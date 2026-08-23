/**
 * The harness runner: every atomic command, one state each, two independent verdicts.
 *
 * WHAT WAS WRONG BEFORE. `package.json` joins its steps with `&&`. That means the FIRST failure blocks
 * every remaining command, and the run reports a single exit code with no indication of how much never
 * executed. There was no per-command record, no tally, and no concept of a skip -- so "the suite is
 * green" and "the suite stopped at command 15" were indistinguishable from the outside.
 *
 * FOUR STATES, NOT THREE.
 *
 *   passed   ran, succeeded
 *   failed   ran, did not succeed
 *   skipped  deliberately not run, with tier + reason + corpus requirement -- TIER C ONLY
 *   blocked  never ran because a prerequisite failed
 *
 * `blocked` exists because collapsing it into `skipped` would let a dependency failure disguise itself
 * as an intentional omission. Every atomic command gets exactly one state and the four counts SUM to
 * the derived atomic total -- derived, never hardcoded, because adding a test changes it. A tally that
 * sums to the top-level entry count instead is wrong by construction, and is rejected.
 *
 * TWO VERDICTS THAT MUST NOT MERGE.
 *
 *   fixture_passed / fixture_failed          Tier F: did the CODE tests pass?
 *   corpus_certified / corpus_not_certified  Tier C: was DATA integrity certified?
 *
 * A run with Tier C skips can be `fixture_passed` and is simultaneously `corpus_not_certified`. It may
 * never be reported as "passed". A green Tier F run that silently implies data integrity is the exact
 * failure this increment exists to remove.
 *
 * CONTINUE BY DEFAULT, WITH TWO DECLARED EXCEPTIONS. Commands are independent and the run continues
 * after a failure, so one break no longer hides the other 148 results. The exceptions are declared,
 * never inferred: (1) `pretest` gates `test` -- it exists to front-load cheap checks, so if it fails
 * the `test` commands are `blocked`, not `skipped`; (2) a manifest-declared prerequisite blocks its
 * declared dependents and only those.
 *
 * PROBE MODE (`--probe`) runs every command against empty fixtures with no manifest, and reports what
 * happened. It is how the manifest's contents were MEASURED rather than guessed. It cannot certify
 * anything and says so: it emits no verdicts.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { planHarness, ENTRY_POINTS, GATING_ENTRY, GATED_ENTRY } = require("./lib/harness-plan.js");
const { buildFixtures, fixtureEnv, DATABASE_NAMES } = require("./lib/fixture-db.js");
const { loadManifest, reconcile, corpusAvailability } = require("./lib/tier-manifest.js");
const { SEED_PROFILES } = require("./lib/fixture-seeds.js");

const REPO = path.join(__dirname, "..");
const DEFAULT_TIMEOUT_MS = 300000;

const PASSED = "passed";
const FAILED = "failed";
const SKIPPED = "skipped";
const BLOCKED = "blocked";

/**
 * How a command announces that it skipped its own work -- and why this is a PROTOCOL, not a guess.
 *
 * The first version of this matched skip-shaped PROSE in a command's output. On the first full run it
 * failed the run on `test_refresh_agency_populations`, whose output contains
 *
 *     skipped non-agency ids: 0, malformed: 0
 *
 * -- a statistic about input rows from the script under test, reporting that nothing was skipped. The
 * test itself has no skip concept and all 15 of its checks passed. A detector that fails a green run
 * on a word in a data line is worse than no detector: it trains people to ignore it.
 *
 * There is no reliable way to infer a test-level skip from arbitrary prose, so a command that means to
 * skip has to SAY so in a way that cannot be confused with its output. Two ways, both unambiguous:
 *
 *   exit code 77            the automake convention for "skipped"
 *   a line `HARNESS-SKIP:`  at the start of a line, with a reason after it
 *
 * No command in this harness uses either today, which is correct rather than disappointing: the
 * contract's own finding is that the harness has NO skip concept. Every skip in the system is a
 * runner-originated Tier C abstention, declared by construction. The check exists so that the first
 * command to invent a skip for itself cannot do it invisibly.
 *
 * The prose patterns survive as an ADVISORY -- printed, never fatal -- because a command drifting
 * toward an undeclared skip is worth a human glance even when it is a false positive.
 */
const SKIP_PROTOCOL_EXIT = 77;
const SKIP_PROTOCOL_LINE = /^HARNESS-SKIP:/m;
const SKIP_PROSE_HINTS = [/^\s*SKIP(?:PED)?\s*:/im, /\bskipping\b[^\n]*\bbecause\b/i];

function parseArgs(argv) {
  const options = { probe: false, json: null, only: null, manifest: null,
    timeout: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--probe") options.probe = true;
    else if (arg === "--json") options.json = argv[++i];
    else if (arg === "--only") options.only = argv[++i];
    // An alternate manifest, so the mutation battery can downgrade one entry's seed profile and prove
    // the preflight catches it, without editing the committed manifest to do so.
    else if (arg === "--manifest") options.manifest = argv[++i];
    else if (arg === "--timeout") options.timeout = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function seedFor(entry) {
  if (!entry || entry.seed_profile === "empty") return {};
  const profile = SEED_PROFILES[entry.seed_profile];
  if (!profile) {
    throw new Error(`${entry.id}: seed profile "${entry.seed_profile}" is not defined in ` +
      `scripts/lib/fixture-seeds.js`);
  }
  return profile;
}

/**
 * Check one `requires` clause against a built fixture. Returns null when satisfied, else the reason.
 *
 * This is the check that closes vacuous green tests: it runs BEFORE the test, so an insufficient
 * fixture fails as a declaration defect instead of passing an assertion that never evaluated.
 */
function checkRequires(entry, fixturePaths) {
  const Database = require("better-sqlite3");
  const open = new Map();
  const problems = [];
  try {
    for (const clause of entry.requires) {
      const file = fixturePaths[clause.database];
      if (!file) {
        problems.push(`${clause.database} was required but not built`);
        continue;
      }
      if (!open.has(clause.database)) open.set(clause.database, new Database(file, { readonly: true }));
      const db = open.get(clause.database);

      const where = clause.where ? ` WHERE ${clause.where}` : "";
      let count;
      try {
        count = db.prepare(`SELECT COUNT(*) AS n FROM ${clause.table}${where}`).get().n;
      } catch (error) {
        problems.push(`${clause.database}.${clause.table}${where}: ${error.message}`);
        continue;
      }

      const floor = Number.isInteger(clause.min_rows) ? clause.min_rows : (clause.non_null ? 1 : 0);
      if (count < floor) {
        problems.push(`${clause.database}.${clause.table}${where}: needs >= ${floor} row(s), has ${count}`);
        continue;
      }

      if (Array.isArray(clause.non_null) && clause.non_null.length) {
        // "At least one matching row where EVERY listed column is non-null." The all-NULL-columns
        // fixture that passes vacuously is precisely what this rejects.
        const notNull = clause.non_null.map((c) => `${c} IS NOT NULL`).join(" AND ");
        const joined = clause.where ? `(${clause.where}) AND ${notNull}` : notNull;
        const withValues = db.prepare(
          `SELECT COUNT(*) AS n FROM ${clause.table} WHERE ${joined}`
        ).get().n;
        if (withValues < 1) {
          problems.push(`${clause.database}.${clause.table}: no row has all of ` +
            `[${clause.non_null.join(", ")}] non-null, so the assertion guarded by that column ` +
            `would never evaluate`);
        }
      }
    }
  } finally {
    for (const db of open.values()) db.close();
  }
  return problems.length ? problems : null;
}

function runCommand(command, env, timeout) {
  const started = Date.now();
  const result = spawnSync(command, {
    cwd: REPO,
    shell: true,
    timeout,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env,
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  return {
    code: result.status,
    signal: result.signal,
    timedOut: result.error && result.error.code === "ETIMEDOUT",
    durationMs: Date.now() - started,
    stdout,
    stderr,
    tail: (stderr.trim() || stdout.trim()).split(/\r?\n/).slice(-6).join("\n"),
  };
}

function childEnv(fixtureDir) {
  return {
    ...process.env,
    // node_modules/.bin is what makes `tsx` resolvable; npm adds it, a bare spawn does not.
    PATH: path.join(REPO, "node_modules", ".bin") + path.delimiter + process.env.PATH,
    ...fixtureEnv(fixtureDir),
    // Tests must never reach a real corpus by accident, and several read this to stay offline.
    CI: "1",
  };
}

function main(argv) {
  const options = parseArgs(argv);
  const scripts = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).scripts;
  const plan = planHarness(scripts, ENTRY_POINTS);

  if (plan.cycles.length) {
    console.error(`refusing to run: ${plan.cycles.length} cycle(s) in the script graph`);
    for (const cycle of plan.cycles) console.error("  " + cycle);
    return 2;
  }
  if (plan.missing.length) {
    console.error(`refusing to run: ${plan.missing.length} referenced script(s) do not exist`);
    for (const miss of plan.missing) console.error("  " + miss);
    return 2;
  }

  // BOOTSTRAP GUARD. Every other check in this system lives inside the command lists, so emptying a
  // list disables the checks that would have complained. A zero-command plan tallies 0 == 0, reports a
  // clean sum and exits 0 -- a harness that runs nothing and calls it success, which is the exact
  // failure this increment exists to remove. No test can catch it from inside; only the runner can.
  const perEntry = new Map(ENTRY_POINTS.map((entry) => [entry, 0]));
  for (const command of plan.commands) {
    perEntry.set(command.entry, (perEntry.get(command.entry) || 0) + 1);
  }
  const empty = [...perEntry].filter(([, count]) => count === 0).map(([entry]) => entry);
  if (empty.length) {
    console.error(`refusing to run: entry point(s) ${empty.join(", ")} expanded to ZERO commands. ` +
      `A harness that runs nothing would otherwise report a correct tally of 0 and exit 0.`);
    return 2;
  }

  let commands = plan.commands;
  if (options.only) {
    // Comma-separated, so a test can select an exact handful of commands. Plan ORDER is preserved,
    // which matters: a prerequisite only blocks a dependent that runs after it.
    const wanted = options.only.split(",").map((s) => s.trim()).filter(Boolean);
    commands = commands.filter((c) => wanted.some((w) => c.command.includes(w)));
  }

  const manifest = options.probe ? { entries: [] } : loadManifest(options.manifest);
  const { matched, undeclared, stale } = reconcile(manifest, commands);
  const entryFor = new Map(matched.map(({ command, entry }) => [command.command, entry]));

  const fatal = [];
  // Coverage is only a meaningful question about a WHOLE run. Under `--only` the command set is
  // filtered, so every entry outside the filter would look stale and every unmatched command
  // undeclared -- 148 false findings for a one-command run. Same reason the tally check is skipped.
  if (!options.probe && !options.only) {
    // A command with no declaration would run against whatever databases happen to be on disk --
    // exactly the pre-P1.1 behaviour this replaces. Declaring "needs nothing" is one line; leaving it
    // undeclared is a hole, so it is fatal rather than a warning.
    for (const command of undeclared) {
      fatal.push(`undeclared command: ${command.command} (via ${command.via})`);
    }
    for (const id of stale) {
      fatal.push(`stale manifest entry: ${id} names a command the harness no longer runs`);
    }
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-fixtures-"));
  const results = [];
  let pretestFailed = false;
  // Exception 2, declared: a manifest entry's `blocks` list names the ids it gates. Populated only
  // when that entry actually fails, so a passing prerequisite gates nothing.
  const blockedBy = new Map();

  /** One place that records a failure's consequences, so the two exceptions cannot diverge. */
  function recordFailure(entry, command) {
    if (command.entry === GATING_ENTRY) pretestFailed = true;
    for (const dependent of (entry && entry.blocks) || []) {
      if (!blockedBy.has(dependent)) blockedBy.set(dependent, entry.id);
    }
  }

  console.log(`harness plan: ${plan.topLevel} top-level entries -> ${plan.commands.length} atomic ` +
    `commands (${commands.length} selected), ${plan.cycles.length} cycles`);
  console.log(options.probe
    ? "PROBE MODE: empty fixtures, no manifest, no verdicts -- evidence only\n"
    : `manifest: ${manifest.entries.length} entries, ${undeclared.length} undeclared, ${stale.length} stale\n`);

  for (const command of commands) {
    const entry = entryFor.get(command.command) || null;
    const id = entry ? entry.id : command.script || command.command;
    const tier = entry ? entry.tier : (options.probe ? "?" : "F");
    const record = { id, tier, command: command.command, entry: command.entry, via: command.via,
      script: command.script };

    // Exception 1, declared: pretest gates test. Blocked, never skipped.
    //
    // Probe mode deliberately does NOT gate: its whole purpose is to observe every command's
    // behaviour, and a gate would leave most of them unmeasured. That is why probe mode issues no
    // verdict -- it trades the run's real semantics for coverage, and must not be read as a run.
    if (!options.probe && command.entry === GATED_ENTRY && pretestFailed) {
      results.push({ ...record, state: BLOCKED,
        reason: `${GATING_ENTRY} failed, so ${GATED_ENTRY} never ran` });
      continue;
    }

    if (!options.probe && blockedBy.has(id)) {
      results.push({ ...record, state: BLOCKED,
        reason: `declared prerequisite ${blockedBy.get(id)} failed` });
      continue;
    }

    // Tier C abstains only for its one declared reason.
    if (tier === "C") {
      const availability = corpusAvailability(entry);
      if (!availability.available) {
        results.push({
          ...record,
          state: SKIPPED,
          reason: availability.reason,
          corpus_requirement: entry.corpus.description,
        });
        continue;
      }
    }

    let fixtures;
    try {
      fixtures = buildFixtures(path.join(workDir, id.replace(/[^A-Za-z0-9_.-]/g, "_")),
        DATABASE_NAMES, seedFor(entry));
    } catch (error) {
      results.push({ ...record, state: FAILED, reason: `fixture build failed: ${error.message}` });
      recordFailure(entry, command);
      continue;
    }

    if (entry && entry.requires.length) {
      const violations = checkRequires(entry, fixtures);
      if (violations) {
        // A failure, never a skip: the fixture was DECLARED sufficient and is not.
        results.push({ ...record, state: FAILED, preflight: true,
          reason: "preflight: " + violations.join("; ") });
        recordFailure(entry, command);
        continue;
      }
    }

    const run = runCommand(command.command, childEnv(path.dirname(fixtures.rtci)), options.timeout);
    const announcedSkip = run.code === SKIP_PROTOCOL_EXIT || SKIP_PROTOCOL_LINE.test(run.stdout);
    const skipProse = !announcedSkip && SKIP_PROSE_HINTS.some((re) => re.test(run.stdout));
    const state = run.code === 0 ? PASSED : FAILED;
    results.push({
      ...record,
      state,
      exitCode: run.code,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      announcedSkip,
      skipProse,
      tail: state === PASSED ? undefined : run.tail,
    });
    if (state === FAILED) recordFailure(entry, command);

    process.stdout.write(`${state === PASSED ? "  ok  " : "  FAIL"} ${id}` +
      `${state === PASSED ? "" : ` (exit ${run.code})`}\n`);
  }

  fs.rmSync(workDir, { recursive: true, force: true });

  // A command that announced its own skip via the protocol must have been declared skippable.
  const advisories = [];
  for (const result of results) {
    if (result.announcedSkip) {
      const entry = entryFor.get(result.command);
      if (!entry || entry.tier !== "C") {
        fatal.push(`undeclared skip: ${result.id} used the skip protocol (exit ` +
          `${SKIP_PROTOCOL_EXIT} or a HARNESS-SKIP: line) but is not a declared Tier C command, so ` +
          `the omission would be invisible in the tally`);
      }
    } else if (result.skipProse) {
      advisories.push(`${result.id}: its output contains skip-shaped prose. Not a failure -- it is ` +
        `probably reporting skipped input rows -- but worth a glance if it should be declaring a skip.`);
    }
  }

  return report(results, plan, options, fatal, advisories);
}

function report(results, plan, options, fatal, advisories) {
  const tally = { passed: 0, failed: 0, skipped: 0, blocked: 0 };
  for (const result of results) tally[result.state]++;
  const total = tally.passed + tally.failed + tally.skipped + tally.blocked;

  console.log("");
  console.log(`tally: ${tally.passed} passed, ${tally.failed} failed, ${tally.skipped} skipped, ` +
    `${tally.blocked} blocked  = ${total}`);

  // The accounting rule, checked rather than asserted in prose. Only meaningful for a full run.
  const expected = plan.commands.length;
  if (!options.only && total !== expected) {
    fatal.push(`tally sums to ${total}, but the derived plan has ${expected} atomic commands ` +
      `(top-level entry count is ${plan.topLevel} and is NOT the expected total)`);
  }

  if (tally.failed) {
    console.log("\nfailed:");
    for (const r of results.filter((x) => x.state === FAILED)) {
      console.log(`  ${r.id}${r.preflight ? "  [preflight]" : ""}`);
      console.log(`      ${(r.reason || r.tail || "").split("\n").join("\n      ")}`);
    }
  }
  if (tally.blocked) {
    console.log(`\nblocked: ${tally.blocked} command(s) never ran because a prerequisite failed`);
  }
  if (tally.skipped) {
    console.log("\nskipped (Tier C, corpus unavailable):");
    for (const r of results.filter((x) => x.state === SKIPPED)) {
      console.log(`  ${r.id}  [tier ${r.tier}]`);
      console.log(`      requires: ${r.corpus_requirement}`);
      console.log(`      reason:   ${r.reason}`);
    }
  }

  if (options.json) {
    fs.writeFileSync(options.json, JSON.stringify({ tally, total, expected, results }, null, 2));
    console.log(`\nwrote ${options.json}`);
  }

  if (options.probe) {
    console.log("\nPROBE MODE: no verdict is issued. This run measured behaviour against empty " +
      "fixtures; it certifies nothing.");
    return fatal.length ? 1 : 0;
  }

  // The two verdicts, always both, never merged.
  const tierF = results.filter((r) => r.tier === "F");
  const fixtureVerdict = tierF.some((r) => r.state === FAILED || r.state === BLOCKED)
    ? "fixture_failed" : "fixture_passed";
  const skippedC = results.filter((r) => r.tier === "C" && r.state === SKIPPED);
  const corpusVerdict = skippedC.length ? "corpus_not_certified" : "corpus_certified";

  console.log("");
  console.log(`verdict  fixture: ${fixtureVerdict}   (${tierF.length} Tier F command(s))`);
  console.log(`verdict  corpus:  ${corpusVerdict}` +
    (skippedC.length ? `   (${skippedC.length} Tier C command(s) skipped)` : ""));
  if (corpusVerdict === "corpus_not_certified") {
    console.log("         This run did NOT certify data integrity. It must not be described as " +
      "\"passed\".");
  }

  if (advisories && advisories.length) {
    // Advisory, deliberately: printed after the verdicts and never part of the exit code.
    console.log(`\n${advisories.length} advisory note(s), not failures:`);
    for (const note of advisories) console.log("  " + note);
  }

  if (fatal.length) {
    console.log(`\n${fatal.length} RUN DEFECT(S):`);
    for (const problem of fatal) console.log("  " + problem);
  }

  const ok = fixtureVerdict === "fixture_passed" && tally.failed === 0 && tally.blocked === 0
    && fatal.length === 0;
  return ok ? 0 : 1;
}

if (require.main === module) {
  raiseExit(main(process.argv.slice(2)));
}

function raiseExit(code) {
  process.exitCode = code;
}

module.exports = { main, report, checkRequires, parseArgs, seedFor,
  SKIP_PROTOCOL_EXIT, SKIP_PROTOCOL_LINE, SKIP_PROSE_HINTS,
  PASSED, FAILED, SKIPPED, BLOCKED };
