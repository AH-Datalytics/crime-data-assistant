import assert from "node:assert/strict";
import {
  HOW_TO_ASK_EXAMPLES,
  applyGuidanceAction,
  getQueryGuidanceWarnings,
  hasBlockingQueryGuidanceWarnings,
} from "../lib/query-guidance";

function warningIds(input: string) {
  return getQueryGuidanceWarnings(input).map((w) => w.id);
}

function assertWarns(input: string, id: string) {
  assert.ok(warningIds(input).includes(id), `${input} should warn for ${id}`);
}

function assertDoesNotWarn(input: string, id: string) {
  assert.ok(!warningIds(input).includes(id), `${input} should not warn for ${id}`);
}

assert.deepEqual(HOW_TO_ASK_EXAMPLES.map((e) => `${e.category}: ${e.question}`), [
  "Trends: murder trend from 2019 to 2025",
  "Rates: violent crime rate in Texas cities of 250k or more in 2023",
  "Places: fatal shootings in Kansas City, Missouri per month from 2020 to 2024",
  "Comparability: New York City vs Chicago officers per year since 1930",
  "Demographics: offender age breakdown for robberies since 2020",
]);

assertWarns("fatal shootings in Kansas City per month from 2020 to 2024", "kansas-city");
assert.equal(hasBlockingQueryGuidanceWarnings("fatal shootings in Kansas City per month from 2020 to 2024"), true);
assertDoesNotWarn("fatal shootings in Kansas City, Missouri per month from 2020 to 2024", "kansas-city");
assert.equal(hasBlockingQueryGuidanceWarnings("fatal shootings in Kansas City, Missouri per month from 2020 to 2024"), false);
assertDoesNotWarn("fatal shootings in KCK per month from 2020 to 2024", "kansas-city");

assert.deepEqual(warningIds("shootings in Kansas City"), ["kansas-city", "shooting-scope"]);
assert.equal(hasBlockingQueryGuidanceWarnings("shootings in Kansas City"), true);
assert.deepEqual(warningIds("fatal shootings in Kansas City, Missouri"), []);

assertWarns("shootings in Baltimore since 2020", "baltimore");
assertDoesNotWarn("shootings in Baltimore County, Maryland since 2020", "baltimore");

assertWarns("murders in St. Louis since 2020", "st-louis");
assertDoesNotWarn("murders in St. Louis County, Missouri since 2020", "st-louis");

assertWarns("gun violence in New York since 2022", "new-york");
assert.deepEqual(warningIds("gun violence in New York since 2022"), ["new-york", "gun-violence"]);
assert.equal(hasBlockingQueryGuidanceWarnings("gun violence in New York since 2022"), true);
assertDoesNotWarn("gun violence in New York State since 2022", "new-york");
assertDoesNotWarn("New York City vs Chicago officers per year since 1930", "new-york");

assertWarns("crime in Washington in 2023", "washington");
assertDoesNotWarn("crime in Washington, DC in 2023", "washington");
assertDoesNotWarn("crime in Washington State in 2023", "washington");
assertWarns("crime in Washington County in 2023", "county-washington");
assertDoesNotWarn("crime in Washington County, Oregon in 2023", "washington");
assertDoesNotWarn("crime in Washington County, Oregon in 2023", "county-washington");

assertWarns("crime in Cook County", "county-cook");
assert.equal(hasBlockingQueryGuidanceWarnings("crime in Cook County"), true);
assertDoesNotWarn("crime in Cook County, Illinois", "county-cook");

assertWarns("violent assaults in Portland in 2022", "portland");
assertDoesNotWarn("violent assaults in Portland, Oregon in 2022", "portland");

assertWarns("gun violence in Louisiana since 2020", "gun-violence");
assert.equal(hasBlockingQueryGuidanceWarnings("gun violence in Louisiana since 2020"), false);
assertDoesNotWarn("fatal firearm homicides in Louisiana since 2020", "gun-violence");
assert.equal(
  getQueryGuidanceWarnings("gun violence in Louisiana since 2020")[0].title,
  "The FBI does not systemically track all shootings"
);

assertWarns("shootings in Louisiana since 2020", "shooting-scope");
assertDoesNotWarn("fatal shootings in Louisiana since 2020", "shooting-scope");
const shootingWarning = getQueryGuidanceWarnings("shootings in Louisiana since 2020")[0];
assert.equal(shootingWarning.title, "The FBI does not systemically track all shootings");
assert.equal(shootingWarning.actions![0].label, "Use fatal shootings");

assertWarns("assaults in Texas in 2023", "assault-type");
assert.equal(hasBlockingQueryGuidanceWarnings("assaults in Texas in 2023"), false);
assertDoesNotWarn("aggravated assault in Texas in 2023", "assault-type");

assertWarns("show consistent reporters in Ohio from 2019 to 2024", "consistent-reporters");
assertWarns("agencies that reported all 12 months in 2024", "consistent-reporters");

const kcWarning = getQueryGuidanceWarnings("fatal shootings in Kansas City per month")[0];
assert.equal(
  applyGuidanceAction("fatal shootings in Kansas City per month", kcWarning.actions![0]),
  "fatal shootings in Kansas City, Missouri per month"
);

console.log("query guidance tests passed");
