/**
 * Owner 2026-10-26 (presentation item 3): an embedded chart states, under it, the sample it covers and a partial last
 * year ("Sample of N agencies covering N population." and "2026 covers data from January to August."). The chart
 * metadata digest binds those facts only when present, so every earlier chart's digest is unchanged.
 *   npx tsx scripts/test-embed-notes.ts
 */
import assert from "node:assert/strict";
import { embedNotes } from "../lib/embed-notes";
import { chartMetaDigestOf } from "../lib/chart-config-log";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); } catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); }
}

const base = { source: "RTCI", agencyCount: 0, population: null };
check("the national sample and its partial last year", () => {
  assert.deepEqual(embedNotes({ ...base, sampleAgencies: 547, samplePopulation: 116958827, partialYear: { year: 2026, from: 1, to: 8 } }),
    ["Sample of 547 agencies covering 117.0 million population.", "2026 covers data from January to August."]);
});
check("no population on file: the sample alone", () => {
  assert.deepEqual(embedNotes({ ...base, sampleAgencies: 12, samplePopulation: null }), ["Sample of 12 agencies."]);
});
check("one month of the last year", () => {
  assert.deepEqual(embedNotes({ ...base, partialYear: { year: 2026, from: 1, to: 1 } }), ["2026 covers data from January only."]);
});
check("nothing to state: an agency chart, other sources, no metadata, a malformed partial year", () => {
  assert.deepEqual(embedNotes({ source: "RTCI", agencyCount: 1, population: 380000 }), []);
  assert.deepEqual(embedNotes({ source: "FBI SRS", agencyCount: 0, population: null }), []);
  assert.deepEqual(embedNotes(null), []);
  assert.deepEqual(embedNotes({ ...base, partialYear: { year: 2026, from: 9, to: 3 } }), []);
});
check("an earlier chart's metadata digest is unchanged; the new facts change it", () => {
  const before = chartMetaDigestOf(base);
  assert.equal(chartMetaDigestOf({ ...base }), before);
  assert.notEqual(chartMetaDigestOf({ ...base, sampleAgencies: 547, samplePopulation: 116958827 }), before);
  assert.notEqual(chartMetaDigestOf({ ...base, sampleAgencies: 547, samplePopulation: 1 }), chartMetaDigestOf({ ...base, sampleAgencies: 547, samplePopulation: 2 }));
  assert.notEqual(chartMetaDigestOf({ ...base, partialYear: { year: 2026, from: 1, to: 8 } }), chartMetaDigestOf({ ...base, partialYear: { year: 2026, from: 1, to: 7 } }));
});

console.log(`\nembed notes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
