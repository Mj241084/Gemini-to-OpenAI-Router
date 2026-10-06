/**
 * Google Native (Gemini API) passthrough helpers.
 * Pure functions only - no I/O. The caller already speaks Google's native
 * shape, so nothing here translates formats; it only (a) parses the route,
 * (b) detects the model kind, (c) rewrites the few fields that must match
 * the router-selected model, and (d) extracts usage for accounting.
 */

import { resolveGemini3ThinkingLevel } from "./nativeTranslate.js";

const THOUGHT_SIGNATURE_SENTINEL = "context_engineering_is_the_way_to_go";

const POST_PATH_RE =
  /^\/(v1beta|v1)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens|embedContent|batchEmbedContents)$/;
const MODELS_PATH_RE = /^\/v1beta\/models(?:\/([^/:]+))?$/;

export function stripModelsPrefix(name) {
  return typeof name === "string" && name.startsWith("models/") ? name.slice("models/".length) : name;
}

export function parseGoogleNativePath(pathname) {
  const m = POST_PATH_RE.exec(pathname || "");
  if (!m) return null;
  let model;
  try {
    model = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  model = stripModelsPrefix(model);
  if (!model) return null;
  return { apiVersion: m[1], model, action: m[3] };
}

// GET /v1beta/models  -> { name: null }
// GET /v1beta/models/{name} -> { name }
export function parseGoogleModelsPath(pathname) {
  const m = MODELS_PATH_RE.exec(pathname || "");
  if (!m) return null;
  if (!m[1]) return { name: null };
  let name;
  try {
    name = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { name: stripModelsPrefix(name) };
}

export function detectKind(action, body) {
  if (action === "embedContent" || action === "batchEmbedContents") return "embedding";
  if (action === "generateContent" || action === "streamGenerateContent") {
    const mods = body && body.generationConfig && body.generationConfig.responseModalities;
    if (Array.isArray(mods) && mods.some((x) => String(x).toUpperCase() === "AUDIO")) return "tts";
  }
  return "chat";
}

// Always v1beta upstream. Client's `key` query param is dropped (it holds the
// router token and must never reach Google); everything else (e.g. alt=sse) is kept.
export function buildUpstreamUrl({ modelName, action, searchParams }) {
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:${action}`;
  const qs = new URLSearchParams();
  if (searchParams) {
    for (const [k, v] of searchParams.entries()) {
      if (k.toLowerCase() === "key") continue;
      qs.append(k, v);
    }
  }
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

// Returns shallow copies only along the changed path - never mutates input
// (the same parsed body is reused across retry attempts with different models).
export function rewriteModelFields(action, body, modelName) {
  if (!body || typeof body !== "object") return body;
  const full = `models/${modelName}`;

  if (action === "embedContent") {
    return typeof body.model === "string" ? { ...body, model: full } : body;
  }
  if (action === "batchEmbedContents") {
    if (!Array.isArray(body.requests)) return body;
    return {
      ...body,
      requests: body.requests.map((r) => (r && typeof r === "object" ? { ...r, model: full } : r)),
    };
  }
  if (action === "countTokens") {
    const g = body.generateContentRequest;
    if (g && typeof g === "object") return { ...body, generateContentRequest: { ...g, model: full } };
    return body;
  }
  return body;
}

// Only fixes an INVALID thinkingLevel on Gemini 3.x (closed enum). Never injects
// default_thinking when the client sent no thinkingConfig (true passthrough).
export function normalizeThinking(body, { modelName, defaultThinking } = {}) {
  if (!body || typeof body !== "object") return body;
  if (!/gemini-3/i.test(modelName || "")) return body;
  const gc = body.generationConfig;
  const tc = gc && gc.thinkingConfig;
  if (!tc || typeof tc !== "object" || !("thinkingLevel" in tc)) return body;

  const level = resolveGemini3ThinkingLevel(tc.thinkingLevel, defaultThinking);
  const { thinkingLevel: _drop, ...restTc } = tc;
  const newTc = level ? { ...restTc, thinkingLevel: level } : restTc;
  return { ...body, generationConfig: { ...gc, thinkingConfig: newTc } };
}

// In-place, idempotent. Gemini 3 requires a thoughtSignature on model-turn
// functionCall parts; SDK clients usually forward it, but plain clients may not.
export function ensureThoughtSignatures(body) {
  if (!body || !Array.isArray(body.contents)) return body;
  for (const content of body.contents) {
    if (!content || !Array.isArray(content.parts)) continue;
    if (content.role && content.role !== "model") continue;
    for (const part of content.parts) {
      if (!part || typeof part !== "object" || !part.functionCall) continue;
      const existing = part.thoughtSignature || part.thought_signature;
      if (typeof existing === "string" && existing.length > 0) continue;
      part.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL;
    }
  }
  return body;
}

function pickNum(segment, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*(\\d+)`).exec(segment);
  return m ? Number(m[1]) : null;
}

// Non-stream responses: usageMetadata sits near the END of the JSON. Cheaper than
// a full JSON.parse of a potentially large body.
export function extractUsageFromText(text) {
  if (!text || typeof text !== "string") return null;
  const idx = text.lastIndexOf('"usageMetadata"');
  if (idx === -1) return null;
  const segment = text.slice(idx, idx + 1500);
  const promptTokens = pickNum(segment, "promptTokenCount");
  const completionTokens = pickNum(segment, "candidatesTokenCount");
  const totalTokens = pickNum(segment, "totalTokenCount");
  if (promptTokens === null && completionTokens === null && totalTokens === null) return null;
  return { promptTokens, completionTokens, totalTokens };
}

// SSE (alt=sse) streams: last usageMetadata wins. Best effort, never throws.
export async function extractUsageFromSseStream(stream) {
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
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const obj = JSON.parse(payload);
          const u = obj && obj.usageMetadata;
          if (u) {
            usage = {
              promptTokens: u.promptTokenCount ?? null,
              completionTokens: u.candidatesTokenCount ?? null,
              totalTokens: u.totalTokenCount ?? null,
            };
          }
        } catch {
          // partial/invalid chunk - ignore
        }
      }
    }
  } catch {
    // best effort only
  }
  return usage;
}
