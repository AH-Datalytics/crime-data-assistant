import assert from "node:assert/strict";
import {
  RESOLVER_WARNING_REJECTION_ENABLED,
  resolverWarningFingerprint,
  resolverWarningGate,
  warningWhitelistMatch,
} from "../lib/resolver-warning-classification";

assert.equal(RESOLVER_WARNING_REJECTION_ENABLED, false);
const safeSql = `WITH targets(city, ori, start_year, end_year) AS (
  VALUES ('Oakland, CA', 'CA00109', 2021, 2021)
) SELECT * FROM targets t JOIN incidents i
ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year`;
assert.equal(warningWhitelistMatch(safeSql), "literal_ori_target_cte");
assert.equal(warningWhitelistMatch("SELECT * FROM incidents i WHERE i.agency LIKE 'Oakland%'"), null);

const one = resolverWarningFingerprint("shr", "resolved ORI missing for Oakland: CA00109", safeSql);
const two = resolverWarningFingerprint("shr", "resolved ORI missing for Oakland: CA00109", safeSql);
assert.equal(one, two);
assert.equal(one.length, 24);

assert.deepEqual(resolverWarningGate([]), {
  total: 0, classified: 0, unclassified: 0, falsePositives: 0,
  falsePositiveRate: null, ready: false,
});
assert.equal(resolverWarningGate([{ classification: "unclassified" }]).ready, false);
assert.equal(resolverWarningGate([
  { classification: "true_positive" },
  { classification: "true_positive" },
]).ready, true);
assert.equal(resolverWarningGate([
  { classification: "true_positive" },
  { classification: "false_positive" },
]).ready, false);

console.log("resolver warning classification tests passed");
