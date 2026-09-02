#!/usr/bin/env npx tsx
/**
 * Sub-city geography — one predicate, every enforcement stage.
 *
 * WHY THIS TEST HAS FOUR STAGES. The refusal of "Ward, AR" was decided in two different
 * places (docs/superpowers/2026-09-02-p3-1a-ward-production-path-diagnostic.md): the
 * pre-SQL override the query/shr/hc routes call before any SQL exists, and the post-SQL
 * capability rule. A fix to either alone would have left the request declined. Every case
 * below is therefore asserted at all four consumers of the predicate — the front-door
 * override, the NIBRS wrapper, the source-capability rule across all five sources, and the
 * guardrail — and the four are required to AGREE. A future change that repairs one stage
 * and not another fails here rather than in production.
 *
 * WHY THERE IS A SURVEY. Fixing the one reported question would have been a Ward-shaped
 * patch. The survey below runs the real predicate over every place name in this
 * application's own two generated catalogs and requires zero of them to be read as a
 * sub-city request. It is a control against a term-specific fix, and its limit is stated
 * plainly: it covers the catalogs this repo generates, not an exhaustive national
 * gazetteer.
 *
 * Deterministic. No database, no model, no network, no server, no production request.
 *
 * Usage: npx tsx scripts/test-subcity-geography.ts
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  PLACE_COLLIDING_SUB_CITY_TERMS,
  SUB_CITY_GEOGRAPHY_MESSAGE,
  UNAMBIGUOUS_SUB_CITY_ALTERNATIVES,
  asksSubCityGeography,
  detectSubCityGeographyOverride,
} from "../lib/capability-overrides";
import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides";
import { buildQueryContract, type QueryContractSource } from "../lib/query-contract";
import { validateSourceCapabilities } from "../lib/source-capabilities";
import { extractQueryContext } from "../lib/query-context";
import { runGuardrails } from "../lib/guardrails";
import type { Tab } from "../lib/query-context";
import { GENERATED_GEO_CITIES } from "../lib/generated/geo-cities";
import { GENERATED_AMBIGUOUS_COUNTIES } from "../lib/generated/ambiguous-counties";

const SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

/** The tabs the sub-city guardrail itself declares in lib/guardrails.ts. */
const GUARDRAIL_TABS: Tab[] = ["current", "historical", "nibrs", "shr"];

const REPO_ROOT = path.resolve(__dirname, "..");

const BLOCK_CASES = [
  // Unambiguous alternatives — coverage that existed before the structural correction and
  // must be unchanged by it.
  "murders by ZIP code in Chicago",
  "crime by neighborhood in Houston",
  "fatal shootings by census tract in Chicago",
  "hate crimes by precinct in New York",
  "crime by ward in DC",
  "assaults by block group in Atlanta",
  "burglaries by police district in Baltimore",
  "robberies by community area in Chicago",
  "calls at Oakwood apartment complex in Dallas",
  "crime around Lakeside housing complex in Phoenix",
  // The frozen v3 positive control, reused verbatim (frozen-cases-v3.json P31A-001).
  "How many murders were reported in the Englewood neighborhood of Chicago, IL in June 2026?",
  // Genuine sub-city STRUCTURE on the place-colliding term. These are what the correction
  // must keep refusing while it stops refusing the city of the same name.
  "How many murders were reported in the 5th ward of New Orleans, LA in 2022?",
  "How many murders were reported in ward 9 of New Orleans, LA in 2022?",
  "How many murders were reported in the Ninth Ward of New Orleans in 2022?",
  "How many murders were reported in each ward of New Orleans in 2022?",
  "How many wards of New Orleans reported a murder in 2022?",
  "Break murders in New Orleans down to the ward level for 2022.",
  "What were New Orleans's murders per ward in 2022?",
  "Give me a ward-by-ward breakdown of murders in New Orleans in 2022.",
  // Genuine precinct structures named in the correction contract.
  "How many aggravated assaults were reported in the Uptown precinct of Denver, CO in 2022?",
  "How many robberies were reported in precinct 12 in Chicago, IL in 2022?",
  // A place name AND a genuine sub-city geography in one question: the sub-city part still
  // decides, so the mixed case is refused rather than silently half-answered.
  "Compare murders in Ward, AR with the 5th ward of New Orleans in 2022.",
];

const ALLOW_CASES = [
  // Negative controls that existed before the correction.
  "which cities are in Santa Clara County",
  "crime in Kansas City, Missouri",
  "violent crime in Washington State",
  "violent crime in communities of 250k or more",
  "apartment burglaries in Dallas",
  "burglaries at apartments in Dallas",
  "community policing related crimes",
  "police departments in Cook County Illinois",
  "which agencies are included in Baltimore County Maryland",
  "crime in New York City by year",
  // THE REPORTED FALSE REFUSAL. Verbatim from frozen-cases-v3.json P31A-002/005/008/011/014,
  // whose adjudicated expectation is `does_not_apply / not_declined_by_this_rule`. Ward,
  // Arkansas is an incorporated city (`city:AR:ward`, lib/generated/geo-cities.ts).
  "How many murders were reported in Ward, AR in 2022?",
  // The same place in the other forms a user writes it, including the Census NAME form
  // ("Ward city") and the county of the same name in ND and TX.
  "How many murders were reported in Ward city, Arkansas in 2022?",
  "How many murders were reported in Ward County, ND in 2022?",
  "What was the murder rate in Ward, Arkansas in 2022?",
  "Compare murders in Ward, AR and Little Rock, AR in 2022.",
  // A determiner in front of the place name does not make it a geography.
  "How many murders did the Ward, AR police department report in 2022?",
  "How many murders were reported in the Ward County, ND area in 2022?",
  // Frozen v3 ordinary-city controls (P31A-003 / P31A-009), so an over-broad correction that
  // began refusing plain city questions would fail here too.
  "How many murders were reported in Chicago, IL in June 2026?",
  "How many aggravated assaults were reported in Phoenix, AZ in 2022?",
];

let checks = 0;
function check(cond: boolean, message: string) {
  assert(cond, message);
  checks++;
}

/* ------------------------------------------------------------------ */
/*  Stage readings                                                     */
/* ------------------------------------------------------------------ */

function sourceCapabilityIds(question: string, source: QueryContractSource): string[] {
  const contract = buildQueryContract(question, source);
  assert(contract, `${source}: expected contract for "${question}"`);
  return validateSourceCapabilities({
    question,
    source,
    contract,
    sql: "SELECT 1",
  }).map((finding) => finding.ruleId);
}

/**
 * The guardrail stage. runGuardrails() logs for every guardrail that fires, which would bury
 * this test's own output under unrelated rules; the logger is muted for the sweep only.
 */
function guardrailFired(question: string, tab: Tab): boolean {
  const originalLog = console.log;
  console.log = () => {};
  try {
    const ctx = extractQueryContext("SELECT 1", question, tab);
    return runGuardrails(ctx).fired.includes("sub-city-geography-override");
  } finally {
    console.log = originalLog;
  }
}

/**
 * Every stage's reading of one question. `expected` is what all of them must say.
 */
function assertAllStagesAgree(question: string, expected: boolean) {
  const label = expected ? "block" : "allow";

  check(
    asksSubCityGeography(question) === expected,
    `shared predicate should ${label}: ${question}`
  );

  // Stage A — the pre-SQL front-door override the query/shr/hc routes call directly.
  const override = detectSubCityGeographyOverride(question);
  if (expected) {
    check(
      override?.guardrail === "sub-city-geography-unsupported",
      `front-door override should block: ${question}`
    );
    check(
      override?.explanation === SUB_CITY_GEOGRAPHY_MESSAGE,
      `front-door override should use shared message: ${question}`
    );
    check(
      !/NIBRS|local police|open data|CompStat/i.test(override?.explanation || ""),
      `override should not suggest another source: ${question}`
    );
  } else {
    check(override === null, `front-door override should not block: ${question}`);
  }

  // Stage A — the NIBRS wrapper, which reaches the same override through its own path.
  const nibrsOverride = detectNibrsCapabilityOverride(question);
  if (expected) {
    check(
      nibrsOverride?.guardrail === "sub-city-geography-unsupported",
      `NIBRS wrapper should block before other overrides: ${question}`
    );
  } else {
    check(
      nibrsOverride?.guardrail !== "sub-city-geography-unsupported",
      `NIBRS wrapper should not use sub-city refusal: ${question}`
    );
  }

  // Stage B — the post-SQL capability rule, all five sources.
  for (const source of SOURCES) {
    const fired = sourceCapabilityIds(question, source).includes("unsupported-sub-city-geography");
    check(fired === expected, `${source}: source-capability rule should ${label}: ${question}`);
  }

  // The guardrail predicate, on every tab the guardrail declares.
  for (const tab of GUARDRAIL_TABS) {
    check(guardrailFired(question, tab) === expected, `${tab}: guardrail should ${label}: ${question}`);
  }
}

for (const question of BLOCK_CASES) assertAllStagesAgree(question, true);
for (const question of ALLOW_CASES) assertAllStagesAgree(question, false);

/* ------------------------------------------------------------------ */
/*  One predicate: no consumer may re-implement or bypass it           */
/* ------------------------------------------------------------------ */

const CONSUMER_ENTRY_POINTS: Array<[string, string]> = [
  ["app/api/query/route.ts", "detectSubCityGeographyOverride("],
  ["app/api/shr-query/route.ts", "detectSubCityGeographyOverride("],
  ["app/api/hc-query/route.ts", "detectSubCityGeographyOverride("],
  ["lib/nibrs-capability-overrides.ts", "detectSubCityGeographyOverride("],
  ["app/api/nibrs-query/route.ts", "detectNibrsCapabilityOverride("],
  ["lib/source-capabilities.ts", "asksSubCityGeography("],
  ["lib/guardrails.ts", "asksSubCityGeography("],
];

for (const [file, needle] of CONSUMER_ENTRY_POINTS) {
  const src = fs.readFileSync(path.join(REPO_ROOT, file), "utf8");
  check(src.includes(needle), `${file} should reach the sub-city decision through ${needle}`);
}

// The old exported regex is gone, and no consumer carries its own copy of the token list.
const BYPASS_SCAN_FILES = [
  ...CONSUMER_ENTRY_POINTS.map(([file]) => file),
  "lib/query-contract-validator.ts",
  "lib/capability-decision.ts",
];
for (const file of BYPASS_SCAN_FILES) {
  const full = path.join(REPO_ROOT, file);
  if (!fs.existsSync(full)) continue;
  const src = fs.readFileSync(full, "utf8");
  check(!src.includes("SUB_CITY_GEOGRAPHY_RE"), `${file} should not use a raw sub-city regex`);
  check(
    !/\\b\(?[^\n]*wards\?/.test(src),
    `${file} should not re-implement the sub-city token list`
  );
}

/* ------------------------------------------------------------------ */
/*  Bounded collision survey                                           */
/* ------------------------------------------------------------------ */

/**
 * Every alternative in the detector, classified, and the classification measured against the
 * two place catalogs this repo generates. A term that appears in either catalog as a
 * standalone place name may not be classified unambiguous — that is the rule that makes this
 * a survey rather than a Ward-specific fix.
 *
 * LIMIT, stated rather than implied: these catalogs are this application's own place
 * inventory (city rows derived from Current + Historical reporting agencies, and multi-state
 * county names). Absence from them is not proof that no United States place carries the
 * name. No new dataset, database, or network source was consulted.
 */
type SurveyRow = { alternative: string; klass: "unambiguous" | "place-colliding"; hits: string[] };

const PLACE_NAMES: Array<{ name: string; qualified: string }> = [
  ...GENERATED_GEO_CITIES.map((c) => ({
    name: c.name,
    qualified: `How many murders were reported in ${c.name}, ${c.state} in 2022?`,
  })),
  ...GENERATED_AMBIGUOUS_COUNTIES.map((c) => ({
    name: c.name,
    qualified: `How many murders were reported in ${c.name} County, ${c.states[0]} in 2022?`,
  })),
];

function termHits(pattern: string): string[] {
  const re = new RegExp(`\\b(?:${pattern})\\b`, "i");
  const seen = new Set<string>();
  for (const place of PLACE_NAMES) if (re.test(place.name)) seen.add(place.name);
  return Array.from(seen).sort();
}

const survey: SurveyRow[] = [
  ...UNAMBIGUOUS_SUB_CITY_ALTERNATIVES.map((alternative): SurveyRow => ({
    alternative,
    klass: "unambiguous",
    hits: termHits(alternative),
  })),
  ...PLACE_COLLIDING_SUB_CITY_TERMS.map((term): SurveyRow => ({
    alternative: `${term}s?`,
    klass: "place-colliding",
    hits: termHits(`${term}s?`),
  })),
];

console.log("\nsub-city alternative survey (against this repo's generated place catalogs):");
for (const row of survey) {
  const hits = row.hits.length ? `${row.hits.length} (${row.hits.join(", ")})` : "0";
  console.log(`  ${row.klass.padEnd(16)} ${row.alternative.padEnd(34)} place-name hits: ${hits}`);
}

for (const row of survey) {
  check(
    row.klass === "place-colliding" || row.hits.length === 0,
    `alternative "${row.alternative}" is classified unambiguous but matches place names ` +
      `${row.hits.join(", ")} — it must move to PLACE_COLLIDING_SUB_CITY_TERMS`
  );
}

// The survey has teeth only if at least one term actually collides; a run where nothing was
// found would otherwise pass forever without measuring anything.
check(
  survey.some((row) => row.klass === "place-colliding" && row.hits.length > 0),
  "survey found no place-name collision at all — the scan is not reaching the catalogs"
);

// The whole inventory, through the real predicate: no place name may read as a sub-city
// request in ordinary place-name position.
const falseRefusals = PLACE_NAMES.filter((place) => asksSubCityGeography(place.qualified));
check(
  falseRefusals.length === 0,
  `place names read as sub-city requests: ${falseRefusals.slice(0, 10).map((p) => p.name).join(", ")}`
);

console.log(
  `\nsub-city geography tests passed: ${checks} assertions — ` +
    `${BLOCK_CASES.length} blockers, ${ALLOW_CASES.length} negative controls, ` +
    `${SOURCES.length} sources, ${GUARDRAIL_TABS.length} guardrail tabs, ` +
    `${PLACE_NAMES.length} catalog place names surveyed`
);
