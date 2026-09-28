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

// Ordinary words must not become an instruction to the model naming a town nobody asked for.
// Both of these produced a hint before the common-word guard: "all" -> Ball, LA and "the" -> Tye, TX.
// The full case list lives in scripts/test-phantom-place-guard.ts.
assert.equal(
  geoCorrectionHint("give me the share of all rape clearances that were prosecution declined in 2025"),
  null,
  "no phantom hint from the quantifier 'all' (was: 'all' appears to mean Ball, LA)"
);
assert.equal(
  geoCorrectionHint("Please show me a graph of the violent crime rate back to 1930 and also the U.S. prison population going back that far"),
  null,
  "no phantom hint from the article 'the' (was: 'the' appears to mean Tye, TX)"
);

// applyGeoCorrection appends only when there's a hint.
assert.ok(applyGeoCorrection("murders in new orlens 2020").includes("New Orleans"));
assert.equal(applyGeoCorrection("murders in Chicago"), "murders in Chicago");

console.log("geo correction tests passed");
