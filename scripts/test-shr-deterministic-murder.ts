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
  CREATE TABLE shr_return_a_comparison (
    shr_ori TEXT, state TEXT, year INTEGER, reta_murders INTEGER,
    shr_victims INTEGER, join_method TEXT, comparison_status TEXT
  );
`);

function addAgency(ori: string, state: string, name: string, firstYear = 1976, lastYear = 2024): void {
  db.prepare("INSERT INTO shr_agency_identity VALUES (?, ?, ?, 'City', ?, ?, 100, ?)")
    .run(ori, state, name, firstYear, lastYear, name);
  db.prepare("INSERT INTO shr_agency_alias VALUES (?, ?, ?, ?, 'City')")
    .run(agencySearchKey(name), ori, state, name);
}

addAgency("MD00001", "MD", "Baltimore");
addAgency("CA00001", "CA", "Los Angeles");
addAgency("NY00001", "NY", "New York");
addAgency("CA00002", "CA", "Oakland");
addAgency("DC00001", "DC", "Washington");
addAgency("TX00001", "TX", "Houston");
addAgency("KY00001", "KY", "Louisville Metro", 1976, 2002);
addAgency("KY00002", "KY", "Louisville Metro", 2003, 2024);

const incident = db.prepare("INSERT INTO incidents (ori, year, month, homicide_type, agency) VALUES (?, 2021, ?, 'Murder', ?)");
const victim = db.prepare("INSERT INTO victims (incident_id) VALUES (?)");
function addMurder(ori: string, month: number, agency: string, victims: number): void {
  const id = Number(incident.run(ori, month, agency).lastInsertRowid);
  for (let index = 0; index < victims; index += 1) victim.run(id);
}

addMurder("MD00001", 1, "Baltimore", 1);
addMurder("CA00001", 2, "Los Angeles", 1);
addMurder("NY00001", 3, "New York", 1);
addMurder("CA00002", 1, "Oakland", 2);
addMurder("CA00002", 8, "Oakland", 1);
addMurder("DC00001", 7, "Washington", 1);
addMurder("KY00001", 2, "Louisville Metro", 10);
addMurder("KY00002", 1, "Louisville Metro", 1);
const comparisonInsert = db.prepare("INSERT INTO shr_return_a_comparison VALUES (?, ?, 2021, ?, ?, 'ori_prefix_7_to_9', ?)");
comparisonInsert.run("MD00001", "MD", 1, 1, "post2020_transition_review");
comparisonInsert.run("CA00001", "CA", 1, 1, "post2020_transition_review");
comparisonInsert.run("NY00001", "NY", 1, 1, "post2020_transition_review");
comparisonInsert.run("CA00002", "CA", 3, 3, "post2020_transition_review");
comparisonInsert.run("DC00001", "DC", 1, 1, "post2020_transition_review");
comparisonInsert.run("TX00001", "TX", null, 0, "reta_unreported");
comparisonInsert.run("KY00001", "KY", 10, 10, "post2020_transition_review");
comparisonInsert.run("KY00002", "KY", 1, 1, "post2020_transition_review");

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
assert.match(monthly.sql, /targets\(city, state, ori, start_year, end_year\)/);
const monthlyRows = db.prepare(monthly.sql).all() as { month: string; city: string; murder_victims: number | null; shr_recorded_months: number; shr_status: string }[];
assert.equal(monthlyRows.length, 12);
assert.equal(monthlyRows[0].murder_victims, 2);
assert.equal(monthlyRows[1].murder_victims, 0);
assert.equal(monthlyRows[7].murder_victims, 1);
assert.equal(monthlyRows[0].shr_status, "count");

const missing = buildShrMurderPlan("murders per month in 2021 in Houston", db);
if (!missing || missing.kind !== "query") throw new Error("missing-coverage plan missing");
const missingRows = db.prepare(missing.sql).all() as { murder_victims: number | null; shr_recorded_months: number; shr_status: string }[];
assert.equal(missingRows.length, 12);
assert.equal(missingRows[0].murder_victims, null);
assert.equal(missingRows[0].shr_recorded_months, 0);
assert.equal(missingRows[0].shr_status, "coverage_unknown");

const succession = buildShrMurderPlan("murders in 2021 in Louisville", db);
if (!succession || succession.kind !== "query") throw new Error("succession plan missing");
const successionRow = db.prepare(succession.sql).get() as {
  murder_victims: number; shr_recorded_months: number;
};
assert.equal(successionRow.murder_victims, 1);
assert.equal(successionRow.shr_recorded_months, 1);

db.close();
console.log("SHR deterministic murder tests passed");
