/**
 * Run the canonical harness commands declared for ONE platform, on that platform.
 *
 * WHY THIS EXISTS. The canonical harness runs on Linux. Four commands in its derived plan are Windows
 * PowerShell 5.1 suites (`powershell -File scripts/test-nibrs-*.ps1`), which a Linux host cannot run, so
 * the tier manifest declares them `platform: "win32"` and the Linux run reports them as a declared
 * platform skip with the verdict `platform_partial`. This script is the other half: the canonical
 * workflow's Windows job runs it, and the workflow's gate requires it to pass whenever the change
 * touches what those suites test.
 *
 * WHAT IT RUNS IS DERIVED, NEVER LISTED. The command set is the derived plan (package.json, through
 * scripts/lib/harness-plan.js) joined to the tier manifest, filtered to entries declaring this platform
 * -- the same two sources run-harness.js uses. No command is written here or in the workflow, so the
 * set cannot drift from what the Linux run skipped.
 *
 * FAILS CLOSED. It refuses to run on a different platform, refuses an undeclared platform name, refuses
 * when a declared entry matches no plan command (a stale declaration would otherwise run nothing), and
 * refuses an empty set. Exit 0 means every declared command ran here and exited 0.
 *
 * It needs no npm install: the plan and manifest modules use only Node's standard library.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { planHarness, ENTRY_POINTS } = require("./lib/harness-plan.js");
const { loadManifest, reconcile, PLATFORMS } = require("./lib/tier-manifest.js");

const REPO = path.join(__dirname, "..");
const TIMEOUT_MS = 600000;

/** The declared commands for `platform`, derived from package.json and the manifest. */
function platformCommands(platform, scripts, manifest) {
  const plan = planHarness(scripts, ENTRY_POINTS);
  if (plan.cycles.length || plan.missing.length) {
    throw new Error(`the derived plan is not usable: cycles=${plan.cycles.length} missing=${plan.missing.length}`);
  }
  const { matched } = reconcile(manifest, plan.commands);
  const selected = matched.filter(({ entry }) => entry.platform === platform);
  const declared = manifest.entries.filter((e) => e.platform === platform).map((e) => e.id);
  const reached = new Set(selected.map(({ entry }) => entry.id));
  const unreached = declared.filter((id) => !reached.has(id));
  if (unreached.length) {
    throw new Error(`declared for ${platform} but not in the derived plan: ${unreached.join(", ")}`);
  }
  if (selected.length === 0) {
    throw new Error(`no command in the derived plan declares platform ${platform}; ` +
      "running nothing must not be reported as success");
  }
  return selected.map(({ command, entry }) => ({ id: entry.id, command: command.command }));
}

function main(argv) {
  const [platform, ...rest] = argv;
  let json = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--json") json = rest[++i];
    else throw new Error(`unknown argument: ${rest[i]}`);
  }
  if (!PLATFORMS.includes(platform)) {
    console.error(`refusing: platform must be one of ${PLATFORMS.join(", ")}, got ${JSON.stringify(platform)}`);
    return 2;
  }
  if (process.platform !== platform) {
    console.error(`refusing: the commands declared for ${platform} cannot be certified on ${process.platform}`);
    return 2;
  }

  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;
  const commands = platformCommands(platform, scripts, loadManifest());
  console.log(`platform suites: ${commands.length} command(s) declared for ${platform}`);

  const results = [];
  for (const { id, command } of commands) {
    const started = Date.now();
    const run = spawnSync(command, {
      cwd: REPO, shell: true, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, CI: "1" },
    });
    const state = run.status === 0 ? "passed" : "failed";
    results.push({ id, command, state, exitCode: run.status, durationMs: Date.now() - started });
    console.log(`  ${state === "passed" ? "ok  " : "FAIL"} ${id}${state === "passed" ? "" : ` (exit ${run.status})`}`);
    if (state === "failed") {
      const text = ((run.stderr || "") + (run.stdout || "")).trim().split(/\r?\n/).slice(-40).join("\n      ");
      console.log(`      ${text}`);
    }
  }

  const failed = results.filter((r) => r.state !== "passed").length;
  console.log(`platform suites: ${results.length - failed} passed, ${failed} failed  = ${results.length}`);
  if (json) fs.writeFileSync(json, JSON.stringify({ platform, total: results.length, results }, null, 2));
  return failed === 0 ? 0 : 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`refusing: ${error.message}`);
    process.exitCode = 2;
  }
}

module.exports = { main, platformCommands };
