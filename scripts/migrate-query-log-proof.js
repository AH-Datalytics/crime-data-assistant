#!/usr/bin/env node
/**
 * Stage 1: add the verified-answer-only proof columns to query_log.
 *
 * Contract: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §9.1 Stage 1 ("additive query-log migration(s) for digest/proof JSON,
 * delivery_action, schema versions, and any required indexes") and §6.3
 * (delivery_action gets its own indexed column because operational and product
 * analysis will group by it; the full decision stays in the JSON).
 *
 * Columns, all nullable, no backfill, no table rewrite:
 *
 *   delivery_action       TEXT     terminal action: answer | answer_limited_scope
 *                                  | clarify | decline_capability | decline_data
 *                                  | decline_source_health. Indexed.
 *   proof_manifest        TEXT     JSON ProofManifest (lib/proof-contract.ts §6.1)
 *   result_digest         TEXT     JSON ResultDigest (lib/result-digest.ts §6.2)
 *   proof_schema_version  INTEGER  bumped when either JSON shape changes
 *   proof_mode            TEXT     off | shadow | enforce, as resolved at write time
 *   plan_family           TEXT     typed plan family, for per-family rollout accounting
 *
 * WHY plan_family AND proof_mode ARE COLUMNS RATHER THAN JSON FIELDS. Both are
 * also inside the manifest, which looks redundant. They are promoted because the
 * Stage 4 enforcement decision is made per source x family and the shadow review
 * has to answer "which families are ready?" and "was this row observed under
 * shadow or enforce?" over hundreds of thousands of rows. Handoff §10 makes those
 * queries a gate on enabling enforcement; json_extract() over an unindexed TEXT
 * blob is the wrong tool for a gate.
 *
 * Safety:
 *   - Additive only. Old rows keep NULL; nothing is rewritten.
 *   - Idempotent. Re-running is a no-op, including partially-applied states: each
 *     column and the index are checked and added independently, so a migration
 *     interrupted between two ALTERs completes correctly on the next run.
 *   - Deploy-order free in both directions. logQuery/logNibrsQuery detect every
 *     column at runtime (PRAGMA table_info) and only write what exists, so the
 *     baseline release c2b52ca runs against a migrated database and a migrated
 *     release runs against an unmigrated database.
 *   - Revertible. --rollback drops the index BEFORE the column, because SQLite
 *     refuses to DROP COLUMN while an index references it.
 *
 * Usage:
 *   node scripts/migrate-query-log-proof.js --db <path> [--dry-run] [--rollback]
 *
 * PRODUCTION EXECUTION IS A SEPARATE APPROVAL. Back up query_log.db first, per
 * docs/runbooks/2026-08-11-rollback-and-backup-manifest.md §3.
 */

const Database = require("better-sqlite3");
const fs = require("node:fs");

/**
 * Column definitions in application order.
 *
 * Order matters only for readable PRAGMA output; correctness does not depend on
 * it, because each column is added independently.
 */
const COLUMNS = [
  // Outcome layer (P2.1 §4.1). Extending this array rather than authoring a second migration is
  // deliberate: one projector pair writes these columns, and two scripts would create two owners
  // of "which outcome columns exist". The script is already per-column idempotent, so the added
  // entries are safe against a database where the others already exist.
  //
  // TEXT, not integers: the values are read by humans in the digest email and in ad-hoc SQL, and
  // an integer would need a lookup table that can drift from the vocabulary.
  //
  // No CHECK constraint, deliberately. SQLite permits one on ADD COLUMN, but a rejected value
  // fails the whole INSERT and both loggers swallow insert failures — so an out-of-vocabulary
  // value would silently destroy the entire log row. Losing the row loses strictly more than
  // losing the outcome. The closed sets are unrepresentable in TypeScript instead, and an escaped
  // value degrades these columns to NULL, which surfaces as a coverage violation.
  //
  // No index on either. The queries that would use them are ts-range plus equality, or a full
  // GROUP BY; a single-column partial index on a low-cardinality column is chosen for neither.
  { name: "record_kind", type: "TEXT" },
  { name: "reason_code", type: "TEXT" },
  { name: "delivery_action", type: "TEXT" },
  { name: "proof_manifest", type: "TEXT" },
  { name: "result_digest", type: "TEXT" },
  { name: "proof_schema_version", type: "INTEGER" },
  { name: "proof_mode", type: "TEXT" },
  { name: "plan_family", type: "TEXT" },
];

const INDEX_NAME = "idx_query_log_delivery_action";
// Partial index: the overwhelming majority of historical rows have no delivery
// action and never will. Indexing them would cost space to store a single
// repeated NULL. Matches the existing idx_query_log_request_id precedent.
const INDEX_SQL =
  `CREATE INDEX ${INDEX_NAME} ON query_log(delivery_action) WHERE delivery_action IS NOT NULL`;

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

function hasIndex(db, name) {
  return db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name) !== undefined;
}

function migrate({ dbPath, dryRun, rollback }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");

  try {
    const existing = new Set(tableColumns(db, "query_log"));
    const missing = COLUMNS.filter((column) => !existing.has(column.name));
    const indexPresent = hasIndex(db, INDEX_NAME);

    if (rollback) {
      const present = COLUMNS.filter((column) => existing.has(column.name));
      if (present.length === 0 && !indexPresent) {
        console.log("No proof columns present; nothing to roll back.");
        return { changed: false, columnsChanged: [], indexChanged: false };
      }
      for (const column of present) {
        const populated = db
          .prepare(`SELECT COUNT(*) AS n FROM query_log WHERE ${column.name} IS NOT NULL`)
          .get().n;
        console.log(`Rolling back: dropping ${column.name} (${populated} rows currently populated).`);
      }
      if (dryRun) {
        console.log("--dry-run: no changes written.");
        return { changed: false, columnsChanged: [], indexChanged: false };
      }
      // Index first: SQLite refuses to DROP COLUMN while an index references it.
      if (indexPresent) db.exec(`DROP INDEX ${INDEX_NAME}`);
      for (const column of present) {
        db.exec(`ALTER TABLE query_log DROP COLUMN ${column.name}`);
      }
      const integrity = db.pragma("integrity_check", { simple: true });
      console.log(`  dropped ${present.length} column(s). integrity_check: ${integrity}`);
      if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
      return {
        changed: true,
        columnsChanged: present.map((column) => column.name),
        indexChanged: indexPresent,
      };
    }

    if (missing.length === 0 && indexPresent) {
      const populated = db
        .prepare("SELECT COUNT(*) AS n FROM query_log WHERE delivery_action IS NOT NULL")
        .get().n;
      console.log(`All proof columns already present (${populated} rows with a delivery_action); nothing to do.`);
      return { changed: false, columnsChanged: [], indexChanged: false };
    }

    for (const column of missing) {
      console.log(`Planned: ALTER TABLE query_log ADD COLUMN ${column.name} ${column.type}`);
    }
    if (!indexPresent) console.log(`Planned: ${INDEX_SQL}`);
    if (dryRun) {
      console.log("--dry-run: no changes written.");
      return { changed: false, columnsChanged: [], indexChanged: false };
    }

    const rowsBefore = db.prepare("SELECT COUNT(*) AS n FROM query_log").get().n;

    for (const column of missing) {
      db.exec(`ALTER TABLE query_log ADD COLUMN ${column.name} ${column.type}`);
    }
    // Created after the column exists, and only once the column is guaranteed
    // present -- an index on a partially-applied migration would fail the whole run.
    if (!hasIndex(db, INDEX_NAME)) db.exec(INDEX_SQL);

    const after = new Set(tableColumns(db, "query_log"));
    const stillMissing = COLUMNS.filter((column) => !after.has(column.name));
    const integrity = db.pragma("integrity_check", { simple: true });
    const rowsAfter = db.prepare("SELECT COUNT(*) AS n FROM query_log").get().n;

    console.log(`  columns added: ${missing.map((column) => column.name).join(", ") || "(none)"}`);
    console.log(`  ${INDEX_NAME} present: ${hasIndex(db, INDEX_NAME)}`);
    console.log(`  query_log rows preserved: ${rowsBefore} -> ${rowsAfter}`);
    console.log(`  integrity_check: ${integrity}`);

    if (stillMissing.length > 0) {
      throw new Error(`columns were not added: ${stillMissing.map((c) => c.name).join(", ")}`);
    }
    if (!hasIndex(db, INDEX_NAME)) throw new Error(`${INDEX_NAME} was not created`);
    if (rowsAfter !== rowsBefore) throw new Error(`row count changed: ${rowsBefore} -> ${rowsAfter}`);
    if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);

    return {
      changed: true,
      columnsChanged: missing.map((column) => column.name),
      indexChanged: true,
    };
  } finally {
    // Closed in a finally so a thrown assertion above cannot leak the handle and
    // leave the database locked for the next attempt.
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

module.exports = { migrate, COLUMNS, INDEX_NAME };
