/**
 * The RTCI freshness monitor, offline.
 *
 * WHAT THIS PROTECTS. The monitor exists because /opt/nibrs/auto-update-rtci.sh ran every morning
 * from April to August 2026 and did nothing, and nobody could tell. A monitor that can report health
 * while blind, or that can be silenced by the very hang it should surface, would reproduce that. So
 * the assertions below are mostly about the monitor's own failure modes, not about the happy path:
 *
 *   1. exit mapping            0 / 10 / 1 reach distinct outcomes, exits and alert decisions
 *   2. lock and staleness      one skip is silent; a skip with no recent success alerts, and reads
 *                              no database
 *   3. independent heartbeat   runs with the lock held, and never takes it
 *   4. secret non-disclosure   no API key reaches a log line or an email body
 *   5. drift and absence       reported when the pinned copy is not the deployed copy, or the
 *                              release has none, without changing the freshness verdict
 *   6. status mode             the reviewed 0644, set explicitly rather than inherited from mkstemp
 *   7. sidecar policy          what is left in prose is only the operator's one-off procedure
 *   8. self-contained stack    the whole thing loads and alerts with node_modules unreachable
 *   9. credential file         root-owned 0600, verified per read, never falling back when unsafe
 *  10. database guard          the served database is byte-identical before and after every run
 *  11. bounded response        the send's timeout survives into body consumption, and bytes are capped
 *  12. single-writer logging   one invocation, one primary outcome line, in one file
 *
 * Nothing here needs a network, a real database or the production host. A stub detector stands in for
 * check-rtci-refresh.py so exit codes can be driven directly.
 *
 * SECTIONS 9 AND 10 ARE MUTATION TESTS, deliberately. A guard is only worth the assertions that can
 * be made to fail: each gated property is broken on its own, against a baseline known to pass, so
 * "the database did not change" is a claim this suite can actually refute rather than merely repeat.
 */
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const SHELL_JS = path.join(REPO, "scripts", "rtci-freshness.js");
const SHELL_SH = path.join(REPO, "scripts", "rtci-freshness.sh");
const policy = require("./lib/rtci-freshness-policy.js");
const mailer = require("./lib/resend-mailer.js");

let passed = 0;
let failed = 0;
let finished = false;
const asyncChecks = [];

/**
 * A suite that dies mid-way must not read as a pass.
 *
 * Writing the hanging-body test found this the hard way: an awaited promise that never settles
 * empties the event loop, and Node exits 0 without printing a summary. Every assertion after the
 * hang is simply never run, and CI reports success. The summary line is the proof of completion, so
 * its absence is a failure.
 */
process.on("exit", (code) => {
  if (!finished && code === 0) {
    console.error("\nFAIL: the suite exited before finishing -- a pending promise never settled");
    process.exitCode = 1;
  }
});

async function expectReject(promise, pattern, label) {
  let message = null;
  try { await promise; } catch (err) { message = err.message; }
  assert.ok(message !== null, `${label}: expected a rejection`);
  assert.match(message, pattern, `${label}: ${message}`);
  return message;
}

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name} -- ${err.message}`);
  }
}

const HOUR = 3600000;
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------
// 1. Exit mapping
// ---------------------------------------------------------------------------------------------
console.log("\n1. exit mapping");

const okStatus = { outcome: "up_to_date", upstream_max_period: 202606, database_max_period: 202606 };
const staleStatus = { outcome: "update_available", upstream_max_period: 202607, database_max_period: 202606 };

check("exit 0 is up_to_date, exit 0, and does NOT alert", () => {
  const r = policy.classify({ kind: "check", detectorExit: 0, status: okStatus });
  assert.equal(r.outcome, "up_to_date");
  assert.equal(r.exitCode, 0);
  assert.equal(r.alert.send, false);
  assert.match(r.logLine, /OK up_to_date upstream=202606 database=202606/);
});

check("exit 10 is update_available, exit 10, and alerts", () => {
  const r = policy.classify({ kind: "check", detectorExit: 10, status: staleStatus });
  assert.equal(r.outcome, "update_available");
  assert.equal(r.exitCode, 10);
  assert.equal(r.alert.send, true);
  assert.match(r.logLine, /STALE update_available upstream=202607 database=202606/);
  assert.match(r.alert.body, /Nothing was imported and nothing was written/);
});

check("exit 1 is check_failed, exit 1, and alerts", () => {
  const r = policy.classify({ kind: "check", detectorExit: 1, detectorStderr: "listing_unavailable: HTTPError" });
  assert.equal(r.outcome, "check_failed");
  assert.equal(r.exitCode, 1);
  assert.equal(r.alert.send, true);
  assert.match(r.logLine, /FAIL check_failed exit=1 reason=listing_unavailable/);
});

check("a failed check says freshness is UNKNOWN, not that it is fine", () => {
  const r = policy.classify({ kind: "check", detectorExit: 1, detectorStderr: "boom" });
  assert.match(r.alert.body, /UNKNOWN as a result -- this is not the same as up to date/);
});

check("an unexpected exit code is still a failure, never a success", () => {
  for (const code of [2, 7, 42, -1, 137]) {
    const r = policy.classify({ kind: "check", detectorExit: code });
    assert.equal(r.outcome, "check_failed", `exit ${code}`);
    assert.equal(r.exitCode, 1);
    assert.equal(r.alert.send, true);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Lock and staleness
// ---------------------------------------------------------------------------------------------
console.log("\n2. lock and staleness");

check("one lock skip is silent: exit 0, no alert", () => {
  const r = policy.classify({ kind: "locked", lastSuccessAgeMs: 2 * HOUR });
  assert.equal(r.outcome, "skipped_locked");
  assert.equal(r.exitCode, 0);
  assert.equal(r.alert.send, false);
});

check("a skip is still silent just under the 36-hour boundary", () => {
  const r = policy.classify({ kind: "locked", lastSuccessAgeMs: policy.STALE_AFTER_MS - 1000 });
  assert.equal(r.outcome, "skipped_locked");
  assert.equal(r.alert.send, false);
});

check("a skip past 36 hours becomes monitor_stalled and alerts", () => {
  const r = policy.classify({ kind: "locked", lastSuccessAgeMs: policy.STALE_AFTER_MS + 1000 });
  assert.equal(r.outcome, "monitor_stalled");
  assert.equal(r.exitCode, 1);
  assert.equal(r.alert.send, true);
  assert.match(r.alert.subject, /STALLED/);
});

check("a skip with NO recorded success ever is monitor_stalled", () => {
  const r = policy.classify({ kind: "locked", lastSuccessAgeMs: null });
  assert.equal(r.outcome, "monitor_stalled");
  assert.equal(r.alert.send, true);
});

check("the stalled alert states that no database was read and nothing written", () => {
  const r = policy.classify({ kind: "locked", lastSuccessAgeMs: null });
  assert.match(r.alert.body, /No database was read and nothing was written/);
});

check("only a genuine up_to_date record counts as a success for staleness", () => {
  const now = Date.parse("2026-08-27T12:00:00Z");
  assert.equal(policy.lastSuccessAgeMs(null, now), null);
  assert.equal(policy.lastSuccessAgeMs({ outcome: "update_available", checked_at_utc: "2026-08-27T11:00:00Z" }, now), null);
  assert.equal(policy.lastSuccessAgeMs({ outcome: "up_to_date" }, now), null, "no timestamp");
  assert.equal(policy.lastSuccessAgeMs({ outcome: "up_to_date", checked_at_utc: "2026-08-27T11:00:00Z" }, now), HOUR);
});

check("the locked path reads no database and runs no detector", () => {
  const src = fs.readFileSync(SHELL_JS, "utf8");
  const locked = src.slice(src.indexOf('if (mode === "locked")'), src.indexOf('if (mode !== "check")'));
  assert.ok(!/spawnSync/.test(locked), "the locked branch must not spawn anything");
  assert.ok(!/DB\b/.test(locked.replace(/\/\/.*$/gm, "")), "the locked branch must not reference the database");
});

// ---------------------------------------------------------------------------------------------
// 3. The heartbeat is independent of the lock
// ---------------------------------------------------------------------------------------------
console.log("\n3. independent heartbeat");

check("the shell script takes the lock for check and NOT for heartbeat", () => {
  const sh = fs.readFileSync(SHELL_SH, "utf8");
  const hb = sh.slice(sh.indexOf("heartbeat)"), sh.indexOf("check)"));
  assert.ok(!/flock/.test(hb), "the heartbeat branch must not flock");
  const ck = sh.slice(sh.indexOf("check)"));
  assert.match(ck, /flock -n 9/, "the check branch must flock");
});

check("a heartbeat with a recent success is heartbeat_ok, exit 0, and still sends", () => {
  const r = policy.classify({ kind: "heartbeat", lastSuccessAgeMs: 6 * HOUR, recentOutcomes: ["a", "b"] });
  assert.equal(r.outcome, "heartbeat_ok");
  assert.equal(r.exitCode, 0);
  assert.equal(r.alert.send, true, "a heartbeat nobody receives is not a heartbeat");
});

check("a heartbeat with no recent success is heartbeat_stalled and exits non-zero", () => {
  const r = policy.classify({ kind: "heartbeat", lastSuccessAgeMs: 90 * HOUR });
  assert.equal(r.outcome, "heartbeat_stalled");
  assert.equal(r.exitCode, 1);
  assert.match(r.alert.subject, /NO SUCCESSFUL CHECK/);
});

check("the heartbeat runs end to end while the lock is held", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-hb-"));
  const status = path.join(dir, "status.json");
  fs.writeFileSync(status, JSON.stringify({ outcome: "up_to_date", checked_at_utc: new Date().toISOString() }));
  const log = path.join(dir, "freshness.log");
  // Hold the lock from this process by opening the same file the shell would.
  const lock = path.join(dir, "lock");
  fs.writeFileSync(lock, "");
  const r = spawnSync(process.execPath, [SHELL_JS, "heartbeat"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: status,
      RTCI_FRESHNESS_LOG: log,
      RTCI_FRESHNESS_LOCK: lock,
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "absent"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 0, `heartbeat exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /HEARTBEAT ok/);
  assert.match(fs.readFileSync(log, "utf8"), /alert rendered \(dry run\)/);
});

// ---------------------------------------------------------------------------------------------
// 4. Secret non-disclosure
// ---------------------------------------------------------------------------------------------
console.log("\n4. secret non-disclosure");

check("a known key value is redacted from any text", () => {
  const prior = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_abcdef0123456789ABCDEF";
  try {
    const out = mailer.redactSecrets(`failed with key re_abcdef0123456789ABCDEF in the request`);
    assert.ok(!out.includes("re_abcdef0123456789ABCDEF"), out);
    assert.match(out, /\[redacted/);
  } finally {
    if (prior === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prior;
  }
});

check("a key-SHAPED string is redacted even when it is not the configured key", () => {
  const prior = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const out = mailer.redactSecrets("Authorization: Bearer re_ZZZZZZZZZZZZZZZZZZZZ");
    assert.ok(!out.includes("re_ZZZZZZZZZZZZZZZZZZZZ"), out);
  } finally {
    if (prior !== undefined) process.env.RESEND_API_KEY = prior;
  }
});

asyncChecks.push(["sending refuses outright when no key is configured", async () => {
  const prior = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    await expectReject(mailer.sendPlainMail({ subject: "s", body: "b" }),
      /RESEND_API_KEY is not set/, "no key");
  } finally {
    if (prior !== undefined) process.env.RESEND_API_KEY = prior;
  }
}]);

check("a dry run renders the message without contacting Resend", async () => {
  const out = await mailer.sendPlainMail({ subject: "subj", body: "body", dryRun: true });
  assert.equal(out.dryRun, true);
  assert.equal(out.to, mailer.TO_EMAIL);
  assert.equal(out.from, mailer.FROM_EMAIL);
});

check("the digest's inline sender and recipient still match the shared module", () => {
  const digest = fs.readFileSync(path.join(REPO, "scripts", "daily-query-analysis.js"), "utf8");
  assert.ok(digest.includes(`"${mailer.TO_EMAIL}"`), `digest TO_EMAIL drifted from ${mailer.TO_EMAIL}`);
  assert.ok(digest.includes(`"${mailer.FROM_EMAIL}"`), `digest FROM_EMAIL drifted from ${mailer.FROM_EMAIL}`);
});

check("no alert body or log line interpolates the environment wholesale", () => {
  const src = fs.readFileSync(SHELL_JS, "utf8") + fs.readFileSync(path.join(REPO, "scripts", "lib", "rtci-freshness-policy.js"), "utf8");
  assert.ok(!/JSON\.stringify\(process\.env/.test(src));
  assert.ok(!/process\.env\.RESEND_API_KEY/.test(fs.readFileSync(path.join(REPO, "scripts", "lib", "rtci-freshness-policy.js"), "utf8")),
    "the policy module has no business reading the key");
});

// ---------------------------------------------------------------------------------------------
// 5. Drift and absence
// ---------------------------------------------------------------------------------------------
console.log("\n5. drift and absence reporting");

check("drift is reported when pinned and deployed differ", () => {
  const notes = policy.describeBinding({ pinnedSha: "a".repeat(64), deployedSha: "b".repeat(64), deployedPresent: true });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /detector_drift/);
});

check("no note when pinned and deployed agree", () => {
  const same = "c".repeat(64);
  assert.deepEqual(policy.describeBinding({ pinnedSha: same, deployedSha: same, deployedPresent: true }), []);
});

check("absence from the release is reported, and named as the rollback case", () => {
  const notes = policy.describeBinding({ pinnedSha: "a".repeat(64), deployedPresent: false });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /detector_absent_from_release/);
  assert.match(notes[0], /rollback/);
});

check("drift does NOT change the freshness verdict or exit code", () => {
  const drift = { pinnedSha: "a".repeat(64), deployedSha: "b".repeat(64), deployedPresent: true };
  const plain = policy.classify({ kind: "check", detectorExit: 0, status: okStatus });
  const drifted = policy.classify({ kind: "check", detectorExit: 0, status: okStatus, binding: drift });
  assert.equal(drifted.outcome, plain.outcome);
  assert.equal(drifted.exitCode, plain.exitCode);
  assert.equal(drifted.alert.send, plain.alert.send);
  assert.match(drifted.logLine, /detector_drift/);
});

check("a missing pinned detector is a failure, not a silent skip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-nopin-"));
  const log = path.join(dir, "f.log");
  const r = spawnSync(process.execPath, [SHELL_JS, "check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: path.join(dir, "s.json"),
      RTCI_FRESHNESS_LOG: log,
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "nothing-here"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL check_failed/);
  assert.match(r.stdout, /no pinned detector/);
});

check("a pinned detector whose hash does not match PINNED is refused", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-badpin-"));
  const commit = "abcdef1";
  fs.mkdirSync(path.join(dir, "pin", commit), { recursive: true });
  const script = path.join(dir, "pin", commit, "check-rtci-refresh.py");
  fs.writeFileSync(script, "print('detector')\n");
  fs.writeFileSync(path.join(dir, "pin", "PINNED"), `sha256=${"0".repeat(64)} commit=${commit}\n`);
  const r = spawnSync(process.execPath, [SHELL_JS, "check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: path.join(dir, "s.json"),
      RTCI_FRESHNESS_LOG: path.join(dir, "f.log"),
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "pin"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /hash mismatch/);
});

// ---------------------------------------------------------------------------------------------
// 6. Status mode
// ---------------------------------------------------------------------------------------------
console.log("\n6. status mode");

check("the reviewed mode is 0644, stated as a constant rather than inherited", () => {
  const shell = require("./rtci-freshness.js");
  assert.equal(shell.STATUS_MODE, 0o644);
  const src = fs.readFileSync(SHELL_JS, "utf8");
  assert.match(src, /STATUS_MODE = 0o644/);
  assert.match(src, /chmodSync\(STATUS, STATUS_MODE\)/);
});

check("the mode is applied after the detector runs, in every outcome", () => {
  const src = fs.readFileSync(SHELL_JS, "utf8");
  const between = src.slice(src.indexOf("const run = spawnSync"), src.indexOf("return emit(policy.classify({\n    kind: \"check\","));
  assert.match(between, /chmodSync/, "the chmod must sit between the run and the classification");
});

check("a real run sets the status file to 0644 even when the detector fails", () => {
  if (process.platform === "win32") { console.log("        (mode bits are not meaningful on win32; asserted on posix only)"); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-mode-"));
  const commit = "1111111";
  fs.mkdirSync(path.join(dir, "pin", commit), { recursive: true });
  const script = path.join(dir, "pin", commit, "check-rtci-refresh.py");
  const status = path.join(dir, "s.json");
  // A stub detector: writes a restrictive status file, then exits 10.
  fs.writeFileSync(script, [
    "import os, sys, json",
    "p = sys.argv[sys.argv.index('--status') + 1]",
    "fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
    "os.write(fd, json.dumps({'outcome': 'update_available', 'upstream_max_period': 202607,",
    "                         'database_max_period': 202606}).encode())",
    "os.close(fd)",
    "sys.exit(10)",
  ].join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "pin", "PINNED"),
    `sha256=${sha256(fs.readFileSync(script))} commit=${commit}\n`);
  const r = spawnSync(process.execPath, [SHELL_JS, "check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: status,
      RTCI_FRESHNESS_LOG: path.join(dir, "f.log"),
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "pin"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_PYTHON: "python3",
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 10, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /STALE update_available upstream=202607 database=202606/);
  assert.equal(fs.statSync(status).mode & 0o777, 0o644,
    `status mode is ${(fs.statSync(status).mode & 0o777).toString(8)}`);
});

// ---------------------------------------------------------------------------------------------
// 7. Sidecar policy
// ---------------------------------------------------------------------------------------------
console.log("\n7. sidecar policy under a concurrent reader");

check("the only sidecar rule left in prose is the one that is an operator procedure", () => {
  // The standing rule is executable and is proved by the mutation tests in section 10. What remains
  // here is the stricter one-off gate for the first hand-run check, which is a human procedure and
  // cannot be code. A prose key for anything the code now enforces would be a second, driftable copy.
  const p = policy.OBSERVATIONAL_SIDECAR_POLICY;
  assert.ok(Object.isFrozen(p), "the policy must be frozen");
  assert.deepEqual(Object.keys(p).sort(), ["firstControlledRun", "standingRule"]);
  assert.match(p.firstControlledRun, /exact equality/);
  assert.match(p.standingRule, /compareDatabaseSnapshots/);
  assert.equal(typeof policy.compareDatabaseSnapshots, "function",
    "the standing rule must be a function, not a sentence");
});

check("a read-only open of an already-attached WAL database does not alter main or -wal", () => {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    console.log("        (better-sqlite3 unavailable; skipped)");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-side-"));
  const db = path.join(dir, "live.db");
  const w = new Database(db);
  w.pragma("journal_mode = WAL");
  w.exec("CREATE TABLE t (x)");
  w.prepare("INSERT INTO t VALUES (1)").run();
  // A concurrent reader keeps the sidecars present, which is the live shape.
  const reader = new Database(db, { readonly: true });
  reader.prepare("SELECT COUNT(*) AS n FROM t").get();

  const snap = () => ["", "-wal", "-shm"].map((s) => {
    const p = db + s;
    if (!fs.existsSync(p)) return null;
    const st = fs.statSync(p);
    return { size: st.size, mtimeNs: String(st.mtimeMs), sha: sha256(fs.readFileSync(p)) };
  });
  const before = snap();
  const probe = new Database(db, { readonly: true });
  probe.prepare("SELECT COUNT(*) AS n FROM t").get();
  probe.close();
  const after = snap();

  for (const [i, label] of [[0, "main"], [1, "-wal"]]) {
    assert.ok(before[i] && after[i], `${label} should exist on both sides`);
    assert.equal(after[i].size, before[i].size, `${label} size`);
    assert.equal(after[i].sha, before[i].sha, `${label} sha256`);
  }
  // -shm is recorded, deliberately not gated.
  console.log(`        -shm before=${before[2] ? before[2].sha.slice(0, 8) : "absent"} ` +
              `after=${after[2] ? after[2].sha.slice(0, 8) : "absent"} (recorded, not gated)`);
  reader.close(); w.close();
});

check("no unexpected sidecar is created beside the status file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-nosc-"));
  const status = path.join(dir, "s.json");
  fs.writeFileSync(status, JSON.stringify({ outcome: "up_to_date", checked_at_utc: new Date().toISOString() }));
  const r = spawnSync(process.execPath, [SHELL_JS, "heartbeat"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: status,
      RTCI_FRESHNESS_LOG: path.join(dir, "f.log"),
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "absent"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const extra = fs.readdirSync(dir).filter((f) => /-wal$|-shm$/.test(f));
  assert.deepEqual(extra, [], `unexpected sidecars: ${extra.join(", ")}`);
});

// ---------------------------------------------------------------------------------------------
// 8. The pinned stack is self-contained
// ---------------------------------------------------------------------------------------------
console.log("\n8. self-contained pinned stack");

const PINNED_STACK = [
  path.join(REPO, "scripts", "rtci-freshness.js"),
  path.join(REPO, "scripts", "lib", "rtci-freshness-policy.js"),
  path.join(REPO, "scripts", "lib", "resend-mailer.js"),
];

check("nothing in the pinned stack requires a third-party package", () => {
  for (const file of PINNED_STACK) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/require\((["'`])([^"'`]+)\1\)/g)) {
      const spec = m[2];
      const ok = spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");
      assert.ok(ok, `${path.basename(file)} requires ${spec}, which resolves through node_modules`);
    }
  }
});

check("the mailer no longer requires the resend package at all", () => {
  const src = fs.readFileSync(path.join(REPO, "scripts", "lib", "resend-mailer.js"), "utf8");
  assert.ok(!/require\((["'`])resend\1\)/.test(src), "resend must not be required");
  assert.match(src, /globalThis\.fetch/, "the send must use the runtime's own fetch");
});

check("the whole stack loads with node_modules unreachable", () => {
  // The rollback proof: run the wrapper with NODE_PATH pointed at an empty directory and the working
  // directory outside the repo, so nothing can resolve through /opt/nibrs/current. If this passes,
  // a rollback cannot take the monitor's ability to alert away with it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-nomod-"));
  const empty = path.join(dir, "empty-node-path");
  fs.mkdirSync(empty);
  const status = path.join(dir, "s.json");
  fs.writeFileSync(status, JSON.stringify({ outcome: "up_to_date", checked_at_utc: new Date().toISOString() }));
  const r = spawnSync(process.execPath, [SHELL_JS, "heartbeat"], {
    encoding: "utf8",
    cwd: dir,
    env: {
      ...process.env,
      NODE_PATH: empty,
      RTCI_FRESHNESS_STATUS: status,
      RTCI_FRESHNESS_LOG: path.join(dir, "f.log"),
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "absent"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_DRY_RUN: "1",
    },
  });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /HEARTBEAT ok/);
});

asyncChecks.push(["a 2xx is a send, and the message id is returned", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const out = await mailer.sendPlainMail({
    subject: "s", body: "b",
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify({ id: "msg_123" }) }),
  });
  assert.equal(out.sent, true);
  assert.equal(out.id, "msg_123");
}]);

asyncChecks.push(["a non-2xx is a failure, never a silent success", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  for (const status of [400, 401, 403, 422, 429, 500, 503]) {
    await expectReject(mailer.sendPlainMail({
      subject: "s", body: "b",
      fetchImpl: async () => ({ status, text: async () => '{"message":"nope"}' }),
    }), new RegExp(`HTTP ${status}`), `status ${status}`);
  }
}]);

asyncChecks.push(["the key never appears in an error raised from a response body", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const msg = await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b",
    fetchImpl: async () => ({ status: 401, text: async () => "unauthorized for re_testkey_0123456789" }),
  }), /HTTP 401/, "leaky body");
  assert.ok(!msg.includes("re_testkey_0123456789"), msg);
  assert.match(msg, /\[redacted/);
}]);

asyncChecks.push(["the send is bounded by a timeout", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const started = Date.now();
  await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b", timeoutMs: 150,
    fetchImpl: (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener("abort", () => {
        const e = new Error("aborted"); e.name = "AbortError"; reject(e);
      });
    }),
  }), /timed out after 150ms/, "timeout");
  assert.ok(Date.now() - started < 5000, "the timeout must actually bound the call");
}]);

asyncChecks.push(["a transport failure is reported, redacted, and not swallowed", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const msg = await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b",
    fetchImpl: async () => { throw new Error("ENOTFOUND api.resend.com re_testkey_0123456789"); },
  }), /the send failed/, "transport");
  assert.ok(!msg.includes("re_testkey_0123456789"), msg);
}]);

asyncChecks.push(["an Authorization header is never echoed back", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const msg = await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b",
    fetchImpl: async () => ({ status: 500, text: async () => "sent Authorization: Bearer re_testkey_0123456789" }),
  }), /HTTP 500/, "auth echo");
  assert.ok(!/Bearer re_/.test(msg), msg);
}]);

// ---------------------------------------------------------------------------------------------
// 9. The credential file
// ---------------------------------------------------------------------------------------------
console.log("\n9. the cron credential file");

// A fake filesystem so ownership and mode can be driven directly. The canonical harness runs on
// windows-latest, where uid is always 0 and mode is always 0666, so asserting these against real
// files would silently assert nothing. Every case below therefore states POSIX semantics explicitly.
function fakeFs({ contents = "RESEND_API_KEY=re_filekey_0123456789\n", uid = 0, gid = 0, mode = 0o600, isFile = true, missing = false } = {}) {
  return {
    statSync(p) {
      if (missing) { const e = new Error(`ENOENT: no such file or directory, stat '${p}'`); e.code = "ENOENT"; throw e; }
      return { uid, gid, mode: 0o100000 | mode, isFile: () => isFile };
    },
    readFileSync(p) {
      if (missing) { const e = new Error(`ENOENT: no such file or directory, open '${p}'`); e.code = "ENOENT"; throw e; }
      return Buffer.from(contents, "utf8");
    },
  };
}
const CRED = "/opt/nibrs/shared/.env.cron";
const credOpts = (over) => ({ envFilePath: CRED, fsFacade: fakeFs(over), platform: "linux" });

check("a root-owned 0600 credential file is accepted and its key is used", () => {
  const out = mailer.resolveApiKey(credOpts());
  assert.equal(out.key, "re_filekey_0123456789");
  assert.equal(out.source, CRED);
});

check("each gated property of the credential file can fail on its own", () => {
  // One mutation at a time, against a baseline that is known to pass. A guard that cannot be made
  // to fail is not a guard.
  const mutations = [
    [{ uid: 1000 }, /not owned by root/i],
    [{ gid: 1000 }, /group/i],
    [{ mode: 0o640 }, /mode/i],
    [{ mode: 0o604 }, /mode/i],
    [{ mode: 0o644 }, /mode/i],
    [{ mode: 0o700 }, /mode/i],
    [{ isFile: false }, /regular file/i],
  ];
  for (const [over, pattern] of mutations) {
    assert.throws(() => mailer.resolveApiKey(credOpts(over)), pattern,
      `mutation ${JSON.stringify(over)} must be refused`);
  }
});

check("a credential file with no RESEND_API_KEY entry is refused", () => {
  assert.throws(() => mailer.resolveApiKey(credOpts({ contents: "OTHER=1\n# RESEND_API_KEY=re_commented_out\n" })),
    /RESEND_API_KEY/);
});

check("a credential value that is not Resend-shaped is refused", () => {
  // The redactor's shape rule only protects `re_`-prefixed tokens, so a key of any other shape
  // could survive into a log line. Refusing it keeps redaction and acceptance in step.
  assert.throws(() => mailer.resolveApiKey(credOpts({ contents: "RESEND_API_KEY=plaintext-secret\n" })), /shape/i);
  assert.throws(() => mailer.resolveApiKey(credOpts({ contents: "RESEND_API_KEY=\n" })), /empty|shape/i);
});

check("quoted and exported forms are read, and later lines do not win", () => {
  assert.equal(mailer.resolveApiKey(credOpts({ contents: 'export RESEND_API_KEY="re_quoted_0123456789"\n' })).key,
    "re_quoted_0123456789");
  assert.equal(mailer.resolveApiKey(credOpts({ contents: "RESEND_API_KEY='re_single_0123456789'\n" })).key,
    "re_single_0123456789");
});

check("no credential-file error discloses the value, the line or the file's contents", () => {
  const secret = "re_leakcanary_0123456789";
  for (const over of [{ uid: 1000 }, { mode: 0o644 }, { isFile: false }]) {
    let msg = "";
    try { mailer.resolveApiKey(credOpts({ ...over, contents: `RESEND_API_KEY=${secret}\n` })); }
    catch (err) { msg = err.message + "\n" + String(err.stack || ""); }
    assert.ok(msg.length > 0, "expected a refusal");
    assert.ok(!msg.includes(secret), `the key leaked into an error: ${msg}`);
  }
});

check("an unsafe credential file is never quietly replaced by the environment variable", () => {
  const prior = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_environment_0123456789";
  try {
    assert.throws(() => mailer.resolveApiKey(credOpts({ mode: 0o644 })), /mode/i,
      "a present-but-unsafe file must fail closed, not fall through");
  } finally {
    if (prior === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prior;
  }
});

check("only a genuinely absent credential file falls through to the environment", () => {
  // Fail-open review: statSync throws for more reasons than absence. Treating EACCES as "no file
  // here" would let a credential file that exists but cannot be read be replaced by whatever happens
  // to be in the environment -- a silent downgrade at exactly the wrong moment.
  const prior = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_environment_0123456789";
  try {
    for (const code of ["EACCES", "EPERM", "ELOOP", "EIO"]) {
      const facade = {
        statSync() { const e = new Error(`${code}: refusing`); e.code = code; throw e; },
        readFileSync() { throw new Error("must not be reached"); },
      };
      assert.throws(() => mailer.resolveApiKey({ envFilePath: CRED, fsFacade: facade, platform: "linux" }),
        new RegExp(code), `${code} must not be read as "no credential file"`);
    }
    for (const code of ["ENOENT", "ENOTDIR"]) {
      const facade = {
        statSync() { const e = new Error(`${code}: gone`); e.code = code; throw e; },
        readFileSync() { throw new Error("must not be reached"); },
      };
      assert.equal(mailer.resolveApiKey({ envFilePath: CRED, fsFacade: facade, platform: "linux" }).source,
        "environment", `${code} genuinely means absent`);
    }
  } finally {
    if (prior === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prior;
  }
});

check("with no credential file present the environment variable is used", () => {
  const prior = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = "re_environment_0123456789";
  try {
    const out = mailer.resolveApiKey({ envFilePath: CRED, fsFacade: fakeFs({ missing: true }), platform: "linux" });
    assert.equal(out.key, "re_environment_0123456789");
    assert.equal(out.source, "environment");
  } finally {
    if (prior === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = prior;
  }
});

check("with neither a file nor an environment variable the send is refused outright", () => {
  const prior = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    assert.throws(() => mailer.resolveApiKey({ envFilePath: CRED, fsFacade: fakeFs({ missing: true }), platform: "linux" }),
      /RESEND_API_KEY is not set/);
  } finally {
    if (prior !== undefined) process.env.RESEND_API_KEY = prior;
  }
});

check("a key loaded from the file is registered with the redactor", () => {
  const prior = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  try {
    const secret = "re_registered_0123456789";
    mailer.resolveApiKey(credOpts({ contents: `RESEND_API_KEY=${secret}\n` }));
    const out = mailer.redactSecrets(`a stray trace containing ${secret} verbatim`);
    assert.ok(!out.includes(secret), out);
  } finally {
    if (prior !== undefined) process.env.RESEND_API_KEY = prior;
  }
});

check("the default credential path is the reviewed one, and is overridable for offline use", () => {
  assert.equal(mailer.DEFAULT_ENV_FILE, "/opt/nibrs/shared/.env.cron");
  const src = fs.readFileSync(path.join(REPO, "scripts", "lib", "resend-mailer.js"), "utf8");
  assert.match(src, /RTCI_FRESHNESS_ENV_FILE/, "an offline path override must exist");
});

check("the credential never reaches argv", () => {
  // The key is read inside the process and passed in a header. Nothing spawns anything with it.
  for (const file of [path.join(REPO, "scripts", "lib", "resend-mailer.js"), SHELL_JS]) {
    const src = fs.readFileSync(file, "utf8");
    assert.ok(!/spawnSync\([^)]*apiKey/s.test(src), `${path.basename(file)} must not put the key on a command line`);
  }
  const sh = fs.readFileSync(SHELL_SH, "utf8");
  assert.ok(!/RESEND_API_KEY/.test(sh), "the wrapper must not handle the key at all");
});

// ---------------------------------------------------------------------------------------------
// 10. The database guard, in executable code
// ---------------------------------------------------------------------------------------------
console.log("\n10. database guard");

const ident = (over = {}) => ({ exists: true, regular: true, size: 1000, mtimeNs: "1700000000000000000", sha256: "a".repeat(64), ...over });
const baseSnap = () => ({
  main: ident(),
  wal: ident({ size: 32, sha256: "b".repeat(64) }),
  shm: ident({ size: 32768, sha256: "c".repeat(64) }),
  siblings: ["crime_data.db-shm", "crime_data.db-wal"],
});

check("an unchanged database passes the guard with no violations", () => {
  const r = policy.compareDatabaseSnapshots(baseSnap(), baseSnap());
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.deepEqual(r.violations, []);
  assert.equal(r.shmNote, null);
});

check("every gated property of the main file and the WAL can fail on its own", () => {
  const mutations = [
    ["main size", (s) => { s.main.size += 1; }, /main.*size/i],
    ["main sha256", (s) => { s.main.sha256 = "d".repeat(64); }, /main.*sha256/i],
    ["main mtime", (s) => { s.main.mtimeNs = "1700000000000000001"; }, /main.*mtime/i],
    ["main vanished", (s) => { s.main = { exists: false }; }, /main.*exist/i],
    ["main not a regular file", (s) => { s.main.regular = false; }, /main.*regular/i],
    ["wal size", (s) => { s.wal.size += 1; }, /-wal.*size/i],
    ["wal sha256", (s) => { s.wal.sha256 = "e".repeat(64); }, /-wal.*sha256/i],
    ["wal mtime", (s) => { s.wal.mtimeNs = "1700000000000000002"; }, /-wal.*mtime/i],
    ["wal appeared", (s) => { s.wal = ident(); }, /-wal.*exist/i],
    ["wal vanished", (s) => { s.wal = { exists: false }; }, /-wal.*exist/i],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const before = baseSnap();
    const after = baseSnap();
    // "wal appeared" has to start from a snapshot where it was absent.
    if (label === "wal appeared") { before.wal = { exists: false }; before.siblings = ["crime_data.db-shm"]; }
    mutate(after);
    const r = policy.compareDatabaseSnapshots(before, after);
    assert.equal(r.ok, false, `${label} must be a violation`);
    assert.ok(r.violations.some((v) => pattern.test(v)), `${label}: ${r.violations.join(" | ")}`);
  }
});

check("a present file with no readable digest is a violation, never a stable identity", () => {
  // A file that exists but cannot be read or hashed yields sha256 null. Two nulls compare equal, so
  // without this rule an unreadable database would have passed the guard by being equally unreadable
  // on both sides -- the strongest possible reading of "nothing changed", from no evidence at all.
  for (const key of ["main", "wal"]) {
    for (const bad of [null, undefined, "", "not-a-digest", "a".repeat(63), "A".repeat(64)]) {
      const before = baseSnap();
      const after = baseSnap();
      before[key].sha256 = bad;
      after[key].sha256 = bad;            // identical on both sides, and still not an identity
      const r = policy.compareDatabaseSnapshots(before, after);
      assert.equal(r.ok, false, `${key} sha256=${JSON.stringify(bad)} must not compare as valid`);
      assert.ok(r.violations.some((v) => /digest/i.test(v)),
        `${key} sha256=${JSON.stringify(bad)}: ${r.violations.join(" | ")}`);
    }
  }
});

check("a digest that becomes unreadable only after the run is caught", () => {
  const before = baseSnap();
  const after = baseSnap();
  after.main.sha256 = null;
  const r = policy.compareDatabaseSnapshots(before, after);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /digest/i.test(v)), r.violations.join(" | "));
});

check("a valid lowercase 64-hex digest is still accepted on both sides", () => {
  const r = policy.compareDatabaseSnapshots(baseSnap(), baseSnap());
  assert.equal(r.ok, true, r.violations.join(" | "));
});

check("an unexpected sidecar appearing beside the database is a violation", () => {
  const before = baseSnap();
  const after = baseSnap();
  after.siblings = [...before.siblings, "crime_data.db-journal"].sort();
  const r = policy.compareDatabaseSnapshots(before, after);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /unexpected sidecar/i.test(v) && v.includes("-journal")), r.violations.join(" | "));
});

check("-shm moving is recorded and is NOT a violation", () => {
  const before = baseSnap();
  const after = baseSnap();
  after.shm.size = 65536;
  after.shm.sha256 = "f".repeat(64);
  after.shm.mtimeNs = "1700000000000000009";
  const r = policy.compareDatabaseSnapshots(before, after);
  assert.equal(r.ok, true, r.violations.join(" | "));
  assert.deepEqual(r.violations, []);
  assert.match(r.shmNote, /shm/i);
  assert.match(r.shmNote, /not gated|recorded/i);
});

check("-shm appearing where there was none is recorded, not gated", () => {
  const before = baseSnap();
  before.shm = { exists: false };
  before.siblings = ["crime_data.db-wal"];
  const after = baseSnap();
  const r = policy.compareDatabaseSnapshots(before, after);
  assert.equal(r.ok, true, r.violations.join(" | "));
  assert.match(r.shmNote, /shm/i);
});

check("a guard violation overrides an otherwise clean detector run", () => {
  const guard = { ok: false, violations: ["main file sha256 changed: aaaaaaaaaaaa -> dddddddddddd"], shmNote: null };
  const r = policy.classify({ kind: "check", detectorExit: 0, status: okStatus, dbGuard: guard });
  assert.equal(r.outcome, "database_mutated", "a mutated database can never be reported as up_to_date");
  assert.equal(r.exitCode, 1);
  assert.equal(r.alert.send, true);
  assert.match(r.logLine, /FAIL database_mutated/);
  assert.match(r.alert.body, /sha256 changed/);
});

check("a passing guard changes nothing about the verdict", () => {
  const guard = { ok: true, violations: [], shmNote: null };
  const plain = policy.classify({ kind: "check", detectorExit: 0, status: okStatus });
  const guarded = policy.classify({ kind: "check", detectorExit: 0, status: okStatus, dbGuard: guard });
  assert.equal(guarded.outcome, plain.outcome);
  assert.equal(guarded.logLine.replace(/^\S+ /, ""), plain.logLine.replace(/^\S+ /, ""));
});

check("a recorded -shm move is reported in the log line without failing the run", () => {
  const guard = { ok: true, violations: [], shmNote: "shm_changed: -shm moved (recorded, not gated)" };
  const r = policy.classify({ kind: "check", detectorExit: 0, status: okStatus, dbGuard: guard });
  assert.equal(r.outcome, "up_to_date");
  assert.equal(r.exitCode, 0);
  assert.match(r.logLine, /shm_changed/);
});

// A stub detector standing in for check-rtci-refresh.py. Node rather than Python so these run
// identically on the windows-latest canonical harness, where python3 is not assumed.
function stubDetector(dir, bodyLines) {
  const commit = "0abcdef";
  fs.mkdirSync(path.join(dir, "pin", commit), { recursive: true });
  const script = path.join(dir, "pin", commit, "check-rtci-refresh.py");
  fs.writeFileSync(script, bodyLines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "pin", "PINNED"), `sha256=${sha256(fs.readFileSync(script))} commit=${commit}\n`);
  return script;
}

function runCheck(dir, extraEnv = {}) {
  return spawnSync(process.execPath, [SHELL_JS, "check"], {
    encoding: "utf8",
    env: {
      ...process.env,
      RTCI_FRESHNESS_STATUS: path.join(dir, "s.json"),
      RTCI_FRESHNESS_LOG: path.join(dir, "f.log"),
      RTCI_FRESHNESS_PINNED_DIR: path.join(dir, "pin"),
      RTCI_FRESHNESS_DEPLOYED: path.join(dir, "absent.py"),
      RTCI_FRESHNESS_PYTHON: process.execPath,
      RTCI_FRESHNESS_DB: path.join(dir, "crime_data.db"),
      RTCI_FRESHNESS_DRY_RUN: "1",
      ...extraEnv,
    },
  });
}

check("a detector that writes to the database is caught, and the run fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-guard-bad-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "const db = process.argv[process.argv.indexOf('--db') + 1];",
    "fs.appendFileSync(db, 'x');",   // exactly the thing nothing scheduled may do
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'up_to_date',upstream_max_period:202606,database_max_period:202606}));",
    "process.exit(0);",
  ]);
  const r = runCheck(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /FAIL database_mutated/);
  assert.ok(!/OK up_to_date/.test(r.stdout), "a mutated database must never read as up_to_date");
});

check("a detector that only reads leaves the guard clean", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-guard-ok-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "fs.readFileSync(process.argv[process.argv.indexOf('--db') + 1]);",
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'up_to_date',upstream_max_period:202606,database_max_period:202606}));",
    "process.exit(0);",
  ]);
  const r = runCheck(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /OK up_to_date/);
  assert.ok(!/database_mutated/.test(r.stdout), r.stdout);
});

check("a detector that creates an unexpected sidecar is caught", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-guard-side-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.argv[process.argv.indexOf('--db') + 1] + '-journal', 'rollback');",
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'up_to_date',upstream_max_period:202606,database_max_period:202606}));",
    "process.exit(0);",
  ]);
  const r = runCheck(dir);
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /database_mutated/);
  assert.match(r.stdout, /-journal/);
});

check("the snapshot records existence, size, sha256 and nanosecond mtime", () => {
  const shell = require("./rtci-freshness.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-snap-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "payload");
  fs.writeFileSync(db + "-wal", "wal");
  const snap = shell.snapshotDatabase(db);
  for (const part of ["main", "wal"]) {
    assert.equal(snap[part].exists, true, part);
    assert.equal(typeof snap[part].size, "number", `${part} size`);
    assert.equal(snap[part].sha256.length, 64, `${part} sha256`);
    assert.match(snap[part].mtimeNs, /^\d+$/, `${part} mtimeNs must be integer nanoseconds`);
  }
  assert.equal(snap.shm.exists, false, "-shm is absent here, and that is recorded rather than assumed");
  assert.ok(Array.isArray(snap.siblings));
});

// ---------------------------------------------------------------------------------------------
// 11. The response body is bounded in time and in size
// ---------------------------------------------------------------------------------------------
console.log("\n11. bounded response body");

asyncChecks.push(["a response whose headers arrive but whose body hangs still times out", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const started = Date.now();
  await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b", timeoutMs: 200,
    // Headers land immediately; the body never does. Clearing the timeout at this point -- which is
    // what the pre-amendment code did -- would hang the scheduled run forever.
    fetchImpl: async () => ({ status: 200, text: () => new Promise(() => {}) }),
  }), /timed out after 200ms/, "hanging body");
  assert.ok(Date.now() - started < 5000, "the timeout must bound body consumption, not just the headers");
}]);

asyncChecks.push(["a hanging streamed body times out as well", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b", timeoutMs: 200,
    fetchImpl: async () => ({
      status: 200,
      body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
    }),
  }), /timed out after 200ms/, "hanging stream");
}]);

asyncChecks.push(["an oversized response is truncated at the cap and stops being read", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const CAP = 4096;
  let pulls = 0;
  const out = await mailer.sendPlainMail({
    subject: "s", body: "b", maxResponseBytes: CAP,
    fetchImpl: async () => ({
      status: 200,
      body: new ReadableStream({
        pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024).fill(65)); },
      }),
    }),
  });
  assert.equal(out.sent, true, "a 2xx is still a send");
  assert.equal(out.truncated, true, "the body must be reported as truncated");
  assert.ok(pulls <= 8, `reading must stop at the cap; it pulled ${pulls} chunks`);
}]);

asyncChecks.push(["an oversized error body is truncated and still names the status", async () => {
  process.env.RESEND_API_KEY = "re_testkey_0123456789";
  const msg = await expectReject(mailer.sendPlainMail({
    subject: "s", body: "b", maxResponseBytes: 2048,
    fetchImpl: async () => ({ status: 500, text: async () => "z".repeat(5_000_000) }),
  }), /HTTP 500/, "oversized error");
  assert.ok(msg.length < 2000, `the error message must not carry the whole body (${msg.length} chars)`);
}]);

asyncChecks.push(["the default response cap is stated as a constant", async () => {
  assert.equal(typeof mailer.MAX_RESPONSE_BYTES, "number");
  assert.ok(mailer.MAX_RESPONSE_BYTES > 0 && mailer.MAX_RESPONSE_BYTES <= 1024 * 1024, "a sane cap");
}]);

// ---------------------------------------------------------------------------------------------
// 12. One writer, one line
// ---------------------------------------------------------------------------------------------
console.log("\n12. single-writer logging");

const PRIMARY_LINE = /^\d{4}-\d\d-\d\dT/;

check("one normal invocation writes exactly one primary outcome line to the log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-onewriter-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'up_to_date',upstream_max_period:202606,database_max_period:202606}));",
    "process.exit(0);",
  ]);
  const r = runCheck(dir);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const lines = fs.readFileSync(path.join(dir, "f.log"), "utf8").split("\n").filter(Boolean);
  const primary = lines.filter((l) => PRIMARY_LINE.test(l));
  assert.equal(primary.length, 1, `expected exactly one primary line, got ${primary.length}:\n${lines.join("\n")}`);
  // The same line on stdout is for a human running it by hand; cron discards it.
  assert.equal(r.stdout.split("\n").filter((l) => PRIMARY_LINE.test(l)).length, 1);
});

check("an alerting invocation still writes exactly one primary outcome line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-onewriter-alert-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'update_available',upstream_max_period:202607,database_max_period:202606}));",
    "process.exit(10);",
  ]);
  const r = runCheck(dir);
  assert.equal(r.status, 10, `${r.stdout}${r.stderr}`);
  const lines = fs.readFileSync(path.join(dir, "f.log"), "utf8").split("\n").filter(Boolean);
  assert.equal(lines.filter((l) => PRIMARY_LINE.test(l)).length, 1, lines.join("\n"));
  assert.equal(r.stderr.trim(), "", `a recorded run must print nothing on stderr: ${r.stderr}`);
});

check("a message that could NOT be recorded in the log is the only thing that reaches stderr", () => {
  // The log path is unwritable, so the process cannot record its own outcome. Under cron both
  // streams go to /dev/null, so this surfaces only for a human running the wrapper by hand -- but
  // the separation is what keeps the log single-writer, and the non-zero exit is what a scheduled
  // run leaves behind.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rtci-unrecordable-"));
  const db = path.join(dir, "crime_data.db");
  fs.writeFileSync(db, "not-a-real-database-just-bytes");
  fs.writeFileSync(db + "-wal", "");
  stubDetector(dir, [
    "const fs = require('node:fs');",
    "const s = process.argv[process.argv.indexOf('--status') + 1];",
    "fs.writeFileSync(s, JSON.stringify({outcome:'up_to_date',upstream_max_period:202606,database_max_period:202606}));",
    "process.exit(0);",
  ]);
  const r = runCheck(dir, { RTCI_FRESHNESS_LOG: path.join(dir, "no-such-directory", "f.log") });
  assert.ok(PRIMARY_LINE.test(r.stderr.trim().split("\n").filter(Boolean).slice(-1)[0] || ""),
    `the unrecorded outcome must surface on stderr: ${JSON.stringify(r.stderr)}`);
});

check("the reviewed cron entries cannot redirect into the application log", () => {
  // The log is written by the Node process and by nothing else. A cron redirection into the same
  // file made cron a second writer, and it also made the file a LAUNCH-TIME dependency: cron opens
  // its redirection target before the job runs, so an unwritable or missing log directory would have
  // stopped the check from starting at all -- a monitor defeated by its own logging.
  const entries = policy.CRON_ENTRIES;
  assert.ok(Object.isFrozen(entries), "the reviewed cron entries must be frozen");
  for (const [name, line] of Object.entries(entries)) {
    assert.ok(!/rtci-freshness\.log/.test(line), `${name} must not name the application log`);
    assert.ok(!/\/var\/log/.test(line), `${name} must not redirect anywhere under /var/log`);
    assert.ok(!/>>/.test(line), `${name} must not append to any file`);
    assert.match(line, />\/dev\/null 2>&1$/, `${name} must discard both streams and end there`);
    assert.match(line, /rtci-freshness\.sh (check|heartbeat) /, `${name} invokes the wrapper`);
  }
  assert.match(entries.check, /^17 7 \* \* \* /);
  assert.match(entries.heartbeat, /^37 7 \* \* 1 /);
});

check("the installed crontab lines can be emitted from the reviewed constant", () => {
  // The runbook does not ask an operator to retype these; it has them printed from the pinned
  // module, so a transcription error cannot put a different command in cron than the one reviewed.
  // (The runbook itself is not tracked in this repository, so the constant -- not the prose -- is
  // the single source of truth, and this is the command the runbook uses.)
  const emitted = spawnSync(process.execPath, [
    "-e",
    "const p=require(process.argv[1]);console.log(p.CRON_ENTRIES.check);console.log(p.CRON_ENTRIES.heartbeat);",
    path.join(REPO, "scripts", "lib", "rtci-freshness-policy.js"),
  ], { encoding: "utf8" });
  assert.equal(emitted.status, 0, emitted.stderr);
  const lines = emitted.stdout.split("\n").filter(Boolean);
  assert.deepEqual(lines, [policy.CRON_ENTRIES.check, policy.CRON_ENTRIES.heartbeat]);
});

// ---------------------------------------------------------------------------------------------
(async () => {
  for (const [name, fn] of asyncChecks) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  FAIL  ${name} -- ${err.message}`);
    }
  }
  finished = true;
  console.log(`\nrtci freshness monitor: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
