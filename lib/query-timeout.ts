import type Database from "better-sqlite3";
import { execFileSync } from "child_process";
import path from "path";
import fs from "fs";

/**
 * Resolve path to the standalone query worker script.
 * The worker uses require("better-sqlite3") directly,
 * avoiding the bundler mangling require.resolve().
 */
function resolveWorkerPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "lib", "query-worker.js"),
    path.join(__dirname, "query-worker.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Execute a SQL statement with a real timeout.
 *
 * Spawns a standalone worker script via execFileSync + timeout.
 * The worker opens its own DB connection, runs the query, and
 * writes JSON to stdout. If the timeout is exceeded, Node kills
 * the child, terminating the SQLite query immediately.
 *
 * Falls back to direct execution if the worker script is not found.
 */
export function executeWithTimeoutSync<T>(
  db: Database.Database,
  stmt: Database.Statement,
  timeoutMs: number = 30000
): T[] {
  const dbPath = (db as unknown as { name: string }).name;
  const sql = stmt.source;
  const workerPath = resolveWorkerPath();

  // Fallback: no worker script, run synchronously (no timeout protection)
  if (!workerPath || !dbPath) {
    return stmt.all() as T[];
  }

  try {
    const stdout = execFileSync(process.execPath, [workerPath, dbPath, sql], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = JSON.parse(stdout.toString());
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    return parsed.rows as T[];
  } catch (err: unknown) {
    if (err instanceof Error && "killed" in err && (err as unknown as { killed: boolean }).killed) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT") || msg.includes("SIGTERM")) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw err;
  }
}
