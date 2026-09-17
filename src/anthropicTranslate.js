/**
 * Anthropic Messages API ⇄ Google Native GenerateContent Translation Layer
 *
 * The caller here speaks Anthropic's Messages API shape (POST /v1/messages,
 * `x-api-key` auth, system/messages/tools/thinking fields, content-block
 * responses). The upstream is ALWAYS Google's native generateContent /
 * streamGenerateContent endpoint (never Google's OpenAI-compat shim, and
 * never a real Anthropic endpoint) - this file bridges the two shapes in
 * both directions, mirroring the pattern already established in
 * nativeTranslate.js for the OpenAI-facing side of this router.
 */

import { uppercaseSchemaTypes, resolveGemini3ThinkingLevel } from "./nativeTranslate.js";

const GEMINI3_MODEL_RE = /gemini-3/i;
const GEMINI25_MODEL_RE = /gemini-2\.5/i;

// Used when Gemini didn't actually return a thoughtSignature for a thinking
// block (e.g. thinking was on but the specific chunk had none) but we still
// need SOME value in Anthropic's required `signature` field. This is only
// ever read back by OUR OWN request translator below - a real Anthropic
// client will never validate it, since the real Anthropic API is never in
// this loop.
const SIGNATURE_PLACEHOLDER = "google_native_bridge_no_signature";

function randomId(len = 24) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

// ---------------------------------------------------------------------------
// Tools translation (Anthropic input_schema -> Gemini functionDeclarations)
// ---------------------------------------------------------------------------

const anthropicToolsTranslationCache = new Map();
const ANTHROPIC_TOOLS_CACHE_MAX_ENTRIES = 50;

export function translateAnthropicToolsWithCache(tools) {
  const cacheKey = JSON.stringify(tools);
  const cached = anthropicToolsTranslationCache.get(cacheKey);
  if (cached) return cached;

  const functionDeclarations = tools
    .filter((t) => t && t.name)
    .map((t) => ({
      name: t.name,
      description: t.description || "",
      // Anthropic's input_schema is plain JSON Schema, same family of
      // problems (additionalProperties, $schema, etc.) that OpenAI-shape
      // tool schemas have - reuse the exact same sanitizer.
      parameters: uppercaseSchemaTypes(t.input_schema || { type: "object", properties: {} }),
    }));

  if (anthropicToolsTranslationCache.size >= ANTHROPIC_TOOLS_CACHE_MAX_ENTRIES) {
    anthropicToolsTranslationCache.clear();
  }
  anthropicToolsTranslationCache.set(cacheKey, functionDeclarations);
  return functionDeclarations;
}

function translateAnthropicToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice !== "object") return null;
  let mode = "AUTO";
  let allowedFunctionNames;

  if (toolChoice.type === "none") mode = "NONE";
  else if (toolChoice.type === "auto") mode = "AUTO";
  else if (toolChoice.type === "any") mode = "ANY";
  else if (toolChoice.type === "tool" && toolChoice.name) {
    mode = "ANY";
    allowedFunctionNames = [toolChoice.name];
  }
  // NOTE: `disable_parallel_tool_use` has no Gemini equivalent exposed via
  // functionCallingConfig - intentionally ignored.

  return { functionCallingConfig: { mode, ...(allowedFunctionNames ? { allowedFunctionNames } : {}) } };
}

// ---------------------------------------------------------------------------
// Extended thinking translation (Anthropic budget_tokens -> Gemini thinking)
// ---------------------------------------------------------------------------

function applyThinkingConfig(genConfig, { thinking, modelName, defaultThinking }) {
  const isGemini3 = GEMINI3_MODEL_RE.test(modelName);
  const isGemini25 = GEMINI25_MODEL_RE.test(modelName);
  if (!isGemini3 && !isGemini25) return; // model row has no thinking knob we know how to drive

  let budgetTokens = null;
  let explicitlyDisabled = false;

  if (thinking && typeof thinking === "object") {
    if (thinking.type === "disabled") {
      explicitlyDisabled = true;
    } else if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
      budgetTokens = thinking.budget_tokens;
    }
    // Any other shape (e.g. Claude Code's {"type":"adaptive"}) intentionally
    // falls through with budgetTokens still null - treated as "no explicit
    // value", resolved from the model's own default below. This is now an
    // EXPLICIT, documented decision (not a coincidence like before).
  }

  if (isGemini3) {
    if (explicitlyDisabled) {
      genConfig.thinkingConfig = { thinkingLevel: "minimal" };
      return;
    }
    let rawLevel = null;
    if (budgetTokens !== null) {
      // APPROXIMATION: Anthropic's budget_tokens is a raw token count,
      // Gemini 3's thinkingLevel is a coarse 4-step enum.
      if (budgetTokens <= 1024) rawLevel = "low";
      else if (budgetTokens <= 8192) rawLevel = "medium";
      else rawLevel = "high";
    }
    const level = resolveGemini3ThinkingLevel(rawLevel, defaultThinking);
    if (level) genConfig.thinkingConfig = { thinkingLevel: level };
    return;
  }

  // Gemini 2.5: numeric budget, no closed-enum failure mode.
  if (explicitlyDisabled) {
    genConfig.thinkingConfig = { thinkingBudget: 0 };
  } else if (budgetTokens !== null) {
    genConfig.thinkingConfig = { thinkingBudget: Math.max(0, Math.min(budgetTokens, 24576)) };
  } else if (defaultThinking) {
    const budget = defaultThinking === "high" || defaultThinking === "medium" ? 2048 : 1024;
    genConfig.thinkingConfig = { thinkingBudget: budget };
  }
}

// ---------------------------------------------------------------------------
// Request: Anthropic Messages body -> Google native generateContent body
// ---------------------------------------------------------------------------

function buildNativePromptParts(anthropicBody) {
  const nativeBody = {};

  // 1) system --------------------------------------------------------------
  let systemText = "";
  if (typeof anthropicBody.system === "string") {
    systemText = anthropicBody.system;
  } else if (Array.isArray(anthropicBody.system)) {
    systemText = anthropicBody.system
      .filter((b) => b && b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
  }
  if (systemText) {
    nativeBody.systemInstruction = { parts: [{ text: systemText }] };
  }

  // 2) tool_use_id -> name lookup -------------------------------------------
  const toolNameById = new Map();
  if (Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      if (!msg || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && block.type === "tool_use" && block.id) {
          toolNameById.set(block.id, block.name);
        }
      }
    }
  }

  // 3) messages -> contents --------------------------------------------------
  const contents = [];
  if (Array.isArray(anthropicBody.messages)) {
    for (const msg of anthropicBody.messages) {
      if (!msg) continue;
      const role = msg.role === "assistant" ? "model" : "user";
      const blocks =
        typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : Array.isArray(msg.content)
          ? msg.content
          : [];

      const parts = [];

      for (const block of blocks) {
        if (!block) continue;
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "image" && block.source?.type === "base64" && block.source.data) {
          parts.push({ inlineData: { mimeType: block.source.media_type || "image/png", data: block.source.data } });
        }
      }

      for (const block of blocks) {
        if (!block || block.type !== "tool_use") continue;
        const part = { functionCall: { name: block.name, args: block.input || {}, id: block.id } };
        const sig = (typeof block._google_thought_signature === "string" && block._google_thought_signature.length > 0)
          ? block._google_thought_signature
          : "context_engineering_is_the_way_to_go";
        part.thoughtSignature = sig;
        parts.push(part);
      }

      for (const block of blocks) {
        if (!block || block.type !== "tool_result") continue;
        let responseObj;
        if (typeof block.content === "string") {
          responseObj = { result: block.content };
        } else if (Array.isArray(block.content)) {
          const text = block.content
            .filter((p) => p && p.type === "text")
            .map((p) => p.text)
            .join("\n");
          responseObj = { result: text };
        } else {
          responseObj = { result: block.content ?? "" };
        }
        if (block.is_error) responseObj.error = true;
        parts.push({
          functionResponse: {
            name: toolNameById.get(block.tool_use_id) || "unknown_tool",
            response: responseObj,
            id: block.tool_use_id,
          },
        });
      }

      if (parts.length === 0) continue;
      contents.push({ role, parts });
    }
  }
  nativeBody.contents = contents;

  // 4) tools & tool_choice ---------------------------------------------------
  if (Array.isArray(anthropicBody.tools) && anthropicBody.tools.length > 0) {
    const functionDeclarations = translateAnthropicToolsWithCache(anthropicBody.tools);
    if (functionDeclarations.length > 0) {
      nativeBody.tools = [{ functionDeclarations }];
      const toolConfig = translateAnthropicToolChoice(anthropicBody.tool_choice);
      if (toolConfig) nativeBody.toolConfig = toolConfig;
    }
  }

  return nativeBody;
}

/**
 * @param {Object} anthropicBody Anthropic-shape request body from the caller.
 * @param {Object} options { modelName, defaultThinking } - same options shape
 *   as nativeTranslate.js's translateRequestToNative.
 * @returns {{url: string, body: Object}}
 */
export function translateAnthropicRequestToNative(anthropicBody, { modelName, defaultThinking } = {}) {
  const isStream = !!anthropicBody.stream;
  const action = isStream ? "streamGenerateContent" : "generateContent";
  const streamSuffix = isStream ? "?alt=sse" : "";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:${action}${streamSuffix}`;

  const nativeBody = buildNativePromptParts(anthropicBody);

  // 5) generationConfig --------------------------------------------------
  const genConfig = {};
  if (typeof anthropicBody.max_tokens === "number") genConfig.maxOutputTokens = anthropicBody.max_tokens;
  if (typeof anthropicBody.temperature === "number") genConfig.temperature = anthropicBody.temperature;
  if (typeof anthropicBody.top_p === "number") genConfig.topP = anthropicBody.top_p;
  if (typeof anthropicBody.top_k === "number") genConfig.topK = anthropicBody.top_k;
  if (Array.isArray(anthropicBody.stop_sequences) && anthropicBody.stop_sequences.length > 0) {
    genConfig.stopSequences = anthropicBody.stop_sequences;
  }
  applyThinkingConfig(genConfig, { thinking: anthropicBody.thinking, modelName, defaultThinking });

  if (Object.keys(genConfig).length > 0) nativeBody.generationConfig = genConfig;

  return { url, body: nativeBody };
}

/**
 * Translates an Anthropic /v1/messages/count_tokens request into Google's
 * native :countTokens endpoint request.
 *
 * @param {Object} anthropicBody
 * @param {Object} options { modelName }
 * @returns {{url: string, body: Object}}
 */
export function translateAnthropicCountTokensRequest(anthropicBody, { modelName }) {
  const promptParts = buildNativePromptParts(anthropicBody);
  const generateContentRequest = {
    model: `models/${modelName}`,
    contents: promptParts.contents || [],
  };
  if (promptParts.systemInstruction) generateContentRequest.systemInstruction = promptParts.systemInstruction;
  if (promptParts.tools) generateContentRequest.tools = promptParts.tools;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:countTokens`;
  return {
    url,
    body: { generateContentRequest },
  };
}

// ---------------------------------------------------------------------------
// Response (non-streaming): Google native generateContent JSON -> Anthropic
// ---------------------------------------------------------------------------

/**
 * @param {Object} nativeJson Google native GenerateContentResponse JSON.
 * @param {string} modelName
 * @returns {Object} Anthropic Messages-shape response body.
 */
export function translateNativeResponseToAnthropic(nativeJson, modelName) {
  const content = [];
  let sawToolUse = false;
  const candidate = nativeJson.candidates && nativeJson.candidates[0];

  if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
    for (const part of candidate.content.parts) {
      if (!part) continue;

      if (part.thought === true && typeof part.text === "string") {
        content.push({
          type: "thinking",
          thinking: part.text,
          signature: part.thoughtSignature || SIGNATURE_PLACEHOLDER,
        });
        continue;
      }

      if (typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        continue;
      }

      if (part.functionCall) {
        sawToolUse = true;
        const block = {
          type: "tool_use",
          id: part.functionCall.id || `toolu_${randomId()}`,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        };
        // Stash Google's Gemini-3 thoughtSignature on the block so a later
        // turn (this same tool_use block resent as part of history, plus
        // its tool_result) can recover it - see
        // translateAnthropicRequestToNative()'s tool_use handling above.
        // This is a non-standard field; real Anthropic clients simply won't
        // have it, which is fine since only OUR OWN google upstream cares.
        if (part.thoughtSignature) block._google_thought_signature = part.thoughtSignature;
        content.push(block);
        continue;
      }
    }
  }

  let stopReason = "end_turn";
  const finishReason = candidate?.finishReason;
  if (sawToolUse) {
    stopReason = "tool_use";
  } else if (finishReason === "MAX_TOKENS") {
    stopReason = "max_tokens";
  } else if (finishReason === "SAFETY" || finishReason === "RECITATION") {
    stopReason = "refusal";
  } else if (finishReason === "STOP") {
    stopReason = "end_turn";
  }
  // NOTE: Gemini has no direct equivalent of Anthropic's stop_sequence-specific
  // stop_reason (which literal sequence halted generation) - folded into
  // "end_turn" above. Extend here if a caller depends on distinguishing it.

  const usage = nativeJson.usageMetadata || {};

  return {
    id: nativeJson.responseId || `msg_${randomId()}`,
    type: "message",
    role: "assistant",
    model: modelName,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming: Google native SSE (alt=sse) -> Anthropic Messages SSE events
// ---------------------------------------------------------------------------

/**
 * Returns a TransformStream that reads raw bytes from Google's
 * streamGenerateContent (?alt=sse) response body and writes out
 * Anthropic-shape SSE bytes (message_start / content_block_start /
 * content_block_delta / content_block_stop / message_delta / message_stop).
 *
 * @param {string} modelName
 * @param {{onUsage?: (usage: {prompt_tokens:number, completion_tokens:number, total_tokens:number}) => void}} options
 *   onUsage is called exactly once, when the stream ends, with final token
 *   counts - use it to feed stub.reportSuccess() the same way the OpenAI
 *   streaming path's extractUsageFromStreamAndLog() does.
 */
export function createAnthropicSseTransformer(modelName, { onUsage } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";

  let messageStarted = false;
  let currentBlockIndex = -1;
  let currentBlockType = null; // "text" | "thinking" | "tool_use" | null
  let sawToolUse = false;
  let finishReason = null;
  let finalUsage = { input_tokens: 0, output_tokens: 0 };
  const messageId = `msg_${randomId()}`;

  function sse(event, data) {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  function ensureMessageStart(controller) {
    if (messageStarted) return;
    messageStarted = true;
    controller.enqueue(
      sse("message_start", {
        type: "message_start",
        message: {
          id: messageId,
          type: "message",
          role: "assistant",
          model: modelName,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
    );
  }

  function closeCurrentBlock(controller) {
    if (currentBlockType === null) return;
    controller.enqueue(sse("content_block_stop", { type: "content_block_stop", index: currentBlockIndex }));
    currentBlockType = null;
  }

  function openBlock(controller, type, startPayload) {
    currentBlockIndex += 1;
    currentBlockType = type;
    controller.enqueue(
      sse("content_block_start", { type: "content_block_start", index: currentBlockIndex, content_block: startPayload })
    );
  }

  function handleNativeChunk(controller, nativeJson) {
    ensureMessageStart(controller);

    if (nativeJson.usageMetadata) {
      finalUsage = {
        input_tokens: nativeJson.usageMetadata.promptTokenCount || 0,
        output_tokens: nativeJson.usageMetadata.candidatesTokenCount || 0,
      };
    }

    const candidate = nativeJson.candidates && nativeJson.candidates[0];
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;

    const parts = candidate.content?.parts || [];
    for (const part of parts) {
      if (!part) continue;

      if (part.thought === true && typeof part.text === "string") {
        if (currentBlockType !== "thinking") {
          closeCurrentBlock(controller);
          openBlock(controller, "thinking", { type: "thinking", thinking: "" });
        }
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "thinking_delta", thinking: part.text },
          })
        );
        if (part.thoughtSignature) {
          controller.enqueue(
            sse("content_block_delta", {
              type: "content_block_delta",
              index: currentBlockIndex,
              delta: { type: "signature_delta", signature: part.thoughtSignature },
            })
          );
        }
        continue;
      }

      if (typeof part.text === "string") {
        if (currentBlockType !== "text") {
          closeCurrentBlock(controller);
          openBlock(controller, "text", { type: "text", text: "" });
        }
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "text_delta", text: part.text },
          })
        );
        continue;
      }

      if (part.functionCall) {
        sawToolUse = true;
        closeCurrentBlock(controller);
        const toolId = part.functionCall.id || `toolu_${randomId()}`;
        openBlock(controller, "tool_use", {
          type: "tool_use",
          id: toolId,
          name: part.functionCall.name,
          input: {},
          // Mirrors the non-streaming path (translateNativeResponseToAnthropic):
          // stash Google's Gemini-3 thought signature (or the documented sentinel
          // fallback) directly on the tool_use content_block_start payload, so a
          // client that stores blocks generically and resends them verbatim can
          // round-trip it back through translateAnthropicRequestToNative()'s
          // tool_use handling on the next turn.
          _google_thought_signature: part.thoughtSignature || "context_engineering_is_the_way_to_go",
        });
        // Gemini delivers the full function-call arguments in one shot (no
        // incremental arg streaming like OpenAI/Anthropic natively support),
        // so we emit exactly one input_json_delta with the whole payload -
        // functionally equivalent for any client that accumulates
        // partial_json chunks before parsing.
        controller.enqueue(
          sse("content_block_delta", {
            type: "content_block_delta",
            index: currentBlockIndex,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(part.functionCall.args || {}) },
          })
        );
        closeCurrentBlock(controller); // this tool_use block is fully materialized already
      }
    }
  }

  function finish(controller) {
    closeCurrentBlock(controller);
    let stopReason = "end_turn";
    if (sawToolUse) stopReason = "tool_use";
    else if (finishReason === "MAX_TOKENS") stopReason = "max_tokens";
    else if (finishReason === "SAFETY" || finishReason === "RECITATION") stopReason = "refusal";

    controller.enqueue(
      sse("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: finalUsage.output_tokens },
      })
    );
    controller.enqueue(sse("message_stop", { type: "message_stop" }));

    if (typeof onUsage === "function") {
      onUsage({
        prompt_tokens: finalUsage.input_tokens,
        completion_tokens: finalUsage.output_tokens,
        total_tokens: finalUsage.input_tokens + finalUsage.output_tokens,
      });
    }
  }

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          handleNativeChunk(controller, JSON.parse(payload));
        } catch {
          // Google's alt=sse lines are always one complete JSON object per
          // event - this should only fire on a genuinely malformed upstream
          // chunk. Best-effort: skip it rather than crash the whole stream.
        }
      }
    },
    flush(controller) {
      finish(controller);
    },
  });
}
