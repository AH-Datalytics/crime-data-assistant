/**
 * The NIBRS route's recovery and terminal decisions — as production code the route calls.
 *
 * WHY THIS EXISTS (review §2C). These decisions lived inline in the route, so the only way
 * to test them was to reimplement them inside a test. A mirrored copy proves the copy is
 * right; it cannot prove the shipped branch is. Worse, a mutation that removed the peer
 * stop from the route would leave the mirrored test green.
 *
 * Everything the route decides after an execution failure now lives here: whether to stop
 * or recover, and exactly what the reader is told. The route calls these functions and
 * does nothing else with the failure, so a test that executes them executes the shipped
 * behaviour.
 *
 * Every message returned here has already been through `governFactualNarrative`, so a
 * failure can never be worded as an absence of data.
 */

import { governFactualNarrative } from "./result-state";
import { genericResultState } from "./result-state-adapters";
import { deterministicPeerSelectionLost } from "./nibrs-deterministic-queries";
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";

/** Is this failure a query timeout rather than a defect in the SQL? */
export function isTimeoutFailure(message: string): boolean {
  return String(message ?? "").includes("timed out");
}

export type RecoveryDecision =
  /** Answer the reader now with this governed message. Nothing further is attempted. */
  | {
      outcome: "stop";
      error: string;
      reason: string;
      /**
       * The guidance ACTUALLY DELIVERED in `error`, or null.
       *
       * Review §3.3: this used to be set at composition time, so a guidance string the
       * governor then rejected still came back non-null. It is now read back out of the
       * rendered text, so it can only be non-null if the reader really sees it.
       */
      guidance: string | null;
      /**
       * Factual local status: was approved guidance delivered? NOT a Decision 15 verdict —
       * D15 is scored independently, and composing a shorter question is not evidence that
       * it succeeds. A runtime decision must not self-award that verdict.
       */
      guidanceShown: boolean;
    }
  /** Continue to the guarded model path, which may still produce an answer. */
  | { outcome: "model_path"; reason: string };

/**
 * The ordinary query shapes this policy is willing to suggest a narrower version of.
 *
 * An ALLOWLIST, not a rewriter (review §3.2). Each entry is a shape the deterministic
 * builders already emit for a single agency and a single year, so "the same question over
 * one year" is a request the product genuinely supports. A unit that is not listed —
 * `rate_per_100k`, `ratio`, `unknown` — gets no suggestion, because narrowing those also
 * changes a denominator or a comparison and this small mechanism cannot promise it holds.
 */
export type SupportedRecoveryShape = "agency_offense_count";

/**
 * The deterministic FAMILIES whose meaning this mechanism can preserve when it shortens the
 * period — identified by the failed plan's own `guardrail`, not by `metric.unit`.
 *
 * WHY THE FAMILY AND NOT THE UNIT (direction §3). `metric.unit` is too coarse. A
 * clearance-METHOD request — "murder clearances by arrest and exceptional means" — has
 * `breakdowns: []` and a clearance unit, so a unit-based gate admitted it, and the
 * suggestion came back as "murders clearance rate", silently dropping the requested
 * separation of arrest from exceptional. Unit preservation is not request preservation.
 *
 * Only ONE family is listed, and only because the positive test below actually executes its
 * SQL and checks the numbers. Everything else — clearance method, clearance-type breakdown,
 * comparable-agency, demographic, juvenile, DV share, structured trend, and any family added
 * later — gets NO guidance until its meaning is explicitly preserved and proved. An
 * unrecognised family is refused by default, so a new builder cannot silently inherit this.
 *
 * A general clearance-rate alternative has no demonstrated single-year builder path, so it
 * stays unsupported rather than being invented to satisfy a test.
 */
const SUPPORTED_RECOVERY_FAMILIES: ReadonlySet<string> = new Set([
  "deterministic-nibrs-local-city-offense-count",
]);

/** Is this failed plan's family one whose meaning a period-narrowing can preserve? */
export function isSupportedRecoveryFamily(guardrail: string | null | undefined): boolean {
  return typeof guardrail === "string" && SUPPORTED_RECOVERY_FAMILIES.has(guardrail);
}

/**
 * Families that calculate their own answer and therefore must never fail into the model path.
 *
 * Listed by the plan's own guardrail, so a family added later inherits nothing by accident -- the
 * same discipline as `SUPPORTED_RECOVERY_FAMILIES` above, in the opposite direction.
 */
const SELF_CALCULATING_FAMILIES: ReadonlySet<string> = new Set([
  "nibrs-annual-clearance",
  // A city ranking is built from a declared request: which cities qualify, which crime, which year
  // and which measure orders the result are separate typed fields. Recovering its failure through
  // model-written SQL restores exactly the confusion of eligibility with the ranked measure that
  // the family replaced, so it stops here like the clearance family does.
  "deterministic-city-ranking-nibrs",
  // GC-091 batch: the agency-period ranking sums one row per agency over the period; the model-written SQL it replaced
  // split agencies into population-year rows. Its failure stops, like the city ranking.
  "deterministic-nibrs-agency-period-ranking",
]);

export function ownsItsCalculation(guardrail: string | null | undefined): boolean {
  return typeof guardrail === "string" && SELF_CALCULATING_FAMILIES.has(guardrail);
}

/**
 * Does this family run the annual-clearance flow (`runOwnedAnnualClearance`)?
 *
 * Separate from `ownsItsCalculation` on purpose. Both facts were the same predicate while the set
 * held one member, and the route dispatched on it; a second self-calculating family would have been
 * handed to the clearance flow by accident.
 */
export function runsAnnualClearanceFlow(guardrail: string | null | undefined): boolean {
  return guardrail === "nibrs-annual-clearance";
}

/**
 * What the request had actually RESOLVED before it failed.
 *
 * Every field is something the product established, never something parsed back out of the
 * question at failure time. This is built ONLY by `buildNibrsRecoveryContext` below, which
 * is the same function the route calls — a hand-built context would test a shape production
 * does not produce, which is how the missing unit went unnoticed (review §3.2).
 */
export interface RecoveryContext {
  /** Resolved place label, e.g. "San Francisco, CA". */
  place: string;
  /** The COMPLETE measure phrase, including the unit, e.g. "rapes clearance rate". */
  measure: string;
  startYear: number;
  endYear: number;
  /** The allowlisted shape this request matched. */
  shape: SupportedRecoveryShape;
}

/** The narrow slice of the contract this policy reads. Structural, so tests use the real thing. */
export interface RecoveryContractView {
  metric: {
    offenses: { label: string }[];
    unit: "count" | "rate_per_100k" | "clearance_rate" | "ratio" | "unknown";
  };
  breakdowns: string[];
}

/** The narrow slice of the resolution plan this policy reads. */
export interface RecoveryResolutionView {
  startYear: number;
  endYear: number;
  places: { status: string; label: string }[];
}

/**
 * Build the recovery context from what the resolver and the contract actually established.
 *
 * THE ROUTE CALLS THIS. It used to be an inline expression at the call site, which is how
 * two defects hid: it read `metric.offenses[].label` and dropped `metric.unit`, so a
 * clearance-rate request suggested a plain count ("rapes" for a rape *clearance rate*); and
 * it filtered places to the resolved ones, which cannot show that every REQUESTED place
 * resolved — only that at least one did.
 *
 * Every gate below returns null rather than guessing:
 *
 *   - a PEER comparison is excluded outright, on any failure (review §3.1);
 *   - the unit must be an allowlisted shape;
 *   - a requested BREAKDOWN is not preserved by narrowing the period, so it disqualifies;
 *   - exactly one place must be requested AND every requested place must have resolved;
 *   - the period must actually span more than one year.
 */
export function buildNibrsRecoveryContext(input: {
  resolutionPlan: RecoveryResolutionView | null | undefined;
  contract: RecoveryContractView | null | undefined;
  /**
   * The plan that failed. Whether it carries a peer-selection contract is derived HERE, so
   * the route keeps no recovery predicate of its own and exactly one place decides it.
   */
  query: Partial<Pick<DeterministicNibrsQuery, "selectedPeers" | "guardrail">> | null | undefined;
}): RecoveryContext | null {
  const { resolutionPlan, contract, query } = input;
  if (query && deterministicPeerSelectionLost(query)) return null;   // §3.1: never narrow away a comparison
  if (!resolutionPlan || !contract) return null;

  // THE FAMILY GATE (§3). The failed plan's own family decides eligibility. An unrecognised
  // or specialised family gets nothing, so a clearance-method request can no longer be
  // answered with an overall-rate suggestion, and a family added later inherits no guidance.
  if (!isSupportedRecoveryFamily(query?.guardrail)) return null;

  // Within that family the unit must still be a plain count. The family gate makes this
  // near-redundant, which is the point: two independent conditions, not one loose one.
  const shape: SupportedRecoveryShape | null =
    contract.metric.unit === "count" ? "agency_offense_count" : null;
  if (!shape) return null;

  // A breakdown ("by sex", "by weapon") is part of what was asked. This mechanism only
  // shortens a period; it cannot carry a breakdown faithfully, so it declines instead.
  if (Array.isArray(contract.breakdowns) && contract.breakdowns.length > 0) return null;

  const places = resolutionPlan.places ?? [];
  if (places.length !== 1) return null;                    // one place only
  if (!places.every(p => p.status === "resolved")) return null;   // and it must have resolved
  const place = String(places[0].label ?? "").trim();
  if (!place) return null;

  const offenses = contract.metric.offenses ?? [];
  if (offenses.length === 0) return null;
  const offenseText = offenses.map(o => String(o.label ?? "").toLowerCase().trim()).filter(Boolean).join(", ");
  if (!offenseText) return null;
  // The unit is part of the measure. Dropping it turned a clearance-rate request into a
  // count request in the suggestion.
  const measure = offenseText;   // count family only; no unit phrase to append

  const { startYear, endYear } = resolutionPlan;
  if (typeof startYear !== "number" || typeof endYear !== "number") return null;
  if (!Number.isFinite(startYear) || !Number.isFinite(endYear)) return null;
  if (endYear <= startYear) return null;                   // already one year: nothing to narrow

  return { place, measure, startYear, endYear, shape };
}

/**
 * A concrete narrower question, or null when none is justified (Decision 15).
 *
 * THE ONLY NARROWING THIS POLICY TRUSTS is collapsing a multi-year span to its most recent
 * single year, for the SAME resolved place and the SAME measure. That combination is an
 * existing supported query shape — a single-year agency query is what the deterministic
 * builders already emit — so the suggestion is grounded rather than hopeful.
 *
 * It deliberately does NOT promise success. A shorter period is a smaller request, not a
 * guaranteed one, and saying otherwise would be exactly the false reassurance the ruling
 * forbids. If place, measure or a real multi-year span is missing, this returns null and
 * the failure stands alone.
 */
export function narrowerQuestionGuidance(ctx: RecoveryContext | null | undefined): string | null {
  if (!ctx) return null;
  const place = (ctx.place ?? "").trim();
  const measure = (ctx.measure ?? "").trim();
  const { startYear: start, endYear: end } = ctx;
  if (!place || !measure) return null;
  if (typeof start !== "number" || typeof end !== "number") return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;
  return (
    `A narrower question I can try, using what this request already resolved: ` +
    `"${measure} in ${place} in ${end}" — one year instead of ${start}–${end}. ` +
    `That's a smaller request, not a guaranteed one.`
  );
}

/**
 * What to do when a DETERMINISTIC NIBRS query fails to execute.
 *
 * Three cases, in order:
 *
 *  1. A timeout is our failure and is reported as one.
 *  2. A PEER COMPARISON carries a selection contract — members chosen on population alone.
 *     Falling through to the model would abandon that contract and let the model invent a
 *     different set of agencies, which is the behaviour Decision 16 failed on. So a
 *     non-timeout failure of a peer query stops honestly instead of recovering.
 *  3. Anything else recovers through the guarded model path.
 */
export function decideDeterministicFailure(
  query: Pick<DeterministicNibrsQuery, "sql"> & Partial<Pick<DeterministicNibrsQuery, "selectedPeers" | "guardrail">>,
  failureMessage: string,
  /** G1: what the request resolved before it failed. Absent means suggest nothing. */
  context?: RecoveryContext | null,
): RecoveryDecision {
  // §3.1: a peer comparison is excluded from narrowing on BOTH failure kinds. The previous
  // version tested the timeout first and never re-checked, so a real peer TIMEOUT was
  // offered "rapes in San Francisco, CA in 2023" — a suggestion that silently drops the
  // comparison the reader asked for.
  const isPeer = deterministicPeerSelectionLost(query);

  if (isTimeoutFailure(failureMessage)) {
    const candidate = isPeer ? null : narrowerQuestionGuidance(context);
    const error = governFactualNarrative(
      "That NIBRS query timed out.",
      genericResultState({ sql: query.sql, rows: [], productError: "deterministic query timed out" }),
      candidate,
    );
    const status = deliveredStatus(error, candidate);
    return { outcome: "stop", ...status, error,
      reason: isPeer
        ? "deterministic peer comparison timed out; narrowing would drop the comparison"
        : status.guidanceShown
          ? "deterministic query timed out; a supported narrower question was delivered"
          : candidate
            ? "deterministic query timed out; the composed suggestion was rejected by the guard"
            : "deterministic query timed out; no supported narrower question, limitation retained",
    };
  }
  /*
   * A CONTROLLED CALCULATION MUST NOT FAIL INTO A GENERATED ONE.
   *
   * The yearly offence-and-clearance family owns its arithmetic: the offence, the contributing
   * rows, the period and the derivation are bound together so the figure is right by construction.
   * Recovering an ordinary execution failure through the model path would answer the SAME question
   * with the calculation that ownership replaced -- and the general checker has twice been shown
   * unable to catch the way that calculation goes wrong. So this family stops, exactly as a peer
   * selection does, and for the same reason: what would come back is not a slower version of the
   * answer, it is a different and unaccountable one.
   */
  if (ownsItsCalculation(query.guardrail)) {
    return {
      outcome: "stop",
      reason: "a controlled calculation must not be recovered through model-generated SQL",
      guidance: null,
      guidanceShown: false,
      error: governFactualNarrative(
        // Each owned family says what IT failed at. The clearance wording was the only one here, so
        // a failed city ranking apologised for "that yearly clearance query".
        runsAnnualClearanceFlow(query.guardrail)
          ? "I couldn't complete that yearly clearance query, and I'm not going to substitute a " +
            "figure I can't account for."
          : query.guardrail === "deterministic-nibrs-agency-period-ranking"
            ? "I couldn't complete that agency ranking, and I'm not going to substitute one I can't account for."
            : "I couldn't complete that city ranking, and I'm not going to substitute one I can't " +
              "account for.",
        genericResultState({ sql: query.sql, rows: [], productError: failureMessage }),
        null,
      ),
    };
  }
  if (isPeer) {
    // Narrowing would change the comparison, and the peer SELECTION must not change.
    // Failing honestly is the whole point of this branch.
    return {
      outcome: "stop",
      reason: "a peer selection contract cannot be abandoned to the model",
      guidance: null,
      guidanceShown: false,
      error: governFactualNarrative(
        "I couldn't complete the like-for-like comparison, and I'm not going to substitute a different set of agencies for the ones chosen by population.",
        genericResultState({ sql: query.sql, rows: [], productError: failureMessage }),
      ),
    };
  }
  return { outcome: "model_path", reason: "no selection contract is at stake" };
}

/**
 * Read the delivered guidance back out of the rendered text (review §3.3).
 *
 * The governor may reject a candidate — an empty-state claim, a raw exception — and when it
 * does, the reader gets the bare admission. Status must describe THAT, not what we hoped to
 * send. So it is derived from the final string, never from the candidate.
 */
function deliveredStatus(renderedError: string, candidate: string | null): { guidance: string | null; guidanceShown: boolean } {
  const delivered = candidate && renderedError.includes(candidate.trim()) ? candidate : null;
  return { guidance: delivered, guidanceShown: delivered !== null };
}

/** Which database-failure exit the route has arrived at. */
export type DatabaseFailureStage =
  /** The rewritten retry also failed to execute. */
  | "retry_failed"
  /** The rewritten retry did not pass SQL validation, so it was never run. */
  | "retry_validation_failed"
  /** No retry was attempted. */
  | "no_retry";

/**
 * What the reader is told when a model-generated NIBRS query fails.
 *
 * The wording differs by stage and by cause because the useful next step differs: a
 * timeout means narrow the request, a column error means the breakdown may not exist, and
 * anything else means rephrase. None of them may imply the data is absent, which is what
 * the governor enforces.
 */
export function decideDatabaseFailure(input: {
  stage: DatabaseFailureStage;
  sql: string;
  /** The message from the ORIGINAL failure — the one that describes the real cause. */
  originalMessage: string;
  /** G1: resolved context, where the model path established any. Absent means no guidance. */
  context?: RecoveryContext | null;
}): RecoveryDecision {
  const { stage, sql, originalMessage, context } = input;
  const timeout = isTimeoutFailure(originalMessage);
  const state = genericResultState({ sql, rows: [], productError: originalMessage });

  // G1: guidance is offered ONLY for timeouts, and only from resolved context. A column
  // error or a validation failure is a defect in what we built; suggesting a narrower
  // question there would imply the data is the problem, which is the exact confusion the
  // ruling forbids. Those keep the bare admission.
  //
  // The composed wordings that used to live here — "the data may not support that exact
  // breakdown", `Database error: ${msg}` — are GONE rather than governed away. They were
  // arbitrary text and a raw exception; nothing now tries to smuggle them past the guard.
  // NOTE: the three real route call sites pass NO context today, so this path delivers no
  // guidance in production. Recorded as a limitation (review 3.3), not claimed as done.
  const candidate = timeout ? narrowerQuestionGuidance(context) : null;

  if (stage === "retry_validation_failed") {
    return {
      outcome: "stop",
      reason: "the rewritten query did not pass validation",
      guidance: null,
      guidanceShown: false,
      error: governFactualNarrative("I couldn't build a query I could safely run for that.", state),
    };
  }

  if (stage === "retry_failed") {
    const error = governFactualNarrative(
      timeout ? "That query timed out, and the rewritten version timed out too."
              : "I couldn't build a query that ran for that request.",
      state, candidate);
    const status = deliveredStatus(error, candidate);
    return { outcome: "stop", ...status, error,
      reason: status.guidanceShown ? "the rewritten query also failed; a supported narrower question was delivered"
                                   : "the rewritten query also failed" };
  }

  const error = governFactualNarrative(
    timeout ? "That query timed out." : "That query failed to run.", state, candidate);
  const status = deliveredStatus(error, candidate);
  return { outcome: "stop", ...status, error,
    reason: status.guidanceShown ? "the query failed and no retry was attempted; a supported narrower question was delivered"
                                 : "the query failed and no retry was attempted" };
}
