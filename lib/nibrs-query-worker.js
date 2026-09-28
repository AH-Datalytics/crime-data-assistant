// Standalone Node script for executing NIBRS SQL queries.
// Called via child_process.execFile with args: [dbPath, rollupPath, sql, expectedSha256?]
// Outputs JSON to stdout: { rows, columns } or { error }
// When the parent kills this process on timeout, the query dies instantly.
// P4.1: when an expected SHA-256 is supplied (the NIBRS model initial/retry paths), the statement
// received here must be exactly the one that passed the final checks; it is verified before prepare.
const Database = require("better-sqlite3");
const crypto = require("crypto");

const [,, dbPath, rollupPath, sql, expectedSha256] = process.argv;

if (expectedSha256 && sql && crypto.createHash("sha256").update(sql, "utf8").digest("hex") !== expectedSha256) {
  console.log(JSON.stringify({ error: "NIBRS execution refused: the statement received differs from the one that passed the final checks" }));
  process.exit(0);
}

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
