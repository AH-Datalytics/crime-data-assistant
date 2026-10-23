// Tests for lib/query-bearing-followup.ts — the shared predicate that keeps
// standalone-question shortcuts (metadata coverage, county clarifier,
// historical place lookup) from intercepting follow-ups that modify a prior
// successful query.
// Run: npx tsx scripts/test-query-bearing-followup.ts
import assert from "node:assert/strict";
import { detectQueryBearingFollowup } from "../lib/query-bearing-followup";

const priorSqlHistory = [
  { role: "user", content: "Murder rates in Minnesota vs the nation since 1985", source: "historical" },
  { role: "assistant", content: "Here are the rates.\n[SQL: SELECT year, murders FROM historical_state_national WHERE state='Minnesota']", source: "historical" },
];
const noSqlHistory = [
  { role: "user", content: "hi", source: "historical" },
  { role: "assistant", content: "Hello! Ask me about crime data.", source: "historical" },
];

function kinds(question: string, history: unknown): string[] | null {
  const r = detectQueryBearingFollowup(question, history);
  return r ? r.kinds : null;
}

// The six regressions, with prior SQL → fires with the right kind
assert.deepEqual(kinds("Can you change the start year to 1988?", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Go back further to 1940.", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Start the chart in 2000.", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("Make it monthly.", priorSqlHistory), ["granularity"]);
assert.deepEqual(kinds("Show the rate instead.", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("Compare it to Dallas.", priorSqlHistory), ["geography"]);

// Owner report 2026-10-23: a complete one-place question with its own offense and a "since"/"from ... to" range is not
// a follow-up (it was refused as "couldn't rebuild this follow-up"); a back-reference word still makes it one.
assert.equal(kinds("Denver vehicle burglaries per month since 2018", priorSqlHistory), null);
assert.equal(kinds("Houston carjackings per month since 2019", priorSqlHistory), null);
assert.equal(kinds("carjackings per year in Memphis from 2020 to 2025", priorSqlHistory), null);
assert.equal(kinds("murders in Dallas through 2020", priorSqlHistory), null);
assert.deepEqual(kinds("show robberies in Dallas instead", priorSqlHistory), ["offense"]);
assert.deepEqual(kinds("murders since 1995", priorSqlHistory), ["time_range"], "no place: still a follow-up");
assert.deepEqual(kinds("Dallas since 1995", priorSqlHistory), ["time_range"], "no offense: still a follow-up");
assert.deepEqual(kinds("extend that through 2020", priorSqlHistory), ["time_range"]);
// Codex r1: explicit changes stay follow-ups; a same-place question that drops an earlier restriction stays one.
const withPrev = (prev: string) => [{ role: "user", content: prev, source: "nibrs" }, { role: "assistant", content: "Figures.\n[SQL: SELECT year, month, SUM(offense_count) FROM summary_city_monthly WHERE ori='X']", source: "nibrs" }];
assert.notEqual(kinds("switch to robberies in Dallas", priorSqlHistory), null);
assert.notEqual(kinds("extend the date range for robberies in Dallas through 2020", priorSqlHistory), null);
assert.notEqual(kinds("use annual totals for robberies in Dallas", priorSqlHistory), null);
assert.notEqual(kinds("what about firearm murders in Dallas since 2010?", priorSqlHistory), null);
assert.deepEqual(kinds("robberies in Dallas since 2010", withPrev("armed robberies by month in Dallas")), ["time_range"], "drops 'armed' and 'by month'");
assert.equal(kinds("Houston carjackings per month since 2019", withPrev("Houston carjackings per month")), null, "the owner's sequence: nothing dropped");
assert.equal(kinds("Denver vehicle burglaries per month since 2018", withPrev("Houston carjackings per month since 2019")), null, "another place");
assert.deepEqual(kinds("Houston carjackings since 2019", withPrev("Houston carjackings per month")), ["time_range"], "drops 'per month' (month)");
assert.equal(kinds("Houston vehicle burglaries per month since 2018", withPrev("Houston carjackings per month since 2019")), null, "same place, its own offense: complete");
assert.deepEqual(kinds("Dallas burglaries since 2010", withPrev("armed robberies by month in Dallas")), ["time_range"], "its own offense but drops 'armed' and 'month'");

// More change phrasings
assert.deepEqual(kinds("extend it through 2020", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("show it from 1990 to 2010", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("what about since 1995?", priorSqlHistory), ["time_range"]);
assert.deepEqual(kinds("make it annual", priorSqlHistory), ["granularity"]);
assert.deepEqual(kinds("show counts instead of rates", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("now make it per capita", priorSqlHistory), ["metric"]);
assert.deepEqual(kinds("what about Dallas?", priorSqlHistory), ["geography"]);
assert.deepEqual(kinds("compare that with Houston", priorSqlHistory), ["geography"]);
assert.deepEqual(kinds("break it down by state", priorSqlHistory), ["breakdown"]);
assert.deepEqual(kinds("make it a line chart", priorSqlHistory), ["chart"]);
assert.deepEqual(kinds("show robberies instead", priorSqlHistory), ["offense"]);

// Multiple kinds accumulate (order: time_range, geography, offense, metric, granularity, breakdown, chart)
assert.deepEqual(kinds("make it monthly and start the chart in 2000", priorSqlHistory), ["time_range", "granularity"]);

// No prior SQL → never fires (standalone questions keep the fast path)
assert.equal(kinds("Can you change the start year to 1988?", noSqlHistory), null);
assert.equal(kinds("Can you change the start year to 1988?", []), null);
assert.equal(kinds("Can you change the start year to 1988?", undefined), null);
assert.equal(kinds("Compare it to Dallas.", noSqlHistory), null);

// Genuine metadata/coverage questions → never fires even WITH prior SQL
assert.equal(kinds("What years does the data cover?", priorSqlHistory), null);
assert.equal(kinds("How far back does the data go?", priorSqlHistory), null);
assert.equal(kinds("What's the earliest year available?", priorSqlHistory), null);
assert.equal(kinds("Which states are covered?", priorSqlHistory), null);
assert.equal(kinds("Which agencies are included in this result?", priorSqlHistory), null);
assert.equal(kinds("how many cities are in the data", priorSqlHistory), null);
assert.equal(kinds("can I download this as CSV?", priorSqlHistory), null);

// Fresh full questions that merely mention a year or place → no change-request verbs → null
assert.equal(kinds("murders in Chicago in 1988", priorSqlHistory), null);
assert.equal(kinds("robbery trend in Texas", priorSqlHistory), null);

// County-scope clarifier ANSWERS must not be swallowed (they have their own transform)
assert.equal(kinds("Countywide total", priorSqlHistory), null);
assert.equal(kinds("Sheriff's office only", priorSqlHistory), null);

// Malformed history entries are ignored safely
assert.equal(kinds("Make it monthly.", [{ role: "assistant" }, null, 42, "x"]), null);

// --- Production 8378: a complete question that opens with "compare" is standalone ---
// It named both places and the offense; the prior SQL was 8377, on another tab.
assert.equal(kinds("compare tulsa and oklahoma city homicides over time", priorSqlHistory), null);
assert.equal(kinds("Compare robbery in Chicago and Dallas, 2022 to 2024", priorSqlHistory), null);
assert.equal(kinds("Murder rates in Baltimore versus Detroit", priorSqlHistory), null);

// Contextual comparisons still fire — the anaphor is what makes them follow-ups
assert.deepEqual(kinds("Compare it to Dallas.", priorSqlHistory), ["geography"]);
assert.deepEqual(kinds("compare to Houston", priorSqlHistory), ["geography"]);

// A self-contained question is standalone even when it carries a change-request verb,
// because it names its own two places and its own offense
assert.equal(kinds("show murders in Tulsa and Oklahoma City by year instead", priorSqlHistory), null);

// ...but the same verb with only one place is still a follow-up
assert.deepEqual(kinds("show rates instead", priorSqlHistory), ["metric"]);

console.log("query-bearing-followup tests passed");
