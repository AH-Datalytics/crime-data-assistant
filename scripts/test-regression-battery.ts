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
schemaDb.close();
console.log("regression battery passed");
