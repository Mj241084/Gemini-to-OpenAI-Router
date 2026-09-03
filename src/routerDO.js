let DurableObjectBase;
try {
  const workers = await import("cloudflare:workers");
  DurableObjectBase = workers.DurableObject;
} catch (e) {
  DurableObjectBase = class {
    constructor(ctx, env) {
      this.ctx = ctx;
      this.env = env;
    }
  };
}

import { getMinuteWindow, getIranDayWindow, msUntilNextIranReset } from "./util.js";
import {
  MAX_LOG_ROWS,
  DEFAULT_THINKING_LEVELS,
  DEFAULT_PROVIDER,
  DEFAULT_KIND,
  MODEL_FAIL_THRESHOLD,
  MODEL_UNAVAILABLE_COOLDOWN_MS,
  USAGE_STATE_FLUSH_INTERVAL_MS,
  LOG_PRUNE_CHECK_INTERVAL,
} from "./config.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL DEFAULT 'google',
  kind TEXT NOT NULL DEFAULT 'chat',
  order_num INTEGER NOT NULL DEFAULT 100,
  order_fast INTEGER NOT NULL DEFAULT 100,
  order_stable INTEGER NOT NULL DEFAULT 100,
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
  `ALTER TABLE models ADD COLUMN order_fast INTEGER NOT NULL DEFAULT 100`,
  `ALTER TABLE models ADD COLUMN order_stable INTEGER NOT NULL DEFAULT 100`,
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

export class RouterDO extends DurableObjectBase {
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
      await this._reloadAllCaches();
      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm === null) {
        await this.ctx.storage.setAlarm(Date.now() + USAGE_STATE_FLUSH_INTERVAL_MS);
      }
    });
  }

  async _reloadAllCaches() {
    this.modelsCache = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM models`));
    this.keysCache = rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM api_keys`));
    this.usageState = new Map();
    for (const row of rowsOf(this.ctx.storage.sql.exec(`SELECT * FROM usage_state`))) {
      this.usageState.set(`${row.key_id}:${row.model_id}`, row);
    }
    const countRow = rowsOf(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM logs`))[0];
    this.logCount = countRow ? countRow.c : 0;
  }

  // -------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------

  _getOrInitUsageState(keyId, modelId, minuteWindow, dayWindow) {
    const cacheKey = `${keyId}:${modelId}`;
    let state = this.usageState.get(cacheKey);
    if (!state) {
      state = {
        key_id: keyId,
        model_id: modelId,
        minute_window: minuteWindow,
        minute_count: 0,
        day_window: dayWindow,
        day_count: 0,
        cooldown_until: 0,
        last_used_at: 0
      };
      this.usageState.set(cacheKey, state);
    }
    return state;
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
    this.logCount = (this.logCount || 0) + 1;
    if (this.logCount % LOG_PRUNE_CHECK_INTERVAL === 0) {
      const countRow = rowsOf(this.ctx.storage.sql.exec(`SELECT COUNT(*) as c FROM logs`))[0];
      if (countRow && countRow.c > MAX_LOG_ROWS) {
        const toDelete = countRow.c - MAX_LOG_ROWS;
        this.ctx.storage.sql.exec(
          `DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY id ASC LIMIT ?)`,
          toDelete
        );
      }
    }
  }

  _cachedModelById(id) {
    return this.modelsCache.find((m) => m.id === id);
  }

  _cachedKeyById(id) {
    return this.keysCache.find((k) => k.id === id);
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

  _upsertModelIntoCache(freshRow) {
    const idx = this.modelsCache.findIndex((m) => m.id === freshRow.id);
    if (idx === -1) this.modelsCache.push(freshRow);
    else this.modelsCache[idx] = freshRow;
  }

  _upsertKeyIntoCache(freshRow) {
    const idx = this.keysCache.findIndex((k) => k.id === freshRow.id);
    if (idx === -1) this.keysCache.push(freshRow);
    else this.keysCache[idx] = freshRow;
  }

  async listModels() {
    return [...this.modelsCache]
      .map((m) => ({ ...m, enabled: !!m.enabled, thinking_levels: JSON.parse(m.thinking_levels) }));
  }

  async addModel({
    name,
    provider = DEFAULT_PROVIDER,
    kind = DEFAULT_KIND,
    order = 100,
    order_fast = 100,
    order_stable = 100,
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
      `INSERT INTO models (name, provider, kind, order_num, order_fast, order_stable, rpm, rpd, thinking_levels, default_thinking, enabled, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(name) DO UPDATE SET
         provider=excluded.provider, kind=excluded.kind, order_num=excluded.order_num,
         order_fast=excluded.order_fast, order_stable=excluded.order_stable,
         rpm=excluded.rpm, rpd=excluded.rpd,
         thinking_levels=excluded.thinking_levels, default_thinking=excluded.default_thinking,
         enabled=excluded.enabled, updated_at=excluded.updated_at`,
      name,
      provider,
      kind,
      order,
      order_fast ?? order ?? 100,
      order_stable ?? order ?? 100,
      rpm,
      rpd,
      JSON.stringify(levels),
      default_thinking || levels[levels.length - 1] || null,
      enabled ? 1 : 0,
      now,
      now
    );
    const fresh = this._modelByName(name);
    this._upsertModelIntoCache(fresh);
    return fresh;
  }

  async updateModel(name, patch) {
    const existing = this._modelByName(name);
    if (!existing) throw new Error(`model "${name}" not found`);
    const merged = {
      provider: patch.provider ?? existing.provider,
      kind: patch.kind ?? existing.kind,
      order: patch.order ?? existing.order_num,
      order_fast: patch.order_fast ?? existing.order_fast ?? 100,
      order_stable: patch.order_stable ?? existing.order_stable ?? 100,
      rpm: patch.rpm ?? existing.rpm,
      rpd: patch.rpd ?? existing.rpd,
      thinking_levels: patch.thinking_levels ?? JSON.parse(existing.thinking_levels),
      default_thinking: patch.default_thinking ?? existing.default_thinking,
      enabled: patch.enabled ?? !!existing.enabled,
    };
    this.ctx.storage.sql.exec(
      `UPDATE models SET provider=?, kind=?, order_num=?, order_fast=?, order_stable=?, rpm=?, rpd=?, thinking_levels=?, default_thinking=?, enabled=?, updated_at=? WHERE name=?`,
      merged.provider,
      merged.kind,
      merged.order,
      merged.order_fast,
      merged.order_stable,
      merged.rpm,
      merged.rpd,
      JSON.stringify(merged.thinking_levels),
      merged.default_thinking,
      merged.enabled ? 1 : 0,
      Date.now(),
      name
    );
    const fresh = this._modelByName(name);
    this._upsertModelIntoCache(fresh);
    return fresh;
  }

  /**
   * Moves a model one slot up or down in priority by swapping its order column
   * (order_num, order_fast, or order_stable) with its immediate neighbor
   * in the currently sorted list for that mode and kind.
   */
  async swapModelOrder({ modelId, direction, mode = "auto" }) {
    const orderCol = mode === "fast" ? "order_fast" : mode === "stable" ? "order_stable" : "order_num";
    const targetModel = this.modelsCache.find((m) => m.id === modelId);
    if (!targetModel) throw new Error(`model id ${modelId} not found`);

    // Only sort and swap among models of the same kind (e.g. chat models)
    const targetKind = targetModel.kind || "chat";
    const models = this.modelsCache
      .filter((m) => (m.kind || "chat") === targetKind)
      .sort((a, b) => (a[orderCol] ?? 100) - (b[orderCol] ?? 100) || a.id - b.id);

    const idx = models.findIndex((m) => m.id === modelId);
    if (idx === -1) throw new Error(`model id ${modelId} not found`);
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= models.length) return { moved: false };
    const a = models[idx];
    const b = models[swapIdx];
    const now = Date.now();
    const valA = a[orderCol] ?? 100;
    const valB = b[orderCol] ?? 100;

    this.ctx.storage.sql.exec(`UPDATE models SET ${orderCol}=?, updated_at=? WHERE id=?`, valB, now, a.id);
    this.ctx.storage.sql.exec(`UPDATE models SET ${orderCol}=?, updated_at=? WHERE id=?`, valA, now, b.id);
    
    const freshA = this._modelById(a.id);
    const freshB = this._modelById(b.id);
    this._upsertModelIntoCache(freshA);
    this._upsertModelIntoCache(freshB);
    return { moved: true };
  }

  async deleteModel(name) {
    const existing = this._modelByName(name);
    if (!existing) return { deleted: false };
    this.ctx.storage.sql.exec(`DELETE FROM usage_state WHERE model_id = ?`, existing.id);
    this.ctx.storage.sql.exec(`DELETE FROM models WHERE id = ?`, existing.id);
    
    this.modelsCache = this.modelsCache.filter((m) => m.id !== existing.id);
    for (const k of this.usageState.keys()) {
      if (k.endsWith(`:${existing.id}`)) this.usageState.delete(k);
    }
    return { deleted: true };
  }

  // -------------------------------------------------------------------
  // API key management (called from /admin/keys)
  // -------------------------------------------------------------------

  async listKeys({ reveal = false } = {}) {
    return [...this.keysCache]
      .sort((a, b) => a.id - b.id)
      .map((k) => ({
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
    const fresh = rowsOf(
      this.ctx.storage.sql.exec(`SELECT * FROM api_keys WHERE api_key = ?`, api_key)
    )[0];
    this._upsertKeyIntoCache(fresh);
    return {
      id: fresh.id,
      label: fresh.label,
      provider: fresh.provider,
      enabled: fresh.enabled,
    };
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
    const fresh = this._keyById(id);
    this._upsertKeyIntoCache(fresh);
    return fresh;
  }

  async deleteKey(id) {
    this.ctx.storage.sql.exec(`DELETE FROM usage_state WHERE key_id = ?`, id);
    this.ctx.storage.sql.exec(`DELETE FROM api_keys WHERE id = ?`, id);
    
    this.keysCache = this.keysCache.filter((k) => k.id !== id);
    for (const k of this.usageState.keys()) {
      if (k.startsWith(`${id}:`)) this.usageState.delete(k);
    }
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

    const isModeRoute = requestedModel === "auto" || requestedModel === "fast" || requestedModel === "stable" || !requestedModel;
    const mode = isModeRoute ? (requestedModel || "auto") : "auto";

    const sortFn = (a, b) => {
      if (mode === "fast") return (a.order_fast ?? 100) - (b.order_fast ?? 100) || a.id - b.id;
      if (mode === "stable") return (a.order_stable ?? 100) - (b.order_stable ?? 100) || a.id - b.id;
      return (a.order_num ?? 100) - (b.order_num ?? 100) || a.id - b.id;
    };

    let models = this.modelsCache
      .filter((m) => m.enabled && m.kind === kind)
      .sort(sortFn);

    if (!isModeRoute) {
      const idx = models.findIndex((m) => m.name === requestedModel);
      if (idx > 0) {
        const [m] = models.splice(idx, 1);
        models.unshift(m);
      }
    }

    const keys = this.keysCache.filter((k) => k.enabled);

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
    state.minute_window = minuteWindow;
    state.minute_count = newMinuteCount;
    state.day_window = dayWindow;
    state.day_count = newDayCount;
    state.last_used_at = now;

    // A success means the model has recovered - clear the circuit breaker.
    const model = this.modelsCache.find((m) => m.id === modelId);
    if (model) {
      model.fail_streak = 0;
      model.unavailable_until = 0;
    }

    const key = this._cachedKeyById(keyId);
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
      const state = this._getOrInitUsageState(keyId, modelId, minuteWindow, dayWindow);
      const isDailyIssue = /day|daily|per[_ ]?day|resource_exhausted.*day/i.test(errorMessage || "");
      if (isDailyIssue) {
        state.day_window = dayWindow;
        state.day_count = 999999;
        state.cooldown_until = now + msUntilNextIranReset(now);
      } else {
        const nextMinuteStart = (minuteWindow + 1) * 60000;
        state.minute_window = minuteWindow;
        state.minute_count = 999999;
        state.cooldown_until = nextMinuteStart;
      }
    } else if (scope === "model" && modelId) {
      // Circuit breaker: count consecutive model-level failures (502/503/
      // 504/network error). After MODEL_FAIL_THRESHOLD in a row, take the
      // model out of rotation for MODEL_UNAVAILABLE_COOLDOWN_MS so future
      // requests skip it immediately instead of re-discovering the outage
      // via a fresh round trip every time.
      const model = this.modelsCache.find((m) => m.id === modelId);
      if (model) {
        const newStreak = (model.fail_streak || 0) + 1;
        if (newStreak >= MODEL_FAIL_THRESHOLD) {
          model.fail_streak = 0;
          model.unavailable_until = now + MODEL_UNAVAILABLE_COOLDOWN_MS;
        } else {
          model.fail_streak = newStreak;
        }
      }
    }
    const model = modelId ? this._cachedModelById(modelId) : null;
    const key = keyId ? this._cachedKeyById(keyId) : null;
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
    const models = [...this.modelsCache].sort((a, b) => a.order_num - b.order_num || a.id - b.id);
    const keys = [...this.keysCache].sort((a, b) => a.id - b.id);

    const result = models.map((model) => ({
      name: model.name,
      provider: model.provider || "google",
      kind: model.kind || "chat",
      order: model.order_num,
      order_fast: model.order_fast,
      order_stable: model.order_stable,
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
          const st = this.usageState.get(`${key.id}:${model.id}`);
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
    let result;
    try {
      result = { rows: rowsOf(cursor) };
    } catch {
      result = { ok: true, note: "Statement executed (no rows returned)." };
    }
    await this._reloadAllCaches();
    return result;
  }

  async _periodicFlush() {
    for (const state of this.usageState.values()) {
      this.ctx.storage.sql.exec(
        `INSERT INTO usage_state (key_id, model_id, minute_window, minute_count, day_window, day_count, cooldown_until, last_used_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(key_id, model_id) DO UPDATE SET
           minute_window=excluded.minute_window, minute_count=excluded.minute_count,
           day_window=excluded.day_window, day_count=excluded.day_count,
           cooldown_until=excluded.cooldown_until, last_used_at=excluded.last_used_at`,
        state.key_id, state.model_id, state.minute_window, state.minute_count,
        state.day_window, state.day_count, state.cooldown_until, state.last_used_at
      );
    }
    for (const model of this.modelsCache) {
      this.ctx.storage.sql.exec(
        `UPDATE models SET fail_streak=?, unavailable_until=? WHERE id=?`,
        model.fail_streak,
        model.unavailable_until,
        model.id
      );
    }
  }

  async alarm() {
    try {
      await this._periodicFlush();
    } catch (err) {
      this._insertLog({ status: "error", errorMessage: `periodic flush failed: ${err.message || err}` });
    }
    await this.ctx.storage.setAlarm(Date.now() + USAGE_STATE_FLUSH_INTERVAL_MS);
  }
}

function maskKey(key) {
  if (!key || key.length < 10) return "****";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
