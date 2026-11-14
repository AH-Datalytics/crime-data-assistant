/**
 * Verified-answer-only contract — frozen internal type definitions.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * sections 6.1 (proof manifest), 2.3 (delivery actions), 7 (omission reasons),
 * and 8 (source health).
 *
 * STAGE 0 SCOPE: these are type and constant definitions only. Nothing in this
 * module reads a request, touches a database, or changes a response. Stage 1
 * wires them into the routes; until then importing this file has no runtime
 * effect beyond the constant tables below.
 *
 * WHY THE NAMES ARE FROZEN HERE: handoff section 15 requires schema/type names
 * to be frozen before route integration begins, because Claude and Codex work
 * the same files in sequence and a renamed check state after integration would
 * silently invalidate stored proof JSON. Treat every exported string-literal
 * union in this file as a persisted wire format, not an implementation detail.
 */

/** Bump when a stored proof manifest's shape changes incompatibly. */
export const PROOF_MANIFEST_VERSION = 1;

/**
 * Valid states for a single mandatory check (handoff 6.1).
 *
 * `unknown` exists specifically so that "the check could not run" is
 * distinguishable from "the check ran and found nothing wrong". The auditor
 * already learned this lesson the expensive way: D6 reported clean for weeks
 * because its reference database was a 0-byte stub, and getAuditorHealth() was
 * built afterwards to separate "did not run" from "ran and passed". A delivered
 * answer requires positive evidence, so `unknown` NEVER satisfies an obligation.
 */
export type CheckState = "passed" | "failed" | "not_applicable" | "unknown";

export const CHECK_STATES: readonly CheckState[] = ["passed", "failed", "not_applicable", "unknown"] as const;

/**
 * The mandatory check categories. A source may declare a category
 * `not_applicable` only with a documented semantic reason from the typed plan
 * (handoff 8.1) -- never as a fallback after the check fails.
 */
export type ProofCheck =
  | "semanticPlan"
  | "canonicalGeographies"
  | "entityCompleteness"
  | "metric"
  | "grain"
  | "timeRange"
  | "missingness"
  | "reconciliation"
  | "claims"
  | "chartData";

export const PROOF_CHECKS: readonly ProofCheck[] = [
  "semanticPlan",
  "canonicalGeographies",
  "entityCompleteness",
  "metric",
  "grain",
  "timeRange",
  "missingness",
  "reconciliation",
  "claims",
  "chartData",
] as const;

/**
 * How the answer's material claims were produced.
 *
 * `deterministic` is the only derivation that can satisfy the final-state
 * contract (handoff 2.1/3.1). `model_authored` is recorded during migration so
 * shadow analysis can measure the legacy population; it is not a pathway to a
 * confirmed answer.
 */
export type Derivation = "deterministic" | "model_authored";

/** Source identifiers. One row per source in the parity matrix (handoff 8.1). */
export type SourceId = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

export const SOURCE_IDS: readonly SourceId[] = ["current", "historical", "nibrs", "shr", "hate_crime"] as const;

/**
 * Terminal delivery actions (handoff 2.3).
 *
 * `retry` is deliberately absent: it is a transitional processing action, not a
 * terminal state. Nothing is sent to a user until a retry resolves into one of
 * these. Retry attempts are accounted separately in the digest.
 */
export type DeliveryAction =
  | "answer"
  | "answer_limited_scope"
  | "clarify"
  | "decline_capability"
  | "decline_data"
  | "decline_source_health";

export const DELIVERY_ACTIONS: readonly DeliveryAction[] = [
  "answer",
  "answer_limited_scope",
  "clarify",
  "decline_capability",
  "decline_data",
  "decline_source_health",
] as const;

/** The two actions that deliver factual content and therefore require full proof. */
export const FACTUAL_DELIVERY_ACTIONS: readonly DeliveryAction[] = ["answer", "answer_limited_scope"] as const;

/* ────────────────────────────────────────────────────────────────────────────────────────────
 * The typed-outcome vocabulary (P2.1 §4.2).
 *
 * `DeliveryAction` answers "what did we do". `ReasonCode` answers "why", in a closed set that is
 * admissible *per action*. The pair is what P2 persists; neither half is ever derived from prose,
 * from `error`, from `guardrails`, or from `plan_family`.
 *
 * WHY ONE CATALOG. An earlier draft carried the action/reason relation in a union and the
 * store relation in a second, hand-maintained list. That is the same "two carriers for one fact"
 * defect that produced the header warning on `lib/query-log-columns.ts`, where three hand-kept
 * sequences desynchronized and every log write was silently lost. Here the action, the reason and
 * the stores that may hold the pair are one row, written once. `ReasonCode`, the per-store outcome
 * types and the runtime admissible-pair sets are all DERIVED. Adding a second membership table,
 * switch, array or validation list re-creates the defect and is rejected by T1c.
 * ──────────────────────────────────────────────────────────────────────────────────────────── */

/** The two stores that may hold a typed outcome. */
export type OutcomeStore = "query_log" | "shared_charts";

export const OUTCOME_STORES: readonly OutcomeStore[] = ["query_log", "shared_charts"] as const;

/**
 * A catalog row. `stores` is a NON-EMPTY tuple on purpose: a reason with no store assignment is
 * a reason nothing can ever persist, and it fails to compile rather than sitting in the vocabulary
 * looking usable.
 */
interface CatalogEntry {
  readonly action: DeliveryAction;
  readonly reason: string;
  readonly stores: readonly [OutcomeStore, ...OutcomeStore[]];
}

/**
 * THE authority for action, reason and store. Every reason appears exactly once.
 *
 * 28 rows (24 from P2.1, plus four named at existing accepted Phase 3 branches when the candidate was
 * integrated: see the clarify and decline_data groups). `answer_limited_scope` deliberately has none: it stays a full member of
 * `DeliveryAction` — the persisted action vocabulary is six — and is simply not producible. Giving
 * it a speculative reason so an exhaustiveness assertion could pass would be inventing a product
 * path, so the assertion is stated over *producible* actions instead (T1).
 *
 * Four reasons are the IDENTICAL STRING as an `OmissionReason` member, so a future join is a join
 * and not a translation table. They stay distinct types with different admissible sets, because a
 * request-level reason and a per-entity omission reason answer different questions. T2 asserts the
 * strings equal, so a rename on either side fails instead of silently forking the vocabulary.
 */
export const OUTCOME_CATALOG = [
  // ── answer (3) ────────────────────────────────────────────────────────────────────────────
  { action: "answer", reason: "deterministic_plan", stores: ["query_log"] },
  { action: "answer", reason: "model_sql_validated", stores: ["query_log"] },
  { action: "answer", reason: "stored_artifact_replay", stores: ["shared_charts"] },

  // ── clarify (6) ───────────────────────────────────────────────────────────────────────────
  { action: "clarify", reason: "geography_ambiguous", stores: ["query_log"] },
  { action: "clarify", reason: "geography_scope_ambiguous", stores: ["query_log"] },
  { action: "clarify", reason: "place_unresolved", stores: ["query_log"] },
  { action: "clarify", reason: "source_switch", stores: ["query_log"] },
  // Integration of the accepted Phase 3 candidate (Codex Gate A vocabulary ruling, 2026-09-30): named
  // decisions at existing branches, not new behavior. `measure_ambiguous`: the violent/property/both and
  // fatal/nonfatal shooting questions. `followup_ambiguous`: the Current/Historical amendment whose request
  // is unresolved.
  { action: "clarify", reason: "measure_ambiguous", stores: ["query_log"] },
  { action: "clarify", reason: "followup_ambiguous", stores: ["query_log"] },

  // ── decline_data (7) ──────────────────────────────────────────────────────────────────────
  { action: "decline_data", reason: "no_rows_in_source", stores: ["query_log", "shared_charts"] },
  { action: "decline_data", reason: "all_values_null", stores: ["query_log"] },
  { action: "decline_data", reason: "outside_the_source_years", stores: ["query_log"] },   // ∗
  { action: "decline_data", reason: "not_in_source", stores: ["query_log"] },              // ∗
  { action: "decline_data", reason: "agency_identity_unavailable", stores: ["query_log"] },
  // Integration (Codex Gate A vocabulary ruling): `reporting_coverage_insufficient` is the NIBRS
  // category-change path's `no-complete-reporter` result (a data decline, not `continuous_reporting_required`,
  // which is a capability decline). `annual_result_not_supported` is the annual family's `no-supportable-year`
  // decline: its years are withheld for disagreement, unestablished or partial reporting, so it must NOT be
  // recorded as `outside_source_years`; the delivered explanation keeps the specific reasons.
  { action: "decline_data", reason: "reporting_coverage_insufficient", stores: ["query_log"] },
  { action: "decline_data", reason: "annual_result_not_supported", stores: ["query_log"] },

  // ── decline_capability (11) ───────────────────────────────────────────────────────────────
  { action: "decline_capability", reason: "capability_path_unavailable", stores: ["query_log"] }, // ∗
  { action: "decline_capability", reason: "guardrail_block", stores: ["query_log"] },
  { action: "decline_capability", reason: "table_not_allowlisted", stores: ["query_log"] },
  { action: "decline_capability", reason: "query_contract_failed", stores: ["query_log"] },
  { action: "decline_capability", reason: "sql_shape_rejected", stores: ["query_log"] },
  { action: "decline_capability", reason: "rate_denominator_unavailable", stores: ["query_log"] },
  { action: "decline_capability", reason: "geography_contract_violation", stores: ["query_log"] },
  { action: "decline_capability", reason: "consolidation_mapping", stores: ["query_log"] },       // ∗
  { action: "decline_capability", reason: "continuous_reporting_required", stores: ["query_log"] },
  { action: "decline_capability", reason: "model_produced_no_sql", stores: ["query_log"] },
  { action: "decline_capability", reason: "empty_reason_not_established", stores: ["query_log"] },

  // ── decline_source_health (1) ─────────────────────────────────────────────────────────────
  // Producible today at two sites, each carrying its own local prerequisite probe. The probe is
  // the evidence; no global source-health registry is needed for these two.
  { action: "decline_source_health", reason: "required_component_unavailable", stores: ["query_log"] },
] as const satisfies readonly CatalogEntry[];

/* ── everything below is DERIVED from the catalog. Nothing here is hand-maintained. ────────── */

type CatalogRow = (typeof OUTCOME_CATALOG)[number];

/** The closed reason vocabulary. */
export type ReasonCode = CatalogRow["reason"];

type RowsFor<S extends OutcomeStore> =
  CatalogRow extends infer E
    ? E extends { stores: readonly (infer T)[] } ? (S extends T ? E : never) : never
    : never;
type ToOutcome<E> = E extends { action: infer A; reason: infer R }
  ? { readonly action: A; readonly reason: R }
  : never;

/** The outcomes a given store may hold, as a discriminated union of whole pairs. */
export type OutcomeFor<S extends OutcomeStore> = ToOutcome<RowsFor<S>>;

/** What the four question routes may supply. */
export type QueryLogOutcome = OutcomeFor<"query_log">;
/** What the embed read may supply. */
export type EmbedReadOutcome = OutcomeFor<"shared_charts">;
/** Any producible outcome. */
export type Outcome = QueryLogOutcome | EmbedReadOutcome;

/** Every reason in the catalog, derived. */
export const REASON_CODES: readonly ReasonCode[] =
  OUTCOME_CATALOG.map((e) => e.reason) as readonly ReasonCode[];

/** The actions that at least one catalog row can produce. */
export const PRODUCIBLE_DELIVERY_ACTIONS: readonly DeliveryAction[] =
  Array.from(new Set(OUTCOME_CATALOG.map((e) => e.action)));

/**
 * The runtime admissible-pair set behind both coverage queries. Generated from the one catalog,
 * so neither store's membership can drift from the other's.
 */
export function admissiblePairs(store: OutcomeStore): { action: DeliveryAction; reason: ReasonCode }[] {
  return OUTCOME_CATALOG
    .filter((e) => (e.stores as readonly OutcomeStore[]).includes(store))
    .map((e) => ({ action: e.action as DeliveryAction, reason: e.reason as ReasonCode }));
}

/** Whether a runtime action/reason pair is admissible in a store. Fails closed on anything odd. */
export function isAdmissiblePair(store: OutcomeStore, action: unknown, reason: unknown): boolean {
  if (typeof action !== "string" || typeof reason !== "string") return false;
  return admissiblePairs(store).some((p) => p.action === action && p.reason === reason);
}

/**
 * The producible outcomes as named constants, DERIVED from the catalog.
 *
 * Exit sites select between these rather than writing object literals, so a computed site is a
 * choice between two whole `Outcome` values and cannot decay into parallel action/reason ternaries
 * (T7b asserts this over the AST). Each constant's type is narrowed to its own row, so
 * `OUTCOMES.stored_artifact_replay` is assignable to `EmbedReadOutcome` and NOT to
 * `QueryLogOutcome` — the store partition is enforced at every use site, from the one catalog.
 */
export const OUTCOMES = Object.freeze(
  Object.fromEntries(
    OUTCOME_CATALOG.map((e) => [e.reason, Object.freeze({ action: e.action, reason: e.reason })]),
  ),
) as { [E in CatalogRow as E["reason"]]: { readonly action: E["action"]; readonly reason: E["reason"] } };

/**
 * The four reasons that are deliberately the same string as an `OmissionReason`. Declared here so
 * T2 can assert the equality from one place rather than restating the list in the test.
 */
export const OUTCOME_OMISSION_SHARED_STRINGS = [
  "outside_source_years",
  "not_in_source",
  "consolidation_mapping",
  "capability_path_unavailable",
] as const;

/**
 * Closed omission reason set (handoff 7).
 *
 * Every reason except `unknown` asserts something factual about the source or
 * the product. `unknown` asserts nothing: it must map to capability wording or a
 * decline, never to an invented source limitation (handoff 2.4).
 */
export type OmissionReason =
  | "not_in_source"
  | "outside_source_years"
  | "nonreporting_period"
  | "insufficient_reporting_coverage"
  | "consolidation_mapping"
  | "unsupported_geography_type"
  | "filtered_by_metric_definition"
  | "source_unhealthy"
  | "capability_path_unavailable"
  | "unknown";

export const OMISSION_REASONS: readonly OmissionReason[] = [
  "not_in_source",
  "outside_source_years",
  "nonreporting_period",
  "insufficient_reporting_coverage",
  "consolidation_mapping",
  "unsupported_geography_type",
  "filtered_by_metric_definition",
  "source_unhealthy",
  "capability_path_unavailable",
  "unknown",
] as const;

/**
 * Reasons that may be stated to a user as a factual claim about the data.
 *
 * Everything outside this set -- including `unknown` -- must be phrased as a
 * product capability limitation. This constant is the enforcement point for
 * handoff 2.4's rule that the system never claims a source lacks data unless a
 * deterministic probe established it.
 */
export const SOURCE_ATTRIBUTABLE_OMISSION_REASONS: readonly OmissionReason[] = [
  "not_in_source",
  "outside_source_years",
  "nonreporting_period",
  "insufficient_reporting_coverage",
  "filtered_by_metric_definition",
] as const;

export function isSourceAttributable(reason: OmissionReason): boolean {
  return SOURCE_ATTRIBUTABLE_OMISSION_REASONS.includes(reason);
}

/** A single omitted entity with the evidence that justifies its reason code. */
export interface Omission {
  /** Canonical entity identifier, not display text. */
  entityId: string;
  /** Display label for the response layer. */
  label: string;
  reason: OmissionReason;
  /**
   * What established the reason. Required for every reason except `unknown`,
   * which by definition has none. Enforced by assertOmissionEvidence().
   */
  evidence: string | null;
}

/**
 * Health of one capability of one source (handoff 8).
 *
 * Three states, never a boolean: a boolean cannot express "we could not tell",
 * and the contract requires unknown to be treated as degraded rather than
 * silently healthy.
 */
export type SourceHealthState = "healthy" | "degraded" | "unknown";

export interface SourceHealth {
  sourceId: SourceId;
  /** The capability being asked about, e.g. "rollup", "sample_agencies". */
  capability: string;
  state: SourceHealthState;
  /** Required whenever state is not healthy. */
  reason: string | null;
  /** Source data version/build identifier when known. */
  dataVersion: string | null;
  /**
   * Whether the source covers the period the request actually asked for.
   * A stale source may still answer a historical period it fully covers
   * (handoff 8), so this is separate from overall health.
   */
  requestedCoverage: CheckState;
}

/**
 * Whether a source's health permits a factual answer.
 *
 * Requires a known `dataVersion` as well as healthy state and passing coverage,
 * matching factualDeliveryBlocker(). Handoff 2.1 requires "a healthy source
 * whose version and applicable time coverage are known", and a helper that
 * answered `true` for a source of unknown version would disagree with the final
 * manifest decision -- a divergence Stage 2 would build source adapters on top
 * of, since this is the function a health check naturally reaches for.
 */
export function permitsAnswer(health: SourceHealth): boolean {
  if (health.state !== "healthy") return false;
  if (health.requestedCoverage !== "passed") return false;
  if (!health.dataVersion || health.dataVersion.trim() === "") return false;
  return true;
}

/** The proof manifest persisted alongside each answered query (handoff 6.1). */
export interface ProofManifest {
  v: number;
  derivation: Derivation;
  /** Typed plan family, e.g. "nibrs-clearance-type". Null while unclassified. */
  planFamily: string | null;
  source: {
    id: SourceId;
    dataVersion: string | null;
    health: CheckState;
    requestedCoverage: CheckState;
  };
  checks: Record<ProofCheck, CheckState>;
  /**
   * Why each `not_applicable` check does not apply, keyed by check name.
   *
   * Required for every check marked `not_applicable`. The handoff says such a
   * state "must be justified by the typed plan, not selected after a check
   * fails" -- without a recorded justification the two are indistinguishable
   * after the fact, and `not_applicable` becomes an unfalsifiable way to pass
   * any obligation.
   */
  notApplicableReasons: Partial<Record<ProofCheck, string>>;
}

/** Every check starts `unknown`: nothing is assumed to have passed. */
export function emptyChecks(): Record<ProofCheck, CheckState> {
  const checks = {} as Record<ProofCheck, CheckState>;
  for (const check of PROOF_CHECKS) checks[check] = "unknown";
  return checks;
}

export function createProofManifest(sourceId: SourceId, derivation: Derivation = "model_authored"): ProofManifest {
  return {
    v: PROOF_MANIFEST_VERSION,
    derivation,
    planFamily: null,
    source: { id: sourceId, dataVersion: null, health: "unknown", requestedCoverage: "unknown" },
    checks: emptyChecks(),
    notApplicableReasons: {},
  };
}

/**
 * Why a manifest cannot deliver factual content, or null when it can.
 *
 * Returns the reason rather than a bare boolean so the shadow-mode logs and the
 * reviewer queue can say what was missing instead of only that something was.
 *
 * Deliberately written as "every obligation is affirmatively satisfied", NOT as
 * "nothing failed". An absent, skipped, or unknown obligation blocks delivery
 * exactly as a failed one does -- and so does a missing piece of the evidence
 * the manifest is supposed to carry:
 *
 *   - `planFamily` names the typed plan the answer came from. Without it there
 *     is no way to know which family's regression corpus and enforcement
 *     threshold apply, so "deterministic" is an unverifiable assertion.
 *   - `dataVersion` identifies the source build the numbers came from. Handoff
 *     2.1 requires "a healthy source whose version and applicable time coverage
 *     are known"; a null version means the version is not known.
 *   - a `not_applicable` check requires a recorded justification (see
 *     ProofManifest.notApplicableReasons).
 */
export function factualDeliveryBlocker(manifest: ProofManifest): string | null {
  if (manifest.v !== PROOF_MANIFEST_VERSION) return `manifest version ${manifest.v} is not ${PROOF_MANIFEST_VERSION}`;
  if (manifest.derivation !== "deterministic") return `derivation is '${manifest.derivation}', not 'deterministic'`;
  if (!manifest.planFamily || manifest.planFamily.trim() === "") return "planFamily is not set";
  if (!manifest.source.dataVersion || manifest.source.dataVersion.trim() === "") return "source.dataVersion is not set";
  if (manifest.source.health !== "passed") return `source.health is '${manifest.source.health}'`;
  if (manifest.source.requestedCoverage !== "passed") return `source.requestedCoverage is '${manifest.source.requestedCoverage}'`;
  for (const check of PROOF_CHECKS) {
    const state = manifest.checks[check];
    if (state === "passed") continue;
    if (state === "not_applicable") {
      const reason = manifest.notApplicableReasons?.[check];
      if (!reason || reason.trim() === "") return `check '${check}' is not_applicable with no recorded justification`;
      continue;
    }
    return `check '${check}' is '${state ?? "absent"}'`;
  }
  return null;
}

/** Whether a manifest satisfies the contract for delivering factual content. */
export function satisfiesFactualDelivery(manifest: ProofManifest): boolean {
  return factualDeliveryBlocker(manifest) === null;
}

/**
 * Names of checks blocking delivery, for logging and reviewer display.
 *
 * A `not_applicable` check with no recorded justification counts as blocking
 * here, exactly as factualDeliveryBlocker() treats it. The two must agree: a
 * reviewer shown an empty blocking list for a manifest that the delivery
 * decision rejected would be looking for a defect the tooling had already
 * hidden.
 */
export function blockingChecks(manifest: ProofManifest): ProofCheck[] {
  return PROOF_CHECKS.filter((check) => {
    const state = manifest.checks[check];
    if (state === "passed") return false;
    if (state === "not_applicable") {
      const reason = manifest.notApplicableReasons?.[check];
      return !reason || reason.trim() === "";
    }
    return true;
  });
}

/**
 * Throws when an omission asserts any reason without the evidence for it.
 *
 * Every reason except `unknown` is a claim about why an entity is absent, and
 * handoff 7 requires that "each reason must carry evidence" -- not only the
 * subset that blames the source. A `consolidation_mapping` or
 * `unsupported_geography_type` with no evidence is just as unfalsifiable as an
 * unproven `not_in_source`, and the reviewer adjudicating an omission has
 * nothing to check it against.
 *
 * `unknown` is the one reason that asserts nothing, so it alone needs no
 * evidence -- and correspondingly it can never be phrased to a user as a source
 * limitation (see isSourceAttributable and handoff 2.4).
 */
export function assertOmissionEvidence(omission: Omission): void {
  if (omission.reason === "unknown") return;
  if (!omission.evidence || omission.evidence.trim() === "") {
    const guidance = isSourceAttributable(omission.reason)
      ? "Use 'capability_path_unavailable' or 'unknown' instead of asserting an unproven source limitation."
      : "Record the probe or resolver output that established this reason, or use 'unknown'.";
    throw new Error(`Omission for ${omission.entityId} claims reason '${omission.reason}' with no evidence. ${guidance}`);
  }
}

/**
 * The internal record attached to one answered request. Persisted as JSON in
 * query_log; `deliveryAction` is additionally stored as its own indexed column
 * (handoff 6.3) because operational analysis groups by it.
 */
export interface DeliveryDecision {
  action: DeliveryAction;
  /**
   * Why the action was taken, from the closed catalog.
   *
   * This field is what carries the reason from the exit that supplied it to the projector that
   * persists it. Without it the reason has no carrier: the exit supplies a whole `Outcome`, but
   * `finalizeProof` returns a `ProofFinalization`, and the projector can only read what the
   * finalization kept. The action was already preserved here; the reason now travels beside it,
   * including through `inertFinalization` in `off` mode and on the degraded path.
   *
   * NOT a proof-schema change. `serializeProofEnvelope` does not serialize `decision`, and
   * `lib/result-digest.ts` never references the decision or the action, so extending this
   * interface changes no persisted proof shape and `PROOF_SCHEMA_VERSION` is unchanged. Adding the
   * reason to the envelope or the digest later WOULD be a version bump.
   */
  reason: ReasonCode;
  /** Count of canonical entities requested and returned, when applicable. */
  requested: number | null;
  included: number | null;
  omissions: Omission[];
  /** Transitional retries that occurred before this terminal action. */
  retries: number;
}
