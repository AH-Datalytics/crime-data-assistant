/**
 * Fix 1 — resolved-place canonicalization.
 *
 * Production 7772/7773: correct NIBRS carjacking data for Baltimore, but the
 * narrative read "carjacking counts for cities in the dataset City" because
 * validateExplanationEntities could not verify "Baltimore":
 *   - SQL filtered by ORI ('MDBPD0000'), so no agency=/city= geo was extracted
 *   - the question was lowercase ("baltimore city"), so the capitalized-name
 *     fallback in query-context.ts did not match
 *   - result rows had no place column, so resultEntities was empty
 * With nothing to verify against, a CORRECT mention was replaced.
 *
 * Fix: extractQueryContext exposes resolvedPlaces (canonical names from the
 * shared place resolver, computed only when no geo was found otherwise), and
 * the explain path unions it into the valid-name set. ctx.geos is deliberately
 * NOT modified — it is read by 9 guardrails and by geoDisplay.
 */

import assert from "node:assert/strict";
import { extractQueryContext } from "../lib/query-context";
import { validateExplanationEntities } from "../lib/explain";

/** Mirrors the explain.ts call site: valid names = SQL geos + resolved places. */
function validNamesFor(sql: string, question: string, tab: "current" | "historical" | "nibrs" | "shr" | "hate_crime") {
  const ctx = extractQueryContext(sql, question, tab);
  return [...ctx.geos, ...(ctx.resolvedPlaces ?? [])];
}

// ---------------------------------------------------------------- 7772
const SQL_7772 =
  "SELECT s.year, SUM(s.offense_count) AS carjackings FROM summary_carjacking_monthly s " +
  "WHERE s.ori = 'MDBPD0000' AND s.year BETWEEN 2021 AND 2025 GROUP BY s.year ORDER BY s.year LIMIT 1000";
const Q_7772 = "carjackings in baltimore city";
const NARRATIVE_7772 =
  "This data contains carjacking counts for Baltimore City from 2021 to 2025.\n\n" +
  "**Note: Baltimore was transitioning to NIBRS reporting in 2021 and data for those years is incomplete. " +
  "Counts are significantly lower than actual crime levels.**";

const resolved7772 = validNamesFor(SQL_7772, Q_7772, "nibrs");
assert.ok(
  resolved7772.some((n) => /baltimore/i.test(n)),
  "7772: resolver must surface Baltimore for a lowercase, ORI-filtered query. Got: " + JSON.stringify(resolved7772)
);

const out7772 = validateExplanationEntities(NARRATIVE_7772, [], resolved7772);
assert.match(out7772, /Baltimore City/, "7772: Baltimore City must survive");
assert.doesNotMatch(out7772, /dataset City/, "7772: 'dataset City' must not appear");
assert.doesNotMatch(out7772, /cities in the dataset/, "7772: no generic substitution should occur");
assert.equal(out7772, NARRATIVE_7772, "7772: a correct narrative must pass through unchanged");

// ---------------------------------------------------------------- 7773 (monthly)
const SQL_7773 =
  "SELECT s.year, s.month, SUM(s.offense_count) AS carjackings FROM summary_carjacking_monthly s " +
  "WHERE s.ori = 'MDBPD0000' AND s.year BETWEEN 2021 AND 2025 GROUP BY s.year, s.month ORDER BY s.year, s.month LIMIT 1000";
const NARRATIVE_7773 =
  "This dataset contains monthly carjacking counts for Baltimore City from 2021 to 2025.\n\n" +
  "**Note: Baltimore was transitioning to NIBRS reporting in 2021 and data for those years is incomplete.**";

const out7773 = validateExplanationEntities(
  NARRATIVE_7773,
  [],
  validNamesFor(SQL_7773, "carjackings in baltimore city by month", "nibrs")
);
assert.match(out7773, /Baltimore City/, "7773: Baltimore City must survive");
assert.doesNotMatch(out7773, /dataset City/, "7773: 'dataset City' must not appear");

// ---------------------------------------------------------------- 7544 class: New York / New York City
const SQL_7544 =
  "SELECT year, SUM(murder) AS murders FROM summary_city_monthly WHERE ori = 'NY03030' AND year >= 2015 GROUP BY year";
const NARRATIVE_7544 = "This data contains murder counts for New York City from 2015 to 2024.";
const out7544 = validateExplanationEntities(
  NARRATIVE_7544,
  [],
  validNamesFor(SQL_7544, "murders in new york city since 2015", "nibrs")
);
assert.match(out7544, /New York City/, "7544: New York City must survive");
assert.doesNotMatch(out7544, /cities in the dataset/, "7544: no generic substitution");

// ------------------------------------------------- SAFE CASE: legitimate generic wording
// A narrative that genuinely describes many cities must NOT be rewritten, and
// the phrase "cities in the dataset" must be left exactly as authored.
const GENERIC_NARRATIVE =
  "This data contains aggregate carjacking counts for cities in the dataset from 2021 to 2025.";
const outGeneric = validateExplanationEntities(GENERIC_NARRATIVE, [], []);
assert.equal(outGeneric, GENERIC_NARRATIVE, "safe case: generic wording must pass through byte-identical");
assert.doesNotMatch(outGeneric, /dataset City/, "safe case: no malformed token introduced");

// ------------------------------------------------- TRUE POSITIVE: real hallucination still caught
// The question and SQL are about Baltimore; a narrative naming Phoenix is a
// genuine hallucination and must still be replaced.
const HALLUCINATED = "This data contains carjacking counts for Phoenix from 2021 to 2025.";
const outHallucinated = validateExplanationEntities(HALLUCINATED, [], resolved7772);
assert.doesNotMatch(outHallucinated, /Phoenix/, "true positive: an ungrounded city must still be replaced");
assert.match(outHallucinated, /cities in the dataset/, "true positive: generic substitution must still apply");

// ------------------------------------------------- geos must be untouched (no guardrail perturbation)
const ctxNoPlace = extractQueryContext(SQL_7772, Q_7772, "nibrs");
assert.deepEqual(ctxNoPlace.geos, [], "ctx.geos must remain empty — guardrails depend on it");
assert.ok(Array.isArray(ctxNoPlace.resolvedPlaces), "resolvedPlaces must be an array");

// An already-resolvable query must not pay for the resolver fallback.
const ctxWithAgency = extractQueryContext(
  "SELECT year, murder FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il'",
  "police staffing in Chicago since 1980",
  "historical"
);
assert.deepEqual(ctxWithAgency.geos, ["Chicago"], "SQL-derived geos must still be extracted");
assert.deepEqual(ctxWithAgency.resolvedPlaces ?? [], [], "resolver fallback must not run when geos are present");

console.log("explain entity preservation tests passed");
