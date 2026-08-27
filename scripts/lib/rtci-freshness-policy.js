/**
 * Every decision the RTCI freshness monitor makes, as pure functions.
 *
 * The IO shell (scripts/rtci-freshness.js) reads files, takes the lock and sends mail. It makes no
 * judgements. Everything that decides an outcome, an exit code, a log line or whether a human is
 * woken lives here, so it can be tested without a database, a lock, a network or a clock.
 *
 * THREE STATES, PLUS THE ONES THE MONITOR CAN BE IN ITSELF. The detector answers a question about
 * the data; the monitor can also be broken, skipped, or running code that is not the deployed code.
 * Collapsing those into "OK / not OK" is how a monitor ends up reporting health while doing nothing,
 * which is exactly what /opt/nibrs/auto-update-rtci.sh did every morning from April to August.
 */
"use strict";

/** Detector exit codes, from scripts/check-rtci-refresh.py. */
const EXIT_UP_TO_DATE = 0;
const EXIT_UPDATE_AVAILABLE = 10;
const EXIT_CHECK_FAILED = 1;

/**
 * A lock skip is harmless once -- the previous run is still going. It stops being harmless when no
 * run has SUCCEEDED for long enough that the schedule should have produced several. At a daily
 * cadence, 36 hours means at least one whole run was missed rather than merely delayed.
 */
const STALE_AFTER_MS = 36 * 60 * 60 * 1000;

function describeBinding(binding) {
  if (!binding) return [];
  const notes = [];
  if (binding.deployedPresent === false) {
    notes.push("detector_absent_from_release: the deployed release carries no detector, so the " +
      "pinned copy is the only one; expected after a rollback to a release before ab9a3e75");
  } else if (binding.deployedSha && binding.pinnedSha && binding.deployedSha !== binding.pinnedSha) {
    notes.push(`detector_drift: pinned ${binding.pinnedSha.slice(0, 12)} != deployed ` +
      `${binding.deployedSha.slice(0, 12)}; the monitor is not running the deployed detector`);
  }
  return notes;
}

/**
 * Decide everything from one observation.
 *
 * `kind` is "check" (the detector ran), "locked" (another run held the lock) or "heartbeat".
 * Returns { outcome, logLine, exitCode, alert: { send, subject, body } }.
 */
function classify(observation) {
  const {
    kind,
    detectorExit = null,
    status = null,
    detectorStderr = "",
    lastSuccessAgeMs = null,
    binding = null,
    nowIso = new Date().toISOString(),
    recentOutcomes = [],
  } = observation;

  const notes = describeBinding(binding);
  const noteSuffix = notes.length ? ` [${notes.join("; ")}]` : "";
  const upstream = status && status.upstream_max_period != null ? status.upstream_max_period : "?";
  const database = status && status.database_max_period != null ? status.database_max_period : "?";

  if (kind === "heartbeat") {
    const lines = recentOutcomes.length
      ? recentOutcomes.map((o) => `  ${o}`).join("\n")
      : "  (no runs recorded yet)";
    const ageHours = lastSuccessAgeMs == null ? null : Math.floor(lastSuccessAgeMs / 3600000);
    const stale = lastSuccessAgeMs == null || lastSuccessAgeMs > STALE_AFTER_MS;
    return {
      outcome: stale ? "heartbeat_stalled" : "heartbeat_ok",
      logLine: `${nowIso} HEARTBEAT ${stale ? "STALLED" : "ok"} last_success_age_hours=${ageHours == null ? "never" : ageHours}${noteSuffix}`,
      exitCode: stale ? 1 : 0,
      alert: {
        send: true,   // the heartbeat's whole purpose is to be sent
        subject: stale
          ? "RTCI freshness monitor: NO SUCCESSFUL CHECK IN 36+ HOURS"
          : "RTCI freshness monitor: weekly heartbeat",
        body: [
          stale
            ? "The freshness monitor has not recorded a successful check in over 36 hours."
            : "The freshness monitor is running. Recent outcomes:",
          "",
          lines,
          "",
          ageHours == null ? "Last successful check: never" : `Last successful check: ${ageHours} hours ago`,
          ...(notes.length ? ["", ...notes] : []),
        ].join("\n"),
      },
    };
  }

  if (kind === "locked") {
    const stale = lastSuccessAgeMs != null && lastSuccessAgeMs > STALE_AFTER_MS;
    const neverSucceeded = lastSuccessAgeMs == null;
    if (stale || neverSucceeded) {
      const ageHours = lastSuccessAgeMs == null ? "never" : Math.floor(lastSuccessAgeMs / 3600000);
      return {
        outcome: "monitor_stalled",
        logLine: `${nowIso} FAIL monitor_stalled lock_held last_success_age_hours=${ageHours}${noteSuffix}`,
        exitCode: 1,
        alert: {
          send: true,
          subject: "RTCI freshness monitor: STALLED (lock held, no recent success)",
          body: [
            "A scheduled freshness check could not take its lock, and no successful check has been",
            "recorded recently. A previous run is most likely hung.",
            "",
            `Last successful check: ${ageHours === "never" ? "never" : ageHours + " hours ago"}`,
            "",
            "No database was read and nothing was written. Inspect the holding process before acting.",
            ...(notes.length ? ["", ...notes] : []),
          ].join("\n"),
        },
      };
    }
    return {
      outcome: "skipped_locked",
      logLine: `${nowIso} SKIP skipped_locked another run holds the lock${noteSuffix}`,
      exitCode: 0,
      alert: { send: false, subject: null, body: null },
    };
  }

  if (detectorExit === EXIT_UP_TO_DATE) {
    return {
      outcome: "up_to_date",
      logLine: `${nowIso} OK up_to_date upstream=${upstream} database=${database}${noteSuffix}`,
      exitCode: 0,
      alert: { send: false, subject: null, body: null },
    };
  }

  if (detectorExit === EXIT_UPDATE_AVAILABLE) {
    return {
      outcome: "update_available",
      logLine: `${nowIso} STALE update_available upstream=${upstream} database=${database}${noteSuffix}`,
      exitCode: EXIT_UPDATE_AVAILABLE,
      alert: {
        send: true,
        subject: `RTCI: upstream has ${upstream}, the database has ${database}`,
        body: [
          "Upstream RTCI has published a period the served database does not have.",
          "",
          `  upstream period : ${upstream}`,
          `  database period : ${database}`,
          "",
          "Nothing was imported and nothing was written -- this monitor only reports.",
          "Importing is a separate, separately authorized operation.",
          ...(notes.length ? ["", ...notes] : []),
        ].join("\n"),
      },
    };
  }

  // Anything else, including a detector that could not run at all.
  const reason = (detectorStderr || "").trim().split("\n").slice(-1)[0] || `exit ${detectorExit}`;
  return {
    outcome: "check_failed",
    logLine: `${nowIso} FAIL check_failed exit=${detectorExit} reason=${reason}${noteSuffix}`,
    exitCode: 1,
    alert: {
      send: true,
      subject: "RTCI freshness check FAILED",
      body: [
        "The RTCI freshness detector did not complete.",
        "",
        `  exit code : ${detectorExit}`,
        `  reason    : ${reason}`,
        "",
        "Freshness is UNKNOWN as a result -- this is not the same as up to date.",
        ...(notes.length ? ["", ...notes] : []),
      ].join("\n"),
    },
  };
}

/** Age of the last recorded success, or null when there has never been one. */
function lastSuccessAgeMs(statusRecord, now = Date.now()) {
  if (!statusRecord || statusRecord.outcome !== "up_to_date" || !statusRecord.checked_at_utc) return null;
  const t = Date.parse(statusRecord.checked_at_utc);
  return Number.isFinite(t) ? now - t : null;
}

/**
 * What the observational run may gate on, and what it may only record.
 *
 * SQLite's -shm is reader-coordination state. While workers answer queries it can legitimately
 * change without anything having written the database, so gating on it would make a healthy monitor
 * look like a production write. The main file and the WAL are different: a change there really would
 * mean the database moved under the check.
 *
 * The FIRST controlled observational run may additionally require exact equality across all three,
 * because it is run deliberately and its concurrency is known. That is a stricter one-off gate, not
 * the standing rule, and it is recorded as such.
 */
const OBSERVATIONAL_SIDECAR_POLICY = Object.freeze({
  main: "gated: size, sha256 and mtime must be unchanged",
  wal: "gated: size, sha256 and mtime must be unchanged",
  shm: "recorded before and after, NOT gated -- a concurrent change is not evidence of a write",
  creation: "gated: no unexpected sidecar may be created",
  firstControlledRun:
    "may require exact equality across main, -wal and -shm, because its concurrency is known",
});

module.exports = {
  classify,
  OBSERVATIONAL_SIDECAR_POLICY,
  lastSuccessAgeMs,
  describeBinding,
  STALE_AFTER_MS,
  EXIT_UP_TO_DATE,
  EXIT_UPDATE_AVAILABLE,
  EXIT_CHECK_FAILED,
};
