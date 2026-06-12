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
