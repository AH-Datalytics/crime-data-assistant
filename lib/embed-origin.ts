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

import { queryLogHasColumn } from "./query-log-columns";

/**
 * EVERY shared_charts column this version reads or writes, not a representative sample.
 *
 * A first revision probed for two of six. A database carrying the earlier migration
 * shape -- which had no origin_state -- therefore answered true, after which POST
 * inserted origin_state and GET selected it, and every embed request 500'd. The point
 * of a runtime probe is that schema and code can deploy in either order; probing a
 * subset gives up exactly that.
 */
export const REQUIRED_SHARED_CHART_COLUMNS = [
  "origin_request_id",
  "origin_delivery_action",
  "origin_proof_mode",
  "origin_state",
  "last_read_delivery_action",
  "last_read_at",
] as const;

/** Whether shared_charts carries every proof column this version needs. */
export function sharedChartsHasProof(db: object | null): boolean {
  if (!db) return false;
  try {
    const rows = (db as { prepare: (sql: string) => { all: () => Array<{ name: string }> } })
      .prepare("PRAGMA table_info(shared_charts)")
      .all();
    const names = new Set(rows.map((row) => row.name));
    return REQUIRED_SHARED_CHART_COLUMNS.every((column) => names.has(column));
  } catch {
    return false;
  }
}

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
 * EXACT SQL equality. No normalization of any kind.
 *
 * A first revision collapsed whitespace here, copying lib/plan-derivation's tolerance.
 * That tolerance exists there for a specific reason -- guardrails reflow SQL between
 * planning and execution -- and NONE of it applies to this comparison: query_log
 * stores the SQL verbatim and only ever truncates it, so the logged copy is either
 * byte-identical to the original or too short to compare.
 *
 * Worse, a blanket `\s+ -> " "` collapses whitespace INSIDE string literals, so
 *
 *     WHERE city = 'New  York'
 *     WHERE city = 'New York'
 *
 * fingerprinted identically -- two materially different queries against this data. A
 * looser comparison bought nothing and silently widened what could claim provenance.
 */
function sqlMatches(logged: string, candidate: string): boolean {
  return logged === candidate;
}

/** query_log truncates sql at 4000 characters; a comparison against a truncated copy proves nothing. */
const QUERY_LOG_SQL_LIMIT = 4000;

/**
 * Fields of a logged chart payload that describe the CHART, as opposed to the result
 * it was drawn over.
 *
 * serializeChartConfigForLog also records `columns` and `columnCount` -- the actual
 * result column names, which the chart auditor needs. Those are properties of the
 * query's output, not of the chart configuration, and the embed route has no result
 * set at creation time. Comparing them made every legitimate chart origin unbound,
 * because the route serialized with real columns and the embed serialized with none.
 */
const CHART_IDENTITY_FIELDS = [
  "type",
  "title",
  "xAxis",
  "yAxis",
  "seriesCount",
  "xAxisLabel",
  "yAxisLabel",
  "yAxisMin",
  "yAxisMax",
  "annotationCount",
  // Digests of what the viewer is actually shown. annotationCount alone let a chart
  // change an annotation's position and its displayed claim while keeping the count,
  // and chartMeta -- the agency count and population rendered beneath the chart --
  // arrived from the client and was compared against nothing at all.
  "annotationsDigest",
  "chartMetaDigest",
] as const;

function chartIdentity(json: string): string | null {
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const identity: Record<string, unknown> = {};
    for (const field of CHART_IDENTITY_FIELDS) {
      if (parsed[field] !== undefined) identity[field] = parsed[field];
    }
    return JSON.stringify(identity);
  } catch {
    return null;
  }
}

/**
 * Compare the chart halves, with DELIBERATE presence semantics.
 *
 * A first revision compared only when both sides had a configuration, so omitting the
 * client config -- or supplying one where the logged answer had none -- still
 * verified. Either asymmetry means the chart is not the artifact that answer produced,
 * so both are now mismatches. The only case that passes on absence is both absent,
 * which is a genuine no-chart export.
 */
function chartConfigMatches(logged: string | null, candidate: string | null): { match: boolean; reason: string } {
  if (!logged && !candidate) {
    return { match: true, reason: "neither the answer nor the chart carried a configuration" };
  }
  if (!logged) {
    return { match: false, reason: "the chart carries a configuration the originating answer did not" };
  }
  if (!candidate) {
    return { match: false, reason: "the originating answer carried a chart configuration and the chart does not" };
  }
  const loggedIdentity = chartIdentity(logged);
  const candidateIdentity = chartIdentity(candidate);
  if (loggedIdentity === null || candidateIdentity === null) {
    return { match: false, reason: "a chart configuration could not be parsed for comparison" };
  }
  if (loggedIdentity !== candidateIdentity) {
    return { match: false, reason: "the chart configuration does not match the originating answer's" };
  }
  return { match: true, reason: "chart configurations match" };
}

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
  if (!sqlMatches(loggedSql, candidate.sql)) {
    return {
      state: "unbound",
      reason: "the chart's SQL is not the SQL of the claimed originating answer",
      ...found,
    };
  }
  const chartVerdict = chartConfigMatches(row.chart_config ?? null, candidate.chartConfigJson);
  if (!chartVerdict.match) {
    return { state: "unbound", reason: chartVerdict.reason, ...found };
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
