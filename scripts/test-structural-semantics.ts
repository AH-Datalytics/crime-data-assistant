/**
 * Increment C: a question's meaning must match what the chosen table can represent.
 *
 * Every SQL string in the "confirmed production" cases below is the SQL that actually ran, taken
 * from the query log. Four of the five originally-named cases were already caught on HEAD by
 * `source-capabilities.ts` rules added 2026-07-17 -- that was verified before any of this was
 * written, and those cases are retained here as regressions against the new structural path rather
 * than claimed as new fixes. Two shapes were NOT caught by anything and are the reason this exists:
 * the Florida clearance question and "top 10 us cities".
 */
import assert from "node:assert";
import { buildQueryContract, type QueryContractSource } from "../lib/query-contract";
import { evaluateStructuralSemantics, requestedScope, catalogCoverage } from "../lib/structural-semantics";
import { validateSourceCapabilities } from "../lib/source-capabilities";
import { TABLE_SEMANTICS, tableSemantics, topicUnitRequirement } from "../lib/table-semantics";

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

function rules(question: string, source: QueryContractSource, sql: string): string[] {
  const contract = buildQueryContract(question, source);
  assert.ok(contract, "no contract built");
  return evaluateStructuralSemantics({ question, source, contract: contract!, sql })
    .map((finding) => finding.ruleId);
}

function severities(question: string, source: QueryContractSource, sql: string): string[] {
  const contract = buildQueryContract(question, source)!;
  return evaluateStructuralSemantics({ question, source, contract, sql }).map((f) => f.severity);
}

function capabilityRules(question: string, source: QueryContractSource, sql: string): string[] {
  const contract = buildQueryContract(question, source)!;
  return validateSourceCapabilities({ question, source, contract, sql }).map((f) => f.ruleId);
}

console.log("\n-- the two shapes nothing caught on HEAD --");

check("Florida statewide clearance is blocked: the national table has no state column", () => {
  const question = "What is the clearance rate for rape in Florida by year?";
  const sql = "SELECT year, ROUND(rape_rate, 1) AS rape_clearance_rate FROM national_clearance_rate ORDER BY year LIMIT 1000";
  assert.deepStrictEqual(capabilityRules(question, "historical", sql), [],
    "precondition: HEAD's capability rules do not catch this");
  assert.ok(rules(question, "historical", sql).includes("structural-row-level-substitution"),
    "a state clearance question served from a national-only table must be blocked");
  assert.ok(severities(question, "historical", sql).includes("block"), "it must block, not retry");
});

check("Florida cannot be rescued by averaging agency clearance percentages either", () => {
  const question = "What is the clearance rate for rape in Florida by year?";
  const sql = "SELECT hac.year, AVG(hac.rape_clr) AS rate FROM historical_agency_clearance hac " +
    "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.state = 'fl' GROUP BY hac.year";
  assert.ok(rules(question, "historical", sql).includes("structural-clearance-not-aggregatable"),
    "percentages with no cleared counts or denominators cannot be averaged into a statewide rate");
});

check("'top 10 us cities' is blocked when the SQL returns states", () => {
  const question = "top 10 us cities by homicide rate in 2021";
  const sql = "SELECT state, ROUND(murder_rate, 1) AS homicide_rate FROM historical_state_national " +
    "WHERE year = 2021 AND state != 'United States' ORDER BY homicide_rate DESC LIMIT 10";
  // The logged guardrail column for this query names `historical-state-national-rate-table`, which
  // looks like an objection but is not: that rule only requires historical_state_national to be
  // present, and it is. Evaluated against HEAD the finding list is empty.
  assert.deepStrictEqual(capabilityRules(question, "historical", sql), [],
    "precondition: HEAD raises nothing at all for this shape");
  assert.ok(rules(question, "historical", sql).includes("structural-row-level-substitution"),
    "a request for city rows cannot be answered with state rows");
});

check("the requested row level comes from the breakout, not the filtering geography", () => {
  const question = "top 10 us cities by homicide rate in 2021";
  const contract = buildQueryContract(question, "historical")!;
  assert.strictEqual(contract.geography.kind, "national", "precondition: the contract reads this as national");
  assert.strictEqual(requestedScope(question, contract).rowLevel, "city",
    "every returned row must still be a city");
});

console.log("\n-- cases already caught on HEAD, retained as regressions --");

for (const [name, question, sql] of [
  ["Denver is not answered with Colorado rows",
    "Denver crime rates over time",
    "SELECT year, ROUND(murder_rate, 1) AS murder_rate FROM historical_state_national WHERE state = 'Colorado' ORDER BY year"],
  ["New York City is not answered with New York State rows",
    "Can you please show me the aggravated assault rates for New York City by year from 2019 to 2025?",
    "SELECT year, ROUND(aggravated_assault_rate, 1) AS r FROM historical_state_national WHERE state = 'New York' AND year BETWEEN 2019 AND 2025"],
  ["Alameda County is not answered with state aggregates",
    "violent crime in Alameda County since 2008",
    "SELECT hsn.year, (hsn.murder + hsn.rape + hsn.robbery + hsn.aggravated_assault) AS violent FROM historical_state_national hsn WHERE hsn.state = 'California'"],
] as const) {
  check(name, () => {
    assert.ok(capabilityRules(question, "historical", sql).length > 0,
      "precondition: HEAD already objects to this");
    assert.ok(rules(question, "historical", sql).includes("structural-row-level-substitution"),
      "and the structural path must object too");
  });
}

check("a homicide count is not answered by counting agency directory rows", () => {
  const question = "How many homicides have there been in the City of Los Angeles so far this year?";
  const sql = "SELECT COUNT(DISTINCT ori) AS city_count FROM historical_agency WHERE type = 'city' AND agency IS NOT NULL";
  assert.ok(capabilityRules(question, "historical", sql).includes("historical-agency-lookup-not-crime-data"),
    "precondition: HEAD already objects");
  assert.ok(rules(question, "historical", sql).includes("structural-non-factual-source"),
    "a directory cannot supply a measure");
});

console.log("\n-- the other three sources --");

check("NIBRS: a city question cannot be served from the state summary", () => {
  const question = "murders in Chicago in 2023";
  const bad = "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'IL' AND year = 2023 GROUP BY year";
  const good = "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE city = 'Chicago' AND state = 'IL' AND year = 2023 GROUP BY year";
  assert.ok(rules(question, "nibrs", bad).includes("structural-row-level-substitution"), "state rows cannot answer a city");
  assert.deepStrictEqual(rules(question, "nibrs", good), [], "the city summary must still pass");
});

check("SHR: an agency population column is not a statewide denominator", () => {
  const question = "murder rate per 100k in California";
  const bad = "SELECT year, COUNT(*) * 100000.0 / population AS rate FROM incidents WHERE state = 'CA' GROUP BY year";
  const good = "SELECT i.year, COUNT(*) * 100000.0 / sp.population AS rate FROM incidents i " +
    "JOIN state_population sp ON sp.state = i.state AND sp.year = i.year WHERE i.state = 'CA' GROUP BY i.year";
  assert.ok(rules(question, "shr", bad).includes("structural-rate-denominator-unbound"),
    "incidents.population is per-agency and cannot serve a statewide rate");
  assert.deepStrictEqual(rules(question, "shr", good), [], "state_population is the supported path");
});

check("SHR: a clearance request still declines through the existing rule", () => {
  const question = "What is the homicide clearance rate in Texas?";
  const sql = "SELECT year, COUNT(*) FROM incidents WHERE state = 'TX' GROUP BY year";
  assert.ok(capabilityRules(question, "shr", sql).includes("shr-clearance-unsupported"),
    "this is HEAD's mechanism and must be preserved, not replaced");
});

check("Hate Crime: a state question cannot use a table with no geography column", () => {
  const question = "hate crimes in Texas by year";
  const bad = "SELECT year, SUM(incident_count) FROM summary_hate_crime_bias_trend GROUP BY year";
  const good = "SELECT year, SUM(incident_count) FROM summary_hate_crime_state WHERE state = 'TX' GROUP BY year";
  assert.ok(rules(question, "hate_crime", bad).includes("structural-row-level-substitution"),
    "summary_hate_crime_bias_trend has year/bias/counts and no place column");
  assert.deepStrictEqual(rules(question, "hate_crime", good), [], "the state summary must pass");
});

check("Current Trends: a supported monthly agency count passes; a national table does not", () => {
  const question = "monthly murders in Chicago in 2023";
  const good = "SELECT year, month, SUM(count) FROM agency_monthly WHERE agency = 'Chicago' AND state = 'IL' AND offense = 'Murder' AND year = 2023 GROUP BY year, month";
  const bad = "SELECT year, month, SUM(count) FROM national_monthly WHERE offense = 'Murder' AND year = 2023 GROUP BY year, month";
  assert.deepStrictEqual(rules(question, "current", good), [], "the supported path must not be blocked");
  assert.ok(rules(question, "current", bad).includes("structural-row-level-substitution"), "national rows cannot answer a city");
});

console.log("\n-- things that must NOT be blocked --");

check("a state question served by the state table is correct, not a substitution", () => {
  const question = "California murder rate over time";
  const sql = "SELECT year, murder_rate FROM historical_state_national WHERE state = 'California' ORDER BY year";
  assert.deepStrictEqual(rules(question, "historical", sql), [],
    "state-named agencies must not make a state question look like a city question");
});

check("a national question served by the national table is correct", () => {
  const question = "national murder rate 1960 to 2024";
  const sql = "SELECT year, murder_rate FROM historical_state_national WHERE state = 'United States' ORDER BY year";
  assert.deepStrictEqual(rules(question, "historical", sql), []);
});

check("a legitimate city-versus-national comparison stays allowed", () => {
  const question = "Compare murders in Chicago to the national total since 2018";
  const sql = "SELECT am.year, SUM(am.count) AS chicago, (SELECT SUM(nm.count) FROM national_monthly nm WHERE nm.year = am.year) AS national " +
    "FROM agency_monthly am WHERE am.agency = 'Chicago' AND am.state = 'IL' GROUP BY am.year";
  assert.deepStrictEqual(rules(question, "current", sql), [],
    "several grains may appear as long as one metric table serves the requested level");
});

check("an uncatalogued table fails closed rather than passing silently", () => {
  // This assertion is inverted from the version written for 89c331b, which required SILENCE here.
  // That was the third blocker: a table whose meaning is not established cannot authorise a
  // factual answer, and the ordinary allowlist only proves the table exists.
  const question = "murders in Chicago in 2023";
  assert.ok(
    rules(question, "current", "SELECT t.year, t.total FROM some_future_table t WHERE t.year = 2023")
      .includes("structural-uncatalogued-factual-source"),
    "unknown semantics must fail closed");
});

check("Historical is annual-only, so a monthly request is declined not silently re-grained", () => {
  const question = "monthly murders in Denver in 1990";
  const sql = "SELECT hac.year, hac.murder FROM historical_agency_crime hac WHERE hac.year = 1990";
  assert.ok(rules(question, "historical", sql).includes("structural-time-grain-unavailable"));
});

console.log("\n-- the four blockers from the 89c331b review --");

check("a decorative denominator join is not proof: the division must use it", () => {
  const question = "murder rate per 100k in California";
  const bad = "SELECT i.year, COUNT(*) * 100000.0 / i.population AS rate FROM incidents i "
    + "JOIN state_population sp ON sp.state = i.state AND sp.year = i.year WHERE i.state = 'CA' GROUP BY i.year";
  const good = "SELECT i.year, COUNT(*) * 100000.0 / sp.population AS rate FROM incidents i "
    + "JOIN state_population sp ON sp.state = i.state AND sp.year = i.year WHERE i.state = 'CA' GROUP BY i.year";
  assert.ok(rules(question, "shr", bad).includes("structural-rate-denominator-unbound"),
    "the approved table is joined but unused; the rate still divides by the per-agency column");
  assert.deepStrictEqual(rules(question, "shr", good), [], "using it in the division is the fix");
});

check("a rate written through ROUND() is still traced", () => {
  const question = "murder rate per 100k in Chicago by year";
  const good = "SELECT am.year, ROUND(SUM(am.count) * 100000.0 / ap.population, 1) AS rate "
    + "FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year "
    + "WHERE am.agency = 'Chicago' AND am.state = 'IL' AND am.offense = 'Murder' GROUP BY am.year";
  assert.deepStrictEqual(rules(question, "current", good), []);
});

check("selecting a different offense and relabelling it is caught", () => {
  const question = "murders in Chicago by year since 2000";
  const bad = "SELECT hac.year, hac.robbery AS murders FROM historical_agency_crime hac "
    + "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il'";
  const good = bad.replace("hac.robbery", "hac.murder");
  assert.ok(rules(question, "historical", bad).includes("structural-measure-substitution"),
    "robbery cannot be returned as murders");
  assert.deepStrictEqual(rules(question, "historical", good), []);
});

check("aggravated assault maps to the column each table actually uses", () => {
  const question = "aggravated assaults in Chicago by year";
  const good = "SELECT hac.year, hac.assault AS aggravated_assaults FROM historical_agency_crime hac "
    + "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il'";
  assert.deepStrictEqual(rules(question, "historical", good), [],
    "historical_agency_crime spells it `assault`, not `aggravated_assault`");
});

check("an unrecognised table cannot authorise a factual answer", () => {
  const question = "murders in Chicago in 2023";
  const sql = "SELECT year, COUNT(*) AS murders FROM totally_unknown_table WHERE year = 2023 GROUP BY year";
  assert.ok(rules(question, "current", sql).includes("structural-uncatalogued-factual-source"),
    "unknown semantics must fail closed, not open");
});

check("a real but non-factual table cannot be counted as offenses", () => {
  const question = "murders in Chicago in 2023";
  const sql = "SELECT year, COUNT(*) AS murders FROM source_build_receipts WHERE year = 2023 GROUP BY year";
  assert.ok(rules(question, "current", sql).includes("structural-non-factual-source"),
    "source_build_receipts is build provenance, not crime data");
});

check("each returned series is judged on its own source", () => {
  const question = "murders in Chicago in 2023";
  const mixed = "SELECT nm.year, SUM(nm.count) AS chicago_murders FROM national_monthly nm "
    + "JOIN agency_monthly am ON am.year = nm.year WHERE nm.offense = 'Murder' GROUP BY nm.year";
  assert.ok(rules(question, "current", mixed).includes("structural-row-level-substitution"),
    "joining a compatible table cannot authorise a series drawn from an incompatible one");
});

check("a series whose source cannot be narrowed fails closed", () => {
  // The statement parses; it is one SERIES that cannot be traced. A CTE joining two metric tables
  // leaves a column that role-narrowing cannot resolve, and a measure we cannot attribute must not
  // be executed. This is a different path from an unparseable statement, and the mutation run
  // showed the whole-statement case did not cover it.
  const sql = "WITH joined AS (SELECT i.year, v.id FROM incidents i JOIN victims v ON v.incident_id = i.id) "
    + "SELECT joined.year, SUM(joined.mystery_measure) AS murders FROM joined GROUP BY joined.year";
  assert.ok(rules("murders in Chicago in 2023", "shr", sql).includes("structural-returned-series-unresolved"),
    "a measure that cannot be attributed to a table must fail closed");
});

check("an untraceable returned expression fails closed", () => {
  const findings = rules("murders in Chicago in 2023", "current", "SELECT 1 FROM");
  assert.ok(findings.includes("structural-returned-series-unresolved"),
    "an unparseable statement must not be treated as safe");
});

console.log("\n-- the four gaps from the 0d16004 review --");

check("every arm of a compound query is checked, not just the first", () => {
  // Only the first arm was ever read, so a second arm returning robbery under the label "murders"
  // passed unexamined. Refusing all compounds fixed that but flagged 140 legitimate production
  // queries -- mostly the documented NIBRS victim-plus-offense pattern -- so every arm is read
  // instead, and the substitution is caught on its merits.
  const q = "murders in Chicago by year since 2000";
  const laundered = "SELECT hac.year, hac.murder AS murders FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000' "
    + "UNION ALL SELECT h2.year, h2.robbery AS murders FROM historical_agency_crime h2 WHERE h2.ori = 'IL0316000'";
  const honest = laundered.replace("h2.robbery", "h2.murder");
  assert.ok(rules(q, "historical", laundered).includes("structural-measure-substitution"),
    "the second arm returning robbery must be caught");
  assert.deepStrictEqual(rules(q, "historical", honest), [],
    "a compound whose arms all return the requested measure stays allowed");
});

check("a wildcard projection is refused", () => {
  const q = "murders in Chicago by year since 2000";
  const qualified = "SELECT hac.* FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago'";
  const bare = "SELECT * FROM historical_state_national WHERE state = 'Illinois'";
  assert.ok(rules(q, "historical", qualified).includes("structural-wildcard-projection"),
    "alias.* states nothing about which measure is returned");
  assert.ok(rules(q, "historical", bare).includes("structural-wildcard-projection"));
});

check("multiplication is not mistaken for a wildcard", () => {
  const good = "SELECT i.year, COUNT(*) * 100000.0 / sp.population AS rate FROM incidents i "
    + "JOIN state_population sp ON sp.state = i.state AND sp.year = i.year WHERE i.state = 'CA' GROUP BY i.year";
  assert.deepStrictEqual(rules("murder rate per 100k in California", "shr", good), [],
    "the second * in COUNT(*) * 100000.0 is an operator");
});

check("a CTE column list is mapped positionally, not discarded", () => {
  // `x(murders)` over `SELECT robbery` means x.murders IS robbery. Discarding the declared list
  // invented a column that does not exist and no offense check could match.
  const sql = "WITH x(murders) AS (SELECT robbery FROM historical_agency_crime WHERE ori = 'IL0316000') "
    + "SELECT x.murders FROM x";
  assert.ok(rules("murders in Chicago by year since 2000", "historical", sql)
    .includes("structural-measure-substitution"),
    "robbery relabelled through a CTE column list is still robbery");
});

check("a schema-qualified table resolves to the table, not the schema", () => {
  // `rollup.national_summary_...` is one table in an ATTACHed database.
  const sql = "SELECT d.race, SUM(d.arrestee_count) AS arrests FROM rollup.national_summary_arrestee_demographics d "
    + "WHERE d.age_group = 'Under 18' GROUP BY d.race";
  assert.deepStrictEqual(rules("juvenile arrests by race nationally", "nibrs", sql), [],
    "a real deterministic NIBRS plan must not be refused because of its schema prefix");
});

console.log("\n-- the deeper gaps from the 24e251f review --");

check("a compound inside a CTE body is checked arm by arm", () => {
  // The compound check used to run only over the text AFTER the CTEs were removed, so a second arm
  // hidden in a CTE laundered a different offense into the outer select with nothing to object to.
  const sql = "WITH x AS (SELECT year, murder AS murders FROM historical_agency_crime "
    + "UNION ALL SELECT year, robbery AS murders FROM historical_agency_crime) SELECT year, murders FROM x";
  assert.ok(rules("murders in Chicago by year since 2000", "historical", sql)
    .includes("structural-measure-substitution"),
    "an arm hidden in a CTE is still an arm");
});

check("a recursive series generator is not mistaken for a laundering compound", () => {
  // The SHR deterministic murder plan builds a month series this way. It reads no metric table and
  // refusing it broke a real, correct plan.
  const sql = "WITH RECURSIVE months(month) AS (SELECT 1 UNION ALL SELECT month + 1 FROM months WHERE month < 12) "
    + "SELECT i.year, COUNT(*) AS murder_victims FROM incidents i JOIN victims v ON v.incident_id = i.id "
    + "CROSS JOIN months m WHERE i.state = 'CA' AND i.homicide_type = 'Murder' GROUP BY i.year";
  assert.deepStrictEqual(rules("murder victims in California by year", "shr", sql), []);
});

check("a wildcard is recognised after DISTINCT and when the alias is quoted", () => {
  const q = "murders in Chicago by year since 2000";
  const distinct = "SELECT DISTINCT * FROM historical_agency_crime WHERE ori = 'IL0316000'";
  const quoted = 'SELECT "hac".* FROM historical_agency_crime AS "hac" WHERE "hac".ori = \'IL0316000\'';
  assert.ok(rules(q, "historical", distinct).includes("structural-wildcard-projection"),
    "a leading DISTINCT does not stop it being a wildcard");
  assert.ok(rules(q, "historical", quoted).includes("structural-wildcard-projection"),
    "a quoted alias does not stop it being a wildcard");
});

check("a nested CTE cannot launder a measure through declared columns", () => {
  // cteOutputs() recursed without forwarding the declared column lists, so the positional mapping
  // vanished one level down and `y.murders` resolved to nothing checkable.
  const sql = "WITH x(m) AS (SELECT robbery FROM historical_agency_crime), "
    + "y(murders) AS (SELECT x.m FROM x) SELECT y.murders FROM y";
  assert.ok(rules("murders in Chicago by year since 2000", "historical", sql)
    .includes("structural-measure-substitution"),
    "robbery renamed twice is still robbery");
});

console.log("\n-- the blockers from the d4755ec review --");

check("compound CTE arms align by position, not by each arm's alias", () => {
  // The second arm's `robbery` belongs to output position 2 whatever it is called there. Merging
  // by alias filed it under `anything` and `x.murders` never saw it.
  const sql = "WITH x AS (SELECT year, murder AS murders FROM historical_agency_crime "
    + "UNION ALL SELECT year, robbery AS anything FROM historical_agency_crime) SELECT year, murders FROM x";
  assert.ok(rules("murders in Chicago by year since 2000", "historical", sql)
    .includes("structural-measure-substitution"));
});

check("a multi-offense request must return every offense asked for", () => {
  const q = "murders and robberies in Chicago by year";
  const partial = "SELECT hac.year, hac.murder AS murders FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'";
  const complete = "SELECT hac.year, hac.murder AS murders, hac.robbery AS robberies "
    + "FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'";
  assert.ok(rules(q, "historical", partial).includes("structural-measure-incomplete"),
    "murder alone does not answer a question about murders AND robberies");
  assert.deepStrictEqual(rules(q, "historical", complete), []);
});

check("a composite measure needs its total or ALL of its components", () => {
  const q = "violent crime in Chicago by year";
  const base = "FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'";
  const oneComponent = `SELECT hac.year, hac.murder AS violent_crime ${base}`;
  const storedTotal = `SELECT hac.year, hac.violent AS violent_crime ${base}`;
  const allComponents = `SELECT hac.year, (hac.murder + hac.rape + hac.robbery + hac.assault) AS violent_crime ${base}`;
  assert.ok(rules(q, "historical", oneComponent).includes("structural-measure-incomplete"),
    "one component is not the total");
  assert.deepStrictEqual(rules(q, "historical", storedTotal), [], "the stored total is one valid alternative");
  assert.deepStrictEqual(rules(q, "historical", allComponents), [], "so is the complete component set");
});

check("every SQLite quoted-identifier form is recognised in a wildcard", () => {
  const q = "murders in Chicago by year since 2000";
  for (const [name, sql] of [
    ["bracket", "SELECT [hac].* FROM historical_agency_crime AS [hac] WHERE [hac].ori = 'IL0316000'"],
    ["backtick", "SELECT `hac`.* FROM historical_agency_crime AS `hac` WHERE `hac`.ori = 'IL0316000'"],
    ["double-quote", 'SELECT "hac".* FROM historical_agency_crime AS "hac" WHERE "hac".ori = \'IL0316000\''],
  ] as const) {
    assert.ok(rules(q, "historical", sql).includes("structural-wildcard-projection"),
      `${name}-quoted alias wildcard must be recognised`);
  }
});

console.log("\n-- the unit dimension, from the 3ba2d2e review --");

check("a count question is not answered with a rate column", () => {
  const q = "How many murders in Illinois by year?";
  const wrong = "SELECT year, murder_rate AS murders FROM historical_state_national WHERE state = 'Illinois'";
  const right = "SELECT year, murder FROM historical_state_national WHERE state = 'Illinois'";
  const found = rules(q, "historical", wrong);
  assert.ok(found.includes("structural-measure-substitution") || found.includes("structural-measure-incomplete"),
    "murder_rate is a different measure from murder, not an alternative spelling");
  assert.deepStrictEqual(rules(q, "historical", right), []);
});

check("a rate question is not answered with a bare count", () => {
  const q = "murder rate in Illinois by year";
  const wrong = "SELECT year, murder AS murder_rate FROM historical_state_national WHERE state = 'Illinois'";
  const right = "SELECT year, murder_rate FROM historical_state_national WHERE state = 'Illinois'";
  assert.ok(rules(q, "historical", wrong).includes("structural-measure-incomplete"),
    "a count relabelled as a rate has no denominator behind it");
  assert.deepStrictEqual(rules(q, "historical", right), [], "the stored rate answers it directly");
});

check("a rate DERIVED from counts passes when the denominator is bound", () => {
  const q = "murder rate per 100k in Chicago by year";
  const sql = "SELECT am.year, ROUND(SUM(am.count) * 100000.0 / ap.population, 1) AS rate "
    + "FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year "
    + "WHERE am.agency = 'Chicago' AND am.state = 'IL' AND am.offense = 'Murder' GROUP BY am.year";
  assert.deepStrictEqual(rules(q, "current", sql), [],
    "counts plus an approved denominator are a valid derivation");
});

check("a composite must be complete WITHIN one expression, not pooled across series", () => {
  const q = "violent crime in Chicago by year";
  const base = "FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'";
  const pooled = `SELECT hac.year, hac.murder, hac.rape, hac.robbery, hac.assault ${base}`;
  const summed = `SELECT hac.year, (hac.murder + hac.rape + hac.robbery + hac.assault) AS violent_crime ${base}`;
  assert.ok(rules(q, "historical", pooled).includes("structural-measure-incomplete"),
    "four separate offense series are not a violent-crime total");
  assert.deepStrictEqual(rules(q, "historical", summed), [], "one expression combining them is");
});

check("a multi-offense request may still use one expression per offense", () => {
  const q = "murders and robberies in Chicago by year";
  const sql = "SELECT hac.year, hac.murder AS murders, hac.robbery AS robberies "
    + "FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'";
  assert.deepStrictEqual(rules(q, "historical", sql), [],
    "each requested topic is satisfied by its own complete expression");
});

console.log("\n-- unmodeled units fail closed (from the e08c761 review) --");

check("a raw count cannot answer a share in ANY source", () => {
  // The rule first landed only on `topic_columns` tables, so Current Trends, SHR and NIBRS kept
  // answering "what share" with a bare total. `COUNT(*)` made it worse: with no column references
  // it contributed no table at all, so the check never even considered it.
  const question = "What share of Chicago murders occurred in 2020?";
  const perSource: [QueryContractSource, string][] = [
    ["current", "SELECT SUM(count) AS share FROM agency_monthly WHERE agency = 'Chicago' AND state = 'IL' AND offense = 'Murder' AND year = 2020"],
    ["shr", "SELECT COUNT(*) AS share FROM incidents WHERE state = 'IL' AND year = 2020"],
    ["nibrs", "SELECT SUM(victim_count) AS share FROM summary_victim_city_monthly WHERE state = 'IL' AND year = 2020"],
    ["hate_crime", "SELECT SUM(incident_count) AS share FROM summary_hate_crime_state WHERE state = 'TX'"],
    ["historical", "SELECT hac.murder AS share FROM historical_agency_crime hac WHERE hac.ori = 'IL0316000'"],
  ];
  for (const [source, sql] of perSource) {
    assert.ok(rules(question, source, sql).includes("structural-measure-unit-unmodeled"),
      `${source} must not answer a share with a raw count`);
  }
});

check("a bare COUNT(*) still resolves to its statement's base tables", () => {
  // The completeness pass derived its tables from column references only, so `COUNT(*)` was
  // invisible to it. It now uses the same rule as the per-item loop.
  const sql = "SELECT COUNT(*) AS share FROM incidents WHERE state = 'IL' AND year = 2020";
  assert.ok(rules("What share of Chicago murders occurred in 2020?", "shr", sql).length > 0,
    "a row count with no column references must still be attributed to a source");
});

check("modeled units are unaffected in every source", () => {
  const cases: [QueryContractSource, string, string][] = [
    ["current", "monthly murders in Chicago in 2023",
      "SELECT am.year, am.month, SUM(am.count) AS murders FROM agency_monthly am WHERE am.agency = 'Chicago' AND am.state = 'IL' AND am.offense = 'Murder' AND am.year = 2023 GROUP BY am.year, am.month"],
    ["shr", "murder victims in California by year",
      "SELECT i.year, COUNT(*) AS murder_victims FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.state = 'CA' AND i.homicide_type = 'Murder' GROUP BY i.year"],
    ["nibrs", "murders in Chicago in 2023",
      "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE state = 'IL' AND year = 2023 GROUP BY year"],
  ];
  for (const [source, question, sql] of cases) {
    assert.deepStrictEqual(rules(question, source, sql), [], `${source} count question`);
  }
});

check("a share request is not satisfied by a raw count", () => {
  // `ratio` used to fold into `count`, so a bare murder total answered "what share".
  const rawCount = "SELECT hac.murder AS share FROM historical_agency_crime hac "
    + "JOIN historical_agency ha ON ha.ori = hac.ori "
    + "WHERE ha.agency = 'Chicago' AND ha.state = 'il' AND hac.year = 2020";
  for (const question of [
    "What share of Chicago murders occurred in 2020?",
    "What percentage of Chicago murders occurred in 2020?",
    "What percent of murders in Chicago were in 2020?",
  ]) {
    assert.ok(rules(question, "historical", rawCount).includes("structural-measure-unit-unmodeled"),
      `"${question}" must not be answered with a count`);
  }
});

check("an unmodeled unit never borrows another unit's columns", () => {
  const question = "What share of Chicago murders occurred in 2020?";
  const contract = buildQueryContract(question, "historical")!;
  assert.strictEqual(contract.metric.unit, "ratio", "precondition: the contract reads this as a ratio");
  const entry = tableSemantics("historical", "historical_agency_crime")!;
  assert.strictEqual(topicUnitRequirement(entry, "murder", "ratio"), null,
    "there is no ratio requirement, and the count requirement must not stand in for one");
  assert.ok(topicUnitRequirement(entry, "murder", "count"), "the count requirement still exists");
});

check("the modeled units are unaffected", () => {
  const cases: [string, string][] = [
    ["How many murders in Chicago in 2020?",
      "SELECT hac.year, hac.murder AS murders FROM historical_agency_crime hac "
      + "JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = 'Chicago' AND ha.state = 'il'"],
    ["murder rate in Illinois by year",
      "SELECT year, murder_rate FROM historical_state_national WHERE state = 'Illinois'"],
    ["murder clearance rate in Chicago by year",
      "SELECT hac.year, hac.murder_clr FROM historical_agency_clearance hac WHERE hac.ori = 'IL0316000'"],
  ];
  for (const [question, sql] of cases) {
    assert.deepStrictEqual(rules(question, "historical", sql), [], question);
  }
});

console.log("\n-- a row count is a measure only where one row IS the occurrence --");

check("a number with no column behind it cannot be an offense count", () => {
  // historical_agency_crime has one row per agency-YEAR, so none of these returns a murder count.
  const q = "murders in Chicago by year since 2000";
  for (const [name, sql] of [
    ["COUNT(*)", "SELECT COUNT(*) AS murders FROM historical_agency_crime WHERE ori = 'IL0316000'"],
    ["a constant", "SELECT 5 AS murders FROM historical_agency_crime WHERE ori = 'IL0316000'"],
    ["SUM(1)", "SELECT SUM(1) AS murders FROM historical_agency_crime WHERE ori = 'IL0316000'"],
  ] as const) {
    const found = rules(q, "historical", sql);
    assert.ok(found.includes("structural-row-count-not-a-measure"),
      `${name} must not pass as a murder count`);
    // And it must fail COMPLETENESS too: none of these selects the required measure column, so the
    // topic is not satisfied by any expression. The two rules are separate guarantees.
    assert.ok(found.includes("structural-measure-incomplete"),
      `${name} must also fail completeness: no expression selects the murder column`);
  }
});

check("counting rows IS the measure only where the PRODUCT says so", () => {
  // Only SHR `victims` survives this test. One row per victim, and the SHR default measure is
  // "murder victim counts" (shr-claude.ts:17). Three other tables looked occurrence-shaped and were
  // wrong, each contradicting an existing metric definition -- see the negatives below.
  assert.deepStrictEqual(
    rules("murder victims in California by year", "shr",
      "SELECT i.year, COUNT(*) AS murder_victims FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.state = 'CA' AND i.homicide_type = 'Murder' GROUP BY i.year"),
    [], "one victim row is one MURDER victim only under the join and the homicide_type filter");
});

check("an SHR row count without the murder predicate is refused", () => {
  // The licence is conditional. shr-claude.ts:123 requires the victims join, and every example in
  // that prompt filters i.homicide_type = 'Murder'; victims rows are homicides, murder is a subset.
  for (const [name, sql] of [
    ["unfiltered COUNT(*)", "SELECT v.year, COUNT(*) AS murders FROM victims v WHERE v.state = 'CA' GROUP BY v.year"],
    ["unfiltered COUNT(v.id)", "SELECT v.year, COUNT(v.id) AS murders FROM victims v WHERE v.state = 'CA' GROUP BY v.year"],
  ] as const) {
    assert.ok(rules("murders in California by year", "shr", sql).includes("structural-row-count-unqualified"),
      `${name} counts homicide victims, not murder victims`);
  }
});

check("mentioning the murder predicate is not applying it", () => {
  // The first version of this licence searched the statement text for `homicide_type = 'Murder'`
  // and accepted a hit. All four of these contain that text and none of them restricts the rows
  // being counted -- the same mention-versus-enforcement error the ORI pin had to fix.
  const joined = "FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE v.state = 'CA'";
  for (const [name, sql] of [
    ["in a line comment",
      `SELECT COUNT(v.id) AS murders ${joined} -- and i.homicide_type = 'Murder'`],
    ["in a block comment",
      `SELECT COUNT(v.id) AS murders ${joined} /* i.homicide_type = 'Murder' */`],
    // The CTE holds BOTH tables and a real restriction. Only the fact that nothing references it
    // makes this unsafe, so this case pins the used-CTE gate and nothing else.
    ["in a CTE the query never uses",
      "WITH m AS (SELECT v.id FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.homicide_type = 'Murder') "
      + `SELECT COUNT(v.id) AS murders ${joined}`],
    // Unparenthesised, so paren-flattening cannot be what refuses it -- the OR guard must.
    ["broadened by OR",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.homicide_type = 'Murder' OR v.state = 'CA'"],
    // An outer join preserves every victim row and blanks the incident columns for non-murders,
    // so its ON restricts nothing. This over-counted by exactly the rows it looked like it excluded.
    ["on a LEFT JOIN's ON, which preserves unmatched victims",
      "SELECT COUNT(v.id) AS murders FROM victims v LEFT JOIN incidents i "
      + "ON v.incident_id = i.id AND i.homicide_type = 'Murder' WHERE v.state = 'CA'"],
    ["in a CTE the query only LEFT JOINs",
      "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
      + "SELECT COUNT(v.id) AS murders FROM victims v LEFT JOIN m ON m.id = v.incident_id "
      + "WHERE v.state = 'CA'"],
    ["in a used CTE that never touches the filter table",
      "WITH m AS (SELECT 'Murder' AS homicide_type) "
      + "SELECT COUNT(v.id) AS murders FROM victims v JOIN m ON 1=1 WHERE v.state = 'CA'"],
    // `homicide_type` lives on `incidents`, not on `victims`. Attributing it to the victims table
    // skips the join, and the join is half of what makes the count a murder count.
    ["attributed to the victims table, with no join to incidents",
      "SELECT COUNT(v.id) AS murders FROM victims v "
      + "WHERE v.homicide_type = 'Murder' AND v.state = 'CA'"],
    ["in an inner-joined CTE that restricts the wrong table",
      "WITH m AS (SELECT id FROM victims WHERE homicide_type = 'Murder') "
      + "SELECT COUNT(v.id) AS murders FROM victims v JOIN m ON m.id = v.id WHERE v.state = 'CA'"],
    ["broadened by a multi-value IN",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.homicide_type IN ('Murder', 'Manslaughter') AND v.state = 'CA'"],
    ["restricting only an unrelated subquery",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE v.state = 'CA' AND i.year IN (SELECT year FROM incidents WHERE homicide_type = 'Murder')"],
  ] as const) {
    assert.ok(rules("murders in California", "shr", sql).includes("structural-row-count-unqualified"),
      `the predicate ${name} does not restrict the victims being counted`);
  }
});

check("the murder predicate applied to the counted rows is accepted", () => {
  for (const [name, sql] of [
    ["directly in the WHERE",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE v.state = 'CA' AND i.homicide_type = 'Murder'"],
    ["written the other way round",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE v.state = 'CA' AND 'Murder' = i.homicide_type"],
    ["as a single-value IN",
      "SELECT COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE v.state = 'CA' AND i.homicide_type IN ('Murder')"],
    ["on the join condition",
      "SELECT COUNT(v.id) AS murders FROM victims v JOIN incidents i "
      + "ON v.incident_id = i.id AND i.homicide_type = 'Murder' WHERE v.state = 'CA'"],
    // The product's own deterministic plan pins the predicate inside a CTE that the outer query
    // really uses. Refusing this shape would refuse the shipped query.
    ["inside a CTE the query does use",
      "WITH counts AS (SELECT i.year AS year, COUNT(v.id) AS murders "
      + "FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.state = 'CA' AND i.homicide_type = 'Murder' GROUP BY i.year) "
      + "SELECT year, murders FROM counts ORDER BY year"],
    // Logged queries #157/#159: a bracketed alias list is ANDed onto the murder filter. The OR is
    // parenthesised, so it widens nothing, and refusing this rejected two correct answers.
    ["alongside a parenthesised OR over place aliases",
      "SELECT i.year, COUNT(v.id) AS murders FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.homicide_type = 'Murder' AND i.year >= 2022 "
      + "AND (i.agency = 'New York' OR i.agency = 'New York City') GROUP BY i.year"],
    // The house idiom: the CTE pins the predicate and the counting query INNER joins it, so every
    // counted victim is reached through the restriction. `cteTargetsOri` accepts the same shape.
    ["in a CTE the counting query INNER joins",
      "WITH m AS (SELECT id FROM incidents WHERE homicide_type = 'Murder') "
      + "SELECT COUNT(v.id) AS murders FROM victims v JOIN m ON m.id = v.incident_id "
      + "WHERE v.state = 'CA'"],
  ] as const) {
    assert.deepStrictEqual(rules("murders in California", "shr", sql), [],
      `the predicate ${name} restricts the victims being counted`);
  }
});

check("a row count is refused where the product defines the measure differently", () => {
  // Each of these contradicts an established definition in the application itself.
  const negatives: [QueryContractSource, string, string, string][] = [
    ["shr", "murders in California by year",
      "SELECT i.year, COUNT(*) AS murders FROM incidents i WHERE i.state = 'CA' GROUP BY i.year",
      "one incident can have many victims; the SHR measure is victims"],
    ["hate_crime", "hate crimes in Texas by year",
      "SELECT h.year, COUNT(*) AS incidents FROM hate_crime_incidents h WHERE h.state = 'TX' GROUP BY h.year",
      "hc-claude.ts:23 calls COUNT(*) here `offense_count`, not the default incident count"],
    ["nibrs", "domestic violence incidents in Texas in 2025",
      "SELECT state, COUNT(*) AS dv_incidents FROM summary_domestic_violence WHERE data_year = 2025 GROUP BY state",
      "the product counts DISTINCT incidents, not victim-offense rows"],
  ];
  for (const [source, question, sql, why] of negatives) {
    assert.ok(rules(question, source, sql).includes("structural-row-count-not-a-measure"), why);
  }
});

check("the established distinct-key queries still pass", () => {
  assert.deepStrictEqual(
    rules("domestic violence incidents in Texas in 2025", "nibrs",
      "SELECT state, COUNT(DISTINCT ori || ':' || data_year || ':' || incident_num) AS dv_incidents "
      + "FROM summary_domestic_violence WHERE data_year = 2025 GROUP BY state"),
    [], "the guardrail's own DV pattern must not be flagged");
  assert.deepStrictEqual(
    rules("hate crimes in Texas by year", "hate_crime",
      "SELECT year, COUNT(DISTINCT incident_number || '|' || ori || '|' || year) AS incidents "
      + "FROM hate_crime_incidents WHERE state = 'TX' GROUP BY year"),
    [], "the prompt's own default hate-crime pattern must not be flagged");
  assert.deepStrictEqual(
    rules("murders in California by year", "shr",
      "SELECT i.year, COUNT(v.id) AS murder_victims FROM incidents i JOIN victims v ON v.incident_id = i.id "
      + "WHERE i.state = 'CA' AND i.homicide_type = 'Murder' GROUP BY i.year"),
    [], "the deterministic murder plan's own measure must not be flagged");
});

check("a pre-aggregated table's rows are buckets, not occurrences", () => {
  // agency_monthly is one agency-month-offense bucket per row with a `count` column.
  const q = "monthly murders in Chicago in 2023";
  const bucketCount = "SELECT am.year, COUNT(*) AS murders FROM agency_monthly am "
    + "WHERE am.agency = 'Chicago' AND am.state = 'IL' GROUP BY am.year";
  const realCount = "SELECT am.year, am.month, SUM(am.count) AS murders FROM agency_monthly am "
    + "WHERE am.agency = 'Chicago' AND am.state = 'IL' AND am.offense = 'Murder' AND am.year = 2023 "
    + "GROUP BY am.year, am.month";
  assert.ok(rules(q, "current", bucketCount).includes("structural-row-count-not-a-measure"),
    "counting buckets is not counting murders");
  assert.deepStrictEqual(rules(q, "current", realCount), [], "summing the count column is");
});

check("eventRow is declared only where the PRODUCT's measure is one row", () => {
  // Exactly one table passes. Three others were declared and removed after review, each because it
  // contradicted a definition already in the application.
  assert.ok(tableSemantics("shr", "victims")?.eventRow, "shr.victims is one victim per row");
  for (const [source, table, why] of [
    ["shr", "incidents", "one incident, many victims; the measure is victims"],
    ["hate_crime", "hate_crime_incidents", "COUNT(*) here is offense_count, not the default"],
    ["nibrs", "summary_domestic_violence", "the product counts DISTINCT incidents"],
    ["historical", "historical_agency_crime", "one agency-year per row"],
    ["current", "agency_monthly", "one agency-month-offense bucket per row"],
    ["nibrs", "summary_victim_city_monthly", "pre-aggregated"],
  ] as const) {
    assert.ok(!tableSemantics(source, table)?.eventRow, `${source}.${table}: ${why}`);
  }
});

console.log("\n-- catalog --");

check("every catalogued table separates physical row key from output levels", () => {
  for (const entry of TABLE_SEMANTICS) {
    assert.ok(entry.role, `${entry.table} has no role`);
    assert.ok(entry.rowKey, `${entry.table} has no rowKey`);
    assert.ok(Array.isArray(entry.outputLevels), `${entry.table} has no outputLevels`);
    assert.ok(entry.measures.length > 0, `${entry.table} declares no measures`);
    assert.ok(entry.timeGrains.length > 0, `${entry.table} declares no time grains`);
    assert.ok(entry.components === "present" || entry.components === "absent",
      `${entry.table} does not say whether its components are present`);
  }
});

check("a table keyed by ori is recorded as agency-keyed even when its name says city", () => {
  const city = tableSemantics("nibrs", "summary_city_monthly");
  assert.ok(city, "summary_city_monthly must be catalogued");
  assert.strictEqual(city!.rowKey, "agency", "it carries ori, so one row is an agency");
  assert.ok(city!.outputLevels.includes("city"), "it can still produce city output");
});

check("all five sources are covered in this increment", () => {
  for (const source of ["current", "historical", "nibrs", "shr", "hate_crime"] as QueryContractSource[]) {
    const coverage = catalogCoverage(source);
    assert.ok(coverage.tables > 0, `${source} has no catalogued tables`);
    assert.ok(coverage.metric > 0, `${source} has no metric table`);
  }
});

check("non-aggregatability is a typed property, not a sentence", () => {
  const clearance = tableSemantics("historical", "historical_agency_clearance");
  assert.ok(clearance, "historical_agency_clearance must be catalogued");
  assert.strictEqual(clearance!.components, "absent", "no cleared counts or denominators exist");
  assert.strictEqual(clearance!.aggregation, "not-aggregatable");
  assert.ok(!clearance!.outputLevels.includes("state"),
    "so it must not be able to produce a statewide figure");
});

console.log(`\nstructural semantics: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
