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
  factualDeliveryBlocker,
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

/** Every blocker must name what is wrong; a bare `false` is not reviewable. */
function assertBlocked(manifest: ProofManifest, pattern: RegExp, message: string): void {
  assert.equal(satisfiesFactualDelivery(manifest), false, message);
  const blocker = factualDeliveryBlocker(manifest);
  assert.ok(blocker && pattern.test(blocker), `${message} — blocker was ${JSON.stringify(blocker)}`);
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

  // not_applicable may proceed ONLY with a recorded justification. Without one
  // it is indistinguishable from a check quietly waived after it failed, which
  // would make it an unfalsifiable way to satisfy any obligation.
  const unjustified = passingManifest();
  unjustified.checks[check] = "not_applicable";
  assertBlocked(unjustified, /no recorded justification/, `unjustified not_applicable '${check}' must block`);

  const justified = passingManifest();
  justified.checks[check] = "not_applicable";
  justified.notApplicableReasons[check] = "the typed plan returns no chart for this family";
  assert.equal(satisfiesFactualDelivery(justified), true, `justified not_applicable '${check}' may proceed`);

  // An empty or whitespace justification is not a justification.
  const blank = passingManifest();
  blank.checks[check] = "not_applicable";
  blank.notApplicableReasons[check] = "   ";
  assertBlocked(blank, /no recorded justification/, `blank justification for '${check}' must block`);
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
  assertBlocked(unhealthy, /source\.health/, "unknown source health must block");

  const uncovered = passingManifest();
  uncovered.source.requestedCoverage = "failed";
  assertBlocked(uncovered, /requestedCoverage/, "failed requested-period coverage must block");
}

// The manifest must carry the evidence it claims to carry. Both of these were
// accepted by an earlier revision, which meant "deterministic" could be asserted
// with no named plan and no known source build behind it.
{
  for (const empty of [null, "", "   "]) {
    const noFamily = passingManifest();
    noFamily.planFamily = empty as string | null;
    assertBlocked(noFamily, /planFamily/, `planFamily=${JSON.stringify(empty)} must block: no family means no regression corpus or threshold applies`);

    const noVersion = passingManifest();
    noVersion.source.dataVersion = empty as string | null;
    assertBlocked(noVersion, /dataVersion/, `dataVersion=${JSON.stringify(empty)} must block: handoff 2.1 requires a known source version`);
  }
}

// A fresh manifest reports the FIRST unmet obligation, not a generic failure.
{
  const fresh = createProofManifest("shr");
  assert.match(factualDeliveryBlocker(fresh) || "", /derivation/);
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

// Omission attribution: EVERY reason except `unknown` is a claim and needs
// evidence (handoff 7). An earlier revision required it only for
// source-attributable reasons, which let a 'consolidation_mapping' or
// 'unsupported_geography_type' ship with nothing a reviewer could check.
{
  const base: Omission = { entityId: "FL0160200", label: "Jacksonville, FL", reason: "not_in_source", evidence: null };

  for (const reason of OMISSION_REASONS) {
    const withoutEvidence: Omission = { ...base, reason };
    if (reason === "unknown") {
      // `unknown` asserts nothing, so it alone needs no evidence.
      assert.doesNotThrow(() => assertOmissionEvidence(withoutEvidence), "unknown needs no evidence");
      continue;
    }
    assert.throws(() => assertOmissionEvidence(withoutEvidence), /no evidence/i, `'${reason}' without evidence must throw`);
    assert.throws(() => assertOmissionEvidence({ ...withoutEvidence, evidence: "  " }), /no evidence/i, `'${reason}' with blank evidence must throw`);
    assert.doesNotThrow(() => assertOmissionEvidence({ ...withoutEvidence, evidence: "probe output" }), `'${reason}' with evidence is fine`);
  }

  // The guidance differs by kind, so the author is pointed at the right fix.
  assert.throws(() => assertOmissionEvidence(base), /unproven source limitation/);
  assert.throws(
    () => assertOmissionEvidence({ ...base, reason: "consolidation_mapping" }),
    /Record the probe or resolver output/
  );

  // Which reasons may be stated to a user as a fact about the data.
  assert.equal(isSourceAttributable("unknown"), false);
  assert.equal(isSourceAttributable("capability_path_unavailable"), false);
  assert.equal(isSourceAttributable("source_unhealthy"), false, "source_unhealthy is our state, not a data fact");
  assert.equal(isSourceAttributable("not_in_source"), true);
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
