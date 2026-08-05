/**
 * Phase 3 migration safety: query_log.chart_config must be additive, idempotent,
 * and revertible.
 *
 * Kept separate from the auditor's provenance migration because this one touches
 * the hot write path -- every answered query logs a row -- so it must be
 * revertible on its own. The insert-shape checks matter because logQuery builds
 * its column list at runtime: if the shape and the table ever disagree, every log
 * write fails silently behind a caught exception.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { serializeChartConfigForLog, parseChartConfigLog } from "../lib/chart-config-log";
import type { ChartConfig } from "../lib/types";

const migration = require("./migrate-query-log-chart-config.js");

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

const baseConfig: ChartConfig = {
  type: "line",
  xAxis: "year",
  yAxis: ["murder", "robbery"],
  title: "Murders and robberies in Houston, 2010-2025",
};

console.log("\n5. Migration is additive, idempotent, and revertible");
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chartcfg-"));
  const dbPath = path.join(dir, "query_log.db");
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT, rows INTEGER,
    error TEXT, ms INTEGER, response TEXT, guardrails TEXT, model TEXT, session_id TEXT,
    routing_confidence TEXT, routing_mode TEXT, routing_reason TEXT, query_guidance TEXT, query_contract TEXT)`);
  db.prepare("INSERT INTO query_log (ts, tab, question, rows) VALUES (1, 'current', 'q', 1)").run();
  db.close();

  check("adds the column and preserves rows", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: false });
    assert.strictEqual(result.changed, true);
    const after = new Database(dbPath);
    const cols = after.prepare("PRAGMA table_info(query_log)").all().map((c: any) => c.name);
    const n = after.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number };
    after.close();
    assert.ok(cols.includes("chart_config"));
    assert.strictEqual(n.n, 1, "existing rows must survive");
  });

  check("re-running is a no-op", () => {
    assert.strictEqual(migration.migrate({ dbPath, dryRun: false, rollback: false }).changed, false);
  });

  check("the 17-value insert shape matches the migrated table", () => {
    const after = new Database(dbPath);
    const columns = "ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, routing_confidence, routing_mode, routing_reason, query_guidance, query_contract, chart_config";
    const placeholders = new Array(17).fill("?").join(", ");
    assert.doesNotThrow(() => {
      after.prepare(`INSERT INTO query_log (${columns}) VALUES (${placeholders})`)
        .run(1, "current", "q", "SELECT 1", 1, null, 5, "r", null, "haiku-4.5", null, null, null, null, null, null, serializeChartConfigForLog(baseConfig, ["year", "murder"]));
    });
    const stored = after.prepare("SELECT chart_config FROM query_log WHERE chart_config IS NOT NULL").get() as { chart_config: string };
    after.close();
    assert.ok(parseChartConfigLog(stored.chart_config)!.title.length > 0);
  });

  check("rollback drops the column and keeps rows", () => {
    const result = migration.migrate({ dbPath, dryRun: false, rollback: true });
    assert.strictEqual(result.changed, true);
    const after = new Database(dbPath);
    const cols = after.prepare("PRAGMA table_info(query_log)").all().map((c: any) => c.name);
    const n = after.prepare("SELECT COUNT(*) AS n FROM query_log").get() as { n: number };
    after.close();
    assert.ok(!cols.includes("chart_config"), "column should be gone");
    assert.strictEqual(n.n, 2, "rows must survive rollback");
  });

  check("the pre-migration insert shape still works after rollback", () => {
    const after = new Database(dbPath);
    const columns = "ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, routing_confidence, routing_mode, routing_reason, query_guidance, query_contract";
    const placeholders = new Array(16).fill("?").join(", ");
    assert.doesNotThrow(() => {
      after.prepare(`INSERT INTO query_log (${columns}) VALUES (${placeholders})`)
        .run(1, "current", "q", "SELECT 1", 1, null, 5, "r", null, "haiku-4.5", null, null, null, null, null, null);
    });
    after.close();
  });
}

console.log(`
${process.exitCode ? "FAILURES present." : `All ${passed} chart-log migration checks passed.`}`);
