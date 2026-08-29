#!/usr/bin/env node
/**
 * Bring shared_charts under the proof contract (handoff §4, §9.1 Stage 1).
 *
 * A shared chart is a factual surface that re-executes stored SQL on every view,
 * indefinitely, with no link back to the answer it came from. Handoff §4 names it
 * explicitly: "newly created embeds require a valid originating proof, and embed reads
 * require current source health plus result/chart proof. Legacy embeds without
 * adequate proof must not be silently treated as compliant."
 *
 * You cannot check an originating proof at read time unless it was recorded at
 * creation time, which is what these columns are for.
 *
 *   origin_request_id          links to query_log.request_id -- the same join key the
 *                              chart auditor already uses
 *   origin_delivery_action     the terminal action of the answer this chart came from
 *   origin_proof_mode          off | shadow | enforce, as resolved when it was created
 *   origin_state               verified | bound_unproven | unbound | absent -- the
 *                              verdict from lib/embed-origin, reached at creation when
 *                              the artifact and the logged answer were both in hand
 *   last_read_delivery_action  what the most recent read would have delivered
 *   last_read_at               when that read happened
 *
 * WHY A LAST-READ SUMMARY RATHER THAN A ROW PER READ. Embed reads are responses and
 * belong in the evidence record, but writing them to query_log would add a new `tab`
 * value, and scripts/daily-query-analysis.js groups by tab with no allowlist -- so
 * every read would land in the reviewer's digest as a new category and shift the
 * counts the auditor reports. The Stage 1 boundary is that existing query logging and
 * the digest keep working unchanged. One rolling summary per chart answers the
 * question a reviewer actually has ("which shared charts are serving unproven
 * results?") without touching either.
 *
 * Safety: additive, nullable, no backfill, no index, idempotent including
 * partially-applied states, revertible. Old code ignores the columns; new code detects
 * them at runtime, so deploy order is free in both directions.
 *
 * Usage:
 *   node scripts/migrate-shared-charts-proof.js --db <path> [--dry-run] [--rollback]
 *
 * PRODUCTION EXECUTION IS A SEPARATE APPROVAL. Back up query_log.db first, per
 * docs/runbooks/2026-08-11-rollback-and-backup-manifest.md §3.
 */

const Database = require("better-sqlite3");
const fs = require("node:fs");

const COLUMNS = [
  { name: "origin_request_id", type: "TEXT" },
  { name: "origin_delivery_action", type: "TEXT" },
  { name: "origin_proof_mode", type: "TEXT" },
  { name: "origin_state", type: "TEXT" },
  { name: "last_read_delivery_action", type: "TEXT" },
  // Paired with the action above and written in the SAME statement (P2.1 §4.3.3). An action
  // stored without its reason is exactly the "two carriers for one fact" defect, and a latest
  // summary carrying an action from one path and a reason from another must not pass.
  //
  // Additive and NOT backfilled, so every chart read before activation keeps a NULL reason while
  // already having an action and a last_read_at. That is why the validity query is bounded by
  // `last_read_at >= :activation_ts`: an unbounded non-NULL check would turn the whole existing
  // population into violations the moment the column was added.
  { name: "last_read_reason_code", type: "TEXT" },
  { name: "last_read_at", type: "INTEGER" },
];

function parseArgs() {
  const argv = process.argv;
  const dbIndex = argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : process.env.QUERY_LOG_DB_PATH;
  if (!dbPath) throw new Error("Pass --db <path> or set QUERY_LOG_DB_PATH.");
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  return { dbPath, dryRun: argv.includes("--dry-run"), rollback: argv.includes("--rollback") };
}

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

function tableExists(db, table) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined;
}

function migrate({ dbPath, dryRun, rollback }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");

  try {
    if (!tableExists(db, "shared_charts")) {
      // Not an error: a database that has never served an embed has no such table,
      // and getWriteDb() creates it with these columns already present.
      console.log("shared_charts does not exist; nothing to migrate.");
      return { changed: false, columnsChanged: [] };
    }

    const existing = new Set(tableColumns(db, "shared_charts"));

    if (rollback) {
      const present = COLUMNS.filter((column) => existing.has(column.name));
      if (present.length === 0) {
        console.log("No proof columns present on shared_charts; nothing to roll back.");
        return { changed: false, columnsChanged: [] };
      }
      for (const column of present) {
        const populated = db
          .prepare(`SELECT COUNT(*) AS n FROM shared_charts WHERE ${column.name} IS NOT NULL`)
          .get().n;
        console.log(`Rolling back: dropping ${column.name} (${populated} rows currently populated).`);
      }
      if (dryRun) {
        console.log("--dry-run: no changes written.");
        return { changed: false, columnsChanged: [] };
      }
      for (const column of present) {
        db.exec(`ALTER TABLE shared_charts DROP COLUMN ${column.name}`);
      }
      const integrity = db.pragma("integrity_check", { simple: true });
      console.log(`  dropped ${present.length} column(s). integrity_check: ${integrity}`);
      if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
      return { changed: true, columnsChanged: present.map((column) => column.name) };
    }

    const missing = COLUMNS.filter((column) => !existing.has(column.name));
    if (missing.length === 0) {
      const total = db.prepare("SELECT COUNT(*) AS n FROM shared_charts").get().n;
      const unproved = db
        .prepare("SELECT COUNT(*) AS n FROM shared_charts WHERE origin_request_id IS NULL")
        .get().n;
      console.log(`All proof columns already present (${unproved} of ${total} charts have no origin proof).`);
      return { changed: false, columnsChanged: [] };
    }

    for (const column of missing) {
      console.log(`Planned: ALTER TABLE shared_charts ADD COLUMN ${column.name} ${column.type}`);
    }
    if (dryRun) {
      console.log("--dry-run: no changes written.");
      return { changed: false, columnsChanged: [] };
    }

    const rowsBefore = db.prepare("SELECT COUNT(*) AS n FROM shared_charts").get().n;
    for (const column of missing) {
      db.exec(`ALTER TABLE shared_charts ADD COLUMN ${column.name} ${column.type}`);
    }

    const after = new Set(tableColumns(db, "shared_charts"));
    const stillMissing = COLUMNS.filter((column) => !after.has(column.name));
    const integrity = db.pragma("integrity_check", { simple: true });
    const rowsAfter = db.prepare("SELECT COUNT(*) AS n FROM shared_charts").get().n;

    console.log(`  columns added: ${missing.map((column) => column.name).join(", ")}`);
    console.log(`  shared_charts rows preserved: ${rowsBefore} -> ${rowsAfter}`);
    console.log(`  integrity_check: ${integrity}`);
    console.log(`  NOTE: every pre-existing chart now has a NULL origin proof. That is`);
    console.log(`  correct -- they were created before proof existed and must be treated`);
    console.log(`  as legacy unproved, not backfilled into looking compliant.`);

    if (stillMissing.length > 0) {
      throw new Error(`columns were not added: ${stillMissing.map((c) => c.name).join(", ")}`);
    }
    if (rowsAfter !== rowsBefore) throw new Error(`row count changed: ${rowsBefore} -> ${rowsAfter}`);
    if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);

    return { changed: true, columnsChanged: missing.map((column) => column.name) };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    migrate(parseArgs());
  } catch (error) {
    console.error(`Migration failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { migrate, COLUMNS };
