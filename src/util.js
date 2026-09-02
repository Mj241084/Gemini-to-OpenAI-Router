// ---------------------------------------------------------------------------
// Time bucketing
// ---------------------------------------------------------------------------

// Per-minute bucket for RPM limiting. Plain UTC minute epoch - resets every
// real minute, no timezone considerations needed here.
export function getMinuteWindow(nowMs = Date.now()) {
  return Math.floor(nowMs / 60000);
}

// Per-day bucket for RPD limiting, with the "day" defined as starting at
// 12:30 PM Iran time (Asia/Tehran, UTC+3:30, no DST currently observed).
// Before 12:30 the bucket id still belongs to the *previous* calendar day.
// Returns a stable string like "2026-08-27" you can compare for equality.
export function getIranDayWindow(nowMs = Date.now()) {
  const date = new Date(nowMs);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  let y = parseInt(parts.year, 10);
  let m = parseInt(parts.month, 10);
  let d = parseInt(parts.day, 10);
  // "24" shows up from some ICU implementations for midnight; normalize.
  let hour = parseInt(parts.hour, 10) % 24;
  const minute = parseInt(parts.minute, 10);

  const afterReset = hour > 12 || (hour === 12 && minute >= 30);
  if (!afterReset) {
    // Still belongs to yesterday's quota-day. Step back one calendar day
    // using UTC arithmetic on a synthetic date (we only need the
    // year/month/day, not a real timezone-aware Date object).
    const prev = new Date(Date.UTC(y, m - 1, d));
    prev.setUTCDate(prev.getUTCDate() - 1);
    y = prev.getUTCFullYear();
    m = prev.getUTCMonth() + 1;
    d = prev.getUTCDate();
  }
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// Milliseconds until the next 12:30 Iran-time boundary, for building
// human-readable "resets in ..." messages.
export function msUntilNextIranReset(nowMs = Date.now()) {
  // Binary-search-free approach: walk forward minute by minute is too slow;
  // instead compute the next reset instant directly using the Iran offset.
  // Asia/Tehran currently has a fixed UTC+03:30 offset (no DST since 2022).
  const IRAN_OFFSET_MIN = 3 * 60 + 30;
  const nowUtcMin = Math.floor(nowMs / 60000);
  const nowIranMin = nowUtcMin + IRAN_OFFSET_MIN;
  const minsIntoIranDay = ((nowIranMin % 1440) + 1440) % 1440;
  const resetMinsIntoDay = 12 * 60 + 30;
  let delta = resetMinsIntoDay - minsIntoIranDay;
  if (delta <= 0) delta += 1440;
  return delta * 60000;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function extractBearerToken(request) {
  const header = request.headers.get("authorization") || request.headers.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function isAuthorized(request, expectedToken) {
  if (!expectedToken) return false;
  const token = extractBearerToken(request);
  if (!token) return false;
  return timingSafeEqual(token, expectedToken);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

export function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

export function corsPreflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

export function unauthorized(message = "Unauthorized: missing or invalid bearer token.") {
  return json(
    { error: { message, type: "authentication_error", code: 401 } },
    401
  );
}

export function openAiError(message, status = 400, type = "invalid_request_error") {
  return json({ error: { message, type, code: status } }, status);
}

export async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Binary/base64 helpers (chunked to avoid call-stack overflow on large
// buffers - spreading a big Uint8Array into String.fromCharCode(...bytes)
// blows the stack past roughly 128KB; TTS audio and other binary payloads
// routinely exceed that, so everything here walks the buffer in chunks.)
// ---------------------------------------------------------------------------

const BASE64_CHUNK = 8192;

export function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Builds a 44-byte canonical WAV header for raw PCM data. Gemini's NATIVE
// TTS endpoint (unlike the OpenAI-compat shim) returns raw, headerless PCM
// (mimeType like "audio/L16;rate=24000" = 16-bit signed little-endian PCM,
// mono, at the given sample rate) - most players and Telegram need an
// actual container to know how to interpret those bytes, so we wrap them
// in the simplest possible one ourselves.
function buildWavHeader(dataLength, sampleRate, numChannels, bitsPerSample) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);
  return new Uint8Array(buffer);
}

// Takes base64-encoded raw PCM (as returned by Gemini's native
// generateContent TTS response) and returns base64-encoded, fully playable
// WAV audio.
export function pcmToWavBase64(base64Pcm, sampleRate = 24000, numChannels = 1, bitsPerSample = 16) {
  const pcmBytes = base64ToBytes(base64Pcm);
  const header = buildWavHeader(pcmBytes.length, sampleRate, numChannels, bitsPerSample);
  const wavBytes = new Uint8Array(header.length + pcmBytes.length);
  wavBytes.set(header, 0);
  wavBytes.set(pcmBytes, header.length);
  return bytesToBase64(wavBytes);
}