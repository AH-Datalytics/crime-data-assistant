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
        created_at INTEGER NOT NULL
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
 * Whether query_log has the Phase 3 chart_config column.
 *
 * Cached per database handle, not globally: getWriteDb() reopens the file when it
 * changes on disk, and a cache keyed on nothing would go stale across a
 * migration or a database swap. A WeakMap keyed on the handle expires naturally
 * when that handle is discarded.
 */
const chartConfigColumnCache = new WeakMap<object, boolean>();

export function queryLogHasChartConfig(db: object): boolean {
  const cached = chartConfigColumnCache.get(db);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("PRAGMA table_info(query_log)")
      .all();
    present = rows.some((row) => row.name === "chart_config");
  } catch {
    present = false;
  }
  chartConfigColumnCache.set(db, present);
  return present;
}

/**
 * Whether query_log has the model_response column — a bounded capture of the raw
 * model text on no-SQL failures. Same per-handle caching rationale as
 * chartConfigColumnCache above.
 */
const modelResponseColumnCache = new WeakMap<object, boolean>();

export function queryLogHasModelResponse(db: object): boolean {
  const cached = modelResponseColumnCache.get(db);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("PRAGMA table_info(query_log)")
      .all();
    present = rows.some((row) => row.name === "model_response");
  } catch {
    present = false;
  }
  modelResponseColumnCache.set(db, present);
  return present;
}

const requestIdColumnCache = new WeakMap<object, boolean>();

export function queryLogHasRequestId(db: object): boolean {
  const cached = requestIdColumnCache.get(db);
  if (cached !== undefined) return cached;
  let present = false;
  try {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("PRAGMA table_info(query_log)").all();
    present = rows.some((row) => row.name === "request_id");
  } catch { present = false; }
  requestIdColumnCache.set(db, present);
  return present;
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
  requestId: string | null = null
): number | null {
  const db = getWriteDb();
  if (db) {
    try {
      const contractSource = tab === "hate_crime" ? "hate_crime" : tab as QueryContractSource;
      // Detected at runtime so schema and code can deploy in either order: an
      // unmigrated database logs exactly as before instead of failing every write.
      const withChartConfig = queryLogHasChartConfig(db);
      const withRequestId = queryLogHasRequestId(db);
      const columns = "ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id, routing_confidence, routing_mode, routing_reason, query_guidance, query_contract" +
        (withChartConfig ? ", chart_config" : "") + (withRequestId ? ", request_id" : "");
      const placeholders = new Array(16 + (withChartConfig ? 1 : 0) + (withRequestId ? 1 : 0)).fill("?").join(", " );
      const values: unknown[] = [
        Date.now(),
        tab,
        (question || "").slice(0, 2000),
        (sql || "").slice(0, 4000),
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
        serializeQueryContractLogMeta(question || "", contractSource, routingMeta),
      ];
      if (withChartConfig) values.push(chartConfigJson);
      if (withRequestId) values.push(requestId ? requestId.slice(0, 64) : null);
      const result = db.prepare(`INSERT INTO query_log (${columns}) VALUES (${placeholders})`).run(...values);
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
