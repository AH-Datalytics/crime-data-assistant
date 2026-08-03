import assert from "node:assert/strict";
import { editDistance, soundex, fuzzyResolvePlace, type FuzzyPlaceCandidate } from "../lib/geo-fuzzy";
import type { GeoPlaceCatalogEntry } from "../lib/geo-place-catalog";

// --- primitives ---
assert.equal(editDistance("new orlens", "new orleans"), 1);
assert.equal(editDistance("chcago", "chicago"), 1);
assert.equal(editDistance("abc", "abc"), 0);
assert.equal(editDistance("aaaa", "bbbb", 2), 3, "bounded distance returns max+1 when exceeded");
assert.equal(soundex("Orleans"), soundex("Orlens"), "typo shares the phonetic key");

// --- real catalog: confident single-place typos resolve ---
const nola = fuzzyResolvePlace("new orlens");
assert.ok(nola.best && /new orleans/i.test(nola.best.entry.name), "new orlens -> New Orleans");
assert.equal(nola.confident, true, "single clear match is confident");
assert.equal(nola.needsConfirmation, false);

const chicago = fuzzyResolvePlace("chcago");
assert.ok(chicago.best && /chicago/i.test(chicago.best.entry.name), "chcago -> Chicago");
assert.equal(chicago.confident, true);

// --- nonsense resolves to nothing ---
const nothing = fuzzyResolvePlace("xzqwvbrmp");
assert.equal(nothing.best, null);
assert.equal(nothing.candidates.length, 0);

// --- correctly-spelled input is not fuzzily re-pointed to a different city ---
const houston = fuzzyResolvePlace("houston");
assert.ok(!houston.best || houston.best.entry.name.toLowerCase() === "houston" || houston.needsConfirmation,
  "an exact name is not confidently rewritten to a different place");

// --- ambiguity: two distinct names equidistant -> ask, don't guess (synthetic catalog) ---
const mini: GeoPlaceCatalogEntry[] = [
  { id: "dayton", kind: "city", name: "Dayton", state: "OH", aliases: ["Dayton"], source: "generated-city" },
  { id: "layton", kind: "city", name: "Layton", state: "UT", aliases: ["Layton"], source: "generated-city" },
];
const ambiguous = fuzzyResolvePlace("aayton", mini);
assert.equal(ambiguous.needsConfirmation, true, "two equidistant distinct places require confirmation");
assert.equal(ambiguous.confident, false);
assert.ok(ambiguous.candidates.length >= 2);

// --- same name in multiple states is NOT a fuzzy ambiguity (state disambiguation owns that) ---
const springs: GeoPlaceCatalogEntry[] = [
  { id: "spr-mo", kind: "city", name: "Springfield", state: "MO", aliases: ["Springfield"], source: "generated-city" },
  { id: "spr-il", kind: "city", name: "Springfield", state: "IL", aliases: ["Springfield"], source: "generated-city" },
];
const springfield = fuzzyResolvePlace("sprngfield", springs);
assert.ok(springfield.best && springfield.best.entry.name === "Springfield");
assert.equal(springfield.needsConfirmation, false, "same canonical name across states is not a typo ambiguity");

console.log("geo fuzzy tests passed");
