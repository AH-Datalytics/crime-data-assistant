import assert from "node:assert/strict";
import { geoCorrectionHint, applyGeoCorrection } from "../lib/geo-correction";

// Typo -> hint names the corrected place.
const nola = geoCorrectionHint("murders in new orlens 2020");
assert.ok(nola && /new orleans/i.test(nola), "hint names New Orleans for 'new orlens'");
assert.ok(nola && /new orlens/i.test(nola), "hint references the raw misspelling");

const sa = geoCorrectionHint("car theft in san antnio");
assert.ok(sa && /san antonio/i.test(sa), "hint names San Antonio");

// Correct spelling -> no hint (place appears literally).
assert.equal(geoCorrectionHint("murders in New Orleans 2020"), null, "no hint when correctly spelled");
assert.equal(geoCorrectionHint("murders in Chicago"), null);

// No place / analytical scope -> no hint.
assert.equal(geoCorrectionHint("large cities with the most murders"), null, "no hint for scope query");
assert.equal(geoCorrectionHint("homicide trends nationally"), null);

// applyGeoCorrection appends only when there's a hint.
assert.ok(applyGeoCorrection("murders in new orlens 2020").includes("New Orleans"));
assert.equal(applyGeoCorrection("murders in Chicago"), "murders in Chicago");

console.log("geo correction tests passed");
