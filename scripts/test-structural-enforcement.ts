/**
 * Increment C: the structural findings must actually stop a query, not merely be observed.
 *
 * The previous increment's lesson was that detection without enforcement is worth very little --
 * `historical-local-geography-state-table` had existed since 2026-07-17 and still only produced a
 * retry directive. These assertions go through `validateQueryContractSql`, which is what all four
 * routes call (36 call sites across the initial, retry, deterministic and follow-up paths), so a
 * finding that does not reach `blockReasons` or `retryIssues` fails here.
 */
import assert from "node:assert";
import { validateQueryContractSql, queryContractFailureMessage } from "../lib/query-contract-validator";
import type { QueryContractSource } from "../lib/query-contract";

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message.split("\n")[0]}`);
  }
}

function validate(question: string, source: QueryContractSource, sql: string) {
  return validateQueryContractSql({ question, source, sql });
}

const FLORIDA = "What is the clearance rate for rape in Florida by year?";
const FLORIDA_SQL = "SELECT year, ROUND(rape_rate, 1) AS rape_clearance_rate FROM national_clearance_rate ORDER BY year LIMIT 1000";
const CITIES = "top 10 us cities by homicide rate in 2021";
const CITIES_SQL = "SELECT state, ROUND(murder_rate, 1) AS homicide_rate FROM historical_state_national WHERE year = 2021 AND state != 'United States' ORDER BY homicide_rate DESC LIMIT 10";

console.log("\n-- blocked, not merely warned --");

check("Florida statewide clearance reaches blockReasons", () => {
  const result = validate(FLORIDA, "historical", FLORIDA_SQL);
  assert.ok(result.blockReasons.length > 0, "the query must be blocked before execution");
  assert.ok(result.enforced.includes("structural-row-level-substitution"), "and recorded as enforced");
  assert.deepStrictEqual(result.retryIssues, [], "a block supersedes any retry directive");
});

check("the Florida block carries a server-authored reason, not a generic message", () => {
  const message = queryContractFailureMessage(validate(FLORIDA, "historical", FLORIDA_SQL));
  assert.ok(message, "there must be a message");
  assert.ok(/national/i.test(message!) && /state/i.test(message!),
    "it should say which level was asked for and which the table holds");
  assert.ok(!/couldn't build a reliable query/i.test(message!),
    "a specific structural reason must not be replaced by the generic second-failure text");
});

console.log("\n-- repairable substitutions retry once, then the existing gate blocks --");

// Denver and "top 10 us cities" are both answerable from historical_agency_crime joined to
// historical_agency_population, so blocking them outright would cut answer coverage for no
// correctness gain. They get one rewrite; `contract_second_failure` stops a second offence. This is
// the distinction `test-layer3-contract-corpus.ts` already encodes, and it caught an earlier draft
// of this increment that blocked on the first attempt.
for (const [name, question, sql] of [
  ["'top 10 us cities' returning states", CITIES, CITIES_SQL],
  ["Denver answered with Colorado rows", "Denver crime rates over time",
    "SELECT year, ROUND(murder_rate, 1) AS murder_rate FROM historical_state_national WHERE state = 'Colorado' ORDER BY year"],
] as const) {
  check(name + " asks for a rewrite rather than blocking", () => {
    const result = validate(question, "historical", sql);
    assert.ok(result.enforced.includes("structural-row-level-substitution"), "it must still be caught");
    assert.strictEqual(result.blockReasons.length, 0, "a repairable mismatch must not block on the first attempt");
    assert.ok(result.retryIssues.some((issue) => /structural-row-level-substitution/.test(issue)),
      "and must produce a structural retry directive");
  });
}

check("a repairable mismatch that survives the retry cannot execute", () => {
  // This is what the route evaluates at its post-retry gate.
  const message = queryContractFailureMessage(validate(CITIES, "historical", CITIES_SQL));
  assert.ok(message, "an unrepaired retry issue must still yield a refusal message at the second gate");
});

check("aggregating agency clearance percentages blocks", () => {
  const result = validate(FLORIDA, "historical",
    "SELECT hac.year, AVG(hac.rape_clr) AS rate FROM historical_agency_clearance hac " +
    "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'fl' GROUP BY hac.year");
  assert.ok(result.enforced.includes("structural-clearance-not-aggregatable"));
  assert.ok(result.blockReasons.length > 0);
});

console.log("\n-- repairable mismatches ask for a retry --");

check("a missing rate denominator is a retry, not a block", () => {
  const result = validate("murder rate per 100k in California", "shr",
    "SELECT year, COUNT(*) * 100000.0 / population AS rate FROM incidents WHERE state = 'CA' GROUP BY year");
  assert.strictEqual(result.blockReasons.length, 0, "this is repairable");
  assert.ok(result.retryIssues.some((issue) => /structural-rate-denominator-unbound/.test(issue)));
  assert.ok(result.retryIssues.some((issue) => /Do not substitute a different geography or measure/.test(issue)),
    "the directive must forbid substitution rather than inviting a different answer");
});

check("counting a directory instead of offenses is a retry", () => {
  const result = validate("How many homicides have there been in the City of Los Angeles so far this year?",
    "historical", "SELECT COUNT(DISTINCT ori) AS city_count FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL");
  assert.ok(result.retryIssues.some((issue) => /structural-non-factual-source/.test(issue)));
});

console.log("\n-- correct queries are untouched --");

for (const [name, question, source, sql] of [
  ["a state question on the state table", "California murder rate over time", "historical",
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'California' ORDER BY year"],
  ["a national question on the national table", "national murder rate 1960 to 2024", "historical",
    "SELECT year, murder_rate FROM historical_state_national WHERE state = 'United States' ORDER BY year"],
  ["a city question on the city summary", "murders in Chicago in 2023", "nibrs",
    "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE city = 'Chicago' AND state = 'IL' AND year = 2023 GROUP BY year"],
  ["a supported hate-crime state query", "hate crimes in Texas by year", "hate_crime",
    "SELECT year, SUM(incident_count) FROM summary_hate_crime_state WHERE state = 'TX' GROUP BY year"],
] as const) {
  check(name + " is not blocked", () => {
    const result = validate(question, source as QueryContractSource, sql);
    const structural = result.enforced.filter((id) => id.startsWith("structural-"));
    assert.deepStrictEqual(structural, [], `unexpected structural enforcement: ${structural.join(", ")}`);
  });
}

check("a legitimate multi-level comparison is not blocked", () => {
  const result = validate("Compare murders in Chicago to the national total since 2018", "current",
    "SELECT am.year, SUM(am.count) AS chicago, (SELECT SUM(nm.count) FROM national_monthly nm WHERE nm.year = am.year) AS national " +
    "FROM agency_monthly am WHERE am.agency = 'Chicago' AND am.state = 'IL' GROUP BY am.year");
  assert.deepStrictEqual(result.enforced.filter((id) => id.startsWith("structural-")), []);
});

console.log("\n-- the existing machinery is preserved --");

check("the county ORI restriction still blocks independently", () => {
  const result = validateQueryContractSql({
    question: "violent crime in Baltimore County, MD",
    source: "historical",
    sql: "SELECT hac.year, hac.murder FROM historical_agency_crime hac WHERE hac.ori = 'MD0030000'",
    requiredOri: "MD0030100",
  });
  assert.ok(result.enforced.includes("contract-required-county-ori"),
    "increment C must not weaken the resolved-ORI restriction");
});

check("existing capability blocks still fire", () => {
  const result = validate("What is the homicide clearance rate in Texas?", "shr",
    "SELECT year, COUNT(*) FROM incidents WHERE state = 'TX' GROUP BY year");
  assert.ok(result.enforced.includes("shr-clearance-unsupported"));
});

console.log(`\nstructural enforcement: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
