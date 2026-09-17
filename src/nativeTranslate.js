/**
 * Native Google Gemini API Translation Layer
 * Handles translation between OpenAI-compatible format and Google's Native GenerateContent API format.
 */

const toolsTranslationCache = new Map();
const TOOLS_CACHE_MAX_ENTRIES = 50;

/**
 * Cache and translate tools declarations to avoid redundant uppercase transformations.
 */
export function translateToolsWithCache(tools) {
  const cacheKey = JSON.stringify(tools);
  const cached = toolsTranslationCache.get(cacheKey);
  if (cached) return cached;
  const functionDeclarations = tools
    .filter((t) => t.type === "function" && t.function)
    .map((t) => ({
      name: t.function.name,
      description: t.function.description || "",
      parameters: uppercaseSchemaTypes(t.function.parameters)
    }));
  if (toolsTranslationCache.size >= TOOLS_CACHE_MAX_ENTRIES) {
    toolsTranslationCache.clear();
  }
  toolsTranslationCache.set(cacheKey, functionDeclarations);
  return functionDeclarations;
}

// Google's native Schema object (used in both functionDeclarations[].parameters
// and generationConfig.responseSchema) is a curated, LIMITED subset of OpenAPI
// 3.0/JSON Schema - it does NOT accept every keyword that OpenAI-shaped tool/
// schema generators commonly emit. The previous version of this function only
// transformed `type`/`properties`/`items` and passed every other key through
// unchanged via a shallow `{ ...schema }` copy - this let stray keywords like
// `additionalProperties` (which OpenAI's own "strict" json_schema mode, and many
// Zod/Pydantic-to-JSON-Schema converters, add automatically to every object
// schema) reach Google's API untouched, producing a hard 400:
//   "Unknown name \"additionalProperties\" at '...': Cannot find field."
// This is a STRUCTURAL bug, not a one-off: it fires deterministically on every
// request whose schema (tool parameters OR response_format.json_schema) happens
// to include one of these fields, for as long as the caller's schema generator
// keeps emitting them.
//
// Confidence levels (see nativeTranslate test file / router README for details):
//   - "additionalProperties": CONFIRMED via a live 400 (see error text above).
//   - everything else below: not yet triggered in production, but near-certain
//     to cause the identical class of error if they ever show up, because
//     they're JSON-Schema-Draft keywords (schema referencing, pattern-keyed
//     properties, content-encoding hints, etc.) that go beyond even the full
//     OpenAPI 3.0 spec Gemini claims to subset - stripping them is low-risk
//     (worst case: a purely cosmetic/validation hint is dropped) versus the
//     alternative (another blind 400).
//
// Google's native Schema object (used in functionDeclarations[].parameters
// and generationConfig.responseSchema) is a curated, LIMITED subset of
// OpenAPI 3.0/JSON Schema. This list was NOT guessed - it is the result of
// live-testing every field individually against gemini-3.6-flash:generateContent
// with a real API key, cross-referenced against Claude Code's actual built-in
// tool schemas (Zod/Pydantic/Draft-2020-12 generated) and the free-claude-code
// reference project. See router README section 12 / cloudflare-projects-
// lessons-learned.md for the full methodology and confirmed field table.
//
// STRICT ALLOWLIST, not blocklist: any key not in this set is silently
// dropped. This is deliberate - the alternative (blocklist) requires us to
// predict every JSON-Schema-draft keyword any future tool/schema generator
// might emit, which already failed 3 times in a row (additionalProperties,
// then exclusiveMinimum/Maximum, then propertyNames). An allowlist degrades
// gracefully (a stray keyword is just dropped) instead of hard-failing with
// a 400 that breaks the entire tool call.
const GEMINI_SCHEMA_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example", // singular only - Gemini rejects the plural "examples"
  "anyOf",
  "oneOf",
  "allOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

export function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;

  const copy = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GEMINI_SCHEMA_ALLOWED_KEYS.has(key)) {
      copy[key] = value;
    } else if (key === "examples" && Array.isArray(value) && value.length > 0 && copy.example === undefined) {
      // Draft-2020-12 generators (Zod/Pydantic) commonly emit the plural
      // array form; Gemini only accepts the singular "example". Take the
      // first item rather than silently losing the hint entirely.
      copy.example = value[0];
    }
    // else: silently dropped - confirmed via live test to be rejected
    // (additionalProperties, exclusiveMinimum/Maximum, propertyNames,
    // patternProperties, const, readOnly, writeOnly, deprecated, $schema,
    // $id, $ref, $defs, unevaluatedProperties, unevaluatedItems, ...) or
    // simply unknown/unconfirmed - both cases are safe to drop.
  }

  if (typeof copy.type === "string") {
    copy.type = copy.type.toUpperCase();
  }

  // Gemini's protobuf Schema requires `items` whenever type is ARRAY - unlike
  // plain JSON Schema, where `{"type":"array"}` with no `items` is valid
  // ("array of anything"). Confirmed via live 400:
  //   "...items.items: missing field" - a nested array whose inner array had
  // no items declared (a perfectly valid, if loose, upstream JSON Schema,
  // e.g. Zod's z.array(z.array(z.unknown()))). Rather than reject or strip
  // the field, inject a permissive default so the tool call still works.
  if (copy.type === "ARRAY" && !copy.items) {
    copy.items = { type: "STRING" };
  }

  if (copy.properties && typeof copy.properties === "object") {
    const properties = {};
    for (const [k, v] of Object.entries(copy.properties)) {
      properties[k] = uppercaseSchemaTypes(v);
    }
    copy.properties = properties;
  }
  if (copy.items && typeof copy.items === "object") {
    copy.items = uppercaseSchemaTypes(copy.items);
  }
  for (const composeKey of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(copy[composeKey])) {
      copy[composeKey] = copy[composeKey].map((item) => uppercaseSchemaTypes(item));
    }
  }

  return copy;
}

// Gemini 3.x's thinkingLevel is a SMALL, CLOSED enum. Confirmed via repeated
// live 400s from multiple independent callers (Hermes sending OpenAI-style
// "none", Claude Code sending mismatched-case or exotic shapes like
// "adaptive") that NOTHING outside this set is ever accepted:
const GEMINI3_VALID_THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// Common cross-ecosystem aliases that mean "turn thinking off/as low as
// possible" - mapped to Gemini's lowest level instead of passed through raw.
const THINKING_OFF_ALIASES = ["none", "off", "disabled", "false", "0"];

/**
 * Single shared source of truth (used by BOTH this file's OpenAI-facing
 * translator AND anthropicTranslate.js's Anthropic-facing translator) for
 * turning ANY raw thinking-effort signal into something Gemini 3.x will
 * actually accept - PROACTIVELY, before it ever reaches Google, instead of
 * reactively discovering it's invalid via a live 400. This function is the
 * fix for a recurring class of bug: two independent translation layers each
 * had their own partial, ad-hoc handling of this same concept (case
 * normalization here, a request-retry-on-400 fallback there), and each
 * still had gaps a different caller could hit.
 *
 * @param {string|null|undefined} rawValue Caller-supplied effort string
 *   (e.g. an OpenAI-style reasoning_effort, or an approximated level from
 *   Anthropic's budget_tokens). May be missing, mis-cased, or a value from
 *   an entirely different ecosystem's convention.
 * @param {string|null|undefined} defaultThinking The model row's own
 *   configured default_thinking (set at model-registration time).
 * @returns {string|null} A value guaranteed to be one of
 *   GEMINI3_VALID_THINKING_LEVELS, or null if there is truly nothing usable
 *   (caller should omit thinkingConfig entirely in that case, NOT send null).
 */
export function resolveGemini3ThinkingLevel(rawValue, defaultThinking) {
  const norm = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  const raw = norm(rawValue);

  if (THINKING_OFF_ALIASES.includes(raw)) return "minimal";
  if (GEMINI3_VALID_THINKING_LEVELS.includes(raw)) return raw;

  // Raw value missing or unrecognized (typo, a future client shape we
  // haven't seen, a completely foreign convention like Hermes' "none")
  // - silently fall back to the model's own configured default, itself
  // normalized the same way so a bad DB value can't cause a second failure.
  const fallback = norm(defaultThinking);
  if (THINKING_OFF_ALIASES.includes(fallback)) return "minimal";
  if (GEMINI3_VALID_THINKING_LEVELS.includes(fallback)) return fallback;

  // Genuinely nothing usable anywhere - omit thinkingConfig entirely rather
  // than send a guaranteed-invalid value; Gemini uses its own internal
  // default for the model in that case.
  return null;
}

/**
 * Translates an OpenAI-compatible request body to a Google Native GenerateContent request.
 * 
 * @param {Object} openAiBody The original OpenAI-compatible request body.
 * @param {Object} options Configuration options including modelName, provider, defaultThinking.
 * @returns {Object} { url, body: nativeBody }
 */
export function translateRequestToNative(openAiBody, { modelName, defaultThinking } = {}) {
  const isStream = !!openAiBody.stream;
  const action = isStream ? "streamGenerateContent" : "generateContent";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:${action}`;

  const nativeBody = {};

  // ---------------------------------------------------------------------------
  // 1. Process Messages -> Contents and SystemInstruction
  // ---------------------------------------------------------------------------
  const contents = [];
  let systemInstructionText = "";

  if (Array.isArray(openAiBody.messages)) {
    for (const msg of openAiBody.messages) {
      if (!msg) continue;

      if (msg.role === "system") {
        // Extract system instruction
        const text = typeof msg.content === "string" ? msg.content : 
                     (Array.isArray(msg.content) ? msg.content.filter(p => p.type === "text").map(p => p.text).join("\n") : "");
        if (text) {
          systemInstructionText = systemInstructionText ? `${systemInstructionText}\n${text}` : text;
        }
        continue;
      }

      const role = msg.role === "assistant" ? "model" : "user";

      if (msg.role === "tool") {
        // Map OpenAI tool result to user functionResponse part
        let parsedContent;
        try {
          parsedContent = JSON.parse(msg.content);
          if (parsedContent === null || typeof parsedContent !== "object") {
            parsedContent = { result: msg.content };
          }
        } catch (e) {
          parsedContent = { result: msg.content };
        }

        const funcRespPart = {
          functionResponse: {
            name: msg.name,
            response: parsedContent,
            id: msg.tool_call_id
          }
        };

        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === "user") {
          lastContent.parts.push(funcRespPart);
        } else {
          contents.push({
            role: "user",
            parts: [funcRespPart]
          });
        }
        continue;
      }

      const nativeContent = {
        role,
        parts: []
      };

      // Map normal content FIRST (text/images/audio must come BEFORE functionCall in Gemini parts)
      if (typeof msg.content === "string" && msg.content.length > 0) {
        nativeContent.parts.push({ text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (!part) continue;
          if (part.type === "text") {
            nativeContent.parts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url?.url) {
            const imgUrl = part.image_url.url;
            const match = imgUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              nativeContent.parts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2]
                }
              });
            }
          } else if (part.type === "input_audio" && part.input_audio?.data) {
            nativeContent.parts.push({
              inlineData: {
                mimeType: part.input_audio.mimeType || "audio/wav",
                data: part.input_audio.data
              }
            });
          } else if (part.type === "file_uri" && part.file_uri?.url) {
            nativeContent.parts.push({
              fileData: {
                fileUri: part.file_uri.url,
                mimeType: part.file_uri.mime_type || "application/octet-stream"
              }
            });
          }
        }
      }

      // Map assistant tool_calls AFTER content parts
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          let args = {};
          try {
            args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function.arguments || {});
          } catch (e) {
            args = { raw_arguments: call.function.arguments };
          }

          // Extract thought signature or use sentinel
          const existingSig = call.extra_content?.google?.thought_signature;
          const sig = (typeof existingSig === "string" && existingSig.length > 0) ? existingSig : "context_engineering_is_the_way_to_go";

          nativeContent.parts.push({
            functionCall: {
              name: call.function.name,
              args: args,
              id: call.id
            },
            thoughtSignature: sig
          });
        }
      }

      if (nativeContent.parts.length > 0) {
        const lastContent = contents[contents.length - 1];
        if (lastContent && lastContent.role === nativeContent.role) {
          lastContent.parts.push(...nativeContent.parts);
        } else {
          contents.push(nativeContent);
        }
      }
    }
  }

  // Gemini Native API Validation Rules:
  // 1. The FIRST entry in contents MUST have role: "user".
  //    If history begins with a model turn (e.g. proactive_wake or assistant initiation), prepend a dummy user turn.
  if (contents.length > 0 && contents[0].role === "model") {
    contents.unshift({
      role: "user",
      parts: [{ text: "..." }]
    });
  }

  nativeBody.contents = contents;

  if (systemInstructionText) {
    nativeBody.systemInstruction = {
      parts: [{ text: systemInstructionText }]
    };
  }

  // ---------------------------------------------------------------------------
  // 2. Process Tools & Tool Choice
  // ---------------------------------------------------------------------------
  if (Array.isArray(openAiBody.tools) && openAiBody.tools.length > 0) {
    const functionDeclarations = translateToolsWithCache(openAiBody.tools);

    if (functionDeclarations.length > 0) {
      nativeBody.tools = [{ functionDeclarations }];

      // Map tool_choice
      if (openAiBody.tool_choice) {
        let mode = "AUTO";
        let allowedFunctionNames = undefined;

        if (openAiBody.tool_choice === "none") {
          mode = "NONE";
        } else if (openAiBody.tool_choice === "auto") {
          mode = "AUTO";
        } else if (typeof openAiBody.tool_choice === "object" && openAiBody.tool_choice.function?.name) {
          mode = "ANY";
          allowedFunctionNames = [openAiBody.tool_choice.function.name];
        }

        nativeBody.toolConfig = {
          functionCallingConfig: {
            mode,
            ...(allowedFunctionNames ? { allowedFunctionNames } : {})
          }
        };
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Process Generation Config (generationConfig)
  // ---------------------------------------------------------------------------
  const genConfig = {};

  if (typeof openAiBody.temperature === "number") genConfig.temperature = openAiBody.temperature;
  if (typeof openAiBody.top_p === "number") genConfig.topP = openAiBody.top_p;
  if (typeof openAiBody.max_tokens === "number") genConfig.maxOutputTokens = openAiBody.max_tokens;
  if (typeof openAiBody.seed === "number") genConfig.seed = openAiBody.seed;

  if (openAiBody.stop) {
    genConfig.stopSequences = Array.isArray(openAiBody.stop) ? openAiBody.stop : [openAiBody.stop];
  }
  if (typeof openAiBody.n === "number") {
    genConfig.candidateCount = openAiBody.n;
  }

  // Response format / Schema
  if (openAiBody.response_format) {
    if (openAiBody.response_format.type === "json_object") {
      genConfig.responseMimeType = "application/json";
    } else if (openAiBody.response_format.type === "json_schema" && openAiBody.response_format.json_schema) {
      genConfig.responseMimeType = "application/json";
      if (openAiBody.response_format.json_schema.schema) {
        genConfig.responseSchema = uppercaseSchemaTypes(openAiBody.response_format.json_schema.schema);
      }
    }
  }

  // Reasoning Effort / Thinking Config (Google Models)
  const explicitTopLevelEffort =
    typeof openAiBody.reasoning_effort === "string" && openAiBody.reasoning_effort.length > 0
      ? openAiBody.reasoning_effort
      : (openAiBody.reasoning && typeof openAiBody.reasoning === "object" && typeof openAiBody.reasoning.effort === "string"
        ? openAiBody.reasoning.effort
        : null);

  if (explicitTopLevelEffort || defaultThinking) {
    const isGemini3 = /gemini-3/i.test(modelName);
    const isGemini25 = /gemini-2\.5/i.test(modelName);

    if (isGemini3) {
      const level = resolveGemini3ThinkingLevel(explicitTopLevelEffort, defaultThinking);
      if (level) genConfig.thinkingConfig = { thinkingLevel: level };
      // level === null -> omit thinkingConfig entirely, never send an invalid value
    } else if (isGemini25) {
      const normEffort = (explicitTopLevelEffort || defaultThinking || "").toLowerCase();
      let budget = 0;
      if (normEffort === "high" || normEffort === "medium") {
        budget = 2048;
      } else if (normEffort === "low" || normEffort === "minimal") {
        budget = 1024;
      }
      // any other string (including "none") safely falls to budget=0 -
      // Gemini 2.5's thinkingBudget is a plain number, not a closed enum,
      // so this branch never had the "invalid enum value" failure mode.
      genConfig.thinkingConfig = { thinkingBudget: budget };
    }
  }

  if (Object.keys(genConfig).length > 0) {
    nativeBody.generationConfig = genConfig;
  }

  return { url, body: nativeBody };
}

/**
 * Translates a Google Native GenerateContent response into an OpenAI-compatible response.
 * 
 * @param {Object} nativeJson Google Native API response JSON.
 * @param {string} modelName The model name used.
 * @returns {Object} OpenAI-compatible response body.
 */
export function translateNativeResponseToOpenAi(nativeJson, modelName) {
  const openAiJson = {
    id: nativeJson.responseId || `chatcmpl-${Math.random().toString(36).substring(2, 15)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelName,
    choices: []
  };

  if (Array.isArray(nativeJson.candidates)) {
    nativeJson.candidates.forEach((candidate, index) => {
      const choice = {
        index: candidate.index ?? index,
        message: {
          role: "assistant",
          content: ""
        },
        finish_reason: "stop"
      };

      // Map parts to content or tool_calls
      if (candidate.content && Array.isArray(candidate.content.parts)) {
        const textParts = [];
        const toolCalls = [];

        candidate.content.parts.forEach(part => {
          if (!part) return;

          if (typeof part.text === "string") {
            textParts.push(part.text);
          }

          if (part.functionCall) {
            const toolCall = {
              id: part.functionCall.id || `call_${Math.random().toString(36).substring(2, 10)}`,
              type: "function",
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args || {})
              }
            };

            // Propagate the thought signature if returned
            if (part.thoughtSignature) {
              toolCall.extra_content = {
                google: {
                  thought_signature: part.thoughtSignature
                }
              };
            }

            toolCalls.push(toolCall);
          }
        });

        choice.message.content = textParts.join("");
        if (toolCalls.length > 0) {
          choice.message.tool_calls = toolCalls;
        }
      }

      // Map finish reason
      if (candidate.finishReason) {
        const reason = candidate.finishReason;
        if (reason === "STOP") {
          choice.finish_reason = choice.message.tool_calls ? "tool_calls" : "stop";
        } else if (reason === "MAX_TOKENS") {
          choice.finish_reason = "length";
        } else if (reason === "SAFETY" || reason === "RECITATION") {
          choice.finish_reason = "content_filter";
        } else {
          choice.finish_reason = choice.message.tool_calls ? "tool_calls" : reason.toLowerCase();
        }
      } else if (choice.message.tool_calls) {
        choice.finish_reason = "tool_calls";
      }

      openAiJson.choices.push(choice);
    });
  }

  // Map usage metadata
  if (nativeJson.usageMetadata) {
    openAiJson.usage = {
      prompt_tokens: nativeJson.usageMetadata.promptTokenCount || 0,
      completion_tokens: nativeJson.usageMetadata.candidatesTokenCount || 0,
      total_tokens: nativeJson.usageMetadata.totalTokenCount || 0
    };
  }

  return openAiJson;
}
