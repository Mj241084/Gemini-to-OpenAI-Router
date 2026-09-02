/**
 * Rigorous Unit Tests for RouterDO Caching & Sync Behavior
 * Uses node:sqlite to run real SQL commands against an in-memory SQLite database.
 */

import { DatabaseSync } from "node:sqlite";
import { RouterDO } from "../src/routerDO.js";
import { getMinuteWindow, getIranDayWindow } from "../src/util.js";

// Helper to extract rows from SQLite query result
function rowsOf(cursor) {
  return cursor.toArray ? cursor.toArray() : cursor;
}

// Mock the Cloudflare SQL execution interface
class MockSql {
  constructor(db) {
    this.db = db;
  }
  exec(sql, ...params) {
    const trimmed = sql.trim();
    // Check if we should execute using prepare() or exec()
    if (params.length > 0) {
      const stmt = this.db.prepare(sql);
      const rows = stmt.all(...params);
      return { toArray: () => rows };
    } else {
      const isSelect = trimmed.toUpperCase().startsWith("SELECT") || trimmed.toUpperCase().startsWith("WITH");
      if (isSelect) {
        const stmt = this.db.prepare(sql);
        const rows = stmt.all();
        return { toArray: () => rows };
      } else {
        try {
          const stmt = this.db.prepare(sql);
          const rows = stmt.all();
          return { toArray: () => rows };
        } catch (e) {
          this.db.exec(sql);
          return { toArray: () => [] };
        }
      }
    }
  }
}

async function runTests() {
  console.log("=== Starting RouterDO Caching & Sync Unit Tests ===");

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
  // Test Setup: Create DatabaseSync and Mock Context
  // ---------------------------------------------------------------------------
  const db = new DatabaseSync(":memory:");
  const sqlMock = new MockSql(db);
  let alarmTime = null;

  const mockCtx = {
    storage: {
      sql: sqlMock,
      getAlarm: async () => alarmTime,
      setAlarm: async (t) => { alarmTime = t; },
    },
    blockConcurrencyWhile: async (fn) => {
      await fn();
    }
  };

  const mockEnv = {};

  // Initialize RouterDO
  const router = new RouterDO(mockCtx, mockEnv);

  // ---------------------------------------------------------------------------
  // Test 1: Models & Keys Initial Load & CRUD In-Memory Caching (Sec 3.1)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 1: CRUD & In-Memory Caching ---");
    // Seed database via RouterDO's model CRUD
    await router.addModel({
      name: "gemini-3.5-flash",
      provider: "google",
      kind: "chat",
      order: 1,
      rpm: 5,
      rpd: 20
    });

    await router.addModel({
      name: "gemini-3.6-flash",
      provider: "google",
      kind: "chat",
      order: 2,
      rpm: 5,
      rpd: 20
    });

    await router.addKey({
      api_key: "key-abc-123",
      label: "mjj",
      provider: "google"
    });

    // Verify cache has been populated and synced
    assert(router.modelsCache.length === 2, "modelsCache populated with 2 models");
    assert(router.keysCache.length === 1, "keysCache populated with 1 key");
    assert(router.modelsCache[0].name === "gemini-3.5-flash", "Model 1 name matches in cache");
    assert(router.modelsCache[1].name === "gemini-3.6-flash", "Model 2 name matches in cache");
    assert(router.keysCache[0].label === "mjj", "Key label matches in cache");

    // Test listModels and listKeys read from cache
    const models = await router.listModels();
    const keys = await router.listKeys();
    assert(models.length === 2, "listModels returned cached models correctly");
    assert(keys.length === 1, "listKeys returned cached keys correctly");

    // Test model deletion cache invalidation
    await router.deleteModel("gemini-3.6-flash");
    assert(router.modelsCache.length === 1, "After deleteModel, cache decrements to 1");
    assert(router.modelsCache[0].name === "gemini-3.5-flash", "Remaining model is gemini-3.5-flash");
  } catch (err) {
    console.error("Test 1 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 2: Usage State Rollover Window Verification (Sec 3.2 & Sec 6)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 2: Usage State Rollover ---");
    const keyId = 1;
    const modelId = 1;
    const oldMinuteWindow = getMinuteWindow() - 10; // 10 minutes ago
    const oldDayWindow = "2025-01-01"; // Old calendar day

    // Get old state
    const state = router._getOrInitUsageState(keyId, modelId, oldMinuteWindow, oldDayWindow);
    state.minute_window = oldMinuteWindow;
    state.minute_count = 50;
    state.day_window = oldDayWindow;
    state.day_count = 100;

    // Report success on current window
    await router.reportSuccess({ keyId, modelId });

    // Validate that windows have rolled over and counters reset to 1
    const currentMinuteWindow = getMinuteWindow();
    const currentDayWindow = getIranDayWindow();

    assert(state.minute_window === currentMinuteWindow, "minute_window rolled over to current");
    assert(state.minute_count === 1, "minute_count reset to 1 on rollover");
    assert(state.day_window === currentDayWindow, "day_window rolled over to current");
    assert(state.day_count === 1, "day_count reset to 1 on rollover");
  } catch (err) {
    console.error("Test 2 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 3: Write Deferral & Periodic Flush (Sec 3.2 & Sec 6)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 3: Write Deferral & Flush ---");
    const keyId = 1;
    const modelId = 1;

    // Mutate usage state in-memory
    const state = router._getOrInitUsageState(keyId, modelId, getMinuteWindow(), getIranDayWindow());
    state.minute_count = 12;
    state.day_count = 45;

    // Verify SQL is still EMPTY/STALE for usage_state (no insert yet)
    let sqlRows = rowsOf(db.prepare("SELECT * FROM usage_state WHERE key_id = ?").all(keyId));
    assert(sqlRows.length === 0, "SQL usage_state table is still empty before flush");

    // Call periodic flush manually
    await router._periodicFlush();

    // Verify SQL database is now fully updated
    sqlRows = rowsOf(db.prepare("SELECT * FROM usage_state WHERE key_id = ?").all(keyId));
    assert(sqlRows.length === 1, "SQL usage_state row exists after flush");
    assert(sqlRows[0].minute_count === 12, "SQL minute_count matches flushed in-memory value");
    assert(sqlRows[0].day_count === 45, "SQL day_count matches flushed in-memory value");
  } catch (err) {
    console.error("Test 3 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 4: Crash & Evict Simulation (Sec 6)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 4: DO Eviction & Reload ---");
    // Change state in-memory and flush
    const keyId = 1;
    const modelId = 1;
    const state = router._getOrInitUsageState(keyId, modelId, getMinuteWindow(), getIranDayWindow());
    state.minute_count = 99;
    state.day_count = 999;
    await router._periodicFlush();

    // Re-instantiate RouterDO simulating cold start (evict/crash reload)
    const freshRouter = new RouterDO(mockCtx, mockEnv);

    // Verify that the constructor blockConcurrencyWhile reloads the state from database Sync
    const freshState = freshRouter.usageState.get(`${keyId}:${modelId}`);
    assert(freshState !== undefined, "Loaded state from db into memory on cold start");
    assert(freshState.minute_count === 99, "Reloaded minute_count matches");
    assert(freshState.day_count === 999, "Reloaded day_count matches");
  } catch (err) {
    console.error("Test 4 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 5: rawQuery Cache Invalidation (Sec 3.4 & Sec 6)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 5: rawQuery Cache Invalidation ---");
    // Run raw SQL update to disable a model directly
    await router.rawQuery({
      sql: "UPDATE models SET enabled = 0 WHERE name = ?",
      params: ["gemini-3.5-flash"]
    });

    // Verify cache has been invalidated and reloaded instantly
    const model = router.modelsCache.find((m) => m.name === "gemini-3.5-flash");
    assert(model.enabled === 0, "rawQuery instantly invalidated cache and model.enabled is 0");
    
    // Restore model
    await router.rawQuery({
      sql: "UPDATE models SET enabled = 1 WHERE name = ?",
      params: ["gemini-3.5-flash"]
    });
    assert(router.modelsCache.find((m) => m.name === "gemini-3.5-flash").enabled === 1, "Model re-enabled via rawQuery");
  } catch (err) {
    console.error("Test 5 failed:", err);
    failed++;
  }

  // ---------------------------------------------------------------------------
  // Test 6: Immediate Circuit Breaker (Sec 6)
  // ---------------------------------------------------------------------------
  try {
    console.log("\n--- Test 6: Immediate Circuit Breaker ---");
    const modelId = 1; // gemini-3.5-flash

    // Report failures up to threshold (3 consecutive)
    await router.reportFailure({ keyId: 1, modelId, httpStatus: 503, errorMessage: "Overloaded", scope: "model" });
    await router.reportFailure({ keyId: 1, modelId, httpStatus: 503, errorMessage: "Overloaded", scope: "model" });
    await router.reportFailure({ keyId: 1, modelId, httpStatus: 503, errorMessage: "Overloaded", scope: "model" });

    // Validate in-memory circuit breaker is active immediately
    const model = router.modelsCache.find((m) => m.id === modelId);
    assert(model.unavailable_until > Date.now(), "Model circuit breaker is active (unavailable_until > now)");

    // Call pickCandidate and verify it immediately returns null (skips model) even before any SQL flush
    const candidate = await router.pickCandidate({ requestedModel: "auto" });
    assert(candidate === null, "pickCandidate immediately skips the cooling-down model before periodic flush");
  } catch (err) {
    console.error("Test 6 failed:", err);
    failed++;
  }

  console.log("\n=== Unit Tests Summary ===");
  console.log(`Passed: ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.error(`❌ ${failed} test(s) failed.`);
    process.exit(1);
  } else {
    console.log("🚀 All caching and sync tests passed successfully!");
  }
}

runTests();
