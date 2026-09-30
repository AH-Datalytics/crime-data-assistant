/**
 * Exit-code certification by MUTATION, because static classification has been wrong four times.
 *
 * WHY THIS IS THE ONLY ACCEPTABLE EVIDENCE. `scripts/audit-test-exit-codes.py` reports 29 scripts that
 * "track failures and exit correctly" and 115 with "no failure tracking detected" -- and its own
 * docstring is explicit that the second category means "my counter patterns did not match", NOT
 * "defective". Two of those classifications were wrong on the first pass here: `test-daily-query-
 * analysis.js` was misfiled because the pattern did not allow `require("node:assert/strict")`'s
 * `node:` prefix, and `test-stage0-operational-guards.ts` throws outside its catches where the
 * rethrow-detection was not looking. So the static pass is a SAMPLING FRAME, and the certification is
 * this: break a real assertion, require a non-zero exit.
 *
 * WHAT EACH TARGET IS FOR. Two axes, deliberately crossed rather than five arbitrary files:
 *
 *   RUNNER      one per runner the harness uses -- tsx, node, python, powershell -- because exit-code
 *               propagation is a property of the runner, not of the test. A python assert and a
 *               PowerShell `throw` reach the shell by completely different routes.
 *   BUCKET      drawn from BOTH auditor buckets, so the 115 "no failure tracking detected" scripts are
 *               shown to fail properly rather than assumed to.
 *
 * HOW A MUTATION IS KEPT HONEST. Each target is (1) run unmutated and required to PASS -- a target
 * that already fails proves nothing; (2) mutated at exactly one asserted site, so a mutation that
 * silently does not land cannot masquerade as evidence; (3) required to exit NON-ZERO; (4) restored,
 * with the restore verified byte-for-byte before the next target.
 *
 * The mutations are chosen and named, not pattern-generated. A generic "invert the first comparison"
 * rule would sometimes invert an assertion that still holds, and would then report a false clean bill.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");

/**
 * bucket: "tracked"   -- the auditor's "track failures and exit correctly" group
 *         "untracked" -- its "no failure tracking detected" group, the one that needed proving
 */
const TARGETS = [
  {
    runner: "node",
    bucket: "untracked",
    script: "scripts/test-harness-plan.js",
    command: "node scripts/test-harness-plan.js",
    what: "a bare node:assert/strict equality on the derived atomic count",
    from: "assert.equal(plan.commands.length, 3);",
    to: "assert.equal(plan.commands.length, 4);",
  },
  {
    runner: "tsx",
    bucket: "untracked",
    script: "scripts/test-time-conventions.ts",
    command: "tsx scripts/test-time-conventions.ts",
    what: "a bare assert.deepEqual on a parsed decade range",
    from: 'assert.deepEqual(parseIntent("murders over the past decade").timeRange, { start: 2016, end: 2025 });',
    to: 'assert.deepEqual(parseIntent("murders over the past decade").timeRange, { start: 2015, end: 2025 });',
  },
  {
    runner: "tsx",
    bucket: "tracked",
    script: "scripts/test-encoding.ts",
    command: "tsx scripts/test-encoding.ts",
    what: "the mojibake counter's own failure branch, inverted so the clean tree trips it",
    from: "if (bad > 0) {",
    to: "if (bad === 0) {",
  },
  {
    runner: "python",
    bucket: "untracked",
    script: "scripts/test_historical_core_digest_delimiter.py",
    command: "python scripts/test_historical_core_digest_delimiter.py",
    what: "the assertion that the unit separator is code point 0x1F",
    from: "assert ord(US) == 0x1F,",
    to: "assert ord(US) == 0x20,",
  },
  {
    runner: "powershell",
    bucket: "tracked",
    script: "scripts/test-nibrs-refresh-cleanup.ps1",
    command: "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-nibrs-refresh-cleanup.ps1",
    what: "an Assert-True on the number of stale partials removed",
    from: "Assert-True ($removed.Count -eq 1)",
    to: "Assert-True ($removed.Count -eq 2)",
  },
];

let passed = 0;
const failures = [];

function env() {
  return {
    ...process.env,
    PATH: path.join(REPO, "node_modules", ".bin") + path.delimiter + process.env.PATH,
    CI: "1",
  };
}

function run(command) {
  const result = spawnSync(command, {
    cwd: REPO, shell: true, encoding: "utf8", timeout: 300000,
    maxBuffer: 32 * 1024 * 1024, env: env(),
  });
  return {
    code: result.status,
    tail: ((result.stderr || "") + (result.stdout || "")).trim().split(/\r?\n/).slice(-3).join(" | "),
  };
}

function certify(target) {
  const full = path.join(REPO, target.script);
  const original = fs.readFileSync(full);
  const label = `${target.runner}/${target.bucket}  ${path.basename(target.script)}`;

  try {
    const clean = run(target.command);
    if (clean.code !== 0) {
      throw new Error(`the UNMUTATED command already fails (exit ${clean.code}), so a mutation ` +
        `would prove nothing: ${clean.tail}`);
    }

    const source = original.toString("utf8");
    const occurrences = source.split(target.from).length - 1;
    if (occurrences !== 1) {
      throw new Error(`expected exactly 1 mutation site for ${JSON.stringify(target.from)}, ` +
        `found ${occurrences} -- the mutation would not have landed where intended`);
    }
    fs.writeFileSync(full, Buffer.from(source.replace(target.from, target.to), "utf8"));

    const mutated = run(target.command);
    if (mutated.code === 0) {
      throw new Error(`the mutated command still exited 0, so a real failure in this script would ` +
        `be invisible to the harness. Mutation: ${target.what}`);
    }
    return { exitCode: mutated.code };
  } finally {
    fs.writeFileSync(full, original);
    const restored = fs.readFileSync(full);
    if (!restored.equals(original)) {
      // Loud, and not merely a failed assertion: the working tree is left modified.
      console.log(`  !!!!  ${label}: RESTORE FAILED -- ${target.script} is left mutated`);
      failures.push(`${label}: restore failed, ${target.script} must be restored by hand`);
    }
  }
}

console.log("exit-code certification by mutation (each target: passes clean, fails mutated, restored)");
for (const target of TARGETS) {
  const label = `${target.runner.padEnd(10)} ${target.bucket.padEnd(9)} ${path.basename(target.script)}`;
  try {
    const { exitCode } = certify(target);
    passed++;
    console.log(`  ok    ${label}  -> exit ${exitCode}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL  ${label}`);
    console.log(`        ${error.message}`);
  }
}

// The crossed axes are the point; assert the coverage rather than trusting the table above.
const runners = new Set(TARGETS.map((t) => t.runner));
const buckets = new Set(TARGETS.map((t) => t.bucket));
for (const required of ["tsx", "node", "python", "powershell"]) {
  if (!runners.has(required)) failures.push(`no mutation covers the ${required} runner`);
}
for (const required of ["tracked", "untracked"]) {
  if (!buckets.has(required)) failures.push(`no mutation is drawn from the ${required} bucket`);
}
if (TARGETS.length < 5) failures.push(`only ${TARGETS.length} mutation target(s); at least 5 required`);

console.log(`\nexit-code mutations: ${passed} of ${TARGETS.length} certified, ${failures.length} problem(s)`);
if (failures.length) {
  for (const failure of failures) console.log("  " + failure);
  process.exitCode = 1;
}
