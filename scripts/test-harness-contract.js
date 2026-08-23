/**
 * The harness runner's contract, asserted rather than described.
 *
 * Every claim here is one the accounting would otherwise make in prose only, and prose is what let
 * "the suite is green" and "the suite stopped at command 15" look identical for as long as they did:
 *
 *   - the four states sum to the DERIVED atomic count, and a tally summing to the top-level entry
 *     count is REJECTED rather than reported;
 *   - `blocked` is never reported as `skipped`, so a dependency failure cannot pose as a Tier C
 *     omission;
 *   - the two verdicts stay separate, and Tier C skips can never produce a bare "passed";
 *   - an insufficient fixture FAILS in preflight, before the test's assertions run -- including the
 *     all-NULL case that would otherwise pass vacuously;
 *   - a zero-byte database counts as ABSENT, not as a corpus;
 *   - the manifest itself is validated, because a declaration nobody checks is not a declaration.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const runner = require("./run-harness.js");
const manifestModule = require("./lib/tier-manifest.js");
const { buildFixtures, DATABASE_NAMES } = require("./lib/fixture-db.js");
const { planHarness, ENTRY_POINTS } = require("./lib/harness-plan.js");

const { PASSED, FAILED, SKIPPED, BLOCKED } = runner;

let passed = 0;
const failures = [];

function check(name, body) {
  try {
    body();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
    return;
  }
  passed++;
  console.log(`  ok    ${name}`);
}

/** Capture stdout so a reporting assertion can inspect what the operator would actually see. */
function capture(fn) {
  const written = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  const original_log = console.log;
  console.log = (...args) => { written.push(args.join(" ") + "\n"); };
  try {
    const value = fn();
    return { value, output: written.join("") };
  } finally {
    process.stdout.write = original;
    console.log = original_log;
  }
}

const validEntry = {
  id: "example",
  tier: "F",
  script: "scripts/run-harness.js",
  databases: ["rtci"],
  seed_profile: "empty",
  requires: [],
};

function entryWith(overrides) {
  return { ...validEntry, ...overrides };
}

function expectProblem(entries, fragment) {
  const problems = manifestModule.validateManifest({ entries });
  const hit = problems.some((p) => p.includes(fragment));
  assert.ok(hit, `expected a problem mentioning ${JSON.stringify(fragment)}, got: ` +
    JSON.stringify(problems));
}

// ------------------------------------------------------------------ manifest validation

check("a well-formed manifest validates", () => {
  assert.deepEqual(manifestModule.validateManifest({ entries: [validEntry] }), []);
});

check("an entry without a stable id is rejected", () => {
  expectProblem([entryWith({ id: undefined })], "stable string id");
});

check("two entries claiming the same script are rejected", () => {
  expectProblem([validEntry, entryWith({ id: "other" })], "a second entry claims");
});

check("an unknown tier is rejected", () => {
  expectProblem([entryWith({ tier: "X" })], "tier must be one of");
});

check("an unknown database name is rejected", () => {
  expectProblem([entryWith({ databases: ["nibrs", "nope"] })], "unknown database");
});

check("a requires clause on an undeclared database is rejected", () => {
  expectProblem(
    [entryWith({ databases: ["rtci"], requires: [{ database: "shr", table: "t", min_rows: 1 }] })],
    "does not declare it in databases");
});

check("a requires clause that demands nothing is rejected", () => {
  // The whole point of `requires` is a non-vacuous floor. A clause with neither a row floor nor a
  // non-null demand would be satisfied by a schema-only fixture and would prove nothing.
  expectProblem(
    [entryWith({ requires: [{ database: "rtci", table: "historical_agency_population" }] })],
    "asserts nothing");
  expectProblem(
    [entryWith({ requires: [{ database: "rtci", table: "historical_agency_population", min_rows: 0 }] })],
    "asserts nothing");
});

check("tier C without a corpus declaration is rejected", () => {
  expectProblem([entryWith({ tier: "C" })], "tier C requires a corpus declaration");
});

check("tier C with an empty detect list is rejected", () => {
  expectProblem(
    [entryWith({ tier: "C", corpus: { description: "d", detect: [] } })],
    "non-empty detect list");
});

check("tier F may not declare a corpus", () => {
  expectProblem(
    [entryWith({ corpus: { description: "d", detect: ["data/x.db"] } })],
    "only tier C may declare a corpus");
});

check("an entry naming a script that does not exist is rejected", () => {
  expectProblem([entryWith({ script: "scripts/not-a-real-file.ts" })], "does not exist");
});

// ------------------------------------------------------------------ reconciliation

check("reconcile reports undeclared commands and stale entries in both directions", () => {
  const commands = [
    { command: "tsx scripts/run-harness.js", script: "scripts/run-harness.js", via: "test" },
    { command: "tsx scripts/test-harness-contract.js", script: "scripts/test-harness-contract.js", via: "test" },
  ];
  const manifest = { entries: [validEntry, entryWith({ id: "ghost", script: "scripts/lib/fixture-db.js" })] };
  const { matched, undeclared, stale } = manifestModule.reconcile(manifest, commands);
  assert.equal(matched.length, 1);
  assert.deepEqual(undeclared.map((c) => c.script), ["scripts/test-harness-contract.js"]);
  assert.deepEqual(stale, ["ghost"]);
});

// ------------------------------------------------------------------ corpus availability

check("an absent corpus is unavailable, with the reason naming what was looked for", () => {
  const result = manifestModule.corpusAvailability({
    corpus: { description: "canonical RTCI", detect: ["data/definitely-absent.db"] },
  });
  assert.equal(result.available, false);
  assert.match(result.reason, /no canonical corpus present/);
  assert.match(result.reason, /definitely-absent\.db/);
});

check("a ZERO-BYTE database counts as absent, not as a corpus", () => {
  // The recorded incident: `resolveDbPath` uses fs.existsSync only, so a 0-byte shr.db resolved as a
  // real database and detector D6 "silently cannot fire". Certifying against that file would be worse
  // than skipping.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-zero-"));
  try {
    const stub = path.join(dir, "stub.db");
    fs.writeFileSync(stub, "");
    assert.equal(fs.statSync(stub).size, 0);
    const result = manifestModule.corpusAvailability({
      corpus: { description: "canonical", detect: [stub] },
    });
    assert.equal(result.available, false);
    assert.match(result.reason, /0 bytes/);

    fs.writeFileSync(stub, "not empty");
    assert.equal(manifestModule.corpusAvailability({
      corpus: { description: "canonical", detect: [stub] },
    }).available, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ preflight

function withFixtures(seeds, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-"));
  try {
    return body(buildFixtures(dir, DATABASE_NAMES, seeds));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check("preflight passes when a declared row floor is met", () => {
  withFixtures({ rtci: { historical_agency_population: [
    { ori: "TX0010000", year: 2017, population: 950000 },
    { ori: "TX0010000", year: 2018, population: 960000 },
  ] } }, (fixtures) => {
    const violations = runner.checkRequires({
      requires: [{ database: "rtci", table: "historical_agency_population", min_rows: 2 }],
    }, fixtures);
    assert.equal(violations, null, JSON.stringify(violations));
  });
});

check("preflight FAILS a schema-only fixture where rows were declared", () => {
  // The required mutation: downgrade a seeded profile to schema-only and the affected test must fail
  // in preflight, before its assertions -- not pass vacuously and not skip.
  withFixtures({}, (fixtures) => {
    const violations = runner.checkRequires({
      requires: [{ database: "rtci", table: "historical_agency_population", min_rows: 2 }],
    }, fixtures);
    assert.ok(violations, "a schema-only fixture satisfied a declared row floor");
    assert.match(violations.join(" "), /needs >= 2 row\(s\), has 0/);
  });
});

check("preflight honours a WHERE clause, not just a total count", () => {
  withFixtures({ rtci: { historical_agency_population: [
    { ori: "TX0010000", year: 2019, population: 950000 },
    { ori: "TX0010000", year: 2020, population: 960000 },
  ] } }, (fixtures) => {
    const met = runner.checkRequires({
      requires: [{ database: "rtci", table: "historical_agency_population", min_rows: 2 }],
    }, fixtures);
    assert.equal(met, null, "the total row floor should be met");

    const unmet = runner.checkRequires({
      requires: [{ database: "rtci", table: "historical_agency_population", where: "year = 2017", min_rows: 1 }],
    }, fixtures);
    assert.ok(unmet, "two non-2017 rows satisfied a year = 2017 requirement");
    assert.match(unmet.join(" "), /year = 2017/);
  });
});

check("preflight FAILS the all-NULL fixture that would otherwise pass VACUOUSLY", () => {
  // The shape of the worked example. test-current-indexed-state-deterministic.ts guards its only
  // equality with `if (base[column] !== null)`, so a 2017 row whose value column is NULL satisfies
  // both "non-empty" and "has a 2017 row" while asserting NOTHING.
  //
  // `historical_agency_population.population` is the right table to demonstrate it on: it is one of
  // the few RTCI columns the committed DDL leaves NULLABLE, so the all-NULL fixture is actually
  // constructible here. On the worked example's own `agency_population` the column is NOT NULL and
  // the same hole is reached through a missing LEFT JOIN match instead -- which is what
  // test-harness-preflight-mutations.js covers end to end.
  withFixtures({ rtci: { historical_agency_population: [
    { ori: "TX0010000", year: 2017, population: null },
    { ori: "TX0010000", year: 2018, population: null },
  ] } }, (fixtures) => {
    const rowsOnly = runner.checkRequires({
      requires: [{ database: "rtci", table: "historical_agency_population", where: "year = 2017", min_rows: 1 }],
    }, fixtures);
    assert.equal(rowsOnly, null, "the row-count-only requirement is met, which is the trap");

    const withValues = runner.checkRequires({
      requires: [{
        database: "rtci", table: "historical_agency_population", where: "year = 2017",
        min_rows: 1, non_null: ["population"],
      }],
    }, fixtures);
    assert.ok(withValues, "an all-NULL 2017 row satisfied a non_null requirement");
    assert.match(withValues.join(" "), /would never evaluate/);
  });
});

check("preflight reports a missing table rather than throwing", () => {
  withFixtures({}, (fixtures) => {
    const violations = runner.checkRequires({
      requires: [{ database: "rtci", table: "no_such_table", min_rows: 1 }],
    }, fixtures);
    assert.ok(violations);
    assert.match(violations.join(" "), /no_such_table/);
  });
});

// ------------------------------------------------------------------ accounting and verdicts

function synthPlan(atomic, topLevel) {
  return { commands: new Array(atomic).fill({}), topLevel, cycles: [], missing: [] };
}

function result(state, tier, extra) {
  return { id: `${state}-${tier}-${Math.random()}`, state, tier, command: "x", ...extra };
}

check("the four states sum to the DERIVED atomic count", () => {
  const results = [result(PASSED, "F"), result(FAILED, "F"), result(SKIPPED, "C",
    { corpus_requirement: "c", reason: "r" }), result(BLOCKED, "F", { reason: "r" })];
  const { output } = capture(() =>
    runner.report(results, synthPlan(4, 3), { probe: false, only: null }, []));
  assert.match(output, /tally: 1 passed, 1 failed, 1 skipped, 1 blocked  = 4/);
});

check("a tally summing to the TOP-LEVEL entry count is rejected", () => {
  // "A tally that sums to 133 is wrong by construction." The derived atomic count is the only
  // legitimate total, and the top-level count is the specific wrong answer to reject by name.
  const results = [result(PASSED, "F"), result(PASSED, "F"), result(PASSED, "F")];
  const { value, output } = capture(() =>
    runner.report(results, synthPlan(4, 3), { probe: false, only: null }, []));
  assert.equal(value, 1, "a short tally must fail the run");
  assert.match(output, /tally sums to 3, but the derived plan has 4 atomic commands/);
  assert.match(output, /top-level entry count is 3 and is NOT the expected total/);
});

check("blocked is reported as blocked, never as skipped", () => {
  const results = [result(BLOCKED, "F", { reason: "pretest failed, so `test` never ran" })];
  const { value, output } = capture(() =>
    runner.report(results, synthPlan(1, 1), { probe: false, only: null }, []));
  assert.match(output, /1 blocked/);
  assert.match(output, /never ran because a prerequisite failed/);
  assert.doesNotMatch(output, /skipped \(Tier C/);
  assert.equal(value, 1, "a blocked command must fail the run");
});

check("Tier C skips give corpus_not_certified while Tier F can still be fixture_passed", () => {
  const results = [
    result(PASSED, "F"),
    result(SKIPPED, "C", { corpus_requirement: "canonical RTCI with 2017-2024", reason: "absent" }),
  ];
  const { value, output } = capture(() =>
    runner.report(results, synthPlan(2, 2), { probe: false, only: null }, []));
  assert.match(output, /verdict {2}fixture: fixture_passed/);
  assert.match(output, /verdict {2}corpus: {2}corpus_not_certified/);
  assert.match(output, /must not be described as "passed"/);
  // A Tier C skip is not a failure -- it is an uncertified run that still reports its Tier F result.
  assert.equal(value, 0);
  // The skip carries the metadata P1.2 needs, without reclassifying anything.
  assert.match(output, /requires: canonical RTCI with 2017-2024/);
});

check("the two verdicts never merge into one", () => {
  const results = [result(FAILED, "F", { reason: "boom" }), result(SKIPPED, "C",
    { corpus_requirement: "c", reason: "absent" })];
  const { output } = capture(() =>
    runner.report(results, synthPlan(2, 2), { probe: false, only: null }, []));
  assert.match(output, /fixture_failed/);
  assert.match(output, /corpus_not_certified/);
  assert.doesNotMatch(output, /\bpassed\b.*\bcertified\b/);
});

check("a run defect fails the run even when every command passed", () => {
  const results = [result(PASSED, "F")];
  const { value, output } = capture(() =>
    runner.report(results, synthPlan(1, 1), { probe: false, only: null },
      ["undeclared skip: something announced a skip"]));
  assert.equal(value, 1);
  assert.match(output, /1 RUN DEFECT\(S\)/);
  assert.match(output, /undeclared skip/);
});

check("probe mode issues NO verdict", () => {
  const results = [result(PASSED, "?")];
  const { output } = capture(() =>
    runner.report(results, synthPlan(1, 1), { probe: true, only: null }, []));
  assert.match(output, /no verdict is issued/);
  assert.doesNotMatch(output, /fixture_passed/);
  assert.doesNotMatch(output, /corpus_certified/);
});

// ------------------------------------------------------------------ skip announcement detection

check("a skip is announced by PROTOCOL, so it cannot be confused with output", () => {
  assert.equal(runner.SKIP_PROTOCOL_EXIT, 77, "the automake convention for a skipped test");
  assert.match("HARNESS-SKIP: the canonical corpus is absent", runner.SKIP_PROTOCOL_LINE);
  // Must be at the start of a line: a command quoting the token mid-sentence is not announcing one.
  assert.doesNotMatch("we could print HARNESS-SKIP: here but do not", runner.SKIP_PROTOCOL_LINE);
});

check("the prose heuristic never fails a run -- the regression that motivated the protocol", () => {
  // The first full run FAILED on this exact line, from `test_refresh_agency_populations`. It is a
  // statistic about input rows, from the script under test, saying that nothing was skipped -- while
  // all 15 of that test's checks passed. Prose cannot distinguish the two, so prose is advisory only.
  const realOutput = [
    "Source: C:/Users/jeffm/AppData/Local/Temp/tmpuiqdkutw/populations.csv",
    "  authoritative agency rows loaded: 4",
    "  skipped non-agency ids: 0, malformed: 0",
    "All 15 population repair checks passed.",
  ].join("\n");

  assert.ok(!runner.SKIP_PROTOCOL_LINE.test(realOutput),
    "the protocol must not fire on a data statistic");
  assert.notEqual(0, runner.SKIP_PROTOCOL_EXIT, "a passing command exits 0, never the skip code");

  // The narrowed prose hints no longer match it either, which is the direct regression guard.
  assert.ok(!runner.SKIP_PROSE_HINTS.some((re) => re.test(realOutput)),
    "the prose hints still match `skipped non-agency ids: 0` -- the false positive is back");

  // And they still recognise a genuine prose skip, so narrowing them did not empty them.
  for (const text of ["SKIP: no corpus", "Skipping the comparison because the corpus is absent"]) {
    assert.ok(runner.SKIP_PROSE_HINTS.some((re) => re.test(text)), `no longer detected: ${text}`);
  }
});

check("an advisory is printed after the verdicts and never changes the exit code", () => {
  const results = [result(PASSED, "F")];
  const { value, output } = capture(() =>
    runner.report(results, synthPlan(1, 1), { probe: false, only: null }, [],
      ["something: skip-shaped prose"]));
  assert.equal(value, 0, "an advisory must not fail a run");
  assert.match(output, /advisory note\(s\), not failures/);
  assert.match(output, /skip-shaped prose/);
  assert.doesNotMatch(output, /RUN DEFECT/);
});

// ------------------------------------------------------------------ seed profiles

check("every defined seed profile is referenced, except the mutation-only ones", () => {
  // Dead seed data still has to be maintained, so an unreferenced profile fails the run. The one
  // exception is declared by naming convention: a `mutation_` profile exists to prove a check fires
  // and is referenced from a mutation battery rather than from the manifest.
  const { SEED_PROFILES } = require("./lib/fixture-seeds.js");
  const manifest = manifestModule.loadManifest();
  const used = new Set(manifest.entries.map((e) => e.seed_profile));
  const orphans = Object.keys(SEED_PROFILES)
    .filter((name) => !name.startsWith("mutation_") && !used.has(name));
  assert.deepEqual(orphans, [], `seed profiles nothing references: ${orphans.join(", ")}`);

  // And the convention is not a loophole: a mutation profile must actually be used by a battery.
  const battery = fs.readFileSync(path.join(__dirname, "test-harness-preflight-mutations.js"), "utf8");
  const unusedMutations = Object.keys(SEED_PROFILES)
    .filter((name) => name.startsWith("mutation_") && !battery.includes(name));
  assert.deepEqual(unusedMutations, [],
    `mutation-only seed profiles no battery references: ${unusedMutations.join(", ")}`);
});

check("every manifest seed_profile resolves, and every entry's databases cover its requires", () => {
  const manifest = manifestModule.loadManifest();
  for (const entry of manifest.entries) {
    assert.doesNotThrow(() => runner.seedFor(entry), `${entry.id}: seed profile does not resolve`);
    for (const clause of entry.requires) {
      assert.ok(entry.databases.includes(clause.database),
        `${entry.id}: requires ${clause.database} without declaring it`);
    }
  }
});

check("the manifest covers every atomic command the harness runs", () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")).scripts;
  const plan = planHarness(scripts, ENTRY_POINTS);
  const manifest = manifestModule.loadManifest();
  const { undeclared, stale } = manifestModule.reconcile(manifest, plan.commands);
  assert.deepEqual(undeclared.map((c) => c.command), [],
    "commands with no manifest entry would run against whatever databases are on disk");
  assert.deepEqual(stale, [], "manifest entries for commands the harness no longer runs");
});

console.log(`harness contract tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log("  " + failure);
  process.exitCode = 1;
}
