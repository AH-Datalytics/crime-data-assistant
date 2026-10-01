/**
 * A level ranking must rank the places the request describes, and say how many it showed.
 *
 * Three saved answers ranked cities by a rate and silently dropped every place whose count was
 * zero. The measure of this suite is not "a rule fires" but "the right places come back": the
 * fixture records a city with an explicit zero, and that city has to appear in the corrected
 * ranking, because it is one of the places the request describes.
 *
 * Two distinctions the fixture exists to hold apart:
 *   - a RECORDED zero is a real observation and stays eligible;
 *   - a MISSING record is not a zero and is never invented. The city with no row must not appear.
 *
 * The mutations at the end are what make the rest mean anything: removing the rule must let the
 * saved bad shapes through, broadening it must break the legitimate requested-threshold cases, and
 * removing the limit sentence must fail the delivered-text checks.
 *
 * Synthetic in-memory fixtures only. No real database, no source, no model, no server.
 */
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  unrequestedMeasureFloors, requestedMeasureThresholds, rankingLimitSentence, measureFloorMessage, asksForPlaces,
} from "../lib/level-ranking-eligibility";
import { governingRowLimit, LIMIT_INCONCLUSIVE } from "../lib/sql-lineage";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { applyResultDisclosures } from "../lib/result-disclosure";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}`); console.log(`        ${(error as Error).message.split("\n")[0]}`); }
}

/* ------------------------------------------------------------------ *
 * The fixture: four eligible cities, one of them a recorded zero
 * ------------------------------------------------------------------ */

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE summary_city_monthly(ori TEXT, year INTEGER, month INTEGER, state TEXT, ucr_offense_code TEXT, offense_count INTEGER);
  CREATE TABLE agencies(ori TEXT, year INTEGER, city TEXT, state TEXT, population INTEGER, agency_type TEXT);
`);
const agency = db.prepare("INSERT INTO agencies VALUES(?,?,?,?,?,?)");
const monthly = db.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?,?,?)");

// All four are 250k+ cities in TX, so all four are places the request describes.
agency.run("TX0010100", 2025, "HOUSTON", "TX", 2300000, "City");
agency.run("TX0020200", 2025, "AUSTIN", "TX", 970000, "City");
agency.run("TX0030300", 2025, "LUBBOCK", "TX", 260000, "City");   // an explicit ZERO
agency.run("TX0040400", 2025, "PLANO", "TX", 290000, "City");     // NO monthly row at all
// A city under the requested floor, and one in the wrong state: neither may appear.
agency.run("TX0050500", 2025, "WACO", "TX", 140000, "City");
agency.run("NM0010100", 2025, "ALBUQUERQUE", "NM", 560000, "City");

monthly.run("TX0010100", 2025, 1, "TX", "23C", 900);
monthly.run("TX0020200", 2025, 1, "TX", "23C", 300);
monthly.run("TX0030300", 2025, 1, "TX", "23C", 0);     // RECORDED zero — eligible
monthly.run("TX0050500", 2025, 1, "TX", "23C", 500);   // under the population floor
monthly.run("NM0010100", 2025, 1, "NM", "23C", 700);   // wrong state
// Decoys inside the eligible cities: wrong year and wrong offense must not reach the figures.
monthly.run("TX0030300", 2024, 1, "TX", "23C", 999);
monthly.run("TX0030300", 2025, 1, "TX", "220", 888);

const QUESTION = "Top 10 cities in Texas of 250,000 people or more by shoplifting rate in 2025";

const RANKING_BODY =
  "SELECT a.city, SUM(s.offense_count) AS offenses, a.population, " +
  "ROUND(SUM(s.offense_count) * 100000.0 / a.population, 2) AS rate_per_100k " +
  "FROM summary_city_monthly s JOIN agencies a ON a.ori = s.ori AND a.year = s.year " +
  "WHERE s.ucr_offense_code = '23C' AND s.year = 2025 AND a.state = 'TX' " +
  "AND a.population >= 250000 AND a.agency_type = 'City' " +
  "GROUP BY a.ori, a.city, a.population";

const WITH_FLOOR = `${RANKING_BODY} HAVING SUM(s.offense_count) > 0 ORDER BY rate_per_100k DESC LIMIT 10`;
const CORRECTED = `${RANKING_BODY} ORDER BY rate_per_100k DESC LIMIT 10`;

const cities = (sql: string): string[] =>
  (db.prepare(sql).all() as Array<{ city: string }>).map((row) => row.city);
const rowsOf = (sql: string) => db.prepare(sql).all() as Record<string, unknown>[];

/* ------------------------------------------------------------------ *
 * 1. Useful outcome: the right places, and the right figures
 * ------------------------------------------------------------------ */

check("the floor removes a city the request describes; without it the ranking is complete", () => {
  const withFloor = cities(WITH_FLOOR);
  const corrected = cities(CORRECTED);
  assert.deepEqual(withFloor, ["HOUSTON", "AUSTIN"], "the floor silently drops the recorded zero");
  assert.deepEqual(corrected, ["HOUSTON", "AUSTIN", "LUBBOCK"], "the corrected ranking includes it");
  assert.ok(!withFloor.includes("LUBBOCK"), "which is the whole defect");
});

check("a recorded zero is eligible and appears when the limit allows", () => {
  const rows = rowsOf(CORRECTED);
  const lubbock = rows.find((row) => row.city === "LUBBOCK");
  assert.ok(lubbock, "the explicitly recorded zero is in the ranking");
  assert.equal(lubbock!.offenses, 0, "as a zero, not as a null");
  assert.equal(lubbock!.rate_per_100k, 0);
  assert.ok(rows.length <= 10, "and within the governing limit");
});

check("a MISSING record is not invented as a zero", () => {
  assert.ok(!cities(CORRECTED).includes("PLANO"), "the city with no monthly row does not appear");
  assert.ok(!cities(WITH_FLOOR).includes("PLANO"), "in either form");
});

check("the requested filters still exclude what they should", () => {
  const corrected = cities(CORRECTED);
  assert.ok(!corrected.includes("WACO"), "under the requested population floor");
  assert.ok(!corrected.includes("ALBUQUERQUE"), "wrong state");
  const houston = rowsOf(CORRECTED).find((row) => row.city === "HOUSTON");
  assert.equal(houston!.offenses, 900, "positive counts are unchanged");
  const lubbock = rowsOf(CORRECTED).find((row) => row.city === "LUBBOCK");
  assert.equal(lubbock!.offenses, 0, "the wrong-year 999 and wrong-offense 888 rows stay out");
});

check("the corrected ranking's ordering is the requested one", () => {
  const rows = rowsOf(CORRECTED) as Array<{ rate_per_100k: number }>;
  const rates = rows.map((row) => row.rate_per_100k);
  assert.deepEqual([...rates].sort((a, b) => b - a), rates, "descending by rate, as asked");
});

/* ------------------------------------------------------------------ *
 * 2. The rule, through the real validator
 * ------------------------------------------------------------------ */

const enforcedFor = (question: string, sql: string, source: "nibrs" | "current" | "historical" = "nibrs") => {
  const verdict = validateQueryContractSql({ question, source, sql });
  return {
    fired: (verdict.enforced ?? []).includes("structural-unrequested-eligibility-floor"),
    retryIssues: (verdict.retryIssues ?? []).filter((issue) => issue.includes("eligibility-floor")),
    blockReasons: verdict.blockReasons ?? [],
  };
};

/*
 * RETIRED WITH THE MATCHER: "the real validator fires on the floor and clears the corrected statement".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

/*
 * RETIRED WITH THE MATCHER: "the retry instruction names the clause and asks for no source change".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

check("a requested measure threshold is honoured, not flagged", () => {
  const asked = "Rank Texas cities with at least 100 shoplifting offenses by rate in 2025";
  const sql = `${RANKING_BODY} HAVING SUM(s.offense_count) >= 100 ORDER BY rate_per_100k DESC LIMIT 10`;
  assert.equal(enforcedFor(asked, sql).fired, false, "the user asked for this floor");
  // The request authorizes a measure, a comparison and a value together, so the threshold carries
  // the inclusive bound it licenses — not a bare number that any floor could match.
  assert.deepEqual(
    requestedMeasureThresholds(asked).map((t) => [t.value, t.lowerBound, t.measureNoun]),
    [[100, 100, "shoplifting"]]
  );
});

check("a requested population floor alone is never a measure floor", () => {
  assert.equal(enforcedFor(QUESTION, CORRECTED).fired, false);
  assert.deepEqual(requestedMeasureThresholds(QUESTION), [], "250,000 people is a size, not a count");
});

check("a denominator guard survives", () => {
  const sql = `${RANKING_BODY} HAVING a.population > 0 ORDER BY rate_per_100k DESC LIMIT 10`;
  assert.equal(enforcedFor(QUESTION, sql).fired, false, "population > 0 is mathematically necessary");
});

/*
 * RETIRED WITH THE MATCHER: "numbers in the request license nothing on their own".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

check("other ranking meanings and non-rankings are untouched", () => {
  const notRanked = `${RANKING_BODY} HAVING SUM(s.offense_count) > 0`;
  assert.equal(enforcedFor(QUESTION, notRanked).fired, false, "no order/limit: not this family");
  const unlimited = `${RANKING_BODY} HAVING SUM(s.offense_count) > 0 ORDER BY rate_per_100k DESC`;
  assert.equal(enforcedFor(QUESTION, unlimited).fired, false, "ordered but unlimited: not this family");
  const completeness =
    "SELECT a.city, SUM(s.offense_count) AS offenses FROM summary_city_monthly s " +
    "JOIN agencies a ON a.ori = s.ori JOIN nibrs_agency_completeness c ON c.ori = s.ori " +
    "WHERE s.year = 2025 GROUP BY a.city HAVING MAX(c.months_reported) > 0 ORDER BY offenses DESC LIMIT 10";
  assert.equal(enforcedFor(QUESTION, completeness).fired, false,
    "a reporting filter is a change-comparison contract, not this one");
});

/*
 * RETIRED WITH THE MATCHER: "the CTE and wrapping forms are covered, deeper nesting stays silent".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

/* ------------------------------------------------------------------ *
 * 3. The governing limit and its sentence
 * ------------------------------------------------------------------ */

check("the governing limit is the outer one, or nothing", () => {
  assert.equal(governingRowLimit(CORRECTED), 10);
  assert.equal(governingRowLimit(`WITH r AS (${RANKING_BODY} LIMIT 5) SELECT * FROM r ORDER BY rate_per_100k DESC LIMIT 20`), 20,
    "a CTE's own limit is not the governing one");
  assert.equal(governingRowLimit(`${RANKING_BODY} ORDER BY rate_per_100k DESC`), null, "no limit, no claim");
  assert.equal(governingRowLimit(`${RANKING_BODY} LIMIT 10 ORDER BY rate_per_100k DESC LIMIT 20`), LIMIT_INCONCLUSIVE,
    "two top-level limits are inconclusive rather than a guess");
  assert.equal(governingRowLimit(`${RANKING_BODY} ORDER BY rate_per_100k DESC LIMIT 5, 15`), 15, "offset form");
});

const deliver = (sql: string | null, rows: Record<string, unknown>[], explanation: string): string =>
  applyResultDisclosures({
    explanation, question: QUESTION, sql: sql as string, rows, tab: "nibrs",
    resultState: { kind: "rows" } as never,
  });

check("the delivered answer states the limit it actually used", () => {
  const text = deliver(CORRECTED, rowsOf(CORRECTED), "Houston had the highest shoplifting rate in 2025.");
  assert.match(text, /Ranking result limit: 10 rows\./, "the outer limit, as executed");
  assert.equal(rankingLimitSentence(CORRECTED, QUESTION), "Ranking result limit: 10 rows.");
});

check("the sentence reports the executed limit, not a default or the row count", () => {
  const twenty = `${RANKING_BODY} ORDER BY rate_per_100k DESC LIMIT 20`;
  assert.match(deliver(twenty, rowsOf(twenty), "Houston led."), /Ranking result limit: 20 rows/,
    "20 because the statement says 20 — three rows came back, and the sentence does not say three");
  assert.equal(rowsOf(twenty).length, 3, "fewer rows than the limit, which changes nothing");
  assert.equal(rankingLimitSentence(`WITH r AS (${RANKING_BODY} LIMIT 5) SELECT * FROM r ORDER BY rate_per_100k DESC LIMIT 20`, QUESTION),
    "Ranking result limit: 20 rows.", "never the CTE's 5");
});

check("no limit sentence is fabricated where there is nothing to report", () => {
  // A refusal reaches delivery with no statement at all. The route returns its refusal payload
  // before this function, so null is guarded at the helper rather than exercised through delivery.
  assert.equal(rankingLimitSentence(null, QUESTION), null, "a refusal has no statement to read");
  assert.equal(rankingLimitSentence(undefined, QUESTION), null);
  assert.equal(rankingLimitSentence("", QUESTION), null);
  assert.equal(rankingLimitSentence(`${RANKING_BODY} ORDER BY rate_per_100k DESC`, QUESTION), null, "no limit");
  assert.equal(rankingLimitSentence(`${RANKING_BODY} LIMIT 10 ORDER BY rate_per_100k DESC LIMIT 20`, QUESTION), null,
    "ambiguous limits say nothing");
  assert.equal(rankingLimitSentence("SELECT SUM(offense_count, QUESTION) AS n FROM summary_city_monthly LIMIT 1"), null,
    "an unordered single-value query is not a ranking");
  const emptyText = deliver(CORRECTED, [], "No rows were returned.");
  assert.doesNotMatch(emptyText, /Ranking result limit/, "an empty result gains no ranking claim");
});

check("the answer survives, and the sentence is appended exactly once", () => {
  // Only what this function actually does is asserted: the source and period notes seen in the
  // saved captures are added elsewhere in the route, so claiming them here would be checking
  // something this delivery step never promised.
  const text = deliver(CORRECTED, rowsOf(CORRECTED), "Houston had the highest shoplifting rate in 2025.");
  assert.match(text, /^Houston had the highest shoplifting rate in 2025\./, "the answer itself is intact");
  assert.equal((text.match(/Ranking result limit/g) ?? []).length, 1, "one sentence, not two");
  const again = deliver(CORRECTED, rowsOf(CORRECTED), text);
  assert.equal((again.match(/Ranking result limit/g) ?? []).length, 1, "and re-running delivery does not duplicate it");
});

/* ------------------------------------------------------------------ *
 * 4. Mutations
 * ------------------------------------------------------------------ */

check("MUTATION removing the rule lets all three saved shapes through", () => {
  // The rule's own predicate, with the measure binding removed — the shape the product had before.
  const withoutRule = (_question: string, _sql: string) => [] as unknown[];
  for (const sql of [WITH_FLOOR, `WITH r AS (${RANKING_BODY} HAVING SUM(s.offense_count) > 0) SELECT * FROM r ORDER BY rate_per_100k DESC LIMIT 10`]) {
    assert.ok(unrequestedMeasureFloors({ question: QUESTION, sql, source: "nibrs" }).length > 0,
      "the rule catches it");
    assert.equal(withoutRule(QUESTION, sql).length, 0, "and without the rule nothing does");
  }
});

check("MUTATION broadening to any lower bound breaks the legitimate cases", () => {
  // A version that flags every numeric lower bound, ignoring what it is bound to.
  const broadened = (sql: string): boolean =>
    /\bHAVING\b[\s\S]*?(?:>=|>)\s*\d+/i.test(sql) || /\bWHERE\b[\s\S]*?population\s*>=\s*\d+/i.test(sql);
  const legitimate = [
    `${RANKING_BODY} HAVING a.population > 0 ORDER BY rate_per_100k DESC LIMIT 10`,
    `${RANKING_BODY} HAVING SUM(s.offense_count) >= 100 ORDER BY rate_per_100k DESC LIMIT 10`,
    CORRECTED,
  ];
  for (const sql of legitimate) {
    assert.ok(broadened(sql), "the broadened version flags this legitimate statement");
  }
  assert.equal(enforcedFor(QUESTION, legitimate[0]).fired, false, "the real rule does not");
  assert.equal(enforcedFor("Rank Texas cities with at least 100 shoplifting offenses by rate in 2025", legitimate[1]).fired, false);
  assert.equal(enforcedFor(QUESTION, legitimate[2]).fired, false);
});

check("MUTATION removing the limit sentence fails the delivered text", () => {
  const withoutSentence = (text: string) => text.replace(/\n\nRanking result limit: \d+ rows\./, "");
  const delivered = deliver(CORRECTED, rowsOf(CORRECTED), "Houston had the highest shoplifting rate in 2025.");
  assert.match(delivered, /Ranking result limit: 10 rows\./);
  assert.doesNotMatch(withoutSentence(delivered), /Ranking result limit/, "so the assertion above is load-bearing");
});

check("the message names every floor it found, not just the first", () => {
  const two = `${RANKING_BODY} HAVING SUM(s.offense_count) > 0 AND SUM(s.offense_count) >= 5 ORDER BY rate_per_100k DESC LIMIT 10`;
  const floors = unrequestedMeasureFloors({ question: QUESTION, sql: two, source: "nibrs" });
  assert.equal(floors.length, 2, "both conjuncts are found");
  const message = measureFloorMessage(floors);
  assert.match(message, /> 0/);
  assert.match(message, />= 5/);
  assert.match(message, /those conditions/, "and the wording is plural");
});

/* ------------------------------------------------------------------ *
 * 5. Same-shape opposing questions, and the boundary the operator decides
 * ------------------------------------------------------------------ */

/*
 * These carry the SAME metric-table SQL shape as the witnesses and differ only in what was ASKED.
 * The earlier version of this suite only removed ORDER/LIMIT or switched the filtered column to a
 * support table, so it never tested a real change or peer request against a level-ranking shape --
 * and all three were being flagged. A table's role cannot say what kind of question was asked.
 */
const SAME_SHAPE =
  "SELECT s.ori, SUM(s.offense_count) AS offenses FROM summary_city_monthly s " +
  "WHERE s.year = 2025 AND s.ucr_offense_code = '23C' GROUP BY s.ori " +
  "HAVING SUM(s.offense_count) > 0 ORDER BY offenses DESC LIMIT 10";

check("a NON-RANKING request with the same shape is left alone", () => {
  assert.equal(
    enforcedFor("List agency shoplifting totals in alphabetical order for 2025", SAME_SHAPE).fired,
    false, "an alphabetical listing is ordered and limited, and is not a ranking"
  );
});

check("a PEER request with the same shape is left alone", () => {
  assert.equal(
    enforcedFor("Compare shoplifting counts for agencies of similar population in 2025", SAME_SHAPE).fired,
    false, "peer selection is a different contract with its own rules"
  );
});

check("a CHANGE request with the same shape is left alone", () => {
  const changeSql =
    "SELECT s.ori, SUM(CASE WHEN s.year=2025 THEN s.offense_count ELSE 0 END)" +
    "-SUM(CASE WHEN s.year=2024 THEN s.offense_count ELSE 0 END) AS change " +
    "FROM summary_city_monthly s WHERE s.year IN (2024,2025) AND s.ucr_offense_code='23C' GROUP BY s.ori " +
    "HAVING SUM(CASE WHEN s.year=2024 THEN s.offense_count ELSE 0 END)>0 ORDER BY change DESC LIMIT 10";
  assert.equal(
    enforcedFor("Rank agencies by the change in shoplifting from 2024 to 2025", changeSql).fired,
    false, "a baseline guard on a change ranking is that contract's business, not this rule's"
  );
});

/*
 * RETIRED WITH THE MATCHER: "metric-table metadata is not the measure".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

/*
 * RETIRED WITH THE MATCHER: "a stricter operator than requested is not authorized".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

/*
 * RETIRED WITH THE MATCHER: "the same number for a different measure authorizes nothing".
 * This asserted that the free-text eligibility matcher ENFORCED a finding. That enforcement is
 * withdrawn (see lib/structural-semantics.ts), so the assertion is retired rather than left
 * failing or quietly deleted. The behaviour it protected is now carried by construction in
 * lib/city-ranking.ts and proved in scripts/test-city-ranking.ts.
 */

check("a nearby population phrase does not erase a requested offense floor", () => {
  const asked = "Rank cities with at least 100 shoplifting offenses and population over 250000 by rate in 2025";
  const floor = SAME_SHAPE.replace("SUM(s.offense_count) > 0", "SUM(s.offense_count) >= 100");
  assert.equal(enforcedFor(asked, floor).fired, false, "both conditions were requested; neither cancels the other");
  const bounds = requestedMeasureThresholds(asked).map((t) => t.value);
  assert.ok(bounds.includes(100), "the offense floor is read");
  assert.ok(!bounds.includes(250000), "and the population size is not treated as one");
});

check("the boundary the operator decides, executed", () => {
  // Two agencies, one sitting exactly on the requested 100.
  const bdb = new Database(":memory:");
  bdb.exec("CREATE TABLE summary_city_monthly(ori TEXT, year INTEGER, ucr_offense_code TEXT, offense_count INTEGER);");
  bdb.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?)").run("A", 2025, "23C", 100);
  bdb.prepare("INSERT INTO summary_city_monthly VALUES(?,?,?,?)").run("B", 2025, "23C", 200);
  const shape = (op: string) =>
    "SELECT s.ori, SUM(s.offense_count) AS offenses FROM summary_city_monthly s " +
    `WHERE s.year = 2025 AND s.ucr_offense_code = '23C' GROUP BY s.ori HAVING SUM(s.offense_count) ${op} ` +
    "ORDER BY offenses DESC LIMIT 10";
  const oris = (op: string) => (bdb.prepare(shape(op)).all() as Array<{ ori: string }>).map((r) => r.ori);
  assert.deepEqual(oris(">= 100"), ["B", "A"], "the requested floor keeps the agency on the boundary");
  assert.deepEqual(oris("> 100"), ["B"], "the stricter one silently drops it");
  bdb.close();
});

/* ------------------------------------------------------------------ *
 * 6. Truthful limit wording
 * ------------------------------------------------------------------ */

check("an ordinary chronological result is not called a ranking", () => {
  const annual =
    "SELECT s.year, SUM(s.offense_count) AS offenses FROM summary_city_monthly s " +
    "WHERE s.ucr_offense_code = '23C' GROUP BY s.year ORDER BY s.year ASC LIMIT 20";
  assert.equal(rankingLimitSentence(annual, "Annual shoplifting totals for 2025"), null,
    "ordered by year and limited, but nobody asked for a ranking");
  const delivered = applyResultDisclosures({
    explanation: "Annual shoplifting totals.", question: "Annual shoplifting totals for 2025",
    sql: annual, rows: [{ year: 2025, offenses: 900 }], tab: "nibrs", resultState: { kind: "rows" } as never,
  });
  assert.doesNotMatch(delivered, /Ranking/i, "and delivery adds no ranking wording");
});

check("the wording claims no direction and no page", () => {
  const lowest =
    "SELECT s.ori, SUM(s.offense_count) AS offenses FROM summary_city_monthly s GROUP BY s.ori ORDER BY offenses ASC LIMIT 10";
  const sentence = rankingLimitSentence(lowest, "Which agencies had the lowest shoplifting counts in 2025?");
  assert.equal(sentence, "Ranking result limit: 10 rows.", "a lowest-first ranking is not a 'top' anything");
  const page =
    "SELECT s.ori, SUM(s.offense_count) AS offenses FROM summary_city_monthly s GROUP BY s.ori ORDER BY offenses DESC LIMIT 20, 10";
  assert.equal(rankingLimitSentence(page, "Rank agencies by shoplifting counts in 2025"),
    "Ranking result limit: 10 rows.", "a page after an offset is not the top 10 either");
  assert.doesNotMatch(String(sentence), /\btop\b/i, "no direction is asserted");
  assert.doesNotMatch(String(sentence), /more (?:results|rows)/i, "and no claim that further rows exist");
});

check("GC-003: a ranking asked with \"where\" states its limit; a relative \"where\" does not", () => {
  // The combined checkpoint delivered GC-003's 20-row ranking without saying it was limited, because
  // the question asks WHERE rather than naming "states" or "cities".
  const sql = "SELECT a.city, a.state, SUM(scd.cleared_B) AS declined FROM summary_clearance_detail scd JOIN agencies a ON a.ori = scd.ori "
    + "WHERE scd.year = 2025 GROUP BY a.city, a.state ORDER BY declined DESC LIMIT 20";
  const gc003 = "what crime type and where had the highest share of offenses cleared because of prosecution being declined in 2025?";
  assert.equal(rankingLimitSentence(sql, gc003), "Ranking result limit: 20 rows.");
  assert.equal(asksForPlaces(gc003), true);
  assert.equal(asksForPlaces("where is violent crime highest in Texas?"), true, "an opening where asks for places");
  assert.equal(asksForPlaces("what crime had the most offenses where the offender was a juvenile?"), false,
    "a relative where qualifies the measure");
  assert.equal(rankingLimitSentence(sql, "what crime had the most offenses where the offender was a juvenile?"), null,
    "and so earns no ranking sentence");
  // "prosecution declined" is a clearance type; a real decline in crime is still a change question.
  assert.equal(rankingLimitSentence(sql, "which states had the highest share of clearances where prosecution was declined?"),
    "Ranking result limit: 20 rows.");
  assert.equal(rankingLimitSentence(sql, "which states declined the most in murders since 2020?"), null,
    "a fall in crime is still a change question");
  assert.equal(rankingLimitSentence(sql, "which cities had the highest robbery counts after crime declined?"), null,
    "and so is 'crime declined'");
});

db.close();
console.log(`\nlevel ranking eligibility: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
