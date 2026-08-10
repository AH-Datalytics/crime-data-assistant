// Tests for lib/nibrs-city-aliases.ts — the shared city-literal normalizer for
// NIBRS agency lookups. The agencies table stores mailing-city literals with
// inconsistent spellings (both 'ST LOUIS' and 'SAINT LOUIS' exist as real,
// different agencies), so a lookup must try every candidate.
// Run: npx tsx scripts/test-nibrs-city-aliases.ts
import assert from "node:assert/strict";
import { cityLookupCandidates, normalizeCityLiteral } from "../lib/nibrs-city-aliases";

assert.equal(normalizeCityLiteral("  St.  Louis "), "ST LOUIS");
assert.equal(normalizeCityLiteral("new york city"), "NEW YORK CITY");

// St/Saint expands both directions — the DB has agencies under each spelling
assert.deepEqual(cityLookupCandidates("St. Louis"), ["ST LOUIS", "SAINT LOUIS"]);
assert.deepEqual(cityLookupCandidates("Saint Louis"), ["SAINT LOUIS", "ST LOUIS"]);
assert.deepEqual(cityLookupCandidates("St Paul"), ["ST PAUL", "SAINT PAUL"]);

// Production 8375: NYPD was reported as "not in this source" because the
// agencies table stores the city as NEW YORK.
assert.deepEqual(cityLookupCandidates("New York City"), ["NEW YORK CITY", "NEW YORK"]);
assert.deepEqual(cityLookupCandidates("NYC"), ["NYC", "NEW YORK"]);

// Ordinary names produce exactly one candidate — no speculative expansion
assert.deepEqual(cityLookupCandidates("Chicago"), ["CHICAGO"]);
assert.deepEqual(cityLookupCandidates("Oklahoma City"), ["OKLAHOMA CITY"]);

// "Stockton" must not be mistaken for a St. prefix
assert.deepEqual(cityLookupCandidates("Stockton"), ["STOCKTON"]);

// Candidates are unique
assert.deepEqual(cityLookupCandidates("  saint   louis  "), ["SAINT LOUIS", "ST LOUIS"]);

console.log("nibrs city alias tests passed");
