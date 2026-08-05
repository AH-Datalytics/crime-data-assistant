#!/usr/bin/env node
/**
 * In-place rollback of migrate-audit-findings-source.js.
 *
 * WHY THIS EXISTS RATHER THAN "restore the snapshot"
 * --------------------------------------------------
 * query_log.db takes live writes continuously -- every user query appends a row.
 * Restoring a pre-migration file copy would silently discard every query logged
 * between the snapshot and the rollback. So the snapshot is a LAST-RESORT
 * artifact for catastrophic corruption only; the ordinary undo path is this
 * forward migration.
 *
 * Order matters, and the reason is not obvious:
 *   1. Delete detector-sourced findings FIRST. The old unique index is
 *      (query_log_id, category) with no source. Detector and digest findings can
 *      coexist under the 3-column index but would collide under the 2-column one
 *      if they ever shared a category name. Detector findings are advisory and
 *      fully regenerable (`run-query-audit.ts --days 30`), so dropping them is
 *      cheap; losing a digest finding is not.
 *   2. Drop the 3-column index, then recreate the 2-column one.
 *   3. Drop the `source` column (SQLite 3.35+; it cannot be dropped while an
 *      index references it, hence the order).
 *   4. Leave audit_runs in place by default -- it is additive, inert to old code,
 *      and holds the run history. --drop-runs removes it if you want a clean slate.
 *
 * Usage:
 *   node scripts/rollback-audit-findings-source.js --db <path> [--dry-run] [--drop-runs]
 */

const Database = require("better-sqlite3");
const fs = require("node:fs");

const DETECTOR_SOURCE = "phase1-detector";

function parseArgs() {
  const argv = process.argv;
  const dbIndex = argv.indexOf("--db");
  const dbPath = dbIndex >= 0 ? argv[dbIndex + 1] : process.env.QUERY_LOG_DB_PATH;
  if (!dbPath) throw new Error("Pass --db <path> or set QUERY_LOG_DB_PATH.");
  if (!fs.existsSync(dbPath)) throw new Error(`Database not found: ${dbPath}`);
  return { dbPath, dryRun: argv.includes("--dry-run"), dropRuns: argv.includes("--drop-runs") };
}

function rollback({ dbPath, dryRun, dropRuns }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");

  const columns = new Set(db.prepare("PRAGMA table_info(audit_findings)").all().map((c) => c.name));
  if (!columns.has("source")) {
    console.log("audit_findings has no `source` column; nothing to roll back.");
    db.close();
    return { rolledBack: false };
  }

  const detectorRows = db.prepare("SELECT COUNT(*) AS n FROM audit_findings WHERE source = ?").get(DETECTOR_SOURCE).n;
  const otherRows = db.prepare("SELECT COUNT(*) AS n FROM audit_findings WHERE source != ?").get(DETECTOR_SOURCE).n;
  console.log(`Will delete ${detectorRows} detector findings; ${otherRows} digest findings will be preserved.`);

  // Refuse to proceed if collapsing to the 2-column key would silently lose a
  // preserved row. Better to stop than to drop a digest finding.
  const collisions = db.prepare(
    `SELECT COUNT(*) AS n FROM (
       SELECT query_log_id, category FROM audit_findings WHERE source != ?
       GROUP BY query_log_id, category HAVING COUNT(*) > 1)`
  ).get(DETECTOR_SOURCE).n;
  if (collisions > 0) {
    db.close();
    throw new Error(`${collisions} preserved (query_log_id, category) pairs are duplicated across sources; the 2-column unique index cannot be restored without data loss. Resolve manually.`);
  }

  if (dryRun) {
    console.log("--dry-run: no changes written.");
    db.close();
    return { rolledBack: false };
  }

  db.transaction(() => {
    db.prepare("DELETE FROM audit_findings WHERE source = ?").run(DETECTOR_SOURCE);
    db.exec("DROP INDEX IF EXISTS idx_audit_findings_unique_v2");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_findings_unique ON audit_findings (query_log_id, category)");
    db.exec("ALTER TABLE audit_findings DROP COLUMN source");
    if (dropRuns) db.exec("DROP TABLE IF EXISTS audit_runs");
  })();

  const after = {
    columns: db.prepare("PRAGMA table_info(audit_findings)").all().map((c) => c.name),
    indexes: db.prepare("PRAGMA index_list(audit_findings)").all().map((i) => i.name),
    findings: db.prepare("SELECT COUNT(*) AS n FROM audit_findings").get().n,
  };
  const integrity = db.pragma("integrity_check", { simple: true });
  db.close();

  console.log(`After: columns ${after.columns.join(", ")}`);
  console.log(`       indexes ${after.indexes.join(", ")}`);
  console.log(`       ${after.findings} findings remain; integrity_check: ${integrity}`);
  if (integrity !== "ok") throw new Error(`integrity_check returned "${integrity}"`);
  return { rolledBack: true, deleted: detectorRows, preserved: otherRows };
}

if (require.main === module) {
  try {
    rollback(parseArgs());
  } catch (error) {
    console.error(`Rollback failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { rollback };
