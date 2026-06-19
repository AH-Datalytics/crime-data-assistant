import assert from "node:assert/strict";
import { getQueryGuidanceLogMeta, serializeQueryGuidanceLogMeta } from "../lib/query-guidance-log";

const blocked = getQueryGuidanceLogMeta("shootings in Kansas City");
assert.equal(blocked?.status, "blocked");
assert.deepEqual(blocked?.blockingIds, ["kansas-city"]);
assert.deepEqual(blocked?.advisoryIds, ["shooting-scope"]);
assert.equal(blocked?.geo.requiresClarification, true);
assert.equal(blocked?.geo.mentions[0].text, "Kansas City");
assert.ok(blocked?.geo.mentions[0].candidateIds.includes("city:MO:kansas-city"));
assert.ok(blocked?.geo.mentions[0].candidateIds.includes("city:KS:kansas-city"));

const advisory = getQueryGuidanceLogMeta("gun violence in Louisiana since 2020");
assert.equal(advisory?.status, "advisory");
assert.deepEqual(advisory?.warningIds, ["gun-violence"]);
assert.equal(advisory?.geo.mentions.length, 1);
assert.deepEqual(advisory?.geo.mentions[0].candidateIds, ["state:LA"]);

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
