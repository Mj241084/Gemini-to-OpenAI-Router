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
// Google's error format is self-diagnosing ("Unknown name \"X\" at '...'"), so
// if a NEW unsupported field shows up later, the fix is a one-line addition to
// this array - no need to get the list perfect up front.
const UNSUPPORTED_SCHEMA_KEYS = [
  "additionalProperties", // confirmed via live 400
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "unevaluatedProperties",
  "unevaluatedItems",
  "patternProperties",
  "additionalItems",
  "const",
  "contentEncoding",
  "contentMediaType",
  "examples",
];

export function uppercaseSchemaTypes(schema) {
  if (!schema || typeof schema !== "object") return schema;
  const copy = { ...schema };

  for (const key of UNSUPPORTED_SCHEMA_KEYS) {
    delete copy[key];
  }

  if (typeof copy.type === "string") {
    copy.type = copy.type.toUpperCase();
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

  // NOT YET HANDLED / NOT LIVE-TESTED: `anyOf` / `oneOf` / `allOf` (JSON-Schema
  // union composition - commonly emitted for Optional[...]/nullable fields by
  // Pydantic v2 and some Zod converters as e.g. `anyOf: [{type:"string"},
  // {type:"null"}]`). Whether this specific Gemini API version's Schema object
  // supports `anyOf` at all is genuinely unconfirmed here. If a future 400
  // mentions "anyOf"/"oneOf"/"allOf" in the field path, that is the signal to
  // live-test the exact accepted shape (same methodology used to confirm the
  // additionalProperties fix) before writing translation logic for it - for
  // now these keys pass through UNCHANGED if present, which means any nested
  // `type` values inside them stay lowercase and could trigger a *different*
  // 400 on their own.

  return copy;
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

  const effortToApply = explicitTopLevelEffort || defaultThinking || null;

  if (effortToApply) {
    const normEffort = effortToApply.toLowerCase();
    const isGemini3 = /gemini-3/i.test(modelName);
    const isGemini25 = /gemini-2\.5/i.test(modelName);

    if (isGemini3) {
      // Maps to thinkingLevel: "minimal", "low", "medium", "high"
      genConfig.thinkingConfig = {
        thinkingLevel: normEffort
      };
    } else if (isGemini25) {
      // Maps to thinkingBudget in tokens
      let budget = 0;
      if (normEffort === "high" || normEffort === "medium") {
        budget = 2048;
      } else if (normEffort === "low" || normEffort === "minimal") {
        budget = 1024;
      }
      genConfig.thinkingConfig = {
        thinkingBudget: budget
      };
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
