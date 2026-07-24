import assert from "node:assert/strict";
import { routeNibrsRollupSql } from "../lib/nibrs-rollup-router";

const juvenile = "SELECT year,race,SUM(arrestee_count) FROM summary_arrestee_demographics WHERE age_group='Under 18' GROUP BY year,race";
assert.match(routeNibrsRollupSql(juvenile, true).sql, /rollup\.national_summary_arrestee_demographics/);
assert.match(routeNibrsRollupSql("SELECT state,race,SUM(arrestee_count) FROM summary_arrestee_demographics GROUP BY state,race", true).sql, /rollup\.state_summary_arrestee_demographics/);
for (const sql of [
  "SELECT * FROM summary_arrestee_demographics WHERE ori='X'",
  "SELECT * FROM summary_arrestee_demographics JOIN agencies USING(ori)",
  "SELECT * FROM summary_victim_demographics WHERE ori IN (SELECT ori FROM nibrs_consistent_reporters)",
  "SELECT * FROM summary_victim_demographics JOIN summary_clearance_type USING(year)",
]) assert.equal(routeNibrsRollupSql(sql, true).routed, false, sql);
assert.equal(routeNibrsRollupSql(juvenile, false).routed, false);
console.log("nibrs rollup router tests passed");
