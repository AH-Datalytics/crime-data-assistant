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
 * Compare a database identity snapshot taken before a detector run with one taken after it.
 *
 * THIS IS THE GUARD ITSELF, not a description of one. An earlier revision stated the rule in a
 * frozen object of prose and tested the prose, which proves only that the sentence still reads the
 * same way -- a detector that rewrote the database would have passed every one of those assertions.
 *
 * The main file and the WAL are gated on existence, size, SHA-256 and nanosecond mtime, and any
 * sidecar appearing that was not there before is a violation. `-shm` is the deliberate exception: it
 * is reader-coordination state that legitimately moves while workers answer queries, so it is
 * recorded on both sides and reported, and never on its own a failure.
 *
 * A snapshot is { main, wal, shm, siblings[] }, each of the first three being
 * { exists:false } or { exists:true, regular, size, mtimeNs, sha256 }.
 */
/** A digest we are willing to call an identity: exactly 64 lowercase hex characters, and nothing else. */
function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function compareDatabaseSnapshots(before, after) {
  const violations = [];
  if (!before || !after) return { ok: true, violations, shmNote: null };

  for (const [key, label] of [["main", "main file"], ["wal", "-wal"]]) {
    const b = before[key] || { exists: false };
    const a = after[key] || { exists: false };
    if (b.exists !== a.exists) {
      violations.push(`${label} existence changed: ${b.exists ? "present" : "absent"} -> ${a.exists ? "present" : "absent"}`);
      continue;
    }
    if (!a.exists) continue;
    if (a.regular === false || b.regular === false) {
      violations.push(`${label} is not a regular file`);
      continue;
    }
    if (b.size !== a.size) violations.push(`${label} size changed: ${b.size} -> ${a.size}`);
    // A file that is present but cannot be read yields a null digest, and two nulls compare equal.
    // Without this, an unreadable database would pass the guard by being equally unreadable on both
    // sides -- the strongest possible reading of "nothing changed", drawn from no evidence at all.
    const bDigest = isDigest(b.sha256);
    const aDigest = isDigest(a.sha256);
    if (!bDigest || !aDigest) {
      const when = !bDigest && !aDigest ? "before or after" : (!bDigest ? "before" : "after");
      violations.push(`${label} has no readable digest ${when} the run; an unhashable file is not a ` +
        "stable identity and is never treated as unchanged");
    } else if (b.sha256 !== a.sha256) {
      violations.push(`${label} sha256 changed: ${b.sha256.slice(0, 12)} -> ${a.sha256.slice(0, 12)}`);
    }
    if (b.mtimeNs !== a.mtimeNs) violations.push(`${label} mtime changed: ${b.mtimeNs} -> ${a.mtimeNs}`);
  }

  // Anything new beside the database. -wal is already covered above by name; -shm is the exception.
  const seen = new Set(before.siblings || []);
  for (const name of after.siblings || []) {
    if (seen.has(name)) continue;
    if (/-shm$/.test(name) || /-wal$/.test(name)) continue;
    violations.push(`unexpected sidecar created: ${name}`);
  }

  const bShm = before.shm || { exists: false };
  const aShm = after.shm || { exists: false };
  let shmNote = null;
  if (!bShm.exists && aShm.exists) {
    shmNote = "shm_created: -shm appeared during the run (recorded, not gated -- it is reader state)";
  } else if (bShm.exists && !aShm.exists) {
    shmNote = "shm_removed: -shm disappeared during the run (recorded, not gated -- it is reader state)";
  } else if (bShm.exists && aShm.exists &&
      (bShm.size !== aShm.size || bShm.sha256 !== aShm.sha256 || bShm.mtimeNs !== aShm.mtimeNs)) {
    shmNote = "shm_changed: -shm moved during the run (recorded, not gated -- it is reader state)";
  }

  return { ok: violations.length === 0, violations, shmNote };
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
    dbGuard = null,
    nowIso = new Date().toISOString(),
    recentOutcomes = [],
  } = observation;

  const notes = describeBinding(binding);
  if (dbGuard && dbGuard.shmNote) notes.push(dbGuard.shmNote);
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

  // A database that moved under a read-only check outranks whatever the detector concluded. Nothing
  // scheduled here may write production data, so if the bytes changed, the verdict is not "fresh" --
  // it is "something wrote to the database while we were reading it".
  if (kind === "check" && dbGuard && dbGuard.ok === false) {
    const violations = dbGuard.violations || [];
    return {
      outcome: "database_mutated",
      logLine: `${nowIso} FAIL database_mutated ${violations.join("; ")}${noteSuffix}`,
      exitCode: 1,
      alert: {
        send: true,
        subject: "RTCI freshness monitor: THE DATABASE CHANGED DURING A READ-ONLY CHECK",
        body: [
          "The served database did not have the same identity before and after the freshness check.",
          "The check is read-only, so this was not the monitor -- something else wrote to the file,",
          "or a swap happened underneath the run.",
          "",
          ...violations.map((v) => `  ${v}`),
          "",
          "The freshness verdict for this run is being discarded: it describes a database that no",
          "longer exists in the state it was read in. Nothing was imported and nothing was written.",
          ...(notes.length ? ["", ...notes] : []),
        ].join("\n"),
      },
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
 * The one part of the sidecar rule that is a human procedure rather than code.
 *
 * The standing rule is compareDatabaseSnapshots() above and is proved by mutation tests. What cannot
 * live in code is the stricter one-off gate the FIRST controlled observational run is held to: an
 * operator running the check by hand knows the host's concurrency, so exact equality across main,
 * -wal and -shm is a reasonable demand of that run and an unreasonable one of every run afterwards.
 */
const OBSERVATIONAL_SIDECAR_POLICY = Object.freeze({
  standingRule:
    "implemented in compareDatabaseSnapshots(): main and -wal gated on existence, size, sha256 and " +
    "nanosecond mtime; unexpected sidecars gated; -shm recorded and never gated",
  firstControlledRun:
    "operator procedure, not code: the first hand-run check may additionally require exact equality " +
    "across main, -wal and -shm, because its concurrency is known",
});

/**
 * The reviewed crontab entries, verbatim and in one place.
 *
 * CRON REDIRECTS NOWHERE. Structured logging is internal to the Node process, which is the log's only
 * writer. An earlier revision had cron append stderr to the same file, which was wrong twice over:
 * it made cron a second writer, and it made the log a **launch-time dependency**. cron opens its
 * redirection target before the job runs, so a missing directory, a full disk or a bad mode on
 * /var/log/rtci-freshness.log would have stopped the check from starting at all -- a monitor
 * defeated by its own logging, which is the failure this whole increment exists to prevent.
 *
 * Both streams therefore go to /dev/null. Nothing is lost that could have reached a human anyway:
 * this host has no MTA, so cron's own output is discarded regardless, and the alerting path is
 * Resend. Whatever the process could not record is reported by the weekly heartbeat, which reads the
 * log and the status record rather than depending on cron having captured anything.
 *
 * TIMES ARE LOCAL, NOT UTC. The crontab declares CRON_TZ=America/Chicago, so `17 7` is 07:17
 * America/Chicago. Reading these as UTC would put the check in the middle of the night and adjacent
 * to jobs it was placed to avoid. The installation procedure verifies CRON_TZ before installing.
 *
 * The installation procedure emits these from here rather than transcribing them, so the crontab and
 * the reviewed code cannot drift.
 */
const CRON_PREFIX = "RTCI_FRESHNESS_PINNED_DIR=/opt/nibrs/tools/rtci-detector " +
  "bash /opt/nibrs/tools/rtci-freshness/current/rtci-freshness.sh";
const CRON_ENTRIES = Object.freeze({
  check: `17 7 * * * ${CRON_PREFIX} check >/dev/null 2>&1`,
  heartbeat: `37 7 * * 1 ${CRON_PREFIX} heartbeat >/dev/null 2>&1`,
});

module.exports = {
  classify,
  compareDatabaseSnapshots,
  OBSERVATIONAL_SIDECAR_POLICY,
  CRON_ENTRIES,
  lastSuccessAgeMs,
  describeBinding,
  STALE_AFTER_MS,
  EXIT_UP_TO_DATE,
  EXIT_UPDATE_AVAILABLE,
  EXIT_CHECK_FAILED,
};
