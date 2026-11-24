/** Percent changes that land exactly on a half round away from zero for both signs (Jeff 2026-11-24, P294). Offline. */
import assert from "node:assert/strict";
import { roundHalfAway1 } from "../lib/round-half-away";
import { change } from "../lib/nibrs-shadow/current";

assert.equal(roundHalfAway1(-6.25), -6.3);
assert.equal(roundHalfAway1(6.25), 6.3);
assert.equal(roundHalfAway1(-62.5 / 10), -6.3);
assert.equal(roundHalfAway1(-6.24), -6.2);
assert.equal(roundHalfAway1(0), 0);
assert.equal(roundHalfAway1(-0.04), 0, "a tiny drop is 0, not -0");
assert.ok(!Object.is(roundHalfAway1(-0.04), -0));
// Counts that make exactly -6.25% and +6.25%.
assert.equal(change(1600, 1500), -6.3);
assert.equal(change(1600, 1700), 6.3);
console.log("round half away: ok");
