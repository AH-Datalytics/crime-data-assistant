// Tests for lib/no-sql-retry.ts — the guarded retry for model responses that
// contain no SQL and match none of the recognized refusal patterns.
// Run: npx tsx scripts/test-no-sql-retry.ts
import assert from "node:assert/strict";
import {
  boundedModelResponseJson,
  shouldRetryUnexplainedNoSql,
  UNEXPLAINED_NO_SQL_RETRY_PROMPT,
} from "../lib/no-sql-retry";
import { buildQueryContract } from "../lib/query-contract";

// A parsed contract means the request is supported — retry is worth a call
{
  const contract = buildQueryContract("murder clearances in Chicago, IL in 2025", "nibrs");
  assert.ok(contract, "fixture question must produce a contract");
  assert.equal(shouldRetryUnexplainedNoSql(contract, null), true);
}

// Nothing to go on — conversational or unsupported. Do not spend a second call.
assert.equal(shouldRetryUnexplainedNoSql(null, null), false);

// A resolved place alone is sufficient evidence the request is answerable
assert.equal(
  shouldRetryUnexplainedNoSql(null, { places: [{ status: "resolved" }] } as never),
  true
);

// An unresolved place is not
assert.equal(
  shouldRetryUnexplainedNoSql(null, { places: [{ status: "ambiguous" }] } as never),
  false
);
assert.equal(shouldRetryUnexplainedNoSql(null, { places: [] } as never), false);

assert.match(UNEXPLAINED_NO_SQL_RETRY_PROMPT, /^\[SYSTEM:/);

// Diagnostic payload is bounded and well-formed
{
  const parsed = JSON.parse(boundedModelResponseJson("x".repeat(5000), "y".repeat(5000)));
  assert.equal(parsed.first.length, 1500);
  assert.equal(parsed.retry.length, 1500);

  assert.equal(JSON.parse(boundedModelResponseJson("hello", null)).retry, null);
  assert.equal(JSON.parse(boundedModelResponseJson(null, null)).first, null);
}

console.log("no-sql-retry tests passed");
