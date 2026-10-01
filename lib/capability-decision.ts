/**
 * The single authority for what a source-capability finding MEANS.
 *
 * These sets and the typed outcome previously lived privately inside `query-contract-validator.ts`.
 * They are extracted here unchanged so that the post-SQL validator and the P3.1a request-decision
 * observer share one classification instead of each carrying its own opinion.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. The observer's whole claim is that it evaluates the same
 * decision production makes. Reusing the predicate proves the *condition* is shared; it proves
 * nothing about the *consequence*. If the observer decided for itself that a fired rule means
 * "decline_capability / query_contract_failed", it would be re-authoring production's decision
 * authority in a second place — and the two could drift without any test noticing. A second block
 * list is exactly the failure this file exists to prevent.
 *
 * BEHAVIOUR IS UNCHANGED. The membership of both sets is byte-for-byte what the validator declared
 * before the move, and `classifyCapabilityRule` reproduces the validator's original branch order:
 * block wins, then retry, then neither. `scripts/test-capability-decision-parity.ts` pins that
 * against the BASE tree.
 */
import { OUTCOMES } from "./proof-contract";

/**
 * Findings that BLOCK. These are exactly the nine question-only capability rules — the ones whose
 * predicates read only `question` and `contract`. That the block set and the SQL-independent set
 * are the same nine is a property of the current design, not a coincidence, and it is asserted
 * rather than assumed.
 */
export const BLOCK_CAPABILITY_RULES = new Set([
  "unsupported-sub-city-geography",
  // Integration (2026-09-30): the accepted Phase 3 candidate added this refusal to the block set that
  // lived in query-contract-validator.ts; dev moved the set here, so it is carried here.
  "vehicle-burglary-unsupported",
  "unsupported-court-policy-topic",
  "demographic-rate-unsupported",
  "nibrs-clearance-weapon-unsupported",
  "nibrs-countywide-demographics-unsupported",
  "nibrs-shooting-category-unsupported",
  "shr-non-homicide-unsupported",
  "shr-clearance-unsupported",
  "shr-demographic-rate-unsupported",
]);

/** Findings that trigger a model retry rather than a block. Membership unchanged from the validator. */
export const RETRY_CAPABILITY_RULES = new Set([
  "current-countywide-crosswalk",
  "current-rate-population",
  "nibrs-weapon-person-crime-table",
  "nibrs-weapon-demographic-person-crime-table",
  "nibrs-weapon-circumstance-person-crime-table",
  "nibrs-weapon-circumstance-demographic-person-crime-table",
  "nibrs-carjacking-clearance-table",
  "nibrs-clearance-type-table",
  "nibrs-dv-assault-share-table",
  "nibrs-campus-agency-resolution",
  "nibrs-countywide-crosswalk",
  "nibrs-continuous-reporters-range-table",
  "nibrs-demographic-breakdown-table",
  "nibrs-specific-drug-offense-table",
  "nibrs-specific-drug-arrest-table",
  "nibrs-local-geography-state-table",
  "nibrs-agency-lookup-not-crime-data",
  "historical-countywide-crosswalk",
  "historical-clearance-table",
  "historical-state-national-rate-table",
  "historical-local-rate-population",
  "historical-rate-null-gaps",
  "historical-local-geography-state-table",
  "historical-parish-type-city",
  "historical-agency-lookup-not-crime-data",
  "shr-campus-agency-resolution",
  "shr-countywide-crosswalk",
  "shr-state-rate-population",
]);

export type CapabilityClassification =
  | { kind: "block"; outcome: typeof OUTCOMES.query_contract_failed }
  | { kind: "retry" }
  | { kind: "observe_only" };

/**
 * Classify one capability rule id.
 *
 * The typed outcome comes from the shared `OUTCOMES` catalog — never from a locally re-authored
 * action/reason pair — so a catalog change moves both the validator and the observer at once.
 * Branch order reproduces the validator's original `if (block) ... else if (retry) ...`.
 */
export function classifyCapabilityRule(ruleId: string): CapabilityClassification {
  if (BLOCK_CAPABILITY_RULES.has(ruleId)) {
    return { kind: "block", outcome: OUTCOMES.query_contract_failed };
  }
  if (RETRY_CAPABILITY_RULES.has(ruleId)) return { kind: "retry" };
  return { kind: "observe_only" };
}
