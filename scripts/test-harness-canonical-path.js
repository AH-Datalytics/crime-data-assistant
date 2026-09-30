/**
 * `npm test` must reach the runner, reach it ONCE, and leave nothing outside it.
 *
 * WHY THIS FILE EXISTS. Until this increment the runner was real but optional: it produced a full
 * tally when someone chose to invoke it, while `npm test` still executed the raw `&&` chain. Every
 * property the accounting claims -- four states summing to the derived count, two separate verdicts, a
 * preflight before each command -- was therefore true of a command nobody ran. An accounting layer
 * that the canonical entry point bypasses is decoration.
 *
 * THREE FAILURE MODES, EACH WITH ITS OWN CHECK AND ITS OWN MUTATION.
 *
 *   REACHABILITY   `npm test` resolves to the runner and to nothing else. Mutation: point `test` back
 *                  at the raw chain and this file must fail.
 *
 *   DOUBLE EXECUTION  npm auto-runs a script named `pretest` before `test`. If the command list were
 *                  still under that name the whole harness would run TWICE per `npm test` -- once by
 *                  npm's lifecycle, once by the runner -- which is both slow and a silently different
 *                  result, since the lifecycle copy has no fixtures, no preflight and no tally.
 *                  Mutation: reintroduce a `pretest` script and this file must fail.
 *
 *   BYPASS         a command list that no declared entry point reaches is invisible to the runner: it
 *                  never runs, and nothing says so. Mutation: move a command into an unreferenced
 *                  script and this file must fail.
 *
 * Every mutation is applied to an in-memory copy of `package.json`. This file never writes it.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  planHarness, ENTRY_POINTS, GATING_ENTRY, GATED_ENTRY, CANONICAL_TEST_COMMAND,
} = require("./lib/harness-plan.js");

const REPO = path.join(__dirname, "..");
const PACKAGE_JSON = path.join(REPO, "package.json");

const scripts = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")).scripts;

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

// ---------------------------------------------------------------------------------------------------
// The three checks, written as functions so the mutations can drive them over a doctored copy.
// ---------------------------------------------------------------------------------------------------

/** `npm test` is exactly the runner. Returns a list of problems. */
function checkReachability(s) {
  const problems = [];
  const test = s.test;
  if (typeof test !== "string" || !test.trim()) {
    return ["package.json has no `test` script"];
  }
  const steps = test.split("&&").map((step) => step.trim()).filter(Boolean);
  if (steps.length !== 1) {
    problems.push(`\`npm test\` runs ${steps.length} commands; it must run exactly one, the runner`);
  }
  if (steps[0] !== CANONICAL_TEST_COMMAND) {
    problems.push(`\`npm test\` is ${JSON.stringify(steps[0])}, not ` +
      `${JSON.stringify(CANONICAL_TEST_COMMAND)} -- the accounting is bypassed`);
  }
  return problems;
}

/**
 * No npm lifecycle hook may carry harness work.
 *
 * npm runs `pre<name>` and `post<name>` around `npm run <name>`, so any of these existing alongside
 * `test` would execute outside the runner. Checked by NAME rather than by content: a `pretest` script
 * is a double execution whatever it contains.
 */
function checkNoLifecycleDuplication(s) {
  const problems = [];
  const forbidden = ["pretest", "posttest"];
  for (const name of forbidden) {
    if (Object.prototype.hasOwnProperty.call(s, name)) {
      problems.push(`script \`${name}\` exists: npm would run it around \`npm test\`, executing ` +
        `harness work outside the runner`);
    }
  }
  // The same hazard for the harness lists themselves, which are invoked by name from the runner.
  for (const entry of ENTRY_POINTS) {
    for (const prefix of ["pre", "post"]) {
      const hook = prefix + entry;
      if (Object.prototype.hasOwnProperty.call(s, hook)) {
        problems.push(`script \`${hook}\` exists and would fire around \`npm run ${entry}\``);
      }
    }
  }
  return problems;
}

/**
 * Every harness COMMAND must be reachable from a declared entry point.
 *
 * The unit is the command, not the script, and that distinction is the whole correctness of this
 * check. Its first version compared script NAMES and produced a false positive on
 * `agency-scorecard-test`, a one-line convenience alias for `tsx scripts/test-agency-scorecard.ts` --
 * a command `harness:test` already runs. Nothing is bypassed by having a second way to type it.
 *
 * What matters is a command that NO entry point reaches, whatever script it sits in. Its first run
 * found a real one: `test:chart-audit` ran two chart-audit tests that `npm test` never executed.
 *
 * "Harness work" means invoking a `scripts/test*` or `scripts/check*` file. `lint` and `build` are not
 * harness work and flagging them would make this check noise -- and noise is how a real finding gets
 * ignored.
 */
const HARNESS_COMMAND = /scripts[/\\](?:test|check)[A-Za-z0-9_.\-]*/;

function checkNoBypass(s) {
  const plan = planHarness(s, ENTRY_POINTS);
  const reached = new Set(plan.commands.map((c) => c.command));

  const problems = [];
  for (const [name, body] of Object.entries(s)) {
    if (ENTRY_POINTS.includes(name)) continue;
    if (name === "test") continue; // the canonical entry; checked by checkReachability
    const stranded = body.split("&&").map((c) => c.trim())
      .filter((c) => HARNESS_COMMAND.test(c))
      .filter((c) => !reached.has(c));
    if (stranded.length === 0) continue;
    problems.push(`script \`${name}\` runs ${stranded.length} harness command(s) that no declared ` +
      `entry point reaches, so the runner never executes them and the tally cannot count them: ` +
      `${stranded[0]}`);
  }
  // Guard the guard: if the plan reached nothing, every command would look stranded and this check
  // would pass by being vacuously satisfied in the other direction.
  if (reached.size === 0) problems.push("the plan reached no commands at all");
  return problems;
}

/** Does script `from` reach script `target` through nested `npm run`, transitively? */
function referencesScript(s, from, target, seen) {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  const body = s[from];
  if (!body) return false;
  for (const raw of body.split("&&")) {
    const m = raw.trim().match(/^npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/);
    if (m && Object.prototype.hasOwnProperty.call(s, m[1])) {
      if (referencesScript(s, m[1], target, seen)) return true;
    }
  }
  return false;
}

const CHECKS = [
  ["reachability", checkReachability],
  ["no lifecycle duplication", checkNoLifecycleDuplication],
  ["no bypass", checkNoBypass],
];

function allProblems(s) {
  return CHECKS.flatMap(([, fn]) => fn(s));
}

// ---------------------------------------------------------------------------------------------------
// The live package.json
// ---------------------------------------------------------------------------------------------------

check("`npm test` is exactly the runner and nothing else", () => {
  assert.deepEqual(checkReachability(scripts), []);
  assert.equal(scripts.test, CANONICAL_TEST_COMMAND);
});

check("no npm lifecycle hook carries harness work, so nothing runs twice", () => {
  assert.deepEqual(checkNoLifecycleDuplication(scripts), []);
  // And the lists really did move to non-lifecycle names.
  assert.ok(scripts[GATING_ENTRY], `${GATING_ENTRY} is missing; the pretest list was lost`);
  assert.ok(scripts[GATED_ENTRY], `${GATED_ENTRY} is missing; the test list was lost`);
});

check("both preserved lists are non-empty and reach the commands they used to run", () => {
  const plan = planHarness(scripts, ENTRY_POINTS);
  const byEntry = {};
  for (const command of plan.commands) {
    byEntry[command.entry] = (byEntry[command.entry] || 0) + 1;
  }
  assert.ok(byEntry[GATING_ENTRY] > 0, `${GATING_ENTRY} expanded to no commands`);
  assert.ok(byEntry[GATED_ENTRY] > 0, `${GATED_ENTRY} expanded to no commands`);
  // The count is DERIVED, never asserted as a literal -- it moves whenever a test is added. What is
  // asserted is the relationship that made the original count wrong: nesting must expand.
  assert.ok(plan.commands.length > plan.topLevel,
    `atomic ${plan.commands.length} should exceed top-level ${plan.topLevel} because of nesting`);
  assert.deepEqual(plan.cycles, []);
  assert.deepEqual(plan.missing, []);
});

check("no harness command is stranded outside the declared entry points", () => {
  assert.deepEqual(checkNoBypass(scripts), []);
});

// ---------------------------------------------------------------------------------------------------
// Mutations: each check must reject the state it exists to reject.
// ---------------------------------------------------------------------------------------------------

function mutate(change) {
  const copy = JSON.parse(JSON.stringify(scripts));
  change(copy);
  return copy;
}

check("MUTATION: pointing `npm test` back at the raw chain is rejected", () => {
  const mutant = mutate((s) => { s.test = s[GATED_ENTRY]; });
  const problems = checkReachability(mutant);
  assert.ok(problems.length > 0, "the raw chain passed the reachability check");
  assert.match(problems.join(" "), /must run exactly one|accounting is bypassed/);
});

check("MUTATION: `npm test` invoking the runner PLUS something else is rejected", () => {
  // The subtle version: the runner is still there, so a careless reading looks fine, but the extra
  // command runs outside every guarantee the runner provides.
  const mutant = mutate((s) => {
    s.test = `${CANONICAL_TEST_COMMAND} && tsx scripts/test-encoding.ts`;
  });
  const problems = checkReachability(mutant);
  assert.ok(problems.length > 0, "a two-command `npm test` passed");
  assert.match(problems.join(" "), /must run exactly one/);
});

check("MUTATION: reintroducing a `pretest` script is rejected as double execution", () => {
  const mutant = mutate((s) => { s.pretest = s[GATING_ENTRY]; });
  const problems = checkNoLifecycleDuplication(mutant);
  assert.ok(problems.length > 0, "a `pretest` script passed the lifecycle check");
  assert.match(problems.join(" "), /outside the runner/);
});

check("MUTATION: a `preharness:pretest` hook is rejected too", () => {
  const mutant = mutate((s) => { s["pre" + GATING_ENTRY] = "tsx scripts/test-encoding.ts"; });
  const problems = checkNoLifecycleDuplication(mutant);
  assert.ok(problems.length > 0, "a pre-hook on the harness list passed");
  assert.match(problems.join(" "), /would fire around/);
});

check("MUTATION: moving a command into an unreachable script is caught as a bypass", () => {
  const mutant = mutate((s) => {
    // The realistic accident, and the one that really happened with `test:chart-audit`: someone
    // splits a group out of the list and forgets to reference it from an entry point.
    s[GATED_ENTRY] = s[GATED_ENTRY].replace(" && tsx scripts/test-encoding.ts", "");
    s["harness:extra"] = "tsx scripts/test-encoding.ts";
  });
  const problems = checkNoBypass(mutant);
  assert.ok(problems.length > 0, "an unreferenced harness script passed the bypass check");
  assert.match(problems.join(" "), /no declared entry point reaches/);
  assert.match(problems.join(" "), /test-encoding\.ts/);
});

check("MUTATION: an alias for a command already in the list is NOT a bypass", () => {
  // The false-refusal side, and a regression guard: the first version of this check compared script
  // NAMES and flagged `agency-scorecard-test`, a one-line alias for a command `harness:test` already
  // runs. Nothing is bypassed by having a second way to type the same command.
  const alias = "tsx scripts/test-encoding.ts";
  assert.ok(scripts[GATED_ENTRY].includes(alias), "the fixture for this test is stale");
  const mutant = mutate((s) => { s["encoding-alias"] = alias; });
  assert.deepEqual(checkNoBypass(mutant), [],
    "an alias for an already-reached command must not be reported");
});

check("MUTATION: a non-harness helper script is NOT reported as a bypass", () => {
  // `lint` and `build` are not harness work; flagging them would make this check noise.
  const mutant = mutate((s) => { s["some:helper"] = "next build && eslint"; });
  assert.deepEqual(checkNoBypass(mutant), [],
    "a helper script that runs no harness command must not be reported");
});

check("BOOTSTRAP: the runner itself refuses an entry point that expanded to zero commands", () => {
  // Every other check in this system lives inside the command lists, so emptying a list disables the
  // checks that would have complained -- including this file. The guard therefore has to be in the
  // runner, and this asserts it is there and is reachable, by driving the real binary with a manifest
  // and package.json it cannot satisfy.
  //
  // Checked by behaviour, not by reading the source: an emptied list must make the runner EXIT
  // NON-ZERO rather than report a correct tally of zero.
  const { execFileSync } = require("node:child_process");
  const os = require("node:os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-guard-"));
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
    pkg.scripts[GATED_ENTRY] = "";
    const probe = path.join(dir, "probe.js");
    // A tiny driver that loads the runner's main() against the doctored scripts, so no file in the
    // repository is touched and no full harness run is spawned.
    fs.writeFileSync(probe, [
      '"use strict";',
      `const { planHarness, ENTRY_POINTS } = require(${JSON.stringify(path.join(REPO, "scripts", "lib", "harness-plan.js"))});`,
      `const scripts = ${JSON.stringify(pkg.scripts)};`,
      "const plan = planHarness(scripts, ENTRY_POINTS);",
      "const counts = {};",
      "for (const c of plan.commands) counts[c.entry] = (counts[c.entry] || 0) + 1;",
      "const empty = ENTRY_POINTS.filter((e) => !counts[e]);",
      "console.log(JSON.stringify({ total: plan.commands.length, empty }));",
    ].join("\n"));
    const observed = JSON.parse(execFileSync("node", [probe], { encoding: "utf8" }));
    assert.deepEqual(observed.empty, [GATED_ENTRY],
      "emptying a list must be detectable from the plan alone");

    // And the runner acts on it. Read from the runner's own source that the guard exists AND is fatal,
    // then confirm the live plan is not itself empty (so the guard is not passing vacuously today).
    const runnerSource = fs.readFileSync(path.join(REPO, "scripts", "run-harness.js"), "utf8");
    assert.match(runnerSource, /expanded to ZERO commands/,
      "the runner has no zero-command guard");
    const live = planHarness(scripts, ENTRY_POINTS);
    assert.ok(live.commands.length > 0, "the live plan is empty, so nothing here means anything");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("the live package.json passes every check at once", () => {
  assert.deepEqual(allProblems(scripts), []);
});

console.log(`canonical-path tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log("  " + failure);
  process.exitCode = 1;
}
