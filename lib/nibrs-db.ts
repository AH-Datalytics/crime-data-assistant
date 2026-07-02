import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import path from "path";
import fs from "fs";
import { getManagedDb, resolveDbPath } from "./sqlite-db";
import type { RoutingLogMeta } from "./routing-log-meta";
import { serializeQueryGuidanceLogMeta } from "./query-guidance-log";
import { serializeQueryContractLogMeta } from "./query-contract";

const state = {
  db: null as Database.Database | null,
  failed: false,
  path: null as string | null,
  mtimeMs: null as number | null,
};

export function getNibrsDb(): Database.Database {
  const db = getManagedDb(state, {
    envVar: "NIBRS_DB_PATH",
    label: "nibrs.db",
    candidates: [
      path.join(process.cwd(), "nibrs.db"),
    ],
    pragmas: [
      ["journal_mode", "WAL"],
      ["busy_timeout", 5000],
    ],
  });
  if (!db) {
    throw new Error("Could not open nibrs.db");
  }
  return db;
}

const QUERY_TIMEOUT_MS = 30_000;

function resolveWorkerScriptPath(): string | null {
  const candidates = [
    path.join(process.cwd(), "lib", "nibrs-query-worker.js"),
    path.join(__dirname, "nibrs-query-worker.js"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

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
    const workerScript = resolveWorkerScriptPath();
    const dbPath = resolveDbPath(process.env.NIBRS_DB_PATH, [
      path.join(process.cwd(), "nibrs.db"),
    ]);
    if (!dbPath) {
      reject(new Error("Could not resolve nibrs.db path"));
      return;
    }

    // Fall back to sync if worker script missing
    if (!workerScript) {
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
      [workerScript, dbPath, sql],
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
  sessionId: string | null = null,
  routingMeta: RoutingLogMeta | null = null
) {
  // Write to shared query_log.db via rtci-db's getWriteDb
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getWriteDb } = require("@/lib/rtci-db");
  const db = getWriteDb();
  if (db) {
    try {
      db.prepare(
        "INSERT INTO query_log (ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, routing_confidence, routing_mode, routing_reason, query_guidance, query_contract) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
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
        sessionId ? sessionId.slice(0, 64) : null,
        routingMeta?.confidence ?? null,
        routingMeta?.mode ?? null,
        routingMeta?.reason ?? null,
        serializeQueryGuidanceLogMeta(question || ""),
        serializeQueryContractLogMeta(question || "", "nibrs", routingMeta)
      );
    } catch (e) {
      console.error("[logNibrsQuery] Failed:", e);
    }
  }
}

export default getNibrsDb;
