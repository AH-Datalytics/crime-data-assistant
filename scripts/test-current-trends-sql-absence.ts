import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { classifyCurrentTrendsSqlAbsence } from "../lib/current-trends-sql-absence";

const digest = createHash("sha256").update("fixture source").digest("hex");
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agency_monthly (ori TEXT);
  CREATE TABLE agencies (ori TEXT);
  CREATE TABLE sample_agencies (ori TEXT);
  CREATE TABLE national_monthly (year INTEGER);
  CREATE TABLE state_monthly (state TEXT);
  CREATE TABLE agency_population (ori TEXT);
  CREATE TABLE agency_county_crosswalk (ori TEXT);
  INSERT INTO agency_monthly VALUES ('A');
  INSERT INTO agencies VALUES ('A');
  INSERT INTO sample_agencies VALUES ('A');
  INSERT INTO national_monthly VALUES (2025);
  INSERT INTO state_monthly VALUES ('AA');
  INSERT INTO agency_population VALUES ('A');
  INSERT INTO agency_county_crosswalk VALUES ('A');
  CREATE TABLE source_build_receipts (
    component TEXT PRIMARY KEY, source_version TEXT, source_sha256 TEXT,
    source_rows INTEGER, expected_rows INTEGER, actual_rows INTEGER, excluded_rows INTEGER,
    table_counts_json TEXT, status TEXT
  );
`);
const insert = db.prepare("INSERT INTO source_build_receipts VALUES (?,?,?,?,?,?,?,?,?)");
function receipt(component: string, counts: Record<string, number>): void {
  insert.run(component, "2025-01", digest, 1, 1, 1, 0, JSON.stringify(counts), "complete");
}
receipt("current_trends_monthly", { agency_monthly: 1, agencies: 1, sample_agencies: 1, national_monthly: 1, state_monthly: 1 });

assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly WHERE ori='Z'", 0).state,
  "not_in_source_snapshot",
);
console.log("PASS monthly absence requires and accepts the monthly receipt");

assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly JOIN agency_population USING(ori) WHERE ori='Z'", 0).state,
  "unknown",
);
console.log("PASS a rate query cannot borrow the monthly receipt for population");

receipt("current_trends_population", { agency_population: 1 });
assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly JOIN agency_population USING(ori) WHERE ori='Z'", 0).state,
  "not_in_source_snapshot",
);
console.log("PASS rate absence requires both monthly and population receipts");

assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly JOIN agency_county_crosswalk USING(ori) WHERE county_fips='0'", 0).state,
  "unknown",
);
receipt("current_trends_crosswalk", { agency_county_crosswalk: 1 });
assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly JOIN agency_county_crosswalk USING(ori) WHERE county_fips='0'", 0).state,
  "not_in_source_snapshot",
);
console.log("PASS county absence requires both monthly and crosswalk receipts");

db.exec("INSERT INTO agency_monthly VALUES ('B')");
assert.equal(
  classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly WHERE ori='Z'", 0).state,
  "local_failure",
);
console.log("PASS post-receipt drift cannot be described as source absence");

assert.equal(classifyCurrentTrendsSqlAbsence(db, "SELECT 1", 0).state, "unknown");
assert.equal(classifyCurrentTrendsSqlAbsence(db, "SELECT * FROM agency_monthly", 2).state, "present");
console.log("PASS unrecognized SQL and nonempty results cannot become absence");

db.close();
console.log("current trends SQL absence: 5/5 passed");
