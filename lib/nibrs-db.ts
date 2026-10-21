import { isInnerRun } from "./why-scope";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import path from "path";
import fs from "fs";
import { getManagedDb, resolveDbPath } from "./sqlite-db";
import type { RoutingLogMeta } from "./routing-log-meta";
import { serializeQueryGuidanceLogMeta } from "./query-guidance-log";
import { serializeQueryContractLogMeta } from "./query-contract";
import { ensureNibrsRollupAttached, nibrsRollupContextForDb } from "./nibrs-rollup-router";
import { buildQueryLogInsert } from "./query-log-columns";
import {
  EMPTY_PROOF_LOG_FIELDS,
  EMPTY_OUTCOME_LOG_FIELDS,
  type ProofLogFields,
  type OutcomeLogFields,
} from "./proof-finalize";
import { nibrsExecutionAuthorityIssue, nibrsSqlSha256, type NibrsExecutionAuthority } from "./nibrs-execution-binding";
import { withUnreadNote, withUnreadTag } from "./unread-fallthrough";

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
  return runNibrsStatement(sql, timeoutMs, null);
}

/**
 * P4.1: execute exactly the statement that passed the final checks on a NIBRS model path. Only an
 * authority issued by `finalizeNibrsStatement` is accepted, and its SQL identity is verified again
 * immediately before prepare -- in the worker, or before the synchronous fallback prepares it. Other
 * callers (owned/deterministic builders, the application fallback) keep `executeWithTimeout`.
 */
export function executeBoundNibrsStatement(
  authority: NibrsExecutionAuthority,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
  const issue = nibrsExecutionAuthorityIssue(authority);
  if (issue) return Promise.reject(new Error(`NIBRS execution refused: ${issue}`));
  return runNibrsStatement(authority.sql, timeoutMs, authority.sha256);
}

function runNibrsStatement(
  sql: string,
  timeoutMs: number,
  expectedSha256: string | null
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
      // The same identity check the worker applies, before prepare. No hard timeout is claimed here.
      if (expectedSha256 && nibrsSqlSha256(sql) !== expectedSha256) {
        reject(new Error("NIBRS execution refused: the statement to prepare differs from the one that passed the final checks"));
        return;
      }
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
      [workerScript, dbPath, rollupContext?.path ?? "", sql, ...(expectedSha256 ? [expectedSha256] : [])],
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
  modelResponseJson: string | null = null,
  requestId: string | null = null,
  /** Proof/digest/delivery columns from lib/proof-finalize's proofLogFields(). */
  proofFields: ProofLogFields = EMPTY_PROOF_LOG_FIELDS,
  /**
   * The three outcome-owned columns from lib/proof-finalize's outcomeLogFields().
   *
   * A SECOND projector with a column set disjoint from proofFields, so "which switch writes
   * this column" has a structural answer rather than a procedural one. Defaults to all-null,
   * which is what a gate-off deployment produces — byte-identical to the baseline release.
   */
  outcomeFields: OutcomeLogFields = EMPTY_OUTCOME_LOG_FIELDS
): number | null {
  // Stage 3b (r1.4 R4.2): an inner run of a "why" turn writes no log row; the outer turn logs once.
  if (isInnerRun()) return null;
  // Option 2 stopgap: the delivered note and its tag on every terminal row of a fallback request (lib/unread-fallthrough.ts).
  response = withUnreadNote(response, rowCount > 0) ?? response;
  guardrails = withUnreadTag(guardrails) ?? guardrails;
  // Write to shared query_log.db via rtci-db's getWriteDb
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getWriteDb } = require("@/lib/rtci-db");
  const db = getWriteDb();
  if (db) {
    try {
      // Columns filtered against the live table for the same reason as logQuery: an
      // unmigrated database must keep logging exactly as before rather than fail
      // every write. Replaces three parallel sequences (column string, placeholder
      // arithmetic, positional values) that had to agree by hand — a disagreement
      // there threw inside this catch and silently lost every log row.
      const insert = buildQueryLogInsert(db, {
        ts: Date.now(),
        tab: "nibrs",
        question: (question || "").slice(0, 2000),
        sql: (sql || "").slice(0, 4000) || null,
        rows: rowCount,
        error: error ? error.slice(0, 500) : null,
        ms,
        response: response ? response.slice(0, 4000) : null,
        guardrails: guardrails.length > 0 ? guardrails.join(",") : null,
        model,
        session_id: sessionId ? sessionId.slice(0, 64) : null,
        routing_confidence: routingMeta?.confidence ?? null,
        routing_mode: routingMeta?.mode ?? null,
        routing_reason: routingMeta?.reason ?? null,
        query_guidance: serializeQueryGuidanceLogMeta(question || ""),
        query_contract: serializeQueryContractLogMeta(question || "", "nibrs", routingMeta),
        chart_config: chartConfigJson,
        model_response: modelResponseJson ? modelResponseJson.slice(0, 4000) : null,
        request_id: requestId ? requestId.slice(0, 64) : null,
        ...proofFields,
        ...outcomeFields,
      });
      if (!insert) return null;
      const result = db.prepare(insert.sql).run(...insert.values);
      return Number(result.lastInsertRowid);
    } catch (e) {
      console.error("[logNibrsQuery] Failed:", e);
    }
  }
  return null;
}

export default getNibrsDb;
