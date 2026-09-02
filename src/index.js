import { RouterDO } from "./routerDO.js";
import { handleTelegramWebhook, sendOwnerAlert } from "./telegram.js";
import { translateRequestToNative, translateNativeResponseToOpenAi } from "./nativeTranslate.js";
import {
  PROVIDER_ENDPOINTS,
  MAX_ATTEMPTS,
  UPSTREAM_TIMEOUT_MS,
  SEED_MODELS,
  SEED_KEYS,
  DEFAULT_KIND,
  googleEmbedContentUrl,
  googleBatchEmbedContentsUrl,
  googleGenerateContentUrl,
} from "./config.js";
import {
  isAuthorized,
  json,
  corsPreflight,
  withCors,
  unauthorized,
  openAiError,
  safeReadText,
  pcmToWavBase64,
} from "./util.js";

export { RouterDO };

function getStub(env) {
  const id = env.ROUTER_DO.idFromName("global");
  return env.ROUTER_DO.get(id);
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") return corsPreflight();

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        return json({ ok: true, service: "gemini-hermes-router" });
      }

      // ---------------------------------------------------------------
      // Hermes-facing, OpenAI-compatible surface
      // ---------------------------------------------------------------
      if (path === "/v1/chat/completions" && request.method === "POST") {
        if (!isAuthorized(request, env.PROXY_TOKEN)) return unauthorized();
        return await handleChatCompletions(request, env, ctx);
      }

      if (path === "/v1/models" && request.method === "GET") {
        if (!isAuthorized(request, env.PROXY_TOKEN)) return unauthorized();
        const stub = getStub(env);
        const models = await stub.listModels();
        const data = models
          .filter((m) => m.enabled)
          .sort((a, b) => a.order_num - b.order_num)
          .map((m) => ({ id: m.name, object: "model", owned_by: "google-ai-studio" }));
        data.unshift({ id: "auto", object: "model", owned_by: "gemini-hermes-router" });
        return withCors(json({ object: "list", data }));
      }

      // Separate from /v1/chat/completions because embeddings are a
      // structurally different request/response shape (no messages/tool
      // calls), not because it needs different auth - same PROXY_TOKEN.
      if (path === "/v1/embeddings" && request.method === "POST") {
        if (!isAuthorized(request, env.PROXY_TOKEN)) return unauthorized();
        return await handleEmbeddings(request, env, ctx);
      }

      // ---------------------------------------------------------------
      // Telegram bot webhook - its own security is Telegram's optional
      // secret_token header + an owner-chat-id allowlist, NOT ADMIN_TOKEN.
      // ---------------------------------------------------------------
      if (path === "/telegram/webhook" && request.method === "POST") {
        return await handleTelegramWebhook(request, env, ctx, getStub);
      }

      // ---------------------------------------------------------------
      // Admin surface
      // ---------------------------------------------------------------
      if (path.startsWith("/admin/")) {
        if (!isAuthorized(request, env.ADMIN_TOKEN)) return unauthorized("Unauthorized: invalid admin token.");
        return await handleAdmin(path, request, env);
      }

      return openAiError("Not found.", 404, "not_found_error");
    } catch (err) {
      return openAiError(`Internal error: ${err.message || err}`, 500, "internal_error");
    }
  },
};

// ===========================================================================
// Hermes proxy logic
// ===========================================================================

async function handleChatCompletions(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return openAiError("Request body must be valid JSON.", 400);
  }

  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "auto";
  // Gemini TTS runs through this SAME /v1/chat/completions endpoint - it's
  // just a chat request with modalities:["text","audio"]. We detect that
  // here and scope the whole fallback chain to kind="tts" models only, so a
  // TTS request can never accidentally cascade into a plain text model (or
  // vice versa) on failure.
  const kind = Array.isArray(body.modalities) && body.modalities.includes("audio") ? "tts" : DEFAULT_KIND;
  const stub = getStub(env);
  const excludePairs = [];
  let lastErrorPayload = null;
  let lastErrorStatus = 502;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = await stub.pickCandidate({ requestedModel, excludePairs, kind });

    if (!candidate) {
      const status = await stub.getStatus();
      const msg = buildExhaustionMessage(status);
      ctx.waitUntil(
        sendOwnerAlert(
          env,
          `🚨 <b>همه‌ی مدل‌ها/کلیدها exhausted شدن</b>\nاین خطا به Hermes برگشت.\n${escapeHtmlAlert(msg)}`
        )
      );
      return openAiError(msg, 429, "rate_limit_exceeded");
    }

    const forwardBody = buildForwardBody(body, candidate);
    const startedAt = Date.now();
    let upstreamResp;

    try {
      if (candidate.kind === "tts" && candidate.provider === "google") {
        // Bypass Google's OpenAI-compatible shim entirely for TTS: the
        // audio modality on that layer is a beta surface that was observed
        // to fail in ways plain retrying never fixed. The native
        // generateContent endpoint is the documented, stable way to do
        // Gemini TTS - see callGoogleNativeTts() below.
        upstreamResp = await callGoogleNativeTts(candidate, forwardBody);
      } else if (candidate.provider === "google" && candidate.kind === "chat" && !body.stream) {
        // Native path for non-streaming google chat completions
        const { url, body: nativeBody } = translateRequestToNative(body, {
          modelName: candidate.modelName,
          defaultThinking: candidate.defaultThinking
        });
        upstreamResp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-goog-api-key": candidate.apiKey
          },
          body: JSON.stringify(nativeBody),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      } else {
        upstreamResp = await fetch(PROVIDER_ENDPOINTS[candidate.provider] || PROVIDER_ENDPOINTS.google, {
          method: "POST",
          headers: buildUpstreamHeaders(candidate, env),
          body: JSON.stringify(forwardBody),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
      }
    } catch (networkErr) {
      // Treat network failure / timeout as a model-level problem: skip the
      // whole model, not just this key, and move on.
      excludePairs.push(`model:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: 0,
          errorMessage: `network error: ${networkErr.message || networkErr}`,
          scope: "model",
        })
      );
      lastErrorPayload = String(networkErr.message || networkErr);
      lastErrorStatus = 502;
      continue;
    }

    // --- 429: this key is rate limited -> rotate the key ----------------
    if (upstreamResp.status === 429) {
      const errText = await safeReadText(upstreamResp);
      excludePairs.push(`${candidate.keyId}:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: 429,
          errorMessage: errText,
          scope: "key",
        })
      );
      lastErrorPayload = errText;
      lastErrorStatus = 429;
      continue;
    }

    // --- 502/503/504: model/upstream looks unavailable -> rotate model --
    if ([502, 503, 504, 524].includes(upstreamResp.status)) {
      const errText = await safeReadText(upstreamResp);
      excludePairs.push(`model:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: upstreamResp.status,
          errorMessage: errText,
          scope: "model",
        })
      );
      lastErrorPayload = errText;
      lastErrorStatus = upstreamResp.status;
      continue;
    }

    // --- 400: almost certainly a request-shape problem (e.g. bad
    // thinking level for this specific model) - retrying elsewhere will
    // not fix it, so fail fast and surface Google's real error message.
    if (upstreamResp.status === 400) {
      const errText = await safeReadText(upstreamResp);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: 400,
          errorMessage: errText,
          scope: "none",
        })
      );
      ctx.waitUntil(
        sendOwnerAlert(
          env,
          `🚨 <b>خطای ۴۰۰ به Hermes برگشت (بدون retry)</b>\nمدل: ${candidate.modelName}\nکلید: ${candidate.keyLabel || "-"}\n<code>${escapeHtmlAlert(errText.slice(0, 600))}</code>`
        )
      );
      return new Response(errText || JSON.stringify({ error: { message: "Bad request", code: 400 } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    // --- 401/403: bad/revoked key -> rotate key --------------------------
    if (upstreamResp.status === 401 || upstreamResp.status === 403) {
      const errText = await safeReadText(upstreamResp);
      excludePairs.push(`${candidate.keyId}:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: upstreamResp.status,
          errorMessage: errText,
          scope: "key",
        })
      );
      lastErrorPayload = errText;
      lastErrorStatus = upstreamResp.status;
      continue;
    }

    // --- any other non-OK status: log and bail out cleanly ---------------
    if (!upstreamResp.ok) {
      const errText = await safeReadText(upstreamResp);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: upstreamResp.status,
          errorMessage: errText,
          scope: "none",
        })
      );
      ctx.waitUntil(
        sendOwnerAlert(
          env,
          `🚨 <b>خطای HTTP ${upstreamResp.status} به Hermes برگشت</b>\nمدل: ${candidate.modelName}\nکلید: ${candidate.keyLabel || "-"}\n<code>${escapeHtmlAlert(errText.slice(0, 600))}</code>`
        )
      );
      return new Response(errText, {
        status: upstreamResp.status,
        headers: { "content-type": "application/json" },
      });
    }

    // --- success ----------------------------------------------------------
    const latencyMs = Date.now() - startedAt;

    if (forwardBody.stream) {
      return handleStreamingSuccess(upstreamResp, stub, candidate, latencyMs, ctx);
    }

    let respText = await upstreamResp.text();
    let usage = {};
    if (candidate.provider === "google" && candidate.kind === "chat" && !body.stream) {
      try {
        const nativeJson = JSON.parse(respText);
        const openAiJson = translateNativeResponseToOpenAi(nativeJson, candidate.modelName);
        respText = JSON.stringify(openAiJson);
        usage = openAiJson.usage || {};
      } catch (err) {
        // fallback
      }
    } else {
      try {
        usage = JSON.parse(respText)?.usage || {};
      } catch {
        // non-JSON success body - forward as-is, just skip usage accounting
      }
    }
    ctx.waitUntil(
      stub.reportSuccess({
        keyId: candidate.keyId,
        modelId: candidate.modelId,
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        totalTokens: usage.total_tokens ?? null,
        latencyMs,
      })
    );
    return new Response(respText, { status: 200, headers: { "content-type": "application/json" } });
  }

  ctx.waitUntil(
    sendOwnerAlert(
      env,
      `🚨 <b>تمام ${MAX_ATTEMPTS} تلاش ناموفق بود</b>\nآخرین خطا (HTTP ${lastErrorStatus}):\n<code>${escapeHtmlAlert(
        String(lastErrorPayload || "unknown").slice(0, 600)
      )}</code>`
    )
  );
  return openAiError(
    `All retry attempts were exhausted. Last upstream error: ${lastErrorPayload || "unknown"}`,
    lastErrorStatus,
    "upstream_error"
  );
}

// ===========================================================================
// Embeddings (native Gemini endpoint, wrapped in an OpenAI-embeddings-shaped
// response for convenience - see config.js comment on why we bypass the
// OpenAI-compat /v1/embeddings shim)
// ===========================================================================

async function handleEmbeddings(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return openAiError("Request body must be valid JSON.", 400);
  }

  const requestedModel = typeof body.model === "string" && body.model.trim() ? body.model.trim() : "auto";
  const input = body.input;
  if (typeof input !== "string" && !Array.isArray(input)) {
    return openAiError("`input` must be a string or an array of strings.", 400);
  }
  const dimensions = Number.isFinite(body.dimensions) ? body.dimensions : undefined;

  const stub = getStub(env);
  const excludePairs = [];
  let lastErrorPayload = null;
  let lastErrorStatus = 502;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = await stub.pickCandidate({ requestedModel, excludePairs, kind: "embedding" });

    if (!candidate) {
      const status = await stub.getStatus();
      const msg = buildExhaustionMessage(status);
      ctx.waitUntil(
        sendOwnerAlert(env, `🚨 <b>مدل/کلید embedding ای در دسترس نیست</b>\n${escapeHtmlAlert(msg)}`)
      );
      return openAiError(msg, 429, "rate_limit_exceeded");
    }

    if (candidate.provider !== "google") {
      // Only Google's native embedContent is wired up. If you add a
      // non-Google embedding model, extend this branch accordingly.
      excludePairs.push(`model:${candidate.modelId}`);
      continue;
    }

    const isBatch = Array.isArray(input);
    const upstreamUrl = isBatch ? googleBatchEmbedContentsUrl(candidate.modelName) : googleEmbedContentUrl(candidate.modelName);
    const upstreamBody = isBatch
      ? {
          requests: input.map((text) => ({
            model: `models/${candidate.modelName}`,
            content: { parts: [{ text: String(text) }] },
            ...(dimensions ? { outputDimensionality: dimensions } : {}),
          })),
        }
      : {
          content: { parts: [{ text: String(input) }] },
          ...(dimensions ? { outputDimensionality: dimensions } : {}),
        };

    const startedAt = Date.now();
    let upstreamResp;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Google's NATIVE REST API (unlike the OpenAI-compat shim) uses
          // this header for the API key, not a Bearer token.
          "x-goog-api-key": candidate.apiKey,
        },
        body: JSON.stringify(upstreamBody),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (networkErr) {
      excludePairs.push(`model:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: 0,
          errorMessage: `network error: ${networkErr.message || networkErr}`,
          scope: "model",
        })
      );
      lastErrorPayload = String(networkErr.message || networkErr);
      continue;
    }

    if (upstreamResp.status === 429) {
      const errText = await safeReadText(upstreamResp);
      excludePairs.push(`${candidate.keyId}:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({ keyId: candidate.keyId, modelId: candidate.modelId, httpStatus: 429, errorMessage: errText, scope: "key" })
      );
      lastErrorPayload = errText;
      lastErrorStatus = 429;
      continue;
    }

    if ([502, 503, 504, 524].includes(upstreamResp.status)) {
      const errText = await safeReadText(upstreamResp);
      excludePairs.push(`model:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({
          keyId: candidate.keyId,
          modelId: candidate.modelId,
          httpStatus: upstreamResp.status,
          errorMessage: errText,
          scope: "model",
        })
      );
      lastErrorPayload = errText;
      lastErrorStatus = upstreamResp.status;
      continue;
    }

    if (!upstreamResp.ok) {
      const errText = await safeReadText(upstreamResp);
      const scope = upstreamResp.status === 401 || upstreamResp.status === 403 ? "key" : "none";
      if (scope === "key") excludePairs.push(`${candidate.keyId}:${candidate.modelId}`);
      ctx.waitUntil(
        stub.reportFailure({ keyId: candidate.keyId, modelId: candidate.modelId, httpStatus: upstreamResp.status, errorMessage: errText, scope })
      );
      if (scope === "none") {
        ctx.waitUntil(
          sendOwnerAlert(
            env,
            `🚨 <b>خطای HTTP ${upstreamResp.status} از embedding به caller برگشت</b>\nمدل: ${candidate.modelName}\n<code>${escapeHtmlAlert(errText.slice(0, 600))}</code>`
          )
        );
        return new Response(errText, { status: upstreamResp.status, headers: { "content-type": "application/json" } });
      }
      lastErrorPayload = errText;
      lastErrorStatus = upstreamResp.status;
      continue;
    }

    // --- success: reshape native response into an OpenAI-embeddings shape
    const latencyMs = Date.now() - startedAt;
    const nativeJson = await upstreamResp.json();
    const vectors = isBatch
      ? (nativeJson.embeddings || []).map((e) => e.values)
      : [nativeJson.embedding?.values].filter(Boolean);

    ctx.waitUntil(
      stub.reportSuccess({
        keyId: candidate.keyId,
        modelId: candidate.modelId,
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        latencyMs,
      })
    );

    return json({
      object: "list",
      data: vectors.map((embedding, index) => ({ object: "embedding", embedding, index })),
      model: candidate.modelName,
    });
  }

  return openAiError(
    `All retry attempts were exhausted. Last upstream error: ${lastErrorPayload || "unknown"}`,
    lastErrorStatus,
    "upstream_error"
  );
}

// Google's documented escape hatch for when a thought_signature can't be
// supplied (e.g. because the calling client is a plain OpenAI client that
// doesn't know about Gemini's non-standard `extra_content` field and drops
// it when it reconstructs message history). Setting this sentinel value
// skips Gemini 3's strict thought_signature validation instead of hard
// failing with a 400.
// Docs: https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures#faqs
const THOUGHT_SIGNATURE_SENTINEL = "context_engineering_is_the_way_to_go";

/**
 * Gemini 3 requires every assistant message that contains tool_calls to have
 * a thought_signature on its FIRST tool call (see docs above). Most OpenAI
 * clients - including Hermes - are not aware of Gemini's non-standard
 * `extra_content` field and strip it when they rebuild the conversation
 * history to send back on the next turn. Without this fix, any multi-step
 * tool-use conversation breaks with:
 *   "Function call ... is missing a thought_signature"
 * as soon as there is more than one tool round-trip.
 *
 * We fix this transparently here: right before forwarding, walk the
 * message history and inject the documented sentinel value into any
 * assistant tool_call that is missing a real signature. This never
 * overwrites a signature that IS present (so genuine reasoning continuity
 * is preserved whenever the client does forward it correctly).
 */
function ensureThoughtSignatures(messages) {
  if (!Array.isArray(messages)) return messages;
  for (const msg of messages) {
    if (!msg || msg.role !== "assistant" || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
      continue;
    }
    const first = msg.tool_calls[0];
    if (!first || typeof first !== "object") continue;
    const existing = first.extra_content && first.extra_content.google && first.extra_content.google.thought_signature;
    if (typeof existing === "string" && existing.length > 0) continue;
    first.extra_content = {
      ...(first.extra_content || {}),
      google: {
        ...((first.extra_content && first.extra_content.google) || {}),
        thought_signature: THOUGHT_SIGNATURE_SENTINEL,
      },
    };
  }
  return messages;
}

function buildUpstreamHeaders(candidate, env) {
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${candidate.apiKey}`,
  };
  if (candidate.provider === "openrouter") {
    // Optional but recommended by OpenRouter for attribution/rankings.
    // https://openrouter.ai/docs/api-reference/chat-completion
    if (env.OPENROUTER_SITE_URL) headers["HTTP-Referer"] = env.OPENROUTER_SITE_URL;
    if (env.OPENROUTER_SITE_NAME) headers["X-Title"] = env.OPENROUTER_SITE_NAME;
  }
  return headers;
}

function buildForwardBody(originalBody, candidate) {
  const forward = { ...originalBody };
  forward.model = candidate.modelName;

  // The thought_signature quirk is specific to Google's Gemini 3 models -
  // forwarding this transform to other providers would be meaningless (and
  // for OpenRouter, could inject a field the underlying model doesn't
  // expect into message history it otherwise handles natively).
  if (candidate.provider === "google") {
    forward.messages = ensureThoughtSignatures(forward.messages);
  }

  const hasGoogleThinkingConfig = !!(
    forward.extra_body &&
    forward.extra_body.google &&
    forward.extra_body.google.thinking_config
  );
  // OpenRouter's current standard is a nested `reasoning: {effort: "..."}`
  // object. If Hermes (or a prior hop) already sent one, respect it as-is.
  const hasReasoningObject = forward.reasoning && typeof forward.reasoning === "object";
  const explicitTopLevelEffort =
    typeof forward.reasoning_effort === "string" && forward.reasoning_effort.length > 0
      ? forward.reasoning_effort
      : null;

  // Only decide on a level to apply when Hermes hasn't already fully
  // specified thinking config in a provider-native shape. If Hermes gave us
  // a flat `reasoning_effort` string, we still honor that VALUE, but we
  // reshape it below to whatever format the target provider expects -
  // Hermes has no way to know in advance which provider a given request
  // will actually land on, since that's decided by our own fallback logic.
  let effortToApply = null;
  if (!hasGoogleThinkingConfig && !hasReasoningObject) {
    effortToApply = explicitTopLevelEffort || candidate.defaultThinking || null;
  }

  if (effortToApply) {
    if (candidate.provider === "openrouter") {
      // OpenRouter rejects requests that include BOTH `reasoning` and
      // `reasoning_effort` (400: "Only one of reasoning and
      // reasoning_effort may be provided"), and treats the flat field as
      // deprecated/unreliable across most models now - so always use the
      // nested object here and strip any stray flat field.
      forward.reasoning = { effort: effortToApply };
      delete forward.reasoning_effort;
    } else {
      // Google's OpenAI-compat layer maps the flat field automatically.
      forward.reasoning_effort = effortToApply;
    }
  }

  return forward;
}

// Extracts plain text from an OpenAI-style message `content` field, which
// can be either a raw string or an array of content parts (text/image_url).
// Used to pull "what to actually speak" out of a chat-shaped TTS request.
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Calls Google's NATIVE generateContent endpoint for TTS (kind="tts",
 * provider="google" models only) instead of the OpenAI-compat shim's audio
 * modality. Returns a real Response object shaped exactly like a normal
 * upstream fetch() result, so it flows through handleChatCompletions'
 * existing status-code branching (429/502-504/400/401-403/success)
 * completely unchanged.
 *
 * Why: the OpenAI-compat layer's audio modality is a beta surface that was
 * observed failing in ways that trying different models/voices never
 * fixed. The native endpoint is Google's documented, stable TTS API - the
 * only wrinkle is that it returns raw headerless PCM audio, which we wrap
 * in a WAV container (see util.js's pcmToWavBase64) before handing back an
 * OpenAI-chat-completions-shaped JSON body that tools/tts.js already knows
 * how to read (message.audio.data / message.audio.transcript).
 */
async function callGoogleNativeTts(candidate, forwardBody) {
  const rawVoice = (forwardBody.audio && forwardBody.audio.voice) || "kore";
  // Gemini's native voice names are capitalized (e.g. "Kore", "Puck") - the
  // OpenAI-compat layer wanted lowercase, which is what caused the original
  // "Kore" error. Normalize here so callers can send either case.
  const voiceName = rawVoice.charAt(0).toUpperCase() + rawVoice.slice(1).toLowerCase();

  const lastUserMsg = [...(forwardBody.messages || [])].reverse().find((m) => m.role === "user");
  const textToSpeak = extractTextContent(lastUserMsg?.content) || "";

  const url = googleGenerateContentUrl(candidate.modelName);
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": candidate.apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text: textToSpeak }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
      },
    }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });

  if (!resp.ok) {
    // Pass the native error straight through - HTTP codes match what the
    // caller's status-based branching already expects (429/502-504/etc).
    return resp;
  }

  let nativeJson;
  try {
    nativeJson = await resp.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: `TTS: invalid JSON from native endpoint: ${e.message}` } }), { status: 502 });
  }

  const part = nativeJson.candidates?.[0]?.content?.parts?.[0];
  const inlineData = part?.inlineData;
  if (!inlineData?.data) {
    return new Response(
      JSON.stringify({
        error: { message: `TTS: no audio returned by native endpoint. Response: ${JSON.stringify(nativeJson).slice(0, 500)}` },
      }),
      { status: 502 }
    );
  }

  const rateMatch = /rate=(\d+)/.exec(inlineData.mimeType || "");
  const sampleRate = rateMatch ? Number(rateMatch[1]) : 24000;
  const wavBase64 = pcmToWavBase64(inlineData.data, sampleRate, 1, 16);

  const shaped = {
    id: `tts-${Date.now()}`,
    object: "chat.completion",
    model: candidate.modelName,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "", audio: { data: wavBase64, transcript: textToSpeak } },
      },
    ],
    usage: {},
  };
  return new Response(JSON.stringify(shaped), { status: 200, headers: { "content-type": "application/json" } });
}

function buildExhaustionMessage(status) {
  const mins = Math.ceil(status.next_daily_reset_in_sec / 60);
  return (
    `All configured models/keys are currently rate limited. ` +
    `Daily quotas reset in about ${mins} minute(s) (at 12:30 Iran time). ` +
    `Check GET /admin/status for per-key/per-model detail.`
  );
}

function escapeHtmlAlert(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function handleStreamingSuccess(upstreamResp, stub, candidate, latencyMs, ctx) {
  const [clientStream, logStream] = upstreamResp.body.tee();
  ctx.waitUntil(extractUsageFromStreamAndLog(logStream, stub, candidate, latencyMs));

  const headers = new Headers(upstreamResp.headers);
  return new Response(clientStream, { status: upstreamResp.status, headers });
}

async function extractUsageFromStreamAndLog(stream, stub, candidate, latencyMs) {
  let usage = null;
  try {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          if (obj.usage) usage = obj.usage;
        } catch {
          // partial/invalid chunk - best effort only, ignore
        }
      }
    }
  } catch {
    // best effort only - never let logging break anything
  } finally {
    try {
      await stub.reportSuccess({
        keyId: candidate.keyId,
        modelId: candidate.modelId,
        promptTokens: usage?.prompt_tokens ?? null,
        completionTokens: usage?.completion_tokens ?? null,
        totalTokens: usage?.total_tokens ?? null,
        latencyMs,
      });
    } catch {
      // ignore
    }
  }
}

// ===========================================================================
// Admin API
// ===========================================================================

async function handleAdmin(path, request, env) {
  const stub = getStub(env);
  const method = request.method;

  // ---- Telegram webhook registration convenience ---------------------------
  if (path === "/admin/telegram/setup" && method === "GET") {
    if (!env.TELEGRAM_BOT_TOKEN) {
      return openAiError("TELEGRAM_BOT_TOKEN secret is not set.", 400);
    }
    const reqUrl = new URL(request.url);
    const webhookUrl = `${reqUrl.protocol}//${reqUrl.host}/telegram/webhook`;
    const params = new URLSearchParams({ url: webhookUrl });
    if (env.TELEGRAM_WEBHOOK_SECRET) params.set("secret_token", env.TELEGRAM_WEBHOOK_SECRET);
    const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?${params.toString()}`);
    return json(await resp.json());
  }

  // ---- Seed convenience endpoint ----------------------------------------
  if (path === "/admin/seed" && method === "POST") {
    for (const m of SEED_MODELS) await stub.addModel(m);
    await stub.addKeysBulk(SEED_KEYS);
    return json({ ok: true, models: SEED_MODELS.length, keys: SEED_KEYS.length });
  }

  // ---- Models -------------------------------------------------------------
  if (path === "/admin/models" && method === "GET") {
    return json(await stub.listModels());
  }
  if (path === "/admin/models" && method === "POST") {
    const body = await readJson(request);
    try {
      return json(await stub.addModel(body), 201);
    } catch (e) {
      return openAiError(e.message, 400);
    }
  }
  const modelMatch = path.match(/^\/admin\/models\/([^/]+)$/);
  if (modelMatch && method === "PATCH") {
    const body = await readJson(request);
    try {
      return json(await stub.updateModel(decodeURIComponent(modelMatch[1]), body));
    } catch (e) {
      return openAiError(e.message, 404);
    }
  }
  if (modelMatch && method === "DELETE") {
    return json(await stub.deleteModel(decodeURIComponent(modelMatch[1])));
  }

  // ---- API keys -------------------------------------------------------------
  if (path === "/admin/keys" && method === "GET") {
    const reveal = new URL(request.url).searchParams.get("reveal") === "1";
    return json(await stub.listKeys({ reveal }));
  }
  if (path === "/admin/keys" && method === "POST") {
    const body = await readJson(request);
    try {
      if (Array.isArray(body.keys)) {
        return json(await stub.addKeysBulk(body.keys), 201);
      }
      return json(await stub.addKey(body), 201);
    } catch (e) {
      return openAiError(e.message, 400);
    }
  }
  const keyMatch = path.match(/^\/admin\/keys\/(\d+)$/);
  if (keyMatch && method === "PATCH") {
    const body = await readJson(request);
    try {
      return json(await stub.updateKey(Number(keyMatch[1]), body));
    } catch (e) {
      return openAiError(e.message, 404);
    }
  }
  if (keyMatch && method === "DELETE") {
    return json(await stub.deleteKey(Number(keyMatch[1])));
  }

  // ---- Observability -------------------------------------------------------------
  if (path === "/admin/status" && method === "GET") {
    return json(await stub.getStatus());
  }
  if (path === "/admin/logs" && method === "GET") {
    const q = new URL(request.url).searchParams;
    const limit = Number(q.get("limit") || 50);
    const status = q.get("status");
    return json(await stub.getLogs({ limit, status }));
  }
  if (path === "/admin/stats" && method === "GET") {
    const q = new URL(request.url).searchParams;
    const hours = Number(q.get("hours") || 24);
    return json(await stub.getStats({ sinceMs: hours * 3600 * 1000 }));
  }

  // ---- Raw SQL passthrough (power users only, see README) -----------------
  if (path === "/admin/query" && method === "POST") {
    const body = await readJson(request);
    try {
      return json(await stub.rawQuery(body));
    } catch (e) {
      return openAiError(e.message, 400);
    }
  }

  return openAiError("Not found.", 404, "not_found_error");
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}