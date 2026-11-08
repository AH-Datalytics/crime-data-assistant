/**
 * Blind verification requests (lib/answer-eval/verify-request.ts; docs/runbooks/verify-new-answers.md): a request names
 * every number an answer shows and where it sits, carries the scorecard's table digest, and never the engine's SQL; a
 * request becomes a verified entry only when every number matched. Offline: built outcomes, no database.
 */
import assert from "node:assert/strict";
import { blindOf, compareExpected, mergeVerified, requestOf, sameValue, verifiedEntries, type VerifyRequest } from "../lib/answer-eval/verify-request";
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

// Results: verified only when every number matched, one result each, bound to the request's own cells and values.
const result = (r: VerifyRequest, i: number, verdict = "matched") => ({ request: r.id, column: r.numbers[i].column, at: r.numbers[i].at, engine: r.numbers[i].value, result: verdict, mine: r.numbers[i].value });
const all = q.numbers.map((_, i) => result(q, i));
const meta = { by: "runner-codex-blind", batch: "test", date: "2026-11-07" };
assert.deepEqual(verifiedEntries([q], all, meta).entries, { "QL-hist-x": { digest: q.digest, ...meta, numbers: 3 } }, "blanks aren't counted as numbers checked");
assert.deepEqual(verifiedEntries([q], all.slice(1), meta).unmatched, [{ id: "QL-hist-x", why: "1 numbers with no result" }]);
assert.deepEqual(verifiedEntries([q], [...all.slice(1), result(q, 0, "mismatch")], meta).unmatched, [{ id: "QL-hist-x", why: "1 not matched" }]);
assert.deepEqual(verifiedEntries([q], [...all, { ...all[0], at: { Year: "1999" } }], meta).unmatched, [{ id: "QL-hist-x", why: "1 results for numbers the answer doesn't show" }]);
assert.deepEqual(verifiedEntries([q], [...all, all[0]], meta).unmatched, [{ id: "QL-hist-x", why: "duplicate results" }]);
// Codex tool review 02: results for another request's values never verify this one, whatever they say ("matched").
const replacement = { ...q, numbers: q.numbers.map((n) => (n.value === 58.4 ? { ...n, value: 999 } : n)), digest: "ffffffffffffffff" };
assert.deepEqual(verifiedEntries([replacement], all, meta).unmatched, [{ id: "QL-hist-x", why: "1 not matched" }], "old results (engine 58.4) against a changed answer (999)");
assert.deepEqual(verifiedEntries([q], all.map((r, i) => (i === 2 ? { ...r, mine: 58.9 } : r)), meta).unmatched, [{ id: "QL-hist-x", why: "1 not matched" }], "the word matched is not trusted over the values");

// What the checker sees: cells without values, no digest, plan or reading.
const blind = JSON.stringify(blindOf(q));
assert.ok(!/61\.2|58\.4|70\.1|digest|engine_read|nibrs_plan/.test(blind), blind);
assert.equal((blindOf(q).cells as unknown[]).length, 4);

// The tolerance is a fixed bound, never the engine value's decimals (Codex tool review 01): 57 and 57.4 differ.
assert.ok(sameValue(57, 57) && sameValue(3.084, 308.4 / 100) && sameValue(61.2, 61.2000000001) && sameValue(null, null));
assert.ok(!sameValue(57, 57.4) && !sameValue(-57, -57.4) && !sameValue(61.2, 61.24) && !sameValue(0, 0.01) && !sameValue(1e21, 1e21 + 1e13) && !sameValue(null, 0) && !sameValue(0, null) && !sameValue(NaN, NaN));

// The compare: equal at the tolerance; both blank; a different value; no value; a blank is never a number.
const exp = (i: number, value: number | null) => ({ id: q.id, column: q.numbers[i].column, at: q.numbers[i].at, value });
const cmp = compareExpected([q], [exp(0, 61.2000001), exp(1, null), exp(2, 58.5), exp(3, 70.1)]).results;
assert.deepEqual(cmp.map((r) => r.result), ["matched", "matched", "mismatch", "matched"]);
assert.deepEqual(compareExpected([q], [exp(0, 61.2)]).results.map((r) => r.result), ["matched", "no value", "no value", "no value"]);
assert.equal(compareExpected([q], [exp(0, 61.2), exp(1, 5), exp(2, 58.4), exp(3, 70.1)]).results[1].result, "mismatch", "a blank is never matched by a number");
// Codex tool review 03-04: a duplicate checker value is trusted for neither, an extra cell is a result, an unknown
// request is a problem; and two cells at one column and place make the answer not verifiable.
const dup = compareExpected([q], [exp(0, 61.2), exp(0, 99), exp(1, null), exp(2, 58.4), exp(3, 70.1)]);
assert.deepEqual(dup.results.map((r) => r.result), ["duplicate value", "matched", "matched", "matched"]);
const extra = compareExpected([q], [exp(0, 61.2), exp(1, null), exp(2, 58.4), exp(3, 70.1), { id: q.id, column: "Extra", at: { Year: "2024" }, value: 1 }, { id: "QL-nope", column: "x", at: {}, value: 1 }]);
assert.deepEqual(extra.results.map((r) => r.result), ["matched", "matched", "matched", "matched", "extra cell"]);
assert.deepEqual(extra.problems, ["checker output for an unknown request QL-nope"]);
assert.equal(verifiedEntries([q], extra.results, meta).unmatched[0].why, "1 results for numbers the answer doesn't show");
const twin = requestOf(label, { ...historical, delivered: { table: { columns: [...columns, columns[1]], rows: [["2024", 61.2, null, 61.2]] }, text: [] } })!;
assert.equal(twin.verifiable, false, "a repeated column header at one place: not verifiable");
assert.deepEqual(verifiedEntries([twin], [], meta).unmatched, [{ id: "QL-hist-x", why: "two cells share one column and place: not verifiable" }]);
const twinRows = requestOf(label, { ...historical, delivered: { table: { columns, rows: [["2024", 61.2, 1], ["2024", 61.2, 1]] }, text: [] } })!;
assert.equal(twinRows.verifiable, false, "a repeated row: not verifiable");

// Adding to the verified file: same digest left alone, a different digest a conflict unless named.
const ex = { "QL-a": { digest: "aaaa" }, "QL-b": { digest: "bbbb" } };
const m = mergeVerified(ex, { "QL-a": { digest: "aaaa" }, "QL-b": { digest: "cccc" }, "QL-c": { digest: "dddd" } });
assert.deepEqual([m.added, m.unchanged, m.conflicts, m.replaced], [["QL-c"], ["QL-a"], ["QL-b"], []]);
assert.equal(m.merged["QL-b"].digest, "bbbb", "a conflict is not replaced");
assert.deepEqual(mergeVerified(ex, { "QL-b": { digest: "cccc" } }, ["QL-b"]).replaced, ["QL-b"]);

console.log("verify requests: every number named with its place in the table, the scorecard's digest, no SQL; verified only when all match");
