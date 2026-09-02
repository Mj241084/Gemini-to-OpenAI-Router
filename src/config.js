// Google AI Studio's OpenAI-compatibility endpoint.
// Docs: https://ai.google.dev/gemini-api/docs/openai
export const GOOGLE_OPENAI_CHAT_COMPLETIONS_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";

// Google's NATIVE embedContent/batchEmbedContents endpoints. We deliberately
// do NOT use the OpenAI-compat /v1/embeddings shim for this: as of this
// writing there are documented reports of the standard OpenAI `dimensions`
// parameter being ignored on Gemini models through that shim, which would
// silently corrupt vector search (wrong dimensionality). The native
// endpoint's `output_dimensionality` field is the well-documented, reliable
// way to control output size, so our /v1/embeddings route talks to this
// directly (still reusing the same key-rotation/rate-limit machinery).
export const googleEmbedContentUrl = (modelName) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:embedContent`;
export const googleBatchEmbedContentsUrl = (modelName) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:batchEmbedContents`;

// Google's NATIVE generateContent endpoint. Used ONLY for kind="tts" models
// (provider=google) - see index.js's callGoogleNativeTts() for the full
// explanation. The audio modality on the OpenAI-compat shim is a beta
// surface that was observed to fail in ways plain retrying never fixed;
// this native endpoint is the documented, stable way to do Gemini TTS.
export const googleGenerateContentUrl = (modelName) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;

// OpenRouter's OpenAI-compatible endpoint.
// Docs: https://openrouter.ai/docs/api-reference/chat-completion
export const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";

// Which upstream URL to use per model.provider value. Both providers accept
// a plain `Authorization: Bearer <key>` header, so no per-provider auth
// logic is needed beyond picking the right URL (and, for OpenRouter,
// optionally attaching attribution headers - see OPENROUTER_SITE_* below).
export const PROVIDER_ENDPOINTS = {
  google: GOOGLE_OPENAI_CHAT_COMPLETIONS_URL,
  openrouter: OPENROUTER_CHAT_COMPLETIONS_URL,
};

export const KNOWN_PROVIDERS = Object.keys(PROVIDER_ENDPOINTS);
export const DEFAULT_PROVIDER = "google";

// A model's "kind" controls which endpoint it's eligible for and keeps
// fallback chains from crossing capability boundaries (e.g. a TTS request
// must never cascade into a plain text chat model on failure, and vice
// versa). "chat" also covers ordinary tool-calling/text models.
export const KNOWN_KINDS = ["chat", "tts", "embedding"];
export const DEFAULT_KIND = "chat";

// Upper bound on how many (key, model) attempts we will make for a single
// incoming request before giving up. This exists purely as a safety valve;
// in practice it is bounded by (number of enabled models * number of
// enabled keys) anyway.
export const MAX_ATTEMPTS = 20;

// Per-upstream-request timeout (ms). Network wait time does NOT count
// against the Worker's CPU-time limit, so this is only about not hanging
// forever if Google's API stalls - it is not a CPU budget. Cloudflare
// itself has no hard duration limit on HTTP-triggered Workers as long as
// the client stays connected, so a long value here is safe on the
// platform side (see README section on timeouts for the caveat about
// Hermes' own client-side timeout).
export const UPSTREAM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Circuit breaker for flaky/overloaded models. After this many consecutive
// 502/503/504 (or network-error) responses FOR THE SAME MODEL, the model is
// taken out of rotation for MODEL_UNAVAILABLE_COOLDOWN_MS instead of being
// retried fresh on every incoming request - this is what actually removes
// the extra round-trip latency once a model is clearly struggling.
export const MODEL_FAIL_THRESHOLD = 3;
export const MODEL_UNAVAILABLE_COOLDOWN_MS = 120_000;

// How many rows to keep in the `logs` table before old rows are pruned.
export const MAX_LOG_ROWS = 5000;

// Default thinking levels used when a new model is added without
// specifying its own table. Ordered from lowest to highest reasoning
// effort - the LAST element is what gets used by default ("highest level"
// as requested), unless the model row sets an explicit default_thinking.
// An EMPTY array means "this model doesn't support/need reasoning_effort at
// all" - useful for non-thinking OpenRouter models, and mandatory for
// tts/embedding kinds - and disables the automatic injection entirely for
// that model.
export const DEFAULT_THINKING_LEVELS = ["minimal", "low", "medium", "high"];

// Seed data matching what the user already has today. This is only used by
// the optional `/admin/seed` convenience endpoint - see README.md.
export const SEED_MODELS = [
  {
    name: "gemini-3.5-flash",
    provider: "google",
    order: 1,
    rpm: 5,
    rpd: 20,
    thinking_levels: ["minimal", "low", "medium", "high"],
    default_thinking: "high",
  },
  {
    name: "gemini-3.6-flash",
    provider: "google",
    order: 2,
    rpm: 5,
    rpd: 20,
    thinking_levels: ["minimal", "low", "medium", "high"],
    default_thinking: "high",
  },
  {
    name: "gemini-3.7-flash",
    provider: "google",
    order: 3,
    rpm: 5,
    rpd: 20,
    thinking_levels: ["minimal", "low", "medium", "high"],
    default_thinking: "high",
  },
];

export const SEED_KEYS = [
  "YOUR_GEMINI_API_KEY_1",
  "YOUR_GEMINI_API_KEY_2",
  "YOUR_GEMINI_API_KEY_3",
].map((key, i) => ({ api_key: key, label: `key-${i + 1}`, provider: "google" }));