import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "crime_data.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

// --- Write DB for query logging ---
// Uses /tmp on Vercel (ephemeral but writable) or cwd locally
let _writeDb: Database.Database | null = null;
let _writeDisabled = false;

function getLogDbPath(): string {
  // On Vercel, cwd is read-only; use /tmp
  const tmpPath = path.join(os.tmpdir(), "crime_query_log.db");
  const localPath = path.join(process.cwd(), "query_log.db");
  // If local path is writable, prefer it
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
        question TEXT,
        sql TEXT,
        rows INTEGER,
        error TEXT,
        ms INTEGER,
        response TEXT
      )
    `);
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
  response: string | null = null
) {
  const db = getWriteDb();
  if (!db) return;
  try {
    db.prepare(
      "INSERT INTO query_log (ts, question, sql, rows, error, ms, response) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      Date.now(),
      (question || "").slice(0, 2000),
      (sql || "").slice(0, 4000),
      rowCount,
      error ? error.slice(0, 500) : null,
      ms,
      response ? response.slice(0, 4000) : null
    );
  } catch (e) {
    console.warn("Log write failed:", e);
  }
}

export default getDb;
