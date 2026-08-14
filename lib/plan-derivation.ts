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

/**
 * v2 tokens may carry a builder-declared capability; v1 tokens predate the field.
 *
 * v1 is accepted as LEGACY: it verifies exactly as before, and its capability is null regardless of
 * what the object carries -- a v1 token has no business naming one, so a capability is honored only
 * from the version that defines it. Any other version fails to verify. This is what "bump while
 * reading older envelopes as null" actually requires: the bump distinguishes capability-bearing
 * tokens from capability-free ones, and the verifier, not the version check alone, provides the
 * compatibility.
 */
export const PLAN_DERIVATION_VERSION = 2;
export const LEGACY_PLAN_DERIVATION_VERSION = 1;

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
  /**
   * The capability this plan built for, declared by whoever built it. Defined by v2; null today.
   *
   * A family cannot identify a capability: `deterministic-nibrs-continuous-reporters` spans four
   * distinct contracts over four different summary tables, and each metadata family spans five, one
   * per source. So capability identity has to come from the builder, sealed alongside the SQL.
   *
   * The verifier honors this field only on a v2 token; v1 tokens verify as legacy and always read as
   * `capability: null`, so no stored envelope was invalidated by the bump and none can smuggle a
   * capability in. An absent capability resolves to `unresolved`, which is fail-closed: nothing can
   * authorize on a token that never named a contract.
   */
  capability?: string | null;
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
/**
 * Closing delimiter for each quoted region SQLite recognizes, and whether that
 * delimiter can be escaped by doubling it.
 *
 * A first revision handled only `'` and `"`. SQLite also accepts backtick and bracket
 * quoted identifiers, and both were collapsible: `[odd  column]` and `[odd column]`
 * fingerprinted identically despite naming different columns. lib/sql-safety accepts
 * all four forms, so all four could reach a deterministic route.
 */
const QUOTED_REGIONS: Record<string, { close: string; doubles: boolean }> = {
  "'": { close: "'", doubles: true },
  '"': { close: '"', doubles: true },
  "`": { close: "`", doubles: true },
  // SQLite brackets have no doubling escape; the first `]` closes the identifier.
  "[": { close: "]", doubles: false },
};

/**
 * Collapse whitespace only where it carries no meaning.
 *
 * The tolerance exists to absorb a guardrail reflowing the STATEMENT between planning
 * and execution. It must never absorb a change to what the statement SELECTS, and
 * three kinds of region make that distinction lexical rather than textual:
 *
 *   QUOTED REGIONS are preserved verbatim. `'New  York'` and `'New York'` are
 *   different values; `[odd  column]` and `[odd column]` are different identifiers.
 *
 *   COMMENTS ARE REMOVED, because their text genuinely cannot change a query's
 *   meaning -- so two statements differing only in comment prose should verify.
 *
 *   THE NEWLINE THAT ENDS A LINE COMMENT IS NOT REMOVED. This is the case that made
 *   the naive version unsafe rather than merely loose:
 *
 *       SELECT 1 -- note\n, 2 FROM t     selects two columns
 *       SELECT 1 -- note , 2 FROM t      selects one; the rest is commented out
 *
 *   Collapsing `\n` to a space made those identical. Replacing each comment with a
 *   single space instead keeps the token boundary and leaves the two distinct.
 */
function normalizeSql(sql: string): string {
  const out: string[] = [];
  /**
   * Emit a separator unless one is already there.
   *
   * Done inline rather than as a final `replace(/ {2,}/g, " ")` pass, because a global
   * collapse at the end also rewrites the inside of the quoted regions this function
   * just went to the trouble of preserving -- which is exactly the bug it was meant to
   * fix, reintroduced one line later. My own reproduction caught it.
   */
  const pushSeparator = () => {
    if (out.length > 0 && out[out.length - 1] !== " ") out.push(" ");
  };

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];

    const region = QUOTED_REGIONS[ch];
    if (region) {
      out.push(ch);
      i += 1;
      while (i < sql.length) {
        if (sql[i] === region.close) {
          if (region.doubles && sql[i + 1] === region.close) {
            out.push(sql[i], sql[i + 1]);
            i += 2;
            continue;
          }
          out.push(sql[i]);
          i += 1;
          break;
        }
        out.push(sql[i]);
        i += 1;
      }
      continue;
    }

    // Line comment: drop through the newline, but emit a separator in its place so the
    // token boundary the newline provided survives.
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      pushSeparator();
      continue;
    }

    // Block comment: drop, leaving a separator. An unterminated one runs to the end,
    // which is also how SQLite reads it.
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i += 2;
      pushSeparator();
      continue;
    }

    if (/\s/.test(ch)) {
      while (i < sql.length && /\s/.test(sql[i])) i += 1;
      pushSeparator();
      continue;
    }

    out.push(ch);
    i += 1;
  }
  return out.join("").trim();
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
export function sealPlanDerivation(planFamily: string, sql: string): PlanDerivation;
export function sealPlanDerivation(planFamily: string, capability: string | null, sql: string): PlanDerivation;
/**
 * Two forms, and the three-argument one is `(family, capability, sql)` -- the approved contract,
 * enforced against the plan's code by the taxonomy harness.
 *
 * The first implementation put the capability THIRD to spare the existing seal sites, which
 * contradicted that contract: every argument is a string, so a caller following the plan would
 * compile cleanly while fingerprinting the capability and storing the SQL as the capability.
 * Overloads keep the 12 existing two-argument sites working unchanged -- no builder computes a
 * structural capability id yet, and inventing one at a route would be a claim about work the route
 * did not do. Task 1A is where builders begin declaring their own.
 */
export function sealPlanDerivation(planFamily: string, second: string | null, third?: string): PlanDerivation {
  const [capability, sql] = third === undefined ? [null, second as string] : [second, third];
  return {
    v: PLAN_DERIVATION_VERSION,
    planFamily,
    sqlFingerprint: fingerprintSql(sql),
    issuer: "route",
    capability,
  };
}

/**
 * Issue a compiler-owned token. Reserved for Stage 6.
 *
 * Exported now so the enforcement guard has a positive case to test against, and so
 * the eventual compiler has an obvious entry point rather than a temptation to reach
 * for sealPlanDerivation().
 */
export function sealCompilerPlanDerivation(planFamily: string, sql: string): PlanDerivation;
export function sealCompilerPlanDerivation(planFamily: string, capability: string | null, sql: string): PlanDerivation;
export function sealCompilerPlanDerivation(planFamily: string, second: string | null, third?: string): PlanDerivation {
  const [capability, sql] = third === undefined ? [null, second as string] : [second, third];
  return {
    v: PLAN_DERIVATION_VERSION,
    planFamily,
    sqlFingerprint: fingerprintSql(sql),
    issuer: "compiler",
    capability,
  };
}

/**
 * A DISCRIMINATED union, so the invalid state cannot be written: only a verified verdict has a
 * capability slot at all. The first version used `ok: boolean` plus an optional field, which could
 * represent `{ok: false, capability: "..."}` -- the exact state the field's contract excludes -- and
 * left the exclusion as a runtime convention a regression had to police.
 */
export type DerivationVerdict =
  | {
      ok: true;
      /** What verification confirmed. Recorded in the proof manifest. */
      reason: string;
      /**
       * The capability the token declared, read here rather than off the raw token so a consumer
       * cannot pick one up from a derivation that failed verification. Null when the token named
       * none -- every v1 token, and every v2 token sealed by a route.
       */
      capability: string | null;
    }
  | {
      ok: false;
      /** Why verification failed. Recorded in the proof manifest. */
      reason: string;
    };

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
  if (derivation.v !== PLAN_DERIVATION_VERSION && derivation.v !== LEGACY_PLAN_DERIVATION_VERSION) {
    return {
      ok: false,
      reason: `derivation version ${derivation.v} is neither ${PLAN_DERIVATION_VERSION} nor legacy ${LEGACY_PLAN_DERIVATION_VERSION}`,
    };
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
  // A capability is honored only from the version that defines the field. A v1 token carrying one
  // is not a legitimate state -- nothing sealed v1 tokens with capabilities -- so it reads as null
  // rather than as a declaration.
  const capability = derivation.v === PLAN_DERIVATION_VERSION
      && typeof derivation.capability === "string"
      && derivation.capability.trim() !== ""
    ? derivation.capability.trim()
    : null;
  return {
    ok: true,
    reason: `executed SQL matches plan family '${derivation.planFamily}' output (${derivation.issuer}-issued)`,
    capability,
  };
}
