#!/usr/bin/env node
/**
 * Add query_log.model_response: a bounded capture of the raw model text when a
 * response contains no SQL.
 *
 * Why: the NIBRS route overwrites claude.explanation with a server-authored
 * template before logging, so on production 8375 the model's actual words were
 * gone and the failure could only be diagnosed by replaying the request against
 * the live API. This column keeps the first attempt and the retry, capped.
 *
 * Diagnostic only. It is not returned to users and is excluded from the query
 * log viewer and the daily digest, both of which select explicit columns.
 *
 * Safety:
 *   - Additive only: one nullable TEXT column. No index, no rewrite, no backfill.
 *   - Idempotent.
 *   - Old code keeps working: logNibrsQuery detects the column at runtime and
 *     only writes it when present, so deploy order between schema and code is
 *     free in both directions.
 *
 * Usage:
 *   node scripts/migrate-query-log-model-response.js --db <path> [--dry-run] [--rollback]
 */

const Database = require("better-sqlite3");
const fs = require("node:fs");

function parseArgs() {
  const argv = process.argv;
  const dbIndex = argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : process.env.QUERY_LOG_DB_PATH;
  if (!dbPath) throw new Error("Pass --db <path> or set QUERY_LOG_DB_PATH.");
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  return { dbPath, dryRun: argv.includes("--dry-run"), rollback: argv.includes("--rollback") };
}

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

function migrate({ dbPath, dryRun, rollback }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");

  const present = hasColumn(db, "query_log", "model_response");

  if (rollback) {
    if (!present) {
      console.log("model_response is not present; nothing to roll back.");
      db.close();
      return { changed: false };
    }
    const populated = db.prepare("SELECT COUNT(*) AS n FROM query_log WHERE model_response IS NOT NULL").get().n;
    console.log(`Rolling back: dropping model_response (${populated} rows currently populated).`);
    if (dryRun) { console.log("--dry-run: no changes written."); db.close(); return { changed: false }; }
    db.exec("ALTER TABLE query_log DROP COLUMN model_response");
    const integrity = db.pragma("integrity_check", { simple: true });
    db.close();
    console.log(`  dropped. integrity_check: ${integrity}`);
    if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
    return { changed: true };
  }

  if (present) {
    const populated = db.prepare("SELECT COUNT(*) AS n FROM query_log WHERE model_response IS NOT NULL").get().n;
    console.log(`model_response already present (${populated} rows populated); nothing to do.`);
    db.close();
    return { changed: false };
  }

  console.log("Planned: ALTER TABLE query_log ADD COLUMN model_response TEXT");
  if (dryRun) { console.log("--dry-run: no changes written."); db.close(); return { changed: false }; }

  db.exec("ALTER TABLE query_log ADD COLUMN model_response TEXT");

  const columns = db.prepare("PRAGMA table_info(query_log)").all().map((row) => row.name);
  const integrity = db.pragma("integrity_check", { simple: true });
  const rowCount = db.prepare("SELECT COUNT(*) AS n FROM query_log").get().n;
  db.close();

  console.log(`  model_response present: ${columns.includes("model_response")}`);
  console.log(`  query_log rows preserved: ${rowCount}`);
  console.log(`  integrity_check: ${integrity}`);
  if (!columns.includes("model_response")) throw new Error("column was not added");
  if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
  return { changed: true };
}

if (require.main === module) {
  try {
    migrate(parseArgs());
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { migrate };
