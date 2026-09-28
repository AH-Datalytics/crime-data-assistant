/**
 * GC-032 supported share: "what share of serious violent crimes in California are committed by youth
 * under 18?" The data answers it as a share of RECORDED OFFENDERS (summary_offender_demographics.
 * offender_count), and the model's retained statement computes it from two one-row CTEs.
 *
 *   1. the retained two-CTE form is judged by the existing share proof through a strict equivalence,
 *      as written and after the planner routes it to the state rollup;
 *   2. every wrong numerator / denominator / unit / scope / shape stays refused;
 *   3. the routed approved single-SELECT share is no longer refused (rollup measure + schema alias);
 *   4. the delivered text is an owned recorded-offender statement; a model's crime-share sentence is
 *      not kept (Codex G32-2);
 *   5. every part of that statement is read from the row or the filters, or left out;
 *   6. the division must be real: an integer division that truncates is refused (Codex G32-1).
 */
import "./offline-evidence-guard";
import { deniedDatabaseOpens, deniedNetworkCalls } from "./offline-evidence-guard";
import { validateQueryContractSql } from "../lib/query-contract-validator";
import { routeNibrsRollupSql } from "../lib/nibrs-rollup-router";
import { tableSemantics } from "../lib/table-semantics";
import { applyResultDisclosures } from "../lib/result-disclosure";

let checks = 0;
let failures = 0;
function check(cond: boolean, message: string) {
  checks += 1;
  if (cond) console.log(`  PASS  ${message}`);
  else { failures += 1; console.log(`  FAIL  ${message}`); }
}

const Q = "what share of serious violent crimes in California are committed by youth under 18?";
const RULE = "structural-measure-unit-unmodeled";
const refusedAsShare = (sql: string, question = Q) => validateQueryContractSql({ question, source: "nibrs", sql }).enforced.includes(RULE);
const clean = (sql: string) => validateQueryContractSql({ question: Q, source: "nibrs", sql }).enforced.length === 0;

const T = "summary_offender_demographics";
const CODES = "('09A','11A','11B','11C','120','13A')";
const SCOPE = `d.state = 'CA' AND d.ucr_offense_code IN ${CODES} AND d.year BETWEEN 2021 AND 2025`;
const RETAINED = "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";
const two = ({ youthAgg = "SUM(d.offender_count)", youthWhere = `${SCOPE} AND d.age_group = 'Under 18'`, totalAgg = "SUM(d.offender_count)",
  totalWhere = SCOPE, totalTable = T, youthTable = T, select = "SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count",
  from = "FROM youth_offenders y, total_offenders t", youthTail = "", totalTail = "" } = {}) =>
  `WITH youth_offenders AS (SELECT ${youthAgg} AS youth_count FROM ${youthTable} d WHERE ${youthWhere}${youthTail}), ` +
  `total_offenders AS (SELECT ${totalAgg} AS total_count FROM ${totalTable} d WHERE ${totalWhere}${totalTail}) ${select} ${from}`;
const YOUTH = "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END)";
const SINGLE = `SELECT ROUND(100.0 * ${YOUTH} / SUM(d.offender_count), 1) AS youth_share_pct FROM ${T} d WHERE ${SCOPE}`;

console.log("\n1 - the retained two-CTE share is judged by the existing share proof");
check(clean(RETAINED), "the retained GC-032 statement, as written");
check(clean(`${RETAINED} LIMIT 1000`), "with the LIMIT the route appends");
const routed = routeNibrsRollupSql(RETAINED, true);
check(routed.routed && /rollup\.state_summary_offender_demographics/.test(routed.sql) && clean(`${routed.sql} LIMIT 1000`), "after the planner routes both CTEs to the state rollup");
check(clean(two({ from: "FROM youth_offenders y CROSS JOIN total_offenders t" })), "CROSS JOIN form");
check(clean(two({ from: "FROM youth_offenders y JOIN total_offenders t ON 1 = 1" })), "JOIN ON 1 = 1 form");
check(clean(two({ select: "SELECT 100.0 * y.youth_count / t.total_count AS pct_under_18" })), "unrounded percentage");

console.log("\n2 - wrong answers stay refused");
const WRONG: Array<[string, string]> = [
  ["denominator drops the state filter", two({ totalWhere: `d.ucr_offense_code IN ${CODES} AND d.year BETWEEN 2021 AND 2025` })],
  ["denominator counts summary rows", two({ totalAgg: "COUNT(*)" })],
  ["numerator counts summary rows", two({ youthAgg: "COUNT(*)" })],
  ["numerator is a different age group than asked", two({ youthWhere: `${SCOPE} AND d.age_group = '18-24'` })],
  ["scale 200 doubles the percentage", two({ select: "SELECT ROUND(200.0 * y.youth_count / t.total_count, 1) AS youth_share_pct" })],
  ["numerator narrowed to one year", two({ youthWhere: `d.state = 'CA' AND d.ucr_offense_code IN ${CODES} AND d.year = 2025 AND d.age_group = 'Under 18'` })],
  ["inverted ratio", two({ select: "SELECT ROUND(100.0 * t.total_count / y.youth_count, 1) AS youth_share_pct" })],
  ["numerator over fewer offenses", two({ youthWhere: `d.state = 'CA' AND d.ucr_offense_code IN ('09A') AND d.year BETWEEN 2021 AND 2025 AND d.age_group = 'Under 18'` })],
  ["subset over subset", two({ totalWhere: `${SCOPE} AND d.age_group = 'Under 18'` })],
  ["two extra conjuncts on the numerator", two({ youthWhere: `${SCOPE} AND d.age_group = 'Under 18' AND d.race = 'White'` })],
  ["an OR in a CTE filter", two({ youthWhere: `${SCOPE} AND (d.age_group = 'Under 18' OR d.age_group = '18-24')` })],
  ["a GROUP BY makes a CTE many rows", two({ totalTail: " GROUP BY d.year" })],
  // Subset first, so both filters END with the same text and only the one-row guard can object.
  ["both CTEs grouped by year (many rows each, cross-joined)", two({ youthWhere: `d.age_group = 'Under 18' AND ${SCOPE}`, youthTail: " GROUP BY d.year", totalTail: " GROUP BY d.year" })],
  ["both CTEs with the same HAVING", two({ youthWhere: `d.age_group = 'Under 18' AND ${SCOPE}`, youthTail: " HAVING SUM(d.offender_count) > 0", totalTail: " HAVING SUM(d.offender_count) > 0" })],
  ["numerator from the state rollup, denominator from the base table", two({ youthTable: "state_summary_offender_demographics" })],
  ["denominator from another table", two({ totalTable: "summary_victim_demographics", totalAgg: "SUM(d.victim_count)" })],
  ["measures differ", two({ totalAgg: "SUM(d.offender_count * 2)" })],
  ["outer join condition other than 1 = 1", two({ from: "FROM youth_offenders y JOIN total_offenders t ON y.youth_count > t.total_count" })],
  ["outer WHERE", two({ from: "FROM youth_offenders y, total_offenders t WHERE t.total_count > 0" })],
  ["outer reads a column the CTE does not return", two({ select: "SELECT ROUND(100.0 * y.youth_count / t.other, 1) AS youth_share_pct" })],
];
for (const [name, sql] of WRONG) check(refusedAsShare(sql), `refused by the share rule: ${name}`);
// The earlier CTE-decomposition limit is unchanged: a share computed INSIDE a CTE and projected out.
check(refusedAsShare(`WITH s AS (SELECT ROUND(100.0 * ${YOUTH} / SUM(d.offender_count), 1) AS youth_share_pct FROM ${T} d WHERE ${SCOPE}) SELECT s.youth_share_pct FROM s`),
  "still refused: a share computed inside a CTE and projected out (not this repair)");
check(refusedAsShare("SELECT SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END) AS youth, SUM(d.offender_count) AS total FROM summary_offender_demographics d WHERE " + SCOPE),
  "still refused: counts side by side without a computed share");

console.log("\n3 - the routed approved single-SELECT share is judged, not refused");
check(clean(SINGLE), "control: as written");
const routedSingle = routeNibrsRollupSql(SINGLE, true);
check(routedSingle.routed && clean(`${routedSingle.sql} LIMIT 1000`), "after routing to rollup.state_summary_offender_demographics");
check(JSON.stringify(tableSemantics("nibrs", "state_summary_offender_demographics")?.recordedMeasures) === '["offender_count"]'
  && JSON.stringify(tableSemantics("nibrs", "national_summary_offender_demographics")?.recordedMeasures) === '["offender_count"]',
  "the planner's rollups carry the source's evidenced recorded measure");
check(tableSemantics("nibrs", "state_summary_victim_demographics")?.recordedMeasures === undefined, "a rollup of an undeclared source declares nothing");
check(!clean(`SELECT ROUND(100.0 * ${YOUTH} / COUNT(*), 1) AS youth_share_pct FROM rollup.state_summary_offender_demographics d WHERE ${SCOPE}`),
  "routed: offenders over summary rows is still refused");

console.log("\n4 - the delivered text is an owned recorded-offender statement (Codex G32-2)");
const ROW = { youth_share_pct: 8.4, youth_count: 1260, total_count: 15060 };
const deliver = (explanation: string, sql = RETAINED, question = Q, rows: Record<string, unknown>[] = [ROW]) =>
  applyResultDisclosures({ explanation, question, sql, rows, tab: "nibrs" });
const OWNED = "Of the offenders recorded in NIBRS reports for the requested offenses in California, 2021–2025, 8.4% (1,260 of 15,060) had a recorded age group of Under 18.";
const CRIME_CLAIM = /% of (?:all )?(?:reported )?serious violent crimes|crimes were committed by youth/i;
const conflicting = deliver("In California from 2021 to 2025, 8.4% of all reported serious violent crimes were committed by youth under 18.");
check(conflicting.startsWith(OWNED) && !CRIME_CLAIM.test(conflicting), `the conflicting crime-share sentence is replaced by the owned statement: ${conflicting.split("\n")[0]}`);
check(deliver("Youth under 18 accounted for 8.0% of serious violent crimes in California from 2021 to 2025.").startsWith(OWNED), "the three-word variant too");
check(deliver("Of recorded offenders, 8.4% were under 18.").startsWith(OWNED), "a correct model sentence is replaced by the same owned statement");
check(/offenders recorded in NIBRS reports \(including offenders recorded with an unknown age\), not of crimes or incidents/.test(conflicting), "the unit note follows, with unknown ages named as part of the total");
// The route's later offender-wording step (app/api/nibrs-query/route.ts, Step 4c) must not garble it.
const step4c = conflicting.replace(/\bshare of (?:crimes|offenses|incidents)\b/gi, "X").replace(/\bpercent(?:age)? of (?:crimes|offenses|incidents)\b/gi, "X")
  .replace(/\bproportion of (?:crimes|offenses|incidents)\b/gi, "X").replace(/\b(?:crimes|offenses) involving\b/gi, "X");
check(step4c === conflicting, "the route's later wording step leaves the owned text unchanged");
check(!/unknown age/.test(deliver("x is 8%.", RETAINED.replace(/d\.year BETWEEN 2021 AND 2025\)/g, "d.year BETWEEN 2021 AND 2025 AND d.age_group <> 'Unknown')"))),
  "unknown ages are not claimed when the statement filters them");
check((deliver(conflicting).match(/^Unit:/gm) ?? []).length === 1 && (deliver(conflicting).match(/^Of the offenders recorded/gm) ?? []).length === 1, "stated once, not repeated");
check(!/Unit:|Of the offenders recorded/.test(deliver("There were 1,200 youth offenders.", "SELECT SUM(d.offender_count) FROM summary_offender_demographics d", "how many youth offenders were there in California?")),
  "not applied to a count question");
check(!/Unit:|Of the offenders recorded/.test(deliver("It was 8%.", "SELECT 100.0 * SUM(v.x) / SUM(v.y) FROM summary_victim_demographics v")), "not applied to a share from another table");

console.log("\n5 - every part of the owned statement is read from the row or the filters, or left out");
const FRACTION = RETAINED.replace("ROUND(100.0 * y.youth_count / t.total_count, 1)", "ROUND(1.0 * y.youth_count / t.total_count, 3)");
check(deliver("x", FRACTION, Q, [{ youth_share_pct: 0.084, youth_count: 1260, total_count: 15060 }]).startsWith(OWNED), "a fraction is stated as the same percentage");
check(deliver("x", RETAINED, Q, [{ youth_share_pct: 8.4, youth_count: 999, total_count: 15060 }]).startsWith(OWNED.replace(" (1,260 of 15,060)", "")),
  "counts that do not reproduce the share are not quoted");
check(/requested offenses, 2021–2025, 8\.4%/.test(deliver("x", RETAINED.replace("d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year", "d.state = 'TX' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year"))),
  "two different states: the place is left out, not guessed");
check(/were in the requested group\./.test(deliver("x", RETAINED.replace("d.age_group = 'Under 18'", "d.age_group = 'Under 18' AND d.sex = 'F'"))), "two group filters: the group is not named");
check(/the share that had a recorded age group of Under 18 is shown in the results above\./.test(deliver("x", RETAINED, Q, [ROW, ROW])), "not one row: no figure is stated");

console.log("\n5b - an unavailable share is never a number; a real zero is (Codex G32 review)");
{
  const first = (rows: Record<string, unknown>[]) => deliver("The percentage cannot be calculated because there are no recorded offenders.", RETAINED, Q, rows).split("\n")[0];
  const SCOPE_TEXT = "Of the offenders recorded in NIBRS reports for the requested offenses in California, 2021–2025, ";
  const nullShare = first([{ youth_share_pct: null, youth_count: 0, total_count: 0 }]);
  check(nullShare === `${SCOPE_TEXT}the share that had a recorded age group of Under 18 is unavailable: the result contains no recorded offenders in this scope, so no percentage can be computed.`
    && !/\d%/.test(nullShare), `NULL with zero counts: unavailable, cause stated, no percentage: ${nullShare}`);
  const nullOnly = first([{ youth_share_pct: null }]);
  check(/is unavailable: the query returned no value for it, so no percentage is stated\.$/.test(nullOnly) && !/\d%/.test(nullOnly), "NULL with no counts returned: unavailable, no cause claimed");
  check(/is unavailable: the query returned no value for it/.test(first([{ youth_share_pct: null, youth_count: 3, total_count: null }])), "NULL beside non-zero counts: no zero-offender cause claimed");
  check(/is unavailable/.test(first([{ youth_share_pct: "8.4", youth_count: 1260, total_count: 15060 }])) , "a non-numeric value is not formatted as a share");
  check(/is unavailable/.test(first([{ youth_count: 1260, total_count: 15060 }])), "a missing share column is unavailable, not zero");
  check(first([{ youth_share_pct: 0, youth_count: 0, total_count: 15060 }]) === `${SCOPE_TEXT}0.0% (0 of 15,060) had a recorded age group of Under 18.`, "a genuine numeric zero is stated as 0.0% with its counts");
  check(first([ROW]) === OWNED, "the positive answer is unchanged");
}

console.log("\n6 - the division must be real (Codex G32-1)");
const INTEGER_CTE = RETAINED.replace("100.0 *", "100 *");
check(refusedAsShare(INTEGER_CTE), "refused: CTE share with an integer 100 (1260/15060 would give 8)");
check(refusedAsShare(RETAINED.replace("100.0 * y.youth_count / t.total_count", "y.youth_count / t.total_count")), "refused: CTE fraction with no real factor (would give 0)");
check(refusedAsShare(SINGLE.replace("ROUND(100.0 *", "ROUND(100 *")), "refused: single-SELECT share with an integer 100");
const routedInteger = routeNibrsRollupSql(SINGLE.replace("ROUND(100.0 *", "ROUND(100 *"), true);
check(routedInteger.routed && refusedAsShare(`${routedInteger.sql} LIMIT 1000`), "refused: the routed single-SELECT sibling with an integer 100");
check(refusedAsShare(`${routeNibrsRollupSql(INTEGER_CTE, true).sql} LIMIT 1000`), "refused: the routed CTE form with an integer 100");
check(refusedAsShare(SINGLE.replace(`ROUND(100.0 * ${YOUTH} / SUM(d.offender_count), 1)`, `ROUND(${YOUTH} / SUM(d.offender_count) * 100.0, 1)`)),
  "refused: the real factor applied after the integer division");
check(clean(FRACTION), "accepted: a fraction with 1.0 * before the division");
check(clean(RETAINED.replace(/SUM\(d\.offender_count\)/g, "TOTAL(d.offender_count)").replace("100.0 *", "100 *")), "accepted: TOTAL() operands, which are always real");
check(clean(SINGLE.replace("ROUND(100.0 *", "ROUND(100.00 *")), "accepted: any decimal literal factor");

console.log(`\n${checks - failures}/${checks} passed; offline guard: ${deniedDatabaseOpens().length} denied database opens, ${deniedNetworkCalls().length} network calls`);
if (failures > 0) process.exit(1);
