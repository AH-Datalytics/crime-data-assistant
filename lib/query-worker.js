// Standalone Node script for executing SQL queries with timeout.
// Called via child_process.execFile with args: [dbPath, sql, ...moreSql]
// Outputs JSON to stdout: { rows, columns } for one statement,
//                         { results: [{ rows, columns }, ...] } for several,
//                         { error } on failure.
// When the parent kills this process on timeout, the query dies instantly.
//
// SEVERAL STATEMENTS SHARE ONE SNAPSHOT. Passing more than one statement runs them all on this
// single read-only connection inside ONE read transaction, so every statement sees the same
// database state. That is why the paired reads exist as one call: a review of the earlier code
// found that two `executeWithTimeoutSync` calls spawn two separate worker PROCESSES, each opening
// and closing its own connection, so a total from the first could describe different contributing
// rows from the coverage read in the second, and a transaction on the caller's own handle governs
// neither child.
//
// CLEANUP IS UNCONDITIONAL. The transaction is rolled back and the connection closed in `finally`,
// so a failing statement cannot leave a read lock behind for the next caller.
const Database = require("better-sqlite3");

const [, , dbPath, ...statements] = process.argv;

if (!dbPath || statements.length === 0) {
  console.log(JSON.stringify({ error: "Usage: node query-worker.js <dbPath> <sql> [...sql]" }));
  process.exit(1);
}

let db = null;
let inTransaction = false;
try {
  db = new Database(dbPath, { readonly: true });
  db.pragma("cache_size = -64000");
  db.pragma("mmap_size = 268435456");
  db.pragma("temp_store = MEMORY");

  /*
   * One read transaction over the statements — but ONLY when there is more than one.
   *
   * A single statement is already atomic, so wrapping it would change the locking behaviour of
   * every existing query in the application for no benefit. The snapshot is what a PAIRED read
   * needs, and that is the only case that takes it. Deferred, so the shared snapshot is taken at
   * the first read and held until the commit below.
   */
  if (statements.length > 1) {
    db.exec("BEGIN");
    inTransaction = true;
  }

  const results = statements.map((sql) => {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    const columns = stmt.columns().map((c) => c.name);
    return { rows, columns };
  });

  if (inTransaction) {
    db.exec("COMMIT");
    inTransaction = false;
  }

  // The single-statement response shape is unchanged, so existing callers are unaffected.
  console.log(JSON.stringify(statements.length === 1 ? results[0] : { results }));
} catch (err) {
  console.log(JSON.stringify({ error: err.message }));
  process.exitCode = 1;
} finally {
  if (db) {
    try { if (inTransaction) db.exec("ROLLBACK"); } catch { /* the connection is closing anyway */ }
    try { db.close(); } catch { /* nothing further to release */ }
  }
}
