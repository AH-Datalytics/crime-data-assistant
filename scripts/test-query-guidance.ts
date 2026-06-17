import assert from "node:assert/strict";
import {
  HOW_TO_ASK_EXAMPLES,
  applyGuidanceAction,
  getQueryGuidanceWarnings,
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
assertDoesNotWarn("fatal shootings in Kansas City, Missouri per month from 2020 to 2024", "kansas-city");
assertDoesNotWarn("fatal shootings in KCK per month from 2020 to 2024", "kansas-city");

assertWarns("shootings in Baltimore since 2020", "baltimore");
assertDoesNotWarn("shootings in Baltimore County, Maryland since 2020", "baltimore");

assertWarns("murders in St. Louis since 2020", "st-louis");
assertDoesNotWarn("murders in St. Louis County, Missouri since 2020", "st-louis");

assertWarns("gun violence in New York since 2022", "new-york");
assertDoesNotWarn("gun violence in New York State since 2022", "new-york");
assertDoesNotWarn("New York City vs Chicago officers per year since 1930", "new-york");

assertWarns("crime in Washington in 2023", "washington");
assertDoesNotWarn("crime in Washington, DC in 2023", "washington");
assertDoesNotWarn("crime in Washington State in 2023", "washington");

assertWarns("violent assaults in Portland in 2022", "portland");
assertDoesNotWarn("violent assaults in Portland, Oregon in 2022", "portland");

assertWarns("gun violence in Louisiana since 2020", "gun-violence");
assertDoesNotWarn("fatal firearm homicides in Louisiana since 2020", "gun-violence");

assertWarns("assaults in Texas in 2023", "assault-type");
assertDoesNotWarn("aggravated assault in Texas in 2023", "assault-type");

assertWarns("show consistent reporters in Ohio from 2019 to 2024", "consistent-reporters");
assertWarns("agencies that reported all 12 months in 2024", "consistent-reporters");

const kcWarning = getQueryGuidanceWarnings("fatal shootings in Kansas City per month")[0];
assert.equal(
  applyGuidanceAction("fatal shootings in Kansas City per month", kcWarning.actions![0]),
  "fatal shootings in Kansas City, Missouri per month"
);

console.log("query guidance tests passed");
