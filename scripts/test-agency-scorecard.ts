import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildAgencyScorecard, detectAgencyScorecardQuestion, SCORECARD_COLUMNS } from "../lib/agency-scorecard";

const db = new Database(":memory:");
db.exec("CREATE TABLE historical_agency (ori TEXT PRIMARY KEY, agency TEXT, state TEXT, type TEXT); CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, population INTEGER, violent INTEGER, murder INTEGER, rape INTEGER, robbery INTEGER, assault INTEGER, property INTEGER, burglary INTEGER, theft INTEGER, motor_vehicle_theft INTEGER, PRIMARY KEY (ori, year)); CREATE TABLE historical_agency_population (ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year)); CREATE TABLE historical_agency_clearance (ori TEXT, year INTEGER, violent_clr REAL, murder_clr REAL, rape_clr REAL, robbery_clr REAL, assault_clr REAL, property_clr REAL, burglary_clr REAL, theft_clr REAL, motor_vehicle_theft_clr REAL, PRIMARY KEY (ori, year));");
db.prepare("INSERT INTO historical_agency VALUES ('OKTULSA01', 'Tulsa', 'ok', 'city')").run();
const crime = db.prepare("INSERT INTO historical_agency_crime VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const population = db.prepare("INSERT INTO historical_agency_population VALUES (?, ?, ?)");
const clearance = db.prepare("INSERT INTO historical_agency_clearance VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
crime.run("OKTULSA01", 2024, 400000, 100, 10, 20, 30, 40, 200, 50, 100, 50); population.run("OKTULSA01", 2024, 400000); clearance.run("OKTULSA01", 2024, 60, 70, 71, 72, 73, 74, 75, 76, 77);
crime.run("OKTULSA01", 2025, 410000, 110, 11, 21, 31, 47, 210, 51, 101, 51); population.run("OKTULSA01", 2025, 410000); clearance.run("OKTULSA01", 2025, 61, 162.5, 72, 73, 74, 75, 76, 77, 78);
assert.equal(detectAgencyScorecardQuestion("Give me Tulsa, Oklahoma's crime scorecard"), true);
const result = buildAgencyScorecard(db, "Give me Tulsa, Oklahoma's crime scorecard");
assert.ok(result); assert.equal(result.title, "Tulsa, OK Scorecard (2025)"); assert.deepEqual(result.columns, [...SCORECARD_COLUMNS]);
assert.deepEqual(result.rows.map((row) => row.offense), ["Violent Crime", "Murder", "Rape", "Robbery", "Aggravated Assault", "Property Crime", "Burglary", "Theft", "Motor Vehicle Theft"]);
assert.equal(result.rows[0].offenses, 110); assert.equal(result.rows[0].rate_per_100k, 26.8); assert.equal(result.rows[0].clearance_rate, 61); assert.equal(result.rows[0].offense_change_pct, 10); assert.equal(result.rows[1].offenses, 11); assert.equal(result.rows[1].rate_per_100k, 2.7); assert.equal(result.rows[1].clearance_rate, 162.5); assert.equal(result.rows[1].offense_change_pct, 10); assert.match(result.explanation, /exceed 100%/); assert.equal(result.rows[5].offenses, 210); assert.equal(result.rows[5].clearance_rate, 75); assert.equal(result.rows[5].offense_change_pct, 5); assert.equal(result.year, 2025); assert.equal(buildAgencyScorecard(db, "Give me Tulsa crime trends"), null);
db.prepare("UPDATE historical_agency_clearance SET rape_clr = NULL WHERE ori = 'OKTULSA01' AND year = 2025").run();
const fallback = buildAgencyScorecard(db, "Give me Tulsa, Oklahoma's crime scorecard");
assert.ok(fallback); assert.equal(fallback.year, 2024); assert.match(fallback.title, /2024/);
const unavailable = buildAgencyScorecard(db, "Give me Oklahoma crime scorecard");
assert.ok(unavailable); assert.equal(unavailable.rows.length, 0); assert.match(unavailable.explanation, /one specific city agency/);

// Boundary fields: the panel draws its header from these, so they must be on the
// result. Both are already computed internally; this asserts they are exposed.
const populated = buildAgencyScorecard(db, "Give me Tulsa, Oklahoma's crime scorecard");
assert.ok(populated);
assert.equal(populated.agencyLabel, "Tulsa, OK");
// By this point in the script, an earlier mutation nulled 2025's rape_clr, so the
// most recent complete year has already fallen back to 2024.

// Unavailable path: every value is falsy, which is exactly the shape that a
// conditional copy downstream would silently drop.
const noAgency = buildAgencyScorecard(db, "Give me Oklahoma crime scorecard");
assert.ok(noAgency);
assert.equal(noAgency.agencyLabel, "");
assert.equal(noAgency.year, null);

db.close(); console.log("Agency scorecard checks passed.");
