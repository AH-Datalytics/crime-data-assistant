// Standalone Node script for executing NIBRS SQL queries.
// Called via child_process.execFile with args: [dbPath, rollupPath, sql]
// Outputs JSON to stdout: { rows, columns } or { error }
// When the parent kills this process on timeout, the query dies instantly.
const Database = require("better-sqlite3");

const [,, dbPath, rollupPath, sql] = process.argv;

if (!dbPath || !sql) {
  console.log(JSON.stringify({ error: "Usage: node nibrs-query-worker.js <dbPath> <rollupPath> <sql>" }));
  process.exit(1);
}

try {
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  if (rollupPath) {
    db.prepare("ATTACH DATABASE ? AS rollup").run(rollupPath);
    db.pragma("query_only = ON");
  }

  const stmt = db.prepare(sql);
  const rows = stmt.all();
  const columns = stmt.columns().map((c) => c.name);

  db.close();
  console.log(JSON.stringify({ rows, columns }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
}
