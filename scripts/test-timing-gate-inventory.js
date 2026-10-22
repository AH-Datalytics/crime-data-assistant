/**
 * The timing-gate inventory: every place the canonical harness reads a clock, classified.
 *
 * WHY. The canonical harness is a required check. Twice -- runs 32970500509 (2026-08-26) and
 * 33801327126 (2026-09-03) -- it went red on byte-identical trees because an assertion compared
 * elapsed wall-clock time on a shared hosted runner with a fixed budget. Such a gate tests how fast
 * the machine was, not whether the code is right, and the standing rule forbids re-running it. The
 * 2026-09-03 repair replaced every such gate with a structural assertion. This test keeps them out.
 *
 * WHAT IS MEASURED. Every script in the derived harness plan (the same expansion the runner uses,
 * so a command cannot be in the harness and outside this inventory) plus the shared helpers under
 * scripts/lib/ is scanned for two things:
 *
 *   clock reads          performance.now(), Date.now(), process.hrtime, process.uptime(),
 *                        no-argument new Date(), and their Python / PowerShell equivalents
 *   elapsed comparisons  an ordering comparison (<, <=, >, >=) whose operand is an identifier that
 *                        names a duration -- elapsed*, took, duration*, latency*, *Ms
 *
 * Every file with a hit must appear below with its EXACT counts and a classification. A new read
 * or comparison anywhere in the harness changes a count and fails here until it is classified;
 * an entry whose file no longer has hits is stale and fails too. Classes follow the repair
 * authorization:
 *
 *   1  wall-clock correctness gate      -- pass/fail depends on elapsed time; MUST be zero
 *   2  non-gating observation           -- measured and printed, never compared for pass/fail
 *   3  fake or injected clock           -- deterministic by construction
 *   4  structural                       -- timestamps as fixture data, fixed-offset ages, liveness
 *                                         bounds on an external process, "clock not consulted"
 *
 * WHAT THIS CANNOT SEE. A comparison against a duration held in a variable whose name says nothing
 * about time. The counts make such a gate harder to add silently (its clock read still counts) but
 * a reader classifying a new entry must still read the code, not just the token.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { planHarness, ENTRY_POINTS } = require("./lib/harness-plan");

const REPO = path.join(__dirname, "..");

/** Clock reads, by file extension. Each pattern is counted once per match. */
const CLOCK_READS = {
  js: [/\bperformance\.now\s*\(/g, /\bDate\.now\s*\(/g, /\bprocess\.hrtime\b/g, /\bprocess\.uptime\s*\(/g, /\bnew Date\s*\(\s*\)/g],
  py: [/\btime\.time\s*\(/g, /\bperf_counter\s*\(/g, /\bmonotonic\s*\(/g, /\bdatetime\.now\s*\(/g, /\butcnow\s*\(/g, /\bprocess_time\s*\(/g],
  ps1: [/\bGet-Date\b/gi, /\bStopwatch\b/gi, /\bMeasure-Command\b/gi],
};
CLOCK_READS.ts = CLOCK_READS.js;
CLOCK_READS.cjs = CLOCK_READS.js;
CLOCK_READS.mjs = CLOCK_READS.js;

/** An ordering comparison with a duration-named operand on either side. */
const DURATION_NAME = String.raw`(?:[A-Za-z_$][\w$.!]*\.)?(?:elapsed\w*|took|duration\w*|latency\w*|\w*Ms)\b`;
const ELAPSED_COMPARISON = new RegExp(
  String.raw`(?:\b${DURATION_NAME}\s*(?:<=?|>=?)\s*[^\n;]+)|(?:[^\n;]*\s(?:<=?|>=?)\s*${DURATION_NAME})`,
  "g",
);

/**
 * The inventory. Counts are exact; a change in either direction fails until reconciled here.
 * `note` says why the classification is honest. Line references are guidance for a reader, not
 * something the test checks -- lines move, counts do not.
 */
const INVENTORY = [
  // ── plan scripts ─────────────────────────────────────────────────────────────────────────────
  { file: "scripts/test-analytics-handler-boundary.ts", clockReads: 2, elapsedComparisons: 1, class: 4,
    note: "fixture row timestamps spaced an hour apart, and a five-minute mtime cutoff (`mtimeMs > cutoff`) that decides which leftover fixture directories a clean-up sweep may remove; the sweep is housekeeping, not an assertion" },
  { file: "scripts/test-audit-provenance.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "fixture row timestamps" },
  { file: "scripts/test-authoritative-label-route-placement.ts", clockReads: 1, elapsedComparisons: 1, class: 4,
    note: "searches the route SOURCE for the line `const totalMs = Date.now() - totalStart;` (the clock read is inside that quoted string) and compares LINE NUMBERS -- `i > totalMs` -- to prove where a label is applied relative to that line; nothing here measures time" },
  { file: "scripts/test-chart-audit-pipeline.ts", clockReads: 5, elapsedComparisons: 0, class: 4,
    note: "renderedAt fixture timestamps, and a 60 s liveness deadline while polling for a spawned child's claim row (the child's own exit is detected and reported separately); a bound on waiting for an external process, not a speed assertion -- the same kind as the runner's per-command timeout" },
  { file: "scripts/test-chart-audit.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "renderedAt fixture timestamp" },
  { file: "scripts/test-clarification-repairs.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "`start: Date.now()` is a fixture field handed to the route helper under test; nothing compares elapsed time" },
  { file: "scripts/test-corpus-acquisition.js", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "builtAt fixture timestamp" },
  { file: "scripts/test-corpus-reachability.js", clockReads: 2, elapsedComparisons: 0, class: 4,
    note: "created_at fixture timestamps and a snapshot dated 30 hours in the past to prove staleness refusal; the offset is fixed, so the verdict does not depend on how long the test took" },
  { file: "scripts/test-delivered-answer.ts", clockReads: 11, elapsedComparisons: 2, class: 4,
    note: "the two counted comparisons (`< startDelayMs`, `< deadlineMs`) are the busy-wait and retry-loop bounds inside a generated writer CHILD script, and `Date.now() < deadline` is a 12 s liveness bound on waiting for that child's report; the paired-read duration is printed only. NOT SEEN BY THE SCANNER, and disclosed: F2's `report.firstAt > startedAt && report.firstAt < finishedAt` orders timestamps across two processes to prove the contention was actually arranged, so it depends on scheduling (accepted candidate test; flagged in the integration report, not changed here)" },
  { file: "scripts/test-embed-proof.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "fixture row timestamp" },
  { file: "scripts/test-historical-baltimore-default.ts", clockReads: 2, elapsedComparisons: 0, class: 4,
    note: "`new Date().getFullYear()` derives the expected default ten-year window from the current year; no duration is measured or compared" },
  { file: "scripts/test-historical-clearance-route.ts", clockReads: 2, elapsedComparisons: 1, class: 4,
    note: "a page token stamped 5 s in the past (the token must be at least 1 s old and under an hour old, a window the test's own duration cannot leave), and the fixture-directory sweep's `mtimeMs > cutoff` filter, as in test-analytics-handler-boundary" },
  { file: "scripts/test-over-refusal-batch1-route.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "a page token stamped 5 s in the past, as in test-shr-guidance-isolation-route; no duration is measured or compared" },
  { file: "scripts/test-shr-guidance-isolation-route.ts", clockReads: 2, elapsedComparisons: 0, class: 4,
    note: "a page token stamped 5 s in the past, as in test-historical-clearance-route, and a session id stamped with the time; no duration is measured or compared" },
  { file: "scripts/test-nibrs-deterministic-queries.ts", clockReads: 3, elapsedComparisons: 0, class: 2,
    note: "current calendar year for year-window expectations (a calendar read, not elapsed time), and the elapsed time of 500 plan compilations printed for information; the gate is now determinism of the compiled plan (repaired 2026-09-03)" },
  { file: "scripts/test-nibrs-rollup-freshness.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "file mtimes set to fixed offsets around one instant; the freshness verdict compares those mtimes, not elapsed time" },
  { file: "scripts/test-operation-taxonomy.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "a page token stamped 5 s in the past, as in test-historical-clearance-route" },
  { file: "scripts/test-outcome-mutations.js", clockReads: 4, elapsedComparisons: 0, class: 4,
    note: "route source text quoted inside mutation find/replace strings; nothing here runs" },
  { file: "scripts/test-owned-demographic-comparison.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "`new Date().getFullYear()` for the current-year fixture; no duration is measured or compared" },
  { file: "scripts/test-p3-1a-smoke-live-path.ts", clockReads: 0, elapsedComparisons: 0, class: 3,
    note: "S2 freezes the spawned runner's clock through scripts/fixtures/frozen-clock.cjs so the collision filename is exact (repaired 2026-09-03: previously seeded 'now plus 7 s' and raced the child's start-up); listed at zero reads so the entry documents the fake clock and fails if a clock read returns" },
  { file: "scripts/test-proof-finalize.ts", clockReads: 0, elapsedComparisons: 0, class: 3,
    note: "budget and circuit-breaker checks drive lib/proof-finalize through __setProofClockForTests with a stepping clock (repaired 2026-09-03); the 5,000-row elapsed time is printed, not compared; 'off must not even measure elapsed time' is an equality with 0, a structural claim" },
  { file: "scripts/test-query-contract.ts", clockReads: 4, elapsedComparisons: 0, class: 4,
    note: "current calendar year for year-window expectations; a calendar read, not elapsed time" },
  { file: "scripts/test-rtci-freshness.js", clockReads: 3, elapsedComparisons: 0, class: 4,
    note: "checked_at_utc fixture timestamps; the two timeout checks prove the mailer aborts and rejects (repaired 2026-09-03: their redundant 'under 5 s' wall-clock assertions were removed)" },
  { file: "scripts/test-shadow-route-equivalence.ts", clockReads: 1, elapsedComparisons: 0, class: 4,
    note: "a page token stamped 5 s in the past" },
  { file: "scripts/test-shr-post-import-runtime.ts", clockReads: 4, elapsedComparisons: 2, class: 4,
    note: "the two counted comparisons check a RECORDED timeout bound against its budget (`timeoutMs <= 7000/8000`); the runtime sets timeoutMs = min(step limit, time remaining), so they hold on any machine speed. The stall witness's elapsed time is printed only (the former `elapsed < budget + slack` gates were replaced on integration by the structural proofs already present: ETIMEDOUT, the recorded bound, the killed pid, the refused next dispatch). The other reads are a busy-wait inside a fake step script and fixture timestamps. Safe SHR refresh (2026-10-02): the importer's own stall witness and its two clock reads were removed with the old section 2; the new refresh tests use injected deadlines, no wall clock" },
  { file: "scripts/test-text-sanitize.ts", clockReads: 2, elapsedComparisons: 0, class: 2,
    note: "each sanitizer call's elapsed time is printed for information (repaired 2026-09-03: the 5 s and 100 ms pass/fail bounds were removed); the output assertions remain the gate and a genuine hang fails via the runner's per-command timeout" },
  // ── shared helpers under scripts/lib ─────────────────────────────────────────────────────────
  { file: "scripts/lib/corpus-snapshot.js", clockReads: 2, elapsedComparisons: 1, class: 4,
    note: "corpus snapshot policy, not a test: `created_at_utc` defaults to now, and `ageMs > MAX_SNAPSHOT_AGE_MS` refuses a stale snapshot; `now` is injectable and the age is a calendar property of the artifact, not the speed of a run" },
  { file: "scripts/lib/rtci-freshness-policy.js", clockReads: 2, elapsedComparisons: 2, class: 3,
    note: "freshness policy, not a test: `nowIso` and `now = Date.now()` are default parameters and `lastSuccessAgeMs > STALE_AFTER_MS` classifies an age the caller supplies; every test passes fixed instants and ages" },
];

function extensionOf(file) {
  return path.extname(file).slice(1).toLowerCase();
}

function scan(file) {
  const source = fs.readFileSync(path.join(REPO, file), "utf8");
  const patterns = CLOCK_READS[extensionOf(file)];
  assert.ok(patterns, `no clock-read patterns for ${file}; add the extension to CLOCK_READS`);
  let clockReads = 0;
  for (const pattern of patterns) clockReads += (source.match(pattern) || []).length;
  const elapsedComparisons = extensionOf(file) in { js: 1, ts: 1, cjs: 1, mjs: 1 }
    ? (source.match(ELAPSED_COMPARISON) || []).length
    : 0;
  return { clockReads, elapsedComparisons };
}

let passed = 0;
function check(name, body) {
  body();
  passed++;
  console.log(`  ok  ${name}`);
}

/** This file: its pattern definitions and doc comment would count as hits, so it scans everything but itself. */
const SELF = "scripts/test-timing-gate-inventory.js";

const pkg = require(path.join(REPO, "package.json"));
const plan = planHarness(pkg.scripts, ENTRY_POINTS);
const planFiles = [...new Set(plan.commands.map((c) => c.script).filter(Boolean))].sort();
const helperFiles = fs.readdirSync(path.join(REPO, "scripts", "lib"))
  .filter((name) => /\.(js|cjs|mjs|ts)$/.test(name))
  .map((name) => `scripts/lib/${name}`)
  .sort();
const scanned = [...planFiles, ...helperFiles].filter((file) => file !== SELF);

check("the plan is derived, not listed: every command names a script file this test can read", () => {
  assert.equal(plan.missing.length, 0, `missing entry points: ${plan.missing.join(", ")}`);
  assert.equal(plan.commands.filter((c) => !c.script).length, 0, "every atomic command must name a script");
  assert.ok(planFiles.includes(SELF), `${SELF} must itself be a canonical-harness command, or nothing enforces this inventory`);
  for (const file of scanned) assert.ok(fs.existsSync(path.join(REPO, file)), `${file} does not exist`);
  console.log(`      ${plan.commands.length} atomic commands -> ${planFiles.length} scripts, plus ${helperFiles.length} scripts/lib helpers`);
});

check("the patterns recognise the gate that fired and its siblings", () => {
  // The exact assertion from run 33801327126 (test-nibrs-place-resolver.ts:239 at 28e5ba5).
  const fired = 'const started = performance.now();\n' +
    'assert.ok(performance.now() - started < 100, "500 cached resolutions should complete under 100ms");';
  assert.equal((fired.match(CLOCK_READS.ts[0]) || []).length, 2);
  const budget = "assert.ok(finalization.elapsedMs <= PROOF_BUDGET_MS, `took ${finalization.elapsedMs}ms`);";
  assert.equal((budget.match(ELAPSED_COMPARISON) || []).length, 1, "a budget comparison is an elapsed comparison");
  const took = "assert.ok(elapsed < 200, `attribution took ${elapsed}ms`);";
  assert.equal((took.match(ELAPSED_COMPARISON) || []).length, 1);
  const mini = "if (elapsed > maxMs) { problems.push(name); }";
  assert.equal((mini.match(ELAPSED_COMPARISON) || []).length, 1, "a hand-rolled harness's comparison counts too");
  const structural = 'assert.strictEqual(finalization.elapsedMs, 0, "off must not even measure elapsed time");';
  assert.equal((structural.match(ELAPSED_COMPARISON) || []).length, 0, "an equality is not an ordering comparison");
  const dated = "new Date(now + i * 1000)";
  assert.equal((dated.match(CLOCK_READS.ts[4]) || []).length, 0, "a Date built from a value is not a clock read");
});

const observed = new Map();
for (const file of scanned) {
  const counts = scan(file);
  if (counts.clockReads > 0 || counts.elapsedComparisons > 0) observed.set(file, counts);
}
const inventoried = new Map(INVENTORY.map((entry) => [entry.file, entry]));

check("every clock read and elapsed comparison in the harness is inventoried, with exact counts", () => {
  const problems = [];
  for (const [file, counts] of observed) {
    const entry = inventoried.get(file);
    if (!entry) {
      problems.push(`${file}: ${counts.clockReads} clock read(s), ${counts.elapsedComparisons} elapsed comparison(s) -- not inventoried`);
      continue;
    }
    if (entry.clockReads !== counts.clockReads || entry.elapsedComparisons !== counts.elapsedComparisons) {
      problems.push(`${file}: inventory says ${entry.clockReads}/${entry.elapsedComparisons}, source has ${counts.clockReads}/${counts.elapsedComparisons} (clock reads/elapsed comparisons)`);
    }
  }
  assert.deepEqual(problems, [], "classify each change in the INVENTORY above before it can land:\n  " + problems.join("\n  "));
});

check("no inventory entry is stale: each names a scanned file and its counts", () => {
  const problems = [];
  for (const entry of INVENTORY) {
    if (!scanned.includes(entry.file)) {
      problems.push(`${entry.file}: not in the harness plan or scripts/lib`);
      continue;
    }
    const counts = observed.get(entry.file) || { clockReads: 0, elapsedComparisons: 0 };
    if (counts.clockReads === 0 && counts.elapsedComparisons === 0 && entry.class !== 3) {
      problems.push(`${entry.file}: no clock reads or elapsed comparisons remain; remove the entry (class-3 entries may stay at zero to document a fake clock)`);
    }
  }
  assert.deepEqual(problems, []);
});

check("every entry carries a class of 2, 3 or 4 and a note; class 1 is not permitted", () => {
  for (const entry of INVENTORY) {
    assert.ok([2, 3, 4].includes(entry.class), `${entry.file}: class ${entry.class} -- a wall-clock correctness gate (class 1) must be repaired, not inventoried`);
    assert.ok(typeof entry.note === "string" && entry.note.length >= 20, `${entry.file}: a classification needs a reason`);
  }
});

check("a non-gating observation (class 2) never compares the duration it measures", () => {
  const offenders = INVENTORY.filter((entry) => entry.class === 2 && entry.elapsedComparisons > 0).map((entry) => entry.file);
  assert.deepEqual(offenders, [], "a class-2 entry that compares a duration is a gate, not an observation");
});

check("the five gates the residual record named, and the one that fired, are no longer gates", () => {
  // 2026-08-26-timing-gate-residual.md listed these; each is now class 2 or 3 above and has zero
  // elapsed comparisons, so a regression to `elapsed < budget` in any of them changes a count.
  for (const file of [
    "scripts/test-nibrs-place-resolver.ts",
    "scripts/test-nibrs-deterministic-queries.ts",
    "scripts/test-omission-attribution.ts",
    "scripts/test-proof-finalize.ts",
    "scripts/test-text-sanitize.ts",
  ]) {
    const counts = observed.get(file) || { clockReads: 0, elapsedComparisons: 0 };
    assert.equal(counts.elapsedComparisons, 0, `${file} compares a duration again`);
    const entry = inventoried.get(file);
    if (entry) assert.notEqual(entry.class, 1);
  }
});

const comparing = [...observed.values()].filter((c) => c.elapsedComparisons > 0).length;
console.log(`timing-gate inventory: ${passed} passed; ${observed.size} file(s) read a clock, ${comparing} compare a duration, all classified, none class 1`);
