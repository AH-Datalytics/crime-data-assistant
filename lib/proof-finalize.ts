/**
 * The single chokepoint where a factual answer becomes deliverable.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §5 (target architecture), §9.1 Stage 1, and §13 (contract tests).
 *
 * WHY A CHOKEPOINT AND NOT A CHECK AT EACH EXIT. The four route files contain
 * roughly 130 terminal responses between them (36 jsonResp sites in the NIBRS
 * route alone). Auditing "can a factual answer reach a user without proof?" by
 * reading 130 sites is not a question anyone can keep answering correctly as the
 * routes change. Instead:
 *
 *   1. Every factual payload must be paired with a ProofFinalization.
 *   2. ProofFinalization is branded and cannot be constructed outside this module.
 *   3. emitFactualPayload() requires one.
 *
 * So the ordering requirement in §13 -- "the first factual Current/Historical SSE
 * event cannot precede proof finalization" -- is enforced by the type checker
 * rather than by a regex over source text. A new exit that forgets to finalize
 * does not compile.
 *
 * THREE INVARIANTS THAT OUTRANK EVERYTHING ELSE HERE:
 *
 *   OFF IS FREE. In `off` mode this module does no digest work, no checks, no
 *   probes, and touches no database (§9.1). It returns a sentinel immediately.
 *
 *   SHADOW IS INVISIBLE. In `shadow` mode the payload is returned byte-identical.
 *   Nothing about routing, SQL, retries, rows, narrative, charts, clarification,
 *   decline behavior, or provenance changes (§3.14). Only additive internal audit
 *   state differs.
 *
 *   FAILURE MOVES TOWARD OFF. Any exception, timeout, or budget overrun inside
 *   this module is caught, recorded as `unknown`, and the user's response proceeds
 *   exactly as it would have. Handoff §3.15 and §9.1 require that a failure of the
 *   proof pipeline cannot stop or rewrite existing query logging, and cannot
 *   affect or delay a user response beyond the stated budget. lib/reliability-
 *   disclosure.ts documents a fail-open doctrine that this contract supersedes for
 *   factual correctness -- but fail-open remains correct for the OBSERVABILITY
 *   layer, which is what this module is until enforcement is approved.
 */

import type Database from "better-sqlite3";
import {
  createProofManifest,
  factualDeliveryBlocker,
  blockingChecks,
  type DeliveryAction,
  type DeliveryDecision,
  type Derivation,
  type ProofManifest,
  type SourceId,
} from "./proof-contract";
import { resolveMode, isObserving, mayAlterDelivery, type ProofMode } from "./proof-modes";
import { buildResultDigest, serializeResultDigest, type DigestPlanDeclaration, type ResultDigest } from "./result-digest";
import { runProofChecks, type NumericClaim } from "./proof-checks";
import { attributeOmissions, type OmittedCandidate } from "./omission-attribution";
import { buildQueryContract, type QueryContractSource } from "./query-contract";

/** Bumped when the persisted proof/digest pair changes shape incompatibly. */
export const PROOF_SCHEMA_VERSION = 1;

/**
 * Per-call soft budget in milliseconds (§11: <50 ms median, <100 ms p95 added).
 *
 * Enforced as an absolute figure rather than a fraction of request time, per the
 * Stage 0 baseline's note: median request latency is 3,800 ms, so a percentage
 * budget would silently permit ~190 ms of added work.
 */
export const PROOF_BUDGET_MS = 100;

/** Consecutive overruns before the shadow component disables itself for the process. */
export const PROOF_OVERRUN_LIMIT = 5;

/**
 * Process-local circuit breaker.
 *
 * §9.1: "automatically disable the shadow component if operational budgets are
 * exceeded." Deliberately process-local and non-persistent: a PM2 reload clears
 * it, which is the right granularity for a budget guard and avoids inventing
 * cross-process state that would itself need health accounting.
 */
const budgetState = {
  consecutiveOverruns: 0,
  selfDisabled: false,
  /** Set once so a tripped breaker does not flood the log on every request. */
  announced: false,
};

/** Test seam. Not exported for production use. */
export function __resetProofBudgetStateForTests(): void {
  budgetState.consecutiveOverruns = 0;
  budgetState.selfDisabled = false;
  budgetState.announced = false;
}

export function proofSelfDisabled(): boolean {
  return budgetState.selfDisabled;
}

function recordElapsed(elapsedMs: number): void {
  if (elapsedMs <= PROOF_BUDGET_MS) {
    budgetState.consecutiveOverruns = 0;
    return;
  }
  budgetState.consecutiveOverruns += 1;
  if (budgetState.consecutiveOverruns >= PROOF_OVERRUN_LIMIT && !budgetState.selfDisabled) {
    budgetState.selfDisabled = true;
    if (!budgetState.announced) {
      budgetState.announced = true;
      console.warn(
        `[proof] Shadow proof work disabled for this process: ${PROOF_OVERRUN_LIMIT} consecutive calls ` +
          `exceeded the ${PROOF_BUDGET_MS}ms budget. User responses are unaffected. Restart to re-enable.`,
      );
    }
  }
}

declare const proofFinalizationBrand: unique symbol;

/**
 * The observable fields of a finalization.
 *
 * Split from the branded type so the brand stays PURELY NOMINAL. `declare const`
 * has no runtime existence, so an object literal that used the brand as a computed
 * key -- `{ [proofFinalizationBrand]: true, ... }` -- type-checks and then throws
 * ReferenceError at runtime. That failure was silent in exactly the worst way: the
 * throw was caught by this module's own degradation handler, so every finalization
 * quietly became inert while tests that only checked "did it return something"
 * still passed. The brand is now never emitted; brandFinalization() applies it in
 * the type system only, in one place.
 */
interface ProofFinalizationFields {
  readonly mode: ProofMode;
  readonly sourceId: SourceId;
  readonly manifest: ProofManifest;
  readonly digest: ResultDigest | null;
  readonly decision: DeliveryDecision;
  /**
   * Why the manifest cannot support factual delivery, or null when it can.
   *
   * Recorded in shadow to answer the enforcement-readiness question ("what would
   * have blocked?") without acting on it.
   */
  readonly blocker: string | null;
  /**
   * Whether this finalization is permitted to change what the user receives.
   *
   * True only in `enforce`. Every delivery-altering branch in Stage 4 must gate on
   * this and nothing else, so "what can change a response?" has one greppable
   * answer.
   */
  readonly mayAlterDelivery: boolean;
  readonly elapsedMs: number;
  /** Set when finalization degraded because of an internal error or budget trip. */
  readonly degradedReason: string | null;
}

/**
 * Proof that finalization ran for one response, before it was sent.
 *
 * The brand is what makes this a gate rather than a convention: the type cannot be
 * produced by an object literal elsewhere in the codebase, so a factual emit site
 * has no way to fabricate one. It exists only in the type system -- see
 * ProofFinalizationFields above for why that distinction is load-bearing.
 */
export type ProofFinalization = ProofFinalizationFields & {
  readonly [proofFinalizationBrand]: true;
};

/** The only place the brand is applied. Adds no runtime property. */
function brandFinalization(fields: ProofFinalizationFields): ProofFinalization {
  return fields as ProofFinalization;
}

/** Everything finalization needs about one response. */
export interface ProofFinalizationInput {
  sourceId: SourceId;
  question: string;
  sql: string | null;
  rows: Record<string, unknown>[];
  columns: string[];
  truncated: boolean;
  /** True when SQL came from a deterministic planner rather than the model. */
  deterministic: boolean;
  /** Typed plan family, when the answer came from one. */
  planFamily: string | null;
  /** What the plan declares about the result's columns; drives digest sums. */
  plan?: DigestPlanDeclaration;
  /** Canonical entities the request asked for. */
  requestedEntities?: string[];
  /** Canonical entities present in the result. */
  returnedEntities?: string[];
  /** Requested entities absent from the result, for attribution. */
  omittedCandidates?: OmittedCandidate[];
  /** True when the delivered narrative openly states the narrower scope. */
  omissionsDisclosed?: boolean;
  /** Deterministic claim bindings. Null means none were produced. */
  claims?: NumericClaim[] | null;
  hasChart?: boolean;
  chartFromBindings?: boolean;
  retries?: number;
  guardrails?: string[];
  /** Read handle for omission probes. Null disables them, yielding `unknown`. */
  db?: Database.Database | null;
  sourceYearRange?: { min: number; max: number } | null;
  /** Terminal action the route intends. Factual actions require full proof. */
  intendedAction: DeliveryAction;
  /** Override for tests. Defaults to process.env. */
  env?: Record<string, string | undefined>;
}

function contractSourceFor(sourceId: SourceId): QueryContractSource {
  return sourceId;
}

/**
 * The sentinel returned in `off` mode and whenever finalization degrades.
 *
 * Its manifest is an all-`unknown` manifest, which factualDeliveryBlocker()
 * rejects. That is deliberate: a degraded finalization must never look like a
 * passing one. In `off` and `shadow` this has no user-visible consequence; if the
 * same degradation happened under `enforce`, the correct behavior is to withhold
 * the factual claim, and this shape produces that automatically rather than
 * requiring a separate error path to remember to.
 */
function inertFinalization(
  sourceId: SourceId,
  mode: ProofMode,
  intendedAction: DeliveryAction,
  elapsedMs: number,
  degradedReason: string | null,
): ProofFinalization {
  const manifest = createProofManifest(sourceId, "model_authored");
  return brandFinalization({
    mode,
    sourceId,
    manifest,
    digest: null,
    decision: { action: intendedAction, requested: null, included: null, omissions: [], retries: 0 },
    blocker: factualDeliveryBlocker(manifest),
    mayAlterDelivery: false,
    elapsedMs,
    degradedReason,
  });
}

/**
 * Run proof finalization for one response.
 *
 * MUST be called before the response's first factual byte is written. Never
 * throws. Never mutates its input.
 */
export function finalizeProof(input: ProofFinalizationInput): ProofFinalization {
  const env = input.env ?? process.env;
  const resolution = resolveMode(input.sourceId, input.planFamily, env);
  const mode = resolution.mode;

  // OFF IS FREE. No digest, no checks, no probes, no database access.
  if (!isObserving(mode)) {
    return inertFinalization(input.sourceId, mode, input.intendedAction, 0, null);
  }

  // The circuit breaker degrades to the same inert shape as `off`, so a tripped
  // budget cannot leave a half-computed manifest that reads as partial evidence.
  if (budgetState.selfDisabled) {
    return inertFinalization(
      input.sourceId,
      mode,
      input.intendedAction,
      0,
      `shadow proof work self-disabled after ${PROOF_OVERRUN_LIMIT} consecutive budget overruns`,
    );
  }

  const startedAt = Date.now();
  try {
    const contract = buildQueryContract(input.question, contractSourceFor(input.sourceId), null);

    // Source health is Stage 2 scope (§9.1). Until the per-capability registry
    // exists, health is honestly `unknown` -- which blocks factual delivery. That
    // is the correct Stage 1 state, not a gap: an answer whose source health was
    // never established has not met §2.1, and recording it as `passed` here would
    // manufacture the exact false assurance this project exists to remove.
    const manifest = createProofManifest(
      input.sourceId,
      input.deterministic ? "deterministic" : ("model_authored" as Derivation),
    );
    manifest.planFamily = input.planFamily;

    const attribution = attributeOmissions(input.omittedCandidates ?? [], {
      sourceId: input.sourceId,
      db: input.db ?? null,
      sourceYearRange: input.sourceYearRange ?? null,
      // Honestly `unknown` until Stage 2 builds the per-capability registry. NOT
      // "degraded": that would assert a source failure nobody checked for, and it
      // would mask the probe evidence with a blanket source_unhealthy on every
      // omission. Unknown health still blocks delivery via manifest.source.health
      // below, which is where §8's "unknown is treated as degraded" belongs.
      sourceHealth: "unknown",
    });

    const checks = runProofChecks({
      question: input.question,
      sql: input.sql,
      rows: input.rows,
      columns: input.columns,
      contract,
      requestedEntities: input.requestedEntities ?? [],
      returnedEntities: input.returnedEntities ?? [],
      omissionsDisclosed: Boolean(input.omissionsDisclosed),
      deterministic: input.deterministic,
      hasChart: Boolean(input.hasChart),
      chartFromBindings: Boolean(input.chartFromBindings),
      claims: input.claims ?? null,
    });
    manifest.checks = checks.states;
    manifest.notApplicableReasons = checks.notApplicableReasons;

    const digest = buildResultDigest({
      rows: input.rows,
      columns: input.columns,
      truncated: input.truncated,
      plan: { ...(input.plan ?? {}), planFamily: input.planFamily },
      requestedEntities: input.requestedEntities,
      returnedEntities: input.returnedEntities,
      omissions: attribution.omissions,
      retries: input.retries,
      guardrails: input.guardrails,
    });

    const blocker = factualDeliveryBlocker(manifest);

    const decision: DeliveryDecision = {
      action: input.intendedAction,
      requested: input.requestedEntities?.length ?? null,
      included: input.returnedEntities?.length ?? null,
      omissions: attribution.omissions,
      retries: input.retries ?? 0,
    };

    const elapsedMs = Date.now() - startedAt;
    recordElapsed(elapsedMs);

    return brandFinalization({
      mode,
      sourceId: input.sourceId,
      manifest,
      digest,
      decision,
      blocker,
      // Even in `enforce`, delivery may only change for the explicitly authorized
      // source x family -- resolveMode() already required three independent
      // authorizations to return `enforce`, so this is simply that decision.
      mayAlterDelivery: mayAlterDelivery(mode),
      elapsedMs,
      degradedReason: null,
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    recordElapsed(elapsedMs);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[proof] finalization degraded (response unaffected): ${reason}`);
    return inertFinalization(input.sourceId, mode, input.intendedAction, elapsedMs, reason);
  }
}

/**
 * The fields a logger persists for one finalization.
 *
 * Every value is either a bounded string or null, so a logger can splice them into
 * an INSERT without further sanitization.
 */
export interface ProofLogFields {
  delivery_action: string | null;
  proof_manifest: string | null;
  result_digest: string | null;
  proof_schema_version: number | null;
  proof_mode: string | null;
  plan_family: string | null;
}

/** Nothing to persist -- used in `off` mode so the logger writes exactly what it always did. */
export const EMPTY_PROOF_LOG_FIELDS: ProofLogFields = {
  delivery_action: null,
  proof_manifest: null,
  result_digest: null,
  proof_schema_version: null,
  proof_mode: null,
  plan_family: null,
};

/**
 * Project a finalization into persistable columns.
 *
 * In `off` mode this returns EMPTY_PROOF_LOG_FIELDS, so an off-mode deployment
 * writes query_log rows that are byte-for-byte what the baseline release writes.
 * That is what makes the "off changes nothing" claim in §13 checkable rather than
 * merely intended.
 */
export function proofLogFields(finalization: ProofFinalization | null): ProofLogFields {
  if (!finalization || !isObserving(finalization.mode)) return EMPTY_PROOF_LOG_FIELDS;
  const manifestJson = (() => {
    try {
      // Blocker and check reasons are carried alongside the frozen manifest shape
      // rather than inside it: ProofManifest is a persisted wire format (§15) and
      // must not grow diagnostic fields that a later reader would have to tolerate.
      return JSON.stringify({
        manifest: finalization.manifest,
        blocker: finalization.blocker,
        blockingChecks: blockingChecks(finalization.manifest),
        elapsedMs: finalization.elapsedMs,
        degradedReason: finalization.degradedReason,
      }).slice(0, 4000);
    } catch {
      return null;
    }
  })();
  const digestJson = finalization.digest ? serializeResultDigest(finalization.digest) : null;
  return {
    delivery_action: finalization.decision.action,
    proof_manifest: manifestJson,
    result_digest: digestJson,
    proof_schema_version: PROOF_SCHEMA_VERSION,
    proof_mode: finalization.mode,
    plan_family: finalization.manifest.planFamily,
  };
}

/**
 * Gate for emitting a factual payload.
 *
 * Requiring a ProofFinalization argument is the entire mechanism. In `off` and
 * `shadow` the payload is returned unchanged -- referentially identical, not a
 * copy, so no serialization difference can creep in. Stage 4 adds the enforce
 * branch here and nowhere else.
 */
export function emitFactualPayload<T>(finalization: ProofFinalization, payload: T): T {
  if (!finalization.mayAlterDelivery) return payload;
  // Stage 4 will substitute a clarify/decline payload here when `blocker` is
  // non-null. Until enforcement is approved by the owner, `mayAlterDelivery` is
  // false for every source and family, so this branch is unreachable in
  // production and intentionally returns the payload unchanged.
  return payload;
}
