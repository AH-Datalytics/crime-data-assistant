/**
 * Guards the seams in the auditor that can drift silently.
 *
 * Three of these test things that no type checker can catch:
 *   - scripts/daily-query-analysis.js runs under plain `node` and therefore
 *     cannot import lib/query-audit-detectors.ts. It keeps a hand-copied mirror
 *     of the detector list. Nothing but a test keeps the copy honest.
 *   - The two writers of audit_findings agree on provenance labels only by
 *     convention. A typo on either side silently splits the data.
 *   - A watermark that advances on a FAILED run would permanently skip rows.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { QUERY_AUDIT_DETECTORS, QUERY_AUDIT_SUITE_VERSION } from "../lib/query-audit-detectors";
import { resolveWindow, runQueryAudit } from "./run-query-audit";

const digestSource = fs.readFileSync(path.join(__dirname, "daily-query-analysis.js"), "utf8");
const migration = require("./migrate-audit-findings-source.js");

let failures = 0;
function check(name: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

function tempDb(): string {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "audit-prov-"));
  return path.join(dir, "query_log.db");
}

function seedDb(dbPath: string, rowCount: number): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE query_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, question TEXT, sql TEXT, rows INTEGER,
    error TEXT, ms INTEGER, response TEXT, tab TEXT, guardrails TEXT, model TEXT, session_id TEXT,
    query_contract TEXT
  )`);
  const insert = db.prepare("INSERT INTO query_log (ts, question, sql, rows, response, tab, guardrails) VALUES (?, ?, ?, ?, ?, ?, ?)");
  for (let i = 0; i < rowCount; i++) {
    insert.run(Date.now() - i * 1000, "murders in Chicago in 2023", "SELECT 1", 1, "There were 617 murders.", "nibrs", "");
  }
  db.close();
}

console.log("\n1. Digest's mirrored detector list matches lib/query-audit-detectors.ts");
{
  const match = /const PHASE1_DETECTORS = \[([\s\S]*?)\];/.exec(digestSource);
  check("digest declares PHASE1_DETECTORS", Boolean(match));
  if (match) {
    const pairs = [...match[1].matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => [m[1], m[2]]);
    const expected = QUERY_AUDIT_DETECTORS.map((detector) => [detector.id, detector.category]);
    check(
      `same count (${pairs.length} vs ${expected.length})`,
      pairs.length === expected.length,
      `digest=${pairs.length} lib=${expected.length}`
    );
    check(
      "same ids and categories in the same order",
      JSON.stringify(pairs) === JSON.stringify(expected),
      `digest=${JSON.stringify(pairs)} lib=${JSON.stringify(expected)}`
    );
  }
}

console.log("\n2. Provenance labels agree across both writers");
{
  const runnerSource = fs.readFileSync(path.join(__dirname, "run-query-audit.ts"), "utf8");
  const runnerLabel = /const SOURCE_ID = "([^"]+)"/.exec(runnerSource)?.[1];
  const digestDetectorLabel = /const DETECTOR_FINDING_SOURCE = "([^"]+)"/.exec(digestSource)?.[1];
  const digestOwnLabel = /const DIGEST_FINDING_SOURCE = "([^"]+)"/.exec(digestSource)?.[1];
  check("runner declares SOURCE_ID", runnerLabel === "phase1-detector", `got ${runnerLabel}`);
  check("digest agrees on the detector label", digestDetectorLabel === runnerLabel, `digest=${digestDetectorLabel} runner=${runnerLabel}`);
  check("digest's own label is distinct", digestOwnLabel === "daily-digest" && digestOwnLabel !== runnerLabel, `got ${digestOwnLabel}`);
  check("migration backfills to the digest's label", migration.BACKFILL_SOURCE === digestOwnLabel, `migration=${migration.BACKFILL_SOURCE}`);
}

console.log("\n3. Semantic families reference real detector categories");
{
  const block = /const SEMANTIC_FAMILIES = \[([\s\S]*?)\];/.exec(digestSource);
  check("digest declares SEMANTIC_FAMILIES", Boolean(block));
  if (block) {
    const detectorCategories = new Set(QUERY_AUDIT_DETECTORS.map((detector) => detector.category));
    const referenced = [...block[1].matchAll(/detector:\s*"([^"]+)"/g)].map((m) => m[1]);
    check("at least one family declared", referenced.length > 0);
    const unknown = referenced.filter((category) => !detectorCategories.has(category));
    check("every referenced detector category exists", unknown.length === 0, `unknown: ${unknown.join(", ")}`);
  }
}

console.log("\n4. Migration is idempotent and labels pre-existing rows correctly");
{
  const dbPath = tempDb();
  seedDb(dbPath, 3);
  // Pre-create the table in its OLD shape with a legacy digest finding present.
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE audit_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT, query_log_id INTEGER NOT NULL, ts INTEGER NOT NULL,
    severity TEXT NOT NULL, category TEXT NOT NULL, finding TEXT NOT NULL, proposed_fix TEXT,
    status TEXT DEFAULT 'open')`);
  db.exec("CREATE UNIQUE INDEX idx_audit_findings_unique ON audit_findings (query_log_id, category)");
  db.prepare("INSERT INTO audit_findings (query_log_id, ts, severity, category, finding) VALUES (1, 1, 'high', 'slow', 'x')").run();
  db.close();

  const first = migration.migrate({ dbPath, dryRun: false });
  const second = migration.migrate({ dbPath, dryRun: false });
  check("first run migrates", first.migrated === true);
  check("second run is a no-op", second.migrated === false && second.steps.length === 0, JSON.stringify(second.steps));

  const after = new Database(dbPath);
  const columns = after.prepare("PRAGMA table_info(audit_findings)").all().map((c: any) => c.name);
  const indexes = after.prepare("PRAGMA index_list(audit_findings)").all().map((i: any) => i.name);
  check("source column added", columns.includes("source"));
  check("3-column unique index present", indexes.includes("idx_audit_findings_unique_v2"));
  check("old 2-column unique index dropped", !indexes.includes("idx_audit_findings_unique"));
  const sources = after.prepare("SELECT DISTINCT source FROM audit_findings").all().map((r: any) => r.source);
  check("pre-existing row labelled daily-digest", JSON.stringify(sources) === JSON.stringify(["daily-digest"]), JSON.stringify(sources));
  const runsTable = after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='audit_runs'").get() as { n: number };
  check("audit_runs created", runsTable.n === 1);
  after.close();
}

console.log("\n5. Watermark ignores runs that did not succeed");
{
  const dbPath = tempDb();
  seedDb(dbPath, 10);
  migration.migrate({ dbPath, dryRun: false });
  const db = new Database(dbPath);
  const insertRun = db.prepare(
    "INSERT INTO audit_runs (source, suite_version, started_ts, from_log_id, to_log_id, status) VALUES ('phase1-detector', ?, 1, 0, ?, ?)"
  );
  insertRun.run(QUERY_AUDIT_SUITE_VERSION, 4, "ok");
  insertRun.run(QUERY_AUDIT_SUITE_VERSION, 9, "failed");
  insertRun.run(QUERY_AUDIT_SUITE_VERSION, 8, "running");

  const savedArgv = process.argv;
  process.argv = ["node", "test"]; // no flags -> watermark mode
  const window = resolveWindow(db);
  process.argv = savedArgv;
  check("resumes from the last OK run, not the failed one", window.fromId === 4, `fromId=${window.fromId}`);
  check("mode is watermark", window.mode === "watermark");

  // A different suite version must not inherit the old watermark.
  const savedArgv2 = process.argv;
  process.argv = ["node", "test"];
  db.prepare("UPDATE audit_runs SET suite_version = 'some-older-suite' WHERE status = 'ok'").run();
  const fresh = resolveWindow(db);
  process.argv = savedArgv2;
  check("a suite-version bump restarts from 0", fresh.fromId === 0, `fromId=${fresh.fromId}`);
  db.close();
}

console.log("\n6. Detectors needing reference data are reported INERT, never clean");
{
  const dbPath = tempDb();
  seedDb(dbPath, 5);
  migration.migrate({ dbPath, dryRun: false });

  const declared = QUERY_AUDIT_DETECTORS.filter((detector) => detector.requiresCanonicalValues).map((d) => d.id);
  check("at least one detector declares the dependency", declared.length > 0, `declared: ${declared.join(",")}`);

  const savedArgv = process.argv;
  const savedShr = process.env.SHR_DB_PATH;
  process.argv = ["node", "test", "--all"];
  // Point at a path that cannot yield canonical values.
  process.env.SHR_DB_PATH = path.join(path.dirname(dbPath), "definitely-absent.db");
  const result = runQueryAudit(dbPath);
  process.argv = savedArgv;
  if (savedShr === undefined) delete process.env.SHR_DB_PATH; else process.env.SHR_DB_PATH = savedShr;

  check(
    "runner reports them as inert",
    declared.every((id) => result.inert.includes(id)),
    `inert=${result.inert.join(",")} declared=${declared.join(",")}`
  );
  const db = new Database(dbPath);
  const detail = db.prepare("SELECT detail FROM audit_runs ORDER BY id DESC LIMIT 1").get() as { detail: string };
  db.close();
  check("inertness is recorded on the run row", /inert detectors/i.test(detail.detail || ""), `detail=${detail.detail}`);
}

console.log(`\n${failures === 0 ? "All audit provenance checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
