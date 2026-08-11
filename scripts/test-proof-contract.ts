// Tests for lib/proof-contract.ts — the frozen verified-answer-only type contract.
// Run: npx tsx scripts/test-proof-contract.ts
//
// The load-bearing assertions here are the negative ones. A delivered answer
// requires positive evidence that every mandatory check ran and passed, so the
// tests that matter most are the ones proving `unknown` and absent checks block
// delivery exactly as `failed` does.
import assert from "node:assert/strict";
import {
  assertOmissionEvidence,
  blockingChecks,
  createProofManifest,
  DELIVERY_ACTIONS,
  emptyChecks,
  FACTUAL_DELIVERY_ACTIONS,
  isSourceAttributable,
  OMISSION_REASONS,
  permitsAnswer,
  PROOF_CHECKS,
  PROOF_MANIFEST_VERSION,
  satisfiesFactualDelivery,
  SOURCE_IDS,
  type Omission,
  type ProofManifest,
  type SourceHealth,
} from "../lib/proof-contract";

/** A manifest that passes everything, used as the baseline to break in each case. */
function passingManifest(): ProofManifest {
  const manifest = createProofManifest("nibrs", "deterministic");
  manifest.planFamily = "nibrs-clearance-type";
  manifest.source.dataVersion = "2025-08-10";
  manifest.source.health = "passed";
  manifest.source.requestedCoverage = "passed";
  for (const check of PROOF_CHECKS) manifest.checks[check] = "passed";
  return manifest;
}

// A fresh manifest assumes nothing: every check starts unknown, so a manifest
// nobody filled in cannot deliver.
{
  const fresh = createProofManifest("historical");
  assert.equal(fresh.derivation, "model_authored", "default derivation must not be deterministic");
  for (const check of PROOF_CHECKS) assert.equal(fresh.checks[check], "unknown");
  assert.equal(satisfiesFactualDelivery(fresh), false, "an unfilled manifest must not permit delivery");
  assert.equal(blockingChecks(fresh).length, PROOF_CHECKS.length);
}

// The baseline passes, or the negative cases below prove nothing.
assert.equal(satisfiesFactualDelivery(passingManifest()), true, "fully passed manifest must permit delivery");

// Each mandatory check, individually, blocks delivery when unknown or failed.
for (const check of PROOF_CHECKS) {
  const unknown = passingManifest();
  unknown.checks[check] = "unknown";
  assert.equal(satisfiesFactualDelivery(unknown), false, `unknown '${check}' must block delivery`);
  assert.deepEqual(blockingChecks(unknown), [check]);

  const failed = passingManifest();
  failed.checks[check] = "failed";
  assert.equal(satisfiesFactualDelivery(failed), false, `failed '${check}' must block delivery`);

  // not_applicable is the one non-passed state that may proceed, because the
  // typed plan justified it (handoff 6.1). Verified so a future refactor cannot
  // quietly widen or narrow the exemption.
  const notApplicable = passingManifest();
  notApplicable.checks[check] = "not_applicable";
  assert.equal(satisfiesFactualDelivery(notApplicable), true, `not_applicable '${check}' may proceed`);
}

// A deleted check key is as blocking as an unknown one. Guards against a
// migration that drops a field from stored JSON and accidentally reads as clean.
{
  const missing = passingManifest();
  delete (missing.checks as Record<string, unknown>)[PROOF_CHECKS[0]];
  assert.equal(satisfiesFactualDelivery(missing), false, "a missing check key must block delivery");
}

// Model-authored SQL cannot become a confirmed answer no matter how many
// postconditions passed (handoff 2.1). This is the contract's central rule.
{
  const modelAuthored = passingManifest();
  modelAuthored.derivation = "model_authored";
  assert.equal(satisfiesFactualDelivery(modelAuthored), false, "model-authored derivation can never satisfy delivery");
}

// Source health and requested-period coverage are separate obligations; each blocks.
{
  const unhealthy = passingManifest();
  unhealthy.source.health = "unknown";
  assert.equal(satisfiesFactualDelivery(unhealthy), false, "unknown source health must block");

  const uncovered = passingManifest();
  uncovered.source.requestedCoverage = "failed";
  assert.equal(satisfiesFactualDelivery(uncovered), false, "failed requested-period coverage must block");
}

// A manifest written by a future schema version is not interpretable by this code.
{
  const future = passingManifest();
  future.v = PROOF_MANIFEST_VERSION + 1;
  assert.equal(satisfiesFactualDelivery(future), false, "a mismatched manifest version must block");
}

// Source health: only healthy + covered permits an answer; unknown is degraded.
{
  const base = (state: SourceHealth["state"], coverage: SourceHealth["requestedCoverage"]): SourceHealth => ({
    sourceId: "shr",
    capability: "comparison",
    state,
    reason: state === "healthy" ? null : "fixture",
    dataVersion: null,
    requestedCoverage: coverage,
  });
  assert.equal(permitsAnswer(base("healthy", "passed")), true);
  assert.equal(permitsAnswer(base("unknown", "passed")), false, "unknown health is not healthy");
  assert.equal(permitsAnswer(base("degraded", "passed")), false);
  assert.equal(permitsAnswer(base("healthy", "unknown")), false, "unknown coverage cannot answer");
  assert.equal(permitsAnswer(base("healthy", "failed")), false);
}

// Omission attribution: a source-attributable reason without evidence is a
// fabricated data claim (handoff 2.4) and must throw rather than ship.
{
  const withoutEvidence: Omission = {
    entityId: "FL0160200",
    label: "Jacksonville, FL",
    reason: "not_in_source",
    evidence: null,
  };
  assert.throws(() => assertOmissionEvidence(withoutEvidence), /no evidence/i);

  const withEvidence: Omission = { ...withoutEvidence, evidence: "nibrs_agency_completeness has no row for FL0160200" };
  assert.doesNotThrow(() => assertOmissionEvidence(withEvidence));

  // `unknown` and capability reasons assert nothing about the source, so they
  // need no evidence -- but they must also never be treated as source claims.
  assert.equal(isSourceAttributable("unknown"), false);
  assert.equal(isSourceAttributable("capability_path_unavailable"), false);
  assert.equal(isSourceAttributable("source_unhealthy"), false, "source_unhealthy is our state, not a data fact");
  assert.doesNotThrow(() => assertOmissionEvidence({ ...withoutEvidence, reason: "unknown" }));
  assert.doesNotThrow(() => assertOmissionEvidence({ ...withoutEvidence, reason: "capability_path_unavailable" }));
}

// Enum shape guards. These catch a rename that would silently invalidate stored
// proof JSON, which is why the handoff freezes these names before integration.
{
  assert.equal(new Set(PROOF_CHECKS).size, PROOF_CHECKS.length, "check names must be unique");
  assert.equal(new Set(OMISSION_REASONS).size, OMISSION_REASONS.length);
  assert.equal(new Set(DELIVERY_ACTIONS).size, DELIVERY_ACTIONS.length);
  assert.equal(SOURCE_IDS.length, 5, "all five sources are in scope (handoff 3.13)");
  assert.deepEqual([...FACTUAL_DELIVERY_ACTIONS], ["answer", "answer_limited_scope"]);
  // `retry` is a processing state, never terminal (handoff 2.3).
  assert.ok(!(DELIVERY_ACTIONS as readonly string[]).includes("retry"), "retry must not be a terminal delivery action");
  assert.equal(Object.keys(emptyChecks()).length, PROOF_CHECKS.length);
}

console.log("proof-contract tests passed");
