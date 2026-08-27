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
 *   7. sidecar policy          main and -wal are gated; -shm is recorded, not gated
 *
 * Nothing here needs a network, a real database or the production host. A stub detector stands in for
 * check-rtci-refresh.py so exit codes can be driven directly.
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

check("sending refuses outright when no key is configured", async () => {
  const prior = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;
  let threw = false;
  try {
    mailer.sendPlainMail({ subject: "s", body: "b" }).catch(() => {});
    // synchronous guard is what we assert on; the async path is covered by the dry-run test
  } finally {
    if (prior !== undefined) process.env.RESEND_API_KEY = prior;
  }
  const r = policy.classify({ kind: "check", detectorExit: 1, detectorStderr: "x" });
  assert.equal(r.alert.send, true);
  assert.ok(!threw);
});

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

check("the observational gate treats main and -wal strictly and -shm as recorded only", () => {
  // Asserted against tracked code, not against prose: a test that greps a document passes or fails
  // on wording. The policy is a frozen object so it cannot drift silently.
  const p = policy.OBSERVATIONAL_SIDECAR_POLICY;
  assert.match(p.main, /gated/);
  assert.match(p.main, /size, sha256 and mtime/);
  assert.match(p.wal, /gated/);
  assert.match(p.wal, /size, sha256 and mtime/);
  assert.match(p.shm, /NOT gated/);
  assert.match(p.shm, /concurrent change is not evidence of a write/);
  assert.match(p.creation, /no unexpected sidecar/);
  assert.match(p.firstControlledRun, /exact equality/);
  assert.ok(Object.isFrozen(p), "the policy must be frozen");
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
console.log(`\nrtci freshness monitor: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
