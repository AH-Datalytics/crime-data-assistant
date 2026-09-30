import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { CURRENT_TRENDS_CAPABILITIES } from "../lib/current-trends-readiness";
import { evaluateCapability } from "../lib/source-health";
import { specFor } from "../lib/source-health-inventory";

const digest = createHash("sha256").update("fixture source").digest("hex");
const spec = specFor(CURRENT_TRENDS_CAPABILITIES.yearCoverage);
assert.ok(spec);

function fixture(receipt: boolean): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agency_monthly (ori TEXT, year INTEGER);
    CREATE TABLE agencies (ori TEXT);
    CREATE TABLE sample_agencies (ori TEXT);
    CREATE TABLE national_monthly (year INTEGER);
    CREATE TABLE state_monthly (state TEXT);
    INSERT INTO agency_monthly VALUES ('A', 2025);
    INSERT INTO agencies VALUES ('A');
    INSERT INTO sample_agencies VALUES ('A');
    INSERT INTO national_monthly VALUES (2025);
    INSERT INTO state_monthly VALUES ('AA');
  `);
  if (receipt) {
    db.exec(`CREATE TABLE source_build_receipts (
      component TEXT PRIMARY KEY, source_version TEXT NOT NULL, source_sha256 TEXT NOT NULL,
      source_rows INTEGER NOT NULL, expected_rows INTEGER NOT NULL, actual_rows INTEGER NOT NULL,
      excluded_rows INTEGER NOT NULL, table_counts_json TEXT NOT NULL, status TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO source_build_receipts VALUES (?,?,?,?,?,?,?,?,?)").run(
      "current_trends_monthly", "2025-01", digest, 1, 1, 1, 0,
      JSON.stringify({ agency_monthly: 1, agencies: 1, sample_agencies: 1, national_monthly: 1, state_monthly: 1 }),
      "complete",
    );
  }
  return db;
}

function evaluate(db: Database.Database) {
  return evaluateCapability(spec!, {
    sourceId: "current",
    requestedYears: [2025],
    dbOverride: { db, resolvedPath: db.name },
  });
}

{
  const db = fixture(false);
  const result = evaluate(db);
  assert.equal(result.trace.boundary, "missing_receipt");
  assert.equal(result.health.state, "unknown");
  db.close();
  console.log("PASS source health stops Current Trends at a missing receipt");
}

{
  const db = fixture(true);
  db.exec("INSERT INTO agency_monthly VALUES ('B', 2025)");
  const result = evaluate(db);
  assert.equal(result.trace.boundary, "receipt_mismatch");
  assert.equal(result.health.state, "degraded");
  db.close();
  console.log("PASS source health reports post-receipt drift as a local failure");
}

{
  const db = fixture(true);
  const result = evaluate(db);
  assert.equal(result.trace.boundary, "policy_incomplete");
  assert.equal(result.health.state, "unknown");
  db.close();
  console.log("PASS a reconciled receipt reaches the next safety gate without authorizing");
}

console.log("current trends source-health integration: 3/3 passed");
