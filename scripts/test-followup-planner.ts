import assert from "node:assert/strict";
import { planFollowup } from "../lib/followup-planner";

function hist(userQ: string, assistantSql: string, source: string) {
  return [
    { role: "user", content: userQ, source },
    { role: "assistant", content: `Here you go.\n[SQL: ${assistantSql}]`, source },
  ];
}
const sql = "SELECT year, count FROM historical_state_national WHERE year >= 1985";
{
  const p = planFollowup("Can you change the start year to 1988?", hist("Compare murder rates in Minnesota to the national rate since 1985", sql, "historical"), "historical");
  assert.equal(p.kind, "query_bearing");
  assert.deepEqual(p.changeKinds, ["time_range"]);
  assert.equal(p.source, "historical");
  assert.match(p.reconstructedQuestion, /Minnesota/);
  assert.match(p.reconstructedQuestion, /1988/);
  assert.equal(p.standaloneEligible, false);
  assert.equal(p.deterministicEligible, false);
  assert.equal(p.transform?.name, "change_time_range");
}
{
  const p = planFollowup("make it a rolling 12-month window", hist("monthly murders in Houston since 2021", "SELECT year, month, count FROM agency_monthly WHERE agency = 'Houston'", "current"), "current");
  assert.equal(p.kind, "query_bearing");
  assert.ok(p.changeKinds.includes("granularity"));
  assert.equal(p.transform?.name, "change_granularity");
  assert.equal(p.deterministicEligible, false);
}
{
  const p = planFollowup("compare to Dallas", hist("firearm homicides in Houston since 2015", "SELECT year, count(*) FROM incidents", "shr"), "shr");
  assert.equal(p.transform?.name, "compare_geographies");
  assert.match(p.reconstructedQuestion, /Dallas/);
  assert.equal(p.source, "shr");
}
{
  const p = planFollowup("What years does the data cover?", hist("murders in Minnesota", sql, "historical"), "historical");
  assert.equal(p.kind, "not_followup");
  assert.equal(p.standaloneEligible, true);
}
{
  const p = planFollowup("what about carjackings?", hist("murders in Houston", sql, "historical"), "historical");
  assert.equal(p.transform?.name, "change_offense");
  assert.match(p.reconstructedQuestion, /carjackings/i);
}
console.log("followup-planner tests passed");
