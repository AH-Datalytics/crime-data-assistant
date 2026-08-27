import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import {
  COMPONENT_TABLES,
  CURRENT_TRENDS_CAPABILITIES,
  classifyCurrentTrendsAbsence,
  currentTrendsReadiness,
} from "../lib/current-trends-readiness";

let passed = 0;
const check = (name: string, run: () => void): void => { run(); passed += 1; console.log(`PASS ${name}`); };
const digest = createHash("sha256").update("fixture source").digest("hex");

function fixture(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE agency_monthly (ori TEXT, year INTEGER);
    CREATE TABLE agencies (ori TEXT);
    CREATE TABLE sample_agencies (ori TEXT);
    CREATE TABLE national_monthly (year INTEGER);
    CREATE TABLE state_monthly (state TEXT);
    CREATE TABLE agency_population (ori TEXT, year INTEGER);
    CREATE TABLE agency_county_crosswalk (ori TEXT);
    INSERT INTO agency_monthly VALUES ('A', 2025);
    INSERT INTO agencies VALUES ('A');
    INSERT INTO sample_agencies VALUES ('A');
    INSERT INTO national_monthly VALUES (2025);
    INSERT INTO state_monthly VALUES ('AA');
    INSERT INTO agency_population VALUES ('A', 2025);
    INSERT INTO agency_county_crosswalk VALUES ('A');
  `);
  return db;
}

function addReceipt(db: Database.Database, component: string, counts: Record<string, number>, overrides: Record<string, unknown> = {}): void {
  db.exec(`CREATE TABLE IF NOT EXISTS source_build_receipts (
    component TEXT PRIMARY KEY, source_version TEXT NOT NULL, source_sha256 TEXT NOT NULL,
    source_rows INTEGER NOT NULL, expected_rows INTEGER NOT NULL, actual_rows INTEGER NOT NULL,
    excluded_rows INTEGER NOT NULL, table_counts_json TEXT NOT NULL, status TEXT NOT NULL
  )`);
  const row = {
    component, source_version: "2026-08", source_sha256: digest, source_rows: 1,
    expected_rows: 1, actual_rows: 1, excluded_rows: 0,
    table_counts_json: JSON.stringify(counts), status: "complete", ...overrides,
  };
  db.prepare(`INSERT OR REPLACE INTO source_build_receipts VALUES
    (@component,@source_version,@source_sha256,@source_rows,@expected_rows,@actual_rows,@excluded_rows,@table_counts_json,@status)`).run(row);
}

const monthlyCounts = { agency_monthly: 1, agencies: 1, sample_agencies: 1, national_monthly: 1, state_monthly: 1 };

check("a legacy database is unknown, not silently healthy", () => {
  const db = fixture();
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage).state, "unknown");
  assert.equal(classifyCurrentTrendsAbsence(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage, 0).state, "unknown");
  db.close();
});

check("a reconciled monthly receipt makes the four non-rate capabilities ready", () => {
  const db = fixture();
  addReceipt(db, "current_trends_monthly", monthlyCounts);
  for (const id of [
    CURRENT_TRENDS_CAPABILITIES.agencyDirectory,
    CURRENT_TRENDS_CAPABILITIES.stateDirectory,
    CURRENT_TRENDS_CAPABILITIES.yearCoverage,
    CURRENT_TRENDS_CAPABILITIES.nationalSweep,
  ]) assert.equal(currentTrendsReadiness(db, id).state, "ready");
  db.close();
});

check("county and rate capabilities require their additional receipts", () => {
  const db = fixture();
  addReceipt(db, "current_trends_monthly", monthlyCounts);
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.countyDirectory).state, "unknown");
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.agencyCountsAndRates).state, "unknown");
  addReceipt(db, "current_trends_crosswalk", { agency_county_crosswalk: 1 });
  addReceipt(db, "current_trends_population", { agency_population: 1 });
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.countyDirectory).state, "ready");
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.agencyCountsAndRates).state, "ready");
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.stateCountsAndRates).state, "ready");
  db.close();
});

check("receipt reconciliation detects our table loss", () => {
  const db = fixture();
  addReceipt(db, "current_trends_monthly", monthlyCounts);
  db.exec("DELETE FROM agency_monthly");
  const result = currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage);
  assert.equal(result.state, "local_failure");
  assert.match(result.reason, /now has 0 rows/);
  db.close();
});

check("expected-versus-actual mismatch is our failure", () => {
  const db = fixture();
  addReceipt(db, "current_trends_monthly", monthlyCounts, { expected_rows: 2 });
  assert.equal(currentTrendsReadiness(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage).state, "local_failure");
  db.close();
});

check("zero means source absence only after reconciliation", () => {
  const db = fixture();
  addReceipt(db, "current_trends_monthly", monthlyCounts);
  assert.equal(classifyCurrentTrendsAbsence(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage, 0).state, "not_in_source_snapshot");
  assert.equal(classifyCurrentTrendsAbsence(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage, 3).state, "present");
  db.close();
});

check("unknown capability and invalid observation never become absence", () => {
  const db = fixture();
  assert.equal(currentTrendsReadiness(db, "crime_data::not-current").state, "unknown");
  assert.equal(classifyCurrentTrendsAbsence(db, CURRENT_TRENDS_CAPABILITIES.yearCoverage, -1).state, "unknown");
  db.close();
});

// The component-table map has two homes -- this module and scripts/current_trends_build_receipt.py.
// The Python side decides what a receipt RECORDS; this side decides what it is CHECKED against, so a
// table added to one and not the other either goes unenforced or fails every reconciliation. Parsing
// the Python binds them to each other; a third hand-written copy here would drift the same way.
check("the component-table map matches its Python source of truth", () => {
  const python = readFileSync(new URL("./current_trends_build_receipt.py", import.meta.url), "utf8");
  const block = python.slice(python.indexOf("COMPONENT_TABLES = {"));
  const parsed: Record<string, string[]> = {};
  for (const entry of block.slice(0, block.indexOf("\n}")).matchAll(/"(current_trends_\w+)":\s*\(([^)]*)\)/g)) {
    parsed[entry[1]] = [...entry[2].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  }
  assert.ok(Object.keys(parsed).length > 0, "could not parse COMPONENT_TABLES from the Python module");
  for (const [component, tables] of Object.entries(parsed)) {
    const here = COMPONENT_TABLES[component as keyof typeof COMPONENT_TABLES];
    assert.ok(here, `${component} is declared in Python but not in current-trends-readiness.ts`);
    assert.deepEqual([...here].sort(), [...tables].sort(), `${component} tables differ between the two homes`);
  }
  assert.deepEqual(
    Object.keys(COMPONENT_TABLES).sort(), Object.keys(parsed).sort(),
    "the two homes declare different components",
  );
});

console.log(`current trends readiness: ${passed}/8 passed`);
