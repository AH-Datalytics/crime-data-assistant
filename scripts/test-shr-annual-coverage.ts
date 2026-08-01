import assert from "node:assert/strict";
import { classifyShrAnnualCoverage } from "../lib/shr-annual-coverage";

const positiveStatuses = [
  ["pre2021_matched", null],
  ["post2020_transition_review", "post2020_coverage_maturing"],
  ["reta_unreported", "return_a_unavailable"],
  ["join_unresolved", "identity_uncertainty"],
] as const;
for (const [comparisonStatus, caveatCode] of positiveStatuses) {
  const decision = classifyShrAnnualCoverage({
    retaMurders: comparisonStatus === "reta_unreported" ? null : 12,
    shrVictims: 10,
    comparisonStatus,
    joinMethod: comparisonStatus === "join_unresolved" ? "ambiguous" : "ori_prefix_7_to_9",
  });
  assert.equal(decision.displayValue, 10);
  assert.equal(decision.displayStatus, "count");
  assert.equal(decision.caveatCode, caveatCode);
  assert.equal(decision.presentationChanged, false);
}

{
  const decision = classifyShrAnnualCoverage({
    retaMurders: 0, shrVictims: 0,
    comparisonStatus: "pre2021_true_zero_candidate", joinMethod: "ori_prefix_7_to_9",
  });
  assert.equal(decision.displayValue, 0);
  assert.equal(decision.displayStatus, "validated_zero");
}

{
  const decision = classifyShrAnnualCoverage({
    retaMurders: 8, shrVictims: 0,
    comparisonStatus: "pre2021_gap_candidate", joinMethod: "ori_prefix_7_to_9",
  });
  assert.equal(decision.displayValue, null);
  assert.equal(decision.displayStatus, "gap");
  assert.equal(decision.comparisonConflict, true);
  assert.equal(decision.presentationChanged, true);
}

for (const comparisonStatus of ["reta_unreported", "post2020_transition_review", "join_unresolved"] as const) {
  const decision = classifyShrAnnualCoverage({
    retaMurders: null, shrVictims: 0, comparisonStatus, joinMethod: "unmatched",
  });
  assert.equal(decision.displayValue, null);
  assert.equal(decision.displayStatus, "coverage_unknown");
}

{
  const repairedZero = classifyShrAnnualCoverage({
    retaMurders: 0, shrVictims: 0,
    comparisonStatus: "pre2021_matched", joinMethod: "ori_prefix_7_to_9",
  });
  assert.equal(repairedZero.normalizedComparisonStatus, "pre2021_true_zero_candidate");
  assert.equal(repairedZero.displayValue, 0);

  const repairedGap = classifyShrAnnualCoverage({
    retaMurders: 4, shrVictims: 0,
    comparisonStatus: "pre2021_matched", joinMethod: "ori_prefix_7_to_9",
  });
  assert.equal(repairedGap.normalizedComparisonStatus, "pre2021_gap_candidate");
  assert.equal(repairedGap.displayValue, null);
}

console.log("SHR annual coverage tests passed");
