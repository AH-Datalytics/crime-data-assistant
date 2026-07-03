#!/usr/bin/env npx tsx
// Tests for lib/nibrs-agency-probe.ts (query-audit-2026-07-03 F25)

import Database from "better-sqlite3";
import {
  appendNibrsAgencyProbeCaveat,
  extractNibrsAgencyScope,
  runNibrsAgencyProbe,
} from "../lib/nibrs-agency-probe.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// Fixture DB mirroring the Jackson, MS case: agency reports 2025-2026 only
const db = new Database(":memory:");
db.exec(`
  CREATE TABLE agencies (ori TEXT, year INTEGER, state TEXT, city TEXT, population INTEGER, pop_group TEXT, agency_type TEXT);
  CREATE TABLE nibrs_agency_completeness (ori TEXT, year INT, months_reported, total_offenses);
  INSERT INTO agencies VALUES
    ('MS0250100', 2025, 'MS', 'JACKSON', 138204, '2', 'City'),
    ('MS0250100', 2026, 'MS', 'JACKSON', 138204, '2', 'City'),
    ('TN0570100', 2020, 'TN', 'JACKSON', 68205, '3', 'City'),
    ('MS0999999', 2025, 'MS', 'NEVERREPORTS', 5000, '6', 'City');
  INSERT INTO nibrs_agency_completeness VALUES
    ('MS0250100', 2025, 12, 5000),
    ('MS0250100', 2026, 5, 2000),
    ('TN0570100', 2020, 12, 900);
`);

// #4595's real SQL shape
const jacksonSql = `SELECT d.year, d.age_group, SUM(d.offender_count) AS offenders FROM summary_offender_demographics d WHERE d.state = 'MS' AND d.year BETWEEN 2019 AND 2025 AND d.weapon_category = 'Firearm' AND d.ori IN (SELECT ori FROM agencies WHERE city = 'JACKSON' AND state = 'MS' AND year = 2025 AND population > 0) AND d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = 2019 AND end_year = 2025) GROUP BY d.year, d.age_group`;

{
  const scope = extractNibrsAgencyScope(jacksonSql);
  assert("extracts city/state scope from agencies subquery",
    scope?.label === "Jackson, MS" && scope?.state === "MS",
    JSON.stringify(scope));
}

{
  const probe = runNibrsAgencyProbe(db, jacksonSql);
  assert("probe finds Jackson's actual span 2025-2026",
    probe?.reported === true && probe?.minYear === 2025 && probe?.maxYear === 2026,
    JSON.stringify(probe));
  assert("probe notices the consistent-reporter filter",
    probe?.usedConsistentReporterFilter === true,
    JSON.stringify(probe));
  const text = appendNibrsAgencyProbeCaveat("The query returned no results.", probe!);
  assert("caveat names the real span and the excluding filter",
    text.includes("2025–2026") && text.includes("consistent-reporter"),
    text);
}

{
  // Agency present in agencies table but never reported
  const sql = `SELECT SUM(x) FROM summary_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'NEVERREPORTS' AND state = 'MS')`;
  const probe = runNibrsAgencyProbe(db, sql);
  assert("non-reporting agency yields reported=false", probe?.reported === false, JSON.stringify(probe));
  const text = appendNibrsAgencyProbeCaveat("", probe!);
  assert("caveat says the agency may not report to NIBRS",
    text.includes("may not report to NIBRS"),
    text);
}

{
  // Direct ORI literal
  const sql = `SELECT SUM(x) FROM summary_city_monthly WHERE ori = 'MS0250100' AND year = 2019`;
  const probe = runNibrsAgencyProbe(db, sql);
  assert("direct ORI literal probes the span",
    probe?.reported === true && probe?.minYear === 2025,
    JSON.stringify(probe));
}

{
  // No agency scope → probe stays silent
  const sql = `SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'MS' GROUP BY year`;
  const scope = extractNibrsAgencyScope(sql);
  assert("state-only query has no agency scope", scope === null, JSON.stringify(scope));
}

console.log(`nibrs agency probe tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
