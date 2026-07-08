import assert from "node:assert/strict";
import { getQueryGuidanceLogMeta, serializeQueryGuidanceLogMeta } from "../lib/query-guidance-log";

const blocked = getQueryGuidanceLogMeta("shootings in Kansas City");
assert.equal(blocked?.status, "blocked");
assert.deepEqual(blocked?.blockingIds, ["kansas-city", "shooting-scope"]);
assert.deepEqual(blocked?.advisoryIds, []);
assert.equal(blocked?.geo.requiresClarification, true);
assert.equal(blocked?.geo.mentions[0].text, "Kansas City");
assert.ok(blocked?.geo.mentions[0].candidateIds.includes("city:MO:kansas-city"));
assert.ok(blocked?.geo.mentions[0].candidateIds.includes("city:KS:kansas-city"));

const kcBlocked = getQueryGuidanceLogMeta("shootings in KC");
assert.equal(kcBlocked?.status, "blocked");
assert.deepEqual(kcBlocked?.blockingIds, ["kansas-city", "shooting-scope"]);
assert.equal(kcBlocked?.geo.mentions[0].text, "KC");

const shootingBlocked = getQueryGuidanceLogMeta("gun violence in Louisiana since 2020");
assert.equal(shootingBlocked?.status, "blocked");
assert.deepEqual(shootingBlocked?.warningIds, ["gun-violence"]);
assert.deepEqual(shootingBlocked?.blockingIds, ["gun-violence"]);
assert.equal(shootingBlocked?.geo.mentions.length, 1);
assert.deepEqual(shootingBlocked?.geo.mentions[0].candidateIds, ["state:LA"]);

const genericCrime = getQueryGuidanceLogMeta("crime in Dallas since 2020");
assert.equal(genericCrime?.status, "advisory");
assert.deepEqual(genericCrime?.warningIds, ["generic-crime-type"]);
assert.deepEqual(genericCrime?.advisoryIds, ["generic-crime-type"]);

const demographicRate = getQueryGuidanceLogMeta("homicide rates for gender and race");
assert.equal(demographicRate?.status, "advisory");
assert.deepEqual(demographicRate?.warningIds, ["demographic-rate-denominator"]);
assert.deepEqual(demographicRate?.advisoryIds, ["demographic-rate-denominator"]);

const ambiguousTheft = getQueryGuidanceLogMeta("thefts in Dallas since 2020");
assert.equal(ambiguousTheft?.status, "advisory");
assert.deepEqual(ambiguousTheft?.warningIds, ["theft-type"]);
assert.deepEqual(ambiguousTheft?.advisoryIds, ["theft-type"]);

const laBlocked = getQueryGuidanceLogMeta("LA murders per month");
assert.equal(laBlocked?.status, "blocked");
assert.deepEqual(laBlocked?.blockingIds, ["la"]);
assert.equal(laBlocked?.geo.requiresClarification, true);
assert.equal(laBlocked?.geo.mentions[0].text, "LA");
assert.ok(laBlocked?.geo.mentions[0].candidateIds.includes("city:CA:los-angeles"));
assert.ok(laBlocked?.geo.mentions[0].candidateIds.includes("county:CA:los-angeles"));
assert.ok(laBlocked?.geo.mentions[0].candidateIds.includes("state:LA"));

const nyBlocked = getQueryGuidanceLogMeta("gun violence in NY since 2022");
assert.equal(nyBlocked?.status, "blocked");
assert.deepEqual(nyBlocked?.blockingIds, ["new-york", "gun-violence"]);
assert.equal(nyBlocked?.geo.mentions[0].text, "NY");
assert.ok(nyBlocked?.geo.mentions[0].candidateIds.includes("city:NY:new-york-city"));
assert.ok(nyBlocked?.geo.mentions[0].candidateIds.includes("state:NY"));

const stlBlocked = getQueryGuidanceLogMeta("murders in STL");
assert.equal(stlBlocked?.status, "blocked");
assert.deepEqual(stlBlocked?.blockingIds, ["st-louis"]);
assert.equal(stlBlocked?.geo.mentions[0].text, "STL");

const typoBlocked = getQueryGuidanceLogMeta("batlimore murders per month");
assert.equal(typoBlocked?.status, "blocked");
assert.deepEqual(typoBlocked?.blockingIds, ["baltimore"]);
assert.equal(typoBlocked?.geo.mentions[0].text.toLowerCase(), "batlimore");

const resolved = getQueryGuidanceLogMeta("fatal shootings in Kansas City, Missouri");
assert.equal(resolved?.status, "resolved_geo");
assert.deepEqual(resolved?.warningIds, []);
assert.equal(resolved?.geo.requiresClarification, false);
assert.deepEqual(resolved?.geo.mentions[0].candidateIds, ["city:MO:kansas-city"]);

assert.equal(getQueryGuidanceLogMeta("murder trend from 2019 to 2025"), null);

const serialized = serializeQueryGuidanceLogMeta("crime in Cook County");
assert.ok(serialized);
assert.equal(JSON.parse(serialized!).status, "blocked");
assert.equal(JSON.parse(serialized!).blockingIds[0], "county-cook");

console.log("query guidance log tests passed");
