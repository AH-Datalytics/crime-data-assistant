/**
 * The test harness's real shape: every ATOMIC command it will run.
 *
 * WHY THIS EXISTS. `package.json` joins its steps with `&&`, and one `pretest` entry is
 * `npm run test:current-trends-readiness`, which is itself ten `&&`-joined commands. Counting
 * top-level entries therefore under-reports the harness by nine executions -- and "nine commands
 * nobody counted" is the same hidden-work problem the accounting is meant to remove. A P1.1 review
 * caught exactly that: 133 entries, 142 atomic commands.
 *
 * So the plan is DERIVED, never hardcoded. Adding a test changes the number, and the tally follows.
 *
 * Nested `npm run` is expanded recursively with cycle detection, because a script that referenced
 * itself would otherwise hang or double-count. Only LOCAL scripts are expanded: `npm run build` for a
 * script that exists is expanded, while any other command is a leaf.
 */
"use strict";

const NPM_RUN = /^npm\s+run\s+([A-Za-z0-9:_-]+)\s*$/;

/**
 * The two scripts that hold the harness, and the only names any of this is measured against.
 *
 * THEY ARE DELIBERATELY NOT `pretest` AND `test`. `npm test` is now a single command --
 * `node scripts/run-harness.js` -- and npm auto-runs a script literally named `pretest` before
 * `test`. Leaving the command list under that name would execute the whole harness TWICE per
 * `npm test`: once by npm's lifecycle and once by the runner. So the lists live under
 * `harness:pretest` and `harness:test`, which npm has no lifecycle hook for.
 *
 * GATING_ENTRY gates GATED_ENTRY: that is the first of the two declared exceptions to "commands are
 * independent". Defined here, in one place, because the runner, the reachability test and the
 * accounting all have to agree on it -- and a second copy of this pair is exactly how they would
 * silently stop agreeing.
 */
const GATING_ENTRY = "harness:pretest";
const GATED_ENTRY = "harness:test";
const ENTRY_POINTS = [GATING_ENTRY, GATED_ENTRY];

/** The single command `npm test` must resolve to. */
const CANONICAL_TEST_COMMAND = "node scripts/run-harness.js";

/**
 * @param {Record<string,string>} scripts  package.json "scripts"
 * @param {string[]} entryPoints           which scripts form the harness, in order
 * @returns {{commands: Array, topLevel: number, cycles: string[], missing: string[]}}
 */
function planHarness(scripts, entryPoints) {
  const commands = [];
  const cycles = [];
  const missing = [];
  let topLevel = 0;

  function walk(name, stack) {
    if (stack.includes(name)) {
      cycles.push(stack.concat(name).join(" -> "));
      return;
    }
    const body = scripts[name];
    if (body === undefined) {
      missing.push(stack.concat(name).join(" -> "));
      return;
    }
    for (const raw of body.split("&&")) {
      const cmd = raw.trim();
      if (!cmd) continue;
      const nested = cmd.match(NPM_RUN);
      if (nested && Object.prototype.hasOwnProperty.call(scripts, nested[1])) {
        // Not a leaf: it is however many commands the referenced script contains.
        walk(nested[1], stack.concat(name));
        continue;
      }
      commands.push({
        command: cmd,
        // The chain of scripts that led here, so a failure can be attributed to where it lives.
        via: stack.concat(name).join(" -> "),
        entry: stack.length ? stack[0] : name,
        script: scriptPathOf(cmd),
        runner: cmd.split(/\s+/)[0],
      });
    }
  }

  for (const entry of entryPoints) {
    const body = scripts[entry];
    topLevel += body === undefined ? 0 : body.split("&&").filter((s) => s.trim()).length;
    walk(entry, []);
  }

  return { commands, topLevel, cycles, missing };
}

/** The script file a command runs, when it names one. Used to join a command to the manifest. */
function scriptPathOf(command) {
  const m = command.match(/(?:^|\s)((?:scripts|lib)[/\\][A-Za-z0-9_.\-/\\]+\.(?:ts|js|py|ps1))/);
  return m ? m[1].replace(/\\/g, "/") : null;
}

module.exports = { planHarness, scriptPathOf, ENTRY_POINTS, GATING_ENTRY, GATED_ENTRY,
  CANONICAL_TEST_COMMAND };
