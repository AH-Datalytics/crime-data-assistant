/**
 * End-to-end mutations of the RUN itself, not of its parts.
 *
 * `test-harness-contract.js` proves the preflight's judgement in isolation: given a schema-only
 * fixture and a declared row floor, `checkRequires` objects. That is necessary and not sufficient. The
 * claim the contract actually makes is about a RUN:
 *
 *   "downgrading a required seed profile to schema-only fails the affected test IN PREFLIGHT, before
 *    its assertions run -- not passing vacuously, and not skipping."
 *
 * Three things there can each fail independently: the preflight must run at all, it must run BEFORE
 * the command, and its verdict must be `failed` rather than `skipped`. Only an end-to-end run can show
 * all three, so each mutation below drives the real runner with a doctored manifest and reads the
 * outcome back out of its JSON report.
 *
 * The committed manifest is never edited: mutants are written to a temp file and passed via
 * `--manifest`.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const MANIFEST = path.join(REPO, "scripts", "fixtures", "harness-tier-manifest.json");
const WORKED_EXAMPLE = "test-current-indexed-state-deterministic";

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

/** Run the real runner over one command with a given manifest; return its JSON report. */
function runOne(manifestPath, only) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-mutation-"));
  const jsonPath = path.join(dir, "report.json");
  try {
    const result = spawnSync("node", [
      path.join(REPO, "scripts", "run-harness.js"),
      "--manifest", manifestPath, "--only", only, "--json", jsonPath,
    ], {
      cwd: REPO, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: path.join(REPO, "node_modules", ".bin") + path.delimiter + process.env.PATH,
      },
    });
    if (!fs.existsSync(jsonPath)) {
      throw new Error(`the runner wrote no report. exit=${result.status} stderr=` +
        `${(result.stderr || "").slice(-400)}`);
    }
    return {
      exitCode: result.status,
      report: JSON.parse(fs.readFileSync(jsonPath, "utf8")),
      stdout: result.stdout || "",
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function mutantManifest(mutate) {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const entry = manifest.entries.find((e) => e.id === WORKED_EXAMPLE);
  if (!entry) throw new Error(`${WORKED_EXAMPLE} is not in the manifest; this battery is stale`);
  mutate(entry, manifest);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mutant-manifest-")), "manifest.json");
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

check("baseline: the worked example PASSES with its declared seed profile", () => {
  // Without this, every mutation below could be passing for the wrong reason.
  const { exitCode, report } = runOne(MANIFEST, WORKED_EXAMPLE);
  const record = report.results.find((r) => r.id === WORKED_EXAMPLE);
  if (!record) throw new Error("the worked example did not run at all");
  if (record.state !== "passed") {
    throw new Error(`expected passed, got ${record.state}: ${record.reason || record.tail}`);
  }
  if (exitCode !== 0) throw new Error(`expected exit 0, got ${exitCode}`);
});

check("REQUIRED MUTATION: seed profile downgraded to schema-only fails IN PREFLIGHT", () => {
  const mutant = mutantManifest((entry) => { entry.seed_profile = "empty"; });
  const { exitCode, report } = runOne(mutant, WORKED_EXAMPLE);
  const record = report.results.find((r) => r.id === WORKED_EXAMPLE);

  if (record.state !== "failed") {
    throw new Error(`a schema-only fixture produced state=${record.state}; it must FAIL, and must ` +
      `not pass vacuously or skip`);
  }
  if (!record.preflight) {
    throw new Error("it failed, but not in preflight -- so the assertions ran and the failure came " +
      "from the test itself, which is a weaker guarantee than the contract requires");
  }
  if (record.exitCode !== undefined) {
    throw new Error("the command was executed; preflight must reject BEFORE the test runs");
  }
  if (!/needs >= /.test(record.reason || "")) {
    throw new Error(`the reason does not name the unmet requirement: ${record.reason}`);
  }
  if (exitCode === 0) throw new Error("the run exited 0 despite a preflight failure");
});

check("a preflight failure is never reported as a skip", () => {
  const mutant = mutantManifest((entry) => { entry.seed_profile = "empty"; });
  const { report, stdout } = runOne(mutant, WORKED_EXAMPLE);
  if (report.tally.skipped !== 0) {
    throw new Error(`preflight failure counted ${report.tally.skipped} skip(s); a dependency ` +
      `failure must never look like a Tier C omission`);
  }
  if (report.tally.failed !== 1) throw new Error(`expected 1 failed, got ${report.tally.failed}`);
  if (!/fixture_failed/.test(stdout)) {
    throw new Error("the fixture verdict did not turn to fixture_failed");
  }
});

check("the population clauses turn an opaque late failure into a precise preflight one", () => {
  // The sharper mutation, and the one that shows what `requires` BUYS rather than only that it fires.
  //
  // The bad fixture is monthly counts with no population rows -- the strongest one reachable, since
  // `agency_population.population` is NOT NULL so a NULL cannot be seeded and the test's nulls come
  // from a LEFT JOIN missing its match. Both runs below fail. The difference is WHERE and WHY:
  //
  //   with the population clauses     failed in PREFLIGHT, naming the missing 2017 population
  //   without them                    the test ran and died inside its own assertions
  //
  // A run that has to be diagnosed from an assertion stack is the situation the preflight exists to
  // remove, so "it fails either way" is not an argument against the clause.
  const strictManifest = mutantManifest((entry) => {
    entry.seed_profile = "mutation_monthly_without_population";
  });
  const laxManifest = mutantManifest((entry) => {
    entry.seed_profile = "mutation_monthly_without_population";
    entry.requires = entry.requires.filter((c) => c.table !== "agency_population");
  });

  const strict = runOne(strictManifest, WORKED_EXAMPLE).report.results
    .find((r) => r.id === WORKED_EXAMPLE);
  const lax = runOne(laxManifest, WORKED_EXAMPLE).report.results
    .find((r) => r.id === WORKED_EXAMPLE);

  if (strict.state !== "failed" || !strict.preflight) {
    throw new Error(`with the population clauses expected a preflight failure, got ` +
      `state=${strict.state} preflight=${strict.preflight}`);
  }
  if (!/agency_population/.test(strict.reason || "")) {
    throw new Error(`the preflight reason does not name the missing precondition: ${strict.reason}`);
  }
  if (lax.preflight) {
    throw new Error("without the population clauses it STILL failed in preflight, so the clauses " +
      "changed nothing and this mutation would prove nothing");
  }
  if (lax.state !== "failed") {
    throw new Error(`without the clauses the test should still fail, on its own assertions; got ` +
      `state=${lax.state}. If it PASSED, the fixture is vacuous and the clause is load-bearing in ` +
      `an even stronger sense than claimed.`);
  }
});

check("a declared prerequisite BLOCKS its dependent, and blocks nothing else", () => {
  // Exception 2 to "commands are independent". It was implemented and, until this test, never driven
  // -- a declared exception nothing exercises is indistinguishable from one that does not work.
  //
  // Construction: make the worked example fail (schema-only fixture) and declare that it blocks a
  // second command. The dependent must come out `blocked`, never `skipped`, and a third command in
  // the same run must be untouched.
  // The dependent and the bystander must both run AFTER the blocker in plan order -- a prerequisite
  // cannot block something that already ran, and picking an earlier command would make this test pass
  // for no reason. Both of these follow the worked example inside `pretest`.
  const dependent = "test-latency-scoreboard";
  const bystander = "test-nibrs-rollup-worker";
  const mutant = mutantManifest((entry) => {
    entry.seed_profile = "empty";
    entry.blocks = [dependent];
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blocks-"));
  const jsonPath = path.join(dir, "report.json");
  try {
    spawnSync("node", [path.join(REPO, "scripts", "run-harness.js"),
      "--manifest", mutant, "--json", jsonPath,
      "--only", [WORKED_EXAMPLE, dependent, bystander].join(",")], {
      cwd: REPO, encoding: "utf8", timeout: 600000, maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: path.join(REPO, "node_modules", ".bin") + path.delimiter + process.env.PATH,
      },
    });
    const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    const blocker = report.results.find((r) => r.id === WORKED_EXAMPLE);
    const blocked = report.results.find((r) => r.id === dependent);
    const untouched = report.results.find((r) => r.id === bystander);
    if (!untouched || untouched.state === "blocked") {
      throw new Error(`the bystander ${bystander} came out ${untouched && untouched.state}; a ` +
        `prerequisite must block only its DECLARED dependents`);
    }

    if (blocker.state !== "failed") throw new Error(`the blocker did not fail: ${blocker.state}`);
    if (!blocked) throw new Error(`${dependent} did not appear in the report at all`);
    if (blocked.state !== "blocked") {
      throw new Error(`the dependent came out ${blocked.state}; a prerequisite failure must report ` +
        `blocked, never skipped and never silently passed`);
    }
    if (!/declared prerequisite/.test(blocked.reason || "")) {
      throw new Error(`the dependent's reason does not name its prerequisite: ${blocked.reason}`);
    }
    if (report.tally.skipped !== 0 && blocked.state === "skipped") {
      throw new Error("a blocked command was counted as a skip");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("an unknown seed profile is rejected loudly, not silently treated as empty", () => {
  const mutant = mutantManifest((entry) => { entry.seed_profile = "no_such_profile"; });
  const { report } = runOne(mutant, WORKED_EXAMPLE);
  const record = report.results.find((r) => r.id === WORKED_EXAMPLE);
  if (record.state !== "failed") {
    throw new Error(`an undefined seed profile produced state=${record.state}; silently seeding ` +
      `nothing would make every requires clause fail for the wrong reason`);
  }
  if (!/seed profile/.test(record.reason || "")) {
    throw new Error(`the reason does not name the missing profile: ${record.reason}`);
  }
});

console.log(`\npreflight mutations: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const failure of failures) console.log("  " + failure);
  process.exitCode = 1;
}
