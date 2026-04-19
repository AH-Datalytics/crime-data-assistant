import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = process.env.RTCI_DB_PATH || path.join(process.cwd(), "crime_data.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.pragma("cache_size = -64000");   // 64 MB page cache
    _db.pragma("mmap_size = 268435456"); // 256 MB memory-mapped I/O
    _db.pragma("temp_store = MEMORY");
  }
  return _db;
}

// --- Shared write DB for query logging (all tabs) ---
let _writeDb: Database.Database | null = null;
let _writeDisabled = false;

function getLogDbPath(): string {
  const tmpPath = path.join(os.tmpdir(), "crime_query_log.db");
  const localPath = path.join(process.cwd(), "query_log.db");
  try {
    fs.accessSync(process.cwd(), fs.constants.W_OK);
    return localPath;
  } catch {
    return tmpPath;
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
        response TEXT
      )
    `);
    // Add columns if table already exists without them
    try { _writeDb.exec(`ALTER TABLE query_log ADD COLUMN tab TEXT`); } catch { /* already exists */ }
    try { _writeDb.exec(`ALTER TABLE query_log ADD COLUMN session_id TEXT`); } catch { /* already exists */ }
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
