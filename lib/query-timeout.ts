import type Database from "better-sqlite3";
import { execFileSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

/**
 * Execute a SQL statement with a real timeout.
 *
 * Writes a small Node script to a temp file, runs it with execFileSync + timeout.
 * The child process opens its own DB connection, runs the query, writes results
 * to a temp JSON file. If the timeout is exceeded, Node kills the child process,
 * which terminates the SQLite query immediately.
 *
 * Overhead: ~80ms for process spawn + DB open. Negligible for 1-5s queries.
 */
export function executeWithTimeoutSync<T>(
  db: Database.Database,
  stmt: Database.Statement,
  timeoutMs: number = 30000
): T[] {
  const dbPath = (db as unknown as { name: string }).name;
  if (!dbPath) {
    return stmt.all() as T[];
  }

  const sql = stmt.source;
  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpScript = path.join(os.tmpdir(), `nibrs-qs-${uid}.js`);
  const tmpResult = path.join(os.tmpdir(), `nibrs-qr-${uid}.json`);

  const script = `
const Database = require(${JSON.stringify(require.resolve("better-sqlite3"))});
const fs = require("fs");
try {
  const db = new Database(${JSON.stringify(dbPath)}, { readonly: true });
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  const stmt = db.prepare(${JSON.stringify(sql)});
  const rows = stmt.all();
  db.close();
  fs.writeFileSync(${JSON.stringify(tmpResult)}, JSON.stringify(rows));
} catch (err) {
  fs.writeFileSync(${JSON.stringify(tmpResult)}, JSON.stringify({ __error: err.message }));
}
`;

  fs.writeFileSync(tmpScript, script);

  try {
    execFileSync(process.execPath, [tmpScript], {
      timeout: timeoutMs,
      stdio: 'pipe',
    });

    const raw = fs.readFileSync(tmpResult, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.__error) {
      throw new Error(parsed.__error);
    }
    return parsed as T[];
  } catch (err: unknown) {
    if (err instanceof Error && 'killed' in err && (err as unknown as { killed: boolean }).killed) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('TIMEOUT') || msg.includes('SIGTERM')) {
      throw new Error(`Query timed out after ${Math.round(timeoutMs / 1000)} seconds`);
    }
    throw err;
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
    try { fs.unlinkSync(tmpResult); } catch {}
  }
}
