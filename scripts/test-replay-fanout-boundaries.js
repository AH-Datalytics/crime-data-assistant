/**
 * The fan-out guardrail assertion in scripts/replay-production-queries.js must match TABLE NAMES,
 * not substrings of longer identifiers.
 *
 * WHY THIS EXISTS. That pattern was written through a shell, and its four `\b` word boundaries became
 * four raw 0x08 bytes. The regex compiled, read correctly in every editor, and had NO boundaries --
 * so `myagency_monthlyx` matched `agency_monthly`. It is the same defect class as a tripwire regex
 * that lost its boundaries and stayed vacuous through three review rounds, and it is invisible to
 * `grep`, so the only honest check is a behavioural one.
 *
 * The pattern is asserted as SHIPPED: it is extracted from the source file rather than retyped here,
 * because a copy in the test would pass happily while the shipped one stayed broken.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "replay-production-queries.js");

let passed = 0;
function check(name, body) {
  body();
  passed++;
  console.log(`  ok  ${name}`);
}

/** The shipped fan-out pattern, lifted from the source so the test cannot drift from it. */
function shippedPattern() {
  const src = fs.readFileSync(SOURCE, "utf8");
  const line = src.split("\n").find((l) => l.includes("agency_monthly") && l.includes("agency_population")
    && l.includes(".test(row.sql)"));
  assert.ok(line, "the fan-out pattern is no longer in replay-production-queries.js");
  const literal = line.slice(line.indexOf("/"), line.lastIndexOf("/i") + 2);
  const body = literal.slice(1, literal.lastIndexOf("/"));
  return new RegExp(body, "i");
}

check("the shipped source carries word boundaries, not control bytes", () => {
  const raw = fs.readFileSync(SOURCE);
  assert.equal(raw.indexOf(0x08), -1, "a raw 0x08 byte is back in the source");
  const text = raw.toString("utf8");
  const boundary = String.fromCharCode(92) + "b";
  const count = text.split(boundary + "agency_monthly").length - 1;
  assert.ok(count >= 1, "the pattern lost its leading word boundary");
});

check("the real fan-out idiom still matches", () => {
  const re = shippedPattern();
  const sql = "SELECT SUM(ap.population) FROM agency_monthly am JOIN agency_population ap ON ap.ori = am.ori";
  assert.ok(re.test(sql), "the guardrail stopped recognising the fan-out it exists to catch");
});

check("a longer identifier containing the table name does NOT match", () => {
  // THE DEFECT. Without boundaries this matched, and the guardrail would fire on unrelated SQL.
  const re = shippedPattern();
  const sql = "SELECT * FROM myagency_monthlyx m JOIN agency_populationz p ON p.ori = m.ori";
  assert.equal(re.test(sql), false, "a substring of a longer identifier matched the table name");
});

check("each boundary is load-bearing, tested one at a time", () => {
  // A single missing boundary is enough to reintroduce the bug, so each side is checked separately.
  const re = shippedPattern();
  assert.equal(re.test("FROM xagency_monthly JOIN agency_population p"), false,
    "a prefix before agency_monthly matched");
  assert.equal(re.test("FROM agency_monthlyx JOIN agency_population p"), false,
    "a suffix after agency_monthly matched");
  assert.equal(re.test("FROM agency_monthly m JOIN agency_populationx p"), false,
    "a suffix after agency_population matched");
});

check("the boundaries are what make the difference", () => {
  // MUTATION, in-test: strip the boundaries from the shipped pattern and show the bad input now
  // matches. If this ever stops holding, the assertions above are no longer proving anything.
  const shipped = shippedPattern();
  const withoutBoundaries = new RegExp(shipped.source.split(String.fromCharCode(92) + "b").join(""), "i");
  const bad = "SELECT * FROM myagency_monthlyx m JOIN agency_populationz p ON p.ori = m.ori";
  assert.equal(shipped.test(bad), false, "the shipped pattern is not rejecting the bad input");
  assert.equal(withoutBoundaries.test(bad), true,
    "removing the boundaries did not reintroduce the match, so this test proves nothing");
});

console.log(`replay fan-out boundary tests: ${passed} passed`);
