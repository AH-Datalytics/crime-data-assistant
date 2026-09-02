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
const { loadRegistry } = require("./lib/corpus-registry.js");

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

check("tier C with an empty corpus_ids list is rejected", () => {
  expectProblem(
    [entryWith({ tier: "C", corpus: { description: "d", corpus_ids: [] } })],
    "non-empty corpus_ids array");
});

// ITEM 9, CASE 1. The legacy form must be REJECTED, not ignored. An entry still carrying `detect`
// after P1.2 reads to a maintainer like a working declaration, and the runner would silently treat the
// command as having declared nothing -- so the failure mode is a Tier C command that can never run,
// for a reason nobody can see in the manifest.
check("a lingering legacy `detect` array is rejected outright", () => {
  expectProblem(
    [entryWith({ tier: "C", corpus: { description: "d", detect: ["data/crime_data.db"],
      corpus_ids: ["rtci"] } })],
    "legacy path-search form");
});

check("a corpus_ids entry naming an unknown corpus is rejected", () => {
  expectProblem(
    [entryWith({ tier: "C", corpus: { description: "d", corpus_ids: ["nibrs"] } })],
    "not in the corpus registry");
});

check("corpus_ids naming the same corpus twice is rejected", () => {
  expectProblem(
    [entryWith({ tier: "C", corpus: { description: "d", corpus_ids: ["rtci", "rtci"] } })],
    "names rtci twice");
});

check("tier F may not declare a corpus", () => {
  expectProblem(
    [entryWith({ corpus: { description: "d", corpus_ids: ["rtci"] } })],
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

// ------------------------------------------------------------------ corpus reachability

// `corpusAvailability()` was deleted by P1.2 and its two tests are replaced here. It answered "does a
// non-empty file exist at one of these paths?", which is a detector rather than a proof: it could not
// tell a reviewed snapshot from a leftover, nor which set two corpora came from. The behaviour that
// replaces it is proven in `scripts/test-corpus-reachability.js`, which stands up real published sets.
//
// What belongs HERE is the narrow structural claim this file owns: the permissive entry point is gone,
// so nothing can reach a corpus without going through verification.

check("the permissive corpusAvailability entry point no longer exists", () => {
  assert.equal(manifestModule.corpusAvailability, undefined,
    "corpusAvailability must be deleted, not merely unused: a permissive fallback that still exports " +
    "cleanly is one someone will eventually call");
});

check("the manifest's own Tier C entries all declare registry corpora, and none declare detect", () => {
  const manifest = manifestModule.loadManifest();
  const tierC = manifest.entries.filter((e) => e.tier === "C");
  assert.ok(tierC.length > 0, "the manifest should declare Tier C commands");
  const known = new Set(loadRegistry().corpora.map((c) => c.id));
  for (const entry of tierC) {
    assert.equal(entry.corpus.detect, undefined, `${entry.id} still carries a legacy detect array`);
    assert.ok(Array.isArray(entry.corpus.corpus_ids) && entry.corpus.corpus_ids.length > 0,
      `${entry.id} declares no corpus_ids`);
    for (const id of entry.corpus.corpus_ids) {
      assert.ok(known.has(id), `${entry.id} declares unknown corpus ${id}`);
    }
  }
});

/**
 * The corpora a description NAMES, by the words a human would write for each.
 *
 * `nibrs` is listed even though no corpus is registered for it, precisely because that is the mistake
 * worth catching: `test-year-availability`'s description claimed NIBRS while decision 5.5 measured that
 * no Tier C command needs it. A vocabulary limited to registered ids could not have seen that.
 */
const CORPUS_WORDS = {
  rtci: [/\bRTCI\b/i, /\bcrime_data\b/i],
  shr: [/\bSHR\b/i, /\bshr\.db\b/i],
  nibrs: [/\bNIBRS\b/i, /\bnibrs\.db\b/i],
};

/** Disagreements between one entry's description prose and its declared corpus_ids. */
function describeMismatches(entry) {
  const declared = new Set(entry.corpus.corpus_ids);
  const description = entry.corpus.description;
  const problems = [];
  for (const [id, patterns] of Object.entries(CORPUS_WORDS)) {
    const named = patterns.some((re) => re.test(description));
    if (named && !declared.has(id)) {
      problems.push(`${entry.id}: description names ${id} but corpus_ids is ` +
        `[${[...declared].join(", ")}] -- move a negative scope fact to \`note\``);
    }
    if (!named && declared.has(id)) {
      problems.push(`${entry.id}: declares ${id} but the description never mentions it`);
    }
  }
  return problems;
}

check("every Tier C description names EXACTLY the corpora it declares", () => {
  // The prose and the declaration are two statements of the same fact, so a disagreement is a defect
  // in one of them -- and it is the prose that misled a reader for a whole increment. Measured scope
  // that is NEGATIVE ("SHR is queried but not required") belongs in `note`, which is not scanned:
  // encoding a negation in the description would need this check to parse English.
  const manifest = manifestModule.loadManifest();
  const problems = manifest.entries
    .filter((e) => e.tier === "C")
    .flatMap((entry) => describeMismatches(entry));
  assert.deepEqual(problems, [], problems.join("\n  "));
});

check("the description scanner would have CAUGHT both corrected descriptions", () => {
  // A scanner that never fires proves nothing, so it is run against the exact prose it was written
  // for: the two descriptions as they stood before 2026-08-23.
  const battery = describeMismatches({
    id: "test-regression-battery",
    corpus: { corpus_ids: ["rtci"],
      description: "canonical RTCI and SHR databases covering the named regression cities" },
  });
  assert.equal(battery.length, 1, `expected exactly one problem, got ${JSON.stringify(battery)}`);
  assert.match(battery[0], /description names shr but corpus_ids is \[rtci\]/);

  const years = describeMismatches({
    id: "test-year-availability",
    corpus: { corpus_ids: ["rtci", "shr"],
      description: "canonical RTCI, SHR and NIBRS databases with their real year ranges" },
  });
  assert.equal(years.length, 1, `expected exactly one problem, got ${JSON.stringify(years)}`);
  assert.match(years[0], /description names nibrs but corpus_ids is \[rtci, shr\]/);

  // And the other direction: a declared corpus the prose forgets.
  const silent = describeMismatches({
    id: "synthetic",
    corpus: { corpus_ids: ["rtci", "shr"], description: "canonical RTCI crime_data.db only" },
  });
  assert.equal(silent.length, 1);
  assert.match(silent[0], /declares shr but the description never mentions it/);
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
  // Whitespace-tolerant: the skip block is column-aligned now that it also prints the declared corpus
  // ids and the active set, and the claim under test is that the requirement is stated, not how it is
  // padded.
  assert.match(output, /requires:\s+canonical RTCI with 2017-2024/);
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


// ── diagnostic excerpt ────────────────────────────────────────────────────────────────────────
//
// THE FAILURE THIS EXISTS FOR. On 2026-09-02 a Tier F suite failed ONCE in CI by crashing at
// MODULE LOAD. The captured stderr was a Node stack trace; the harness kept its last six lines,
// which were four frames of loader internals, a blank line, and `Node.js v24.14.0`. The first line
// — the one naming what could not be loaded — was discarded, so the failure was undiagnosable from
// the record. It did NOT reproduce locally: two reproductions under the harness's own fixture
// environment, one in a disposable fresh checkout, both passed. It stands as a single unexplained,
// non-reproduced occurrence. What is established is narrower and sufficient: six lines demonstrably
// lost the message.
//
// THE BOUND IS THE PROBLEM, NOT ITS SIZE. An exception message sits at the TOP of a trace, so ANY
// tail-only window loses it whenever a trace exceeds that window. The actual length of the
// 2026-09-02 trace is unknowable, because that output was discarded. These assertions therefore pin
// the general property — that BOTH ends survive, and that the reader is told when the middle was
// dropped — rather than anything about that particular trace.

check("excerpt keeps output shorter than the limit verbatim", () => {
  const short = ["Error: boom", "    at one", "    at two"].join("\n");
  assert.equal(runner.diagnosticExcerpt(short), short);
});

check("excerpt keeps output exactly at the limit verbatim", () => {
  const exact = Array.from({ length: runner.EXCERPT_LINES }, (_, i) => `line ${i}`).join("\n");
  assert.equal(runner.diagnosticExcerpt(exact), exact);
  assert.equal(runner.diagnosticExcerpt(exact).split("\n").length, runner.EXCERPT_LINES);
});

check("excerpt of a long module-load trace keeps the exception MESSAGE", () => {
  // A SYNTHETIC trace in the shape a module-load failure takes: message first, many frames, runner
  // epilogue last. It is not the recovered 2026-09-02 output, which no longer exists; its length is
  // chosen to exceed any plausible tail-only bound so the property is exercised, not to model a
  // measured trace.
  const trace = [
    "node:internal/modules/cjs/loader:1210",
    "  throw err;",
    "  ^",
    "",
    "Error: Cannot find module 'some-module'",
    "Require stack:",
    "- D:\\a\\repo\\repo\\scripts\\thing.ts",
    ...Array.from({ length: 200 }, (_, i) => `    at frame${i} (node:internal/x:${i}:1)`),
    "",
    "Node.js v24.14.0",
  ].join("\n");
  const out = runner.diagnosticExcerpt(trace);
  assert.ok(out.includes("Error: Cannot find module 'some-module'"),
    "the exception message must survive; a tail-only window is what lost the CI message");
  assert.ok(out.includes("Require stack:"), "the context under the message must survive too");
});

check("excerpt of the same trace keeps the TERMINAL frames and epilogue", () => {
  const trace = [
    "Error: Cannot find module 'some-module'",
    ...Array.from({ length: 200 }, (_, i) => `    at frame${i} (node:internal/x:${i}:1)`),
    "",
    "Node.js v24.14.0",
  ].join("\n");
  const out = runner.diagnosticExcerpt(trace);
  assert.ok(out.includes("Node.js v24.14.0"), "the epilogue must survive");
  assert.ok(out.includes("at frame199"), "the last frame must survive");
});

check("excerpt never exceeds its declared line budget", () => {
  for (const n of [65, 100, 500, 5000]) {
    const text = Array.from({ length: n }, (_, i) => `line ${i}`).join("\n");
    const lines = runner.diagnosticExcerpt(text).split("\n");
    assert.ok(lines.length <= runner.EXCERPT_LINES,
      `an excerpt of ${n} lines produced ${lines.length}, over the ${runner.EXCERPT_LINES} budget`);
  }
});

check("excerpt marks the elision rather than presenting a false contiguous view", () => {
  const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
  const out = runner.diagnosticExcerpt(text);
  const marker = out.split("\n").find((l) => l.includes("elided"));
  assert.ok(marker, "a truncated excerpt must say so");
  // The count must be honest: kept + elided === total.
  const kept = out.split("\n").length - 1;
  const elided = Number((marker.match(/(\d+) line\(s\) elided/) || [])[1]);
  assert.equal(kept + elided, 300, "the elision count must reconcile with what was kept");
});

check("the excerpt budget is larger than the six lines that lost the 2026-09-02 message", () => {
  assert.ok(runner.EXCERPT_LINES >= 64,
    "the budget was raised deliberately after a module-load message was truncated away");
});

console.log(`harness contract tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log("  " + failure);
  process.exitCode = 1;
}
