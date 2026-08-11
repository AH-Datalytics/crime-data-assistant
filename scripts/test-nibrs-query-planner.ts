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
const availableJuvenileIncident = planNibrsQuery(
  "how many violent crime incidents nationwide in 2025 had any offenders under age 18",
  null,
  { allowDeterministic: true, juvenileIncidentRollupAvailable: true }
);
assert.equal(availableJuvenileIncident.kind, "deterministic");
if (availableJuvenileIncident.kind === "deterministic") {
  assert.match(availableJuvenileIncident.query.sql, /summary_juvenile_offender_incidents/);
  assert.match(availableJuvenileIncident.query.sql, /offense_scope = 'violent_crime'/);
  assert.match(availableJuvenileIncident.query.sql, /s\.year = 2025/);
  assert.match(availableJuvenileIncident.query.explanation, /counted once/i);
  assert.match(availableJuvenileIncident.query.explanation, /not a national estimate/i);
  db.exec("CREATE TABLE summary_juvenile_offender_incidents(year INT,month INT,state TEXT,ori TEXT,offense_scope TEXT,incident_count INT); INSERT INTO summary_juvenile_offender_incidents VALUES (2025,0,'IL','ORI1','violent_crime',5),(2025,1,'IL','ORI1','violent_crime',3),(2025,2,'TX','ORI2','violent_crime',4),(2025,1,'IL','ORI1','120',2);");
  const row = db.prepare(availableJuvenileIncident.query.sql).get() as { juvenile_offender_incidents: number };
  assert.equal(row.juvenile_offender_incidents, 12);
  const monthly = planNibrsQuery(
    "violent crime incidents by month in 2025 with any offenders under age 18",
    null,
    { allowDeterministic: true, juvenileIncidentRollupAvailable: true }
  );
  assert.equal(monthly.kind, "deterministic");
  if (monthly.kind === "deterministic") {
    assert.match(monthly.query.sql, /s\.month BETWEEN 1 AND 12/);
    const rows = db.prepare(monthly.query.sql).all() as { month: number; juvenile_offender_incidents: number }[];
    assert.deepEqual(rows, [
      { year: 2025, month: 1, juvenile_offender_incidents: 3 },
      { year: 2025, month: 2, juvenile_offender_incidents: 4 },
    ]);
  }
}
db.close();
console.log("nibrs query planner tests passed");
