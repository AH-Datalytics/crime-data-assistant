/**
 * Blind verification requests (lib/answer-eval/verify-request.ts; docs/runbooks/verify-new-answers.md): a request names
 * every number an answer shows and where it sits, carries the scorecard's table digest, and never the engine's SQL; a
 * request becomes a verified entry only when every number matched. Offline: built outcomes, no database.
 */
import assert from "node:assert/strict";
import { blindOf, compareExpected, requestOf, verifiedEntries, type VerifyRequest } from "../lib/answer-eval/verify-request";
import { tableDigest } from "../lib/answer-eval/table-digest";

const label = { id: "QL-hist-x", tab: "historical", kind: "first", times: 3, question: "Murder clearance rate in Houston and Dallas since 2024", previous: null };
const columns = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year" },
  { binding: { kind: "statistic", as: "clearance_rate.0" }, header: "Houston, Texas: murders cleared (%)" },
  { binding: { kind: "statistic", as: "clearance_rate.1" }, header: "Dallas, Texas: murders cleared (%)" }];
const rows = [["2024", 61.2, null], ["2025", 58.4, 70.1]];
const historical = { kind: "historical", period: { from: "2024-01", to: "2025-12" }, delivered: { table: { columns, rows }, text: ["..."] },
  question: { measure: "murder", statistic: "clearance_rate", agencies: [{ ori: "TXHPD0000", state: "TX", label: "Houston, Texas" }, { ori: "TXDPD0000", state: "TX", label: "Dallas, Texas" }] },
  read: { table: "agency_clearances", column: "murder_cleared_rate", release: "crimeindex-20261101" } };
const q = requestOf(label, historical)!;
assert.equal(q.source, "crimeindex_agency");
assert.equal(q.grain, "time.year");
assert.deepEqual(q.places, [{ kind: "agency", ori: "TXHPD0000", state: "TX", label: "Houston, Texas" }, { kind: "agency", ori: "TXDPD0000", state: "TX", label: "Dallas, Texas" }]);
assert.equal(q.numbers.length, 4, "every statistic cell, blanks included");
assert.deepEqual(q.numbers[1], { column: "Dallas, Texas: murders cleared (%)", binding: { kind: "statistic", as: "clearance_rate.1" }, at: { Year: "2024" }, value: null });
assert.equal(q.digest, tableDigest(rows), "the scorecard's digest of the same rows");
assert.equal(q.follow_up_of, null);

// A NIBRS answer: its plan, without any SQL at any depth; the engine's own query is never in a request.
const nibrs = { kind: "answer", period: { from: "2023-01", to: "2023-12" }, sql: "SELECT secret", delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: "Robberies" }], rows: [[512]] } },
  plan: { measures: [{ id: "offenses.robbery", as: "robbery" }], statistics: [{ kind: "count", as: "robbery_count", measure: "robbery" }], filters: [], groupings: [], geography: { places: [{ kind: "agency", ori: "MA0130100", label: "Boston, Massachusetts" }], combine: "separate" }, compiled: { sql: "SELECT x" } } };
const n = requestOf({ ...label, id: "QL-nibrs-y", tab: "nibrs", kind: "follow-up", previous: "robberies in Boston" }, nibrs)!;
assert.equal(n.source, "nibrs");
assert.equal(n.grain, "total");
assert.equal(n.follow_up_of, "robberies in Boston");
assert.ok(!/SELECT/.test(JSON.stringify(n)), "no SQL anywhere in a request");
assert.deepEqual(n.places, [{ kind: "agency", ori: "MA0130100", label: "Boston, Massachusetts" }]);
assert.equal(n.combine, "separate");
assert.deepEqual([n.measure, n.statistic], ["robbery", "count"], "a NIBRS answer's measure and statistic come from its plan");
const rolling = requestOf(label, { ...nibrs, plan: { ...nibrs.plan, measures: [{ id: "victims.murder", as: "murder" }], statistics: [{ kind: "count" }], transforms: [{ kind: "rolling", months: 12 }] } })!;
assert.deepEqual([rolling.measure, rolling.statistic], ["murder", "count+rolling"]);
// No table: no request.
assert.equal(requestOf(label, { kind: "clarify" }), null);

// Results: verified only when every number matched, one result each.
const result = (r: VerifyRequest, i: number, verdict = "matched") => ({ request: r.id, column: r.numbers[i].column, at: r.numbers[i].at, engine: r.numbers[i].value, result: verdict, mine: r.numbers[i].value });
const all = q.numbers.map((_, i) => result(q, i));
const meta = { by: "runner-codex-blind", batch: "test", date: "2026-11-07" };
assert.deepEqual(verifiedEntries([q], all, meta).entries, { "QL-hist-x": { digest: q.digest, ...meta, numbers: 3 } }, "blanks aren't counted as numbers checked");
assert.deepEqual(verifiedEntries([q], all.slice(1), meta).unmatched, [{ id: "QL-hist-x", why: "1 numbers with no result" }]);
assert.deepEqual(verifiedEntries([q], [...all.slice(1), result(q, 0, "mismatch")], meta).unmatched, [{ id: "QL-hist-x", why: "1 not matched" }]);
assert.deepEqual(verifiedEntries([q], [...all, { ...all[0], at: { Year: "1999" } }], meta).unmatched, [{ id: "QL-hist-x", why: "1 results for numbers the answer doesn't show" }]);
assert.deepEqual(verifiedEntries([q], [...all, all[0]], meta).unmatched, [{ id: "QL-hist-x", why: "duplicate results" }]);

// What the checker sees: cells without values, no digest, plan or reading.
const blind = JSON.stringify(blindOf(q));
assert.ok(!/61\.2|58\.4|70\.1|digest|engine_read|nibrs_plan/.test(blind), blind);
assert.equal((blindOf(q).cells as unknown[]).length, 4);
// The compare: equal at the engine value's own decimals; both blank; a different value; no value.
const exp = (i: number, value: number | null) => ({ id: q.id, column: q.numbers[i].column, at: q.numbers[i].at, value });
const cmp = compareExpected([q], [exp(0, 61.2000001), exp(1, null), exp(2, 58.5), exp(3, 70.1)]);
assert.deepEqual(cmp.map((r) => r.result), ["matched", "matched", "mismatch", "matched"]);
assert.deepEqual(compareExpected([q], [exp(0, 61.2)]).map((r) => r.result), ["matched", "no value", "no value", "no value"]);
assert.equal(compareExpected([q], [exp(0, 61.2), exp(1, 5), exp(2, 58.4), exp(3, 70.1)])[1].result, "mismatch", "a blank is never matched by a number");

console.log("verify requests: every number named with its place in the table, the scorecard's digest, no SQL; verified only when all match");
