/**
 * What the query route is allowed to say when a Current Trends request carried no value.
 *
 * These are checks on the route's source rather than its behaviour, because the branch
 * runs inside a streaming handler that needs the model, the databases and a request. The
 * properties they hold are structural: the explanation for an empty or entirely-blank
 * Current Trends result must come from the deterministic check, a statement about the
 * published data must only be made when that check established one, and the Historical
 * tab's own probes must be left alone.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const route = fs.readFileSync(path.join(process.cwd(), "app", "api", "query", "route.ts"), "utf8");

function section(startMarker: string, endMarker: string): string {
  const start = route.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} is missing`);
  const end = route.indexOf(endMarker, start);
  assert.ok(end > start, `${endMarker} is missing after ${startMarker}`);
  return route.slice(start, end);
}

let passed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const emptyBranch = section("// Step 4: Handle empty results", "// Step 4b");
const allNullBranch = section("// Step 4c: Detect columns that are ALL null", "// Check for partial null columns");

console.log("\nan empty Current Trends result is explained by the deterministic check");

check("a reported zero never enters this path", () => {
  // The whole branch is gated on there being no rows at all, so a row carrying an
  // explicit zero keeps its own meaning and is never handed to the empty-result check.
  assert.match(emptyBranch, /^\/\/ Step 4: Handle empty results\s*\n\s*if \(rows\.length === 0\) \{/);
});

check("the explanation comes from the deterministic check, for Current Trends only", () => {
  assert.match(emptyBranch, /isHistorical \? null : explainEmptyCurrentTrendsResult\(db, sql\)/);
  assert.match(emptyBranch, /emptyMsg = currentEmpty\.message/);
});

check("only an established reason is delivered as a statement about the data", () => {
  assert.match(emptyBranch, /const emptyIsSourceAbsence = isHistorical \|\| \(currentEmpty\?\.establishedFromData \?\? false\)/);
  // P2.2: the site now selects between two WHOLE outcome constants from the same predicate, so
  // the action and its reason cannot desynchronize. The distinction this check defends is
  // unchanged: an established source absence declines on the data, everything else declines on
  // capability and says the reason was not established.
  assert.match(emptyBranch,
    /emptyIsSourceAbsence \? OUTCOMES\.no_rows_in_source : OUTCOMES\.empty_reason_not_established/);
  assert.match(emptyBranch, /empty_result_unverified/);
});

check("the old one-size sentence and its gate are gone", () => {
  assert.doesNotMatch(emptyBranch, /can't tell whether there are no matching source records/);
  assert.doesNotMatch(emptyBranch, /currentAbsenceProven/);
  assert.doesNotMatch(emptyBranch, /classifyCurrentTrendsSqlAbsence/);
});

check("Current Trends no longer reaches the fuzzy-name wording", () => {
  // This sentence claimed something about Current Trends coverage that no check had
  // established, and the offense probe below it read the monthly table directly. Both
  // are gone; the Historical counterparts stay.
  assert.doesNotMatch(emptyBranch, /is not in our dataset of ~/);
  assert.doesNotMatch(emptyBranch, /SELECT DISTINCT offense FROM agency_monthly/);
});

check("Historical keeps its own probes and wording", () => {
  assert.match(emptyBranch, /findSimilarAgencies\(db, agencyName, isHistorical, requestedState\)/);
  assert.match(emptyBranch, /historical_agency_crime hac/);
  assert.match(emptyBranch, /is not in our dataset\. Try the \[NIBRS\]/);
  assert.match(emptyBranch, /is in our dataset, but no data was found for that specific query/);
});

console.log("\nan entirely blank Current Trends result is treated the same way");

check("blank values go through the same deterministic check", () => {
  assert.match(allNullBranch, /isHistorical \? null : explainEmptyCurrentTrendsResult\(db, sql\)/);
  assert.match(allNullBranch, /currentAllNull\.message/);
});

check("blank values no longer claim the published data is missing by default", () => {
  assert.match(allNullBranch, /const allNullIsSourceAbsence = isHistorical \|\| \(currentAllNull\?\.establishedFromData \?\? false\)/);
  assert.match(allNullBranch,
    /outcome: allNullIsSourceAbsence \? OUTCOMES\.all_values_null : OUTCOMES\.empty_reason_not_established/);
  assert.doesNotMatch(allNullBranch, /outcome: OUTCOMES\.all_values_null,/);
});

check("Historical keeps its broken-math wording", () => {
  assert.match(allNullBranch, /the math likely broke somewhere/);
});

console.log("\nnothing internal reaches the reader");

check("no internal vocabulary in either branch's wording", () => {
  for (const branch of [emptyBranch, allNullBranch]) {
    for (const [, sentence] of branch.matchAll(/emptyMsg\s*(?:=|\+=)\s*(?:`|")((?:[^`"\\]|\\.)*)/g)) {
      assert.doesNotMatch(
        sentence,
        /\b(?:source absence|readiness|receipt|capability|unverified|verified)\b/i,
        `internal vocabulary in: ${sentence}`,
      );
    }
  }
});

check("the unsafe comment the earlier round removed has not come back", () => {
  assert.doesNotMatch(emptyBranch, /findSimilarAgencies\(\).*establish deterministically what the source has/);
});

console.log(`\ncurrent trends empty-result egress: ${passed} passed`);
