/**
 * NIBRS SQL optimizer tests, made deterministic.
 *
 * WHAT WAS WRONG. Every call here used to omit `optimizeNibrsSql`'s second argument, so the result
 * depended on `routeNibrsRollupSql`'s default:
 *
 *     rollupAvailable = resolveNibrsRollupPath() !== null
 *
 * -- that is, on whether a rollup database happens to exist on the machine running the test. One
 * assertion, that a NATIONAL query is left unrewritten, holds only when NO rollup database is present.
 * It passed for years because the developer checkout has none. Point the harness at any rollup
 * database, including an empty fixture, and `summary_clearance_type` is correctly rewritten to
 * `rollup.national_summary_clearance_type` and the assertion fails.
 *
 * So the test was asserting the behaviour of an absence. In production a rollup database DOES exist,
 * which means the one case this file pinned hardest was the one case it never exercised.
 *
 * THE CORRECTION. Nothing about the optimizer changes. Every call now passes `rollupAvailable`
 * explicitly, and the national case -- the only one whose result differs -- is asserted BOTH ways:
 * unrouted when no rollup is available, routed to the national rollup table when one is.
 *
 * Every other case here contains an ori, agency, city or county term, which `routeNibrsRollupSql`
 * treats as agency-or-continuous scope and never routes. Those assertions must therefore hold under
 * BOTH values, and `bothWays` runs each of them twice to prove that rather than assume it. That is
 * what makes this file independent of what is on disk.
 *
 * DELIBERATELY NOT ASSERTED: what the DEFAULT does. An assertion on the default would be an assertion
 * about the filesystem, which is exactly the defect being removed here. Whether the default itself is
 * the right production behaviour is a separate question and not this file's to answer.
 */
import assert from "node:assert/strict";
import { optimizeNibrsSql } from "../lib/nibrs-sql-optimizer";
import { validateAndSanitize } from "../lib/sql-safety";

/**
 * Run one assertion under BOTH rollup states.
 *
 * Used for every case whose result must not depend on rollup availability. If a future optimizer
 * change makes one of them rollup-sensitive, this fails on the value that changed instead of passing
 * on whichever value the machine happened to supply.
 */
function bothWays(sql: string, assertion: (optimized: string, rollupAvailable: boolean) => void): void {
  for (const rollupAvailable of [false, true]) {
    assertion(optimizeNibrsSql(sql, rollupAvailable), rollupAvailable);
  }
}

const oriSql = "SELECT sct.year FROM summary_clearance_type sct " +
  "WHERE sct.ori IN (SELECT ori FROM agencies WHERE city = 'CHICAGO')";
bothWays(oriSql, (optimized, rollupAvailable) => {
  assert.match(optimized, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i,
    `ori-scoped hint missing with rollupAvailable=${rollupAvailable}`);
  assert.equal(validateAndSanitize(optimized).valid, true,
    `optimized SQL failed validation with rollupAvailable=${rollupAvailable}`);
});

const joinSql = "SELECT sct.year FROM summary_clearance_type sct " +
  "JOIN agencies a ON a.ori = sct.ori WHERE a.city = 'CHICAGO'";
bothWays(joinSql, (optimized, rollupAvailable) => {
  assert.match(optimized, /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i,
    `joined ori scope lost its hint with rollupAvailable=${rollupAvailable}`);
});

// THE CASE THAT DIFFERS, asserted in both directions rather than in whichever one the disk provides.
const nationalSql = "SELECT year FROM summary_clearance_type WHERE ucr_offense_code = '09A'";

// rollupAvailable = false: there is nothing to route to, so the query is returned untouched.
assert.equal(optimizeNibrsSql(nationalSql, false), nationalSql,
  "with no rollup database available a national query must be left exactly as written");

// rollupAvailable = true: a national query with no agency scope is routed to the national rollup.
const routedNational = optimizeNibrsSql(nationalSql, true);
assert.match(routedNational, /\brollup\.national_summary_clearance_type\b/i,
  "with a rollup database available a national query must be routed to the national rollup table");
assert.notEqual(routedNational, nationalSql,
  "routing must actually change the SQL when a rollup is available");
assert.equal(validateAndSanitize(routedNational).valid, true,
  "the routed national SQL must still pass validation");
// Routing is idempotent: `routeNibrsRollupSql` returns early on already-routed SQL.
assert.equal(optimizeNibrsSql(routedNational, true), routedNational,
  "re-optimizing already-routed SQL must be a no-op");

const unaliasedOriSql = "SELECT year FROM summary_clearance_type WHERE ori = 'ILCPD0000'";
bothWays(unaliasedOriSql, (optimized, rollupAvailable) => {
  assert.match(optimized, /summary_clearance_type INDEXED BY idx_sct_ori_year WHERE/i,
    `unaliased ori filter lost its hint with rollupAvailable=${rollupAvailable}`);
});

const citySql = "SELECT s.year FROM summary_city_monthly AS s " +
  "WHERE s.ori IN (SELECT ori FROM agencies WHERE city = 'OMAHA')";
bothWays(citySql, (optimized, rollupAvailable) => {
  assert.match(optimized, /summary_city_monthly AS s INDEXED BY idx_scm_ori_year/i,
    `city hint missing with rollupAvailable=${rollupAvailable}`);
  assert.equal(optimizeNibrsSql(optimized, rollupAvailable), optimized,
    `optimization is not idempotent with rollupAvailable=${rollupAvailable}`);
});

// The reporting-table substitution is REMOVED, so these two assertions are inverted from what they
// asserted before: the requested monthly count must survive, and the completeness table must not be
// introduced by the planner. See the docblock in lib/nibrs-sql-optimizer.ts — the swap changed a
// figure on a fixture where the two sources disagree, and it passed validation both ways.
// scripts/test-optimizer-calculation-preservation.ts holds the changed-figure witnesses.
const stateRateSql = "SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) " +
  "FROM agencies a JOIN (SELECT ori, COUNT(DISTINCT month) AS months_reported " +
  "FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt ON rpt.ori = a.ori " +
  "WHERE a.year = 2024 GROUP BY a.state";
// Integration (2026-09-30): the accepted Phase 3 candidate REMOVED the completeness-table rewrite from
// lib/nibrs-sql-optimizer.ts (it swapped the calculation after validation; see the comment there), and the merged
// optimizer is that version. So the candidate's expectations hold, asserted here in dev's both-ways form.
bothWays(stateRateSql, (optimized, rollupAvailable) => {
  assert.match(optimized, /COUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported/i,
    `the requested monthly count must run as written with rollupAvailable=${rollupAvailable}`);
  assert.doesNotMatch(optimized, /nibrs_agency_completeness/i,
    `no completeness-table substitution with rollupAvailable=${rollupAvailable}`);
});
// A producer that asks for the completeness table still gets it, untouched.
const completenessSql = "SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) " +
  "FROM agencies a JOIN (SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = 2024) rpt " +
  "ON rpt.ori = a.ori WHERE a.year = 2024 GROUP BY a.state";
bothWays(completenessSql, (optimized, rollupAvailable) => {
  assert.match(optimized, /FROM nibrs_agency_completeness WHERE year = 2024/i,
    `an explicitly requested completeness table is kept with rollupAvailable=${rollupAvailable}`);
});

// Production 7618: an offense-filtered state-ranking scan of summary_city_monthly
// (no ori scope of its own) must NOT be force-hinted onto idx_scm_ori_year just
// because a qualified `rpt.ori = a.ori` join appears elsewhere -- that pinned the
// wrong index and cost 16.6s. The idx_scm_ucr path is correct for ucr filters.
const rankingSql = "WITH sv AS (SELECT state, SUM(offense_count) AS c FROM summary_city_monthly " +
  "WHERE ucr_offense_code = '240' AND year = 2024 GROUP BY state) " +
  "SELECT a.state FROM agencies a JOIN (SELECT ori, COUNT(DISTINCT month) AS m " +
  "FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt ON rpt.ori = a.ori GROUP BY a.state";
bothWays(rankingSql, (optimized, rollupAvailable) => {
  assert.doesNotMatch(optimized,
    /summary_city_monthly INDEXED BY idx_scm_ori_year\s+WHERE\s+ucr_offense_code/i,
    `the mis-applied hint from production 7618 is back with rollupAvailable=${rollupAvailable}`);
});

// A genuine unqualified ori filter on the un-aliased table still gets the hint.
const singleAgency = "SELECT year, month, SUM(offense_count) FROM summary_city_monthly " +
  "WHERE ori = 'TX01234' AND ucr_offense_code = '240' AND year = 2024 GROUP BY year, month";
bothWays(singleAgency, (optimized, rollupAvailable) => {
  assert.match(optimized, /INDEXED BY idx_scm_ori_year/i,
    `single-agency hint missing with rollupAvailable=${rollupAvailable}`);
});

console.log("nibrs SQL optimizer tests passed (every case pinned under rollupAvailable false and true)");
