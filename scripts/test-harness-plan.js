/**
 * Tests for the harness plan: the recursive expansion that turns package.json's `&&` chains into the
 * atomic command list every P1.1 tally is measured against.
 *
 * The property that matters: a nested `npm run` is NOT one command. Getting that wrong is what made
 * the first P1.1 contract under-report the harness by nine executions.
 */
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { planHarness, scriptPathOf, ENTRY_POINTS } = require("./lib/harness-plan");

let passed = 0;
function check(name, body) {
  body();
  passed++;
  console.log(`  ok  ${name}`);
}

check("a flat chain counts every command", () => {
  const plan = planHarness({ test: "a && b && c" }, ["test"]);
  assert.equal(plan.commands.length, 3);
  assert.equal(plan.topLevel, 3);
  assert.deepEqual(plan.commands.map((c) => c.command), ["a", "b", "c"]);
});

check("a nested local npm run expands to its own commands, not one", () => {
  // THE DEFECT THIS PREVENTS. Counting `npm run inner` as one step hides two executions.
  const plan = planHarness({ outer: "a && npm run inner && z", inner: "p && q" }, ["outer"]);
  assert.deepEqual(plan.commands.map((c) => c.command), ["a", "p", "q", "z"]);
  assert.equal(plan.commands.length, 4, "atomic count");
  assert.equal(plan.topLevel, 3, "top-level entries stay 3");
});

check("nesting is expanded to arbitrary depth", () => {
  const plan = planHarness({ a: "npm run b", b: "npm run c", c: "x && y" }, ["a"]);
  assert.deepEqual(plan.commands.map((c) => c.command), ["x", "y"]);
});

check("a cycle is reported and does not hang", () => {
  const plan = planHarness({ a: "npm run b", b: "npm run a" }, ["a"]);
  assert.equal(plan.cycles.length, 1);
  assert.match(plan.cycles[0], /a -> b -> a/);
});

check("a reference to a script that does not exist is reported, not silently dropped", () => {
  const plan = planHarness({ a: "npm run nope" }, ["a"]);
  // `npm run nope` is not a local script, so it stays a leaf command rather than vanishing.
  assert.equal(plan.commands.length, 1);
  assert.equal(plan.commands[0].command, "npm run nope");
});

check("a non-local npm command is a leaf", () => {
  const plan = planHarness({ a: "npm ci && npm run inner", inner: "x" }, ["a"]);
  assert.deepEqual(plan.commands.map((c) => c.command), ["npm ci", "x"]);
});

check("each command records the script chain it came from", () => {
  const plan = planHarness({ outer: "npm run inner", inner: "x" }, ["outer"]);
  assert.equal(plan.commands[0].via, "outer -> inner");
  assert.equal(plan.commands[0].entry, "outer");
});

check("multiple entry points are ordered and both counted", () => {
  const plan = planHarness({ pretest: "a", test: "b && c" }, ["pretest", "test"]);
  assert.deepEqual(plan.commands.map((c) => c.command), ["a", "b", "c"]);
  assert.equal(plan.topLevel, 3);
});

check("the script path is extracted so a command can be joined to the manifest", () => {
  assert.equal(scriptPathOf("tsx scripts/test-foo.ts"), "scripts/test-foo.ts");
  assert.equal(scriptPathOf("python scripts/audit.py"), "scripts/audit.py");
  assert.equal(
    scriptPathOf("powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-a.ps1"),
    "scripts/test-a.ps1",
  );
  assert.equal(scriptPathOf("npm ci"), null);
});

check("a windows backslash path is normalised", () => {
  assert.equal(scriptPathOf("node scripts\\lib\\thing.js"), "scripts/lib/thing.js");
});

check("the real package.json expands to more commands than it has entries", () => {
  // Not a fixed number: adding a test must change it. The invariant is that expansion finds MORE
  // than the entry count, because at least one nested script exists.
  //
  // ENTRY_POINTS is imported rather than written out. Hardcoding `["pretest", "test"]` here is
  // precisely what broke when `npm test` became the runner and the lists moved to non-lifecycle
  // names: both real-package checks silently planned a single command and the `atomic > top-level`
  // assertion inverted. One carrier for the entry-point names, consulted everywhere.
  const pkg = require(path.join(__dirname, "..", "package.json"));
  const plan = planHarness(pkg.scripts, ENTRY_POINTS);
  assert.deepEqual(plan.missing, [],
    `every declared entry point must exist in package.json; missing: ${plan.missing.join(", ")}`);
  assert.equal(plan.cycles.length, 0, "the real harness must not contain a cycle");
  assert.ok(plan.commands.length > plan.topLevel,
    `expected atomic (${plan.commands.length}) > top-level (${plan.topLevel})`);
  const hidden = plan.commands.length - plan.topLevel;
  assert.ok(hidden >= 9, `expected at least the 9 known hidden executions, found ${hidden}`);
  console.log(`      real harness: ${plan.topLevel} entries -> ${plan.commands.length} atomic (${hidden} hidden)`);
});

check("every real command resolves a runner", () => {
  const pkg = require(path.join(__dirname, "..", "package.json"));
  const plan = planHarness(pkg.scripts, ENTRY_POINTS);
  for (const c of plan.commands) {
    assert.ok(c.runner && c.runner.length > 0, `no runner for: ${c.command}`);
  }
});

check("every powershell command is declared win32, and every win32 declaration is a powershell command", () => {
  // The canonical harness runs on Linux, where `powershell` (Windows PowerShell 5.1) does not exist.
  // A new .ps1 suite added without the declaration would fail there for the wrong reason; a win32
  // declaration on anything else would turn a runnable command into a skip. Both directions, derived.
  const pkg = require(path.join(__dirname, "..", "package.json"));
  const { loadManifest, reconcile } = require("./lib/tier-manifest");
  const plan = planHarness(pkg.scripts, ENTRY_POINTS);
  const { matched } = reconcile(loadManifest(), plan.commands);
  const powershell = matched.filter(({ command }) => command.runner === "powershell");
  assert.ok(powershell.length > 0, "no powershell command in the plan; this check would be vacuous");
  for (const { command, entry } of matched) {
    if (command.runner === "powershell") {
      assert.equal(entry.platform, "win32", `${entry.id} runs under powershell but is not declared win32`);
    } else {
      assert.equal(entry.platform, undefined, `${entry.id} is declared ${entry.platform} but runs under ${command.runner}`);
    }
  }
  console.log(`      ${powershell.length} powershell command(s), all declared win32`);
});

console.log(`harness plan tests: ${passed} passed`);
