import Database from "better-sqlite3";
import path from "path";

const SHR_DB_PATH = process.env.SHR_DB_PATH || path.join(process.cwd(), "..", "shr.db");

let _db: Database.Database | null = null;

export function getShrDb(): Database.Database {
  if (!_db) {
    _db = new Database(SHR_DB_PATH, { readonly: true });
    _db.pragma("cache_size = -32000");   // 32 MB
    _db.pragma("mmap_size = 134217728"); // 128 MB
    _db.pragma("temp_store = MEMORY");
  }
  return _db;
}
