#!/usr/bin/env node
/**
 * Phase 3: add query_log.chart_config so the cross-artifact auditor can compare
 * a chart's claims against the query that produced it.
 *
 * Deliberately a SEPARATE migration from migrate-audit-findings-source.js. This
 * one touches the hot write path -- every answered query logs a row -- so if
 * anything goes wrong it must be revertible without disturbing the auditor's
 * provenance work.
 *
 * Safety:
 *   - Additive only: one nullable TEXT column. No index, no rewrite, no backfill.
 *     Existing rows keep NULL, which the detectors read as "no chart captured"
 *     rather than "chart was empty".
 *   - Idempotent.
 *   - Old code keeps working: logQuery detects the column at runtime and only
 *     writes it when present, so deploy order between schema and code is free.
 *
 * Usage:
 *   node scripts/migrate-query-log-chart-config.js --db <path> [--dry-run] [--rollback]
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

  const present = hasColumn(db, "query_log", "chart_config");

  if (rollback) {
    if (!present) {
      console.log("chart_config is not present; nothing to roll back.");
      db.close();
      return { changed: false };
    }
    const populated = db.prepare("SELECT COUNT(*) AS n FROM query_log WHERE chart_config IS NOT NULL").get().n;
    console.log(`Rolling back: dropping chart_config (${populated} rows currently populated).`);
    if (dryRun) { console.log("--dry-run: no changes written."); db.close(); return { changed: false }; }
    db.exec("ALTER TABLE query_log DROP COLUMN chart_config");
    const integrity = db.pragma("integrity_check", { simple: true });
    db.close();
    console.log(`  dropped. integrity_check: ${integrity}`);
    if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
    return { changed: true };
  }

  if (present) {
    const populated = db.prepare("SELECT COUNT(*) AS n FROM query_log WHERE chart_config IS NOT NULL").get().n;
    console.log(`chart_config already present (${populated} rows populated); nothing to do.`);
    db.close();
    return { changed: false };
  }

  console.log("Planned: ALTER TABLE query_log ADD COLUMN chart_config TEXT");
  if (dryRun) { console.log("--dry-run: no changes written."); db.close(); return { changed: false }; }

  db.exec("ALTER TABLE query_log ADD COLUMN chart_config TEXT");

  const columns = db.prepare("PRAGMA table_info(query_log)").all().map((row) => row.name);
  const integrity = db.pragma("integrity_check", { simple: true });
  const rowCount = db.prepare("SELECT COUNT(*) AS n FROM query_log").get().n;
  db.close();

  console.log(`  chart_config present: ${columns.includes("chart_config")}`);
  console.log(`  query_log rows preserved: ${rowCount}`);
  console.log(`  integrity_check: ${integrity}`);
  if (!columns.includes("chart_config")) throw new Error("column was not added");
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
