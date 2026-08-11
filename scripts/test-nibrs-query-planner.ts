#!/usr/bin/env npx tsx

import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import { resolveNibrsPlaces } from "../lib/nibrs-place-resolver.js";
import { planNibrsQuery } from "../lib/nibrs-query-planner.js";

const db = new Database(":memory:");
db.exec("CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT, population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT); CREATE TABLE agency_county_crosswalk (ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT); INSERT INTO agencies VALUES ('ILCHI0000', 2024, 'IL', 'CHICAGO', 'City', 2600000, '1A', 'N', 'E'), ('CA0193500', 2016, 'CA', 'LAKEWOOD', 'City', 81921, '3', 'N', 'C'); INSERT INTO agency_county_crosswalk VALUES ('CA01935', 'CA0193500', 'Lakewood', 'CA', 'LOS ANGELES');");

const mixedQuestion = "Compare murder rates in Chicago, IL and Lakewood, CA from 2021 to 2024";
const mixedPlan = resolveNibrsPlaces(db, mixedQuestion);
assert.ok(mixedPlan);
const blocked = planNibrsQuery(mixedQuestion, mixedPlan);
assert.equal(blocked.kind, "blocked");
if (blocked.kind === "blocked") assert.match(blocked.explanation, /in this comparison/);

const resolvedQuestion = "Murder trend in Chicago, IL from 2024 to 2024";
const resolvedPlan = resolveNibrsPlaces(db, resolvedQuestion);
assert.ok(resolvedPlan);
assert.equal(planNibrsQuery(resolvedQuestion, resolvedPlan).kind, "deterministic");
assert.equal(planNibrsQuery(resolvedQuestion, resolvedPlan, { allowDeterministic: false }).kind, "model");

const juvenileIncident = planNibrsQuery(
  "how many violent crime incidents in 2025 had one or more offenders under age 18",
  null
);
assert.equal(juvenileIncident.kind, "unavailable");
if (juvenileIncident.kind === "unavailable") {
  assert.match(juvenileIncident.explanation, /count offenders rather than distinct incidents/i);
  assert.match(juvenileIncident.explanation, /without risking double-counting/i);
}

db.close();
console.log("nibrs query planner tests passed");
