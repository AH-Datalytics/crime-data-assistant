#!/usr/bin/env node
/**
 * Additive migration: give `audit_findings` a provenance column, and add the
 * run-accounting table the incremental auditor needs.
 *
 * Why this is needed
 * ------------------
 * Two independent processes write `audit_findings`:
 *   - scripts/daily-query-analysis.js  (rule-based digest findings)
 *   - scripts/run-query-audit.ts       (Phase 1 deterministic detectors)
 * Both created the table with the same columns and the same UNIQUE index on
 * (query_log_id, category), and neither recorded WHICH system produced a row.
 * That makes "judge-only vs detector-confirmed" unreportable, and it means the
 * two writers' conflict policies (INSERT OR IGNORE vs ON CONFLICT DO UPDATE)
 * fight over the same key if a category name is ever used on both sides.
 *
 * Safety properties (this runs against a LIVE production database)
 * ---------------------------------------------------------------
 *   - Additive only: ADD COLUMN + CREATE INDEX. No table rewrite, no data loss,
 *     no column drops. Old writer code keeps working via the column default.
 *   - The new unique index is created BEFORE the old one is dropped, so the
 *     table is never left without uniqueness protection mid-migration.
 *   - Idempotent: safe to re-run. The one-time provenance backfill happens only
 *     on the run that actually adds the column.
 *   - Bounded busy timeout so a concurrent app write fails fast instead of
 *     hanging the migration (the app opens this file readonly, but the digest
 *     and the auditor both write it).
 *
 * Usage:
 *   node scripts/migrate-audit-findings-source.js --db <path> [--dry-run]
 */

const Database = require("better-sqlite3");
const fs = require("node:fs");

const BUSY_TIMEOUT_MS = 10000;

/**
 * Every pre-existing row was written by the digest. Verified on the 2026-08-04
 * production snapshot: all 677 rows carried snake_case categories (the digest's
 * naming; the detectors use kebab-case) and every proposed_fix was NULL (the
 * digest never populates it). run-query-audit.ts had never been invoked in
 * production -- that was the gap this work exists to close. So labelling the
 * backfill 'daily-digest' is a measured fact, not an assumption.
 *
 * The column default is still 'legacy' rather than 'daily-digest': a writer
 * that forgets to set `source` should show up as unattributed, not silently
 * inherit the digest's identity.
 */
const BACKFILL_SOURCE = "daily-digest";

function parseArgs() {
  const argv = process.argv;
  const dbIndex = argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : process.env.QUERY_LOG_DB_PATH;
  if (!dbPath) {
    throw new Error("Pass --db <path> or set QUERY_LOG_DB_PATH. Refusing to guess which database to migrate.");
  }
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  return { dbPath, dryRun: argv.includes("--dry-run") };
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
}

function indexNames(db, table) {
  return new Set(db.prepare(`PRAGMA index_list(${table})`).all().map((row) => row.name));
}

function migrate({ dbPath, dryRun }) {
  const db = new Database(dbPath);
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name)
  );

  // The digest creates audit_findings lazily, so a database that has never had
  // a finding written simply has no table yet. Create it in its current shape
  // rather than failing -- that keeps the migration usable on fresh installs.
  if (!tables.has("audit_findings")) {
    console.log("audit_findings does not exist; creating it with provenance included.");
    if (!dryRun) {
      db.exec(`CREATE TABLE audit_findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        query_log_id INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        finding TEXT NOT NULL,
        proposed_fix TEXT,
        status TEXT DEFAULT 'open',
        source TEXT NOT NULL DEFAULT 'legacy'
      )`);
    }
  }

  const before = {
    columns: [...columnNames(db, "audit_findings")],
    indexes: [...indexNames(db, "audit_findings")],
    findings: db.prepare("SELECT COUNT(*) AS n FROM audit_findings").get().n,
  };
  console.log(`Before: ${before.findings} findings; source column ${before.columns.includes("source") ? "present" : "ABSENT"}`);

  const steps = [];
  const needsSourceColumn = !before.columns.includes("source");
  const needsNewIndex = !before.indexes.includes("idx_audit_findings_unique_v2");
  const hasOldIndex = before.indexes.includes("idx_audit_findings_unique");
  const needsRunsTable = !tables.has("audit_runs");

  if (needsSourceColumn) steps.push("ADD COLUMN audit_findings.source");
  if (needsSourceColumn) steps.push(`backfill ${before.findings} existing rows to source='${BACKFILL_SOURCE}'`);
  if (needsNewIndex) steps.push("CREATE UNIQUE INDEX idx_audit_findings_unique_v2 (query_log_id, category, source)");
  if (hasOldIndex) steps.push("DROP INDEX idx_audit_findings_unique");
  if (needsRunsTable) steps.push("CREATE TABLE audit_runs");

  if (steps.length === 0) {
    console.log("Already migrated; nothing to do.");
    db.close();
    return { migrated: false, steps: [] };
  }
  console.log("Planned steps:");
  for (const step of steps) console.log(`  - ${step}`);

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    db.close();
    return { migrated: false, steps };
  }

  const apply = db.transaction(() => {
    if (needsSourceColumn) {
      db.exec("ALTER TABLE audit_findings ADD COLUMN source TEXT NOT NULL DEFAULT 'legacy'");
      // One-time only: rows that existed before provenance was tracked.
      const updated = db.prepare("UPDATE audit_findings SET source = ? WHERE source = 'legacy'").run(BACKFILL_SOURCE);
      console.log(`  backfilled ${updated.changes} rows to source='${BACKFILL_SOURCE}'`);
    }
    // New index first: uniqueness must never lapse, even inside the transaction.
    if (needsNewIndex) {
      db.exec("CREATE UNIQUE INDEX idx_audit_findings_unique_v2 ON audit_findings (query_log_id, category, source)");
    }
    if (hasOldIndex) {
      db.exec("DROP INDEX idx_audit_findings_unique");
    }
    if (needsRunsTable) {
      db.exec(`CREATE TABLE audit_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        suite_version TEXT NOT NULL,
        started_ts INTEGER NOT NULL,
        finished_ts INTEGER,
        from_log_id INTEGER,
        to_log_id INTEGER,
        rows_audited INTEGER,
        findings_written INTEGER,
        status TEXT NOT NULL DEFAULT 'running',
        detail TEXT
      )`);
      db.exec("CREATE INDEX idx_audit_runs_watermark ON audit_runs (source, status, to_log_id)");
    }
  });
  apply();

  const after = {
    columns: [...columnNames(db, "audit_findings")],
    indexes: [...indexNames(db, "audit_findings")],
  };
  const bySource = db.prepare("SELECT source, COUNT(*) AS n FROM audit_findings GROUP BY source").all();

  // Codex's review flagged this explicitly: do not trust the new unique index
  // until every row actually carries a source.
  const unattributed = db.prepare("SELECT COUNT(*) AS n FROM audit_findings WHERE source IS NULL OR source = ''").get().n;
  if (unattributed > 0) throw new Error(`${unattributed} findings still have no source; aborting before anything depends on the new index.`);

  const integrity = db.pragma("integrity_check", { simple: true });
  db.close();

  console.log("\nAfter:");
  console.log(`  columns: ${after.columns.join(", ")}`);
  console.log(`  indexes: ${after.indexes.join(", ")}`);
  console.log(`  findings by source: ${bySource.map((row) => `${row.source}=${row.n}`).join(", ")}`);
  console.log(`  integrity_check: ${integrity}`);
  if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
  return { migrated: true, steps };
}

if (require.main === module) {
  try {
    migrate(parseArgs());
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { migrate, BACKFILL_SOURCE };
