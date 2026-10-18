/**
 * Decide whether this canonical-workflow run must execute the Windows PowerShell 5.1 suites.
 *
 * The canonical harness runs on Linux. The four `win32` suites and the powershell exit-code mutation run
 * on a Windows runner, which bills at twice the Linux rate, so they run when the change can affect them
 * -- and the workflow's gate job turns this decision into a required result that can only pass in two
 * ways: this detector succeeded and said "not needed", or the Windows job ran and passed.
 *
 * FAILS TOWARD RUNNING. Scheduled and manually dispatched runs are forced. Any diff that cannot be
 * established -- an unknown event, a push with no usable `before` commit, a pull-request checkout that
 * is not the two-parent merge commit -- is `needed`, never "not needed". An exception exits non-zero,
 * which the gate treats as a failure. Only a fully established diff with no path matching a trigger
 * (scripts/fixtures/windows-suite-triggers.json) yields `needed=false`.
 *
 * Usage (in the workflow): EVENT_NAME=<github.event_name> BEFORE_SHA=<github.event.before>
 *   node scripts/detect-windows-suites.js       -> writes needed= and reason= to $GITHUB_OUTPUT
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const TRIGGERS_PATH = path.join(REPO, "scripts", "fixtures", "windows-suite-triggers.json");

function loadTriggers(file) {
  const parsed = JSON.parse(fs.readFileSync(file || TRIGGERS_PATH, "utf8"));
  if (!parsed || !Array.isArray(parsed.patterns) || parsed.patterns.length === 0) {
    throw new Error("windows-suite-triggers.json must carry a non-empty `patterns` array");
  }
  for (const p of parsed.patterns) {
    if (typeof p !== "string" || !p || p.startsWith("/") || p.includes("\\")) {
      throw new Error(`invalid trigger pattern ${JSON.stringify(p)}: repo-relative POSIX paths only`);
    }
  }
  return parsed.patterns;
}

/** Glob to RegExp: `**\/` is any directory prefix (including none), `*` stays inside one segment. */
function patternToRegExp(pattern) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; continue; }
    const ch = pattern[i];
    if (ch === "*") re += "[^/]*";
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function matcher(patterns) {
  const res = patterns.map(patternToRegExp);
  return (file) => res.some((re) => re.test(file));
}

function defaultGit(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * The decision. `git` is injectable so scripts/test-windows-suite-gate.js can drive every branch.
 * Returns { needed: boolean, reason: string, matched: string[] }.
 */
function decide({ event, before, git, patterns }) {
  const run = git || defaultGit;
  const unknown = (why) => ({ needed: true, reason: `unknown diff, so the suites run: ${why}`, matched: [] });
  if (event === "schedule" || event === "workflow_dispatch") {
    return { needed: true, reason: `forced: ${event} runs always execute the suites`, matched: [] };
  }

  let range;
  if (event === "pull_request") {
    let parents;
    try {
      parents = run(["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
    } catch (error) {
      return unknown(`could not read HEAD's parents (${error.message.split("\n")[0]})`);
    }
    if (parents.length !== 3) {
      return unknown(`HEAD has ${parents.length - 1} parent(s); a pull-request run checks out the two-parent merge commit`);
    }
    range = [parents[1], parents[0]];
  } else if (event === "push") {
    if (!/^[0-9a-f]{40}$/.test(before || "") || /^0+$/.test(before)) {
      return unknown(`push has no usable before commit (${JSON.stringify(before || "")})`);
    }
    try {
      run(["cat-file", "-e", `${before}^{commit}`]);
    } catch {
      return unknown(`the before commit ${before} is not in this checkout`);
    }
    range = [before, "HEAD"];
  } else {
    return unknown(`event ${JSON.stringify(event || "")} has no defined diff`);
  }

  let files;
  try {
    files = run(["diff", "--name-only", "-z", "--no-renames", range[0], range[1]]).split("\0").filter(Boolean);
  } catch (error) {
    return unknown(`git diff failed (${error.message.split("\n")[0]})`);
  }
  const matches = matcher(patterns);
  const matched = files.filter(matches);
  if (matched.length) {
    return { needed: true, matched,
      reason: `${matched.length} changed path(s) match a trigger: ${matched.slice(0, 5).join(", ")}` +
        (matched.length > 5 ? ", ..." : "") };
  }
  return { needed: false, matched,
    reason: `established diff of ${files.length} path(s) (${range[0].slice(0, 12)}..${range[1] === "HEAD" ? "HEAD" : range[1].slice(0, 12)}); none matches a trigger` };
}

function main() {
  const decision = decide({ event: process.env.EVENT_NAME, before: process.env.BEFORE_SHA,
    patterns: loadTriggers() });
  const reason = decision.reason.replace(/[\r\n]+/g, " ");
  console.log(`windows suites needed: ${decision.needed}`);
  console.log(`reason: ${reason}`);
  for (const f of decision.matched) console.log(`  trigger: ${f}`);
  const out = process.env.GITHUB_OUTPUT;
  if (!out) throw new Error("GITHUB_OUTPUT is not set; the decision would be lost");
  fs.appendFileSync(out, `needed=${decision.needed}\nreason=${reason}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`detection failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { TRIGGERS_PATH, loadTriggers, patternToRegExp, matcher, decide };
