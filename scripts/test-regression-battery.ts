import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildCompletenessAnswer } from "../lib/completeness-intent";
import { geoCorrectionHint } from "../lib/geo-correction";
import { resolveGeoPlaces } from "../lib/geo-place-resolver";
import { missingLowerBoundNote } from "../lib/result-disclosure";
import { validateGrain } from "../lib/requested-grain";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { validateSqlSchema } from "../lib/schema-validation";
import { finalizeGuardrailTags, mergeGuardrailTags } from "../lib/guardrail-tag-state";
import { HISTORICAL, NIBRS } from "../lib/dynamic-facts";
import { historicalYearAvailability } from "../lib/year-availability";
import { formatNibrsResolutionGuidance, resolveNibrsPlaces, resolvedOriEnforcementIssue } from "../lib/nibrs-place-resolver";
import { detectFollowupTransform } from "../lib/followup-transform";
import { planFollowup } from "../lib/followup-planner";
import { buildMultiCityTrendPlan } from "../lib/multi-city-deterministic";
import { shouldRetryUnexplainedNoSql } from "../lib/no-sql-retry";
import { buildQueryContract } from "../lib/query-contract";

/** Live-only checks: these require the deployed model/API and are not executed here. */
export const LIVE_REPLAY = [
  { question: "DWI in El Paso, Texas per month over time", expected: "invalid arrest_count is caught or corrected to arrestee_count; returned data remains monthly" },
  { question: "new orlens 2017 to 2020", expected: "New Orleans result with rows and geo-typo-corrected" },
  { question: "large cities with the most murders 2023", expected: "ordered national city ranking, not metadata or a single place" },
  { question: "crime from 2016 to present", expected: "disclosure if returned data begins in 2017" },
];

const annualDwi = [{ year: 2021, dui_arrests: 10 }, { year: 2025, dui_arrests: 12 }];
const grain = validateGrain("DWI in El Paso per month over time", annualDwi);
assert.equal(grain.ok, false);
assert.match(grain.message ?? "", /annually, not monthly/);

const schemaDb = new Database(":memory:");
schemaDb.exec("CREATE TABLE summary_arrestee_demographics (year INTEGER, month INTEGER, arrestee_count INTEGER)");
const schema = validateSqlSchema(schemaDb, "SELECT year, month, arrest_count FROM summary_arrestee_demographics");
assert.equal(schema.ok, true);
assert.equal(schema.corrected, true);
assert.match(schema.sql, /arrestee_count/);
assert.doesNotMatch(schema.sql, /\barrest_count\b/);

const typoHint = geoCorrectionHint("murders in new orlens 2020");
assert.ok(typoHint);
assert.match(typoHint ?? "", /New Orleans/);
const typoResolution = resolveGeoPlaces("murders in new orlens 2020");
assert.equal(typoResolution.mentions[0]?.candidates[0]?.name, "New Orleans");

const rankingQuestion = "large cities with the most murders 2023";
const rankingSql = "SELECT ha.agency, hac.year, SUM(hac.murder) AS murders FROM historical_agency ha JOIN historical_agency_crime hac ON hac.ori = ha.ori WHERE hac.year = 2023 GROUP BY ha.agency, hac.year ORDER BY murders DESC LIMIT 20";
const rankingContract = validateQueryContractSql({ question: rankingQuestion, source: "historical", sql: rankingSql });
assert.equal(rankingContract.blockReasons.length, 0);
assert.equal(rankingContract.enforced.includes("contract-geography-state-missing"), false);

const completeness = buildCompletenessAnswer(
  "hate_crime",
  [{ year: 2024, value: 100 }, { year: 2025, value: 110 }, { year: 2026, value: 40 }],
  2026,
  2026,
);
assert.match(completeness, /2026 .*in progress and incomplete/i);
assert.match(completeness, /latest reasonably complete year is 2024/i);

const lowerBound = missingLowerBoundNote(
  "violent crime from 2016 to present",
  "SELECT year, count FROM crime WHERE year >= 2016",
  [{ year: 2017, count: 10 }, { year: 2025, count: 20 }],
);
assert.equal(lowerBound, "Although the query covered 2016 onward, this source returned data beginning in 2017.");

const preservedTags = mergeGuardrailTags(["geo-typo-corrected"], ["contract-year-lower-bound-missing"]);
assert.ok(preservedTags.includes("geo-typo-corrected"), "non-contract tags survive accumulation");
const resolvedTags = finalizeGuardrailTags(["contract-year-lower-bound-missing", "geo-typo-corrected"], []);
assert.ok(resolvedTags.includes("contract-year-lower-bound-missing-resolved-on-retry"));
assert.equal(resolvedTags.includes("contract-year-lower-bound-missing"), false);
const unresolvedTags = finalizeGuardrailTags(["contract-year-lower-bound-missing"], ["contract-year-lower-bound-missing"]);
assert.ok(unresolvedTags.includes("contract-year-lower-bound-missing"));
assert.equal(unresolvedTags.includes("contract-year-lower-bound-missing-resolved-on-retry"), false);
// ---------------------------------------------------------------------------
// The 2026-08-10 clearance session, end to end (query_log 8348 - 8378).
//
// One user, one afternoon, five separate defects. Each has unit coverage in its
// own suite; this walks the actual sequence so a future change that reopens the
// chain fails here even if the individual units still pass.
// ---------------------------------------------------------------------------

// 8348 - Historical cannot answer a 2025 clearance question and now says where to go
{
  const clearanceYear = Math.min(NIBRS.maxYear, HISTORICAL.clearanceMaxYear + 1);
  const availability = historicalYearAvailability(`murders and clearance rate in ${clearanceYear} for every city that had 50 or more murders`);
  assert.ok(availability, "a clearance year past Historical's cutoff must be caught");
  assert.match(availability.explanation, /NIBRS/, "8348: the dead end now points at NIBRS");
}

// The 32-city question, trimmed to three cities that reproduce all three resolver bugs
const THIRTY_TWO_CITY_Q =
  "give me number of murders and murder clearances by type for 2025 for these cities: Chicago, IL New York City, NY St Louis, MO";

const sessionDb = new Database(":memory:");
sessionDb.exec(`
  CREATE TABLE agencies (
    ori TEXT, year INTEGER, state TEXT, city TEXT, agency_type TEXT,
    population INTEGER, pop_group TEXT, covered_flag TEXT, agency_indicator TEXT
  );
  INSERT INTO agencies VALUES
    ('ILCPD0000', 2025, 'IL', 'CHICAGO', 'City', 2660000, '1A', 'N', 'E'),
    ('NY0303000', 2025, 'NY', 'NEW YORK', 'City', 8496850, '1A', 'N', 'E'),
    ('NY0230000', 2025, 'NY', 'NEW YORK CITY', 'County', 0, '9D', 'N', 'E'),
    ('MOSPD0000', 2025, 'MO', 'SAINT LOUIS', 'City', 274819, '1C', 'N', 'E'),
    ('MO0956200', 2025, 'MO', 'ST LOUIS', 'City', 9052, '6', 'N', 'E');
`);

// 8375 - every place resolves, including the two that did not in production
{
  const plan = resolveNibrsPlaces(sessionDb, THIRTY_TWO_CITY_Q);
  assert.ok(plan);
  const resolved = new Map(
    plan.places.filter((p) => p.status === "resolved").map((p) => [p.label, p.oriYears[0]?.ori])
  );
  assert.equal(resolved.size, 3, "8375: all three cities must resolve");
  assert.ok([...resolved.values()].includes("NY0303000"), "8375: NYPD is in NIBRS");
  assert.ok([...resolved.values()].includes("MOSPD0000"), "8375: St Louis is SLMPD, not the 9k-population namesake");

  const guidance = formatNibrsResolutionGuidance(plan) ?? "";
  assert.match(guidance, /NY0303000/);
  assert.match(guidance, /MOSPD0000/);

  // and a no-SQL reply for this question is worth one retry rather than a shrug
  assert.equal(shouldRetryUnexplainedNoSql(buildQueryContract(THIRTY_TWO_CITY_Q, "nibrs"), plan), true);

  // 8376 - city-name SQL against that plan is now blocked, not merely logged
  const bypass = resolvedOriEnforcementIssue(
    plan,
    "SELECT a.city, SUM(scd.total_offenses) FROM summary_clearance_detail scd JOIN agencies a ON a.ori = scd.ori WHERE a.city = 'SAINT LOUIS' GROUP BY a.city"
  );
  assert.ok(bypass, "8376: matching agencies by city name must be caught");
}

// 8376 - the follow-up rebuilds from a prior turn that produced no SQL at all
{
  const transform = detectFollowupTransform("just clearances by type", [
    { role: "user", content: THIRTY_TWO_CITY_Q },
    { role: "assistant", content: "I could not generate a database query for that request in the NIBRS source. Please restate it with the place, offense, and date range you want." },
  ]);
  assert.equal(transform?.name, "restrict_scope", "8376: the fragment must reconstruct");
  const plan = resolveNibrsPlaces(sessionDb, transform!.contextQuestion!);
  assert.ok(plan?.places.some((p) => p.status === "resolved"), "8376: reconstruction restores the places");
}

// 8377 -> 8378 - a complete question is not a follow-up of the previous tab's result
{
  const plan = planFollowup(
    "compare tulsa and oklahoma city homicides over time",
    [
      { role: "user", content: "Compare robbery in Chicago and Dallas, 2022 to 2024", source: "current" },
      { role: "assistant", content: "Here you go.\n[SQL: SELECT period, chicago FROM agency_monthly]", source: "current" },
    ],
    "historical"
  );
  assert.equal(plan.kind, "not_followup", "8378: standalone, so the deterministic path stays open");
  assert.ok(
    buildMultiCityTrendPlan("compare tulsa and oklahoma city homicides over time", "historical"),
    "8378: and the deterministic path produces a plan"
  );
}

sessionDb.close();
schemaDb.close();
console.log("regression battery passed");
