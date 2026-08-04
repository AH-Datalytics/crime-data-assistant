process.env.RESEND_API_KEY = process.env.RESEND_API_KEY || "test-key";
const assert = require("node:assert/strict");
const { recordReliabilityTag } = require("./daily-query-analysis.js");

function stats() {
  return {
    guardrailFires: {},
    resolverTags: {},
    reliabilityCategories: {
      signal: {
        tag: "contract-year-lower-bound-missing",
        threshold: 3,
        count: 0,
        examples: [],
        resolvedCount: 0,
        resolvedExamples: [],
      },
    },
  };
}

const unresolved = stats();
recordReliabilityTag(unresolved, "contract-year-lower-bound-missing", "missing bound");
assert.equal(unresolved.reliabilityCategories.signal.count, 1);
assert.equal(unresolved.reliabilityCategories.signal.resolvedCount, 0);

const resolved = stats();
recordReliabilityTag(resolved, "contract-year-lower-bound-missing-resolved-on-retry", "fixed on retry");
assert.equal(resolved.reliabilityCategories.signal.count, 0);
assert.equal(resolved.reliabilityCategories.signal.resolvedCount, 1);
assert.equal(resolved.guardrailFires["contract-year-lower-bound-missing-resolved-on-retry"], 1);

console.log("daily reliability tag tests passed");