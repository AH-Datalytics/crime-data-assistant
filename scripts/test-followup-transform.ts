import assert from "node:assert/strict";
import { detectFollowupTransform } from "../lib/followup-transform";
import type { PromptHistoryMessage } from "../lib/chat-history";

const historyWithSql: PromptHistoryMessage[] = [
  { role: "user", content: "show rolling 12 month murders in Kansas City" },
  {
    role: "assistant",
    content:
      "SELECT year, month, SUM(count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) AS murders FROM agency_monthly",
  },
];

const domesticViolenceRateHistory: PromptHistoryMessage[] = [
  { role: "user", content: "rates of domestic violence across jurisdictions in 2025" },
  {
    role: "assistant",
    content:
      "SELECT dv.state, dv.dv_incidents, ROUND(dv.dv_incidents * 100000.0 / pop.reporting_population, 1) AS rate_per_100k FROM summary_domestic_violence dv JOIN agencies a ON a.ori = dv.ori",
  },
];

{
  const transform = detectFollowupTransform("split it out by state", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "state");
  assert.match(transform.instruction, /Preserve the prior query's dataset/);
  assert.match(transform.instruction, /PARTITION BY state/);
}

{
  const transform = detectFollowupTransform("break this down by city", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "city");
}

{
  const transform = detectFollowupTransform("show results by agency", historyWithSql);
  assert(transform);
  assert.equal(transform.dimension, "agency");
}

{
  const transform = detectFollowupTransform("only include agencies that reported every year from 2018 through 2025", historyWithSql);
  assert(transform);
  assert.equal(transform.name, "add_continuous_reporting_filter");
  assert.match(transform.instruction, /nibrs_consistent_reporters/);
  assert.match(transform.instruction, /reported all 12 months in every chosen year/);
}

{
  const transform = detectFollowupTransform("adjust for incomplete coverage", historyWithSql);
  assert(transform);
  assert.equal(transform.name, "add_continuous_reporting_filter");
}

{
  const transform = detectFollowupTransform("Can you give me number instead of rate?", domesticViolenceRateHistory);
  assert(transform);
  assert.equal(transform.name, "replace_rate_with_count");
  assert.match(transform.contextQuestion || "", /raw counts, not rates/);
  assert.match(transform.instruction, /remove population joins/);
  assert.match(transform.instruction, /Do not refuse because the prior query asked for a rate/);
}

{
  const transform = detectFollowupTransform("sheriff's office only", [
    { role: "user", content: "show violent crime in Cook County, IL" },
    { role: "assistant", content: "For Cook County, do you want the countywide total (all law enforcement agencies mapped to Cook County, summed — totals depend on each agency's reporting participation) or the sheriff's office only (the single county agency record)? Choose: Countywide total or Sheriff's office only." },
  ]);
  assert(transform);
  assert.equal(transform.name, "resolve_county_scope");
  assert.match(transform.instruction, /NOT "Cook County Sheriff"/);
  assert.match(transform.instruction, /agency = 'Maricopa' AND type = 'County'/);
  assert.match(transform.instruction, /do not search agencies\.city = 'COOK COUNTY'/);
}

{
  const transform = detectFollowupTransform("please show just victim demographics.", domesticViolenceRateHistory);
  assert(transform);
  assert.equal(transform.name, "replace_with_dv_victim_demographics");
  assert.match(transform.instruction, /replaces the prior domestic-violence metric/);
  assert.match(transform.instruction, /Do NOT preserve any prior per-capita/);
  assert.match(transform.instruction, /victim_sequence/);
}

{
  const transform = detectFollowupTransform("split it out by state", [
    { role: "user", content: "show murder trends" },
    { role: "assistant", content: "Here is the chart." },
  ]);
  assert.equal(transform, null);
}

{
  const transform = detectFollowupTransform("crime by state", historyWithSql);
  assert.equal(transform, null);
}

console.log("follow-up transform tests passed");
