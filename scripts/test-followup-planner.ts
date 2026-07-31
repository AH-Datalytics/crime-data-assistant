import assert from "node:assert/strict";
import { planFollowup, planFollowupSafe } from "../lib/followup-planner";

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
  // "to 1988" is the preposition of "change to", not an end-year marker
  assert.equal(p.timeRange.startYear, 1988);
  assert.equal(p.timeRange.endYear, null);
}
{
  const p = planFollowup("Go back further to 1940.", hist("Compare murder rates in Minnesota to the national rate since 1985", sql, "historical"), "historical");
  assert.equal(p.kind, "query_bearing");
  assert.deepEqual(p.changeKinds, ["time_range"]);
  // "go back ... to 1940" moves the START of the range, never the end
  assert.equal(p.timeRange.startYear, 1940);
  assert.equal(p.timeRange.endYear, null);
}
{
  const p = planFollowup("Start the chart in 2000.", hist("Compare murder rates in Minnesota to the national rate since 1985", sql, "historical"), "historical");
  assert.equal(p.timeRange.startYear, 2000);
  assert.equal(p.timeRange.endYear, null);
}
{
  const p = planFollowup("what about this year?", hist("What is SFPD's rape clearance rate?", "SELECT year, rape_clearance_rate FROM historical_agency_clearance", "historical"), "historical");
  assert.equal(p.kind, "query_bearing");
  assert.ok(p.changeKinds.includes("time_range"));
  assert.match(p.reconstructedQuestion, /clearance rate/i);
  assert.match(p.reconstructedQuestion, /this year/i);
  assert.equal(p.source, "historical");
  assert.equal(p.sourceChanged, false);
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
  assert.ok(p.changeKinds.includes("geography"));
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
{
  const h = hist("firearm homicides in Houston since 2015", "SELECT year FROM incidents", "shr");
  const p = planFollowup("what about carjackings?", h, "shr");
  assert.equal(p.source, "nibrs");
  assert.equal(p.sourceChanged, true);
  assert.doesNotMatch(p.reconstructedQuestion, /firearm/i);
  assert.match(p.reconstructedQuestion, /carjackings/i);
}
{
  const h = hist("murders in Louisville from 1995 to 2010", "SELECT year FROM incidents", "shr");
  const p = planFollowup("extend it through 2015", h, "shr");
  assert.equal(p.timeRange.startYear, 1995);
  assert.equal(p.timeRange.endYear, 2015);
}
{
  const h = hist("robberies in Baltimore since 2018", "SELECT year FROM agency_monthly", "current");
  const p = planFollowup("how does that compare to Maryland statewide?", h, "current");
  assert.ok(p.changeKinds.includes("geography"));
  assert.match(p.reconstructedQuestion, /Baltimore/);
  assert.match(p.reconstructedQuestion, /Maryland/);
}
{
  const h = [{ role: "user", content: "show violent crime in Cook County, IL", source: "nibrs" }, { role: "assistant", content: "Countywide total (all law enforcement agencies mapped to Cook County, summed)", source: "nibrs" }];
  const p = planFollowup("Countywide total", h, "nibrs");
  assert.equal(p.transform?.name, "resolve_county_scope");
}
{
  const h = hist("violent crime at Ohio State University since 2018", "SELECT year FROM summary_victim_city_monthly", "nibrs");
  const p = planFollowup("Make it monthly", h, "nibrs");
  assert.equal(p.granularity, "monthly");
}
{
  const h = hist("murder rates in Minnesota", "SELECT year FROM historical_state_national", "historical");
  const p = planFollowup("show this as a line chart", h, "historical");
  assert.equal(p.chartOnly, true);
  assert.equal(p.standaloneEligible, false);
}

// MS01: cross-source fragment gets reconstructed context (history is
// Historical-tagged, current source is SHR, so normalization drops it all)
{
  const h = [
    { role: "user", content: "murders in Houston since 2010", source: "historical" },
    { role: "assistant", content: "Rates for Houston and Dallas.\n[SQL: SELECT year, ROUND(hac.murder * 100000.0 / hap.population, 1) AS rate FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE (ha.agency = 'Houston' OR ha.agency = 'Dallas') AND ha.state = 'tx' AND hac.year >= 2010]", source: "historical" },
  ];
  const p = planFollowup("now show firearm murders instead", h, "shr");
  assert.equal(p.kind, "query_bearing");
  assert.equal(p.transform?.name, "carry_cross_source_context");
  assert.match(p.reconstructedQuestion, /Houston/);
  assert.match(p.reconstructedQuestion, /Dallas/);
  assert.match(p.reconstructedQuestion, /2010/);
  assert.doesNotMatch(p.transform!.instruction, /\[SQL:/, "SQL text must never cross the source boundary");
}

// Crash isolation: pathological input must degrade to null, never throw
{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = planFollowupSafe(null as any, [{ role: "assistant", content: "SELECT 1 FROM t" }], "current");
  assert.equal(p, null);
}

console.log("followup-planner tests passed");
