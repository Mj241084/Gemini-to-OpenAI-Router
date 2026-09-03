/**
 * Comprehensive Test Script for Native Translate Layer
 * Validates the translation logic locally using Node.js.
 */

import { 
  translateRequestToNative, 
  translateNativeResponseToOpenAi, 
  uppercaseSchemaTypes 
} from "../src/nativeTranslate.js";

function runTests() {
  console.log("=== Starting Native Translate Unit Tests ===");

  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ [PASS] ${message}`);
      passed++;
    } else {
      console.error(`❌ [FAIL] ${message}`);
      failed++;
    }
  }

  // ---------------------------------------------------------------------------
  // Test 1: Schema Type Uppercase Helper
  // ---------------------------------------------------------------------------
  try {
    const inputSchema = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema",
      additionalProperties: false,
      const: "fixed_val",
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        tags: {
          type: "array",
          additionalProperties: false,
          items: { type: "string" }
        }
      },
      required: ["name"]
    };

    const outputSchema = uppercaseSchemaTypes(inputSchema);
    assert(outputSchema.type === "OBJECT", "Root schema type is OBJECT");
    assert(!("additionalProperties" in outputSchema), "additionalProperties removed from root");
    assert(!("$schema" in outputSchema), "$schema removed from root");
    assert(!("const" in outputSchema), "const removed from root");
    assert(outputSchema.properties.name.type === "STRING", "Property name type is STRING");
    assert(outputSchema.properties.age.type === "INTEGER", "Property age type is INTEGER");
    assert(outputSchema.properties.tags.type === "ARRAY", "Property tags type is ARRAY");
    assert(!("additionalProperties" in outputSchema.properties.tags), "additionalProperties removed from nested property");
    assert(outputSchema.properties.tags.items.type === "STRING", "Array items type is STRING");
  } catch (err) {
    console.error("Test 1 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 2: Basic Chat Request Translation
  // ---------------------------------------------------------------------------
  try {
    const openAiRequest = {
      model: "gemini-3.6-flash",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Hello! What's your name?" }
      ],
      temperature: 0.5,
      max_tokens: 100,
      stop: ["\n", "Stop"],
      seed: 123
    };

    const result = translateRequestToNative(openAiRequest, { modelName: "gemini-3.6-flash" });
    assert(result.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent", "URL maps to generateContent");
    assert(result.body.systemInstruction.parts[0].text === "You are a helpful assistant.", "System instruction extracted correctly");
    assert(result.body.contents.length === 1, "Contents contains 1 user message");
    assert(result.body.contents[0].role === "user", "Message role maps to user");
    assert(result.body.contents[0].parts[0].text === "Hello! What's your name?", "User text mapped correctly");
    assert(result.body.generationConfig.temperature === 0.5, "Temperature mapped correctly");
    assert(result.body.generationConfig.maxOutputTokens === 100, "Max output tokens mapped correctly");
    assert(result.body.generationConfig.seed === 123, "Seed mapped correctly");
    assert(JSON.stringify(result.body.generationConfig.stopSequences) === JSON.stringify(["\n", "Stop"]), "Stop sequences mapped correctly");
  } catch (err) {
    console.error("Test 2 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 3: Tools & Tool Choice Translation
  // ---------------------------------------------------------------------------
  try {
    const openAiRequest = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "Get current weather." }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get current weather",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } }
            }
          }
        }
      ],
      tool_choice: {
        type: "function",
        function: { name: "get_weather" }
      }
    };

    const result = translateRequestToNative(openAiRequest, { modelName: "gemini-3.6-flash" });
    assert(result.body.tools.length === 1, "Tools container is present");
    assert(result.body.tools[0].functionDeclarations.length === 1, "Function declarations has 1 tool");
    assert(result.body.tools[0].functionDeclarations[0].name === "get_weather", "Tool name is get_weather");
    assert(result.body.tools[0].functionDeclarations[0].parameters.type === "OBJECT", "Parameters type cased to OBJECT");
    assert(result.body.toolConfig.functionCallingConfig.mode === "ANY", "Tool choice mode ANY is set");
    assert(JSON.stringify(result.body.toolConfig.functionCallingConfig.allowedFunctionNames) === JSON.stringify(["get_weather"]), "Allowed function names listed correctly");
  } catch (err) {
    console.error("Test 3 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 4: Thought Signature and Tool Message Translation
  // ---------------------------------------------------------------------------
  try {
    const openAiRequest = {
      model: "gemini-3.6-flash",
      messages: [
        { role: "user", content: "Call tool." },
        {
          role: "assistant",
          content: "I will call the weather tool.",
          tool_calls: [
            {
              id: "call_999",
              type: "function",
              function: { name: "get_weather", arguments: "{\"location\":\"Tehran\"}" }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_999",
          name: "get_weather",
          content: "{\"weather\":\"Sunny, 20C\"}"
        }
      ]
    };

    const result = translateRequestToNative(openAiRequest, { modelName: "gemini-3.6-flash" });
    assert(result.body.contents.length === 3, "Contains exactly 3 messages in history");
    
    // Assistant tool_call translation
    const assistantMsg = result.body.contents[1];
    assert(assistantMsg.role === "model", "Assistant message role maps to model");
    assert(assistantMsg.parts[0].functionCall.name === "get_weather", "Assistant part 1 is functionCall 'get_weather'");
    assert(assistantMsg.parts[0].functionCall.id === "call_999", "Assistant functionCall carries correct ID");
    assert(assistantMsg.parts[0].functionCall.args.location === "Tehran", "Assistant functionCall arguments are fully parsed");
    assert(assistantMsg.parts[0].thoughtSignature === "context_engineering_is_the_way_to_go", "Missing thought_signature correctly injected with sentinel");

    // Tool response translation
    const toolMsg = result.body.contents[2];
    assert(toolMsg.role === "user", "Tool message role maps to user in native API");
    assert(toolMsg.parts[0].functionResponse.name === "get_weather", "Tool part is functionResponse");
    assert(toolMsg.parts[0].functionResponse.id === "call_999", "Tool functionResponse id matches tool_call_id");
    assert(toolMsg.parts[0].functionResponse.response.weather === "Sunny, 20C", "Tool response content is correctly parsed");
  } catch (err) {
    console.error("Test 4 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 5: Multimodal Image Request Translation
  // ---------------------------------------------------------------------------
  try {
    const openAiRequest = {
      model: "gemini-3.6-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this picture." },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" } }
          ]
        }
      ]
    };

    const result = translateRequestToNative(openAiRequest, { modelName: "gemini-3.6-flash" });
    assert(result.body.contents.length === 1, "Contains 1 message");
    assert(result.body.contents[0].parts.length === 2, "Message has 2 parts");
    assert(result.body.contents[0].parts[0].text === "Analyze this picture.", "Part 1 is text");
    assert(result.body.contents[0].parts[1].inlineData.mimeType === "image/png", "Part 2 is image inlineData with correct mimeType");
    assert(result.body.contents[0].parts[1].inlineData.data === "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "Part 2 contains base64 payload");
  } catch (err) {
    console.error("Test 5 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 6: Reasoning Effort / Thinking Config Translation (Gemini 3 vs Gemini 2.5)
  // ---------------------------------------------------------------------------
  try {
    const openAiRequest = {
      model: "gemini-3.6-flash",
      messages: [{ role: "user", content: "Reason deep." }],
      reasoning_effort: "medium"
    };

    // Test Gemini 3.x
    const resG3 = translateRequestToNative(openAiRequest, { modelName: "gemini-3.6-flash" });
    assert(resG3.body.generationConfig.thinkingConfig.thinkingLevel === "medium", "Gemini 3.6 maps thinkingLevel correctly");

    // Test Gemini 2.5
    const resG25 = translateRequestToNative(openAiRequest, { modelName: "gemini-2.5-flash" });
    assert(resG25.body.generationConfig.thinkingConfig.thinkingBudget === 2048, "Gemini 2.5 maps medium to thinkingBudget 2048");
  } catch (err) {
    console.error("Test 6 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 7: Native Response Translation to OpenAI shape
  // ---------------------------------------------------------------------------
  try {
    const nativeResponse = {
      responseId: "res-abc-123",
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              { text: "The answer is 42." }
            ],
            role: "model"
          },
          finishReason: "STOP"
        }
      ],
      usageMetadata: {
        promptTokenCount: 15,
        candidatesTokenCount: 25,
        totalTokenCount: 40
      }
    };

    const result = translateNativeResponseToOpenAi(nativeResponse, "gemini-3.6-flash");
    assert(result.id === "res-abc-123", "Carries responseId as ID");
    assert(result.model === "gemini-3.6-flash", "Correct model mapping");
    assert(result.choices.length === 1, "Exactly 1 choice mapped");
    assert(result.choices[0].message.role === "assistant", "Message role is assistant");
    assert(result.choices[0].message.content === "The answer is 42.", "Message text content mapped correctly");
    assert(result.choices[0].finish_reason === "stop", "Finish reason is stop");
    assert(result.usage.prompt_tokens === 15, "Prompt tokens mapped correctly");
    assert(result.usage.completion_tokens === 25, "Completion tokens mapped correctly");
    assert(result.usage.total_tokens === 40, "Total tokens mapped correctly");
  } catch (err) {
    console.error("Test 7 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 8: Native Tool Response Translation with Thought Signature
  // ---------------------------------------------------------------------------
  try {
    const nativeResponse = {
      responseId: "res-tool-456",
      candidates: [
        {
          index: 0,
          content: {
            parts: [
              {
                functionCall: {
                  name: "search_web",
                  args: { query: "OpenAI Router" },
                  id: "call_abc_xyz"
                },
                thoughtSignature: "sig_val_123"
              }
            ],
            role: "model"
          },
          finishReason: "STOP"
        }
      ]
    };

    const result = translateNativeResponseToOpenAi(nativeResponse, "gemini-3.6-flash");
    assert(result.choices[0].message.tool_calls.length === 1, "Tool call is mapped");
    assert(result.choices[0].message.tool_calls[0].id === "call_abc_xyz", "Tool call ID matches native functionCall ID");
    assert(result.choices[0].message.tool_calls[0].function.name === "search_web", "Tool function name matched");
    assert(result.choices[0].message.tool_calls[0].function.arguments === "{\"query\":\"OpenAI Router\"}", "Tool function arguments matched");
    assert(result.choices[0].message.tool_calls[0].extra_content.google.thought_signature === "sig_val_123", "Thought signature correctly extracted and embedded in tool_call extra_content");
    assert(result.choices[0].finish_reason === "tool_calls", "Finish reason overridden to tool_calls because of tool_call presence");
  } catch (err) {
    console.error("Test 8 crashed:", err);
    failed++;
  }

  console.log("\n=== Unit Tests Summary ===");
  console.log(`Passed: ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.error(`❌ ${failed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log("🚀 All tests passed successfully!");
  }
}

runTests();
