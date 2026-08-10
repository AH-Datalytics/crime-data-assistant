import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import path from "path";
import fs from "fs";
import { getManagedDb, resolveDbPath } from "./sqlite-db";
import type { RoutingLogMeta } from "./routing-log-meta";
import { serializeQueryGuidanceLogMeta } from "./query-guidance-log";
import { serializeQueryContractLogMeta } from "./query-contract";
import { ensureNibrsRollupAttached, nibrsRollupContextForDb } from "./nibrs-rollup-router";

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
  try {
    ensureNibrsRollupAttached(db);
  } catch (error) {
    // Ordinary main-database queries may continue. Rollup-routed queries are
    // rejected explicitly rather than falling back to main.
    console.error("[nibrs] Rollup attachment unavailable:", error instanceof Error ? error.message : String(error));
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

    const db = getNibrsDb();
    const rollupContext = nibrsRollupContextForDb(db);
    if (/\brollup\./i.test(sql) && !rollupContext?.available) {
      reject(new Error("NIBRS rollup is unavailable"));
      return;
    }

    // Fall back to sync if worker script missing
    if (!workerScript) {
      console.warn("[nibrs] Worker script not found, falling back to sync execution");
      try {
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
      [workerScript, dbPath, rollupContext?.path ?? "", sql],
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
  routingMeta: RoutingLogMeta | null = null,
  /** Phase 3 chart capture; pre-serialized via lib/chart-config-log's allowlist. */
  chartConfigJson: string | null = null,
  /** Bounded raw model text on no-SQL failures; see lib/no-sql-retry. Diagnostic only. */
  modelResponseJson: string | null = null
) {
  // Write to shared query_log.db via rtci-db's getWriteDb
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getWriteDb, queryLogHasChartConfig, queryLogHasModelResponse } = require("@/lib/rtci-db");
  const db = getWriteDb();
  if (db) {
    try {
      // Detected at runtime for the same reason as logQuery: an unmigrated
      // database must keep logging exactly as before rather than fail every write.
      const withChartConfig = queryLogHasChartConfig(db);
      const withModelResponse = queryLogHasModelResponse(db);
      const columns = "ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, routing_confidence, routing_mode, routing_reason, query_guidance, query_contract" +
        (withChartConfig ? ", chart_config" : "") +
        (withModelResponse ? ", model_response" : "");
      const placeholders = new Array(16 + (withChartConfig ? 1 : 0) + (withModelResponse ? 1 : 0)).fill("?").join(", ");
      const values: unknown[] = [
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
        serializeQueryContractLogMeta(question || "", "nibrs", routingMeta),
      ];
      if (withChartConfig) values.push(chartConfigJson);
      if (withModelResponse) values.push(modelResponseJson ? modelResponseJson.slice(0, 4000) : null);
      db.prepare(`INSERT INTO query_log (${columns}) VALUES (${placeholders})`).run(...values);
    } catch (e) {
      console.error("[logNibrsQuery] Failed:", e);
    }
  }
}

export default getNibrsDb;
