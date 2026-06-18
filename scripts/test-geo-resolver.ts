import assert from "node:assert/strict";
import {
  geoClarificationText,
  getBlockingGeoClarification,
  getGeoResolutionIssues,
  hasBlockingGeoResolutionIssue,
} from "../lib/geo-resolver";

function issueIds(input: string) {
  return getGeoResolutionIssues(input).map((issue) => issue.id);
}

function assertIssue(input: string, id: string) {
  assert.ok(issueIds(input).includes(id), `${input} should resolve with ${id}`);
}

function assertNoIssue(input: string, id: string) {
  assert.ok(!issueIds(input).includes(id), `${input} should not resolve with ${id}`);
}

assertIssue("fatal shootings in Kansas City per month from 2020 to 2024", "kansas-city");
assertNoIssue("fatal shootings in KCMO per month from 2020 to 2024", "kansas-city");
assertNoIssue("fatal shootings in Kansas City, Kansas per month from 2020 to 2024", "kansas-city");

assertIssue("shootings in Baltimore since 2020", "baltimore");
assertNoIssue("shootings in Baltimore city since 2020", "baltimore");
assertNoIssue("shootings in Baltimore County, Maryland since 2020", "baltimore");

assertIssue("murders in St. Louis since 2020", "st-louis");
assertNoIssue("murders in St. Louis city since 2020", "st-louis");
assertNoIssue("murders in St. Louis County, Missouri since 2020", "st-louis");

assertIssue("gun violence in New York since 2022", "new-york");
assertNoIssue("gun violence in New York State since 2022", "new-york");
assertNoIssue("New York City vs Chicago officers per year since 1930", "new-york");
assertNoIssue("robberies in New York County, New York in 2024", "new-york");

assertIssue("crime in Washington in 2023", "washington");
assertNoIssue("crime in Washington, DC in 2023", "washington");
assertNoIssue("crime in Washington State in 2023", "washington");
assertNoIssue("crime in Washington County, Oregon in 2023", "washington");

assertIssue("violent assaults in Portland in 2022", "portland");
assertNoIssue("violent assaults in Portland, Oregon in 2022", "portland");

const issues = getGeoResolutionIssues("shootings in Kansas City and Baltimore");
assert.deepEqual(issues.map((issue) => issue.id), ["kansas-city", "baltimore"]);
assert.equal(hasBlockingGeoResolutionIssue("shootings in Kansas City and Baltimore"), true);
assert.equal(hasBlockingGeoResolutionIssue("shootings in Kansas City, Missouri"), false);

const clarification = getBlockingGeoClarification("shootings in Baltimore");
assert.equal(clarification?.issue.id, "baltimore");
assert.equal(
  clarification?.explanation,
  "Use Baltimore city or Baltimore County, Maryland so the result does not mix jurisdictions. Choose: Baltimore city or Baltimore County."
);

assert.equal(
  geoClarificationText(getGeoResolutionIssues("crime in Washington")[0]),
  "Say Washington, DC or Washington State when asking for geography-specific results. Choose: Washington, DC or Washington State."
);

console.log("geo resolver tests passed");
