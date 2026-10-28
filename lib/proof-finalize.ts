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
  isAdmissiblePair,
  type DeliveryAction,
  type DeliveryDecision,
  type Outcome,
  type Derivation,
  type ProofManifest,
  type SourceId,
} from "./proof-contract";
import { resolveMode, isObserving, mayAlterDelivery, outcomeWritesEnabled, type ProofMode } from "./proof-modes";
import { buildResultDigest, serializeResultDigest, type DigestPlanDeclaration, type ResultDigest } from "./result-digest";
import { runProofChecks, type NumericClaim } from "./proof-checks";
import { attributeOmissions, type OmittedCandidate } from "./omission-attribution";
import { buildQueryContract, type QueryContract, type QueryContractSource } from "./query-contract";
import { verifyPlanDerivation, type PlanDerivation } from "./plan-derivation";
import { narrativeDisclosesOmissions } from "./omission-wording";
import { recordFinalization, recordEmission } from "./why-scope";
import { projectAnswer, projectPayload } from "./answer-columns";
import {
  omittedCandidatesFor,
  requestedEntitiesFromRequest,
  requestedYearsFromContract,
  type RequestedEntity,
} from "./requested-entities";

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

/**
 * The clock the budget is measured against. Production always reads `Date.now`; the seam exists
 * so the budget accounting and the circuit breaker can be tested against a deterministic clock
 * instead of against how fast the test machine happened to be.
 */
let now: () => number = Date.now;

/** Test seam. Pass nothing to restore the real clock. Not exported for production use. */
export function __setProofClockForTests(clock?: () => number): void {
  now = clock ?? Date.now;
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
  /**
   * Set when a level asked to enforce but authorization was narrowed.
   *
   * Kept distinct from degradedReason: a withheld enforcement is a correct, deliberate
   * outcome of the authorization rules, not a malfunction. Collapsing the two would
   * make a half-configured rollout read as a proof-system fault in the reviewer queue.
   */
  readonly enforcementWithheldReason: string | null;
  /**
   * The action the CONTRACT would require, as distinct from what was delivered.
   *
   * `decision.action` records what the user actually received, which in shadow is
   * always what the route intended -- that is what shadow means. But recording only
   * that made a blocked answer indistinguishable from a proven one in the log: both
   * showed `delivery_action = answer`. Handoff §14.1 requires the digest to report
   * "would-answer/would-narrow/would-clarify/would-decline counts", which needs the
   * counterfactual stored alongside the fact.
   */
  readonly hypotheticalAction: DeliveryAction;
  /** Per-check reasons, for the reviewer queue. Shed first if the envelope is large. */
  readonly checkReasons: Record<string, string> | null;
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

declare const sealedPayloadBrand: unique symbol;

/**
 * A factual payload that has passed through the gate.
 *
 * THIS IS WHAT MAKES THE CHOKEPOINT REAL. Requiring a ProofFinalization argument on
 * emitFactualPayload() only constrains code that chooses to call it -- a route could
 * still hand a raw `{ success: true, ... }` straight to jsonResp(), and one did: the
 * Hate Crime metadata answer finalized and then responded without the wrap, so the
 * finalization was computed and discarded.
 *
 * Sealing the PAYLOAD closes that. The response constructors now accept only a
 * SealedPayload for factual content, and this type is produced nowhere but
 * emitFactualPayload(). An unwrapped factual exit is a compile error, not a review
 * finding. Purely nominal -- no runtime property is added (see
 * ProofFinalizationFields for why that distinction is load-bearing here).
 */
export type SealedPayload<T> = T & { readonly [sealedPayloadBrand]: true };

/** Everything finalization needs about one response. */
export interface ProofFinalizationInput {
  sourceId: SourceId;
  question: string;
  sql: string | null;
  rows: Record<string, unknown>[];
  columns: string[];
  truncated: boolean;
  /**
   * Sealed proof that a deterministic planner produced this SQL, or null.
   *
   * Replaces a `deterministic: boolean`. A boolean asserted deterministic
   * derivation on the caller's word and could not detect SQL rewritten between
   * planning and execution -- which four separate retry paths in these routes do.
   * See lib/plan-derivation.ts.
   */
  derivation?: PlanDerivation | null;
  /** Typed plan family, when the answer came from one. */
  planFamily: string | null;
  /** What the plan declares about the result's columns; drives digest sums. */
  plan?: DigestPlanDeclaration;
  /**
   * Canonical entities the request asked for.
   *
   * OMIT THIS unless a deterministic planner knows better than the typed plan does.
   * When absent it is derived from the parsed request via
   * requestedEntitiesFromRequest(). Deriving it from the generated SQL -- which the
   * first revision did -- makes the completeness check unable to see a dropped
   * entity, because the SQL that dropped it also defines what was "requested".
   */
  requestedEntities?: string[];
  /** Canonical entities present in the result. */
  returnedEntities?: string[];
  // omittedCandidates is deliberately NOT an input. It was an escape hatch that let a
  // caller declare which entities were missing -- i.e. declare its own completeness --
  // and no route ever used it. Omissions are computed here from the requested set minus
  // what came back, so the numbers reconcile by construction.
  /**
   * The exact narrative text being delivered with this payload.
   *
   * Supplied so `omissionsDisclosed` can be DERIVED by checking whether the text
   * actually names every omitted entity, rather than accepted as a caller's
   * assertion. A route asserting `true` would let a silent omission pass
   * entityCompleteness -- the same class of unverified claim as the old
   * `deterministic` boolean.
   *
   * Omit for exits that deliver no narrative; omissions then count as undisclosed,
   * which is the safe direction.
   */
  narrative?: string | null;
  /** Deterministic claim bindings. Null means none were produced. */
  claims?: NumericClaim[] | null;
  hasChart?: boolean;
  chartFromBindings?: boolean;
  retries?: number;
  guardrails?: string[];
  /** Read handle for omission probes. Null disables them, yielding `unknown`. */
  db?: Database.Database | null;
  sourceYearRange?: { min: number; max: number } | null;
  /**
   * The whole typed outcome the exit supplies: action AND reason, as one value.
   *
   * Replaces `intendedAction`. A pair cannot desynchronize the way two parallel properties can,
   * and a computed site selects between two whole `Outcome` constants rather than between an
   * action and, separately, a reason.
   */
  outcome: Outcome;
  /**
   * The effective request, when the route built it by amendment. Proof then reasons about the same
   * requested places and years the validator checked, instead of re-parsing `question`. A contract
   * for a different source is ignored.
   */
  contract?: QueryContract | null;
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
  outcome: Outcome,
  elapsedMs: number,
  degradedReason: string | null,
): ProofFinalization {
  const manifest = createProofManifest(sourceId, "model_authored");
  return brandFinalization({
    mode,
    sourceId,
    manifest,
    digest: null,
    // Both halves of the outcome survive the inert path. The reason costs nothing to carry and
    // dropping it here would make `off`-mode and degraded rows silently reason-less, which is the
    // one place a missing carrier would be hardest to notice.
    decision: {
      action: outcome.action,
      reason: outcome.reason,
      requested: null,
      included: null,
      omissions: [],
      retries: 0,
    },
    blocker: factualDeliveryBlocker(manifest),
    mayAlterDelivery: false,
    elapsedMs,
    degradedReason,
    // An inert finalization proves nothing, so the contract could not have
    // authorized a factual answer regardless of what the route intended.
    hypotheticalAction: hypotheticalFor(outcome.action, factualDeliveryBlocker(manifest)),
    checkReasons: null,
    enforcementWithheldReason: null,
  });
}

/**
 * What the contract would require, given whether proof succeeded.
 *
 * A blocked factual intent becomes `decline_capability`: the product could not
 * establish the claim, which under §2.4 is a capability statement and never an
 * invented source limitation. A non-factual intent is unaffected -- a clarify is a
 * clarify whether or not a manifest passed.
 */
function hypotheticalFor(intended: DeliveryAction, blocker: string | null): DeliveryAction {
  if (blocker === null) return intended;
  if (intended === "answer" || intended === "answer_limited_scope") return "decline_capability";
  return intended;
}

/**
 * Run proof finalization for one response.
 *
 * MUST be called before the response's first factual byte is written. Never
 * throws. Never mutates its input.
 */
/**
 * Stage 3b (amendment A1): every finalization of an INNER run (lib/why-context.ts) is recorded with its own input,
 * on every path including proof-off, so the outer "why" turn can finalize the composed answer from the same input.
 * Outside an inner run this records nothing.
 */
export function finalizeProof(given: ProofFinalizationInput): ProofFinalization {
  // The answer contract (lib/answer-columns.ts): proof checks and the digest see the answer the user is given.
  const input = projectedInput(given);
  const finalization = finalizeProofPaths(input);
  recordFinalization(finalization, input);
  return finalization;
}

function projectedInput(input: ProofFinalizationInput): ProofFinalizationInput {
  const projected = projectAnswer(input.columns, input.rows);
  return projected.dropped.length ? { ...input, columns: projected.columns, rows: projected.rows } : input;
}

function finalizeProofPaths(input: ProofFinalizationInput): ProofFinalization {
  const env = input.env ?? process.env;
  // PHASE 1: resolve with the CALLER's family, only to decide whether to do any work.
  // This value must never be the one that authorizes enforcement -- the family is
  // unverified at this point, and per-family enforcement keyed on an unverified
  // family would let a token sealed for family A be authorized by family B's
  // environment variable. Phase 2 below re-resolves against the verified family.
  const provisional = resolveMode(input.sourceId, input.planFamily, env);

  // OFF IS FREE. No digest, no checks, no probes, no database access.
  if (!isObserving(provisional.mode)) {
    return inertFinalization(input.sourceId, provisional.mode, input.outcome, 0, null);
  }
  const mode = provisional.mode;

  // The circuit breaker degrades to the same inert shape as `off`, so a tripped
  // budget cannot leave a half-computed manifest that reads as partial evidence.
  if (budgetState.selfDisabled) {
    return inertFinalization(
      input.sourceId,
      mode,
      input.outcome,
      0,
      `shadow proof work self-disabled after ${PROOF_OVERRUN_LIMIT} consecutive budget overruns`,
    );
  }

  const startedAt = now();
  try {
    const contract = input.contract && input.contract.source === contractSourceFor(input.sourceId)
      ? input.contract
      : buildQueryContract(input.question, contractSourceFor(input.sourceId), null);

    // Source health is Stage 2 scope (§9.1). Until the per-capability registry
    // exists, health is honestly `unknown` -- which blocks factual delivery. That
    // is the correct Stage 1 state, not a gap: an answer whose source health was
    // never established has not met §2.1, and recording it as `passed` here would
    // manufacture the exact false assurance this project exists to remove.
    // Derivation is VERIFIED here, not asserted by the caller: the token is checked
    // against the SQL that actually executed, so a deterministic plan whose SQL was
    // rewritten by a guardrail or a retry is correctly recorded as model_authored.
    const derivation = input.derivation ?? null;
    // The caller's claimed family is passed as the expectation, so a token sealed for
    // a different family fails verification instead of silently relabelling the answer.
    const derivationVerdict = verifyPlanDerivation(derivation, input.sql, input.planFamily);
    const manifest = createProofManifest(
      input.sourceId,
      derivationVerdict.ok ? "deterministic" : ("model_authored" as Derivation),
    );
    // THE VERIFIED TOKEN'S FAMILY IS AUTHORITATIVE, NOT THE CALLER'S CLAIM.
    //
    // Three cases, and the middle one is the defect this replaces:
    //   - verified token  -> the token's family, which is proven
    //   - token that FAILED verification -> null. Previously this fell back to
    //     input.planFamily, so a compiler token sealed for family A presented with
    //     `planFamily: "family-b"` was recorded as family-b and, worse, authorized by
    //     family-b's environment variable. A family claim from a token that did not
    //     verify is not evidence of anything.
    //   - no token at all -> the caller's label, which is descriptive only. Clarify and
    //     decline exits use families like "geo:ambiguous-state" and assert no derivation.
    manifest.planFamily = derivation
      ? derivationVerdict.ok
        ? derivation.planFamily
        : null
      : input.planFamily ?? null;

    // WHAT WAS ASKED FOR COMES FROM THE REQUEST, NOT THE GENERATED SQL. If the SQL
    // omits Dallas, deriving the requested set from that SQL makes Dallas vanish
    // from both the result and the expectation, and entityCompleteness passes on a
    // silently dropped city. Only a deterministic planner may override, because it
    // knows its own entity list (multi-city pivots cities into columns, where row
    // scanning cannot see them).
    // ONE authoritative requested set drives requested, included, AND omissions.
    //
    // An earlier revision counted `requested` from the caller's override while
    // deriving omissions from the parsed request, so the two described different sets:
    // a deterministic planner declaring three cities against a one-city question
    // reported requested=3, included=3, omissions=0. Every downstream number has to
    // come from the same list or they cannot reconcile.
    const requestedEntityList: RequestedEntity[] = input.requestedEntities
      ? input.requestedEntities.map((label) => ({ entityId: label.toLowerCase(), label, state: null }))
      : requestedEntitiesFromRequest(contract);
    const requestedEntities = requestedEntityList.map((entity) => entity.label);
    const returnedEntities = input.returnedEntities ?? [];

    // Computed here, never supplied -- see the note on the removed input. Passing none
    // is why the first revision's attribution recorded zero omissions everywhere.
    const omittedCandidates = omittedCandidatesFor(
      requestedEntityList,
      returnedEntities,
      requestedYearsFromContract(contract),
    );

    const attribution = attributeOmissions(omittedCandidates, {
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

    // DERIVED from the generated notice, not inferred from prose. A narrative that
    // merely mentions an omitted city discloses nothing about its absence.
    const disclosed = narrativeDisclosesOmissions(input.narrative, attribution.omissions);

    const checks = runProofChecks({
      question: input.question,
      sql: input.sql,
      rows: input.rows,
      columns: input.columns,
      contract,
      requestedEntities,
      returnedEntities,
      omissionsDisclosed: disclosed,
      derivation,
      expectedFamily: input.planFamily,
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
      plan: { ...(input.plan ?? {}), planFamily: manifest.planFamily },
      requestedEntities,
      returnedEntities,
      omissions: attribution.omissions,
      retries: input.retries,
      guardrails: input.guardrails,
    });

    const blocker = factualDeliveryBlocker(manifest);

    const decision: DeliveryDecision = {
      // What the user ACTUALLY receives. In shadow this is always the route's
      // intent; hypotheticalAction below carries what the contract would require.
      action: input.outcome.action,
      reason: input.outcome.reason,
      requested: requestedEntities.length > 0 ? requestedEntities.length : null,
      // REQUESTED ENTITIES SUCCESSFULLY MATCHED -- not returnedEntities.length.
      // returnedEntities holds alias-expanded row values across city, agency, and
      // state columns, so a single Chicago row contributes "chicago" and "il" and one
      // included entity would have been counted as two. The count that means anything
      // is how many of the requested entities came back.
      included:
        requestedEntities.length > 0
          ? Math.max(0, requestedEntities.length - omittedCandidates.length)
          : null,
      omissions: attribution.omissions,
      retries: input.retries ?? 0,
    };

    // PHASE 2: enforcement authorization, now that the family is verified.
    //
    // Two independent guards, both narrowing only:
    //   - the family used for authorization is the VERIFIED one, so a mislabelled
    //     token cannot borrow another family's approval;
    //   - a route-issued token may never authorize delivery at all. It proves SQL
    //     identity, not that a deterministic compiler produced the query, so it is
    //     shadow instrumentation. Compiler-issued tokens arrive in Stage 6.
    let effectiveMode = mode;
    // resolveMode already explains a phase-1 cap (a half-configured rollout that asked
    // to enforce without authorization at every level). Discarding it left the
    // finalization silent about the most common reason enforcement does not engage.
    let enforcementWithheld: string | null = provisional.enforcementWithheldReason ?? null;
    if (mayAlterDelivery(mode)) {
      // ENFORCEMENT REQUIRES A VERIFIED, COMPILER-ISSUED TOKEN AND THE VERIFIED
      // FAMILY'S OWN AUTHORIZATION. Ordered so the strongest precondition is checked
      // first: without a passing verdict there is no trustworthy family to authorize
      // against, and an earlier revision checked only the issuer -- so a compiler token
      // whose family did NOT verify still reached `enforce` under the caller's claimed
      // family. It failed closed on the manifest blocker, but the enforcement identity
      // and the per-family accounting were both wrong, which is precisely what the
      // Stage 4 rollout gates on.
      if (!derivation) {
        effectiveMode = "shadow";
        enforcementWithheld = "enforcement withheld: no plan derivation was sealed for this answer";
      } else if (!derivationVerdict.ok) {
        effectiveMode = "shadow";
        enforcementWithheld = `enforcement withheld: derivation did not verify (${derivationVerdict.reason})`;
      } else if (derivation.issuer !== "compiler") {
        effectiveMode = "shadow";
        enforcementWithheld =
          `enforcement withheld: derivation is ${derivation.issuer}-issued, which proves SQL identity ` +
          "but not compiler provenance";
      } else if (!mayAlterDelivery(resolveMode(input.sourceId, manifest.planFamily, env).mode)) {
        effectiveMode = "shadow";
        enforcementWithheld =
          `enforcement withheld: verified plan family '${manifest.planFamily ?? "(none)"}' is not authorized to enforce`;
      }
    }

    const elapsedMs = now() - startedAt;
    recordElapsed(elapsedMs);

    return brandFinalization({
      mode: effectiveMode,
      sourceId: input.sourceId,
      manifest,
      digest,
      decision,
      blocker,
      // Even in `enforce`, delivery may only change for the explicitly authorized
      // source x family -- resolveMode() already required three independent
      // authorizations to return `enforce`, so this is simply that decision.
      mayAlterDelivery: mayAlterDelivery(effectiveMode),
      elapsedMs,
      degradedReason: null,
      enforcementWithheldReason: enforcementWithheld,
      hypotheticalAction: hypotheticalFor(input.outcome.action, blocker),
      checkReasons: checks.reasons,
    });
  } catch (error) {
    const elapsedMs = now() - startedAt;
    recordElapsed(elapsedMs);
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[proof] finalization degraded (response unaffected): ${reason}`);
    return inertFinalization(input.sourceId, mode, input.outcome, elapsedMs, reason);
  }
}

/**
 * The fields a logger persists for one finalization.
 *
 * Every value is either a bounded string or null, so a logger can splice them into
 * an INSERT without further sanitization.
 */
export interface ProofLogFields {
  proof_manifest: string | null;
  result_digest: string | null;
  proof_schema_version: number | null;
  proof_mode: string | null;
  plan_family: string | null;
}

/** Storage bound for the proof_manifest column. */
export const MAX_PROOF_MANIFEST_CHARS = 4000;

function boundString(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Serialize the proof envelope so the stored value is ALWAYS valid JSON.
 *
 * THE BUG THIS REPLACES. The previous implementation did
 * `JSON.stringify({...}).slice(0, 4000)`, which truncates mid-token and produces
 * unparseable text. It is reachable in production: a better-sqlite3 error message
 * quotes the failing statement, so a degraded finalization carrying a long
 * SqliteError filled the whole budget and stored exactly 4,000 characters ending in
 * an unterminated string. The reviewer queue and the digest both JSON.parse this
 * column, so the corruption surfaces as a lost record rather than an error -- and
 * the original test asserted only `length <= 4000`, which the corrupt value passed.
 *
 * Fields are bounded individually BEFORE serialization, and if the envelope is
 * still too large it sheds whole fields and re-serializes. Nothing is ever sliced
 * after stringify.
 */
function serializeProofEnvelope(finalization: ProofFinalization): string | null {
  const blocking = blockingChecks(finalization.manifest);
  const base = {
    manifest: finalization.manifest,
    blocker: boundString(finalization.blocker, 400),
    blockingChecks: blocking,
    elapsedMs: finalization.elapsedMs,
    degradedReason: boundString(finalization.degradedReason, 600),
    // What the contract WOULD have required. See ProofFinalization.hypotheticalAction.
    hypotheticalAction: finalization.hypotheticalAction,
    checkReasons: finalization.checkReasons,
    enforcementWithheldReason: boundString(finalization.enforcementWithheldReason, 300),
  };

  // Progressive shedding, most diagnostic first. Each rung re-serializes from
  // scratch, so every candidate is complete and parseable by construction.
  const candidates: (() => unknown)[] = [
    () => base,
    () => ({ ...base, checkReasons: undefined }),
    () => ({ ...base, checkReasons: undefined, manifest: { ...finalization.manifest, notApplicableReasons: {} } }),
    () => ({
      manifest: { ...finalization.manifest, notApplicableReasons: {} },
      blocker: boundString(finalization.blocker, 120),
      blockingChecks: blocking,
      elapsedMs: finalization.elapsedMs,
      degradedReason: boundString(finalization.degradedReason, 120),
      hypotheticalAction: finalization.hypotheticalAction,
    }),
    () => ({
      v: finalization.manifest.v,
      envelopeReduced: true,
      blockingChecks: blocking,
      hypotheticalAction: finalization.hypotheticalAction,
    }),
  ];

  for (const build of candidates) {
    try {
      const json = JSON.stringify(build());
      if (typeof json === "string" && json.length <= MAX_PROOF_MANIFEST_CHARS) return json;
    } catch {
      // Try the next, smaller shape.
    }
  }
  // Last resort: a fixed, known-short, valid envelope. Recorded as an error rather
  // than stored as null, so "the envelope could not be built" is visible instead of
  // looking like a row the proof system never touched.
  return JSON.stringify({ v: finalization.manifest.v, envelopeError: true });
}

/** Nothing to persist -- used in `off` mode so the logger writes exactly what it always did. */
export const EMPTY_PROOF_LOG_FIELDS: ProofLogFields = {
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
  const digestJson = finalization.digest ? serializeResultDigest(finalization.digest) : null;
  return {
    proof_manifest: serializeProofEnvelope(finalization),
    result_digest: digestJson,
    proof_schema_version: PROOF_SCHEMA_VERSION,
    proof_mode: finalization.mode,
    plan_family: finalization.manifest.planFamily,
  };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * The OUTCOME projector (P2.1 §4.4).
 *
 * Two projectors with DISJOINT column sets, so the outcome/proof boundary is structural rather
 * than procedural. `outcomeLogFields` owns record_kind, delivery_action and reason_code;
 * `proofLogFields` owns the five proof-owned columns and nothing else. Under outcome-only
 * activation every proof-owned column stays NULL — including proof_schema_version, whose presence
 * would be the first quiet claim that proof material had been persisted.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * What the row is, supplied by the exit rather than inferred.
 *
 * Discriminated on purpose. A positional `(finalization, recordKind)` pair lets a `decision`
 * arrive with no finalization and an `operational` record arrive carrying one — the same
 * parallel-carrier defect the `Outcome` union removes for action and reason, one layer up. Here
 * neither mismatch is expressible.
 *
 * Never inferred from `error IS NULL` or from a NULL outcome: `nibrs-query`'s mid-flight
 * diagnostic writes an operational row on a request that then continues to a real decision exit,
 * so inference would mislabel it.
 */
export type OutcomeLogRecord =
  | { kind: "decision"; finalization: ProofFinalization }
  | { kind: "operational" };

/** The three outcome-owned columns. */
export interface OutcomeLogFields {
  record_kind: string | null;
  delivery_action: string | null;
  reason_code: string | null;
}

export const EMPTY_OUTCOME_LOG_FIELDS: OutcomeLogFields = {
  record_kind: null,
  delivery_action: null,
  reason_code: null,
};

/** Wrap a finalization as a decision record. The only way a decision row is expressed. */
export function decisionRecord(finalization: ProofFinalization): OutcomeLogRecord {
  return { kind: "decision", finalization };
}

/** The single operational marker. An operational row asserts no product decision. */
export const OPERATIONAL_RECORD: OutcomeLogRecord = Object.freeze({ kind: "operational" as const });

/**
 * Normalize what an exit hands the route-local logger into the discriminated carrier.
 *
 * The two inputs are structurally disjoint: a `ProofFinalization` is branded and has no `kind`,
 * and an `OutcomeLogRecord` has nothing else. So a decision exit cannot express "operational" and
 * an operational exit cannot smuggle in a finalization — which is the mismatch the discriminated
 * record exists to prevent. `null` means "this exit is not instrumented yet" and yields the
 * baseline all-NULL row.
 */
export function asOutcomeRecord(
  value: ProofFinalization | OutcomeLogRecord | null,
): OutcomeLogRecord | null {
  if (value === null) return null;
  return "kind" in value ? value : { kind: "decision", finalization: value };
}

/** The finalization a row carries, if any. Operational rows carry none, so proof columns stay NULL. */
export function decisionFinalization(
  value: ProofFinalization | OutcomeLogRecord | null,
): ProofFinalization | null {
  const record = asOutcomeRecord(value);
  return record && record.kind === "decision" ? record.finalization : null;
}

/**
 * Project the outcome columns.
 *
 * Gate-off returns all-NULL, so a row built with outcome logging disabled is byte-identical to
 * what the baseline release writes.
 *
 * DEGRADES RATHER THAN THROWS on an out-of-vocabulary value. There is deliberately no CHECK
 * constraint on these columns: both loggers swallow insert failures, so a rejected value would
 * destroy the whole log row — question, SQL, response, timing — and losing the row loses strictly
 * more than losing the outcome. An escaped value nulls only these three columns and logs an error,
 * which surfaces as a coverage violation: visible and failing, never an accepted bad code.
 */
export function outcomeLogFields(
  record: OutcomeLogRecord | null,
  env: Record<string, string | undefined> = process.env,
): OutcomeLogFields {
  if (record === null) return EMPTY_OUTCOME_LOG_FIELDS;
  const mode = record.kind === "decision" ? record.finalization.mode : null;
  if (!outcomeWritesEnabled(env, mode)) return EMPTY_OUTCOME_LOG_FIELDS;

  if (record.kind === "operational") {
    return { record_kind: "operational", delivery_action: null, reason_code: null };
  }

  const { action, reason } = record.finalization.decision;
  if (!isAdmissiblePair("query_log", action, reason)) {
    console.error(
      `[outcome] refusing an inadmissible query_log pair; the row is written with NULL outcome ` +
        `columns and will surface as a coverage violation. action=${JSON.stringify(action)} ` +
        `reason=${JSON.stringify(reason)}`,
    );
    return { record_kind: "decision", delivery_action: null, reason_code: null };
  }
  return { record_kind: "decision", delivery_action: action, reason_code: reason };
}

/**
 * Gate for emitting a factual payload.
 *
 * Two things make this a real chokepoint rather than a convention:
 *
 *   1. It requires a ProofFinalization, which only this module can construct.
 *   2. It returns a SealedPayload, which only this function can produce -- and the
 *      response constructors (sseEvent, jsonResp) accept nothing else for factual
 *      content. So a factual exit that skips the gate does not compile.
 *
 * Requirement 2 was missing at first, and a route did exactly what its absence
 * allowed: the Hate Crime metadata answer finalized, then responded without the
 * wrap, discarding the finalization it had just computed.
 *
 * In `off` and `shadow` the payload is returned REFERENTIALLY identical, not a copy,
 * so no serialization difference can creep in. Stage 4 adds the enforce branch here
 * and nowhere else.
 */
export function emitFactualPayload<T>(finalization: ProofFinalization, payload: T): SealedPayload<T> {
  // Stage 3b (A1): an INNER run's emission is captured, paired with its finalization input; the outer turn delivers.
  recordEmission(finalization, payload);
  // The capture keeps the unprojected payload: it is internal evidence (a "why" turn reads its notes), never
  // delivered as is -- the outer turn re-emits through this function, which projects it.
  // The answer contract (lib/answer-columns.ts): annotation columns never reach the user. The same pure projection
  // runs on finalizeProof()'s input, so the delivered answer and the finalized one agree. A payload with nothing to
  // drop is returned referentially identical, as before.
  const delivered = projectPayload(payload);
  if (!finalization.mayAlterDelivery) return delivered as SealedPayload<T>;
  // Stage 4 will substitute a clarify/decline payload here when `blocker` is
  // non-null. Until enforcement is approved by the owner, `mayAlterDelivery` is
  // false for every source and family, so this branch is unreachable in
  // production and intentionally returns the payload unchanged.
  return delivered as SealedPayload<T>;
}
