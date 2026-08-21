/**
 * The legacy licence verdict really is removed, and nothing else is.
 *
 * BEHAVIOURAL, not a source regex. A source-level assertion can only show that a stripping function
 * is called; it cannot show that the finding is gone from every field it was recorded in, nor that
 * unrelated warnings, retries, blocks and enforcement tags survived. Both halves matter: leaving the
 * legacy verdict in place would decide this licence twice, and removing anything else would silently
 * disable an unrelated guardrail.
 */
import assert from "node:assert";
import { validateQueryContractSql, type QueryContractSqlValidation } from "../lib/query-contract-validator";
import { withoutLegacyLicence, LEGACY_LICENCE_RULES, validateModelAuthoredShrSql } from "../lib/shr-authority";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`  FAIL  ${name}\n        ${(error as Error).message}`); }
}

const LEGACY = LEGACY_LICENCE_RULES[0];

check("the legacy rule really is produced by the validator, so this test is not vacuous", () => {
  // If the underlying validator stopped emitting it, every assertion below would pass trivially.
  const real = validateQueryContractSql({
    question: "murders in California",
    source: "shr",
    sql: "SELECT COUNT(v.id) AS m FROM victims v WHERE v.state = 'CA'",
  });
  const recorded = [
    real.warnings.includes(LEGACY) && "warnings",
    real.enforced.includes(LEGACY) && "enforced",
    real.retryIssues.some((r) => r.includes(LEGACY)) && "retryIssues",
    real.blockReasons.some((r) => r.includes(LEGACY)) && "blockReasons",
  ].filter(Boolean);
  assert.ok(recorded.length > 0,
    `the validator no longer records ${LEGACY} anywhere; this suite would prove nothing`);
  console.log(`        (recorded in: ${recorded.join(", ")})`);
});

check("the legacy verdict is removed from every field it is recorded in", () => {
  // Constructed so the finding appears in ALL four fields at once -- the removal must not depend on
  // which of them the validator happens to use today.
  const constructed: QueryContractSqlValidation = {
    sql: "SELECT 1",
    fired: ["some-guardrail"],
    warnings: [LEGACY, "structural-measure-substitution"],
    capabilityFindings: [],
    retryIssues: [
      `[SYSTEM: Query contract violation (${LEGACY}). Rewrite it.]`,
      "[SYSTEM: Query contract violation (structural-measure-substitution). Rewrite it.]",
    ],
    blockReasons: [`blocked because ${LEGACY} applied`, "blocked for an unrelated reason"],
    enforced: [LEGACY, "contract-required-county-ori"],
  };
  const stripped = withoutLegacyLicence(constructed);

  assert.deepStrictEqual(stripped.warnings, ["structural-measure-substitution"]);
  assert.deepStrictEqual(stripped.enforced, ["contract-required-county-ori"]);
  assert.deepStrictEqual(stripped.retryIssues,
    ["[SYSTEM: Query contract violation (structural-measure-substitution). Rewrite it.]"]);
  assert.deepStrictEqual(stripped.blockReasons, ["blocked for an unrelated reason"]);
});

check("everything unrelated survives byte-for-byte", () => {
  const untouched: QueryContractSqlValidation = {
    sql: "SELECT 1 FROM t",
    fired: ["guardrail-a", "guardrail-b"],
    warnings: ["structural-measure-substitution", "structural-measure-incomplete"],
    capabilityFindings: [],
    retryIssues: ["[SYSTEM: unrelated retry]"],
    blockReasons: ["an unrelated block"],
    enforced: ["contract-required-county-ori", "structural-measure-substitution"],
  };
  const stripped = withoutLegacyLicence(untouched);
  assert.deepStrictEqual(stripped, untouched,
    "a result with no legacy finding must come back identical");
});

check("removal does not depend on the tag appearing in `enforced`", () => {
  // The earlier implementation returned early unless `enforced` carried the tag, coupling this to
  // an implementation detail of the validator. Recorded only in warnings/retries, it must still go.
  const partial: QueryContractSqlValidation = {
    sql: "SELECT 1",
    fired: [],
    warnings: [LEGACY],
    capabilityFindings: [],
    retryIssues: [`[SYSTEM: Query contract violation (${LEGACY}). Rewrite it.]`],
    blockReasons: [],
    enforced: [],
  };
  const stripped = withoutLegacyLicence(partial);
  assert.deepStrictEqual(stripped.warnings, []);
  assert.deepStrictEqual(stripped.retryIssues, []);
});

check("end to end, the model-authored result carries the fact verdict and not the legacy one", () => {
  const unproved = validateModelAuthoredShrSql({
    question: "murders in California",
    sql: "SELECT COUNT(v.id) AS m FROM victims v WHERE v.state = 'CA'",
  });
  assert.ok(!unproved.warnings.includes(LEGACY), "the legacy warning survived");
  assert.ok(!unproved.enforced.includes(LEGACY), "the legacy tag survived");
  assert.ok(!unproved.retryIssues.some((r) => r.includes(LEGACY)), "the legacy retry survived");
  assert.ok(unproved.enforced.includes("shr-murder-licence-unproved"), "the fact verdict is missing");
  assert.ok(unproved.blockReasons.length > 0, "an unproved licence must block");
  assert.ok(unproved.licenceRefusal, "the refusal reason is not recorded");

  const proved = validateModelAuthoredShrSql({
    question: "murders in California",
    sql: "SELECT COUNT(v.id) AS m FROM victims v JOIN incidents i ON v.incident_id = i.id "
      + "WHERE i.homicide_type = 'Murder' AND v.state = 'CA'",
  });
  assert.strictEqual(proved.licenceRefusal, null, "a proved licence must not record a refusal");
  assert.ok(!proved.enforced.includes("shr-murder-licence-unproved"));
});

console.log(`\nSHR legacy licence removal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
