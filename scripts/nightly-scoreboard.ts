#!/usr/bin/env npx tsx
/**
 * Accuracy scoreboard — runs a fixed live-replay suite against the app,
 * computes a single smoke-test number, and persists the run to
 * query_log.db (scoreboard_runs) so the daily email can report the score and
 * its day-over-day delta.
 *
 * Usage:
 *   npx tsx scripts/nightly-scoreboard.ts --quick                  # localhost, 18-case smoke run
 *   npx tsx scripts/nightly-scoreboard.ts                          # localhost, full suite (manual/major changes)
 *   npx tsx scripts/nightly-scoreboard.ts --host https://nibrsai.com
 *   npx tsx scripts/nightly-scoreboard.ts --skip-run               # score latest existing audit JSON
 *
 * Manual only: do not schedule the fixed replay suite daily. Repeated passing
 * canaries add cost and swamp the real-user signal in the answer review.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

function resolveQueryLogPath(): string {
  if (process.env.QUERY_LOG_DB_PATH) return process.env.QUERY_LOG_DB_PATH;
  return resolve(process.cwd(), "query_log.db");
}

interface ReplayRun {
  timestamp: string;
  host: string;
  mode: string;
  total: number;
  passed: number;
  failed: number;
  inconclusive: number;
  flaky?: number;
  errors: number;
  results: { id: string; status: string; category: string; failures: string[]; flaky?: boolean }[];
}

function latestReplayJson(): string | null {
  const dir = resolve(process.cwd(), "audit");
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith("live-replay-") && f.endsWith(".json"))
    .sort();
  return files.length ? join(dir, files[files.length - 1]) : null;
}

function main() {
  const args = process.argv.slice(2);
  const hostIdx = args.indexOf("--host");
  const host = hostIdx >= 0 ? args[hostIdx + 1] : "http://localhost:3000";
  const quick = args.includes("--quick");
  const skipRun = args.includes("--skip-run");

  if (!skipRun) {
    const replayArgs = ["tsx", "scripts/live-replay.ts", quick ? "--quick" : "--full", "--host", host];
    console.log(`[scoreboard] Running: npx ${replayArgs.join(" ")}`);
    const proc = spawnSync("npx", replayArgs, { stdio: "inherit", shell: process.platform === "win32" });
    if (proc.status !== 0) {
      console.error(`[scoreboard] live-replay exited with code ${proc.status}; scoring latest JSON anyway`);
    }
  }

  const jsonPath = latestReplayJson();
  if (!jsonPath) {
    console.error("[scoreboard] No live-replay JSON found in audit/ — nothing to score");
    process.exit(1);
  }
  const run: ReplayRun = JSON.parse(readFileSync(jsonPath, "utf-8"));

  // Inconclusive runs (CAPTCHA / rate limit / infra) are excluded from the
  // denominator so infrastructure noise doesn't read as accuracy change.
  const scored = run.passed + run.failed;
  const accuracy = scored > 0 ? run.passed / scored : 0;
  const failedIds = run.results.filter((r) => r.status === "fail").map((r) => r.id);
  const inconclusiveIds = run.results.filter((r) => r.status === "inconclusive").map((r) => r.id);
  const flakyIds = run.results.filter((r) => r.flaky).map((r) => r.id);

  const dbPath = resolveQueryLogPath();
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS scoreboard_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_ts TEXT NOT NULL,
      host TEXT,
      mode TEXT,
      total INTEGER,
      passed INTEGER,
      failed INTEGER,
      inconclusive INTEGER,
      accuracy REAL,
      failed_ids TEXT,
      inconclusive_ids TEXT,
      json_path TEXT
    )
  `);
  // flaky_ids added 2026-07-05 (retry-once); ALTER is a no-op error on fresh tables
  try { db.exec("ALTER TABLE scoreboard_runs ADD COLUMN flaky_ids TEXT"); } catch { /* column exists */ }
  const prev = db
    .prepare("SELECT * FROM scoreboard_runs ORDER BY id DESC LIMIT 1")
    .get() as { accuracy: number; passed: number; failed: number; run_ts: string } | undefined;

  db.prepare(
    `INSERT INTO scoreboard_runs
     (run_ts, host, mode, total, passed, failed, inconclusive, accuracy, failed_ids, inconclusive_ids, flaky_ids, json_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    run.timestamp,
    run.host,
    run.mode,
    run.total,
    run.passed,
    run.failed,
    run.inconclusive,
    accuracy,
    JSON.stringify(failedIds),
    JSON.stringify(inconclusiveIds),
    JSON.stringify(flakyIds),
    jsonPath,
  );
  db.close();

  const pctStr = `${(100 * accuracy).toFixed(1)}%`;
  console.log(`\n[scoreboard] ${run.passed}/${scored} passed (${pctStr}), ${run.inconclusive} inconclusive${flakyIds.length ? `, ${flakyIds.length} flaky` : ""}`);
  if (prev) {
    const delta = 100 * (accuracy - prev.accuracy);
    console.log(
      `[scoreboard] Delta vs previous run (${prev.run_ts}): ${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts`,
    );
  }
  if (failedIds.length) console.log(`[scoreboard] Failed: ${failedIds.join(", ")}`);
  if (flakyIds.length) console.log(`[scoreboard] Flaky (passed on retry): ${flakyIds.join(", ")}`);
  if (inconclusiveIds.length) console.log(`[scoreboard] Inconclusive: ${inconclusiveIds.join(", ")}`);
  console.log(`[scoreboard] Persisted to ${dbPath}`);
}

main();
