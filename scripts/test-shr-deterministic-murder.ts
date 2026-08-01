import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { agencySearchKey } from "../lib/shr-agency-normalization";
import { buildShrMurderPlan } from "../lib/shr-deterministic-murder";
import { validateQueryContractSql } from "../lib/query-contract-validator";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE shr_agency_identity (
    ori TEXT PRIMARY KEY, state TEXT, canonical_agency TEXT, agency_type TEXT,
    first_year INTEGER, last_year INTEGER, incident_count INTEGER,
    source_agency_names TEXT
  );
  CREATE TABLE shr_agency_alias (
    alias_key TEXT, ori TEXT, state TEXT, canonical_agency TEXT, agency_type TEXT
  );
  CREATE TABLE incidents (
    id INTEGER PRIMARY KEY, ori TEXT, year INTEGER, month INTEGER,
    homicide_type TEXT, agency TEXT
  );
  CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER);
`);

function addAgency(ori: string, state: string, name: string): void {
  db.prepare("INSERT INTO shr_agency_identity VALUES (?, ?, ?, 'City', 1976, 2024, 100, ?)")
    .run(ori, state, name, name);
  db.prepare("INSERT INTO shr_agency_alias VALUES (?, ?, ?, ?, 'City')")
    .run(agencySearchKey(name), ori, state, name);
}

addAgency("MDBALT", "MD", "Baltimore");
addAgency("CALAX", "CA", "Los Angeles");
addAgency("NYNYC", "NY", "New York");
addAgency("CAOAK", "CA", "Oakland");
addAgency("DCWAS", "DC", "Washington");
addAgency("TXHOU", "TX", "Houston");

const incident = db.prepare("INSERT INTO incidents (ori, year, month, homicide_type, agency) VALUES (?, 2021, ?, 'Murder', ?)");
const victim = db.prepare("INSERT INTO victims (incident_id) VALUES (?)");
function addMurder(ori: string, month: number, agency: string, victims: number): void {
  const id = Number(incident.run(ori, month, agency).lastInsertRowid);
  for (let index = 0; index < victims; index += 1) victim.run(id);
}

addMurder("MDBALT", 1, "Baltimore", 1);
addMurder("CALAX", 2, "Los Angeles", 1);
addMurder("NYNYC", 3, "New York", 1);
addMurder("CAOAK", 1, "Oakland", 2);
addMurder("CAOAK", 8, "Oakland", 1);
addMurder("DCWAS", 7, "Washington", 1);

const comparison = buildShrMurderPlan(
  "Murders through July in 2021 in Baltimore city, Los Angeles, California, NYC, Oakland, and DC",
  db,
);
assert.equal(comparison?.kind, "query");
if (!comparison || comparison.kind !== "query") throw new Error("comparison plan missing");
assert.doesNotMatch(comparison.sql, /alias_key|LIKE/i);
const comparisonContract = validateQueryContractSql({
  question: "Murders through July in 2021 in Baltimore city, Los Angeles, California, NYC, Oakland, and DC",
  source: "shr",
  sql: comparison.sql,
});
assert.deepEqual(comparisonContract.blockReasons, []);
assert.deepEqual(comparisonContract.enforced, []);
const comparisonRows = db.prepare(comparison.sql).all() as { city: string; murder_victims: number }[];
assert.equal(comparisonRows.length, 5);
assert.deepEqual(Object.fromEntries(comparisonRows.map((row) => [row.city, row.murder_victims])), {
  "Baltimore, MD": 1,
  "Los Angeles, CA": 1,
  "New York City, NY": 1,
  "Oakland, CA": 2,
  "Washington, DC": 1,
});

const monthly = buildShrMurderPlan("murders per month in 2021 in Oakland", db);
assert.equal(monthly?.kind, "query");
if (!monthly || monthly.kind !== "query") throw new Error("monthly plan missing");
const monthlyContract = validateQueryContractSql({
  question: "murders per month in 2021 in Oakland", source: "shr", sql: monthly.sql,
});
assert.deepEqual(monthlyContract.blockReasons, []);
assert.deepEqual(monthlyContract.enforced, []);
const monthlyRows = db.prepare(monthly.sql).all() as { month: string; city: string; murder_victims: number | null; shr_recorded_months: number; shr_status: string }[];
assert.equal(monthlyRows.length, 12);
assert.equal(monthlyRows[0].murder_victims, 2);
assert.equal(monthlyRows[1].murder_victims, 0);
assert.equal(monthlyRows[7].murder_victims, 1);
assert.equal(monthlyRows[0].shr_status, "SHR records present");

const missing = buildShrMurderPlan("murders per month in 2021 in Houston", db);
if (!missing || missing.kind !== "query") throw new Error("missing-coverage plan missing");
const missingRows = db.prepare(missing.sql).all() as { murder_victims: number | null; shr_recorded_months: number; shr_status: string }[];
assert.equal(missingRows.length, 12);
assert.equal(missingRows[0].murder_victims, null);
assert.equal(missingRows[0].shr_recorded_months, 0);
assert.equal(missingRows[0].shr_status, "No SHR homicide records in period");

db.close();
console.log("SHR deterministic murder tests passed");
