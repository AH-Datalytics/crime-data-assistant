/**
 * Proof that the SQL a route executed is the SQL a deterministic planner emitted.
 *
 * WHY A TOKEN AND NOT A BOOLEAN. An earlier revision passed a bare
 * `deterministic: true` flag from each route into checkSemanticPlan(), alongside a
 * QueryContract parsed independently from the question. Nothing connected the two:
 * the check asserted "this SQL was compiled from a validated typed plan" on the
 * strength of a caller-supplied boolean, which is precisely the shape of claim the
 * verified-answer contract exists to eliminate. Handoff §2.1: "An arbitrary
 * LLM-authored SQL query cannot become a confirmed answer merely because
 * postconditions did not detect a problem."
 *
 * A route can still lie by sealing a token around model-authored SQL, but it
 * cannot do so ACCIDENTALLY, and it cannot do so silently -- the seal call site is
 * greppable and the fingerprint is checked against what actually ran.
 *
 * WHAT THIS PROVES, EXACTLY:
 *   1. A deterministic planner produced a SQL string, and
 *   2. the SQL that reached the database is that same string, unmodified.
 *
 * WHAT IT DOES NOT PROVE:
 *   - That the planner's interpretation of the question is correct. No runtime
 *     check can establish that; it is what the regression corpus and the shadow
 *     review period are for (§10).
 *   - That the plan is semantically complete for the request. checkMetric,
 *     checkGrain, checkTimeRange, and checkEntityCompleteness cover parts of that
 *     independently.
 *
 * The failure mode it DOES catch is real and already present in these routes:
 * between a plan being built and its SQL executing, the guardrail auto-rewrite,
 * the schema-column corrector, the table-allowlist retry, and the rolling-12-month
 * retry can each replace `sql`. A deterministic answer whose SQL was rewritten
 * downstream is no longer deterministically derived, and before this token there
 * was nothing to notice that.
 *
 * Stage 6 tightens this further: when the deterministic compilers are built, the
 * token should be issued BY the compiler rather than sealed by the route around
 * the compiler's output.
 */

import { createHash } from "node:crypto";

/** Bump if the fingerprint algorithm changes; an old token then fails to verify. */
export const PLAN_DERIVATION_VERSION = 1;

/**
 * Who issued the token, which bounds what it may authorize.
 *
 * `route`  - sealed by a route around a planner's output. Proves SQL identity only.
 * `compiler` - issued by a deterministic compiler that owns the plan. Does not exist
 *            yet; Stage 6 builds it.
 *
 * A route-issued token is honest shadow instrumentation and nothing more. It cannot
 * establish that a deterministic compiler produced the query, so it must never
 * authorize a delivery decision under enforcement -- see the issuer guard in
 * lib/proof-finalize.ts. Recording the distinction in the token means that guard is
 * a property of the evidence rather than a convention someone has to remember.
 */
export type DerivationIssuer = "route" | "compiler";

export interface PlanDerivation {
  v: number;
  /** The typed plan family that produced the SQL. */
  planFamily: string;
  /** Fingerprint of the SQL as emitted by the planner. */
  sqlFingerprint: string;
  issuer: DerivationIssuer;
}

/**
 * Normalize before fingerprinting so that whitespace reflow -- which several
 * guardrails perform harmlessly -- does not read as tampering, while any change to
 * a table, column, filter, or literal does.
 *
 * Case is deliberately NOT normalized: `state = 'la'` and `state = 'LA'` are
 * different queries against this data, and SQLite string comparison is
 * case-sensitive by default.
 */
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function fingerprintSql(sql: string): string {
  return createHash("sha256").update(normalizeSql(sql), "utf8").digest("hex").slice(0, 32);
}

/**
 * Seal a planner's output from inside a route.
 *
 * Call immediately where the plan and its SQL are both in hand. Issues a `route`
 * token, which proves SQL identity but cannot authorize enforcement.
 */
export function sealPlanDerivation(planFamily: string, sql: string): PlanDerivation {
  return {
    v: PLAN_DERIVATION_VERSION,
    planFamily,
    sqlFingerprint: fingerprintSql(sql),
    issuer: "route",
  };
}

/**
 * Issue a compiler-owned token. Reserved for Stage 6.
 *
 * Exported now so the enforcement guard has a positive case to test against, and so
 * the eventual compiler has an obvious entry point rather than a temptation to reach
 * for sealPlanDerivation().
 */
export function sealCompilerPlanDerivation(planFamily: string, sql: string): PlanDerivation {
  return {
    v: PLAN_DERIVATION_VERSION,
    planFamily,
    sqlFingerprint: fingerprintSql(sql),
    issuer: "compiler",
  };
}

export interface DerivationVerdict {
  ok: boolean;
  /** Why verification failed, or what it confirmed. Recorded in the proof manifest. */
  reason: string;
}

/**
 * Check a token against the SQL that actually executed.
 *
 * Every failure path returns ok: false with a reason rather than throwing --
 * a token mismatch must degrade the proof, never the response.
 */
export function verifyPlanDerivation(
  derivation: PlanDerivation | null | undefined,
  executedSql: string | null,
  /**
   * The family the caller claims this answer belongs to.
   *
   * VERIFIED, NOT TRUSTED. The fingerprint alone proves that some planner emitted
   * this SQL; it says nothing about which family the answer is being recorded and
   * authorized under. Without this comparison a token sealed for family A could be
   * presented alongside `planFamily: "B"`, and the answer would be logged under B --
   * and, once per-family enforcement exists, authorized by B's env variable. Pass
   * null only when the caller genuinely has no independent claim to check.
   */
  expectedFamily?: string | null,
): DerivationVerdict {
  if (!derivation) {
    return { ok: false, reason: "no deterministic plan derivation was sealed for this answer" };
  }
  if (derivation.v !== PLAN_DERIVATION_VERSION) {
    return { ok: false, reason: `derivation version ${derivation.v} is not ${PLAN_DERIVATION_VERSION}` };
  }
  if (!derivation.planFamily || derivation.planFamily.trim() === "") {
    return { ok: false, reason: "derivation carries no plan family" };
  }
  if (derivation.issuer !== "route" && derivation.issuer !== "compiler") {
    return { ok: false, reason: `derivation issuer '${String(derivation.issuer)}' is not recognized` };
  }
  if (expectedFamily && expectedFamily.trim() !== "" && expectedFamily !== derivation.planFamily) {
    return {
      ok: false,
      reason:
        `plan family mismatch: token was sealed for '${derivation.planFamily}' but this answer ` +
        `is being recorded as '${expectedFamily}'`,
    };
  }
  if (!executedSql || executedSql.trim() === "") {
    // A plan family with no SQL is not necessarily wrong -- some deterministic
    // answers are pure metadata -- but it is not a SQL derivation either, so it
    // cannot satisfy this check.
    return { ok: false, reason: "no SQL was executed, so a SQL derivation cannot be verified" };
  }
  const actual = fingerprintSql(executedSql);
  if (actual !== derivation.sqlFingerprint) {
    return {
      ok: false,
      reason:
        `executed SQL does not match the plan's output (plan ${derivation.sqlFingerprint}, ` +
        `executed ${actual}); it was rewritten between planning and execution`,
    };
  }
  return {
    ok: true,
    reason: `executed SQL matches plan family '${derivation.planFamily}' output (${derivation.issuer}-issued)`,
  };
}
