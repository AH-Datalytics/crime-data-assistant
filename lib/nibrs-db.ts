import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.NIBRS_DB_PATH || "/opt/nibrs/nibrs.db";

let _db: Database.Database | null = null;

export function getNibrsDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
  }
  return _db;
}

const QUERY_TIMEOUT_MS = 30_000;
const WORKER_SCRIPT = path.join(process.cwd(), "lib", "nibrs-query-worker.js");

/**
 * Execute a SQL query in a child process with a hard timeout.
 * If the query exceeds QUERY_TIMEOUT_MS, the child is killed
 * and an error is thrown — without blocking the main event loop.
 */
export function executeWithTimeout(
  sql: string,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  return new Promise((resolve, reject) => {
    // Fall back to sync if worker script missing
    if (!fs.existsSync(WORKER_SCRIPT)) {
      console.warn("[nibrs] Worker script not found, falling back to sync execution");
      try {
        const db = getNibrsDb();
        const stmt = db.prepare(sql);
        const rows = stmt.all() as Record<string, unknown>[];
        const columns = stmt.columns().map((c) => c.name);
        resolve({ rows, columns });
      } catch (e) {
        reject(e);
      }
      return;
    }

    execFile(
      process.execPath,
      [WORKER_SCRIPT, DB_PATH, sql],
      { timeout: timeoutMs, maxBuffer: 50 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ("killed" in err && err.killed || err.message.includes("TIMEOUT")) {
            reject(new Error(`Query timed out after ${timeoutMs / 1000} seconds. Try a more specific query or use a smaller date range.`));
          } else {
            reject(new Error(stderr || err.message));
          }
          return;
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) {
            reject(new Error(result.error));
          } else {
            resolve({ rows: result.rows, columns: result.columns });
          }
        } catch {
          reject(new Error("Failed to parse query result"));
        }
      }
    );
  });
}

export function logNibrsQuery(
  question: string,
  sql: string | null,
  rowCount: number,
  error: string | null,
  ms: number,
  response: string | null = null,
  guardrails: string[] = [],
  model: string | null = null,
  sessionId: string | null = null
) {
  // Write to shared query_log.db via rtci-db's getWriteDb
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getWriteDb } = require("@/lib/rtci-db");
  const db = getWriteDb();
  if (db) {
    try {
      db.prepare(
        "INSERT INTO query_log (ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        Date.now(),
        "nibrs",
        (question || "").slice(0, 2000),
        (sql || "").slice(0, 4000) || null,
        rowCount,
        error ? error.slice(0, 500) : null,
        ms,
        response ? response.slice(0, 4000) : null,
        guardrails.length > 0 ? guardrails.join(",") : null,
        model,
        sessionId ? sessionId.slice(0, 64) : null
      );
    } catch (e) {
      console.error("[logNibrsQuery] Failed:", e);
    }
  }
}

export default getNibrsDb;
