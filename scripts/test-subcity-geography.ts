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
 * application's own two generated catalogs, in six sentence shapes each, and requires zero
 * of them to be read as a sub-city request. It is a control against a term-specific fix,
 * and its limits are stated plainly: it covers the catalogs this repo generates, not an
 * exhaustive national gazetteer, and six templated contexts, not every phrasing a person
 * can write. Its first version used one shape — `Name, ST` — which was the very shape the
 * predicate special-cased, and it therefore missed three false refusals that a review
 * found by hand.
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
  "Which ward of New Orleans had the most murders in 2022?",
  "How many murders were reported in the Uptown ward of New Orleans in 2022?",
  // Codex review 2026-09-02: weak determiners the first revision missed entirely. A place
  // name takes none of these, and in each the term is the head of its noun phrase. Each
  // names a real city as well, because an unresolvable place phrase costs `buildQueryContract`
  // seconds of fuzzy matching per source and the determiner is what is under test here.
  "How many murders were reported in a ward of New Orleans, LA in 2022?",
  "How many murders were reported in our ward in New Orleans, LA in 2022?",
  "How many murders were reported in your ward in New Orleans, LA in 2022?",
  "How many murders were reported in my ward in New Orleans, LA in 2022?",
  "How many murders were reported in an Uptown ward in New Orleans, LA in 2022?",
  // A named ward longer than one naming word. Bounded disposition: up to two naming words
  // between the determiner and the term are recognised, and a longer name is not — a
  // deliberate stopping point, recorded rather than extended indefinitely.
  "How many murders were reported in the French Quarter ward in New Orleans, LA in 2022?",
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
  // A determiner in front of the place name does not make it a geography. The first three
  // are the false refusals the Codex review of 2026-09-02 found in the first revision:
  // the state spelled out, no state at all, and the name used adjectivally. None of them
  // is rescued by a place-qualifier list, which is why the predicate tests the term's
  // syntactic role instead.
  "How many murders did the Ward, Arkansas police department report in 2022?",
  "How many murders did the Ward police department report in 2022?",
  "What was the Ward murder rate in 2022?",
  "How many murders did the Ward, AR police department report in 2022?",
  "How many murders were reported in the Ward County, ND area in 2022?",
  "How many murders did the Ward sheriff's office report in 2022?",
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
 * this test's own output under unrelated rules; the logger is muted for the calls below.
 */
function muted<T>(fn: () => T): T {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
  }
}

/**
 * WHY THE SWEEP DOES NOT RE-EXTRACT PER CASE. `extractQueryContext` fuzzy-resolves an
 * unfamiliar place-like phrase against ~14k catalog names — 423 ms for a single adversarial
 * case here, and the sweep is 54 cases × 4 tabs. The sub-city guardrail's `match` reads
 * exactly one field, `ctx.question`, so the sweep substitutes that field into a context
 * extracted once per tab, and `assertRealExtractionPath()` below pays for the real thing on
 * the cases where fidelity actually matters.
 */
const GUARDRAIL_BASE_CTX = new Map(
  GUARDRAIL_TABS.map((tab) => [
    tab,
    muted(() =>
      extractQueryContext("SELECT 1", "How many murders were reported in Chicago, IL in 2022?", tab)
    ),
  ])
);

function guardrailFired(question: string, tab: Tab): boolean {
  const base = GUARDRAIL_BASE_CTX.get(tab);
  assert(base, `no base context for ${tab}`);
  return muted(() =>
    runGuardrails({ ...base, question }).fired.includes("sub-city-geography-override")
  );
}

/**
 * The unsubstituted path: a real `extractQueryContext` for the reported false refusal and
 * for a genuine sub-city request, on every tab. This is what proves the question reaches the
 * guardrail unchanged, so the substitution above is an optimisation and not a different test.
 */
function assertRealExtractionPath(question: string, tab: Tab, expected: boolean) {
  const ctx = muted(() => extractQueryContext("SELECT 1", question, tab));
  check(ctx.question === question, `${tab}: extraction should carry the question through unchanged`);
  const fired = muted(() => runGuardrails(ctx).fired.includes("sub-city-geography-override"));
  check(
    fired === expected,
    `${tab}: real extraction path should ${expected ? "block" : "allow"}: ${question}`
  );
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

/**
 * The Codex review's nine adversarial strings, verbatim as it reported them. Their
 * city-named twins in BLOCK_CASES carry the full four-stage matrix; these are asserted at
 * the shared predicate only, because an unresolvable place phrase costs seconds per source
 * in `buildQueryContract` and what is under test here is the predicate's reading. Keeping
 * the exact strings means a future revision is measured against what was actually reported,
 * not against a paraphrase of it.
 */
const CODEX_REVIEW_CASES: Array<[string, boolean]> = [
  ["How many murders did the Ward, Arkansas police department report in 2022?", false],
  ["How many murders did the Ward police department report in 2022?", false],
  ["What was the Ward murder rate in 2022?", false],
  ["crime in a ward", true],
  ["crime in our ward", true],
  ["crime in your ward", true],
  ["crime in my ward", true],
  ["crime in an Uptown ward", true],
  ["crime in the French Quarter ward", true],
];
for (const [question, expected] of CODEX_REVIEW_CASES) {
  check(
    asksSubCityGeography(question) === expected,
    `Codex review case should ${expected ? "block" : "allow"}: ${question}`
  );
}

for (const tab of GUARDRAIL_TABS) {
  assertRealExtractionPath("How many murders were reported in Ward, AR in 2022?", tab, false);
  assertRealExtractionPath("How many murders did the Ward police department report in 2022?", tab, false);
  assertRealExtractionPath("How many murders were reported in the 5th ward of New Orleans, LA in 2022?", tab, true);
  assertRealExtractionPath("How many murders were reported in the French Quarter ward in New Orleans, LA in 2022?", tab, true);
}

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

/**
 * SIX SENTENCE SHAPES, NOT ONE. The first revision surveyed only `${name}, ${state}`,
 * which always put a comma and a two-letter abbreviation immediately after the token —
 * precisely the form its own lookahead exempted. A survey that only exercises the shape
 * the predicate special-cases proves nothing about the others, and the Codex review of
 * 2026-09-02 found three false refusals hiding in the shapes it never tried.
 *
 * These templates cover: the catalog's own alias forms (comma or space, abbreviation or
 * full state name), the unqualified name, the name in front of an agency noun, the name
 * used adjectivally, and the name after a determiner. They are still templates — see the
 * limit recorded below.
 */
function placeContexts(name: string, aliases: string[]): string[] {
  return [
    ...aliases.map((alias) => `How many murders were reported in ${alias} in 2022?`),
    `How many murders were reported in ${name} in 2022?`,
    `How many murders did the ${name} police department report in 2022?`,
    `What was the ${name} murder rate in 2022?`,
    `How many murders were reported in the ${name} area in 2022?`,
    `Compare murders in ${name} and Chicago in 2022.`,
  ];
}

const PLACE_NAMES: Array<{ name: string; contexts: string[] }> = [
  ...GENERATED_GEO_CITIES.map((c) => ({
    name: c.name,
    contexts: placeContexts(c.name, c.aliases),
  })),
  ...GENERATED_AMBIGUOUS_COUNTIES.map((c) => ({
    name: c.name,
    contexts: placeContexts(`${c.name} County`, [
      `${c.name} County, ${c.states[0]}`,
      `${c.name} County ${c.states[0]}`,
    ]),
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

// The whole inventory, through the real predicate, in all six shapes: no place name may
// read as a sub-city request in any of them.
const falseRefusals: string[] = [];
let contextsScanned = 0;
for (const place of PLACE_NAMES) {
  for (const context of place.contexts) {
    contextsScanned++;
    if (asksSubCityGeography(context)) falseRefusals.push(context);
  }
}
check(
  falseRefusals.length === 0,
  `${falseRefusals.length} place references read as sub-city requests, e.g. ` +
    falseRefusals.slice(0, 5).map((q) => `"${q}"`).join("; ")
);

// The templates must actually be able to fail, or "zero false refusals" is a statement
// about the template rather than about the predicate. A genuine sub-city phrase poured
// through the same shapes has to come back refused.
const TEMPLATE_CONTROL = placeContexts("5th ward", ["5th ward, LA"]);
check(
  TEMPLATE_CONTROL.every((context) => asksSubCityGeography(context)),
  "survey templates cannot detect a sub-city phrase — the scan proves nothing"
);

console.log(
  `\nsub-city geography tests passed: ${checks} assertions — ` +
    `${BLOCK_CASES.length} blockers, ${ALLOW_CASES.length} negative controls, ` +
    `${SOURCES.length} sources, ${GUARDRAIL_TABS.length} guardrail tabs, ` +
    `${PLACE_NAMES.length} catalog place names surveyed in ${contextsScanned} sentence contexts`
);
