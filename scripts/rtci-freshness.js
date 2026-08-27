#!/usr/bin/env node
/**
 * The RTCI freshness monitor's IO shell. It reads, runs, logs and mails; it decides nothing.
 *
 * Every judgement lives in scripts/lib/rtci-freshness-policy.js and every send in
 * scripts/lib/resend-mailer.js, so this file is the only part that has to be reasoned about in terms
 * of the filesystem and the network.
 *
 * IT RUNS THE DETECTOR AND NOTHING ELSE. The detector's whole CLI is `--db` and `--status`; there is
 * no flag that imports, deploys, or writes the database. This shell adds no other argument and
 * invokes no other program, so nothing scheduled here can write production data. The one file it
 * writes besides its own log is the status record, and the detector writes that atomically.
 *
 *   node scripts/rtci-freshness.js check       # the detector ran (called with the lock held)
 *   node scripts/rtci-freshness.js locked      # the lock was NOT available
 *   node scripts/rtci-freshness.js heartbeat   # independent; never takes the lock
 *
 * `heartbeat` is deliberately reachable without the lock. A heartbeat behind the same lock as the
 * check would be suppressed by exactly the hung run it exists to report.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const policy = require("./lib/rtci-freshness-policy.js");
const mailer = require("./lib/resend-mailer.js");

const DB = process.env.RTCI_FRESHNESS_DB || "/opt/nibrs/shared/crime_data.db";
const STATUS = process.env.RTCI_FRESHNESS_STATUS || "/opt/nibrs/shared/rtci-refresh-status.json";
const LOG = process.env.RTCI_FRESHNESS_LOG || "/var/log/rtci-freshness.log";
const PINNED_DIR = process.env.RTCI_FRESHNESS_PINNED_DIR || "/opt/nibrs/tools/rtci-detector";
const DEPLOYED = process.env.RTCI_FRESHNESS_DEPLOYED || "/opt/nibrs/current/scripts/check-rtci-refresh.py";
const PYTHON = process.env.RTCI_FRESHNESS_PYTHON || "python3";
const STATUS_MODE = 0o644;   // the reviewed mode: a monitoring artifact meant to be readable
const DRY_RUN = process.env.RTCI_FRESHNESS_DRY_RUN === "1";

function sha256(file) {
  try {
    return require("node:crypto").createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function appendLog(line) {
  try {
    fs.appendFileSync(LOG, mailer.redactSecrets(line) + "\n");
  } catch (err) {
    process.stderr.write(`could not write ${LOG}: ${err.message}\n`);
  }
}

/** The pinned detector and how it compares to whatever the current release carries. */
function readBinding() {
  const pinnedRecord = (() => {
    try {
      return fs.readFileSync(path.join(PINNED_DIR, "PINNED"), "utf8").trim();
    } catch {
      return null;
    }
  })();
  let pinnedScript = null;
  let pinnedSha = null;
  if (pinnedRecord) {
    const m = pinnedRecord.match(/^sha256=([0-9a-f]{64})\s+commit=([0-9a-f]{7,40})/m);
    if (m) {
      pinnedSha = m[1];
      pinnedScript = path.join(PINNED_DIR, m[2], "check-rtci-refresh.py");
    }
  }
  const deployedPresent = fs.existsSync(DEPLOYED);
  return {
    pinnedScript,
    pinnedSha,
    pinnedShaOnDisk: pinnedScript ? sha256(pinnedScript) : null,
    deployedPresent,
    deployedSha: deployedPresent ? sha256(DEPLOYED) : null,
  };
}

/** The last few outcomes, for the heartbeat body. Log-derived, so it needs no extra state. */
function recentOutcomes(limit = 8) {
  try {
    return fs.readFileSync(LOG, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
  } catch {
    return [];
  }
}

async function emit(result) {
  appendLog(result.logLine);
  process.stdout.write(result.logLine + "\n");
  if (result.alert.send) {
    try {
      const sent = await mailer.sendPlainMail({
        subject: result.alert.subject,
        body: result.alert.body,
        dryRun: DRY_RUN,
      });
      appendLog(`  alert ${sent.dryRun ? "rendered (dry run)" : "sent"}: ${result.alert.subject}`);
    } catch (err) {
      // An alert that cannot be delivered must not be swallowed: the run fails loudly instead.
      const msg = mailer.redactSecrets(`  ALERT DELIVERY FAILED: ${err.message}`);
      appendLog(msg);
      process.stderr.write(msg + "\n");
      process.exitCode = 1;
      return;
    }
  }
  process.exitCode = result.exitCode;
}

async function main() {
  const mode = process.argv[2];
  const binding = readBinding();
  const previous = readJson(STATUS);
  const ageBefore = policy.lastSuccessAgeMs(previous);

  if (mode === "heartbeat") {
    // No lock, no database, no detector: it reports on the monitor, not on the data.
    return emit(policy.classify({
      kind: "heartbeat", lastSuccessAgeMs: ageBefore, binding, recentOutcomes: recentOutcomes(),
    }));
  }

  if (mode === "locked") {
    // Deliberately touches no database and runs no detector.
    return emit(policy.classify({ kind: "locked", lastSuccessAgeMs: ageBefore, binding }));
  }

  if (mode !== "check") {
    process.stderr.write("usage: rtci-freshness.js check | locked | heartbeat\n");
    process.exitCode = 2;
    return;
  }

  if (!binding.pinnedScript || !fs.existsSync(binding.pinnedScript)) {
    return emit(policy.classify({
      kind: "check", detectorExit: -1, binding,
      detectorStderr: `no pinned detector at ${PINNED_DIR} (PINNED record missing or unreadable)`,
    }));
  }
  if (binding.pinnedSha !== binding.pinnedShaOnDisk) {
    return emit(policy.classify({
      kind: "check", detectorExit: -1, binding,
      detectorStderr: `pinned detector hash mismatch: PINNED says ${String(binding.pinnedSha).slice(0, 12)}, ` +
        `file is ${String(binding.pinnedShaOnDisk).slice(0, 12)}`,
    }));
  }

  const run = spawnSync(PYTHON, [binding.pinnedScript, "--db", DB, "--status", STATUS],
    { encoding: "utf8", timeout: 15 * 60 * 1000 });
  const detectorExit = run.status === null ? -1 : run.status;

  // The reviewed mode, set explicitly rather than inherited from mkstemp's 0600.
  try {
    if (fs.existsSync(STATUS)) fs.chmodSync(STATUS, STATUS_MODE);
  } catch (err) {
    process.stderr.write(`could not set the status mode: ${err.message}\n`);
  }

  return emit(policy.classify({
    kind: "check",
    detectorExit,
    status: readJson(STATUS),
    detectorStderr: run.stderr || (run.error ? run.error.message : ""),
    lastSuccessAgeMs: ageBefore,
    binding,
  }));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(mailer.redactSecrets(String(err && err.stack ? err.stack : err)) + "\n");
    process.exitCode = 1;
  });
}

module.exports = { readBinding, recentOutcomes, STATUS_MODE };
