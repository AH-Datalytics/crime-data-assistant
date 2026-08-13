import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { findExistingPaths, getManagedDb, resolveDbPath } from "./sqlite-db";
import type { RoutingLogMeta } from "./routing-log-meta";
import { serializeQueryGuidanceLogMeta } from "./query-guidance-log";
import { serializeQueryContractLogMeta, type QueryContractSource } from "./query-contract";
import {
  normalizedSqlShape,
  resolverWarningCode,
  resolverWarningFingerprint,
  warningWhitelistMatch,
} from "./resolver-warning-classification";
import { buildQueryLogInsert, queryLogHasColumn } from "./query-log-columns";
import { EMPTY_PROOF_LOG_FIELDS, type ProofLogFields } from "./proof-finalize";

const state = {
  db: null as Database.Database | null,
  failed: false,
  path: null as string | null,
  mtimeMs: null as number | null,
};

export function getDb(): Database.Database {
  const db = getManagedDb(state, {
    envVar: "RTCI_DB_PATH",
    label: "crime_data.db",
    candidates: [
      path.join(process.cwd(), "crime_data.db"),
    ],
    pragmas: [
      ["cache_size", -64000],
      ["mmap_size", 268435456],
      ["temp_store", "MEMORY"],
    ],
  });
  if (!db) {
    throw new Error("Could not open crime_data.db");
  }
  return db;
}

// --- Shared write DB for query logging (all tabs) ---
let _writeDb: Database.Database | null = null;
let _writeDisabled = false;
let _logPath: string | null = null;

function getLogDbPath(): string {
  if (_logPath) return _logPath;

  const tmpPath = path.join(os.tmpdir(), "crime_query_log.db");
  const candidates = [
    path.join(process.cwd(), "query_log.db"),
  ];
  const envValue = process.env.QUERY_LOG_DB_PATH;
  const existing = findExistingPaths(envValue, candidates);
  if (existing.length > 1) {
    console.warn(`[db] Multiple query_log.db candidates exist: ${existing.join(", ")}`);
  }

  const preferred = resolveDbPath(envValue, candidates) || tmpPath;
  const dir = path.dirname(preferred);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    _logPath = preferred;
    console.log(`[db] Using query_log.db: ${_logPath}`);
    return _logPath;
  } catch {
    _logPath = tmpPath;
    console.warn(`[db] Falling back to temp query log DB: ${_logPath}`);
    return _logPath;
  }
}

export function getWriteDb(): Database.Database | null {
  if (_writeDisabled) return null;
  if (_writeDb) return _writeDb;
  try {
    _writeDb = new Database(getLogDbPath());
    _writeDb.exec(`
      CREATE TABLE IF NOT EXISTS query_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER,
        tab TEXT,
        question TEXT,
        sql TEXT,
        rows INTEGER,
        error TEXT,
        ms INTEGER,
        response TEXT,
        guardrails TEXT,
        model TEXT,
        session_id TEXT,
        routing_confidence TEXT,
        routing_mode TEXT,
        routing_reason TEXT,
        query_guidance TEXT,
        query_contract TEXT
      )
    `);
    _writeDb.exec(`
      CREATE TABLE IF NOT EXISTS shared_charts (
        id TEXT PRIMARY KEY,
        tab TEXT NOT NULL,
        title TEXT,
        sql TEXT NOT NULL,
        chart_config TEXT,
        chart_meta TEXT,
        created_at INTEGER NOT NULL,
        -- Proof columns (handoff §4). Present here for a freshly-created database;
        -- scripts/migrate-shared-charts-proof.js adds them to an existing one, and
        -- app/api/embed/route.ts detects them at runtime so deploy order is free.
        origin_request_id TEXT,
        origin_delivery_action TEXT,
        origin_proof_mode TEXT,
        origin_state TEXT,
        last_read_delivery_action TEXT,
        last_read_at INTEGER
      )
    `);
    _writeDb.exec(`
      CREATE TABLE IF NOT EXISTS resolver_warning_classification (
        fingerprint TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        warning_code TEXT NOT NULL,
        warning_text TEXT NOT NULL,
        sql_shape TEXT NOT NULL,
        sample_question TEXT,
        sample_sql TEXT,
        sample_session_id TEXT,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 1,
        classification TEXT NOT NULL DEFAULT 'unclassified',
        whitelist_rule TEXT,
        review_notes TEXT,
        reviewed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_resolver_warning_last_seen
        ON resolver_warning_classification(last_seen);
      CREATE INDEX IF NOT EXISTS idx_resolver_warning_classification
        ON resolver_warning_classification(classification);
    `);
    // Add columns if table already exists without them
    for (const col of ["tab TEXT", "session_id TEXT", "guardrails TEXT", "model TEXT", "routing_confidence TEXT", "routing_mode TEXT", "routing_reason TEXT", "query_guidance TEXT", "query_contract TEXT"]) {
      try { _writeDb.exec(`ALTER TABLE query_log ADD COLUMN ${col}`); } catch { /* already exists */ }
    }
    return _writeDb;
  } catch (e) {
    console.warn("Query logging disabled:", e);
    _writeDisabled = true;
    return null;
  }
}

export function logResolverWarnings(input: {
  source: "nibrs" | "shr";
  question: string;
  sql: string;
  warnings: string[];
  sessionId?: string | null;
}): void {
  if (input.warnings.length === 0) return;
  const db = getWriteDb();
  if (!db) return;
  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO resolver_warning_classification (
      fingerprint, source, warning_code, warning_text, sql_shape,
      sample_question, sample_sql, sample_session_id,
      first_seen, last_seen, occurrence_count, classification, whitelist_rule
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET
      last_seen = excluded.last_seen,
      occurrence_count = resolver_warning_classification.occurrence_count + 1,
      sample_question = excluded.sample_question,
      sample_sql = excluded.sample_sql,
      sample_session_id = excluded.sample_session_id,
      whitelist_rule = COALESCE(resolver_warning_classification.whitelist_rule, excluded.whitelist_rule)
  `);
  const write = db.transaction((warnings: string[]) => {
    for (const warning of warnings) {
      const whitelistRule = warningWhitelistMatch(input.sql);
      upsert.run(
        resolverWarningFingerprint(input.source, warning, input.sql),
        input.source,
        resolverWarningCode(warning),
        warning.slice(0, 1000),
        normalizedSqlShape(input.sql),
        input.question.slice(0, 2000),
        input.sql.slice(0, 4000),
        input.sessionId?.slice(0, 64) || null,
        now,
        now,
        whitelistRule ? "whitelisted_safe" : "unclassified",
        whitelistRule,
      );
    }
  });
  try {
    write(input.warnings);
  } catch (error) {
    console.warn("Resolver warning classification write failed:", error);
  }
}

/**
 * Per-column presence checks for query_log.
 *
 * These were three near-identical WeakMap caches, each re-running PRAGMA
 * table_info for one column name. Stage 1 adds six more columns, at which point
 * nine copies of the same twelve lines is worse than one shared column set — so
 * they now delegate to lib/query-log-columns, which caches the whole set per
 * handle with the same expiry semantics. The three exported names are kept
 * because lib/nibrs-db.ts requires them by name.
 */
export function queryLogHasChartConfig(db: object): boolean {
  return queryLogHasColumn(db, "chart_config");
}

export function queryLogHasModelResponse(db: object): boolean {
  return queryLogHasColumn(db, "model_response");
}

export function queryLogHasRequestId(db: object): boolean {
  return queryLogHasColumn(db, "request_id");
}

export function logQuery(
  question: string,
  sql: string | null,
  rowCount: number,
  error: string | null,
  ms: number,
  response: string | null = null,
  tab: string = "current",
  guardrails: string[] = [],
  model: string | null = null,
  sessionId: string | null = null,
  routingMeta: RoutingLogMeta | null = null,
  /**
   * Pre-serialized chart configuration (see serializeChartConfigForLog). Passed
   * as a string rather than a ChartConfig so the allowlist serialization happens
   * once at the call site and this function cannot accidentally widen it.
   */
  chartConfigJson: string | null = null,
  requestId: string | null = null,
  /**
   * Bounded raw model text on no-SQL failures. Diagnostic only; never user-visible.
   *
   * CLOSES A REAL GAP. Until Stage 1 this parameter did not exist, so
   * `model_response` could only ever be written by the NIBRS route — Current
   * Trends, Historical, SHR, and Hate Crime had no diagnostic capture at all.
   * Handoff §3.13 requires the proof contract to apply uniformly across all five
   * sources, and the Stage 0 baseline recorded this asymmetry as Stage 1 scope
   * (docs/reviews/2026-08-11-stage0-production-baseline.md §4).
   */
  modelResponseJson: string | null = null,
  /**
   * Proof/digest/delivery columns from lib/proof-finalize's proofLogFields().
   *
   * Defaults to all-null, which is exactly what `off` mode produces — so an
   * off-mode deployment writes query_log rows identical to the baseline release's.
   */
  proofFields: ProofLogFields = EMPTY_PROOF_LOG_FIELDS
): number | null {
  const db = getWriteDb();
  if (db) {
    try {
      const contractSource = tab === "hate_crime" ? "hate_crime" : tab as QueryContractSource;
      // Columns are filtered against the live table so schema and code can deploy
      // in either order: an unmigrated database logs exactly as before instead of
      // failing every write. buildQueryLogInsert derives the column list, the
      // placeholders, and the values from this one object, so they cannot drift.
      const insert = buildQueryLogInsert(db, {
        ts: Date.now(),
        tab,
        question: (question || "").slice(0, 2000),
        sql: (sql || "").slice(0, 4000),
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
        query_contract: serializeQueryContractLogMeta(question || "", contractSource, routingMeta),
        chart_config: chartConfigJson,
        request_id: requestId ? requestId.slice(0, 64) : null,
        model_response: modelResponseJson ? modelResponseJson.slice(0, 4000) : null,
        ...proofFields,
      });
      if (!insert) return null;
      const result = db.prepare(insert.sql).run(...insert.values);
      return Number(result.lastInsertRowid);
    } catch (e) {
      console.warn("Log write failed:", e);
    }
  }

  // Google Sheets log (fire-and-forget)
  const sheetUrl = process.env.SHEET_WEBHOOK_URL;
  if (sheetUrl) {
    fetch(sheetUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tab,
        question: (question || "").slice(0, 2000),
        sql: (sql || "").slice(0, 4000),
        rows: rowCount,
        error: error ? error.slice(0, 500) : null,
        ms,
        response: response ? response.slice(0, 4000) : null,
        routingConfidence: routingMeta?.confidence ?? null,
        routingMode: routingMeta?.mode ?? null,
        routingReason: routingMeta?.reason ?? null,
        queryGuidance: serializeQueryGuidanceLogMeta(question || ""),
        queryContract: serializeQueryContractLogMeta(question || "", tab === "hate_crime" ? "hate_crime" : tab as QueryContractSource, routingMeta),
      }),
    }).catch(() => {});
  }
  return null;
}

export default getDb;
