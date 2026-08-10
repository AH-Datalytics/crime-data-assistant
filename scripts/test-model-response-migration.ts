/**
 * query_log.model_response must be additive, idempotent, and revertible.
 *
 * Same reasoning as test-chart-config-migration: this column sits on the hot
 * write path, and logNibrsQuery builds its column list at runtime, so if the
 * insert shape and the table ever disagree every log write fails silently
 * behind a caught exception. Both shapes are exercised here — with the column
 * and without — because deploy order between schema and code is not fixed.
 *
 * The column pairs with the two migrations that may or may not have run yet
 * (chart_config is not present in production at time of writing), so the
 * 16/17/18-value shapes are all live possibilities.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { boundedModelResponseJson } from "../lib/no-sql-retry";

const migration = require("./migrate-query-log-model-response.js");

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}
        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const BASE_COLUMNS =
  "ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, " +
  "routing_confidence, routing_mode, routing_reason, query_guidance, query_contract";
const BASE_VALUES = [1, "nibrs", "q", "SELECT 1", 1, null, 5, "r", null, "haiku-4.5", null, null, null, null, null, null];

console.log("\nmodel_response migration is additive, idempotent, and revertible");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modelresp-"));
  const dbPath = path.join(dir, "query_log.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
    error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
    routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT, query_contract TEXT)`);
  db.prepare("INSERT INTO query_log (ts, tab, question, rows) VALUES (1, 'nibrs', 'q', 1)").run();
  db.close();

  check("adds the column and preserves rows", () => {
    assert.strictEqual(migration.migrate({ dbPath, dryRun: false, rollback: false }).changed, true);
    const after = new Database(dbPath);
    const cols = after.prepare("PRAGMA table_info(query_log)").all().map((c: any) => c.name);
    const n = after.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number };
    after.close();
    assert.ok(cols.includes("model_response"));
    assert.strictEqual(n.n, 1, "existing rows must survive");
  });

  check("re-running is a no-op", () => {
    assert.strictEqual(migration.migrate({ dbPath, dryRun: false, rollback: false }).changed, false);
  });

  check("the 17-value insert shape matches the migrated table", () => {
    const after = new Database(dbPath);
    const columns = `${BASE_COLUMNS}, model_response`;
    const placeholders = new Array(17).fill("?").join(", ");
    assert.doesNotThrow(() => {
      after.prepare(`INSERT INTO query_log (${columns}) VALUES (${placeholders})`)
        .run(...BASE_VALUES, boundedModelResponseJson("I could not build that query.", null));
    });
    const stored = after.prepare("SELECT model_response FROM query_log WHERE model_response IS NOT NULL").get() as { model_response: string };
    after.close();
    assert.strictEqual(JSON.parse(stored.model_response).first, "I could not build that query.");
  });

  check("rollback drops the column and keeps rows", () => {
    assert.strictEqual(migration.migrate({ dbPath, dryRun: false, rollback: true }).changed, true);
    const after = new Database(dbPath);
    const cols = after.prepare("PRAGMA table_info(query_log)").all().map((c: any) => c.name);
    const n = after.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number };
    after.close();
    assert.ok(!cols.includes("model_response"), "column should be gone");
    assert.strictEqual(n.n, 2, "rows must survive rollback");
  });

  check("the pre-migration insert shape still works after rollback", () => {
    const after = new Database(dbPath);
    const placeholders = new Array(16).fill("?").join(", ");
    assert.doesNotThrow(() => {
      after.prepare(`INSERT INTO query_log (${BASE_COLUMNS}) VALUES (${placeholders})`).run(...BASE_VALUES);
    });
    after.close();
  });

  check("dry-run reports the change without making it", () => {
    assert.strictEqual(migration.migrate({ dbPath, dryRun: true, rollback: false }).changed, false);
    const after = new Database(dbPath);
    const cols = after.prepare("PRAGMA table_info(query_log)").all().map((c: any) => c.name);
    after.close();
    assert.ok(!cols.includes("model_response"), "dry-run must not alter the table");
  });
}

console.log(`
${process.exitCode ? "FAILURES present." : `All ${passed} model_response migration checks passed.`}`);
