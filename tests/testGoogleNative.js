/**
 * Tests for the Google-native passthrough surface.
 * Pure functions + handler with a fake DO stub and a mocked global fetch.
 * Run: node tests/testGoogleNative.js
 */

import worker, { handleGoogleNative } from "../src/index.js";
import {
  parseGoogleNativePath,
  parseGoogleModelsPath,
  detectKind,
  buildUpstreamUrl,
  rewriteModelFields,
  normalizeThinking,
  ensureThoughtSignatures,
  extractUsageFromText,
  extractUsageFromSseStream,
} from "../src/googleNative.js";

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`✅ [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${msg}`);
    failed++;
  }
}

const SENT = "context_engineering_is_the_way_to_go";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const MODELS = [
  { name: "gemini-test-1", enabled: 1, kind: "chat", order_num: 1 },
  { name: "emb-test", enabled: 1, kind: "embedding", order_num: 2 },
  { name: "tts-test", enabled: 1, kind: "tts", order_num: 3 },
  { name: "disabled-test", enabled: 0, kind: "chat", order_num: 4 },
];

function cand(n, extra = {}) {
  return {
    modelId: n,
    modelName: extra.modelName || (n === 1 ? "gemini-3.6-flash" : `gemini-test-${n}`),
    provider: "google",
    kind: "chat",
    defaultThinking: "high",
    keyId: n,
    apiKey: `UPSTREAM-KEY-${n}`,
    keyLabel: `k${n}`,
    ...extra,
  };
}

function makeHarness({ pick, fetchScript }) {
  const calls = { pick: [], success: [], failure: [], fetch: [] };
  const stub = {
    pickCandidate: async (args) => {
      calls.pick.push({ ...args, excludePairs: [...args.excludePairs] });
      return pick(args, calls.pick.length);
    },
    reportSuccess: async (a) => {
      calls.success.push(a);
      return { ok: true };
    },
    reportFailure: async (a) => {
      calls.failure.push(a);
      return { ok: true };
    },
    getStatus: async () => ({ next_daily_reset_in_sec: 600 }),
    listModels: async () => MODELS,
  };
  const env = { PROXY_TOKEN: "CLIENT-TOKEN", ROUTER_DO: { idFromName: () => "id", get: () => stub } };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.fetch.push({ url: String(url), headers: opts.headers, body: opts.body });
    const next = fetchScript.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return next();
  };
  return {
    env,
    ctx,
    calls,
    flush: () => Promise.all(pending),
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

const ok = (text) => () => new Response(text, { status: 200, headers: { "content-type": "application/json" } });
const errResp = (status, text) => () => new Response(text, { status, headers: { "content-type": "application/json" } });
const OK_BODY =
  '{"candidates":[{"content":{"parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":11,"candidatesTokenCount":4,"totalTokenCount":15},"modelVersion":"x"}';

function post(path, body) {
  return new Request(`https://router.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
function run(h, path, body) {
  const req = post(path, body);
  return handleGoogleNative(req, h.env, h.ctx, parseGoogleNativePath(new URL(req.url).pathname));
}
const SIMPLE = { contents: [{ role: "user", parts: [{ text: "hello" }] }] };

async function main() {
  // =========================================================================
  // Pure functions
  // =========================================================================
  console.log("\n--- parseGoogleNativePath / parseGoogleModelsPath ---");
  {
    const p1 = parseGoogleNativePath("/v1beta/models/gemini-3.6-flash:generateContent");
    assert(p1 && p1.apiVersion === "v1beta" && p1.model === "gemini-3.6-flash" && p1.action === "generateContent", "v1beta generateContent parsed");
    const p2 = parseGoogleNativePath("/v1/models/auto:streamGenerateContent");
    assert(p2 && p2.apiVersion === "v1" && p2.model === "auto", "v1 streamGenerateContent parsed");
    for (const a of ["countTokens", "embedContent", "batchEmbedContents"]) {
      assert(parseGoogleNativePath(`/v1beta/models/m:${a}`)?.action === a, `action ${a} parsed`);
    }
    assert(parseGoogleNativePath("/v1beta/models/models%2Fauto:countTokens")?.model === "auto", "encoded models/ prefix stripped");
    assert(parseGoogleNativePath("/v1beta/models/x:unknownAction") === null, "unknown action rejected");
    assert(parseGoogleNativePath("/v1/models") === null, "/v1/models is not a native route");
    assert(parseGoogleNativePath("/v1beta/tunedModels/x:generateContent") === null, "tunedModels rejected");
    assert(parseGoogleModelsPath("/v1beta/models")?.name === null, "models list path");
    assert(parseGoogleModelsPath("/v1beta/models/auto")?.name === "auto", "single model path");
    assert(parseGoogleModelsPath("/v1beta/models/auto:generateContent") === null, "action path is not a models GET path");
    assert(parseGoogleModelsPath("/v1/models") === null, "/v1/models untouched by google models parser");
  }

  console.log("\n--- detectKind ---");
  {
    assert(detectKind("embedContent", {}) === "embedding", "embedContent -> embedding");
    assert(detectKind("batchEmbedContents", {}) === "embedding", "batchEmbedContents -> embedding");
    assert(detectKind("generateContent", { generationConfig: { responseModalities: ["audio"] } }) === "tts", "AUDIO (lowercase) -> tts");
    assert(detectKind("streamGenerateContent", { generationConfig: { responseModalities: ["TEXT", "AUDIO"] } }) === "tts", "TEXT+AUDIO -> tts");
    assert(detectKind("generateContent", SIMPLE) === "chat", "plain -> chat");
    assert(detectKind("countTokens", { generationConfig: { responseModalities: ["AUDIO"] } }) === "chat", "countTokens always chat");
  }

  console.log("\n--- buildUpstreamUrl ---");
  {
    const u = buildUpstreamUrl({
      modelName: "m1",
      action: "streamGenerateContent",
      searchParams: new URLSearchParams("alt=sse&key=SECRET"),
    });
    assert(u === "https://generativelanguage.googleapis.com/v1beta/models/m1:streamGenerateContent?alt=sse", "key dropped, alt=sse kept, v1beta");
    const u2 = buildUpstreamUrl({ modelName: "m1", action: "generateContent", searchParams: new URLSearchParams("key=SECRET") });
    assert(!u2.includes("?") && !u2.includes("SECRET"), "no query when only key present");
  }

  console.log("\n--- rewriteModelFields ---");
  {
    const e = { model: "models/old", content: { parts: [{ text: "x" }] } };
    const e2 = rewriteModelFields("embedContent", e, "new");
    assert(e2.model === "models/new" && e.model === "models/old" && e2 !== e, "embedContent rewritten, input not mutated");
    const b = { requests: [{ model: "models/old", content: {} }, { model: "models/old", content: {} }] };
    const b2 = rewriteModelFields("batchEmbedContents", b, "new");
    assert(b2.requests.every((r) => r.model === "models/new") && b.requests[0].model === "models/old", "batch requests rewritten, input not mutated");
    const c = { generateContentRequest: { model: "models/old", contents: [] } };
    const c2 = rewriteModelFields("countTokens", c, "new");
    assert(c2.generateContentRequest.model === "models/new" && c.generateContentRequest.model === "models/old", "countTokens inner model rewritten");
    assert(rewriteModelFields("generateContent", SIMPLE, "new") === SIMPLE, "generateContent returns same object");
    const cPlain = { contents: [] };
    assert(rewriteModelFields("countTokens", cPlain, "new") === cPlain, "plain countTokens untouched");
  }

  console.log("\n--- normalizeThinking ---");
  {
    const mk = (lvl) => ({ generationConfig: { thinkingConfig: { thinkingLevel: lvl, includeThoughts: true } } });
    const lv = (b) => b.generationConfig.thinkingConfig.thinkingLevel;
    assert(lv(normalizeThinking(mk("none"), { modelName: "gemini-3.6-flash", defaultThinking: "high" })) === "minimal", '"none" -> minimal');
    assert(lv(normalizeThinking(mk("MEDIUM"), { modelName: "gemini-3.6-flash", defaultThinking: "high" })) === "medium", '"MEDIUM" -> medium');
    assert(lv(normalizeThinking(mk("banana"), { modelName: "gemini-3.6-flash", defaultThinking: "LOW" })) === "low", "invalid -> model default");
    const dropped = normalizeThinking(mk("banana"), { modelName: "gemini-3.6-flash", defaultThinking: "also-bad" });
    assert(!("thinkingLevel" in dropped.generationConfig.thinkingConfig) && dropped.generationConfig.thinkingConfig.includeThoughts === true, "no valid value -> only thinkingLevel removed");
    const g25 = mk("none");
    assert(normalizeThinking(g25, { modelName: "gemini-2.5-flash", defaultThinking: "high" }) === g25, "2.5 untouched");
    assert(normalizeThinking(SIMPLE, { modelName: "gemini-3.6-flash", defaultThinking: "high" }) === SIMPLE, "no thinkingConfig -> nothing injected");
    const budget = { generationConfig: { thinkingConfig: { thinkingBudget: 1024 } } };
    assert(normalizeThinking(budget, { modelName: "gemini-3.6-flash", defaultThinking: "high" }) === budget, "thinkingBudget untouched");
  }

  console.log("\n--- ensureThoughtSignatures ---");
  {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "x" }] },
        { role: "model", parts: [{ functionCall: { name: "a", args: {} } }, { functionCall: { name: "b", args: {} }, thoughtSignature: "REAL" }] },
      ],
    };
    ensureThoughtSignatures(body);
    assert(body.contents[1].parts[0].thoughtSignature === SENT, "sentinel injected when missing");
    assert(body.contents[1].parts[1].thoughtSignature === "REAL", "real signature preserved");
    ensureThoughtSignatures(body);
    assert(body.contents[1].parts[0].thoughtSignature === SENT && body.contents[1].parts[1].thoughtSignature === "REAL", "idempotent");
  }

  console.log("\n--- usage extractors ---");
  {
    const u = extractUsageFromText(OK_BODY);
    assert(u && u.promptTokens === 11 && u.completionTokens === 4 && u.totalTokens === 15, "usage from JSON text");
    assert(extractUsageFromText('{"candidates":[]}') === null, "no usage -> null");
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode('data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\ndata: {"usageMetadata":{"promptTok'));
        c.enqueue(enc.encode('enCount":1}}\n\ndata: {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}\n\n'));
        c.close();
      },
    });
    const su = await extractUsageFromSseStream(stream);
    assert(su && su.promptTokens === 7 && su.totalTokens === 10, "SSE usage across split chunks, last wins");
  }

  // =========================================================================
  // Handler tests
  // =========================================================================
  console.log("\n--- handler: success non-stream ---");
  {
    const h = makeHarness({ pick: () => cand(1), fetchScript: [ok(OK_BODY)] });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent?key=CLIENT-TOKEN", SIMPLE);
      const text = await res.text();
      await h.flush();
      assert(res.status === 200 && text === OK_BODY, "response is byte-identical to upstream text");
      assert(h.calls.fetch[0].url === "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent", "upstream URL uses chosen model, no key param");
      assert(h.calls.fetch[0].headers["x-goog-api-key"] === "UPSTREAM-KEY-1", "upstream gets candidate key, not client token");
      assert(h.calls.pick[0].kind === "chat" && h.calls.pick[0].requestedModel === "auto", "pickCandidate got kind=chat, model=auto");
      assert(h.calls.success.length === 1 && h.calls.success[0].totalTokens === 15 && h.calls.success[0].promptTokens === 11, "reportSuccess with parsed usage");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: 429 rotates key ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("1:1") ? cand(2) : cand(1)),
      fetchScript: [errResp(429, '{"error":{"message":"quota"}}'), ok(OK_BODY)],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      await h.flush();
      assert(res.status === 200, "succeeds after key rotation");
      assert(h.calls.pick[1].excludePairs.includes("1:1"), "429 excludes keyId:modelId pair");
      assert(h.calls.failure[0].scope === "key" && h.calls.failure[0].httpStatus === 429, "failure reported with scope=key");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: 503 rotates model ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("model:1") ? cand(2) : cand(1)),
      fetchScript: [errResp(503, '{"error":{"status":"UNAVAILABLE"}}'), ok(OK_BODY)],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      await h.flush();
      assert(res.status === 200 && h.calls.pick[1].excludePairs.includes("model:1"), "503 excludes whole model");
      assert(h.calls.failure[0].scope === "model", "failure scope=model");
      assert(h.calls.fetch[1].url.includes("gemini-test-2"), "second attempt targets model 2");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: 500 + UNAVAILABLE rotates model ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("model:1") ? cand(2) : cand(1)),
      fetchScript: [errResp(500, '{"error":{"code":500,"status":"UNAVAILABLE"}}'), ok(OK_BODY)],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      await h.flush();
      assert(res.status === 200 && h.calls.failure[0].scope === "model", "transient 500 treated as model failure");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: network error rotates model ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("model:1") ? cand(2) : cand(1)),
      fetchScript: [
        () => {
          throw new Error("boom");
        },
        ok(OK_BODY),
      ],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      await h.flush();
      assert(res.status === 200 && h.calls.failure[0].httpStatus === 0 && h.calls.failure[0].scope === "model", "network error -> model scope, httpStatus 0");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: 400 fail-fast, raw body ---");
  {
    const raw = '{"error":{"code":400,"message":"bad contents","status":"INVALID_ARGUMENT"}}';
    const h = makeHarness({ pick: () => cand(1), fetchScript: [errResp(400, raw)] });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      const text = await res.text();
      await h.flush();
      assert(res.status === 400 && text === raw, "raw Google 400 body returned");
      assert(h.calls.fetch.length === 1, "no retry on 400");
      assert(h.calls.failure[0].scope === "none", "400 reported with scope=none");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: 401 rotates key ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("1:1") ? cand(2) : cand(1)),
      fetchScript: [errResp(401, '{"error":{"status":"UNAUTHENTICATED"}}'), ok(OK_BODY)],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      await h.flush();
      assert(res.status === 200 && h.calls.failure[0].scope === "key", "401 rotates key");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: exhaustion ---");
  {
    const h = makeHarness({ pick: () => null, fetchScript: [] });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      const j = await res.json();
      assert(res.status === 429 && j.error.status === "RESOURCE_EXHAUSTED" && j.error.code === 429, "exhaustion -> Google-shaped 429");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: bad JSON ---");
  {
    const h = makeHarness({ pick: () => cand(1), fetchScript: [] });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", "{not json");
      const j = await res.json();
      assert(res.status === 400 && j.error.status === "INVALID_ARGUMENT", "invalid JSON -> Google-shaped 400");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: SSE stream passthrough + usage ---");
  {
    const sseText =
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n' +
      'data: {"usageMetadata":{"promptTokenCount":7,"candidatesTokenCount":3,"totalTokenCount":10}}\n\n';
    const h = makeHarness({
      pick: () => cand(1),
      fetchScript: [
        () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(enc.encode(sseText));
                c.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/event-stream" } }
          ),
      ],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:streamGenerateContent?alt=sse", SIMPLE);
      const text = await res.text();
      await h.flush();
      assert(text === sseText, "SSE bytes passed through untouched");
      assert(h.calls.fetch[0].url.endsWith(":streamGenerateContent?alt=sse"), "alt=sse forwarded upstream");
      assert(h.calls.success.length === 1 && h.calls.success[0].totalTokens === 10, "stream usage reported after completion");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: embedding kind + model rewrite ---");
  {
    const h = makeHarness({ pick: () => cand(5, { kind: "embedding" }), fetchScript: [ok('{"embedding":{"values":[0.1,0.2]}}')] });
    try {
      const res = await run(h, "/v1beta/models/auto:embedContent", { model: "models/auto", content: { parts: [{ text: "x" }] }, outputDimensionality: 768 });
      await res.text();
      await h.flush();
      const sent = JSON.parse(h.calls.fetch[0].body);
      assert(h.calls.pick[0].kind === "embedding", "pickCandidate kind=embedding");
      assert(sent.model === "models/gemini-test-5" && sent.outputDimensionality === 768, "body.model rewritten, other fields kept");
      assert(h.calls.success[0].promptTokens === null, "embedding usage tokens null");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: tts kind ---");
  {
    const h = makeHarness({ pick: () => cand(6, { kind: "tts" }), fetchScript: [ok("{}")] });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", { ...SIMPLE, generationConfig: { responseModalities: ["AUDIO"] } });
      await res.text();
      await h.flush();
      assert(h.calls.pick[0].kind === "tts", "AUDIO modality routes to kind=tts");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: thought signature + thinking normalization on the wire ---");
  {
    const body = {
      contents: [
        { role: "user", parts: [{ text: "q" }] },
        { role: "model", parts: [{ functionCall: { name: "f", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "f", response: { r: 1 } } }] },
      ],
      generationConfig: { thinkingConfig: { thinkingLevel: "none" } },
    };
    const h = makeHarness({ pick: () => cand(1), fetchScript: [ok(OK_BODY)] });
    try {
      const res = await run(h, "/v1beta/models/gemini-test-1:generateContent", body);
      await res.text();
      const sent = JSON.parse(h.calls.fetch[0].body);
      assert(sent.contents[1].parts[0].thoughtSignature === SENT, "sentinel signature present upstream");
      assert(sent.generationConfig.thinkingConfig.thinkingLevel === "minimal", 'thinkingLevel "none" normalized to minimal upstream');
      assert(h.calls.pick[0].requestedModel === "gemini-test-1", "explicit model name forwarded as requestedModel");
    } finally {
      h.restore();
    }
  }

  console.log("\n--- handler: non-google provider skipped ---");
  {
    const h = makeHarness({
      pick: (a) => (a.excludePairs.includes("model:9") ? cand(1) : cand(9, { provider: "openrouter" })),
      fetchScript: [ok(OK_BODY)],
    });
    try {
      const res = await run(h, "/v1beta/models/auto:generateContent", SIMPLE);
      await res.text();
      assert(res.status === 200 && h.calls.fetch.length === 1, "non-google candidate skipped without a fetch");
    } finally {
      h.restore();
    }
  }

  // =========================================================================
  // Route-level tests via worker.fetch
  // =========================================================================
  console.log("\n--- routing & auth ---");
  {
    const h = makeHarness({ pick: () => cand(1), fetchScript: [] });
    try {
      let res = await worker.fetch(post("/v1beta/models/auto:generateContent?key=WRONG", SIMPLE), h.env, h.ctx);
      let j = await res.json();
      assert(res.status === 401 && j.error.status === "UNAUTHENTICATED", "wrong token -> Google-shaped 401");

      res = await worker.fetch(
        new Request("https://router.test/v1beta/models", { headers: { "x-goog-api-key": "CLIENT-TOKEN" } }),
        h.env,
        h.ctx
      );
      j = await res.json();
      const names = j.models.map((m) => m.baseModelId);
      assert(res.status === 200 && names.includes("auto") && names.includes("fast") && names.includes("stable"), "model list has auto/fast/stable");
      assert(names.includes("gemini-test-1") && names.includes("emb-test") && !names.includes("disabled-test"), "enabled models listed, disabled hidden");
      assert(j.models.find((m) => m.baseModelId === "emb-test").supportedGenerationMethods.includes("embedContent"), "embedding methods advertised");

      res = await worker.fetch(
        new Request("https://router.test/v1beta/models/auto", { headers: { authorization: "Bearer CLIENT-TOKEN" } }),
        h.env,
        h.ctx
      );
      j = await res.json();
      assert(res.status === 200 && j.name === "models/auto", "single model GET with Bearer auth");

      res = await worker.fetch(
        new Request("https://router.test/v1beta/models/nope", { headers: { "x-goog-api-key": "CLIENT-TOKEN" } }),
        h.env,
        h.ctx
      );
      assert(res.status === 404, "unknown model -> 404");

      res = await worker.fetch(
        new Request("https://router.test/v1beta/files", { headers: { "x-goog-api-key": "CLIENT-TOKEN" } }),
        h.env,
        h.ctx
      );
      j = await res.json();
      assert(res.status === 501 && j.error.status === "UNIMPLEMENTED", "/v1beta/files -> 501 UNIMPLEMENTED");

      res = await worker.fetch(
        new Request("https://router.test/v1/models", { headers: { authorization: "Bearer CLIENT-TOKEN" } }),
        h.env,
        h.ctx
      );
      j = await res.json();
      assert(res.status === 200 && j.object === "list" && j.data[0].id === "auto", "existing GET /v1/models (OpenAI shape) unchanged");
    } finally {
      h.restore();
    }
  }

  console.log("\n=== Unit Tests Summary ===");
  console.log(`Passed: ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.error(`❌ ${failed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log("🚀 All Google-native tests passed!");
    process.exit(0);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
