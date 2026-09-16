/**
 * Comprehensive Test Script for the Anthropic <-> Google Native Translate Layer
 * Validates the translation logic locally using Node.js (Node 18+, same
 * requirement as the rest of this project - global ReadableStream/TransformStream
 * are needed for the streaming tests).
 */

import {
  translateAnthropicRequestToNative,
  translateNativeResponseToAnthropic,
  translateAnthropicToolsWithCache,
  createAnthropicSseTransformer,
  translateAnthropicCountTokensRequest,
} from "../src/anthropicTranslate.js";

function makeGoogleSseStream(dataObjects) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const obj of dataObjects) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
      }
      controller.close();
    },
  });
}

async function collectSseEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  const events = [];
  for (const block of buffer.split("\n\n").filter((b) => b.trim())) {
    let eventType = "message";
    let dataLine = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventType = line.slice(6).trim();
      if (line.startsWith("data:")) dataLine = line.slice(5).trim();
    }
    events.push({ event: eventType, data: dataLine ? JSON.parse(dataLine) : null });
  }
  return events;
}

async function runTests() {
  console.log("=== Starting Anthropic Translate Unit Tests ===");

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

  // ---------------------------------------------------------------------
  // Test 1: Basic request translation (system + user + generation params)
  // ---------------------------------------------------------------------
  try {
    const anthropicRequest = {
      model: "claude-sonnet-4-5", // ignored - candidate.modelName always wins
      system: "You are a helpful assistant.",
      max_tokens: 512,
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ["\n\nHuman:"],
      messages: [{ role: "user", content: "Hello! What's your name?" }],
    };

    const result = translateAnthropicRequestToNative(anthropicRequest, { modelName: "gemini-3.6-flash" });
    assert(
      result.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
      "Non-streaming URL maps to generateContent (no alt=sse)"
    );
    assert(result.body.systemInstruction?.parts?.[0]?.text === "You are a helpful assistant.", "System instruction extracted");
    assert(result.body.contents.length === 1 && result.body.contents[0].role === "user", "User message mapped correctly");
    assert(result.body.contents[0].parts[0].text === "Hello! What's your name?", "User text mapped correctly");
    assert(result.body.generationConfig.maxOutputTokens === 512, "max_tokens mapped to maxOutputTokens");
    assert(result.body.generationConfig.temperature === 0.4, "temperature mapped");
    assert(result.body.generationConfig.topP === 0.9, "top_p mapped to topP");
    assert(result.body.generationConfig.topK === 40, "top_k mapped to topK");
    assert(result.body.generationConfig.stopSequences[0] === "\n\nHuman:", "stop_sequences mapped");
  } catch (err) {
    console.error("Test 1 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 2: Streaming URL uses alt=sse
  // ---------------------------------------------------------------------
  try {
    const result = translateAnthropicRequestToNative(
      { max_tokens: 100, stream: true, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.6-flash" }
    );
    assert(result.url.includes(":streamGenerateContent"), "Streaming URL uses streamGenerateContent");
    assert(result.url.includes("?alt=sse"), "Streaming URL includes ?alt=sse");
  } catch (err) {
    console.error("Test 2 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 3: Tools + tool_choice translation
  // ---------------------------------------------------------------------
  try {
    const tools = [
      {
        name: "search_web",
        description: "Search the web",
        input_schema: {
          type: "object",
          additionalProperties: false,
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];
    const decls = translateAnthropicToolsWithCache(tools);
    assert(decls[0].name === "search_web", "Tool name mapped");
    assert(decls[0].parameters.type === "OBJECT", "Tool schema type uppercased via shared sanitizer");
    assert(!("additionalProperties" in decls[0].parameters), "additionalProperties stripped from tool schema");

    const result = translateAnthropicRequestToNative(
      {
        max_tokens: 100,
        messages: [{ role: "user", content: "search for cats" }],
        tools,
        tool_choice: { type: "tool", name: "search_web" },
      },
      { modelName: "gemini-3.6-flash" }
    );
    assert(result.body.tools[0].functionDeclarations[0].name === "search_web", "Tools attached to native body");
    assert(result.body.toolConfig.functionCallingConfig.mode === "ANY", "tool_choice type:tool maps to mode ANY");
    assert(
      result.body.toolConfig.functionCallingConfig.allowedFunctionNames[0] === "search_web",
      "tool_choice name forced into allowedFunctionNames"
    );
  } catch (err) {
    console.error("Test 3 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 4: tool_use / tool_result round trip (name recovery + signature passthrough)
  // ---------------------------------------------------------------------
  try {
    const anthropicRequest = {
      max_tokens: 100,
      messages: [
        { role: "user", content: "what's the weather in Tehran?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_123",
              name: "get_weather",
              input: { city: "Tehran" },
              _google_thought_signature: "sig_abc",
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "22C, sunny" }],
        },
      ],
    };

    const result = translateAnthropicRequestToNative(anthropicRequest, { modelName: "gemini-3.6-flash" });
    const modelTurn = result.body.contents.find((c) => c.role === "model");
    const userToolTurn = result.body.contents[result.body.contents.length - 1];

    assert(modelTurn.parts[0].functionCall.name === "get_weather", "tool_use mapped to functionCall");
    assert(modelTurn.parts[0].thoughtSignature === "sig_abc", "Stashed thought signature round-tripped into part");
    assert(userToolTurn.parts[0].functionResponse.name === "get_weather", "tool_result name RECOVERED from earlier tool_use (id lookup)");
    assert(userToolTurn.parts[0].functionResponse.response.result === "22C, sunny", "tool_result content mapped");
  } catch (err) {
    console.error("Test 4 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 5: thinking budget_tokens -> Gemini 3 thinkingLevel approximation
  // ---------------------------------------------------------------------
  try {
    const low = translateAnthropicRequestToNative(
      { max_tokens: 100, thinking: { type: "enabled", budget_tokens: 500 }, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.6-flash" }
    );
    const high = translateAnthropicRequestToNative(
      { max_tokens: 100, thinking: { type: "enabled", budget_tokens: 20000 }, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.6-flash" }
    );
    const budget25 = translateAnthropicRequestToNative(
      { max_tokens: 100, thinking: { type: "enabled", budget_tokens: 3000 }, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-2.5-flash" }
    );
    assert(low.body.generationConfig.thinkingConfig.thinkingLevel === "low", "Small budget_tokens maps to low thinkingLevel");
    assert(high.body.generationConfig.thinkingConfig.thinkingLevel === "high", "Large budget_tokens maps to high thinkingLevel");
    assert(budget25.body.generationConfig.thinkingConfig.thinkingBudget === 3000, "Gemini 2.5 passes budget_tokens through directly");
  } catch (err) {
    console.error("Test 5 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 6: Non-streaming response translation (plain text)
  // ---------------------------------------------------------------------
  try {
    const nativeResponse = {
      responseId: "abc123",
      candidates: [{ content: { parts: [{ text: "Hi there!" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
    };
    const result = translateNativeResponseToAnthropic(nativeResponse, "gemini-3.6-flash");
    assert(result.type === "message", "Response type is message");
    assert(result.content[0].type === "text" && result.content[0].text === "Hi there!", "Text content mapped");
    assert(result.stop_reason === "end_turn", "STOP finishReason maps to end_turn");
    assert(result.usage.input_tokens === 10 && result.usage.output_tokens === 4, "Usage mapped correctly");
  } catch (err) {
    console.error("Test 6 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 7: Non-streaming response translation (tool_use + thought signature)
  // ---------------------------------------------------------------------
  try {
    const nativeResponse = {
      candidates: [
        {
          content: {
            parts: [{ functionCall: { name: "get_weather", args: { city: "Tehran" }, id: "call_1" }, thoughtSignature: "sig_xyz" }],
          },
          finishReason: "STOP",
        },
      ],
    };
    const result = translateNativeResponseToAnthropic(nativeResponse, "gemini-3.6-flash");
    assert(result.stop_reason === "tool_use", "Presence of functionCall overrides stop_reason to tool_use");
    assert(result.content[0].type === "tool_use" && result.content[0].name === "get_weather", "tool_use block mapped");
    assert(result.content[0]._google_thought_signature === "sig_xyz", "Thought signature stashed on tool_use block for round-trip");
  } catch (err) {
    console.error("Test 7 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 8: Streaming transformer - text-only stream shape/order
  // ---------------------------------------------------------------------
  try {
    const chunks = [
      { candidates: [{ content: { parts: [{ text: "Hello" }] } }] },
      { candidates: [{ content: { parts: [{ text: " world" }] } }] },
      {
        candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
      },
    ];

    let reportedUsage = null;
    const src = makeGoogleSseStream(chunks);
    const transformer = createAnthropicSseTransformer("gemini-3.6-flash", {
      onUsage: (u) => {
        reportedUsage = u;
      },
    });
    const events = await collectSseEvents(src.pipeThrough(transformer));
    const types = events.map((e) => e.event);

    assert(types[0] === "message_start", "First event is message_start");
    assert(types.includes("content_block_start"), "Has content_block_start");
    assert(types.filter((t) => t === "content_block_delta").length === 2, "Two text_delta events emitted");
    assert(types.includes("content_block_stop"), "Has content_block_stop");
    assert(types[types.length - 2] === "message_delta", "Second-to-last event is message_delta");
    assert(types[types.length - 1] === "message_stop", "Last event is message_stop");

    const firstDelta = events.find((e) => e.event === "content_block_delta");
    assert(firstDelta.data.delta.text === "Hello", "First text delta content matches");
    assert(reportedUsage && reportedUsage.prompt_tokens === 5 && reportedUsage.completion_tokens === 2, "onUsage called with correct totals");
  } catch (err) {
    console.error("Test 8 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 9: Streaming transformer - tool_use with thoughtSignature stash
  // ---------------------------------------------------------------------
  try {
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "read_file", args: { path: "main.py" }, id: "call_tool_1" },
                  thoughtSignature: "sig_stream_xyz_456",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
      },
    ];

    const src = makeGoogleSseStream(chunks);
    const transformer = createAnthropicSseTransformer("gemini-3.6-flash");
    const events = await collectSseEvents(src.pipeThrough(transformer));

    const blockStart = events.find((e) => e.event === "content_block_start");
    assert(blockStart && blockStart.data.content_block.type === "tool_use", "Streaming emitted tool_use block start");
    assert(
      blockStart.data.content_block._google_thought_signature === "sig_stream_xyz_456",
      "Streaming stashed _google_thought_signature on tool_use content_block_start"
    );
    assert(blockStart.data.content_block.name === "read_file", "Tool name matches");

    const blockDelta = events.find((e) => e.event === "content_block_delta");
    assert(
      blockDelta && blockDelta.data.delta.partial_json === JSON.stringify({ path: "main.py" }),
      "Streaming emitted correct input_json_delta"
    );

    // Verify round-trip through translateAnthropicRequestToNative on the next turn
    const nextTurnRequest = {
      max_tokens: 200,
      messages: [
        { role: "user", content: "read main.py" },
        {
          role: "assistant",
          content: [blockStart.data.content_block],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: blockStart.data.content_block.id, content: "print('hello')" }],
        },
      ],
    };

    const nativeResult = translateAnthropicRequestToNative(nextTurnRequest, { modelName: "gemini-3.6-flash" });
    const modelTurn = nativeResult.body.contents.find((c) => c.role === "model");
    assert(
      modelTurn && modelTurn.parts[0].thoughtSignature === "sig_stream_xyz_456",
      "Stashed streaming thought signature round-tripped into native request body part"
    );
  } catch (err) {
    console.error("Test 9 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 10: count_tokens request translation
  // ---------------------------------------------------------------------
  try {
    const countReq = {
      model: "claude-sonnet-4-5",
      system: "You are a calculator.",
      messages: [{ role: "user", content: "2 + 2 = ?" }],
      tools: [
        {
          name: "add",
          description: "Add two numbers",
          input_schema: { type: "object", properties: { a: { type: "number" } } },
        },
      ],
    };

    const countResult = translateAnthropicCountTokensRequest(countReq, { modelName: "gemini-3.6-flash" });
    assert(
      countResult.url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:countTokens",
      "countTokens URL maps to :countTokens endpoint"
    );
    assert(
      countResult.body.generateContentRequest && countResult.body.generateContentRequest.model === "models/gemini-3.6-flash",
      "generateContentRequest wrapper includes model field"
    );
    assert(
      countResult.body.generateContentRequest.systemInstruction.parts[0].text === "You are a calculator.",
      "countTokens includes system instruction"
    );
    assert(
      countResult.body.generateContentRequest.contents[0].parts[0].text === "2 + 2 = ?",
      "countTokens includes user contents"
    );
    assert(
      countResult.body.generateContentRequest.tools[0].functionDeclarations[0].name === "add",
      "countTokens includes tool declarations"
    );
  } catch (err) {
    console.error("Test 10 crashed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------
  // Test 11: Thinking level normalization and forced fallback
  // ---------------------------------------------------------------------
  try {
    // Case normalization: DB value stored with wrong casing still gets fixed
    // automatically (Claude Code's normal traffic hits exactly this branch,
    // since it omits `thinking` on third-party providers).
    const uppercaseDefault = translateAnthropicRequestToNative(
      { max_tokens: 100, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.7-flash", defaultThinking: "MINIMAL" }
    );
    assert(
      uppercaseDefault.body.generationConfig.thinkingConfig.thinkingLevel === "minimal",
      "default_thinking is lowercased before being sent, regardless of DB casing"
    );

    // forceDefaultThinking: explicit caller thinking ignored, default used (and lowercased)
    const forced = translateAnthropicRequestToNative(
      { max_tokens: 100, thinking: { type: "enabled", budget_tokens: 500 }, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.7-flash", defaultThinking: "MINIMAL", forceDefaultThinking: true }
    );
    assert(
      forced.body.generationConfig.thinkingConfig.thinkingLevel === "minimal",
      "forceDefaultThinking ignores explicit caller thinking, falls back to lowercased default"
    );

    // Regression guard: normal explicit thinking still works as before when NOT forced
    const normal = translateAnthropicRequestToNative(
      { max_tokens: 100, thinking: { type: "enabled", budget_tokens: 500 }, messages: [{ role: "user", content: "hi" }] },
      { modelName: "gemini-3.7-flash", defaultThinking: "minimal" }
    );
    assert(
      normal.body.generationConfig.thinkingConfig.thinkingLevel === "low",
      "without forceDefaultThinking, explicit caller thinking still wins as before"
    );
  } catch (err) {
    console.error("Thinking normalization/fallback test crashed:", err);
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
