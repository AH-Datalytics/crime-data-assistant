/**
 * City rankings: exact accounting for the request, then the answer it produces.
 *
 * WHAT CHANGED, AND WHY THE SUITE IS ORGANISED THIS WAY. Twice, typed construction was defeated by
 * recognition putting the wrong thing in the slot, and the second attempt's completeness check --
 * a proximity window plus a list of comparison phrasings -- was defeated by four executed requests:
 *
 *   `at least 500 people and under 1000 people`   -> only `>= 500` survived
 *   `population between 100000 and 500000`        -> no condition at all
 *   `at least 1.5 million people`                 -> `>= 5,000,000`
 *   `at least 100 murders and under 200 murders`  -> only `>= 100` survived
 *
 * Recognition now ACCOUNTS for every token: each one is either covered by a clause that binds to a
 * typed field, or matched by a small context-specific presentation rule, and anything left over is
 * an owned decline. So the suite has three obligations, and every section serves one of them:
 *
 *   1. The four counterexamples decline, and their supported near-counterparts still deliver.
 *   2. Every filler rule is paired with a question where a meaning-bearing word sits in the same
 *      slot and the request declines -- so the rules cannot quietly become an ignore list.
 *   3. The saved witnesses, the boundaries and the executed figures are unchanged.
 *
 * Synthetic in-memory fixtures only. No real database, no source, no model, no server.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  recognizeCityRanking, rankingValidationContract, statedPopulationCondition, statedCountThreshold, scanNumbers, offenseToken,
  DEFAULT_RESULT_COUNT, MAX_RESULT_COUNT, SUPPORTED_RATE_BASIS, FILLER_RULES,
  type CityRankingRequest, type CityRankingSource,
} from "../lib/city-ranking";
import { buildCityRanking, resolvePeriod, IDENTITY_UNIQUENESS } from "../lib/city-ranking-builder";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import { deterministicPlanRefusal } from "../lib/deterministic-plan-guard";
import { buildQueryContract } from "../lib/query-contract";
import { planNibrsCityRanking } from "../lib/city-ranking-nibrs";
import { decideCandidates, completenessOf } from "../lib/city-ranking-completeness";
import { accountNibrsRequest, nibrsRecognitionRefusal } from "../lib/nibrs-request-accounting";
import { nibrsUnboundParts, type NibrsApplied } from "../lib/nibrs-legacy-binding";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}`); console.log(`        ${(error as Error).message.split("\n")[0]}`); }
}

/** An OBSERVED cutoff: read from the source, not guessed from the calendar. */
const OBSERVED_FULL = { year: 2025, month: 12, observed: true };
const OBSERVED_PARTIAL = { year: 2025, month: 7, observed: true };
const HEURISTIC = { year: 2025, month: 7, observed: false };

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const nibrs = new Database(":memory:");
nibrs.exec(`
  CREATE TABLE summary_city_monthly(ori TEXT, year INTEGER, month INTEGER, state TEXT, ucr_offense_code TEXT, offense_count INTEGER);
  CREATE TABLE agencies(ori TEXT, year INTEGER, city TEXT, state TEXT, population INTEGER, agency_type TEXT, PRIMARY KEY (ori, year));
`);
const nAgency = nibrs.prepare("INSERT INTO agencies VALUES(?,?,?,?,?,?)");
const nMonth = nibrs.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?,?,?)");
nAgency.run("TX01", 2025, "HOUSTON", "TX", 2300000, "City");
nAgency.run("TX02", 2025, "AUSTIN", "TX", 1000000, "City");
nAgency.run("TX03", 2025, "LUBBOCK", "TX", 260000, "City");   // RECORDED zero
nAgency.run("TX04", 2025, "PLANO", "TX", 290000, "City");     // NO offense record at all
nAgency.run("TX05", 2025, "WACO", "TX", 140000, "City");      // under the 250k floor
nAgency.run("TX07", 2025, "BOUNDARY", "TX", 250000, "City");  // EXACTLY on the 250k boundary
nAgency.run("TX08", 2025, "HAMLET", "TX", 600, "City");       // 600 people: above 500, far below 500k
nAgency.run("NM01", 2025, "ALBUQUERQUE", "NM", 560000, "City"); // wrong state
nAgency.run("TX06", 2025, "HARRIS SO", "TX", 900000, "Sheriff"); // not a city agency
nMonth.run("TX01", 2025, 1, "TX", "23C", 460);
nMonth.run("TX02", 2025, 1, "TX", "23C", 100);
nMonth.run("TX03", 2025, 1, "TX", "23C", 0);      // recorded zero: eligible
nMonth.run("TX05", 2025, 1, "TX", "23C", 700);
nMonth.run("TX07", 2025, 1, "TX", "23C", 50);
nMonth.run("TX08", 2025, 1, "TX", "23C", 6);
nMonth.run("NM01", 2025, 1, "NM", "23C", 900);
nMonth.run("TX06", 2025, 1, "TX", "23C", 800);
nMonth.run("TX03", 2024, 1, "TX", "23C", 999);    // wrong year
nMonth.run("TX03", 2025, 1, "TX", "23H", 888);    // wrong offense (All Other Larceny, not Shoplifting)
nMonth.run("TX01", 2025, 2, "TX", "23C", 460);    // a second month, so the year aggregates
nMonth.run("TX01", 2025, 9, "TX", "23C", 1000);   // AFTER a July cutoff
// Human trafficking rows (64A/64B). Carjacking hotfix (2026-10-10): GC-063 used to rank these as carjackings;
// a carjacking ranking must never read them.
nMonth.run("TX01", 2025, 1, "TX", "64A", 30);
nMonth.run("TX01", 2025, 1, "TX", "64B", 10);
nMonth.run("TX03", 2025, 1, "TX", "64A", 2);
nMonth.run("TX07", 2025, 1, "TX", "64A", 0);
// Murders, for the cross-offense counterpart and the period tests. (NIBRS counts are exercised with
// murders because the contract resolves no unit at all for "shoplifting counts".)
nMonth.run("TX01", 2025, 1, "TX", "09A", 300);
nMonth.run("TX01", 2025, 2, "TX", "09A", 60);
nMonth.run("TX01", 2025, 9, "TX", "09A", 1000);   // AFTER a July cutoff
nMonth.run("TX02", 2025, 1, "TX", "09A", 50);

// GC-063 (answer batch A): carjacking's own derived table, in the production column order. Several months, a
// population change across agency-years, a city under the floor, another state, a non-City agency and an agency of
// unknown type.
nibrs.exec("CREATE TABLE summary_carjacking_monthly(year INTEGER, month INTEGER, state TEXT, ori TEXT, offense_count INTEGER);");
nAgency.run("TX09", 2025, "SAN ANTONIO", "TX", 1500000, "City");
nAgency.run("TX09", 2024, "SAN ANTONIO", "TX", 1400000, "City");    // another year's population is not used for 2025
nAgency.run("TX10", 2025, "UNKNOWNVILLE", "TX", 300000, null);      // otherwise eligible, type unknown
const nCarjack = nibrs.prepare("INSERT INTO summary_carjacking_monthly VALUES(?,?,?,?,?)");
nCarjack.run(2025, 1, "TX", "TX01", 40);
nCarjack.run(2025, 2, "TX", "TX01", 20);    // HOUSTON 60 / 2.3m = 2.61
nCarjack.run(2025, 1, "TX", "TX09", 30);
nCarjack.run(2025, 3, "TX", "TX09", 15);    // SAN ANTONIO 45 / 1.5m = 3.00
nCarjack.run(2024, 1, "TX", "TX09", 99);    // wrong year
nCarjack.run(2025, 1, "TX", "TX02", 5);     // AUSTIN 5 / 1m = 0.50
nCarjack.run(2025, 1, "TX", "TX05", 50);    // WACO: under the 250k floor
nCarjack.run(2025, 1, "NM", "NM01", 80);    // ALBUQUERQUE: another state
nCarjack.run(2025, 1, "TX", "TX06", 70);    // HARRIS SO: not a city agency
nCarjack.run(2025, 1, "TX", "TX10", 9);     // UNKNOWNVILLE: unknown type, so not ranked as a city

const current = new Database(":memory:");
current.exec(`
  CREATE TABLE agency_monthly(ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);
  CREATE TABLE agency_population(ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year));
`);
const cMonth = current.prepare("INSERT INTO agency_monthly VALUES(?,?,?,?,?,?,?,?)");
const cPop = current.prepare("INSERT INTO agency_population VALUES(?,?,?)");
for (const [ori, pop] of [["C1", 700000], ["C2", 500000], ["C3", 240000], ["C4", 480000]] as const) {
  cPop.run(ori, 2025, pop);
}
cMonth.run("C1", "DENVER", "CO", "City", 2025, 1, "Rape", 350);
cMonth.run("C2", "MESA", "AZ", "City", 2025, 1, "Rape", 50);
cMonth.run("C3", "BOISE", "ID", "City", 2025, 1, "Rape", 0);      // recorded zero
cMonth.run("C1", "DENVER", "CO", "City", 2024, 1, "Rape", 999);   // wrong year
cMonth.run("C2", "MESA", "AZ", "City", 2025, 1, "Robbery", 777);  // wrong offense
// OMAHA (C4) has a population row and no offense record: a missing record is not a zero.
// BETA has offense records and NO population row: it belongs in a COUNT ranking.
cMonth.run("C5", "BETA", "NE", "City", 2025, 1, "Murder", 20);
cMonth.run("C1", "DENVER", "CO", "City", 2025, 1, "Murder", 10);

/** Expected figures, computed from the fixtures rather than from any statement under test. */
const expected = {
  // HOUSTON 1920/2.3m, BOUNDARY 50/250k, AUSTIN 100/1m, LUBBOCK 0/260k.
  nibrsTexas250k: ["HOUSTON", "BOUNDARY", "AUSTIN", "LUBBOCK"],
  nibrsShopliftingHouston: 1920,
  nibrsMurderHouston: 1360,
  nibrsMurderHoustonThroughJuly: 360,
  currentCities: ["DENVER", "MESA", "BOISE"],
  murderCountOrder: ["BETA", "DENVER"],
};

const rowsOf = (db: Database.Database, sql: string) => db.prepare(sql).all() as Record<string, unknown>[];
const cityNames = (db: Database.Database, sql: string) => rowsOf(db, sql).map((row) => String(row.city));

/** Recognise, build and execute, so a test states the request and reads the answer. */
function run(
  db: Database.Database, question: string, source: CityRankingSource,
  cutoff: { year: number; month: number; observed: boolean } | null = OBSERVED_FULL,
) {
  const plan = recognizeCityRanking(question, source);
  assert.ok(plan, `expected ${JSON.stringify(question)} to be recognised as a city ranking`);
  assert.equal(plan!.kind, "ranking",
    `expected a plannable ranking for: ${question}${plan!.kind === "unsupported" ? ` (declined: ${(plan as { reason: string }).reason})` : ""}`);
  const built = buildCityRanking(plan as CityRankingRequest, cutoff);
  assert.ok(built, `expected a built statement for: ${question}`);
  return { plan: plan as CityRankingRequest, built: built!, rows: rowsOf(db, built!.sql), names: cityNames(db, built!.sql) };
}

/** Assert the request was recognised as this family AND declined, with its reason. */
function declined(question: string, source: CityRankingSource, reason?: string) {
  const plan = recognizeCityRanking(question, source);
  assert.ok(plan, `expected ${JSON.stringify(question)} to be recognised, not handed back to the model`);
  assert.equal(plan!.kind, "unsupported", `expected ${JSON.stringify(question)} to be declined, not answered`);
  const declinedPlan = plan as { reason: string; explanation: string };
  if (reason) assert.equal(declinedPlan.reason, reason, `declined for ${declinedPlan.reason}, expected ${reason}`);
  assert.doesNotMatch(declinedPlan.explanation, /no data|missing data|not available in the data/i,
    "an honest limitation claims nothing about the data");
  return declinedPlan;
}

/* ------------------------------------------------------------------ *
 * 1. The four executed counterexamples, with their supported counterparts
 * ------------------------------------------------------------------ */

check("COUNTEREXAMPLE 1 — a second adjacent condition is not swallowed", () => {
  const plan = declined("Top 10 cities by murder rate in 2025 with at least 500 people and under 1000 people",
    "current", "multiple-conditions");
  assert.match(plan.explanation, /more than one limit of the same kind/);
  // The counterpart: ONE population condition still delivers, in either direction.
  const up = run(nibrs, "Top 10 cities in Texas with at least 500 people by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(up.plan.eligibility, [{ kind: "population", comparison: ">=", value: 500 }]);
  const down = run(nibrs, "Top 10 cities in Texas with fewer than 250000 people by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(down.plan.eligibility, [{ kind: "population", comparison: "<", value: 250000 }]);
});

check("COUNTEREXAMPLE 2 — an interval nothing accounts for declines, naming the words", () => {
  const plan = declined("Top 10 cities by murder rate in 2025 with population between 100000 and 500000",
    "current", "unaccounted-request");
  assert.match(plan.explanation, /between/, "it quotes what it could not place");
  assert.match(plan.explanation, /100000/);
  /*
   * The design property, not a word list: phrasings nobody enumerated ALSO decline, because nothing
   * consumed them. If this were a list of comparison phrases, each of these would need adding.
   */
  for (const unlisted of [
    "Top 10 cities by murder rate in 2025 with population ranging from 100000 to 500000",
    "Top 10 cities by murder rate in 2025 with population somewhere around 250000",
    "Top 10 cities by murder rate in 2025 with population in the region of 250000",
  ]) {
    declined(unlisted, "current", "unaccounted-request");
  }
});

check("COUNTEREXAMPLE 3 — a fractional value declines instead of being read out of the middle", () => {
  const plan = declined("Top 10 cities by murder rate in 2025 with at least 1.5 million people",
    "current", "fractional-value");
  assert.match(plan.explanation, /whole numbers/);
  // The number is read atomically: one token, not a "5" hiding inside "1.5".
  const tokens = scanNumbers("at least 1.5 million people");
  assert.equal(tokens.length, 1, "one numeric token");
  assert.equal(tokens[0].text, "1.5");
  assert.equal(tokens[0].fractional, true);
  assert.equal(tokens[0].suffix, "m");
  // The counterpart: a whole number with the same suffix is carried exactly.
  const whole = run(nibrs, "Top 10 cities in Texas with at least 1 million people by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(whole.plan.eligibility, [{ kind: "population", comparison: ">=", value: 1_000_000 }]);
  assert.deepEqual(whole.names, ["HOUSTON", "AUSTIN"], "and only the cities that clear it come back");
});

check("COUNTEREXAMPLE 4 — a second count condition is not swallowed either", () => {
  declined("Top 10 cities by murder rate in 2025 with at least 100 murders and under 200 murders",
    "current", "unaccounted-request");
  // The counterpart: one count floor still delivers, on the crime its own clause named.
  const one = run(nibrs, "Rank cities in Texas by murder rate in 2025 with at least 100 murders", "nibrs");
  assert.equal(one.plan.eligibility.length, 1);
  const condition = one.plan.eligibility[0];
  assert.equal(condition.kind, "count");
  assert.deepEqual(condition.kind === "count" ? condition.offense : null, { kind: "nibrs_codes", codes: ["09A"] });
  assert.deepEqual(one.names, ["HOUSTON"], "AUSTIN's 50 murders are below the floor that was asked for");
});

check("a malformed number declines rather than being partly read", () => {
  const plan = declined("Top 10 cities by murder rate in 2025 with at least 1,00,000 people", "current");
  assert.match(plan.explanation, /couldn't read/);
  assert.equal(scanNumbers("1,00,000")[0].wellFormed, false);
  assert.equal(scanNumbers("100,000")[0].wellFormed, true);
  assert.equal(scanNumbers("100000")[0].wellFormed, true);
});

/* ------------------------------------------------------------------ *
 * 2. Every filler rule, paired with a meaning-changing counterpart
 * ------------------------------------------------------------------ */

/**
 * Each row is a supported question that NEEDS the filler rule, and a near-identical question where
 * a meaning-bearing word sits in the same slot and the request must decline. Without the second
 * half, a filler rule is indistinguishable from a global ignore list.
 */
const FILLER_PAIRS: { rule: string; supported: string; counterpart: string; source: CityRankingSource }[] = [
  {
    rule: "request-opener", source: "current",
    supported: "Show me the cities with the highest sexual assault rate per 100,000",
    counterpart: "Show me the cities excluding suburbs with the highest sexual assault rate per 100,000",
  },
  {
    rule: "question-opener", source: "nibrs",
    supported: "which cities in Texas had the highest rate of murders in 2025?",
    counterpart: "which cities in Texas besides suburbs had the highest rate of murders in 2025?",
  },
  {
    rule: "trailing-punctuation", source: "nibrs",
    supported: "Rank cities in Texas by shoplifting rate in 2025?",
    counterpart: "Rank cities in Texas by shoplifting rate in 2025 only?",
  },
  {
    rule: "preposition", source: "nibrs",
    supported: "Rank cities in Texas by shoplifting rate in 2025",
    counterpart: "Rank cities in Texas without shoplifting rate in 2025",
  },
  {
    rule: "auxiliary", source: "nibrs",
    supported: "which cities in Texas had the highest rate of murders in 2025?",
    counterpart: "which cities in Texas nearly had the highest rate of murders in 2025?",
  },
  {
    rule: "determiner", source: "current",
    supported: "Rank the cities by the highest murder rate per 100,000 in 2025",
    counterpart: "Rank the safest cities by the highest murder rate per 100,000 in 2025",
  },
  {
    rule: "punctuation", source: "nibrs",
    supported: "which cities in Texas (min 250k) had the highest rate of murders in 2025?",
    counterpart: "which cities in Texas (excluding suburbs) had the highest rate of murders in 2025?",
  },
];

check("CHECK 4 — every filler rule in the module has a pair, and the rule is shown to fire", () => {
  /*
   * Coverage is DERIVED from the module's own rule list, so a rule added there cannot escape the
   * obligation by not being listed here. The previous version hard-coded six pairs against eight
   * entries, and one of them named `conjunction` for a question containing no conjunction.
   */
  const paired = new Set(FILLER_PAIRS.map((pair) => pair.rule));
  for (const { rule } of FILLER_RULES) {
    assert.ok(paired.has(rule), `filler rule "${rule}" has no pair in this suite`);
  }
  for (const pair of FILLER_PAIRS) {
    assert.ok(FILLER_RULES.some((r) => r.rule === pair.rule), `pair names a rule the module does not have: ${pair.rule}`);
    const supported = recognizeCityRanking(pair.supported, pair.source);
    assert.ok(supported && supported.kind === "ranking",
      `${pair.rule}: the supported question must still be answered — ${pair.supported}`);
    // A matching rule name proves the rule was EXERCISED. It does not prove semantic safety, which
    // is what the counterpart below is for.
    assert.ok(supported.accounting.some((claim) => claim.rule === pair.rule),
      `${pair.rule}: the supported question does not actually exercise that rule`);
    const counterpart = recognizeCityRanking(pair.counterpart, pair.source);
    assert.ok(counterpart, `${pair.rule}: the counterpart stays in the family — ${pair.counterpart}`);
    assert.equal(counterpart!.kind, "unsupported",
      `${pair.rule}: a meaning-bearing word in the same slot must decline — ${pair.counterpart}`);
  }
});

check("CHECK 4 — a connector between two conditions is NOT filler; it names their relationship", () => {
  /*
   * The governed OR witness, kept here because this is where the defect lived: `and|or` used to be
   * a filler rule, so a disjunction became a conjunction with no trace.
   */
  assert.ok(!FILLER_RULES.some((rule) => rule.pattern.test("or")),
    "no filler rule may match a connector");
  const conjunction = recognizeCityRanking(
    "Rank cities by murder rate in 2025 with at least 500 people and at least 100 murders", "current");
  assert.ok(conjunction && conjunction.kind === "ranking", "AND is the supported relationship");
  assert.equal(conjunction.eligibility.length, 2);
  assert.ok(conjunction.accounting.some((claim) => claim.rule === "condition-connector"),
    "and the connector is claimed as a relationship, not as filler");
  const disjunction = declined(
    "Rank cities by murder rate in 2025 with at least 500 people or at least 100 murders",
    "current", "disjunction-unsupported");
  assert.match(disjunction.explanation, /EITHER/);
});

/* ------------------------------------------------------------------ *
 * 2b. The four governing witnesses, and their useful counterparts
 * ------------------------------------------------------------------ */

/**
 * CHECK 2. Each row: a request whose meaning this family cannot carry, and the near-identical
 * request it CAN. The counterpart half is what stops a fix that simply refuses everything.
 */
const GOVERNING_WITNESSES: {
  name: string; source: CityRankingSource; unsupported: string; reason: string;
  supported: string; expects: (plan: CityRankingRequest) => void;
}[] = [
  {
    name: "disjunction", source: "current", reason: "disjunction-unsupported",
    unsupported: "Rank cities by murder rate in 2025 with at least 500 people or at least 100 murders",
    supported: "Rank cities by murder rate in 2025 with at least 500 people and at least 100 murders",
    expects: (plan) => {
      assert.deepEqual(plan.eligibility.map((c) => [c.kind, c.comparison, c.value]),
        [["population", ">=", 500], ["count", ">=", 100]]);
    },
  },
  {
    name: "rate basis", source: "current", reason: "rate-basis-unsupported",
    unsupported: "Rank cities by murder rate per 1000 in 2025",
    supported: "Rank cities by murder rate per 100,000 in 2025",
    expects: (plan) => {
      assert.equal(plan.sort.quantity, "rate_per_100k");
      assert.equal(SUPPORTED_RATE_BASIS, 100000);
    },
  },
  {
    name: "count scale", source: "current", reason: "count-scale-unsupported",
    unsupported: "Rank cities by murder rate in 2025 with at least 1k murders",
    supported: "Rank cities by murder rate in 2025 with at least 1000 murders",
    expects: (plan) => {
      assert.deepEqual(plan.eligibility.map((c) => [c.kind, c.comparison, c.value]), [["count", ">=", 1000]]);
    },
  },
  {
    // The reason is now the clause form itself rather than leftover words inside it: the tail
    // `attempted murders` is not one of the supported count forms at all.
    name: "offense qualifier", source: "current", reason: "count-clause-unsupported",
    unsupported: "Rank cities by murder rate in 2025 with at least 100 attempted murders",
    supported: "Rank cities by murder rate in 2025 with at least 100 murders",
    expects: (plan) => {
      assert.deepEqual(plan.eligibility.map((c) => [c.kind, c.comparison, c.value]), [["count", ">=", 100]]);
    },
  },
];

check("CHECK 2 — each governing witness declines, and its counterpart keeps its exact meaning", () => {
  for (const witness of GOVERNING_WITNESSES) {
    declined(witness.unsupported, witness.source, witness.reason);
    const plan = recognizeCityRanking(witness.supported, witness.source);
    assert.ok(plan && plan.kind === "ranking", `${witness.name}: the counterpart must still deliver`);
    witness.expects(plan);
  }
});

check("CHECK 2 — the counterparts deliver different executed rows, not merely different plans", () => {
  /*
   * A fixture shaped so each condition selects a different set: BOTH clears both, COUNT_ONLY only
   * the count, POP_ONLY only the population, NEITHER neither. A disjunction would return three of
   * them, which is why it has to decline rather than quietly become a conjunction.
   */
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE agency_monthly(ori TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER);" +
    "CREATE TABLE agency_population(ori TEXT, year INTEGER, population INTEGER, PRIMARY KEY (ori, year));"
  );
  const pop = db.prepare("INSERT INTO agency_population VALUES(?,?,?)");
  const mon = db.prepare("INSERT INTO agency_monthly VALUES(?,?,?,?,?,?,?,?)");
  pop.run("B", 2025, 1000); pop.run("C", 2025, 100); pop.run("P", 2025, 5000); pop.run("N", 2025, 100);
  mon.run("B", "BOTH", "TX", "City", 2025, 1, "Murder", 600);
  mon.run("C", "COUNT_ONLY", "TX", "City", 2025, 1, "Murder", 500);
  mon.run("P", "POP_ONLY", "TX", "City", 2025, 1, "Murder", 5);
  mon.run("N", "NEITHER", "TX", "City", 2025, 1, "Murder", 1);

  const conjunction = run(db, "Rank cities by murder rate in 2025 with at least 500 people and at least 100 murders", "current");
  assert.deepEqual(conjunction.names, ["BOTH"], "both conditions apply together");
  const thousand = run(db, "Rank cities by murder rate in 2025 with at least 1000 murders", "current");
  assert.deepEqual(thousand.names, [], "one thousand is one thousand — no city clears it");
  const hundred = run(db, "Rank cities by murder rate in 2025 with at least 100 murders", "current");
  assert.deepEqual(hundred.names.slice().sort(), ["BOTH", "COUNT_ONLY"].sort());
  const rate = run(db, "Rank cities by murder rate per 100,000 in 2025", "current");
  assert.equal(rate.rows.find((r) => r.city === "BOTH")!.rate_per_100k, 60000,
    "the supported basis is per 100,000, and the delivered figure says so");
  db.close();
});

/* ------------------------------------------------------------------ *
 * 2c. Interior qualifiers, in both positions
 * ------------------------------------------------------------------ */

check("CHECK 3 — an unsupported modifier is unsupported outside a clause AND inside one", () => {
  // A modifier with no supported meaning declines wherever it sits.
  for (const modifier of ["attempted", "reported attempted", "justifiable"]) {
    const outside = recognizeCityRanking(`Rank cities by ${modifier} murder rate in 2025`, "current");
    assert.ok(outside, `${modifier}: stays in the family when it sits outside a clause`);
    assert.equal(outside!.kind, "unsupported", `${modifier}: declines outside a clause`);
    const inside = recognizeCityRanking(
      `Rank cities by murder rate in 2025 with at least 100 ${modifier} murders`, "current");
    assert.ok(inside, `${modifier}: stays in the family when it sits inside the count clause`);
    assert.equal(inside!.kind, "unsupported",
      `${modifier}: an enclosing match is not evidence its interior was understood`);
  }
  /*
   * "per capita" is the interesting one, and it is NOT symmetric: outside a clause it is a
   * recognised way of naming the rate, and inside a count clause it means nothing. Both are
   * asserted, because "unsupported everywhere" would be the wrong rule for it.
   */
  const asUnit = recognizeCityRanking("Rank cities by per capita murder rate in 2025", "current");
  assert.ok(asUnit && asUnit.kind === "ranking", "per capita names the rate when it names the measure");
  assert.equal(asUnit.sort.quantity, "rate_per_100k");
  assert.ok(asUnit.accounting.some((claim) => claim.rule === "unit-rate" && /per capita/i.test(claim.text)),
    "and it is claimed as the unit, not ignored");
  const insideClause = recognizeCityRanking(
    "Rank cities by murder rate in 2025 with at least 100 per capita murders", "current");
  assert.ok(insideClause && insideClause.kind === "unsupported",
    "while inside a count clause it has no meaning this family can carry");
  // And an ordinary count clause, with and without a crime word, still works in the same slot.
  const named = run(nibrs, "Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses", "nibrs");
  assert.deepEqual(named.plan.eligibility.map((c) => [c.kind, c.value]), [["count", 100]]);
  const generic = run(nibrs, "Rank cities in Texas by shoplifting rate in 2025 with at least 100 offenses", "nibrs");
  assert.deepEqual(generic.plan.eligibility.map((c) => [c.kind, c.value]), [["count", 100]],
    "a generic count noun may refer to the crime already being ranked");
});

/* ------------------------------------------------------------------ *
 * 2d. Assembly: productions, declared defaults, and no recovery of a failed clause
 * ------------------------------------------------------------------ */

check("CHECK 1 — every assembled field records whether it came from the request or a default", () => {
  const stated = run(nibrs, "Top 10 cities in Texas of 250,000 people or more by shoplifting rate in 2025", "nibrs");
  const origin = (field: string) => stated.plan.origins.find((o) => o.field === field);
  for (const field of ["sort.direction", "resultCount", "sort.quantity", "offense", "scope", "period", "eligibility"]) {
    assert.ok(origin(field), `the assembled ${field} records its origin`);
  }
  assert.equal(origin("resultCount")!.from, "production", "Top 10 was stated");
  assert.equal(origin("period")!.from, "production", "and so was 2025");
  assert.equal(origin("scope")!.from, "resolved-leaf", "Texas is a claim whose leaf the contract resolved");

  // Genuine omissions take their declared defaults — the opposing control.
  const omitted = recognizeCityRanking("Show me the cities with the highest sexual assault rate per 100,000", "current");
  assert.ok(omitted && omitted.kind === "ranking");
  const omittedOrigin = (field: string) => omitted.origins.find((o) => o.field === field);
  assert.equal(omittedOrigin("resultCount")!.from, "declared-default");
  assert.equal(omitted.resultCount, DEFAULT_RESULT_COUNT);
  assert.equal(omittedOrigin("period")!.from, "declared-default");
  assert.equal(omitted.period.kind, "latest_with_data");
  assert.equal(omittedOrigin("scope")!.from, "declared-default");
  assert.deepEqual(omitted.scope, { kind: "nationwide" });
});

check("CHECK 1 — a stated unit governs; an omitted one takes the established policy", () => {
  const stated = recognizeCityRanking("Rank cities by murder counts in 2025", "current");
  assert.ok(stated && stated.kind === "ranking");
  assert.equal(stated.sort.quantity, "count");
  assert.equal(stated.origins.find((o) => o.field === "sort.quantity")!.from, "production");
  // A request naming no measure at all is a genuine omission and still works.
  const omitted = recognizeCityRanking("Which cities had the most murders in 2025?", "current");
  assert.ok(omitted && omitted.kind === "ranking", "a request with no measure word is not newly declined");
  assert.equal(omitted.sort.quantity, "count");
  assert.equal(omitted.origins.find((o) => o.field === "sort.quantity")!.from, "declared-default");
});

check("CHECK 1 — a FAILED clause never reaches the default that would have covered it", () => {
  /*
   * The whole point of the fallback boundary. In each pair the same field has a perfectly good
   * default available; because the request STATED something this family cannot carry, it declines
   * instead of quietly taking that default.
   */
  const perThousand = declined("Rank cities by murder rate per 1000 in 2025", "current", "rate-basis-unsupported");
  assert.match(perThousand.explanation, /per 100,000/, "it says what it can do instead");
  const withoutBasis = recognizeCityRanking("Rank cities by murder rate in 2025", "current");
  assert.ok(withoutBasis && withoutBasis.kind === "ranking",
    "and the same question without the basis takes the default — so the default was there to be taken");
  assert.equal(withoutBasis.sort.quantity, "rate_per_100k");

  const scaled = declined("Rank cities by murder rate in 2025 with at least 1k murders", "current", "count-scale-unsupported");
  assert.match(scaled.explanation, /1000/, "it says what to write instead");
  assert.equal(recognizeCityRanking("Rank cities by murder rate in 2025 with at least 1 murders", "current")!.kind,
    "ranking", "and the unscaled threshold is fine, so the decline is about the scale");
});

/* ------------------------------------------------------------------ *
 * 2e. Complete clause forms: the whole phrase contributes, or the clause fails
 * ------------------------------------------------------------------ */

/**
 * The supported count-clause forms, and the shapes that look like them and are not.
 *
 * The defect this replaces: `offenseToken(phrase)` found an offense ANYWHERE inside the words before
 * a generic noun and then declared the whole phrase explained, so `at least 100 attempted shoplifting
 * offenses` delivered the plain shoplifting threshold with `attempted` gone. An offense now explains
 * only the words it matched IN FULL.
 */
const COUNT_FORMS: { ranked: string; clause: string; supported: boolean; note: string }[] = [
  { ranked: "murder", clause: "at least 100 murders", supported: true, note: "direct crime noun" },
  { ranked: "robbery", clause: "at least 100 robberies", supported: true, note: "direct crime noun" },
  { ranked: "motor vehicle theft", clause: "at least 100 motor vehicle thefts", supported: true, note: "multi-word crime noun matched in full" },
  { ranked: "aggravated assault", clause: "at least 100 aggravated assaults", supported: true, note: "a qualifier that IS part of the offense name" },
  { ranked: "shoplifting", clause: "at least 100 shoplifting offenses", supported: true, note: "offense phrase then a generic noun" },
  { ranked: "shoplifting", clause: "at least 100 offenses", supported: true, note: "generic noun, referring to the ranked crime" },
  { ranked: "murder", clause: "at least 100 attempted murders", supported: false, note: "unmatched qualifier before a crime noun" },
  { ranked: "shoplifting", clause: "at least 100 attempted shoplifting offenses", supported: false, note: "unmatched qualifier before an offense phrase" },
  { ranked: "shoplifting", clause: "at least 100 reported attempted shoplifting offenses", supported: false, note: "two unmatched qualifiers" },
  { ranked: "shoplifting", clause: "at least 100 per capita shoplifting offenses", supported: false, note: "an unmatched modifier that is a unit word elsewhere" },
  { ranked: "murder", clause: "at least 100 justifiable homicides", supported: false, note: "unmatched qualifier before a crime noun" },
];

check("CLAUSE FORMS — a count clause is one of three complete forms, or it is refused", () => {
  for (const form of COUNT_FORMS) {
    const question = `Rank cities in Texas by ${form.ranked} rate in 2025 with ${form.clause}`;
    const plan = recognizeCityRanking(question, "nibrs");
    assert.ok(plan, `${form.note}: stays in the family — ${form.clause}`);
    if (form.supported) {
      assert.equal(plan!.kind, "ranking",
        `${form.note}: must still be answered — ${form.clause}${plan!.kind === "unsupported" ? ` (${(plan as { reason: string }).reason})` : ""}`);
      const condition = (plan as CityRankingRequest).eligibility.find((c) => c.kind === "count");
      assert.ok(condition, `${form.note}: and carries its threshold — ${form.clause}`);
      assert.equal(condition!.value, 100);
    } else {
      assert.equal(plan!.kind, "unsupported", `${form.note}: must be refused — ${form.clause}`);
    }
  }
});

check("CLAUSE FORMS — an offense explains only the words it matched, not the ones beside them", () => {
  /*
   * The two shapes side by side. Both contain `shoplifting`; only one of them is a complete form,
   * and the difference is exactly the word the previous version threw away.
   */
  const plain = run(nibrs, "Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses", "nibrs");
  assert.deepEqual(plain.plan.eligibility.map((c) => [c.kind, c.value]), [["count", 100]]);
  assert.deepEqual(plain.names, ["WACO", "HOUSTON", "AUSTIN"]);
  const qualified = declined(
    "Rank cities in Texas by shoplifting rate in 2025 with at least 100 attempted shoplifting offenses",
    "nibrs", "count-clause-unsupported");
  assert.match(qualified.explanation, /at least 100 murders/, "and it says what it can take instead");
  // The same pair on the direct-crime-noun shape, which is where the murder witnesses live.
  const directPlain = run(nibrs, "Rank cities in Texas by murder rate in 2025 with at least 100 murders", "nibrs");
  assert.deepEqual(directPlain.plan.eligibility.map((c) => [c.kind, c.value]), [["count", 100]]);
  declined("Rank cities in Texas by murder rate in 2025 with at least 100 attempted murders",
    "nibrs", "count-clause-unsupported");
});

/* ------------------------------------------------------------------ *
 * 2f. Stated-ness is recorded independently of whether a production succeeded
 * ------------------------------------------------------------------ */

check("STATED — a denominator states the unit, even with no word \"rate\" anywhere", () => {
  /*
   * The shipped case that showed the gap with no mutation at all: the request states its measure
   * through `per 100000`, and the old assembly recorded that as an omission and took the resolver's
   * value. The figure happened to be right; the authority was not.
   */
  const withWord = recognizeCityRanking("Rank cities by murder rate in 2025", "current");
  assert.ok(withWord && withWord.kind === "ranking");
  assert.equal(withWord.origins.find((o) => o.field === "sort.quantity")!.from, "production");

  const denominatorOnly = recognizeCityRanking("Rank cities by murder per 100000 in 2025", "current");
  assert.ok(denominatorOnly && denominatorOnly.kind === "ranking");
  assert.equal(denominatorOnly.sort.quantity, "rate_per_100k");
  assert.equal(denominatorOnly.origins.find((o) => o.field === "sort.quantity")!.from, "production",
    "the unit comes from the request's own denominator, not from the resolver");

  // And a genuinely measure-omitting request still takes the established default.
  const omitted = recognizeCityRanking("Which cities had the most murders in 2025?", "current");
  assert.ok(omitted && omitted.kind === "ranking");
  assert.equal(omitted.sort.quantity, "count");
  assert.equal(omitted.origins.find((o) => o.field === "sort.quantity")!.from, "declared-default");
});

check("STATED — an unreadable denominator refuses rather than falling back to the default", () => {
  declined("Rank cities by murder rate per 1.5 in 2025", "current", "denominator-unreadable");
  declined("Rank cities by murder rate per 1000 in 2025", "current", "rate-basis-unsupported");
  // The default was available the whole time: the same question without a basis takes it.
  const withoutBasis = recognizeCityRanking("Rank cities by murder rate in 2025", "current");
  assert.ok(withoutBasis && withoutBasis.kind === "ranking");
  assert.equal(withoutBasis.sort.quantity, "rate_per_100k");
});

check("negation and exclusion are never filler", () => {
  for (const question of [
    "Rank cities in Texas by shoplifting rate in 2025 excluding sheriffs",
    "Rank cities in Texas by shoplifting rate in 2025 with no reported arrests",
    "Rank cities in Texas by shoplifting rate in 2025 that did not report every month",
  ]) {
    const plan = recognizeCityRanking(question, "nibrs");
    assert.ok(plan, `stays in the family: ${question}`);
    assert.equal(plan!.kind, "unsupported", `declines: ${question}`);
  }
});

check("the accounting travels with the request, so what was read is inspectable", () => {
  const { plan } = run(nibrs, "Top 10 cities in Texas of 250,000 people or more by shoplifting rate in 2025", "nibrs");
  const fields = plan.accounting.map((claim) => claim.field);
  for (const required of ["entity", "direction", "size", "crime", "unit", "geography", "period", "population"]) {
    assert.ok(fields.includes(required as never), `the request accounts for its ${required}`);
  }
  const population = plan.accounting.find((claim) => claim.field === "population");
  assert.equal(population!.text, "250,000 people or more",
    "and a clause's span covers the WHOLE clause, its trailing qualifier included");
  const withLeading = run(nibrs, "Top 10 cities in Texas with at least 500 people by shoplifting rate in 2025", "nibrs");
  assert.equal(withLeading.plan.accounting.find((claim) => claim.field === "population")!.text,
    "at least 500 people", "and its leading comparison words too");
});

/* ------------------------------------------------------------------ *
 * 3. The three saved witnesses, delivered
 * ------------------------------------------------------------------ */

const GC062 = "Top 10 cities of 250,000 people or more by shoplifting rate in 2025";
const GC063 = "which cities in Texas (min 250k) had the highest rate of carjackings in 2025?";
const GC039 = "Show me the cities with the highest sexual assault rate per 100,000";

check("GC-062 is recognised with its floor, limit, offense and sort, each in its own field", () => {
  const plan = recognizeCityRanking(GC062, "nibrs");
  assert.ok(plan && plan.kind === "ranking");
  assert.equal(plan.sort.quantity, "rate_per_100k");
  assert.equal(plan.sort.direction, "desc");
  assert.deepEqual(plan.eligibility, [{ kind: "population", comparison: ">=", value: 250000 }]);
  assert.equal(plan.resultCount, 10);
  assert.deepEqual(plan.offense, { kind: "nibrs_codes", codes: ["23C"] }, "shoplifting is 23C");
  assert.equal(plan.period.kind === "explicit" && plan.period.year, 2025);
});

check("GC-062 executed returns every eligible city, including the recorded zero", () => {
  const { rows, names } = run(nibrs, "Top 10 cities in Texas of 250,000 people or more by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(names, expected.nibrsTexas250k, "every eligible city, in rate order");
  assert.equal(rows.find((r) => r.city === "LUBBOCK")!.offenses, 0, "the recorded zero is present as 0");
  assert.equal(rows.find((r) => r.city === "HOUSTON")!.offenses, expected.nibrsShopliftingHouston);
  assert.ok(!names.includes("PLANO"), "a city with no record is never invented as a zero");
  assert.ok(!names.includes("WACO"), "under the requested floor");
  assert.ok(!names.includes("ALBUQUERQUE"), "wrong state");
  assert.ok(!names.includes("HARRIS SO"), "not a city agency");
});

check("GC-063 (carjackings) is ranked from the derived carjacking table, never from the human-trafficking codes 64A/64B", () => {
  // Answer batch A (2026-10-20): carjacking has no NIBRS code (it is robbery 120 with a stolen vehicle), so it is
  // never built from codes (carjacking hotfix, 2026-10-10); it has its own derived table, summary_carjacking_monthly.
  const { plan, built, rows, names } = run(nibrs, GC063, "nibrs");
  assert.deepEqual(plan.offense, { kind: "nibrs_carjacking" });
  assert.deepEqual(plan.scope, { kind: "state", code: "TX", name: "Texas" });
  assert.deepEqual(plan.eligibility, [{ kind: "population", comparison: ">=", value: 250000 }]);
  assert.match(built.sql, /FROM summary_carjacking_monthly s JOIN agencies a ON a\.ori = s\.ori AND a\.year = s\.year/);
  assert.doesNotMatch(built.sql, /ucr_offense_code|summary_city_monthly|64A|64B|'120'/);
  assert.deepEqual(names, ["SAN ANTONIO", "HOUSTON", "AUSTIN"], "rate order; WACO, ALBUQUERQUE, HARRIS SO, UNKNOWNVILLE excluded");
  assert.deepEqual(rows.map((r) => r.rate_per_100k), [3, 2.61, 0.5]);
  assert.equal(rows[0].population, 1500000, "the 2025 population, not 2024's");
  assert.deepEqual([rows[0].first_month, rows[0].last_month], [1, 3], "the span is reported, not certified complete");
  assert.match(built.caveats.join(" "), /derived measure: robbery incidents in which a motor vehicle was stolen/);
  assert.match(built.caveats.join(" "), /do not rule out missing months/);
  // Completeness: the candidates statement reads the same table, and the unknown-type agency is the unresolved one.
  const candidates = rowsOf(nibrs, built.completeness!.candidatesSql);
  assert.match(built.completeness!.candidatesSql, /FROM summary_carjacking_monthly s/);
  assert.deepEqual(candidates.map((r) => r.city), ["UNKNOWNVILLE"]);
  assert.equal(built.completeness!.ranked([]), built.sql);
  // The existing decision, as the route runs it: UNKNOWNVILLE (9 / 300,000 = 3.00 per 100k) is an eligible agency of
  // unknown type that would place within the ranking, so the ranking is delivered as PARTIAL, naming it.
  const decision = decideCandidates(built.completeness!, candidates);
  assert.equal(decision.kind, "decided");
  if (decision.kind === "decided") {
    assert.deepEqual(decision.unresolved.map((c) => c.ori), ["TX10"]);
    assert.deepEqual(decision.conflicted, []);
    const result = completenessOf(built.completeness!, decision, rows, built.title);
    assert.equal(result.complete, false, "an unresolved agency that would rank prevents an unqualified complete ranking");
    assert.match(result.sentences.join(" "), /This ranking is incomplete: one agency .*UNKNOWNVILLE/);
  }
});

check("carjacking beside another offense, in either order, and domestic violence are still declined", () => {
  for (const q of ["which cities had the most carjackings and robberies in 2025?", "which cities had the most robberies and carjackings in 2025?", "which cities had the most domestic violence in 2025?"]) {
    const plan = recognizeCityRanking(q, "nibrs");
    assert.ok(!plan || plan.kind === "unsupported", `declined: ${q}`);
  }
});

check("the GC-063 ranking binds every part of the request in NIBRS request accounting (carjacking by family value)", () => {
  const p = planNibrsCityRanking(GC063, { year: 2026, month: 7, observed: true } as never);
  assert.ok(p && p.kind === "deterministic");
  const applied = (p as { query: { applied: NibrsApplied } }).query.applied;
  assert.deepEqual(applied.families, ["carjacking"]);
  assert.deepEqual(applied.codeGroups, []);
  const ledger = accountNibrsRequest(GC063);
  assert.equal(nibrsRecognitionRefusal(ledger), null);
  assert.deepEqual(nibrsUnboundParts(ledger, applied).map((x) => x.text), []);
});

check("GC-063's shape with a coded offense carries Texas and the 250k floor, and delivers its figures", () => {
  const { plan, names } = run(nibrs, GC063.replace("carjackings", "murders"), "nibrs");
  assert.deepEqual(plan.scope, { kind: "state", code: "TX", name: "Texas" });
  assert.deepEqual(plan.eligibility, [{ kind: "population", comparison: ">=", value: 250000 }]);
  assert.deepEqual(plan.offense, { kind: "nibrs_codes", codes: ["09A"] });
  assert.equal(plan.resultCount, DEFAULT_RESULT_COUNT, "no count was asked for, so the existing default applies");
  assert.deepEqual(names, ["HOUSTON", "AUSTIN"], "ordered by rate, highest first");
});

check("GC-039 resolves its period from an OBSERVED cutoff and says the year is partial", () => {
  const plan = recognizeCityRanking(GC039, "current");
  assert.ok(plan && plan.kind === "ranking");
  assert.equal(plan.period.kind, "latest_with_data");
  assert.deepEqual(plan.offense, { kind: "current_offense", value: "Rape" });
  assert.ok(plan.caveats.some((c) => /UCR category "Rape"/.test(c)), "and carries the category caveat");
  const built = buildCityRanking(plan, OBSERVED_PARTIAL);
  assert.ok(built);
  assert.equal(built!.period.provenance, "observed-cutoff");
  assert.match(built!.title, /2025 through July/);
  assert.match(built!.sql, /am\.month <= 7/, "the statement covers exactly the period it claims");
  assert.deepEqual(cityNames(current, built!.sql), expected.currentCities);
  assert.ok(!cityNames(current, built!.sql).includes("OMAHA"), "a city with no offense record is not invented");
});

check("GC-039 with no cutoff, or a GUESSED one, is not answered with an invented year", () => {
  const plan = recognizeCityRanking(GC039, "current") as CityRankingRequest;
  assert.equal(resolvePeriod(plan, null), null, "no cutoff, no period");
  assert.equal(buildCityRanking(plan, null), null);
  assert.equal(resolvePeriod(plan, HEURISTIC), null, "a heuristic date does not establish a period");
  assert.equal(buildCityRanking(plan, HEURISTIC), null);
});

/* ------------------------------------------------------------------ *
 * 4. The original ten specimens
 * ------------------------------------------------------------------ */

check("SPECIMEN — direction, size and scale each come from their own clause", () => {
  const bottom = run(nibrs, "Bottom 2 cities in Texas by shoplifting rate in 2025", "nibrs");
  assert.equal(bottom.plan.sort.direction, "asc");
  assert.equal(bottom.names[0], "LUBBOCK", "the lowest rate first — LUBBOCK's recorded zero");
  const top = run(nibrs, "Top 2 cities in Texas by shoplifting rate in 2025", "nibrs");
  assert.equal(top.plan.sort.direction, "desc");
  assert.notDeepEqual(bottom.names, top.names);
  // "at least" belongs to the population clause, not to the direction.
  const atLeast = run(nibrs, "Top 10 cities in Texas with at least 500 people by shoplifting rate in 2025", "nibrs");
  assert.equal(atLeast.plan.sort.direction, "desc");
  assert.ok(atLeast.names.includes("HAMLET"), "and 500 people means 500 people");
});

check("SPECIMEN — \"over\" and \"or more\" are different comparisons", () => {
  const over = run(nibrs, "Top 10 cities in Texas with population over 250000 by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(over.plan.eligibility, [{ kind: "population", comparison: ">", value: 250000 }]);
  assert.ok(!over.names.includes("BOUNDARY"), "a city sitting exactly on 250,000 is OVER nothing");
  const orMore = run(nibrs, "Top 10 cities in Texas of 250,000 people or more by shoplifting rate in 2025", "nibrs");
  assert.ok(orMore.names.includes("BOUNDARY"), "while \"or more\" keeps it");
});

check("SPECIMEN — a count floor on one crime is never applied to a ranking of another", () => {
  declined("Rank cities by murder rate in 2025 with at least 100 shoplifting offenses", "nibrs",
    "cross-offense-eligibility");
  const same = run(nibrs, "Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses", "nibrs");
  assert.match(same.built.sql, /HAVING SUM\(s\.offense_count\) >= 100/);
  assert.ok(same.names.includes("AUSTIN"), "the city sitting exactly on the boundary is kept");
  const exclusive = run(nibrs, "Rank cities in Texas by shoplifting rate in 2025 with more than 100 shoplifting offenses", "nibrs");
  assert.ok(!exclusive.names.includes("AUSTIN"), "more than 100 excludes it, as asked");
});

check("SPECIMEN — a rate threshold, a month, a range, two states and an oversized list all decline", () => {
  declined("Rank cities by shoplifting rate in 2025 with a rate of at least 100 offenses per 100000 residents",
    "nibrs", "rate-eligibility");
  declined("Top 10 cities by shoplifting rate in January 2025", "nibrs", "sub-year-period");
  declined("Top 10 cities by shoplifting rate in Q2 2025", "nibrs", "sub-year-period");
  const range = declined("Rank cities by shoplifting rate from 2024 to 2025", "nibrs", "multi-year-range");
  assert.match(range.explanation, /2024 to 2025/);
  const states = declined("Rank cities in Texas and California by shoplifting rate in 2025", "nibrs", "multi-state");
  assert.match(states.explanation, /Texas and California/);
  const big = declined("Top 1000 cities by shoplifting rate in 2025", "nibrs", "result-count-unsupported");
  assert.match(big.explanation, /1,000/);
  assert.match(big.explanation, new RegExp(String(MAX_RESULT_COUNT)));
  // Their supported counterparts still deliver.
  assert.equal(run(nibrs, "Rank cities in Texas by shoplifting rate in 2024", "nibrs").plan.period.kind, "explicit");
  assert.equal(run(nibrs, `Top ${MAX_RESULT_COUNT} cities in Texas by shoplifting rate in 2025`, "nibrs").plan.resultCount,
    MAX_RESULT_COUNT);
});

check("SPECIMEN — a vague size word declines rather than being ignored", () => {
  /*
   * A behaviour CHANGE, recorded as one. The previous version answered this with every city, on the
   * reasoning that a size word is not a threshold; true, and not a defence, because the reader asked
   * for large cities and got all of them.
   */
  const plan = declined("Rank large cities in Texas by shoplifting rate in 2025", "nibrs", "vague-size");
  assert.match(plan.explanation, /doesn't tell me a size I can measure/);
  assert.match(plan.explanation, /at least 250,000 people/, "and says what would make it answerable");
  const numbered = run(nibrs, "Rank cities in Texas with at least 250000 people by shoplifting rate in 2025", "nibrs");
  assert.deepEqual(numbered.plan.eligibility, [{ kind: "population", comparison: ">=", value: 250000 }]);
});

/* ------------------------------------------------------------------ *
 * 5. Joins preserve totals and eligible cities
 * ------------------------------------------------------------------ */

check("a COUNT ranking requires no population relationship, and keeps cities that have none", () => {
  const { built, names, rows } = run(current, "Rank cities by murder counts in 2025", "current");
  assert.doesNotMatch(built.sql, /agency_population/, "population is not joined when nothing asked for it");
  assert.deepEqual(names, expected.murderCountOrder);
  assert.equal(rows.find((r) => r.city === "BETA")!.offenses, 20);
});

check("a RATE ranking still requires its denominator, and a population condition still joins", () => {
  const rate = run(current, "Rank cities by the highest murder rate per 100,000 in 2025", "current");
  assert.match(rate.built.sql, /JOIN agency_population/);
  assert.ok(!rate.names.includes("BETA"), "a rate cannot be computed without a population");
  const conditioned = run(current, "Rank cities by murder counts in 2025 with at least 400000 people", "current");
  assert.match(conditioned.built.sql, /JOIN agency_population/);
  assert.ok(!conditioned.names.includes("BETA"));
});

check("the identity join is on a uniqueness constraint the schema DECLARES and ENFORCES", () => {
  for (const [source, invariant] of Object.entries(IDENTITY_UNIQUENESS)) {
    const declared = fs.readFileSync(path.join(__dirname, "..", invariant.declaredIn), "utf8");
    const table = new RegExp(
      `CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?${invariant.table}\\b[\\s\\S]*?PRIMARY KEY\\s*\\(\\s*${invariant.key[0]}\\s*,\\s*${invariant.key[1]}\\s*\\)`,
      "i");
    assert.match(declared, table,
      `${source}: ${invariant.table} declares PRIMARY KEY (${invariant.key.join(", ")}) in ${invariant.declaredIn}`);
  }
  const nibrsSql = run(nibrs, "Top 10 cities in Texas by shoplifting rate in 2025", "nibrs").built.sql;
  assert.match(nibrsSql, /JOIN agencies a ON a\.ori = s\.ori AND a\.year = s\.year/);
  const currentSql = run(current, "Rank cities by the highest murder rate per 100,000 in 2025", "current").built.sql;
  assert.match(currentSql, /JOIN agency_population ap ON ap\.ori = am\.ori AND ap\.year = am\.year/);
  assert.throws(() => nAgency.run("TX01", 2025, "HOUSTON", "TX", 2300000, "City"), /UNIQUE|PRIMARY KEY/i);
  assert.throws(() => cPop.run("C1", 2025, 700000), /UNIQUE|PRIMARY KEY/i);
  assert.equal(
    run(nibrs, "Top 10 cities in Texas by murder counts in 2025", "nibrs").rows.find((r) => r.city === "HOUSTON")!.offenses,
    expected.nibrsMurderHouston, "no multiplication occurred");
});

/* ------------------------------------------------------------------ *
 * 6. The period the answer claims is the period the statement covers
 * ------------------------------------------------------------------ */

check("an EXPLICIT year that the source only partly holds is said to be partial", () => {
  const { built, rows } = run(nibrs, "Top 10 cities in Texas by murder counts in 2025", "nibrs", OBSERVED_PARTIAL);
  assert.equal(built.period.throughMonth, 7);
  assert.equal(built.period.provenance, "requested");
  assert.match(built.title, /2025 through July/);
  assert.match(built.sql, /s\.month <= 7/);
  assert.equal(rows.find((r) => r.city === "HOUSTON")!.offenses, expected.nibrsMurderHoustonThroughJuly);
});

check("without observed evidence the answer claims nothing about completeness", () => {
  const { built, rows } = run(nibrs, "Top 10 cities in Texas by murder counts in 2025", "nibrs", HEURISTIC);
  assert.equal(built.period.throughMonth, null);
  assert.doesNotMatch(built.sql, /month <=/);
  assert.doesNotMatch(built.caveats.join(" "), /through July/);
  assert.equal(rows.find((r) => r.city === "HOUSTON")!.offenses, expected.nibrsMurderHouston);
});

check("returned coverage is returned per city, and described as exactly what it is", () => {
  const { built, rows } = run(nibrs, "Top 10 cities in Texas by murder counts in 2025", "nibrs", OBSERVED_PARTIAL);
  assert.ok(built.columns.includes("first_month") && built.columns.includes("last_month"));
  assert.equal(rows.find((r) => r.city === "HOUSTON")!.first_month, 1);
  assert.equal(rows.find((r) => r.city === "HOUSTON")!.last_month, 2, "Houston's own span, not the source's");
  assert.equal(rows.find((r) => r.city === "AUSTIN")!.last_month, 1, "and Austin reports a shorter one");
  assert.match(built.caveats.join(" "), /do not rule out missing months in between/);
});

/* ------------------------------------------------------------------ *
 * 7. Out-of-family requests keep their existing route
 * ------------------------------------------------------------------ */

check("change, peer, chronological, breakdown, named-city and non-ranking requests are not this family", () => {
  for (const [question, source] of [
    ["Rank cities by the change in shoplifting from 2024 to 2025", "nibrs"],
    ["Compare shoplifting counts for cities of similar population in 2025", "nibrs"],
    ["Show shoplifting totals by year for the largest cities", "nibrs"],
    ["Rank cities by shoplifting rate by race in 2025", "nibrs"],
    ["What was the highest shoplifting month in Houston in 2025?", "nibrs"],
    ["List city shoplifting totals in alphabetical order for 2025", "nibrs"],
    ["How many shoplifting offenses were there in 2025?", "nibrs"],
  ] as const) {
    assert.equal(recognizeCityRanking(question, source), null, `outside the family: ${question.slice(0, 44)}`);
  }
});

check("a recognised request this family cannot carry is owned, never returned to the model", () => {
  declined("Rank cities by the shoplifting clearance rate in 2025", "nibrs", "unit-clearance_rate");
  // An unknown crime word is now caught by the accounting and QUOTED, which is a better answer than
  // "I couldn't identify which offense": the reader is told which word did not land.
  const unknown = declined("Rank cities by the highest flimflam rate in 2025", "nibrs", "unaccounted-request");
  assert.match(unknown.explanation, /flimflam/);
});

/* ------------------------------------------------------------------ *
 * 7b. A unit qualifies the quantity it was written on
 *
 * Every unit word and every denominator used to be collected globally and handed to the RANKING,
 * whatever it was written next to. So a threshold the reader stated as a rate --
 * `at least 100 shoplifting offenses per 100,000`, or `… per capita` -- arrived as a plain count
 * floor of 100, and cities the reader's own limit excluded came back in the answer.
 *
 * A contribution now qualifies the nearest quantity: the ranking measure, or an eligibility clause.
 * Both directions are read, because `Top 10 cities per 100,000 by murder rate` writes the unit
 * ahead of its measure and has always been answered; on a tie the preceding quantity wins, so a
 * trailing unit still belongs to the clause it follows.
 * ------------------------------------------------------------------ */

check("a unit trailing a count threshold makes it a RATE threshold, which this family declines", () => {
  for (const trailing of ["per capita", "per 100000", "per 100,000"]) {
    const plan = declined(
      `Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses ${trailing}`,
      "nibrs", "rate-eligibility");
    assert.match(plan.explanation, /can rank by a rate but/i, trailing);
  }
});

check("the same threshold with NO trailing unit is still a plain count, and still delivers", () => {
  const { plan, names } = run(nibrs,
    "Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses", "nibrs");
  assert.equal(plan.sort.quantity, "rate_per_100k");
  const condition = plan.eligibility.find((c) => c.kind === "count");
  assert.ok(condition && condition.kind === "count");
  assert.equal(condition.value, 100, "the threshold keeps its plain-count meaning");
  // WACO 700/140k, HOUSTON 1920/2.3m, AUSTIN 100/1m -- the three clearing the stated count floor,
  // ordered by rate. Only WACO also clears 100 per 100,000, which is what the reader would have
  // been asking for had the trailing unit been kept: the other two are why that request declines.
  assert.deepEqual(names, ["WACO", "HOUSTON", "AUSTIN"], "and the answer is unchanged");
});

check("a unit written BEFORE its measure still qualifies the ranking, and delivers the same answer", () => {
  const forward = run(current, "Top 10 cities per 100,000 by murder rate in 2025", "current");
  const trailing = run(current, "Top 10 cities by murder rate per 100,000 in 2025", "current");
  assert.equal(forward.plan.sort.quantity, "rate_per_100k");
  assert.deepEqual(forward.plan.eligibility, [], "no eligibility condition is invented");
  assert.equal(forward.built.sql, trailing.built.sql, "the same statement");
  assert.equal(forward.built.title, trailing.built.title);
  assert.deepEqual(forward.names, trailing.names, "and the same delivered rows");
});

check("a unit qualifying a POPULATION limit declines rather than losing its unit", () => {
  for (const trailing of ["per capita", "per 100,000"]) {
    const plan = declined(`Rank cities by murder rate in 2025 with at least 500 people ${trailing}`,
      "current", "population-rate-unsupported");
    assert.match(plan.explanation, /number of people rather than a rate/i, trailing);
  }
  // The ordinary population floor beside a ranking rate is untouched.
  const { plan } = run(current, "Rank cities by murder rate per 100000 in 2025 with at least 500 people", "current");
  assert.equal(plan.sort.quantity, "rate_per_100k");
  assert.deepEqual(plan.eligibility, [{ kind: "population", comparison: ">=", value: 500 }]);
});

check("every supported unit alternative qualifies the ranking when written on it", () => {
  const alternatives: [string, CityRankingSource, "count" | "rate_per_100k"][] = [
    ["Rank cities by murder rate in 2025", "current", "rate_per_100k"],
    ["Rank cities by murder rates in 2025", "current", "rate_per_100k"],
    ["Rank cities by murder per capita in 2025", "current", "rate_per_100k"],
    ["Rank cities by murder per 100,000 in 2025", "current", "rate_per_100k"],
    ["Rank cities by murder counts in 2025", "current", "count"],
    ["Rank cities by murder numbers in 2025", "current", "count"],
    ["Rank cities by murder totals in 2025", "current", "count"],
  ];
  for (const [question, source, quantity] of alternatives) {
    const plan = recognizeCityRanking(question, source);
    assert.ok(plan && plan.kind === "ranking", `${question} must be answered`);
    assert.equal((plan as CityRankingRequest).sort.quantity, quantity, question);
  }
});

check("a unit that qualifies nothing declines rather than being dropped or given to the ranking", () => {
  // No crime and no condition: there is no quantity for `rate` to measure.
  declined("Rank cities by rate in 2025", "current", "unit-unowned");
  // A count unit on a count threshold agrees with it, so it is not an error.
  const plan = recognizeCityRanking(
    "Rank cities by murder rate in 2025 with at least 100 murders total", "current");
  assert.ok(plan && plan.kind === "ranking", "a count word on a count threshold is consistent");
  assert.equal((plan as CityRankingRequest).sort.quantity, "rate_per_100k", "and does not become the ranking's unit");
});

check("a period between a condition and its unit does not hand the unit to the ranking", () => {
  /*
   * `in 2025` interrupts the clause; it does not end it. Reading ownership by character distance
   * made the year push the reader's `per 100000` onto the ranking, and the threshold was then
   * applied as a plain count -- delivering cities the reader's own limit excludes.
   */
  for (const unit of ["per 100000", "per capita"]) {
    declined(`Rank cities with at least 100 shoplifting offenses in 2025 ${unit} by shoplifting rate`,
      "nibrs", "rate-eligibility");
  }
  declined("Rank cities with at least 500 people in 2025 per capita by murder rate",
    "current", "population-rate-unsupported");
});

check("an article cannot change which quantity a unit describes", () => {
  /*
   * `by rate of murder` and `by the rate of murder` are the same request. Under the distance rule
   * the article changed the gaps, so one refused and the other delivered.
   */
  const pairs: [string, string][] = [
    ["Rank cities with at least 10 murders by rate of murder in 2025",
      "Rank cities with at least 10 murders by the rate of murder in 2025"],
    ["Rank cities with at least 500 people by rate of murder in 2025",
      "Rank cities with at least 500 people by the rate of murder in 2025"],
  ];
  for (const [bare, article] of pairs) {
    const a = run(current, bare, "current");
    const b = run(current, article, "current");
    assert.equal(a.plan.sort.quantity, "rate_per_100k", bare);
    assert.deepEqual(a.plan.eligibility, b.plan.eligibility, "the same conditions");
    assert.equal(a.built.sql, b.built.sql, "the same statement");
    assert.deepEqual(a.names, b.names, "and the same delivered rows");
    assert.ok(a.names.length > 0, "which is a real answer, not an empty one");
  }
});

check("a measure spread over several words stays one measure", () => {
  /*
   * `by the rate per 100000 of murder` is one instruction. Assigning its parts separately sent the
   * denominator into whichever condition happened to sit to its left, and the request refused.
   */
  const pairs: [string, string][] = [
    ["Rank cities with at least 500 people by the rate per 100000 of murder in 2025",
      "Rank cities with at least 500 people by the rate of murder per 100000 in 2025"],
    ["Rank cities with at least 10 murders by the rate per 100000 of murder in 2025",
      "Rank cities with at least 10 murders by the rate of murder per 100000 in 2025"],
  ];
  for (const [compound, control] of pairs) {
    const a = run(current, compound, "current");
    const b = run(current, control, "current");
    assert.equal(a.plan.sort.quantity, "rate_per_100k", compound);
    assert.deepEqual(a.plan.eligibility, b.plan.eligibility, "the same conditions");
    assert.equal(a.built.sql, b.built.sql, "the same statement");
    assert.deepEqual(a.names, b.names, "and the same delivered rows");
    assert.ok(a.names.length > 0, "which is a real answer");
  }
});

check("a direction word inside the ranking instruction does not strand the unit before it", () => {
  const forward = run(current, "Top 10 cities per 100000 by highest murder rate in 2025", "current");
  const trailing = run(current, "Top 10 cities by highest murder rate per 100000 in 2025", "current");
  assert.equal(forward.plan.sort.quantity, "rate_per_100k");
  assert.equal(forward.plan.sort.direction, "desc", "and it is still the highest-first ranking");
  assert.equal(forward.built.sql, trailing.built.sql, "the same statement");
  assert.deepEqual(forward.names, trailing.names, "and the same delivered rows");
  assert.ok(forward.names.length > 0, "which is a real answer");
});

check("group membership is per span, so the same words in two clauses are two memberships", () => {
  const plan = recognizeCityRanking(
    "Rank cities by murder rate per 100,000 in 2025 with at least 500 people per 100,000", "current");
  assert.ok(plan && plan.kind === "unsupported", "the population-qualified rate still declines");
  assert.equal((plan as { reason: string }).reason, "population-rate-unsupported");
  const units = (plan as { unitOwnership?: { text: string; group: string }[] }).unitOwnership ?? [];
  const perHundred = units.filter((u) => u.text.trim() === "per 100,000");
  assert.equal(perHundred.length, 2, "both occurrences are recorded separately");
  assert.deepEqual(perHundred.map((u) => u.group), ["ranking", "population:1"],
    "the first belongs to the ranking measure, the second to the population limit");
});

check("contradictory unit contributions on the ranking still decline", () => {
  declined("Rank cities by murder rate counts in 2025", "current", "unit-ambiguous");
  declined("Rank cities by murder counts per 100,000 in 2025", "current", "unit-ambiguous");
  declined("Rank cities by murder rate per 1000 in 2025", "current", "rate-basis-unsupported");
});

/* ------------------------------------------------------------------ *
 * 8. Every supported statement passes the product's own validation
 * ------------------------------------------------------------------ */

check("built statements are accepted by the real contract validator and the real plan guard", () => {
  const supported: [string, CityRankingSource][] = [
    [GC062, "nibrs"],
    [GC063.replace("carjackings", "murders"), "nibrs"],
    ["Rank cities in Texas by shoplifting rate in 2025 with at least 100 shoplifting offenses", "nibrs"],
    ["Bottom 2 cities in Texas by shoplifting rate in 2025", "nibrs"],
    ["Top 10 cities in Texas with fewer than 250000 people by shoplifting rate in 2025", "nibrs"],
    ["Top 10 cities in Texas by murder counts in 2025", "nibrs"],
    [GC039, "current"],
    ["Rank cities by murder counts in 2025", "current"],
  ];
  for (const [question, source] of supported) {
    const plan = recognizeCityRanking(question, source);
    assert.ok(plan && plan.kind === "ranking", question);
    const built = buildCityRanking(plan, OBSERVED_PARTIAL);
    assert.ok(built, question);
    assert.equal(queryContractFailureMessage(validateQueryContractSql({ question, source, sql: built!.sql })), null,
      `${question.slice(0, 32)}… validates cleanly`);
    const refusal = deterministicPlanRefusal({ question, source, sql: built!.sql });
    assert.equal(refusal, null,
      `${question.slice(0, 32)}… passes the route's plan guard${refusal ? `: ${refusal.ruleIds.join(",")}` : ""}`);
  }
});

/* ------------------------------------------------------------------ *
 * 9. Second locks
 * ------------------------------------------------------------------ */

check("the builder refuses a count threshold stated about a different offense", () => {
  const plan = recognizeCityRanking("Rank cities in Texas by murder rate in 2025 with at least 100 murders", "nibrs");
  assert.ok(plan && plan.kind === "ranking");
  const forged: CityRankingRequest = {
    ...plan,
    eligibility: [{
      kind: "count", comparison: ">=", value: 100,
      offense: { kind: "nibrs_codes", codes: ["23C"] }, offenseLabel: "Shoplifting",
    }],
  };
  assert.throws(() => buildCityRanking(forged, OBSERVED_FULL), /stated about a different offense/);
});

check("the builder refuses to interpolate an implausible year or threshold", () => {
  const plan = recognizeCityRanking(GC062, "nibrs") as CityRankingRequest;
  assert.throws(() => buildCityRanking({ ...plan, period: { kind: "explicit", year: 9999 } }, null),
    /refusing to build with year/);
  assert.throws(() => buildCityRanking({ ...plan, resultCount: -1 }, null), /refusing to build with threshold/);
});

check("the narrow helpers read the same clauses the accounting does", () => {
  const population = statedPopulationCondition("cities with at least 250,000 people");
  assert.equal(population!.comparison, ">=");
  assert.equal(population!.value, 250000);
  const threshold = statedCountThreshold("with at least 100 shoplifting offenses");
  assert.equal(threshold!.value, 100);
  assert.equal(threshold!.token, "shoplifting");
  assert.equal(statedCountThreshold("with at least 100 offenses")!.token, null);
  assert.equal(offenseToken("Rank cities by murder rate in 2025"), "murder");
});

/* ------------------------------------------------------------------ *
 * National scope (Codex national-ranking ruling, 2026-10-01). A STATED nationwide scope is its own
 * production: it reaches the same ranking as the unqualified request, with a truthful origin, and
 * competing or different meanings of the same words are not broadened into a nationwide ranking.
 * ------------------------------------------------------------------ */

const NATIONAL_FORMS: [string, (measure: string) => string][] = [
  ["U.S.", (m) => `Which U.S. cities have the highest ${m} rates in 2025?`],
  ["US", (m) => `Which US cities have the highest ${m} rates in 2025?`],
  ["United States", (m) => `What cities in the United States had the highest ${m} rates in 2025?`],
  ["American", (m) => `Which American cities have the highest ${m} rates in 2025?`],
  ["nationwide", (m) => `Which cities nationwide had the highest ${m} rates in 2025?`],
];
const scopeOrigin = (plan: CityRankingRequest) => plan.origins.find((o) => o.field === "scope");

for (const [source, db, measure, label] of [
  ["current", current, "rape", "Current"],
  ["nibrs", nibrs, "murder", "NIBRS"],
] as const) {
  check(`NATIONAL (${label}) — every stated national form delivers the unqualified ranking, non-empty`, () => {
    const base = run(db, `What cities had the highest ${measure} rates in 2025?`, source);
    assert.ok(base.rows.length > 0, "the fixture answer must be non-empty, or equality proves nothing");
    assert.deepEqual(base.plan.scope, { kind: "nationwide" });
    assert.equal(scopeOrigin(base.plan)?.from, "declared-default", "an unqualified request is a genuine omission");
    for (const [form, ask] of NATIONAL_FORMS) {
      const qualified = run(db, ask(measure), source);
      assert.deepEqual(qualified.plan.scope, { kind: "nationwide" }, `${form}: scope`);
      assert.equal(scopeOrigin(qualified.plan)?.from, "production", `${form}: a stated scope is a production, not the omission default`);
      assert.match(scopeOrigin(qualified.plan)!.detail, /^nationwide \(stated: /, `${form}: origin names what was stated`);
      assert.equal(qualified.built.sql, base.built.sql, `${form}: the same statement`);
      assert.deepEqual(qualified.rows, base.rows, `${form}: the same rows`);
      assert.equal(qualified.built.title, base.built.title, `${form}: the same title`);
      assert.deepEqual(qualified.built.caveats, base.built.caveats, `${form}: the same disclosures`);
    }
  });
}

check("NATIONAL — a state control is unchanged: the state stays a state", () => {
  const colorado = run(current, "Which cities in Colorado have the highest rape rates in 2025?", "current");
  assert.deepEqual(colorado.plan.scope, { kind: "state", code: "CO", name: "Colorado" });
  assert.deepEqual(colorado.names, ["DENVER"]);
  const texas = run(nibrs, "Which cities in Texas have the highest murder rates in 2025?", "nibrs");
  assert.equal(texas.plan.scope.kind, "state");
  assert.ok(texas.rows.length > 0 && texas.names.every((n) => n !== "ALBUQUERQUE"), "only Texas cities");
});

check("NATIONAL — competing or different meanings are not broadened into a nationwide ranking", () => {
  for (const source of ["current", "nibrs"] as const) {
    // national plus a state, in either form
    declined("Which American cities in Texas have the highest murder rates in 2025?", source, "national-and-state");
    declined("Which U.S. cities in Texas have the highest murder rates in 2025?", source);
    declined("Which cities nationwide and in Texas have the highest murder rates in 2025?", source);
    // the pronoun, an agency name, a territory and an exclusion are not the country
    declined("Show us the cities with the highest murder rates in 2025", source, "unaccounted-request");
    declined("Which US Marshals cities have the highest murder rates in 2025?", source, "unaccounted-request");
    declined("Which cities in the U.S. Virgin Islands have the highest murder rates in 2025?", source, "unaccounted-request");
    declined("Which cities outside the US have the highest murder rates in 2025?", source, "unaccounted-request");
    const samoa = recognizeCityRanking("Which cities in American Samoa have the highest murder rates in 2025?", source);
    assert.ok(!samoa || samoa.kind !== "ranking", "American Samoa is not the United States");
  }
});

check("NATIONAL (NR-1) — a state stated by postal code is never swallowed into a nationwide ranking", () => {
  for (const source of ["current", "nibrs", "shr"] as const) {
    // Codex NR-1: "in IN" read as preposition + preposition, so the national form delivered every city.
    declined("Which US cities in IN had the highest murder rates in 2025?", source, "national-and-state");
    declined("Which US cities in IN had the most murders in 2025?", source, "national-and-state");
    declined("Which U.S. cities in TX had the most murders in 2025?", source, "national-and-state");
    // Codex NR-1 casing ruling: the preposition's casing must not decide whether the state survives.
    for (const prep of ["IN", "In", "iN"]) {
      declined(`Which US cities ${prep} IN had the highest murder rates in 2025?`, source, "national-and-state");
      declined(`Which US cities ${prep} IN had the most murders in 2025?`, source, "national-and-state");
      declined(`Which cities ${prep} IN had the highest murder rates in 2025?`, source, "state-unresolved");
    }
    declined("Which US cities ACROSS TX had the most murders in 2025?", source);
    declined("Which US cities IN Indiana had the highest murder rates in 2025?", source);
    // The same swallowing without a national word gave a nationwide answer on released 9bc214c too.
    declined("Which cities in IN had the highest murder rates in 2025?", source, "state-unresolved");
    declined("Which cities in TX have the highest murder rates in 2025?", source, "state-unresolved");
    // Full-name counterparts are unchanged: a state ranking, and national-plus-state still refused.
    const indiana = recognizeCityRanking("Which cities in Indiana had the highest murder rates in 2025?", source);
    assert.ok(indiana?.kind === "ranking" && indiana.scope.kind === "state" && indiana.scope.code === "IN", "Indiana spelled out is a state ranking");
    declined("Which US cities in Indiana had the highest murder rates in 2025?", source);
    // The lower-case preposition is never a state, and the national forms still reach the ranking.
    // The code itself stays case-sensitive: "in in"-style lower case is never Indiana, and the pronoun
    // "us" is still not the country.
    declined("Show us the cities with the highest murder rates in 2025", source, "unaccounted-request");
    for (const q of ["Which cities in the US had the highest murder rates in 2025?", "Which US cities have the highest murder rates in 2025?"]) {
      const r = recognizeCityRanking(q, source);
      assert.ok(r?.kind === "ranking" && r.scope.kind === "nationwide", `${q} stays a nationwide ranking`);
    }
  }
});

check("WHAT/WHICH — a state city ranking worded 'What cities in <state>' passes the route's structural proof, as 'Which' does", () => {
  // The defect (2026-10-01 witness, nibrs-what-state): on NIBRS "What cities in Illinois had the highest murder
  // rates" built the state ranking but the route refused it, structural-rate-denominator-unbound.
  for (const [source, db] of [["nibrs", nibrs], ["current", current]] as const) {
    for (const state of ["Illinois", "Texas", "Michigan", "Louisiana"]) {
      for (const lead of ["What", "Which"]) {
        const question = `${lead} cities in ${state} had the highest murder rates in 2025?`;
        const { plan, built } = run(db, question, source);
        assert.equal(plan.scope.kind, "state", question);
        for (const sql of [built.sql, ...(built.completeness ? [built.completeness.candidatesSql] : [])]) {
          assert.equal(deterministicPlanRefusal({ question, source, sql }), null, `${source}: ${question}`);
        }
      }
    }
  }
});

check("NATIONAL — accepted ranking constraints still apply to a national request", () => {
  // NIBRS reporting-jurisdiction limitation (GC-057) is unchanged by a national qualifier.
  declined("Which US jurisdictions had the highest murder rates in 2025?", "nibrs", "jurisdiction-unavailable-nibrs");
  // population eligibility, size and the population-selected-set decline are unchanged.
  const floor = run(nibrs, "Top 10 U.S. cities with at least 250000 people by murder rate in 2025", "nibrs");
  assert.deepEqual(floor.plan.eligibility, [{ kind: "population", comparison: ">=", value: 250000 }]);
  assert.equal(floor.plan.resultCount, 10);
  declined("the 20 largest U.S. cities ranked by 2025 homicide rate", "current");
});

check("NATIONAL — the route's structural proof accepts a stated national scope through its assembled scope", () => {
  // The routes validate an owned ranking against rankingValidationContract (the question less its
  // claimed national words), not the raw question, whose "U.S." reads as national row level.
  let contractHonored = 0;
  for (const [source, db, measure] of [["current", current, "rape"], ["nibrs", nibrs, "murder"]] as const) {
    // A deliberately STATE-level contract for the same statements. If the guard ignored the contract it is
    // handed (validating the raw question instead), these would be accepted -- so a refusal here proves
    // the plumbing honors the contract. (The raw national question can no longer serve as this witness:
    // since the "what cities" row-level cue, 2026-10-02, "What cities in the United States ..." reads as
    // city rows without the adapter too.)
    const stateLevel = buildQueryContract(`What is the ${measure} rate in Illinois in 2025?`, source);
    assert.equal(rankingValidationContract(`What cities had the highest ${measure} rates in 2025?`, source), null,
      "an unqualified request keeps the question's own contract");
    assert.equal(rankingValidationContract("Which cities in Texas have the highest murder rates in 2025?", source), null,
      "a state request keeps the question's own contract");
    assert.equal(rankingValidationContract("Which American cities in Texas have the highest murder rates in 2025?", source), null,
      "a declined request gets no contract");
    for (const [form, ask] of NATIONAL_FORMS) {
      const question = ask(measure);
      const contract = rankingValidationContract(question, source);
      assert.ok(contract, `${form}: a stated national ranking has an assembled validation contract`);
      const { built } = run(db, question, source);
      const statements = [built.sql, ...(built.completeness ? [built.completeness.candidatesSql] : [])];
      for (const sql of statements) {
        assert.equal(deterministicPlanRefusal({ question, source, sql, contract }), null,
          `${form} (${source}): accepted with the assembled scope`);
        // A question with NO row-level cue, so the level comes from the contract: accepted on its own contract
        // (unknown level), refused when the state-level contract is handed in.
        const neutral = `${measure} rates in 2025`;
        if (built.sql === sql && deterministicPlanRefusal({ question: neutral, source, sql }) === null
          && deterministicPlanRefusal({ question: neutral, source, sql, contract: stateLevel })) contractHonored++;
      }
    }
  }
  assert.ok(contractHonored > 0, "a state-level contract handed to the guard refuses the city rows, so the guard uses the contract it is given");
});

nibrs.close();
current.close();
console.log(`\ncity ranking: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
