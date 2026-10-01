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
  timeoutMs: number = 30000,
  /**
   * Test seam, unused in production and behaviour-neutral. Present only so the pre-existing
   * single-statement fallback can be shown to be PRESERVED, rather than asserted to be.
   */
  seam?: { resolveWorkerPath?: () => string | null },
): T[] {
  return runInWorker<T>(
    db, [stmt.source], timeoutMs, () => [stmt.all() as T[]],
    seam?.resolveWorkerPath ?? resolveWorkerPath,
  )[0];
}

/** Thrown before any SQL runs when the paired read cannot be executed under a time bound. */
export const BOUNDED_EXECUTION_UNAVAILABLE =
  "Bounded query execution is unavailable, so the paired read was not executed";

/**
 * Execute several statements with a real timeout, ALL ON ONE SNAPSHOT.
 *
 * Why this exists: `executeWithTimeoutSync` spawns one worker process per call, and each worker
 * opens and closes its own read-only connection. Two such calls therefore read the database at two
 * different moments, so a total returned by the first can describe different contributing rows from
 * the evidence returned by the second — and wrapping the caller's own handle in a transaction
 * governs neither child. Statements passed here run inside a single read transaction on a single
 * connection, which is the guarantee a paired totals-and-coverage read needs.
 *
 * NO UNBOUNDED FALLBACK, DELIBERATELY. An earlier version fell back to synchronous `.all()` calls
 * inside a transaction when the worker was unavailable, and a comment here claimed that was "the
 * same guarantee". It was not: a transaction establishes a snapshot, it does not establish bounded
 * execution, so the fallback traded a timeout away to keep the snapshot — the exact swap the R1
 * ruling prohibited. This helper now FAILS BEFORE EITHER STATEMENT RUNS instead, and the caller
 * reports its own internal failure. The single-statement helper above keeps its pre-existing
 * fallback; that behaviour is outside this correction.
 *
 * Returns one row array per statement, in the order given.
 */
export function executeManyWithTimeoutSync<T>(
  db: Database.Database,
  sqlStatements: string[],
  timeoutMs: number = 30000,
  /**
   * Test seam, unused in production. It exists so the worker-unavailable path can be proved without
   * renaming or deleting the shared worker script, which would disturb every other caller.
   */
  seam?: { resolveWorkerPath?: () => string | null },
): T[][] {
  if (sqlStatements.length === 0) return [];

  // Checked up front, so nothing has executed by the time this refuses.
  const resolve = seam?.resolveWorkerPath ?? resolveWorkerPath;
  const dbPath = (db as unknown as { name: string }).name;
  if (!resolve() || !dbPath) throw new Error(BOUNDED_EXECUTION_UNAVAILABLE);

  return runInWorker<T>(db, sqlStatements, timeoutMs, () => {
    // Unreachable given the guard above, and kept so a later refactor of `runInWorker` cannot
    // quietly reintroduce an unbounded path here.
    throw new Error(BOUNDED_EXECUTION_UNAVAILABLE);
  }, resolve);
}

/** The shared worker invocation: one child, one connection, one snapshot, N statements. */
function runInWorker<T>(
  db: Database.Database,
  sqlStatements: string[],
  timeoutMs: number,
  fallback: () => T[][],
  resolve: () => string | null = resolveWorkerPath,
): T[][] {
  const dbPath = (db as unknown as { name: string }).name;
  const workerPath = resolve();

  // Fallback: no worker script, run synchronously (no timeout protection)
  if (!workerPath || !dbPath) {
    return fallback();
  }

  try {
    const stdout = execFileSync(process.execPath, [workerPath, dbPath, ...sqlStatements], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const parsed = JSON.parse(stdout.toString());
    if (parsed.error) {
      throw new Error(parsed.error);
    }
    // One statement keeps the original `{ rows, columns }` shape; several return `{ results }`.
    if (Array.isArray(parsed.results)) {
      return (parsed.results as { rows: T[] }[]).map((result) => result.rows);
    }
    return [parsed.rows as T[]];
  } catch (err: unknown) {
    if (err instanceof Error && "killed" in err && (err as unknown as { killed: boolean }).killed) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("TIMEOUT") || msg.includes("SIGTERM")) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    /*
     * The worker reports a SQL failure as JSON on stdout and exits non-zero, so `execFileSync`
     * throws its own generic "Command failed" and the real reason is in the captured stdout. Surface
     * it: a caller logging an internal failure can do nothing with "Command failed".
     */
    const stdout = (err as { stdout?: Buffer | string } | null)?.stdout;
    if (stdout) {
      try {
        const reported = JSON.parse(stdout.toString());
        if (reported?.error) throw new Error(String(reported.error));
      } catch (parseErr) {
        if (parseErr instanceof Error && parseErr.message && !/JSON/i.test(parseErr.message)) throw parseErr;
      }
    }
    throw err;
  }
}
