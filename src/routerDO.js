import { DurableObject } from "cloudflare:workers";
import { getMinuteWindow, getIranDayWindow, msUntilNextIranReset } from "./util.js";
import {
  MAX_LOG_ROWS,
  DEFAULT_THINKING_LEVELS,
  DEFAULT_PROVIDER,
  DEFAULT_KIND,
  MODEL_FAIL_THRESHOLD,
  MODEL_UNAVAILABLE_COOLDOWN_MS,
} from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  kind TEXT NOT NULL DEFAULT 'chat',
  order_num INTEGER NOT NULL DEFAULT 100,
  rpm INTEGER NOT NULL,
  rpd INTEGER NOT NULL,
  thinking_levels TEXT NOT NULL DEFAULT '["minimal","low","medium","high"]',
  default_thinking TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  unavailable_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key TEXT UNIQUE NOT NULL,
  label TEXT,
  provider TEXT NOT NULL DEFAULT 'google',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_state (
  key_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  minute_window INTEGER NOT NULL DEFAULT 0,
  minute_count INTEGER NOT NULL DEFAULT 0,
  day_window TEXT NOT NULL DEFAULT '',
  day_count INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, model_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  model_name TEXT,
  key_label TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  total_tokens INTEGER,
  latency_ms INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts);
`;

// Columns added after the initial release. CREATE TABLE above already
// includes them for brand-new deployments; for a Durable Object that was
// already running before this update, CREATE TABLE IF NOT EXISTS is a
// no-op, so we ALTER TABLE the missing columns in here instead. Each
// statement is wrapped in try/catch because SQLite errors on adding a
// column that already exists - that's expected and fine on fresh installs.
const MIGRATIONS = [
  `ALTER TABLE models ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'`,
  `ALTER TABLE models ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`,
  `ALTER TABLE models ADD COLUMN fail_streak INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE models ADD COLUMN unavailable_until INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE api_keys ADD COLUMN provider TEXT NOT NULL DEFAULT 'google'`,
  `ALTER TABLE usage_state ADD COLUMN last_used_at INTEGER NOT NULL DEFAULT 0`,
];

function rowsOf(cursor) {
  // Storage SQL API returns a cursor; .toArray() materializes rows as
  // plain objects keyed by column name.
  return cursor.toArray();
}

export class RouterDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ctx.blockConcurrencyWhile(async () => {
      for (const stmt of SCHEMA.split(";")) {
        const trimmed = stmt.trim();
        if (trimmed) this.ctx.storage.sql.exec(trimmed);
      }
      for (const stmt of MIGRATIONS) {
        try {
          this.ctx.storage.sql.exec(stmt);
        } catch {
          // Column already exists (fresh install where CREATE TABLE already
          // had it) - expected and safe to ignore.
        }
      }
    });
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  _getOrInitUsageState(keyId, modelId, minuteWindow, dayWindow) {
    const rows = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM usage_state WHERE key_id = ? AND model_id = ?`,
        keyId,
        modelId
      )
    );
    if (rows.length) return rows[0];
    this.ctx.storage.sql.exec(
      `INSERT INTO usage_state (key_id, model_id, minute_window, minute_count, day_window, day_count, cooldown_until, last_used_at)
       VALUES (?, ?, ?, 0, ?, 0, 0, 0)`,
      keyId,
      modelId,
      minuteWindow,
      dayWindow
    );
    return {
      key_id: keyId,
      model_id: modelId,
      minute_window: minuteWindow,
      minute_count: 0,
      day_window: dayWindow,
      day_count: 0,
      cooldown_until: 0,
      last_used_at: 0,
    };
  }

  _insertLog(entry) {
    this.ctx.storage.sql.exec(
      `INSERT INTO logs (ts, model_name, key_label, status, http_status, prompt_tokens, completion_tokens, total_tokens, latency_ms, error_message)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      Date.now(),
      entry.modelName ?? null,
      entry.keyLabel ?? null,
      entry.status,
      entry.httpStatus ?? null,
      entry.promptTokens ?? null,
      entry.completionTokens ?? null,
      entry.totalTokens ?? null,
      entry.latencyMs ?? null,
      entry.errorMessage ? String(entry.errorMessage).slice(0, 800) : null
    );
    const countRow = rowsOf(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM logs`))[0];
    if (countRow && countRow.c > MAX_LOG_ROWS) {
      const toDelete = countRow.c - MAX_LOG_ROWS;
      this.ctx.storage.sql.exec(
        `DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)`,
        toDelete
      );
    }
  }

  _modelByName(name) {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM models WHERE name = ?`, name))[0];
  }

  _modelById(id) {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM models WHERE id = ?`, id))[0];
  }

  _keyById(id) {
    return rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM api_keys WHERE id = ?`, id))[0];
  }

  // -------------------------------------------------------------------
  // Model management (called from /admin/models)
  // -------------------------------------------------------------------

  async listModels() {
    return rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM models ORDER BY order_num ASC, id ASC`)
    ).map((m) => ({ ...m, enabled: !!m.enabled, thinking_levels: JSON.parse(m.thinking_levels) }));
  }

  async addModel({
    name,
    provider = DEFAULT_PROVIDER,
    kind = DEFAULT_KIND,
    order = 100,
    rpm,
    rpd,
    thinking_levels,
    default_thinking,
    enabled = true,
  }) {
    if (!name) throw new Error("name is required");
    if (!Number.isFinite(rpm) || !Number.isFinite(rpd)) {
      throw new Error("rpm and rpd are required numbers");
    }
    const levels = Array.isArray(thinking_levels) ? thinking_levels : DEFAULT_THINKING_LEVELS;
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO models (name, provider, kind, order_num, rpm, rpd, thinking_levels, default_thinking, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         provider=excluded.provider, kind=excluded.kind, order_num=excluded.order_num, rpm=excluded.rpm, rpd=excluded.rpd,
         thinking_levels=excluded.thinking_levels, default_thinking=excluded.default_thinking,
         enabled=excluded.enabled, updated_at=excluded.updated_at`,
      name,
      provider,
      kind,
      order,
      rpm,
      rpd,
      JSON.stringify(levels),
      default_thinking || levels[levels.length - 1] || null,
      enabled ? 1 : 0,
      now,
      now
    );
    return this._modelByName(name);
  }

  async updateModel(name, patch) {
    const existing = this._modelByName(name);
    if (!existing) throw new Error(`model "${name}" not found`);
    const merged = {
      provider: patch.provider ?? existing.provider,
      kind: patch.kind ?? existing.kind,
      order: patch.order ?? existing.order_num,
      rpm: patch.rpm ?? existing.rpm,
      rpd: patch.rpd ?? existing.rpd,
      thinking_levels: patch.thinking_levels ?? JSON.parse(existing.thinking_levels),
      default_thinking: patch.default_thinking ?? existing.default_thinking,
      enabled: patch.enabled ?? !!existing.enabled,
    };
    this.ctx.storage.sql.exec(
      `UPDATE models SET provider=?, kind=?, order_num=?, rpm=?, rpd=?, thinking_levels=?, default_thinking=?, enabled=?, updated_at=? WHERE name=?`,
      merged.provider,
      merged.kind,
      merged.order,
      merged.rpm,
      merged.rpd,
      JSON.stringify(merged.thinking_levels),
      merged.default_thinking,
      merged.enabled ? 1 : 0,
      Date.now(),
      name
    );
    return this._modelByName(name);
  }

  /**
   * Moves a model one slot up or down in priority by swapping its order_num
   * with its immediate neighbor in the currently sorted list. Used by the
   * Telegram bot's inline-button /priority view - this way "up"/"down"
   * always does something sensible regardless of what the raw order_num
   * values happen to be (they don't need to be contiguous integers).
   */
  async swapModelOrder({ modelId, direction }) {
    const models = rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM models ORDER BY order_num ASC, id ASC`)
    );
    const idx = models.findIndex((m) => m.id === modelId);
    if (idx === -1) throw new Error(`model id ${modelId} not found`);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= models.length) return { moved: false };
    const a = models[idx];
    const b = models[swapIdx];
    const now = Date.now();
    this.ctx.storage.sql.exec(`UPDATE models SET order_num=?, updated_at=? WHERE id=?`, b.order_num, now, a.id);
    this.ctx.storage.sql.exec(`UPDATE models SET order_num=?, updated_at=? WHERE id=?`, a.order_num, now, b.id);
    return { moved: true };
  }

  async deleteModel(name) {
    const existing = this._modelByName(name);
    if (!existing) return { deleted: false };
    this.ctx.storage.sql.exec(`DELETE FROM usage_state WHERE model_id = ?`, existing.id);
    this.ctx.storage.sql.exec(`DELETE FROM models WHERE id = ?`, existing.id);
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // API key management (called from /admin/keys)
  // -------------------------------------------------------------------

  async listKeys({ reveal = false } = {}) {
    const rows = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM api_keys ORDER BY id ASC`));
    return rows.map((k) => ({
      id: k.id,
      label: k.label,
      provider: k.provider,
      enabled: !!k.enabled,
      created_at: k.created_at,
      api_key: reveal ? k.api_key : maskKey(k.api_key),
    }));
  }

  async addKey({ api_key, label, provider = DEFAULT_PROVIDER, enabled = true }) {
    if (!api_key) throw new Error("api_key is required");
    this.ctx.storage.sql.exec(
      `INSERT INTO api_keys (api_key, label, provider, enabled, created_at) VALUES (?,?,?,?,?)
       ON CONFLICT(api_key) DO UPDATE SET label=excluded.label, provider=excluded.provider, enabled=excluded.enabled`,
      api_key,
      label || null,
      provider,
      enabled ? 1 : 0,
      Date.now()
    );
    return rowsOf(
      this.ctx.storage.sql.exec(`SELECT id, label, provider, enabled FROM api_keys WHERE api_key = ?`, api_key)
    )[0];
  }

  async addKeysBulk(keys) {
    const results = [];
    for (const k of keys) {
      results.push(await this.addKey(k));
    }
    return results;
  }

  async updateKey(id, patch) {
    const existing = this._keyById(id);
    if (!existing) throw new Error(`key id ${id} not found`);
    const label = patch.label ?? existing.label;
    const provider = patch.provider ?? existing.provider;
    const enabled = patch.enabled ?? !!existing.enabled;
    this.ctx.storage.sql.exec(
      `UPDATE api_keys SET label=?, provider=?, enabled=? WHERE id=?`,
      label,
      provider,
      enabled ? 1 : 0,
      id
    );
    return this._keyById(id);
  }

  async deleteKey(id) {
    this.ctx.storage.sql.exec(`DELETE FROM usage_state WHERE key_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE id = ?`, id);
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // Core routing logic
  // -------------------------------------------------------------------

  /**
   * Picks the best available (model, key) pair given current rate-limit
   * state, honoring model priority order and skipping anything already
   * excluded (tried-and-failed) in this request's retry loop.
   *
   * excludePairs entries are either:
   *   "model:<id>"        -> skip this model entirely (e.g. after a 503)
   *   "<keyId>:<modelId>" -> skip just this key for this model (e.g. after 429)
   */
  async pickCandidate({ requestedModel, excludePairs = [], kind = DEFAULT_KIND }) {
    const now = Date.now();
    const minuteWindow = getMinuteWindow(now);
    const dayWindow = getIranDayWindow(now);
    const excludeSet = new Set(excludePairs);

    let models = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT * FROM models WHERE enabled = 1 AND kind = ? ORDER BY order_num ASC, id ASC`,
        kind
      )
    );

    if (requestedModel && requestedModel !== "auto") {
      const idx = models.findIndex((m) => m.name === requestedModel);
      if (idx > 0) {
        const [m] = models.splice(idx, 1);
        models.unshift(m);
      }
    }

    const keys = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM api_keys WHERE enabled = 1 ORDER BY id ASC`));

    for (const model of models) {
      if (excludeSet.has(`model:${model.id}`)) continue;
      // Circuit breaker: a model that has failed MODEL_FAIL_THRESHOLD times
      // in a row (502/503/504/network error) is skipped entirely until its
      // cooldown expires, instead of paying a fresh round-trip on every
      // incoming request to rediscover that it's still down.
      if ((model.unavailable_until || 0) > now) continue;

      const candidates = [];
      for (const key of keys) {
        // Only consider keys that belong to this model's provider (e.g. a
        // Google AI Studio key is never tried against an OpenRouter model).
        if ((key.provider || "google") !== (model.provider || "google")) continue;
        if (excludeSet.has(`${key.id}:${model.id}`)) continue;
        const state = this._getOrInitUsageState(key.id, model.id, minuteWindow, dayWindow);
        if (state.cooldown_until > now) continue;
        const minuteCount = state.minute_window === minuteWindow ? state.minute_count : 0;
        const dayCount = state.day_window === dayWindow ? state.day_count : 0;
        if (minuteCount >= model.rpm) continue;
        if (dayCount >= model.rpd) continue;
        candidates.push({ key, minuteCount, dayCount, lastUsedAt: state.last_used_at || 0 });
      }
      if (candidates.length === 0) continue;

      // Smart pick: prefer the key with the most daily headroom, then the
      // most per-minute headroom, then the one that has sat idle the
      // longest (round-robin instead of always hammering the same key when
      // counts are tied), spreading load evenly across keys.
      candidates.sort(
        (a, b) =>
          a.dayCount - b.dayCount ||
          a.minuteCount - b.minuteCount ||
          a.lastUsedAt - b.lastUsedAt ||
          a.key.id - b.key.id
      );
      const chosen = candidates[0];
      const thinkingLevels = JSON.parse(model.thinking_levels || "[]");
      const defaultThinking =
        model.default_thinking || (thinkingLevels.length ? thinkingLevels[thinkingLevels.length - 1] : null);

      return {
        modelId: model.id,
        modelName: model.name,
        provider: model.provider || "google",
        kind: model.kind || "chat",
        rpm: model.rpm,
        rpd: model.rpd,
        thinkingLevels,
        defaultThinking,
        keyId: chosen.key.id,
        apiKey: chosen.key.api_key,
        keyLabel: chosen.key.label,
      };
    }

    return null;
  }

  async reportSuccess({ keyId, modelId, promptTokens, completionTokens, totalTokens, latencyMs }) {
    const now = Date.now();
    const minuteWindow = getMinuteWindow(now);
    const dayWindow = getIranDayWindow(now);
    const state = this._getOrInitUsageState(keyId, modelId, minuteWindow, dayWindow);
    const newMinuteCount = (state.minute_window === minuteWindow ? state.minute_count : 0) + 1;
    const newDayCount = (state.day_window === dayWindow ? state.day_count : 0) + 1;
    this.ctx.storage.sql.exec(
      `UPDATE usage_state SET minute_window=?, minute_count=?, day_window=?, day_count=?, last_used_at=? WHERE key_id=? AND model_id=?`,
      minuteWindow,
      newMinuteCount,
      dayWindow,
      newDayCount,
      now,
      keyId,
      modelId
    );
    // A success means the model has recovered - clear the circuit breaker.
    this.ctx.storage.sql.exec(`UPDATE models SET fail_streak=0, unavailable_until=0 WHERE id=?`, modelId);
    const model = this._modelById(modelId);
    const key = this._keyById(keyId);
    this._insertLog({
      modelName: model?.name,
      keyLabel: key?.label,
      status: "success",
      httpStatus: 200,
      promptTokens,
      completionTokens,
      totalTokens,
      latencyMs,
    });
    return { ok: true };
  }

  /**
   * scope:
   *   "key"   -> this specific key looks exhausted/invalid for this model
   *              (429, 401, 403). We cool it down but do NOT touch other
   *              keys or other models.
   *   "model" -> the model itself looks unavailable (503/502/504/network
   *              error). We don't blame the key; the caller will simply
   *              exclude this whole model on the next attempt.
   *   "none"  -> just log it (e.g. a 400 we are not going to retry).
   */
  async reportFailure({ keyId, modelId, httpStatus, errorMessage, scope }) {
    const now = Date.now();
    if (scope === "key") {
      const minuteWindow = getMinuteWindow(now);
      const dayWindow = getIranDayWindow(now);
      this._getOrInitUsageState(keyId, modelId, minuteWindow, dayWindow);
      const isDailyIssue = /day|daily|per[_ ]?day|resource_exhausted.*day/i.test(errorMessage || "");
      if (isDailyIssue) {
        this.ctx.storage.sql.exec(
          `UPDATE usage_state SET day_window=?, day_count=999999, cooldown_until=? WHERE key_id=? AND model_id=?`,
          dayWindow,
          now + msUntilNextIranReset(now),
          keyId,
          modelId
        );
      } else {
        const nextMinuteStart = (minuteWindow + 1) * 60000;
        this.ctx.storage.sql.exec(
          `UPDATE usage_state SET minute_window=?, minute_count=999999, cooldown_until=? WHERE key_id=? AND model_id=?`,
          minuteWindow,
          nextMinuteStart,
          keyId,
          modelId
        );
      }
    } else if (scope === "model" && modelId) {
      // Circuit breaker: count consecutive model-level failures (502/503/
      // 504/network error). After MODEL_FAIL_THRESHOLD in a row, take the
      // model out of rotation for MODEL_UNAVAILABLE_COOLDOWN_MS so future
      // requests skip it immediately instead of re-discovering the outage
      // via a fresh round trip every time.
      const model = this._modelById(modelId);
      const newStreak = (model?.fail_streak || 0) + 1;
      if (newStreak >= MODEL_FAIL_THRESHOLD) {
        this.ctx.storage.sql.exec(
          `UPDATE models SET fail_streak=0, unavailable_until=? WHERE id=?`,
          now + MODEL_UNAVAILABLE_COOLDOWN_MS,
          modelId
        );
      } else {
        this.ctx.storage.sql.exec(`UPDATE models SET fail_streak=? WHERE id=?`, newStreak, modelId);
      }
    }
    const model = modelId ? this._modelById(modelId) : null;
    const key = keyId ? this._keyById(keyId) : null;
    this._insertLog({
      modelName: model?.name,
      keyLabel: key?.label,
      status: "error",
      httpStatus,
      errorMessage,
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------

  async getStatus() {
    const now = Date.now();
    const minuteWindow = getMinuteWindow(now);
    const dayWindow = getIranDayWindow(now);
    const models = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM models ORDER BY order_num ASC, id ASC`));
    const keys = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM api_keys ORDER BY id ASC`));
    const states = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM usage_state`));
    const stateMap = new Map(states.map((s) => [`${s.key_id}:${s.model_id}`, s]));

    const result = models.map((model) => ({
      name: model.name,
      provider: model.provider || "google",
      kind: model.kind || "chat",
      order: model.order_num,
      enabled: !!model.enabled,
      rpm: model.rpm,
      rpd: model.rpd,
      thinking_levels: JSON.parse(model.thinking_levels || "[]"),
      default_thinking: model.default_thinking,
      circuit_breaker: {
        fail_streak: model.fail_streak || 0,
        unavailable: (model.unavailable_until || 0) > now,
        unavailable_remaining_sec:
          (model.unavailable_until || 0) > now ? Math.ceil((model.unavailable_until - now) / 1000) : 0,
      },
      keys: keys
        .filter((key) => (key.provider || "google") === (model.provider || "google"))
        .map((key) => {
          const st = stateMap.get(`${key.id}:${model.id}`);
          const minuteCount = st && st.minute_window === minuteWindow ? Math.min(st.minute_count, model.rpm) : 0;
          const dayCount = st && st.day_window === dayWindow ? Math.min(st.day_count, model.rpd) : 0;
          const cooldownUntil = st ? st.cooldown_until : 0;
          return {
            id: key.id,
            label: key.label,
            enabled: !!key.enabled,
            minute_used: minuteCount,
            minute_limit: model.rpm,
            day_used: dayCount,
            day_limit: model.rpd,
            cooling_down: cooldownUntil > now,
            cooldown_remaining_sec: cooldownUntil > now ? Math.ceil((cooldownUntil - now) / 1000) : 0,
          };
        }),
    }));

    return {
      server_time: new Date(now).toISOString(),
      day_window: dayWindow,
      next_daily_reset_in_sec: Math.ceil(msUntilNextIranReset(now) / 1000),
      models: result,
    };
  }

  async getLogs({ limit = 50, status = null } = {}) {
    const lim = Math.max(1, Math.min(500, limit | 0));
    const rows = status
      ? rowsOf(
          this.ctx.storage.sql.exec(
            `SELECT * FROM logs WHERE status = ? ORDER BY id DESC LIMIT ?`,
            status,
            lim
          )
        )
      : rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM logs ORDER BY id DESC LIMIT ?`, lim));
    return rows;
  }

  async getStats({ sinceMs = 24 * 3600 * 1000 } = {}) {
    const since = Date.now() - sinceMs;
    const totals = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT
           COUNT(*) as requests,
           SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
           SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
           SUM(COALESCE(prompt_tokens,0)) as prompt_tokens,
           SUM(COALESCE(completion_tokens,0)) as completion_tokens,
           SUM(COALESCE(total_tokens,0)) as total_tokens,
           AVG(latency_ms) as avg_latency_ms
         FROM logs WHERE ts >= ?`,
        since
      )
    )[0];
    const byModel = rowsOf(
      this.ctx.storage.sql.exec(
        `SELECT model_name,
                COUNT(*) as requests,
                SUM(CASE WHEN status='success' THEN 1 ELSE 0 END) as successes,
                SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors,
                SUM(COALESCE(total_tokens,0)) as total_tokens
         FROM logs WHERE ts >= ? GROUP BY model_name`,
        since
      )
    );
    return { since: new Date(since).toISOString(), totals, by_model: byModel };
  }

  // -------------------------------------------------------------------
  // Power-user raw SQL passthrough (see README "دسترسی مستقیم SQL")
  // -------------------------------------------------------------------

  async rawQuery({ sql, params = [] }) {
    if (!sql || typeof sql !== "string") throw new Error("sql (string) is required");
    const cursor = this.ctx.storage.sql.exec(sql, ...params);
    try {
      return { rows: rowsOf(cursor) };
    } catch {
      return { ok: true, note: "Statement executed (no rows returned)." };
    }
  }
}

function maskKey(key) {
  if (!key || key.length < 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
