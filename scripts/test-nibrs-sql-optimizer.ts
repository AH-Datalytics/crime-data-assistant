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

const stateRateSql = "SELECT a.state, SUM(a.population * rpt.months_reported / 12.0) " +
  "FROM agencies a JOIN (SELECT ori, COUNT(DISTINCT month) AS months_reported " +
  "FROM summary_city_monthly WHERE year = 2024 GROUP BY ori) rpt ON rpt.ori = a.ori " +
  "WHERE a.year = 2024 GROUP BY a.state";
assert.match(optimizeNibrsSql(stateRateSql), /FROM nibrs_agency_completeness WHERE year = 2024/i);
assert.doesNotMatch(optimizeNibrsSql(stateRateSql), /COUNT\s*\(\s*DISTINCT\s+month\s*\)/i);

console.log("nibrs SQL optimizer tests passed");
