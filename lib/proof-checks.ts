/**
 * v1 postconditions for the verified-answer-only contract.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §9.1 Stage 1 ("implement v1 checks for requested/returned entities, canonical
 * geography, metric, grain, year range, missingness, and safe numeric claims")
 * and §6.1 for the check names, which are frozen in lib/proof-contract.ts.
 *
 * WHAT A CHECK IS ALLOWED TO CONCLUDE. Each function returns a CheckState and a
 * reason. The states are `passed`, `failed`, `not_applicable`, `unknown` -- and
 * the hardest discipline in this file is returning `unknown` rather than `passed`
 * when a check had nothing to work with. Handoff §2.1 is explicit that
 * postconditions "can establish internal consistency; they cannot prove that
 * arbitrary SQL selected the correct table, population, denominator, filters, or
 * interpretation." A check that returns `passed` because it found no evidence of
 * a problem is the exact failure mode that made detector D6 report clean for
 * weeks against a 0-byte reference database.
 *
 * So: no check here returns `passed` unless it affirmatively verified something.
 * `not_applicable` is reserved for cases where the typed plan makes the check
 * meaningless (a metadata answer has no year range), and every use is paired with
 * a recorded reason -- lib/proof-contract's factualDeliveryBlocker() rejects a
 * `not_applicable` with no justification.
 *
 * REUSE, NOT REIMPLEMENTATION. lib/query-contract.ts already parses a question
 * into a typed structure with canonical geography, metric unit, offense codes, and
 * a year range; lib/requested-grain.ts already compares requested to returned
 * grain. Those are this repository's existing semantic plan, and these checks
 * consume them. Building a second parallel interpretation of the same question
 * would guarantee the two disagree.
 */

import type { CheckState, ProofCheck } from "./proof-contract";
import type { QueryContract } from "./query-contract";
import { detectRequestedGrain, resultGrain } from "./requested-grain";
import { entityAliasKeys } from "./result-disclosure";
import { verifyPlanDerivation, type PlanDerivation } from "./plan-derivation";

export interface CheckOutcome {
  state: CheckState;
  /**
   * Why the check reached its state. Required for every state, including
   * `passed`: a reviewer reading the proof record needs to know what was actually
   * verified, not merely that something was.
   */
  reason: string;
}

export interface CheckInput {
  question: string;
  sql: string | null;
  rows: Record<string, unknown>[];
  columns: string[];
  /** The typed plan, when one could be built. Null forces `unknown`, never `passed`. */
  contract: QueryContract | null;
  /** Canonical entity ids the request asked for, when resolvable. */
  requestedEntities: string[];
  /** Canonical entity ids present in the result. */
  returnedEntities: string[];
  /**
   * True when the delivered narrative openly states the narrower scope.
   *
   * Supplied by the caller because only the caller knows the final text. Without
   * it, entityCompleteness cannot distinguish `answer_limited_scope` (omission
   * disclosed) from a silent drop (§2.4).
   */
  omissionsDisclosed: boolean;
}

const NUMERIC_CLAIM_TOLERANCE = 0.005;

/**
 * Did every requested canonical entity come back?
 *
 * This is the check for the historical 31-of-32 failure: a comparison across 32
 * cities returned 31 and the narrative described it as complete. A shortfall is
 * not automatically a failure -- an answer that openly states the narrower scope
 * is `answer_limited_scope`, which the contract permits (§2.3). A shortfall that
 * nobody told the user about is a failure.
 */
export function checkEntityCompleteness(input: CheckInput): CheckOutcome {
  if (input.requestedEntities.length === 0) {
    return {
      state: "not_applicable",
      reason: "the request named no resolvable canonical entities to compare against",
    };
  }
  if (input.rows.length === 0) {
    return { state: "unknown", reason: "no rows returned, so returned entities could not be compared" };
  }
  // Alias-expanded on both sides, using the same keys lib/result-disclosure uses.
  // Matching on bare normalized strings reported "St. Louis" as missing from a
  // result containing "Saint Louis" -- a false omission claim about a city that
  // was in fact present.
  const returned = new Set(input.returnedEntities.flatMap((entity) => entityAliasKeys(entity)));
  if (returned.size === 0) {
    return {
      state: "unknown",
      reason: "result rows carried no recognizable entity column, so completeness is undetermined",
    };
  }
  const missing = input.requestedEntities.filter(
    (entity) => !entityAliasKeys(entity).some((key) => returned.has(key)),
  );
  if (missing.length === 0) {
    return {
      state: "passed",
      reason: `all ${input.requestedEntities.length} requested entities are present in the result`,
    };
  }
  if (input.omissionsDisclosed) {
    return {
      state: "passed",
      reason: `${missing.length} of ${input.requestedEntities.length} entities absent and disclosed: ${missing.slice(0, 8).join(", ")}`,
    };
  }
  return {
    state: "failed",
    reason: `${missing.length} requested entities absent from the result and not disclosed: ${missing.slice(0, 8).join(", ")}`,
  };
}

/**
 * Was every geography resolved to a canonical identity the source recognizes?
 *
 * Consumes lib/query-contract's resolution rather than re-resolving, so a
 * geography this system considers ambiguous is the same one the guardrails and
 * clarification paths already considered ambiguous.
 */
export function checkCanonicalGeographies(input: CheckInput): CheckOutcome {
  const contract = input.contract;
  if (!contract) {
    return { state: "unknown", reason: "no typed plan was available to resolve geography against" };
  }
  const geographies = contract.geographies.filter((geo) => geo.kind !== "unknown" || geo.name !== null);
  if (geographies.length === 0) {
    return {
      state: "not_applicable",
      reason: "the typed plan resolved no geography, so there is none to canonicalize",
    };
  }
  const unresolved = geographies.filter((geo) => geo.needsClarification.length > 0);
  if (unresolved.length > 0) {
    return {
      state: "failed",
      reason: `geography requires clarification: ${unresolved
        .map((geo) => `${geo.name ?? geo.kind} (${geo.needsClarification.join("/")})`)
        .join(", ")}`,
    };
  }
  const uncanonical = geographies.filter((geo) => geo.kind !== "national" && !geo.canonicalName);
  if (uncanonical.length > 0) {
    return {
      state: "unknown",
      reason: `no canonical name resolved for: ${uncanonical.map((geo) => geo.name ?? geo.kind).join(", ")}`,
    };
  }
  const lowConfidence = geographies.filter((geo) => geo.confidence === "low");
  if (lowConfidence.length > 0) {
    return {
      state: "unknown",
      reason: `low-confidence geography resolution: ${lowConfidence.map((geo) => geo.name ?? geo.kind).join(", ")}`,
    };
  }
  return {
    state: "passed",
    reason: `${geographies.length} geograph${geographies.length === 1 ? "y" : "ies"} resolved canonically with no outstanding clarification`,
  };
}

/**
 * Is the requested measure one the plan can name and the source supports?
 *
 * `unsupportedReason` on the contract's metric is authoritative: it is set when
 * the question asks for something this product cannot compute, which under §2.3
 * is `decline_capability` rather than an answer.
 */
export function checkMetric(input: CheckInput): CheckOutcome {
  const contract = input.contract;
  if (!contract) {
    return { state: "unknown", reason: "no typed plan was available to identify the metric" };
  }
  if (contract.metric.unsupportedReason) {
    return { state: "failed", reason: `metric unsupported: ${contract.metric.unsupportedReason}` };
  }
  if (contract.metric.unit === "unknown") {
    return { state: "unknown", reason: "the plan could not determine whether the request is a count, rate, or ratio" };
  }
  if (contract.metric.topic === "unknown" || contract.metric.offenseCodes.length === 0) {
    return { state: "unknown", reason: "the plan could not bind the request to a specific offense definition" };
  }
  // A rate needs a denominator, and a denominator that is absent from the SQL is
  // the rate-no-population failure the guardrails already chase at generation
  // time. Checked here too because a cache hit re-runs SQL that never passed
  // through this request's guardrails.
  if (
    (contract.metric.unit === "rate_per_100k" || contract.metric.unit === "clearance_rate") &&
    input.sql &&
    !/population|cleared|clearance|denominator/i.test(input.sql)
  ) {
    return {
      state: "failed",
      reason: `request asks for ${contract.metric.unit} but the SQL carries no denominator source`,
    };
  }
  return {
    state: "passed",
    reason: `metric bound to ${contract.metric.topic} as ${contract.metric.unit} over ${contract.metric.offenseCodes.length} offense code(s)`,
  };
}

/** Does the result's grain match what was asked for (monthly vs annual)? */
export function checkGrain(input: CheckInput): CheckOutcome {
  const requested = detectRequestedGrain(input.question);
  if (requested === null) {
    return { state: "not_applicable", reason: "the request did not specify a monthly or annual grain" };
  }
  if (input.rows.length === 0) {
    return { state: "unknown", reason: "no rows returned, so result grain could not be determined" };
  }
  const actual = resultGrain(input.rows, input.sql ?? "");
  if (actual === "unknown") {
    return { state: "unknown", reason: `requested ${requested} grain but the result's grain is undetermined` };
  }
  if (actual !== requested) {
    return { state: "failed", reason: `requested ${requested} grain but the result is ${actual}` };
  }
  return { state: "passed", reason: `result grain is ${actual}, matching the request` };
}

function yearsInRows(rows: Record<string, unknown>[]): number[] {
  const years: number[] = [];
  for (const row of rows) {
    const value = row.year ?? row.data_year ?? row.yr;
    const year = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    if (Number.isFinite(year) && year > 1900 && year < 2200) years.push(year);
  }
  return years;
}

/**
 * Does the question express a CONTIGUOUS range, or enumerate specific years?
 *
 * "from 2015 to 2025" demands every year in between; "2015 and 2025" does not.
 * lib/query-contract collapses both to startYear/endYear, so the distinction has to
 * be recovered from the question text. Without it, a gap check would either miss
 * real gaps (min/max only) or fabricate them for every two-year comparison.
 */
function asksContiguousRange(question: string): boolean {
  return /\b(?:from\s+\d{4}\s*(?:to|through|thru|-|–|—)\s*\d{4}|between\s+\d{4}\s+and\s+\d{4}|since\s+\d{4}|\d{4}\s*(?:-|–|—)\s*\d{4})\b/i.test(
    question,
  ) || /\b(?:each|every|annual(?:ly)?|by year|per year|trend|over time)\b/i.test(question);
}

/**
 * Does the returned period cover the period the plan asked for?
 *
 * TWO FAILURES, NOT ONE. Checking only min and max lets a result containing just
 * 2015 and 2025 "cover" a request for 2015-2025 -- the endpoints match and eight
 * interior years are missing. A trend chart drawn from that is a straight line
 * between two points presented as a decade of data. So interior gaps are checked
 * too, but only when the question actually asked for a contiguous range; an
 * enumerated two-year comparison is reported `unknown` rather than failed, because
 * the plan cannot tell us which reading was meant.
 *
 * Under-coverage at the boundaries is `failed` rather than `unknown`: the plan named
 * a year the result does not contain, which is a concrete discrepancy, and §2.4
 * forbids silently dropping a requested year. Whether that becomes a limited-scope
 * answer or a decline is the delivery layer's decision, not this check's.
 */
export function checkTimeRange(input: CheckInput): CheckOutcome {
  const contract = input.contract;
  if (!contract) {
    return { state: "unknown", reason: "no typed plan was available to establish the requested period" };
  }
  const { startYear, endYear } = contract.time;
  if (startYear === null && endYear === null) {
    return { state: "not_applicable", reason: "the request named no explicit year or year range" };
  }
  if (input.rows.length === 0) {
    return { state: "unknown", reason: "no rows returned, so the returned period could not be compared" };
  }
  const years = yearsInRows(input.rows);
  if (years.length === 0) {
    return {
      state: "unknown",
      reason: "result rows carry no year column, so the returned period is undetermined",
    };
  }
  const min = Math.min(...years);
  const max = Math.max(...years);
  const shortfalls: string[] = [];
  if (startYear !== null && min > startYear) shortfalls.push(`requested from ${startYear}, returned from ${min}`);
  if (endYear !== null && max < endYear) shortfalls.push(`requested through ${endYear}, returned through ${max}`);
  if (shortfalls.length > 0) {
    return { state: "failed", reason: shortfalls.join("; ") };
  }

  // Interior gaps. The boundaries matching is not coverage.
  const spanStart = startYear ?? min;
  const spanEnd = endYear ?? max;
  if (spanEnd > spanStart) {
    const present = new Set(years);
    const gaps: number[] = [];
    for (let year = spanStart; year <= spanEnd; year++) {
      if (!present.has(year)) gaps.push(year);
    }
    if (gaps.length > 0) {
      const shown = gaps.slice(0, 8).join(", ") + (gaps.length > 8 ? `, +${gaps.length - 8} more` : "");
      if (asksContiguousRange(input.question)) {
        return {
          state: "failed",
          reason: `requested ${spanStart}-${spanEnd} contiguously but ${gaps.length} year(s) are absent: ${shown}`,
        };
      }
      return {
        state: "unknown",
        reason:
          `${gaps.length} year(s) within ${spanStart}-${spanEnd} are absent (${shown}); the request did not ` +
          `clearly ask for a contiguous range, so this may be an intended enumeration`,
      };
    }
  }

  return {
    state: "passed",
    reason: `returned ${min}-${max} covers the requested ${spanStart}-${spanEnd} with no interior gaps`,
  };
}

/**
 * Are missing values distinguishable from zeroes?
 *
 * Handoff §3.10: "missingness and zero are distinct states across every source",
 * and §2.4: "never represent missing, unreported, unavailable, unsupported, or
 * unhealthy data as zero." The concrete failure this guards is a result where a
 * measure column is entirely null being narrated as a real zero.
 */
export function checkMissingness(input: CheckInput): CheckOutcome {
  if (input.rows.length === 0) {
    return {
      state: "not_applicable",
      reason: "an empty result has no values whose missingness could be confused with zero",
    };
  }
  const isDimension = (column: string) =>
    /^(year|month|data_year|yr|state|city|agency|agency_name|ori|type)$/i.test(column);
  const isNull = (value: unknown) => value === null || value === undefined;

  // A measure column is classified WITHOUT requiring a numeric value to be
  // present, because the single most important case for this check is the column
  // that is null in every row. An earlier revision identified measures by
  // `rows.some(v => typeof v === "number")`, which excluded all-null columns from
  // consideration entirely and returned `unknown` for the exact defect the check
  // exists to catch. A column of strings is still not a measure, so the three
  // cases are separated explicitly.
  const candidates = input.columns.filter((column) => !isDimension(column));
  const allNull = candidates.filter((column) => input.rows.every((row) => isNull(row[column])));
  const numericMeasures = candidates.filter((column) => input.rows.some((row) => typeof row[column] === "number"));

  if (allNull.length > 0) {
    return {
      state: "failed",
      reason: `measure column(s) entirely null and indistinguishable from zero: ${allNull.join(", ")}`,
    };
  }
  if (numericMeasures.length === 0) {
    return { state: "unknown", reason: "no numeric measure column was identified, so missingness is undetermined" };
  }
  const measureColumns = numericMeasures;
  const partialNull = measureColumns.filter((column) => input.rows.some((row) => isNull(row[column])));
  if (partialNull.length > 0) {
    return {
      state: "unknown",
      reason: `column(s) mix nulls and values without a declared missingness semantic: ${partialNull.join(", ")}`,
    };
  }
  return {
    state: "passed",
    reason: `${measureColumns.length} measure column(s) fully populated; no null-as-zero ambiguity`,
  };
}

/**
 * A numeric claim asserted in prose, paired with the value it should equal.
 *
 * Supplied by the caller from deterministic claim bindings (§6.4). Deliberately
 * NOT extracted by parsing finished prose -- §16 defers "a general prose-to-claim
 * parser as the foundation of correctness", and §6.4 requires prose and charts to
 * be generated FROM bindings rather than mined for them.
 */
export interface NumericClaim {
  label: string;
  claimed: number;
  /** The value derived from the result rows. */
  derived: number;
}

/**
 * Do the asserted numbers reconcile with the result?
 *
 * With no bindings this returns `unknown`, never `passed`. During migration the
 * model-authored path has no bindings, so this check is the reason a legacy answer
 * cannot satisfy the contract -- which is the intended outcome (§3.1, §6.4), not a
 * gap to be worked around by relaxing the check.
 */
export function checkClaims(claims: NumericClaim[] | null): CheckOutcome {
  if (claims === null) {
    return {
      state: "unknown",
      reason: "no deterministic claim bindings were produced, so asserted numbers are unverified",
    };
  }
  if (claims.length === 0) {
    return { state: "not_applicable", reason: "the response asserts no numeric claims to reconcile" };
  }
  const mismatched = claims.filter((claim) => {
    const scale = Math.max(Math.abs(claim.derived), 1);
    return Math.abs(claim.claimed - claim.derived) / scale > NUMERIC_CLAIM_TOLERANCE;
  });
  if (mismatched.length > 0) {
    return {
      state: "failed",
      reason: `claim(s) do not reconcile: ${mismatched
        .map((claim) => `${claim.label} asserted ${claim.claimed}, derived ${claim.derived}`)
        .join("; ")}`,
    };
  }
  return { state: "passed", reason: `${claims.length} numeric claim(s) reconcile with the result rows` };
}

/**
 * Internal arithmetic consistency of the result itself.
 *
 * Separate from checkClaims: that one asks "does the prose match the data", this
 * one asks "is the data self-consistent" -- a percentage outside 0-100, a
 * clearance rate above 1, a negative count.
 */
export function checkReconciliation(input: CheckInput): CheckOutcome {
  if (input.rows.length === 0) {
    return { state: "not_applicable", reason: "an empty result has no values to reconcile" };
  }
  const problems: string[] = [];
  for (const column of input.columns) {
    // Every proportion-like column is bounds-checked, not only the ones whose name
    // happens to contain pct/percent/share. An earlier revision documented
    // clearance-rate bounds and then required that extra name match to apply them,
    // so a column called `clearance_rate` -- the exact case named in the comment --
    // was never checked at all.
    const isRateColumn = /(rate|pct|percent|share|clearance|proportion|ratio)/i.test(column);
    const isCountColumn = /(count|total|incidents|victims|offenses|arrests|murders|homicides)/i.test(column);
    const values = input.rows
      .map((row) => row[column])
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (values.length === 0) continue;

    if (isCountColumn) {
      const negative = values.find((value) => value < 0);
      if (negative !== undefined) {
        problems.push(`${column} has a negative count (${negative})`);
        continue;
      }
    }

    if (isRateColumn) {
      const negative = values.find((value) => value < 0);
      if (negative !== undefined) {
        problems.push(`${column} has a negative rate (${negative})`);
        continue;
      }
      // Scale is inferred from the data, because this codebase emits clearance as a
      // 0-1 proportion in some queries and a 0-100 percentage in others. A value
      // above 100 is out of bounds on either reading, which is the check that
      // matters; distinguishing 0-1 from 0-100 below that would need a declared
      // unit, and inventing one here would just be a differently-wrong guess.
      const max = Math.max(...values);
      // `rate_per_100k` is a genuine per-capita rate with no upper bound, so it is
      // excluded from the ceiling rather than reported as impossible.
      const isPerCapita = /per_?100_?0?0?0?k?|per_capita|per_100000/i.test(column);
      if (!isPerCapita && max > 100) {
        problems.push(`${column} exceeds 100 (${max}), which is out of bounds as either a proportion or a percentage`);
      }
    }
  }
  if (problems.length > 0) {
    return { state: "failed", reason: problems.slice(0, 4).join("; ") };
  }
  return {
    state: "passed",
    reason: "no negative counts, no negative rates, and no proportion column above 100",
  };
}

/**
 * Was the SQL produced deterministically from a validated plan?
 *
 * TAKES A SEALED DERIVATION, NOT A BOOLEAN. An earlier revision accepted
 * `deterministic: boolean` from the route and combined it with a QueryContract
 * parsed independently from the question -- so nothing connected the plan to the
 * SQL, and the check asserted deterministic derivation on a caller's word. Now it
 * verifies a token issued where the planner's SQL was produced against the SQL that
 * actually executed, which catches the real failure mode: the guardrail rewriter,
 * schema corrector, table-allowlist retry, and rolling-12-month retry can each
 * replace `sql` after planning. See lib/plan-derivation.ts for exactly what the
 * token does and does not prove.
 *
 * During Stage 1 every model path is unsealed, so this returns `unknown` for all
 * model traffic. That asymmetry is the migration measurement the shadow period
 * exists to collect (§10) -- not a bug to be softened.
 */
export function checkSemanticPlan(input: CheckInput, derivation: PlanDerivation | null): CheckOutcome {
  if (!input.contract) {
    return { state: "unknown", reason: "the question could not be parsed into a typed plan" };
  }
  const verdict = verifyPlanDerivation(derivation, input.sql);
  if (!verdict.ok) {
    return { state: "unknown", reason: verdict.reason };
  }
  if (input.contract.warnings.length > 0) {
    return {
      state: "unknown",
      reason: `deterministic plan carries unresolved warnings: ${input.contract.warnings.join(", ")}`,
    };
  }
  return { state: "passed", reason: verdict.reason };
}

/** Was the chart built from the same validated facts as the prose? */
export function checkChartData(hasChart: boolean, chartFromBindings: boolean): CheckOutcome {
  if (!hasChart) {
    return { state: "not_applicable", reason: "the response renders no chart" };
  }
  if (!chartFromBindings) {
    return {
      state: "unknown",
      reason: "a chart was rendered but not provably generated from the same validated bindings as the prose",
    };
  }
  return { state: "passed", reason: "chart inputs derive from the same validated bindings as the narrative" };
}

export interface RunChecksInput extends CheckInput {
  /** Sealed derivation token, or null for a model-authored answer. */
  derivation: PlanDerivation | null;
  hasChart: boolean;
  chartFromBindings: boolean;
  claims: NumericClaim[] | null;
}

export interface ChecksResult {
  states: Record<ProofCheck, CheckState>;
  reasons: Record<ProofCheck, string>;
  /** Justifications for every check that came back `not_applicable`. */
  notApplicableReasons: Partial<Record<ProofCheck, string>>;
}

/**
 * Run every v1 check and collect states, reasons, and not-applicable justifications.
 *
 * Every one of the ten frozen ProofCheck categories is assigned a state here. A
 * category left unassigned would default to `unknown` in the manifest anyway, but
 * assigning all ten explicitly means a newly-added category cannot silently
 * inherit a pass, and the reasons map stays complete for the reviewer queue.
 */
export function runProofChecks(input: RunChecksInput): ChecksResult {
  const outcomes: Record<ProofCheck, CheckOutcome> = {
    semanticPlan: checkSemanticPlan(input, input.derivation),
    canonicalGeographies: checkCanonicalGeographies(input),
    entityCompleteness: checkEntityCompleteness(input),
    metric: checkMetric(input),
    grain: checkGrain(input),
    timeRange: checkTimeRange(input),
    missingness: checkMissingness(input),
    reconciliation: checkReconciliation(input),
    claims: checkClaims(input.claims),
    chartData: checkChartData(input.hasChart, input.chartFromBindings),
  };

  const states = {} as Record<ProofCheck, CheckState>;
  const reasons = {} as Record<ProofCheck, string>;
  const notApplicableReasons: Partial<Record<ProofCheck, string>> = {};
  for (const [check, outcome] of Object.entries(outcomes) as [ProofCheck, CheckOutcome][]) {
    states[check] = outcome.state;
    reasons[check] = outcome.reason;
    if (outcome.state === "not_applicable") notApplicableReasons[check] = outcome.reason;
  }

  return { states, reasons, notApplicableReasons };
}
