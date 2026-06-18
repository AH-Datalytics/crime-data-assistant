import assert from "node:assert/strict";
import { resolveGeoPlaces, type GeoPlaceResolution } from "../lib/geo-place-resolver";

function first(input: string) {
  const result = resolveGeoPlaces(input);
  assert.ok(result.mentions.length > 0, `${input} should produce at least one mention`);
  return result.mentions[0];
}

function ids(result: GeoPlaceResolution): string[] {
  return result.mentions.flatMap((mention) => mention.candidates.map((candidate) => candidate.id));
}

function assertCandidates(input: string, expectedIds: string[]) {
  const actual = ids(resolveGeoPlaces(input)).sort();
  assert.deepEqual(actual, expectedIds.sort(), input);
}

function assertClarifies(input: string) {
  assert.equal(resolveGeoPlaces(input).requiresClarification, true, `${input} should require clarification`);
}

function assertDoesNotClarify(input: string) {
  assert.equal(resolveGeoPlaces(input).requiresClarification, false, `${input} should not require clarification`);
}

assertCandidates("violent crime in Los Angeles", ["city:CA:los-angeles", "county:CA:los-angeles"]);
assertClarifies("violent crime in Los Angeles");
assertCandidates("violent crime in Los Angeles CA", ["city:CA:los-angeles"]);
assertDoesNotClarify("violent crime in Los Angeles CA");
assertCandidates("violent crime in Los Angeles County, California", ["county:CA:los-angeles"]);
assertDoesNotClarify("violent crime in Los Angeles County, California");

assertCandidates("crime in Alameda since 2008", ["city:CA:alameda", "county:CA:alameda"]);
assertClarifies("crime in Alameda since 2008");
assertCandidates("crime in Alameda County since 2008", ["county:CA:alameda"]);
assertDoesNotClarify("crime in Alameda County since 2008");

assertCandidates("fatal shootings in Kansas City", ["city:KS:kansas-city", "city:MO:kansas-city"]);
assertClarifies("fatal shootings in Kansas City");
assertCandidates("fatal shootings in KCMO", ["city:MO:kansas-city"]);
assertCandidates("fatal shootings in KCK", ["city:KS:kansas-city"]);

assertCandidates("gun violence in New York", ["city:NY:new-york-city", "state:NY"]);
assertClarifies("gun violence in New York");
assertCandidates("gun violence in New York State", ["state:NY"]);
assertDoesNotClarify("gun violence in New York State");
assertCandidates("gun violence in NYC", ["city:NY:new-york-city"]);

assertCandidates("crime in Washington", ["city:DC:washington", "state:WA"]);
assertClarifies("crime in Washington");
assertCandidates("crime in Washington DC", ["city:DC:washington"]);
assertCandidates("crime in Washington State", ["state:WA"]);

assertCandidates("crime in Linn County", [
  "county:IA:linn",
  "county:KS:linn",
  "county:MO:linn",
  "county:OR:linn",
]);
assertClarifies("crime in Linn County");
assertCandidates("crime in Linn County, Oregon", ["county:OR:linn"]);
assertDoesNotClarify("crime in Linn County, Oregon");

assertCandidates("murders in Baltimore", ["city:MD:baltimore-city", "county:MD:baltimore"]);
assertClarifies("murders in Baltimore");
assertCandidates("murders in Baltimore city", ["city:MD:baltimore-city"]);
assertCandidates("murders in Baltimore County, Maryland", ["county:MD:baltimore"]);

const multi = resolveGeoPlaces("Compare Portland, Oregon with Portland, Maine");
assert.equal(multi.mentions.length, 2);
assert.deepEqual(ids(multi), ["city:OR:portland", "city:ME:portland"]);
assert.equal(multi.requiresClarification, false);

assert.equal(resolveGeoPlaces("show national murder trend").mentions.length, 0);

const mention = first("violent crime in El Paso");
assert.equal(mention.text, "El Paso");
assert.equal(mention.candidates.length, 2);
assert.ok(mention.reason.includes("2 possible places"));

console.log("geo place resolver tests passed");
