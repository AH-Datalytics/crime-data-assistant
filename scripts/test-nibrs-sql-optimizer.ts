import assert from "node:assert/strict";
import { optimizeNibrsSql } from "../lib/nibrs-sql-optimizer";
import { validateAndSanitize } from "../lib/sql-safety";

const oriSql = "SELECT sct.year FROM summary_clearance_type sct " +
  "WHERE sct.ori IN (SELECT ori FROM agencies WHERE city = 'CHICAGO')";
assert.match(optimizeNibrsSql(oriSql), /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i);
assert.equal(validateAndSanitize(optimizeNibrsSql(oriSql)).valid, true);

const joinSql = "SELECT sct.year FROM summary_clearance_type sct " +
  "JOIN agencies a ON a.ori = sct.ori WHERE a.city = 'CHICAGO'";
assert.match(optimizeNibrsSql(joinSql), /summary_clearance_type sct INDEXED BY idx_sct_ori_year/i);

const nationalSql = "SELECT year FROM summary_clearance_type WHERE ucr_offense_code = '09A'";
assert.equal(optimizeNibrsSql(nationalSql), nationalSql);

const unaliasedOriSql = "SELECT year FROM summary_clearance_type WHERE ori = 'ILCPD0000'";
assert.match(optimizeNibrsSql(unaliasedOriSql), /summary_clearance_type INDEXED BY idx_sct_ori_year WHERE/i);

const citySql = "SELECT s.year FROM summary_city_monthly AS s " +
  "WHERE s.ori IN (SELECT ori FROM agencies WHERE city = 'OMAHA')";
const optimized = optimizeNibrsSql(citySql);
assert.match(optimized, /summary_city_monthly AS s INDEXED BY idx_scm_ori_year/i);
assert.equal(optimizeNibrsSql(optimized), optimized);

// The reporting-table substitution is REMOVED, so these two assertions are inverted from what they
// asserted before: the requested monthly count must survive, and the completeness table must not be
// introduced by the planner. See the docblock in lib/nibrs-sql-optimizer.ts — the swap changed a
// figure on a fixture where the two sources disagree, and it passed validation both ways.
// scripts/test-optimizer-calculation-preservation.ts holds the changed-figure witnesses.
const stateRateSql = "SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) " +
  "FROM agencies a JOIN (SELECT ori, COUNT(DISTINCT month) AS months_reported " +
  "FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt ON rpt.ori = a.ori " +
  "WHERE a.year = 2024 GROUP BY a.state";
assert.match(optimizeNibrsSql(stateRateSql), /COUNT\s*\(\s*DISTINCT\s+month\s*\)\s+AS\s+months_reported/i);
assert.doesNotMatch(optimizeNibrsSql(stateRateSql), /nibrs_agency_completeness/i);
// A producer that asks for the completeness table still gets it, untouched.
const completenessSql = "SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) " +
  "FROM agencies a JOIN (SELECT ori, months_reported FROM nibrs_agency_completeness WHERE year = 2024) rpt " +
  "ON rpt.ori = a.ori WHERE a.year = 2024 GROUP BY a.state";
assert.match(optimizeNibrsSql(completenessSql), /FROM nibrs_agency_completeness WHERE year = 2024/i);

// Production 7618: an offense-filtered state-ranking scan of summary_city_monthly
// (no ori scope of its own) must NOT be force-hinted onto idx_scm_ori_year just
// because a qualified `rpt.ori = a.ori` join appears elsewhere — that pinned the
// wrong index and cost 16.6s. The idx_scm_ucr path is correct for ucr filters.
const rankingSql = "WITH sv AS (SELECT state, SUM(offense_count) AS c FROM summary_city_monthly " +
  "WHERE ucr_offense_code = '240' AND year = 2024 GROUP BY state) " +
  "SELECT a.state FROM agencies a JOIN (SELECT ori, COUNT(DISTINCT month) AS m " +
  "FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt ON rpt.ori = a.ori GROUP BY a.state";
assert.doesNotMatch(optimizeNibrsSql(rankingSql), /summary_city_monthly INDEXED BY idx_scm_ori_year\s+WHERE\s+ucr_offense_code/i);
// A genuine unqualified ori filter on the un-aliased table still gets the hint.
const singleAgency = "SELECT year, month, SUM(offense_count) FROM summary_city_monthly " +
  "WHERE ori = 'TX01234' AND ucr_offense_code = '240' AND year = 2024 GROUP BY year, month";
assert.match(optimizeNibrsSql(singleAgency), /INDEXED BY idx_scm_ori_year/i);

console.log("nibrs SQL optimizer tests passed");
