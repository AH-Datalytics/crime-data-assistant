// Standalone Node script for executing SQL queries with timeout.
// Called via child_process.execFile with args: [dbPath, sql]
// Outputs JSON to stdout: { rows, columns } or { error }
// When the parent kills this process on timeout, the query dies instantly.
const Database = require("better-sqlite3");

const [,, dbPath, sql] = process.argv;

if (!dbPath || !sql) {
  console.log(JSON.stringify({ error: "Usage: node query-worker.js <dbPath> <sql>" }));
  process.exit(1);
}

try {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");
  const stmt = db.prepare(sql);
  const rows = stmt.all();
  const columns = stmt.columns().map(c => c.name);
  db.close();
  console.log(JSON.stringify({ rows, columns }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
}
