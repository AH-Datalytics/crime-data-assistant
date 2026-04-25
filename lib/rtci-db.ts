import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { findExistingPaths, getManagedDb, resolveDbPath } from "./sqlite-db";

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
        session_id TEXT
      )
    `);
    // Add columns if table already exists without them
    for (const col of ["tab TEXT", "session_id TEXT", "guardrails TEXT", "model TEXT"]) {
      try { _writeDb.exec(`ALTER TABLE query_log ADD COLUMN ${col}`); } catch { /* already exists */ }
    }
    return _writeDb;
  } catch (e) {
    console.warn("Query logging disabled:", e);
    _writeDisabled = true;
    return null;
  }
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
  sessionId: string | null = null
) {
  const db = getWriteDb();
  if (db) {
    try {
      db.prepare(
        "INSERT INTO query_log (ts, tab, question, sql, rows, error, ms, response, guardrails, model, session_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
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
        sessionId ? sessionId.slice(0, 64) : null
      );
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
      }),
    }).catch(() => {});
  }
}

export default getDb;
