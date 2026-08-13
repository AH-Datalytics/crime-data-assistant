/**
 * Whether a shared chart genuinely came from a proven answer.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §4 — "newly created embeds require a valid originating proof ... Legacy embeds
 * without adequate proof must not be silently treated as compliant."
 *
 * TWO WAYS THE FIRST VERSION OF THIS WAS WRONG, both of which made "proven origin" a
 * label rather than a property:
 *
 *   1. NOTHING BOUND THE REQUEST TO THE ARTIFACT. It looked up a request id and read
 *      that row's delivery_action. Any valid request id therefore blessed ANY SQL the
 *      client cared to submit — a chart could claim provenance from an answer it had
 *      no relationship to. The fix is to compare the client's payload against what the
 *      SERVER logged for that request: same tab, same SQL, same chart configuration.
 *      The client cannot forge that, because the comparison is against the server's
 *      own record; the only way to "pass" is to actually be that answer.
 *
 *   2. delivery_action WAS TREATED AS PROOF. In shadow, delivery_action records what
 *      was ACTUALLY SERVED, which is `answer` for every legacy answer in the system —
 *      including ones whose proof was blocked. The value that says whether proof
 *      passed is hypotheticalAction inside the stored envelope, which exists precisely
 *      to separate the two. Reading the wrong one meant every shadow-era answer looked
 *      proven.
 *
 * WHAT A VERIFIED ORIGIN MEANS HERE. The chart's SQL is the SQL of a specific logged
 * answer, and that answer's proof envelope had no blocker. It does NOT mean the
 * numbers are currently correct — the source may have changed underneath. That is what
 * the read-time finalization is for.
 */

import { createHash } from "node:crypto";
import { queryLogHasColumn } from "./query-log-columns";

/** Why an origin is or is not verified. Recorded, and surfaced to the reviewer. */
export type OriginState =
  /** Bound to a logged answer whose proof envelope had no blocker. */
  | "verified"
  /** Bound to a logged answer, but that answer's proof did not pass. */
  | "bound_unproven"
  /** A request id was supplied but does not match a logged answer for this artifact. */
  | "unbound"
  /** No request id was supplied. Legacy charts and older clients. */
  | "absent";

export interface OriginVerdict {
  state: OriginState;
  /** Human-readable explanation, recorded for the reviewer queue. */
  reason: string;
  /** The delivery action the originating answer actually served, when found. */
  deliveryAction: string | null;
  /** The proof mode that answer was produced under, when found. */
  proofMode: string | null;
}

export interface OriginCandidate {
  requestId: string | null;
  tab: string;
  sql: string;
  /** Pre-serialized through lib/chart-config-log, so both sides compare identically. */
  chartConfigJson: string | null;
}

/**
 * Normalized SQL fingerprint, matching lib/plan-derivation's treatment.
 *
 * Whitespace is collapsed because the logged copy may have been reflowed; case is NOT
 * normalized, because `state = 'la'` and `state = 'LA'` are different queries against
 * this data.
 */
function sqlFingerprint(sql: string): string {
  return createHash("sha256").update(sql.replace(/\s+/g, " ").trim(), "utf8").digest("hex").slice(0, 32);
}

/** query_log truncates sql at 4000 characters; a comparison against a truncated copy proves nothing. */
const QUERY_LOG_SQL_LIMIT = 4000;

interface QueryLogRow {
  tab: string | null;
  sql: string | null;
  chart_config: string | null;
  delivery_action: string | null;
  proof_mode: string | null;
  proof_manifest: string | null;
}

/**
 * Did the stored proof envelope actually pass?
 *
 * Reads hypotheticalAction, which is what the contract would have required, rather
 * than delivery_action, which is what shadow actually served. A missing or
 * unparseable envelope is `false` -- absence of evidence is not evidence.
 */
function envelopeProved(manifestJson: string | null): boolean {
  if (!manifestJson) return false;
  try {
    const parsed = JSON.parse(manifestJson) as { blocker?: string | null; hypotheticalAction?: string };
    if (parsed.blocker) return false;
    return parsed.hypotheticalAction === "answer" || parsed.hypotheticalAction === "answer_limited_scope";
  } catch {
    return false;
  }
}

/**
 * Verify a claimed originating answer against what the server logged.
 *
 * Never throws: a failure to verify must degrade to `unbound`, never to a rejected
 * request or an assumed-good origin.
 */
export function verifyEmbedOrigin(
  // Structurally typed rather than importing better-sqlite3's Database, so this module
  // stays testable against a plain stub and does not depend on the driver's generics.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: { prepare: (sql: string) => { get: (...params: any[]) => unknown } } | null,
  candidate: OriginCandidate,
): OriginVerdict {
  if (!candidate.requestId) {
    return {
      state: "absent",
      reason: "no originating request id was supplied",
      deliveryAction: null,
      proofMode: null,
    };
  }
  if (!db) {
    return {
      state: "unbound",
      reason: "query log unavailable, so the claimed origin could not be checked",
      deliveryAction: null,
      proofMode: null,
    };
  }
  if (!queryLogHasColumn(db, "request_id") || !queryLogHasColumn(db, "proof_manifest")) {
    return {
      state: "unbound",
      reason: "query log lacks the columns needed to verify an origin",
      deliveryAction: null,
      proofMode: null,
    };
  }

  let row: QueryLogRow | undefined;
  try {
    row = db
      .prepare(
        "SELECT tab, sql, chart_config, delivery_action, proof_mode, proof_manifest " +
          "FROM query_log WHERE request_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(candidate.requestId) as QueryLogRow | undefined;
  } catch {
    return {
      state: "unbound",
      reason: "the origin lookup failed",
      deliveryAction: null,
      proofMode: null,
    };
  }

  if (!row) {
    return {
      state: "unbound",
      reason: `no logged answer matches request id '${candidate.requestId}'`,
      deliveryAction: null,
      proofMode: null,
    };
  }

  const found = { deliveryAction: row.delivery_action ?? null, proofMode: row.proof_mode ?? null };

  // THE BINDING. Each mismatch means this chart is not that answer.
  if ((row.tab ?? "") !== candidate.tab) {
    return {
      state: "unbound",
      reason: `origin tab '${row.tab ?? "(none)"}' does not match the chart's '${candidate.tab}'`,
      ...found,
    };
  }
  const loggedSql = row.sql ?? "";
  if (loggedSql.length >= QUERY_LOG_SQL_LIMIT) {
    // The logged copy is truncated, so equality cannot be established either way.
    // Recorded as unbound rather than waved through.
    return {
      state: "unbound",
      reason: "the logged SQL is truncated, so it cannot be compared to the chart's",
      ...found,
    };
  }
  if (sqlFingerprint(loggedSql) !== sqlFingerprint(candidate.sql)) {
    return {
      state: "unbound",
      reason: "the chart's SQL is not the SQL of the claimed originating answer",
      ...found,
    };
  }
  // Chart configuration is compared only when the logged answer captured one. Both
  // sides pass through serializeChartConfigForLog, so this is a like-for-like
  // comparison rather than a raw-object one.
  if (row.chart_config && candidate.chartConfigJson && row.chart_config !== candidate.chartConfigJson) {
    return {
      state: "unbound",
      reason: "the chart configuration does not match the originating answer's",
      ...found,
    };
  }

  if (!envelopeProved(row.proof_manifest)) {
    return {
      state: "bound_unproven",
      reason:
        "the originating answer is this chart's, but its proof did not pass " +
        `(served '${row.delivery_action ?? "unknown"}')`,
      ...found,
    };
  }

  return {
    state: "verified",
    reason: "the chart's tab, SQL, and chart configuration match a logged answer whose proof passed",
    ...found,
  };
}

/** True only for a fully verified origin. */
export function originIsVerified(verdict: OriginVerdict): boolean {
  return verdict.state === "verified";
}

/**
 * Plan family recorded for an embed read, derived from the origin verdict.
 *
 * Distinct per state so the shadow record can tell a forged or missing origin from a
 * genuine one -- which the first revision could not, because it assigned
 * `embed-replay` whenever a request id was merely non-null.
 */
export function embedPlanFamily(verdict: OriginVerdict): string {
  switch (verdict.state) {
    case "verified":
      return "embed-verified-origin";
    case "bound_unproven":
      return "embed-bound-unproven-origin";
    case "unbound":
      return "embed-unbound-origin";
    default:
      return "embed-legacy-unproved";
  }
}
