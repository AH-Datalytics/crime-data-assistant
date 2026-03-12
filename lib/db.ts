import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(process.cwd(), "crime_data.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
  }
  return _db;
}

export default getDb;
