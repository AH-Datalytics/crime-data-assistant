/**
 * P1.3-R: every test-shaped file has exactly one home, and the harness can prove it.
 *
 * THE GAP THIS CLOSES. `reconcile()` reports `undeclared` (the harness runs it, the manifest does not
 * declare it) and `stale` (the manifest declares it, the harness does not run it). Both are questions
 * about the PLAN, so neither can see a file that nothing runs and nothing declares. "Zero undeclared,
 * zero stale" was therefore honestly reported at `15e4801` while fifteen test-shaped files were
 * invisible to the accounting. Only the filesystem can answer the third question, so this suite asks
 * it and then requires the answer to close.
 *
 * THE PROPERTY IS A DISJOINT UNION, ALL THREE SETS DERIVED:
 *
 *     discovered (filesystem walk)  ==  registered (derived plan)  (+)  excluded (registry)
 *
 * NO EXPECTED TOTAL IS ASSERTED. A hard-coded count would rebuild exactly the defect the derived plan
 * removed, and would fail a correctly registered new test for the sole reason that a second number was
 * not incremented. Today's figures are PRINTED as evidence and asserted nowhere. Non-vacuity comes from
 * `discovered` being non-empty and from the contract's mutation battery, not from a constant.
 *
 * WHY `both` IS A SEPARATE FAILURE FROM `unresolved`. They are opposite defects. A file in neither home
 * is invisible. A file in BOTH makes every individual check pass while the truth is ambiguous -- the
 * manifest says it runs, the registry says it deliberately does not -- and whichever a reader consults
 * first is the answer they get.
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

const {
  DISCOVERY_ROOT,
  isTestShaped,
  discoverTestShaped,
  discoveryDirectories,
  partitionDiscovered,
} = require("./lib/orphan-discovery.js");
const {
  KINDS,
  REASON_CODES,
  NEVER_IN_MANIFEST,
  validateExclusions,
  loadExclusions,
  exclusionPaths,
} = require("./lib/harness-exclusions.js");
const { planHarness, ENTRY_POINTS } = require("./lib/harness-plan.js");
const manifestModule = require("./lib/tier-manifest.js");

const REPO = path.join(__dirname, "..");

let passed = 0;
const failures = [];
function check(name, body) {
  try {
    body();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message}`);
  }
}

/* ------------------------------------------------------------------ derived inputs */

const scripts = require(path.join(REPO, "package.json")).scripts;
const plan = planHarness(scripts, ENTRY_POINTS);
const planScripts = plan.commands.map((c) => c.script).filter(Boolean);
const discovered = discoverTestShaped(REPO);
const registry = loadExclusions();
const excluded = exclusionPaths(registry);
const partition = partitionDiscovered(discovered, planScripts, excluded);
const manifest = manifestModule.loadManifest();

/* ------------------------------------------------------------------ the rule itself */

check("the rule catches a MIDDLE-segment `test`, which globs would miss", () => {
  /**
   * The blocker that produced revision 2. `audit-test-routing-log.ts` was named in revision 1's own
   * disposition matrix while revision 1's discovery rule -- four globs -- could not find it.
   */
  assert.equal(isTestShaped("scripts/audit-test-routing-log.ts"), true,
    "a middle-segment `test` is not being discovered; the revision-1 hole is open again");
  for (const glob of [/^test-/, /^test_/, /-test\./, /_test\./]) {
    assert.equal(glob.test("audit-test-routing-log.ts"), false,
      `the revision-1 glob ${glob} would have caught it, so this control proves nothing`);
  }
});

check("the rule is a BASENAME rule -- a directory named `test` sweeps nothing in", () => {
  // False-refusal control 1. A path component is not a basename segment.
  assert.equal(isTestShaped("scripts/test/helpers.ts"), false);
  assert.equal(isTestShaped("scripts/integration-test/runner.js"), false);
  assert.equal(isTestShaped("scripts/lib/fixture-db.js"), false);
  assert.equal(isTestShaped("scripts/lib/harness-plan.js"), false);
  // …and a segment that merely CONTAINS `test` is not the segment `test`.
  assert.equal(isTestShaped("scripts/latest-run.ts"), false);
  assert.equal(isTestShaped("scripts/contest-results.py"), false);
  assert.equal(isTestShaped("scripts/testing-utils.ts"), false);
});

check("`.d.ts` declaration files are not tests", () => {
  // False-refusal control 3.
  assert.equal(isTestShaped("scripts/test-thing.d.ts"), false);
  assert.equal(isTestShaped("scripts/types/test.d.ts"), false);
  for (const file of discovered) {
    assert.ok(!file.endsWith(".d.ts"), `${file} is a declaration file and should not be discovered`);
  }
});

check("only the governed extensions are discovered", () => {
  assert.equal(isTestShaped("scripts/test-notes.md"), false);
  assert.equal(isTestShaped("scripts/test-data.json"), false);
  assert.equal(isTestShaped("scripts/test-thing.ts"), true);
  assert.equal(isTestShaped("scripts/test_thing.py"), true);
  assert.equal(isTestShaped("scripts/test-thing.js"), true);
  assert.equal(isTestShaped("scripts/test-thing.ps1"), true);
});

/* ------------------------------------------------------------------ discovery is real */

check("discovery is non-empty and genuinely recursive", () => {
  assert.ok(discovered.length > 0,
    "discovery found nothing, so every partition claim below would be vacuous");
  const dirs = discoveryDirectories(discovered);
  assert.ok(dirs.includes(DISCOVERY_ROOT), `expected test-shaped files directly under ${DISCOVERY_ROOT}`);
  // A top-level-only scan was revision 1's other defect: one candidate lives in a subdirectory.
  const nested = dirs.filter((d) => d !== DISCOVERY_ROOT);
  assert.ok(nested.length > 0,
    "no nested directory holds a test-shaped file, so recursion is unproven here");
});

/* ------------------------------------------------------------------ the registry */

check("the exclusion registry validates", () => {
  const problems = validateExclusions(registry, { repo: REPO, discovered, manifestScripts: manifest.entries.map((e) => e.script) });
  assert.deepEqual(problems, [], `registry problems:\n  ${problems.join("\n  ")}`);
});

check("every exclusion's kind and reason_code are inside the closed sets", () => {
  for (const entry of registry.entries) {
    assert.ok(KINDS.includes(entry.kind), `${entry.path}: kind ${entry.kind} is outside the closed set`);
    assert.ok(REASON_CODES[entry.kind].includes(entry.reason_code),
      `${entry.path}: reason_code ${entry.reason_code} is not valid for kind ${entry.kind}`);
  }
});

check("every quarantine names a follow-up, so it cannot become permanent by neglect", () => {
  const quarantined = registry.entries.filter((e) => e.kind === "quarantined");
  assert.ok(quarantined.length > 0, "no quarantine entries; this control would be vacuous");
  for (const entry of quarantined) {
    assert.ok(typeof entry.follow_up === "string" && entry.follow_up.trim().length > 0,
      `${entry.path}: quarantined with no follow_up`);
  }
});

check("no excluded file carries a corpus declaration -- Tier C is not `needs network`", () => {
  /**
   * Tier C means "declares registry corpora", not "needs a network". A corpus declaration on a file
   * that never runs would be Tier C leaking somewhere it cannot mean anything, so the field is refused
   * outright rather than ignored.
   */
  for (const entry of registry.entries) {
    assert.equal(entry.corpus_ids, undefined, `${entry.path}: an exclusion cannot declare corpus_ids`);
  }
  const problems = validateExclusions(
    { entries: [{ ...registry.entries[0], corpus_ids: ["rtci"] }] },
    { repo: REPO, discovered, manifestScripts: manifest.entries.map((e) => e.script) },
  );
  assert.ok(problems.some((p) => /unknown field "corpus_ids"/.test(p)),
    `validation accepted corpus_ids on an exclusion; problems were: ${problems.join(" | ")}`);
});

check("no network-optional or quarantined file appears in the tier manifest", () => {
  const manifestScripts = new Set(manifest.entries.map((e) => e.script));
  for (const entry of registry.entries) {
    if (!NEVER_IN_MANIFEST.includes(entry.kind)) continue;
    assert.ok(!manifestScripts.has(entry.path),
      `${entry.path} is ${entry.kind} yet declared in the tier manifest`);
  }
});

/* ------------------------------------------------------------------ the partition */

check("no discovered file is UNRESOLVED -- nothing is silently invisible", () => {
  assert.deepEqual(partition.unresolved, [],
    "these test-shaped files are neither registered nor excluded, so the harness cannot see them:\n"
    + `        ${partition.unresolved.join("\n        ")}`);
});

check("no discovered file is in BOTH homes", () => {
  assert.deepEqual(partition.both, [],
    "these are registered AND excluded, so the accounting is ambiguous:\n"
    + `        ${partition.both.join("\n        ")}`);
});

check("the partition is a disjoint union of the two derived subsets", () => {
  const union = [...partition.registered, ...partition.excluded].sort();
  assert.deepEqual(union, discovered,
    "registered ⊎ excluded does not equal discovered");
  const overlap = partition.registered.filter((f) => partition.excluded.includes(f));
  assert.deepEqual(overlap, [], "the two subsets overlap");
  assert.equal(
    partition.registered.length + partition.excluded.length,
    discovered.length,
    "the two subsets do not account for every discovered file exactly once",
  );
});

check("every registered discovered file is reachable EXACTLY ONCE", () => {
  const counts = new Map();
  for (const script of planScripts) counts.set(script, (counts.get(script) || 0) + 1);
  for (const file of partition.registered) {
    assert.equal(counts.get(file), 1,
      `${file} is reachable ${counts.get(file)} times through the derived plan, not once`);
  }
});

check("every registered discovered file has a manifest entry", () => {
  const manifestScripts = new Set(manifest.entries.map((e) => e.script));
  for (const file of partition.registered) {
    assert.ok(manifestScripts.has(file), `${file} runs in the plan with no manifest entry`);
  }
});

/* ------------------------------------------------------------------ evidence, not acceptance */

console.log("");
console.log("  evidence (printed, never asserted -- see the disjoint-union note above):");
console.log(`    derived chain commands                    : ${plan.commands.length}`);
console.log(`    test-shaped files discovered recursively  : ${discovered.length}`);
console.log(`    …registered (reachable through the plan)  : ${partition.registered.length}`);
console.log(`    …excluded (declared in the registry)      : ${partition.excluded.length}`);
console.log(`    …unresolved                               : ${partition.unresolved.length}`);
console.log(`    directories holding test-shaped files     : ${discoveryDirectories(discovered).join(", ")}`);
const byKind = {};
for (const entry of registry.entries) byKind[entry.kind] = (byKind[entry.kind] || 0) + 1;
console.log(`    exclusions by kind                        : ${
  Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ")}`);

console.log("");
console.log(`harness discovery: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
