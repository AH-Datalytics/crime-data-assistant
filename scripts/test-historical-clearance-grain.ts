// Historical state-clearance property: Historical carries clearance nationally and per agency, and
// nothing in between, so a state-grain clearance request has no correct answer.
//
// OBSERVATION ONLY in this increment. These tests assert what is OBSERVED, and one of them asserts
// that observing changes nothing a caller acts on.
//
// Both directions are equally binding. A rule that declines "the rape rate in Florida" -- a crime
// rate, not a clearance rate -- has failed, not over-delivered.

import { buildQueryContract } from "../lib/query-contract";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import {
  clearanceMeasureColumn,
  observeHistoricalClearanceGrain,
  type ClearanceGrainReason,
} from "../lib/historical-clearance-grain";
import fs from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
let gaps = 0;

/**
 * A KNOWN GAP in the existing typed resolver, recorded rather than papered over.
 *
 * These assert what the resolver does TODAY and print a GAP line. They are counted separately from
 * passes so the suite never claims coverage it does not have: a gap turning into a pass is a
 * deliberate decision someone has to make, not a silent improvement.
 */
function gap(name: string, fn: () => void) {
  try {
    fn();
    gaps++;
    console.log(`  GAP   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name} (gap assertion no longer holds -- re-decide it)`);
    console.log(`        ${(e as Error).message}`);
  }
}

function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(e as Error).message}`);
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

/** Observe a question the way the route would: build the typed contract, then classify it. */
function observe(question: string, source: "historical" | "nibrs" | "shr" = "historical") {
  const contract = buildQueryContract(question, source, null);
  assert(Boolean(contract), `no contract built for: ${question}`);
  return observeHistoricalClearanceGrain(contract!);
}

function expectReason(question: string, reason: ClearanceGrainReason) {
  const o = observe(question);
  assert(o !== null, `expected a ${reason} observation, got none: ${question}`);
  assert(o!.reason === reason, `expected ${reason}, got ${o!.reason}: ${question}`);
  return o!;
}

function expectAllowed(question: string) {
  const o = observe(question);
  assert(o === null, `expected no observation, got ${o?.reason} (${o?.message?.slice(0, 60)}): ${question}`);
}

/* ---------------------------------------------------------------- */
/*  The class: every state, every supported measure, every phrasing  */
/* ---------------------------------------------------------------- */

console.log("\n-- a state-grain clearance request is observed, across states/measures/phrasings --");

// Generated, not a hand-listed set of Florida cases. States span full names, postal codes and casing;
// measures span every topic that has a `*_clr` column; phrasings span count/trend/comparison/ranking.
// Full names with casing variants. Every entry is verified below to resolve to kind "state"; bare
// postal codes and the New York city/state collision are recorded as gaps further down instead of
// being quietly dropped from the matrix.
const STATES = [
  "Florida", "florida", "Texas", "california", "Ohio", "Pennsylvania",
  "Georgia", "Michigan", "Illinois", "Arizona", "Oregon", "Alabama",
];
const MEASURES = [
  "rape", "murder", "robbery", "aggravated assault",
  "burglary", "theft", "motor vehicle theft", "violent crime", "property crime",
];
const PHRASINGS: Array<(m: string, s: string) => string> = [
  (m, s) => `What is the ${m} clearance rate in ${s}?`,
  (m, s) => `What is the ${m} clearance rate in ${s} by year?`,
  (m, s) => `Show the ${m} clearance rate trend in ${s} since 2000`,
  (m, s) => `How often are ${m} cases solved in ${s}?`,
  (m, s) => `What share of ${m} cases were cleared in ${s} in 2020?`,
];

check("every state in the matrix really resolves to state grain", () => {
  // Guards the matrix itself: if a resolver change turns one of these into a city or unknown, the
  // matrix below would silently shrink to fewer real cells.
  const wrong: string[] = [];
  for (const s of STATES) {
    const c = buildQueryContract(`What is the rape clearance rate in ${s}?`, "historical", null);
    const geos = c ? (c.geographies?.length ? c.geographies : [c.geography]) : [];
    if (!geos.some((g) => g.kind === "state")) wrong.push(`${s} -> ${geos.map((g) => g.kind).join(",") || "none"}`);
  }
  assert(wrong.length === 0, `matrix states not resolving to state grain: ${wrong.join("; ")}`);
});

check("every state x supported measure x phrasing is observed as a state-grain finding", () => {
  const misses: string[] = [];
  let cells = 0;
  for (const s of STATES) {
    for (const m of MEASURES) {
      for (const phrase of PHRASINGS) {
        const q = phrase(m, s);
        cells++;
        const o = observe(q);
        if (!o || o.reason !== "historical-state-clearance-no-aggregate") {
          misses.push(`${q} -> ${o ? o.reason : "none"}`);
        }
      }
    }
  }
  assert(cells === STATES.length * MEASURES.length * PHRASINGS.length, `cell count wrong: ${cells}`);
  assert(misses.length === 0, `${misses.length}/${cells} cells not observed, first 3:\n        ${misses.slice(0, 3).join("\n        ")}`);
  console.log(`        ${cells} generated cells`);
});

check("the permanent Florida rape regression", () => {
  const o = expectReason("What is the rape clearance rate in Florida by year?", "historical-state-clearance-no-aggregate");
  assert(o.stateName === "Florida", `expected stateName Florida, got ${o.stateName}`);
  assert(o.topic === "rape", `expected topic rape, got ${o.topic}`);
});

check("a two-state comparison is observed, not just a single state", () => {
  expectReason("Compare rape clearance rates in Florida and Georgia", "historical-state-clearance-no-aggregate");
});

check("a state in a NON-PRIMARY geography slot is still observed", () => {
  // The decisive case for traversing every resolved geography. "Compare rape clearance rates in
  // Florida and Georgia" resolves Florida as the PRIMARY geography, so it is caught even by code
  // that only ever looks at the primary -- which is how a mutation removing the traversal survived
  // the first matrix. Here the primary is city:Miami and the state is second in the list, so only
  // real traversal observes it.
  const contract = buildQueryContract("Compare rape clearance rates in Miami and Florida", "historical", null)!;
  assert(contract.geography.kind === "city", `expected a city primary, got ${contract.geography.kind}`);
  const o = observeHistoricalClearanceGrain(contract);
  assert(o !== null, "a state in a non-primary slot was not observed");
  assert(o!.reason === "historical-state-clearance-no-aggregate", `wrong reason: ${o!.reason}`);
  assert(o!.stateName === "Florida", `expected Florida, got ${o!.stateName}`);
});

gap("a possessive comparison resolves nothing: \"Miami's ... compare to Florida's\" -> unknown", () => {
  // The possessive form defeats the existing place resolver, so neither place is resolved and the
  // rule cannot see the state. A phrasing gap in resolution, not in this property.
  const c = buildQueryContract("How does Miami's rape clearance rate compare to Florida's?", "historical", null)!;
  const geos = c.geographies?.length ? c.geographies : [c.geography];
  assert(geos.every((g) => g.kind === "unknown"), `expected unknown, got ${geos.map((g) => g.kind).join(",")}`);
  assert(observeHistoricalClearanceGrain(c) === null, "now observed -- re-decide this gap");
});

gap("cross-state RANKING is not observed: no single state is resolved", () => {
  // "Which states have the highest murder clearance rates?" resolves geography kind "unknown".
  // The contract has no plural-state grain, so this shape cannot be detected by resolved geography.
  // It is the same missing quantity as the Florida case and SHOULD decline; detecting it needs a
  // grain notion the contract does not carry, which is a scope change, not a fix here.
  assert(observe("Which states have the highest murder clearance rates?") === null,
    "cross-state ranking is now observed -- the gap is closed, update the contract deliberately");
});

gap("cross-state COMPARISON mis-resolves to a city: \"across all states\" -> city Ball, LA", () => {
  // A spurious fuzzy match in the existing place resolver. It makes a cross-state comparison look
  // like an agency question, so this rule allows it. Reported as a resolver defect, not patched here.
  const c = buildQueryContract("Compare murder clearance rates across all states", "historical", null)!;
  const geos = c.geographies?.length ? c.geographies : [c.geography];
  assert(geos.some((g) => g.kind === "city"), `expected the spurious city match, got ${geos.map((g) => g.kind).join(",")}`);
  assert(observeHistoricalClearanceGrain(c) === null, "now observed -- re-decide this gap");
});

gap("a bare postal code is not resolved as a state: \"FL\" -> unknown", () => {
  // The contract I wrote promised postal-code spellings would decline. The existing resolver does not
  // resolve a bare code to a state, so keying on kind === "state" cannot deliver that promise.
  for (const code of ["FL", "WA"]) {
    const c = buildQueryContract(`What is the rape clearance rate in ${code}?`, "historical", null)!;
    const geos = c.geographies?.length ? c.geographies : [c.geography];
    assert(!geos.some((g) => g.kind === "state"), `${code} now resolves to a state -- the gap is closed`);
    assert(observeHistoricalClearanceGrain(c) === null, `${code} is now observed -- re-decide this gap`);
  }
});

gap("\"New York\" resolves to the CITY, so the state reading is not observed", () => {
  // Genuinely ambiguous input. A user meaning the state gets an agency-grain answer today. Resolving
  // it is a geo-disambiguation product decision, outside this increment.
  const c = buildQueryContract("What is the rape clearance rate in New York?", "historical", null)!;
  const geos = c.geographies?.length ? c.geographies : [c.geography];
  assert(geos.some((g) => g.kind === "city"), `expected city, got ${geos.map((g) => g.kind).join(",")}`);
  assert(observeHistoricalClearanceGrain(c) === null, "now observed -- re-decide this gap");
});

/* ---------------------------------------------------------------- */
/*  False-refusal controls: each must stay allowed                   */
/* ---------------------------------------------------------------- */

console.log("\n-- what Historical CAN answer stays allowed --");

check("agency-grain clearance stays allowed", () => {
  expectAllowed("What is the rape clearance rate in Gainesville, Florida?");
});

check("a city question inside a state is agency grain, not state grain", () => {
  // The trap: this carries state: "Florida" with kind: "city". Keying on `state` instead of `kind`
  // would turn every city clearance question into a false decline.
  const contract = buildQueryContract("What is the murder clearance rate in Miami?", "historical", null)!;
  assert(observeHistoricalClearanceGrain(contract) === null, "a city question was observed as state grain");
});

check("agency-to-agency comparison stays allowed", () => {
  expectAllowed("Compare murder clearance rates in Miami and Tampa");
});

check("national clearance stays allowed", () => {
  expectAllowed("What is the national rape clearance rate by year?");
});

check("United States follows the national path, not the state path", () => {
  expectAllowed("What is the murder clearance rate in the United States?");
});

check("a state CRIME rate is not a clearance rate", () => {
  expectAllowed("What is the rape rate in Florida by year?");
});

check("a state crime count is unaffected", () => {
  expectAllowed("How many rapes were reported in Florida in 2023?");
});

check("a non-clearance state question is unaffected", () => {
  expectAllowed("How many murders were there in Texas in 2020?");
});

/* ---------------------------------------------------------------- */
/*  Real corpus questions the shadow measurement caught me refusing  */
/* ---------------------------------------------------------------- */

console.log("\n-- not knowing WHICH measure was asked for is not knowing it is absent --");

// Every one of these is a real logged Historical question that an earlier version of this rule
// observed as "measure absent", purely because no specific offense resolved (topic "unknown" or
// "crime", offenses []). All were answered correctly at the time. Enforcing that version would have
// declined ten working questions. These are now permanent regressions.
const UNRESOLVED_OFFENSE_BUT_LEGITIMATE: Array<[number, string]> = [
  [169, "National clearance rates 1960 to 2024"],
  [1158, "Cities of 250,000 or more, and yes, lowest clearance rate"],
  [2833, "show me violent crimes in salem oregon from 2000 to 2025 with clearance rates"],
  [3139, "How has clearance of violent crimes changed over time?"],
  [6227, "what is the autotheft clearance rate for Albany, New York State by year?"],
  [7521, "Washington DC clearance rate"],
  [7522, "Atlanta clearance rate"],
  [7731, "how do clearance rate for violent and nonviolent crimes in albuquerque new mexico compare against national average and comparable cities"],
  [7888, "how do clearance rates in berkeley compare regionally, statewide, and nationally?"],
];

for (const [id, question] of UNRESOLVED_OFFENSE_BUT_LEGITIMATE) {
  check(`#${id} is not observed: no offense resolved, and its grain is allowed`, () => {
    const contract = buildQueryContract(question, "historical", null)!;
    assert(contract.metric.offenses.length === 0,
      `this case is meant to have NO resolved offense; it now resolves ${contract.metric.offenses.map((o) => o.topic).join(",")}`);
    const o = observeHistoricalClearanceGrain(contract);
    assert(o === null, `observed as ${o?.reason}: ${question.slice(0, 70)}`);
  });
}

check("an unnamed measure at STATE grain still declines, on grain alone", () => {
  // The other side of the same fix: grain is wrong for every offense, so a state clearance question
  // declines even with no offense named -- and the text must not invent an offense.
  const contract = buildQueryContract("What is the clearance rate in Florida?", "historical", null)!;
  const o = observeHistoricalClearanceGrain(contract);
  assert(o !== null, "a state clearance question with no named offense was not observed");
  assert(o!.reason === "historical-state-clearance-no-aggregate", `wrong reason: ${o!.reason}`);
  assert(/statewide clearance rates for Florida/.test(o!.message),
    `expected the offense-free wording, got: ${o!.message}`);
  assert(!/\d/.test(o!.message), "the decline text contains a digit");
});

/* ---------------------------------------------------------------- */
/*  The rape_rate collision, asserted in both directions             */
/* ---------------------------------------------------------------- */

console.log("\n-- the rape_rate name collision, both directions --");

check("state CLEARANCE is observed while state CRIME RATE is not, for the same identifier", () => {
  // national_clearance_rate.rape_rate = percent cleared (27.2 in 2024, and NO state column)
  // historical_state_national.rape_rate = rapes per 100,000 (27.93 for Florida in 2024)
  // Same column name, unrelated quantities, ~0.7 apart. This pair is the whole defect.
  const clearance = observe("What is the rape clearance rate in Florida in 2024?");
  const crimeRate = observe("What is the rape rate in Florida in 2024?");
  assert(clearance !== null, "the state clearance question was not observed");
  assert(clearance!.reason === "historical-state-clearance-no-aggregate", `wrong reason: ${clearance!.reason}`);
  assert(crimeRate === null, `the state crime-rate question was wrongly observed as ${crimeRate?.reason}`);
});

/* ---------------------------------------------------------------- */
/*  Separate facts keep separate reason codes                        */
/* ---------------------------------------------------------------- */

console.log("\n-- missing measure and missing state aggregate are different findings --");

check("a clearance measure Historical does not carry gets its own reason code", () => {
  // Historical has nine `*_clr` columns. Hate crime is not among them, at any grain.
  const o = expectReason("What is the hate crime clearance rate in Florida?", "historical-clearance-measure-absent");
  assert(o.stateName === null, "measure-absent should not claim a state finding");
  assert(clearanceMeasureColumn("hate_crime") === null, "hate_crime should have no clearance column");
});

check("the two reason codes are never the same string", () => {
  const a = expectReason("What is the rape clearance rate in Florida?", "historical-state-clearance-no-aggregate");
  const b = expectReason("What is the hate crime clearance rate in Florida?", "historical-clearance-measure-absent");
  assert(a.reason !== b.reason, "the two findings collapsed to one reason code");
});

check("every supported measure maps to a real *_clr column, and unsupported ones map to none", () => {
  const expected: Record<string, string> = {
    murder: "murder_clr", rape: "rape_clr", robbery: "robbery_clr",
    aggravated_assault: "assault_clr", burglary: "burglary_clr", theft: "theft_clr",
    motor_vehicle_theft: "motor_vehicle_theft_clr", violent_crime: "violent_clr",
    property_crime: "property_clr",
  };
  for (const [topic, column] of Object.entries(expected)) {
    assert(clearanceMeasureColumn(topic) === column, `${topic} -> ${clearanceMeasureColumn(topic)}, expected ${column}`);
  }
  for (const topic of ["hate_crime", "sex_offense", "carjacking", "domestic_violence", "unknown"]) {
    assert(clearanceMeasureColumn(topic) === null, `${topic} should have no clearance column`);
  }
});

/* ---------------------------------------------------------------- */
/*  Wording                                                         */
/* ---------------------------------------------------------------- */

console.log("\n-- the decline text offers alternatives without answering --");

check("the message labels both alternatives and contains no numeric rate", () => {
  const o = expectReason("What is the rape clearance rate in Florida by year?", "historical-state-clearance-no-aggregate");
  const m = o.message;
  assert(/national clearance rate/i.test(m), "the national alternative is not labelled national");
  assert(/individual Florida agencies' reported rates where available/i.test(m),
    "the agency alternative is not labelled as individual reported rates 'where available'");
  // No number at all: the offer must not become an answer, and no availability probe may have run.
  assert(!/\d/.test(m), `the decline text contains a digit, so it may be reporting a rate: ${m}`);
  assert(/cannot be combined/i.test(m), "the message does not say why a state figure is unavailable");
});

check("the measure-absent message names what IS carried, without a number", () => {
  const o = expectReason("What is the hate crime clearance rate in Florida?", "historical-clearance-measure-absent");
  assert(!/\d/.test(o.message), `measure-absent text contains a digit: ${o.message}`);
  assert(/murder, rape, robbery/i.test(o.message), "the message does not name the measures Historical carries");
});

/* ---------------------------------------------------------------- */
/*  Source isolation                                                */
/* ---------------------------------------------------------------- */

console.log("\n-- Historical only --");

check("NIBRS and SHR are never observed by this rule", () => {
  for (const source of ["nibrs", "shr"] as const) {
    const contract = buildQueryContract("What is the rape clearance rate in Florida by year?", source, null);
    if (!contract) continue;
    assert(observeHistoricalClearanceGrain(contract) === null, `${source} was observed by a Historical-only rule`);
  }
});

/* ---------------------------------------------------------------- */
/*  Placement, and proof that observing enforces nothing             */
/* ---------------------------------------------------------------- */

console.log("\n-- placement is pre-execution, and observation is inert --");

check("the observation is computed inside contract validation, before execution", () => {
  const validator = fs.readFileSync(path.join(__dirname, "..", "lib", "query-contract-validator.ts"), "utf8");
  assert(validator.includes("observeHistoricalClearanceGrain(contract)"), "the validator never observes");
  const route = fs.readFileSync(path.join(__dirname, "..", "app", "api", "query", "route.ts"), "utf8");
  const validateAt = route.indexOf("validateQueryContractSql");
  const executeAt = route.search(/db\.prepare\(/);
  assert(validateAt >= 0, "the route no longer calls contract validation; this check is stale");
  assert(executeAt >= 0, "the route no longer executes SQL; this check is stale");
  assert(validateAt < executeAt, "contract validation does not precede execution");
});

check("OBSERVATION ONLY: the finding reaches no field the route acts on", () => {
  const result = validateQueryContractSql({
    question: "What is the rape clearance rate in Florida by year?",
    source: "historical",
    sql: "SELECT year, rape_rate FROM national_clearance_rate ORDER BY year",
    routingMeta: null,
  });
  assert(result.clearanceGrainObservation !== null, "the observation was not recorded at all");
  assert(result.clearanceGrainObservation!.reason === "historical-state-clearance-no-aggregate",
    `unexpected reason: ${result.clearanceGrainObservation!.reason}`);

  const leaked: string[] = [];
  for (const field of ["fired", "warnings", "retryIssues", "blockReasons", "enforced"] as const) {
    for (const entry of result[field]) {
      if (/clearance-grain|state-clearance|clearance-measure-absent/i.test(entry)) leaked.push(`${field}: ${entry}`);
    }
  }
  assert(leaked.length === 0, `the observation leaked into enforcing fields: ${leaked.join("; ")}`);
});

check("an allowed question records no observation through the validator", () => {
  const result = validateQueryContractSql({
    question: "What is the rape rate in Florida by year?",
    source: "historical",
    sql: "SELECT year, rape_rate FROM historical_state_national WHERE state = 'Florida' ORDER BY year",
    routingMeta: null,
  });
  assert(result.clearanceGrainObservation === null,
    `a state crime-rate question was observed as ${result.clearanceGrainObservation?.reason}`);
});

console.log(`\nHistorical clearance grain: ${passed} passed, ${failed} failed, ${gaps} known gaps recorded`);
if (failed > 0) process.exit(1);
