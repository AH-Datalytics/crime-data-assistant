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
assertCandidates("LA murders per month", ["city:CA:los-angeles", "county:CA:los-angeles", "state:LA"]);
assertClarifies("LA murders per month");
assertCandidates("LA County murders per month", ["county:CA:los-angeles"]);
assertDoesNotClarify("LA County murders per month");
assertCandidates("Louisiana murders per month", ["state:LA"]);
assertDoesNotClarify("Louisiana murders per month");
assertCandidates("violent crime in Los Angeles CA", ["city:CA:los-angeles"]);
assertDoesNotClarify("violent crime in Los Angeles CA");
assertCandidates("violent crime in Los Angeles County, California", ["county:CA:los-angeles"]);
assertDoesNotClarify("violent crime in Los Angeles County, California");

assertCandidates("crime in Alameda since 2008", ["city:CA:alameda", "county:CA:alameda"]);
assertClarifies("crime in Alameda since 2008");
assertCandidates("crime in Alameda County since 2008", ["county:CA:alameda"]);
assertDoesNotClarify("crime in Alameda County since 2008");

assertCandidates("Robbery in Anchorage Alaska", ["city:AK:anchorage"]);
assertDoesNotClarify("Robbery in Anchorage Alaska");
assertCandidates("Robberies in Anchorage AK", ["city:AK:anchorage"]);
assertDoesNotClarify("Robberies in Anchorage AK");
assertCandidates("Robberies in Anchorage", ["city:AK:anchorage"]);
assertDoesNotClarify("Robberies in Anchorage");

assertCandidates("New Orleans robberies per month", ["city:LA:new-orleans"]);
assertDoesNotClarify("New Orleans robberies per month");

assertCandidates("Murder rate in Houston Texas since 2010", ["city:TX:houston"]);
assertDoesNotClarify("Murder rate in Houston Texas since 2010");
assertCandidates("Murder rate in Houston since 2010", ["city:TX:houston"]);
assertDoesNotClarify("Murder rate in Houston since 2010");
assertCandidates("How many vehicle burglaries per month in Boston in 2023?", ["city:MA:boston"]);
assertDoesNotClarify("How many vehicle burglaries per month in Boston in 2023?");
assertCandidates("Show me theft in Omaha rolling over 12 months", ["city:NE:omaha"]);
assertDoesNotClarify("Show me theft in Omaha rolling over 12 months");
assertCandidates("violent crime per capita over time in Charlotte", ["city:NC:charlotte"]);
assertDoesNotClarify("violent crime per capita over time in Charlotte");
assertCandidates("crime trend in Nashville", ["city:TN:nashville"]);
assertDoesNotClarify("crime trend in Nashville");
assertCandidates("crime trend in Las Vegas", ["city:NV:las-vegas"]);
assertDoesNotClarify("crime trend in Las Vegas");
assertCandidates("crime trend in Louisville", ["city:KY:louisville"]);
assertDoesNotClarify("crime trend in Louisville");

assertCandidates("drug offenses in Salem Oregon since 2000", ["city:OR:salem"]);
assertDoesNotClarify("drug offenses in Salem Oregon since 2000");
assertCandidates("drug offenses in Salem OR since 2000", ["city:OR:salem"]);
assertDoesNotClarify("drug offenses in Salem OR since 2000");
assertClarifies("drug offenses in Salem since 2000");

assertCandidates("crime in Springfield IL", ["city:IL:springfield"]);
assertDoesNotClarify("crime in Springfield IL");
assertClarifies("crime in Springfield");

assertCandidates("fatal shootings in Kansas City", ["city:KS:kansas-city", "city:MO:kansas-city"]);
assertClarifies("fatal shootings in Kansas City");
assertCandidates("fatal shootings in KC", ["city:KS:kansas-city", "city:MO:kansas-city"]);
assertClarifies("fatal shootings in KC");
assertCandidates("fatal shootings in KCMO", ["city:MO:kansas-city"]);
assertCandidates("fatal shootings in KCK", ["city:KS:kansas-city"]);

assertCandidates("gun violence in New York", ["city:NY:new-york-city", "state:NY"]);
assertClarifies("gun violence in New York");
assertCandidates("gun violence in NY", ["city:NY:new-york-city", "state:NY"]);
assertClarifies("gun violence in NY");
assertCandidates("gun violence in New York State", ["state:NY"]);
assertDoesNotClarify("gun violence in New York State");
assertCandidates("gun violence in NY State", ["state:NY"]);
assertDoesNotClarify("gun violence in NY State");
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

assertCandidates("murders in Baltimore", ["city:MD:baltimore", "county:MD:baltimore"]);
assertClarifies("murders in Baltimore");
assertCandidates("murders in batlimore", ["city:MD:baltimore", "county:MD:baltimore"]);
assertClarifies("murders in batlimore");
assertCandidates("murders in Baltimore city", ["city:MD:baltimore"]);
assertCandidates("murders in batlimore city", ["city:MD:baltimore"]);
assertCandidates("murders in Baltimore County, Maryland", ["county:MD:baltimore"]);

assertCandidates("murders in STL", ["city:MO:st-louis", "county:MO:st-louis"]);
assertClarifies("murders in STL");
assertCandidates("murders in STL city", ["city:MO:st-louis"]);
assertDoesNotClarify("murders in STL city");
assertCandidates("murders in STL County", ["county:MO:st-louis"]);
assertDoesNotClarify("murders in STL County");

const multi = resolveGeoPlaces("Compare Portland, Oregon with Portland, Maine");
assert.equal(multi.mentions.length, 2);
assert.deepEqual(ids(multi), ["city:OR:portland", "city:ME:portland"]);
assert.equal(multi.requiresClarification, false);

assert.equal(resolveGeoPlaces("show national murder trend").mentions.length, 0);
assert.equal(resolveGeoPlaces("Top 10 cities by murder rate in 2025").mentions.length, 0);
for (const input of ["Show carjacking trend by month/year", "Robbery in Houston 2020-2025", "National murder trend", "Top 10 cities by murder rate in 2025"]) {
  resolveGeoPlaces(input);
}

const mention = first("violent crime in El Paso");
assert.equal(mention.text, "El Paso");
assert.equal(mention.candidates.length, 3);
assert.ok(mention.reason.includes("3 possible places"));

// Task 21b: typo-tolerant fallback (fires only when exact resolution finds nothing).
{
  const nola = resolveGeoPlaces("murders in new orlens 2020").mentions[0];
  assert.ok(nola && /new orleans/i.test(nola.candidates[0].name), "new orlens -> New Orleans");
  assert.equal(nola.requiresClarification, false, "confident typo resolves without asking");
}
{
  const sa = resolveGeoPlaces("car theft in san antnio 2021").mentions[0];
  assert.ok(sa && /san antonio/i.test(sa.candidates[0].name), "san antnio -> San Antonio (longer confident span beats short sub-span)");
}
{
  // place-at-start extension.
  const nola2 = resolveGeoPlaces("new orlens crime rate").mentions[0];
  assert.ok(nola2 && /new orleans/i.test(nola2.candidates[0].name), "leading typo resolves");
}
{
  // no place -> no fuzzy false match.
  assert.equal(resolveGeoPlaces("homicide trends nationally").mentions.length, 0, "non-place query stays unresolved");
  assert.equal(resolveGeoPlaces("show me robbery data").mentions.length, 0, "command words are not fuzzy-matched");
  // A single leading adjective must not fuzzy-collide with a city ("large" -> "Largo").
  assert.equal(resolveGeoPlaces("large cities with the most murders 2023").mentions.length, 0, "large cities is a scope, not Largo");
  assert.equal(resolveGeoPlaces("biggest cities by violent crime").mentions.length, 0, "biggest cities is a scope, not a place");
}

console.log("geo place resolver tests passed");
