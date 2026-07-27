#!/usr/bin/env npx tsx

import { strict as assert } from "node:assert";
import Database from "better-sqlite3";
import {
  auditNibrsResolvedOriUsage,
  formatNibrsResolutionGuidance,
  resolveNibrsPlaces,
} from "../lib/nibrs-place-resolver.js";
import { buildQueryContract } from "../lib/query-contract.js";
import { decideNibrsCompleteness } from "../lib/nibrs-completeness.js";
import { buildNibrsStructuredLocalTrendQuery } from "../lib/nibrs-deterministic-queries.js";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agencies (
    ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT,
    population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT
  );
  CREATE TABLE agency_county_crosswalk (
    ori TEXT, ori9 TEXT, agency_name TEXT, state TEXT, county_key TEXT
  );
  CREATE INDEX idx_agencies_state_city_year ON agencies(state, city, year);
  INSERT INTO agencies VALUES
    ('ILCHI0001', 2021, 'IL', 'CHICAGO', 'City', 2700000, '1A', 'N', 'E'),
    ('ILCHI0001', 2022, 'IL', 'CHICAGO', 'City', 2690000, '1A', 'N', 'E'),
    ('ILCHI0001', 2023, 'IL', 'CHICAGO', 'City', 2680000, '1A', 'N', 'E'),
    ('ILCHI0002', 2024, 'IL', 'CHICAGO', 'City', 2670000, '1A', 'N', 'E'),
    ('ILCHI0002', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E'),
    ('MO0480000', 2024, 'MO', 'JACKSON', 'County', 720000, '9A', 'N', 'E'),
    ('MO0480000', 2025, 'MO', 'JACKSON', 'County', 725000, '9A', 'N', 'E'),
    ('MO0482300', 2025, 'MO', 'JACKSON', 'County', 0, '9D', 'N', 'E'),
    ('VA0290000', 2025, 'VA', 'FAIRFAX', 'County', 0, '9D', 'N', 'E'),
    ('VA0290100', 2024, 'VA', 'FAIRFAX', 'County', 1107151, '9A', 'N', 'E'),
    ('VA0290100', 2025, 'VA', 'FAIRFAX', 'County', 1125193, '9A', 'N', 'E'),
    ('CA0193500', 2016, 'CA', 'LAKEWOOD', 'City', 81921, '3', 'N', 'C');
  INSERT INTO agency_county_crosswalk VALUES
    ('MO04800', 'MO0480000', 'Jackson', 'MO', 'JACKSON'),
    ('MO04823', 'MO0482300', 'Jackson County Park Rgrs', 'MO', 'JACKSON'),
    ('MO04827', 'MO0482700', 'Jackson County Drug T F', 'MO', 'JACKSON'),
    ('VA02900', 'VA0290000', 'Fairfax', 'VA', 'FAIRFAX'),
    ('VA02901', 'VA0290100', 'Fairfax County Pd', 'VA', 'FAIRFAX'),
    ('CA01935', 'CA0193500', 'Lakewood', 'CA', 'LOS ANGELES');
`);

{
  const plan = resolveNibrsPlaces(db, "Chicago murders from 2021 to 2025");
  assert.ok(plan);
  assert.equal(plan.places[0].status, "resolved");
  assert.deepEqual(plan.places[0].oriRanges, [
    { ori: "ILCHI0001", startYear: 2021, endYear: 2023 },
    { ori: "ILCHI0002", startYear: 2024, endYear: 2025 },
  ]);
  assert.match(formatNibrsResolutionGuidance(plan) ?? "", /ILCHI0001 for 2021-2023/);
  assert.deepEqual(auditNibrsResolvedOriUsage(
    plan,
    "SELECT * WHERE ori IN ('ILCHI0001','ILCHI0002')"
  ), []);
  const query = buildNibrsStructuredLocalTrendQuery(
    "Murder rate in Chicago from 2021 to 2025",
    plan
  );
  assert.ok(query);
  assert.match(query.sql, /'ILCHI0001' AS ori, 2021 AS effective_year/);
  assert.match(query.sql, /'ILCHI0002' AS ori, 2025 AS effective_year/);
  assert.match(query.sql, /tp\.effective_year = s\.year/);
  assert.doesNotMatch(query.sql, /a\.city = 'CHICAGO'/);
}

{
  const question = "Jackson County Sheriff's Office in Missouri murders from 2024 to 2025";
  const contract = buildQueryContract(question, "nibrs");
  const plan = resolveNibrsPlaces(db, question, contract);
  assert.ok(plan);
  assert.equal(plan.places.length, 1, "state mention must be disambiguation, not another local place");
  assert.equal(plan.hasStateComparison, false);
  assert.equal(plan.places[0].status, "resolved", JSON.stringify({ contract, plan }));
  assert.deepEqual([...new Set(plan.places[0].oriYears.map((row) => row.ori))], ["MO0480000"]);
  assert.doesNotMatch(JSON.stringify(plan), /MO0482300|MO0482700/);
}

{
  const plan = resolveNibrsPlaces(
    db,
    "Fairfax County Police Department in Virginia murders from 2024 to 2025"
  );
  assert.ok(plan);
  assert.equal(plan.places[0].kind, "county_police");
  assert.equal(plan.places[0].status, "resolved");
  assert.deepEqual([...new Set(plan.places[0].oriYears.map((row) => row.ori))], ["VA0290100"]);
  const query = buildNibrsStructuredLocalTrendQuery(
    "Fairfax County Police Department in Virginia murder rate from 2024 to 2025",
    plan
  );
  assert.ok(query);
  assert.match(query.sql, /'VA0290100' AS ori/);
  assert.doesNotMatch(query.sql, /city = 'FAIRFAX COUNTY'/i);
}

{
  const plan = resolveNibrsPlaces(db, "Lakewood, CA murders from 2021 to 2025");
  assert.ok(plan);
  assert.equal(plan.places[0].status, "covered");
  assert.match(plan.places[0].reason, /no active city-agency ORI/i);
}

{
  const plan = resolveNibrsPlaces(db, "Chicago murders from 2021 to 2025");
  assert.ok(plan);
  assert.deepEqual(
    auditNibrsResolvedOriUsage(plan, "SELECT * FROM summary_victim_city_monthly"),
    ["resolved ORI missing for Chicago, IL: ILCHI0001,ILCHI0002"]
  );
}

{
  assert.equal(decideNibrsCompleteness({
    year: 2021,
    currentYear: 2026,
    reportingMonths: 7,
    unit: "count",
  }).display, false);
  assert.equal(decideNibrsCompleteness({
    year: 2026,
    currentYear: 2026,
    reportingMonths: null,
    summaryMonths: 3,
    unit: "count",
  }).display, true);
  assert.equal(decideNibrsCompleteness({
    year: 2026,
    currentYear: 2026,
    reportingMonths: null,
    summaryMonths: 3,
    unit: "rate",
  }).display, false);
}

{
  const started = performance.now();
  for (let i = 0; i < 500; i += 1) {
    resolveNibrsPlaces(db, "Chicago murders from 2021 to 2025");
  }
  assert.ok(performance.now() - started < 100, "500 cached resolutions should complete under 100ms");
}

db.close();
console.log("nibrs place resolver tests passed");
