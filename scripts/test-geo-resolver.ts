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

assertIssue("LA murders per month", "la");
assertNoIssue("Louisiana murders per month", "la");
assertNoIssue("Los Angeles murders per month", "la");
assertNoIssue("LA County murders per month", "la");

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
assert.equal(getGeoResolutionIssues("gun violence in New York since 2022")[0].title, "New York is ambiguous");
assert.equal(
  geoClarificationText(getGeoResolutionIssues("gun violence in New York since 2022")[0]),
  "Say New York City or New York State to avoid ambiguity. Choose: New York City or New York State."
);

assert.equal(getGeoResolutionIssues("LA murders per month")[0].title, "LA is ambiguous");
assert.equal(
  geoClarificationText(getGeoResolutionIssues("LA murders per month")[0]),
  "LA can mean Los Angeles city, Los Angeles County, or Louisiana. Choose: Los Angeles city or Los Angeles County or Louisiana."
);

assertIssue("crime in Washington in 2023", "washington");
assertNoIssue("crime in Washington, DC in 2023", "washington");
assertNoIssue("crime in Washington State in 2023", "washington");
assertNoIssue("crime in Washington County, Oregon in 2023", "washington");
assertIssue("crime in Washington County in 2023", "county-washington");
assertNoIssue("crime in Washington County, Oregon in 2023", "county-washington");

assertIssue("violent assaults in Portland in 2022", "portland");
assertNoIssue("violent assaults in Portland, Oregon in 2022", "portland");

assertIssue("crime in Alameda since 2008", "city-county-alameda");
assertNoIssue("crime in Alameda, California since 2008", "city-county-alameda");
assertNoIssue("crime in Alameda CA since 2008", "city-county-alameda");
assertNoIssue("crime in Alameda County since 2008", "city-county-alameda");

assertIssue("violent crime in Albany in 2024", "city-county-albany");
assertNoIssue("violent crime in Albany, New York in 2024", "city-county-albany");
assertNoIssue("violent crime in Albany NY in 2024", "city-county-albany");
assertNoIssue("violent crime in Albany County, New York in 2024", "city-county-albany");

assertIssue("burglary trend in Boise", "city-county-boise");
assertNoIssue("burglary trend in Boise, Idaho", "city-county-boise");
assertNoIssue("burglary trend in Boise County, Idaho", "city-county-boise");

assertIssue("crime in Fairfax", "city-county-fairfax");
assertNoIssue("crime in Fairfax, Virginia", "city-county-fairfax");
assertNoIssue("crime in Fairfax VA", "city-county-fairfax");
assertNoIssue("crime in Fairfax County, Virginia", "city-county-fairfax");

assertIssue("violent crime in Los Angeles", "city-county-los-angeles");
assertNoIssue("violent crime in Los Angeles, California", "city-county-los-angeles");
assertNoIssue("violent crime in Los Angeles CA", "city-county-los-angeles");
assertNoIssue("violent crime in Los Angeles County, California", "city-county-los-angeles");

assertIssue("murder trend in Sacramento", "city-county-sacramento");
assertNoIssue("murder trend in Sacramento, California", "city-county-sacramento");
assertNoIssue("murder trend in Sacramento County, California", "city-county-sacramento");

assertIssue("fatal shootings in San Diego", "city-county-san-diego");
assertNoIssue("fatal shootings in San Diego, California", "city-county-san-diego");
assertNoIssue("fatal shootings in San Diego County, California", "city-county-san-diego");

assertIssue("violent crime in El Paso", "city-county-el-paso");
assertNoIssue("violent crime in El Paso, Texas", "city-county-el-paso");
assertNoIssue("violent crime in El Paso TX", "city-county-el-paso");
assertNoIssue("violent crime in El Paso County, Texas", "city-county-el-paso");

assertIssue("fatal shootings in Cook County", "county-cook");
assertNoIssue("fatal shootings in Cook County, Illinois", "county-cook");
assertNoIssue("fatal shootings in Cook County IL", "county-cook");

assertIssue("violent crime in Orange County", "county-orange");
assertNoIssue("violent crime in Orange County, California", "county-orange");

assertIssue("crime in Linn County", "county-linn");
assertNoIssue("crime in Linn County, Oregon", "county-linn");

assertIssue("crime in Jefferson County", "county-jefferson");
assertNoIssue("crime in Jefferson County, Alabama", "county-jefferson");
assertNoIssue("crime in Jefferson Parish", "county-jefferson");

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

assert.equal(
  geoClarificationText(getGeoResolutionIssues("crime in Cook County")[0]),
  "Cook County exists in multiple states. Add the state so countywide results use the right geography. Choose: Cook County, Georgia or Cook County, Illinois or Cook County, Minnesota."
);

assert.equal(
  geoClarificationText(getGeoResolutionIssues("crime in Jefferson County")[0]),
  "Jefferson County exists in multiple states. Add the state so countywide results use the right geography."
);

console.log("geo resolver tests passed");
