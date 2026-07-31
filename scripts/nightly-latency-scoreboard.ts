import Database from "better-sqlite3";
import path from "node:path";
import { isProductionTraffic, latencyFamily, latencyStats, type LatencyRow } from "../lib/latency-scoreboard";

function numberArg(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

const hours = numberArg("--hours", 24);
const thresholdMs = numberArg("--threshold-ms", 10_000);
const failOnSlow = process.argv.includes("--fail-on-slow");
const dbPath = path.resolve(process.env.QUERY_LOG_DB_PATH || path.join(process.cwd(), "query_log.db"));
const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

db.exec(`
  CREATE TABLE IF NOT EXISTS latency_scoreboard_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL,
    window_end INTEGER NOT NULL,
    threshold_ms INTEGER NOT NULL,
    total INTEGER NOT NULL,
    slow INTEGER NOT NULL,
    slow_rate REAL NOT NULL,
    p50 INTEGER NOT NULL,
    p95 INTEGER NOT NULL,
    max_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS latency_scoreboard_families (
    run_id INTEGER NOT NULL,
    family TEXT NOT NULL,
    tab TEXT NOT NULL,
    total INTEGER NOT NULL,
    slow INTEGER NOT NULL,
    p50 INTEGER NOT NULL,
    p95 INTEGER NOT NULL,
    max_ms INTEGER NOT NULL,
    PRIMARY KEY (run_id, family, tab)
  );
`);

const windowEnd = Date.now();
const windowStart = windowEnd - hours * 60 * 60 * 1000;
const rows = (db.prepare(`
  SELECT tab, question, ms, session_id
  FROM query_log
  WHERE ts >= ? AND ts < ? AND ms IS NOT NULL
`).all(windowStart, windowEnd) as LatencyRow[]).filter(isProductionTraffic);
const overall = latencyStats(rows, thresholdMs);

const groups = new Map<string, LatencyRow[]>();
for (const row of rows) {
  const family = latencyFamily(row.question);
  const tab = row.tab || "unknown";
  const key = `${tab}\u0000${family}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}

const save = db.transaction(() => {
  const result = db.prepare(`
    INSERT INTO latency_scoreboard_runs
      (created_at, window_start, window_end, threshold_ms, total, slow, slow_rate, p50, p95, max_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(windowEnd, windowStart, windowEnd, thresholdMs, overall.total, overall.slow, overall.slowRate, overall.p50, overall.p95, overall.max);
  const runId = Number(result.lastInsertRowid);
  const insertFamily = db.prepare(`
    INSERT INTO latency_scoreboard_families
      (run_id, family, tab, total, slow, p50, p95, max_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [key, familyRows] of groups) {
    const [tab, family] = key.split("\u0000");
    const stats = latencyStats(familyRows, thresholdMs);
    insertFamily.run(runId, family, tab, stats.total, stats.slow, stats.p50, stats.p95, stats.max);
  }
  return runId;
});
const runId = save();

console.log(`Latency scoreboard #${runId}: ${overall.total} production queries over ${hours}h; ${overall.slow} >= ${thresholdMs}ms (${(overall.slowRate * 100).toFixed(1)}%); p50=${overall.p50}ms p95=${overall.p95}ms max=${overall.max}ms`);
const ranked = [...groups.entries()]
  .map(([key, familyRows]) => ({ key, stats: latencyStats(familyRows, thresholdMs) }))
  .filter(({ stats }) => stats.slow > 0)
  .sort((a, b) => b.stats.slow - a.stats.slow || b.stats.p95 - a.stats.p95);
for (const { key, stats } of ranked) {
  const [tab, family] = key.split("\u0000");
  console.log(`  ${tab}/${family}: ${stats.slow}/${stats.total} slow; p95=${stats.p95}ms max=${stats.max}ms`);
}
db.close();
if (failOnSlow && overall.slow > 0) process.exitCode = 2;
