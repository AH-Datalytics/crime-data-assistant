/**
 * The canonical workflow's Windows gate: the structure that keeps the four Windows PowerShell 5.1 suites
 * required now that the canonical harness runs on Linux.
 *
 * WHAT IS PROVED HERE, OFFLINE, ON EVERY HARNESS RUN.
 *
 *   1. The triggers cover what the suites test. Every file a `win32` suite loads or reads through
 *      `$PSScriptRoot` (followed transitively), every local module the Windows job's three node scripts
 *      load, and the files that declare or derive the Windows command set all match a trigger. A
 *      dependency added without a trigger fails here instead of letting a change skip Windows.
 *   2. The detector fails toward running: forced on schedule and dispatch, `needed` on any diff it
 *      cannot establish, `not needed` only on an established diff with no trigger match.
 *   3. The workflow wires it fail-closed: the gate job always runs, needs both jobs, and passes only on
 *      detection success plus "not needed" with the Windows job skipped, or "needed" with it passing;
 *      the Windows job runs the derived win32 commands and the powershell mutation; nothing may
 *      continue on error.
 *
 * WHAT IS NOT PROVED. That GitHub evaluates the workflow as written -- that is what its first runs
 * show. Tier F: reads tracked files and runs no command; git is injected into the detector.
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { loadTriggers, matcher, decide } = require("./detect-windows-suites.js");
const { loadManifest } = require("./lib/tier-manifest.js");

const REPO = path.join(__dirname, "..");
const WORKFLOW = ".github/workflows/canonical-harness.yml";

let passed = 0;
const failures = [];
function check(name, body) {
  try {
    body();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error.message.split("\n").join("\n        ")}`);
  }
}

// Line endings are normalised: the harness must give the same answer in an LF or a CRLF checkout.
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8").replace(/\r\n/g, "\n");
const patterns = loadTriggers();
const matches = matcher(patterns);

/** Files a PowerShell script reaches through `Join-Path $PSScriptRoot "<name>"`, transitively. */
function powershellClosure(start) {
  const seen = new Set();
  const frontier = [start];
  while (frontier.length) {
    const rel = frontier.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    if (!rel.endsWith(".ps1")) continue;
    const dir = path.posix.dirname(rel);
    for (const m of read(rel).matchAll(/Join-Path \$PSScriptRoot "([^"]+)"/g)) {
      const target = path.posix.join(dir, m[1].replace(/\\/g, "/"));
      assert.ok(fs.existsSync(path.join(REPO, target)), `${rel} references ${target}, which does not exist`);
      frontier.push(target);
    }
  }
  return [...seen];
}

/** Local modules a node script loads through relative require(), transitively. */
function requireClosure(start) {
  const seen = new Set();
  const frontier = [start];
  while (frontier.length) {
    const rel = frontier.pop();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dir = path.posix.dirname(rel);
    for (const m of read(rel).matchAll(/require\("(\.{1,2}\/[^"]+)"\)/g)) {
      let target = path.posix.join(dir, m[1]);
      if (!target.endsWith(".js") && !target.endsWith(".json")) target += ".js";
      assert.ok(fs.existsSync(path.join(REPO, target)), `${rel} requires ${target}, which does not exist`);
      frontier.push(target);
    }
  }
  return [...seen];
}

// ------------------------------------------------------------------ 1. trigger coverage

check("the matcher folds directory depth for **/ and keeps * inside one segment", () => {
  assert.ok(matches("scripts/refresh-nibrs-rollups.ps1"));
  assert.ok(matches("deep/er/x.ps1"));
  assert.ok(matches("top.ps1"), "**/ must also match no directory at all");
  assert.ok(matches("scripts/lib/harness-plan.js"));
  assert.ok(!matches("scripts/lib/harness-plan.jsx"), "an exact path must not match a longer name");
  assert.ok(!matches("lib/claude.ts"));
  assert.ok(!matches("docs/superpowers/x.md"));
  assert.ok(!matches("scripts/x.ps1.bak"));
});

const win32 = loadManifest().entries.filter((e) => e.platform === "win32");

check("every file a win32 suite loads or reads matches a trigger", () => {
  assert.ok(win32.length >= 4, `expected the four Windows PowerShell suites, found ${win32.length}`);
  const reached = new Set();
  for (const entry of win32) for (const f of powershellClosure(entry.script)) reached.add(f);
  assert.ok(reached.has("scripts/refresh-nibrs-rollups.ps1"),
    "the closure misses refresh-nibrs-rollups.ps1, which the lifecycle suite reads; the walk is broken");
  const uncovered = [...reached].filter((f) => !matches(f));
  assert.deepEqual(uncovered, [], `not covered by a trigger: ${uncovered.join(", ")}`);
  console.log(`        ${reached.size} PowerShell file(s) reached from ${win32.length} suite(s), all covered`);
});

check("every module the Windows job's node scripts load, and their data files, match a trigger", () => {
  const roots = ["scripts/run-platform-suites.js", "scripts/test-harness-mutations.js",
    "scripts/detect-windows-suites.js"];
  const modules = new Set();
  for (const root of roots) for (const f of requireClosure(root)) modules.add(f);
  // Read by path constants, not require(): the plan source, the manifest and the registry it validates
  // against, the trigger list itself, and what fixes the checkout and the toolchain.
  const data = ["package.json", "package-lock.json", "scripts/fixtures/harness-tier-manifest.json",
    "scripts/fixtures/corpus-registry.json", "scripts/fixtures/windows-suite-triggers.json",
    ".gitattributes", WORKFLOW, "scripts/run-harness.js"];
  const uncovered = [...modules, ...data].filter((f) => !matches(f));
  assert.deepEqual(uncovered, [], `not covered by a trigger: ${uncovered.join(", ")}`);
});

// ------------------------------------------------------------------ 2. the detector's decisions

function fakeGit(responses) {
  return (args) => {
    const key = args.join(" ");
    for (const [prefix, out] of responses) {
      if (key.startsWith(prefix)) {
        if (out instanceof Error) throw out;
        return out;
      }
    }
    throw new Error(`unexpected git ${key}`);
  };
}
const BEFORE = "a".repeat(40);

check("scheduled and dispatched runs are forced, without consulting git", () => {
  for (const event of ["schedule", "workflow_dispatch"]) {
    const d = decide({ event, patterns, git: () => { throw new Error("git must not be consulted"); } });
    assert.equal(d.needed, true, event);
    assert.match(d.reason, /forced/);
  }
});

check("a diff that cannot be established runs the suites", () => {
  const cases = [
    { event: "push", before: "0".repeat(40), git: fakeGit([]) },
    { event: "push", before: "", git: fakeGit([]) },
    { event: "push", before: BEFORE, git: fakeGit([["cat-file", new Error("missing")]]) },
    { event: "push", before: BEFORE, git: fakeGit([["cat-file", ""], ["diff", new Error("bad")]]) },
    { event: "pull_request", git: fakeGit([["rev-list", "h p1\n"]]) },
    { event: "pull_request", git: fakeGit([["rev-list", new Error("no HEAD")]]) },
    { event: "merge_group", git: fakeGit([]) },
    { event: undefined, git: fakeGit([]) },
  ];
  for (const c of cases) {
    const d = decide({ ...c, patterns });
    assert.equal(d.needed, true, `${c.event} ${c.before || ""} must run the suites`);
    assert.match(d.reason, /unknown diff/);
  }
});

check("an established diff decides by the triggers, both ways", () => {
  const pr = (files) => decide({ event: "pull_request", patterns,
    git: fakeGit([["rev-list", "head p1 p2\n"], ["diff", files.map((f) => f + "\0").join("")]]) });
  const unrelated = pr(["lib/claude.ts", "docs/roadmap/current.md"]);
  assert.equal(unrelated.needed, false);
  assert.match(unrelated.reason, /none matches a trigger/);
  const touching = pr(["lib/claude.ts", "scripts/nibrs-refresh-logging.ps1"]);
  assert.equal(touching.needed, true);
  assert.deepEqual(touching.matched, ["scripts/nibrs-refresh-logging.ps1"]);

  const push = decide({ event: "push", before: BEFORE, patterns,
    git: fakeGit([["cat-file", ""], ["diff", "package-lock.json\0"]]) });
  assert.equal(push.needed, true, "a lockfile change must run the suites");
});

// ------------------------------------------------------------------ 3. the workflow's wiring

const workflow = read(WORKFLOW);

/** The text of one top-level job, from `  <id>:` to the next job or the end. */
function job(id) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `the workflow has no job ${id}`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[end])) end++;
  return lines.slice(start, end).join("\n");
}

check("nothing in the workflow may continue on error", () => {
  assert.doesNotMatch(workflow, /continue-on-error/);
});

check("the canonical job runs the whole harness on Linux", () => {
  const j = job("canonical-harness");
  assert.match(j, /name: canonical harness \(linux, LF\)/);
  assert.match(j, /runs-on: ubuntu-24\.04/);
  assert.match(j, /npm test -- --json harness-report\.json/);
  assert.match(j, /need_exactly_one "platform verdict"/, "the platform verdict is not required in the log");
});

check("the workflow runs weekly, so the Windows suites cannot go unexercised indefinitely", () => {
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: "[^"]+"/m);
});

check("detection runs the tracked detector with the event and the push's before commit", () => {
  const j = job("windows-detect");
  assert.match(j, /node scripts\/detect-windows-suites\.js/);
  assert.match(j, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(j, /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(j, /fetch-depth: 0/, "without history the diff cannot be established");
  assert.match(j, /needed: \$\{\{ steps\.detect\.outputs\.needed \}\}/);
});

check("the Windows job runs only on a successful 'needed' decision, and runs both certifications", () => {
  const j = job("windows-suites");
  assert.match(j, /needs: windows-detect/);
  assert.match(j, /if: needs\.windows-detect\.result == 'success' && needs\.windows-detect\.outputs\.needed == 'true'/);
  assert.match(j, /runs-on: windows-latest/);
  assert.match(j, /node scripts\/run-platform-suites\.js win32/);
  assert.match(j, /node scripts\/test-harness-mutations\.js --runner powershell/);
  assert.match(j, /node-version: 24\.14\.0/);
});

check("the gate always runs and passes only on the two allowed outcomes", () => {
  const j = job("windows-gate");
  assert.match(j, /name: canonical harness \(windows gate\)/);
  assert.match(j, /needs: \[windows-detect, windows-suites\]/);
  assert.match(j, /if: always\(\)/);
  // The four inputs the gate decides on, each bound to the right job's result or output.
  assert.match(j, /DETECT_RESULT: \$\{\{ needs\.windows-detect\.result \}\}/);
  assert.match(j, /NEEDED: \$\{\{ needs\.windows-detect\.outputs\.needed \}\}/);
  assert.match(j, /REASON: \$\{\{ needs\.windows-detect\.outputs\.reason \}\}/);
  assert.match(j, /SUITES_RESULT: \$\{\{ needs\.windows-suites\.result \}\}/);
  // Success is reaching the end of the script; no branch may short-circuit it.
  assert.doesNotMatch(j, /exit 0/);
});

/** The gate step's shell body exactly as the workflow holds it (the block under its `run: |`). */
function gateBody() {
  const lines = job("windows-gate").split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  assert.ok(at >= 0, "the gate has no `run: |` block");
  const indent = lines[at].match(/^(\s*)/)[1].length + 2;
  const body = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() && line.length - line.trimStart().length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

/** A POSIX bash: `bash` on Linux; Git Bash on Windows, where a bare `bash` may be the WSL launcher. */
function posixBash() {
  if (process.platform !== "win32") return "bash";
  const { execFileSync } = require("node:child_process");
  const found = execFileSync("where", ["git"], { encoding: "utf8" }).split(/\r?\n/).map((s) => s.trim())
    .filter(Boolean).flatMap((g) => [path.resolve(path.dirname(g), "..", "bin", "bash.exe"),
      path.resolve(path.dirname(g), "..", "..", "bin", "bash.exe")])
    .find((c) => fs.existsSync(c));
  assert.ok(found, "no Git Bash found; the gate's shell body cannot be executed here");
  return found;
}

check("the gate's real shell body passes exactly the two allowed outcomes and fails every other", () => {
  // Executed, not pattern-matched: deleting an `exit 1`, or binding a branch to the wrong value, flips
  // one of these rows. GitHub hands a missing output or a skipped job's result to the step as text.
  const { spawnSync } = require("node:child_process");
  const body = gateBody();
  const bash = posixBash();
  const rows = [
    // DETECT_RESULT, NEEDED, SUITES_RESULT, passes?
    ["success", "false", "skipped", true],
    ["success", "true", "success", true],
    ["failure", "", "skipped", false],
    // A detection job that wrote "not needed" and then failed or was cancelled is still a failed
    // detection: its decision must not be trusted.
    ["failure", "false", "skipped", false],
    ["cancelled", "false", "skipped", false],
    ["cancelled", "true", "skipped", false],
    ["skipped", "", "skipped", false],
    ["success", "", "skipped", false],
    ["success", "maybe", "success", false],
    ["success", "true", "skipped", false],
    ["success", "true", "failure", false],
    ["success", "true", "cancelled", false],
    ["success", "false", "success", false],
    ["success", "false", "failure", false],
  ];
  for (const [detect, needed, suites, passes] of rows) {
    const run = spawnSync(bash, ["-c", body], { encoding: "utf8",
      env: { ...process.env, DETECT_RESULT: detect, NEEDED: needed, REASON: "test", SUITES_RESULT: suites } });
    assert.ok(run.status !== null, `bash did not run: ${run.error && run.error.message}`);
    assert.equal(run.status === 0, passes,
      `detect=${detect} needed=${JSON.stringify(needed)} suites=${suites}: exit ${run.status}, expected ` +
      `${passes ? "pass" : "fail"}\n${(run.stdout || "") + (run.stderr || "")}`);
  }
  console.log(`        ${rows.length} outcome(s) executed: 2 pass, ${rows.length - 2} fail`);
});

console.log(`\nwindows suite gate: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exitCode = 1;
}
