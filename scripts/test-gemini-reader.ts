/**
 * The Gemini reader's validator (lib/nibrs-shadow/gemini-reader.ts): a reading is accepted only when grounded,
 * complete and read back exactly; anything else keeps today's outcome. No model calls: readings written for the test.
 */
import assert from "node:assert/strict";
import { MEASURE_WORDS, renderReading, validateReading, type Reading } from "../lib/nibrs-shadow/gemini-reader";
import { readQuestion } from "../lib/nibrs-shadow/reading";

// Every measure's canonical words read back as that measure, as a count, a rate and with a unit.
for (const [id, [one, many]] of Object.entries(MEASURE_WORDS)) for (const w of [many, `${one} rate`, `${one} victims`]) {
  const parts = readQuestion(`${w} in Memphis, Tennessee in 2024`, 2026).ledger.parts.filter((p) => p.clause === 0);
  assert.deepEqual(parts.filter((p) => p.concept === "measure").map((p) => p.value), [id], w);
  assert.ok(!parts.some((p) => p.concept === "unrecognized" || p.state === "not-interpreted"), w);
}

const base: Reading = { measure: { id: "murder", evidence: "killings" }, unit: null, places: [{ name: "Memphis", evidence: "Memphis" }],
  period: { kind: "year", years: [2024], evidence: "2024" }, breakdowns: [], statistic: null, unhandled: [] };
const ok = (r: Reading, q: string, prev: string | null = null) => { const v = validateReading(r, q, prev, 2026); assert.ok(v.ok, `${q}: ${JSON.stringify(v)}`); return (v as { question: string }).question; };
const no = (r: Reading | null, q: string, reason: string, prev: string | null = null) => assert.deepEqual(validateReading(r, q, prev, 2026), { ok: false, reason }, q);

// Accepted: grounded, covered, read back.
assert.equal(ok(base, "how many killings were there in Memphis in 2024"), "murders in Memphis in 2024");
assert.equal(ok({ ...base, breakdowns: [{ value: "race", person: "offender", evidence: "race of the killers" }], measure: { id: "murder", evidence: "murders" } },
  "show me the murders in memphis during 2024 broken out by race of the killers"), "murders in Memphis in 2024 by offender race");
assert.equal(ok({ ...base, period: { kind: "range", years: [2020, 2024], evidence: "between 2020 and 2024" }, statistic: { value: "percent_change", evidence: "percentage swing" } },
  "percentage swing in killings in Memphis between 2020 and 2024"), "percent change in murders in Memphis from 2020 to 2024");
// A person's attribute without whose stays a bare breakdown, which the engine asks about (never assumed victims).
assert.equal(ok({ ...base, breakdowns: [{ value: "race", person: null, evidence: "by race" }] }, "killings in Memphis in 2024 by race"), "murders in Memphis in 2024 by race");

// Refused: anything unhandled; words not in the question; words left over; a measure whose words read as another.
no({ ...base, unhandled: ["unsolved"] }, "unsolved killings in Memphis in 2024", "unhandled");
no({ ...base, places: [{ name: "Memphis", evidence: "Nashville" }] }, "killings in Memphis in 2024", "ungrounded");
no(base, "killings near schools in Memphis in 2024", "uncovered");
no({ ...base, measure: { id: "murder", evidence: "homicides" } }, "homicides in Memphis in 2024", "measure words read as another measure");
no(null, "anything", "no reading");
// Years must be written; no future years; a range has two ends.
no({ ...base, period: { kind: "year", years: [2023], evidence: "last year" } }, "killings in Memphis last year", "period");
no({ ...base, period: { kind: "year", years: [2030], evidence: "2030" } }, "killings in Memphis in 2030", "period");
no({ ...base, period: { kind: "range", years: [2020], evidence: "2020" } }, "killings in Memphis in 2020", "period");
// Whose only for a person's attribute.
no({ ...base, breakdowns: [{ value: "weapon", person: "victim", evidence: "by weapon" }] }, "killings in Memphis in 2024 by weapon", "breakdown");
// A missing measure stays missing.
no({ ...base, measure: null }, "Memphis in 2024", "no measure");

// Follow-ups: state from the previous question, grounded there; the follow-up's own words covered.
const prev = "killings in Memphis in 2024";
assert.equal(ok({ ...base, measure: { id: "murder", evidence: "killings", from: "previous" }, period: { kind: "year", years: [2024], evidence: "2024", from: "previous" },
  places: [{ name: "Dallas", evidence: "Dallas", from: "question" }] }, "same for Dallas", prev), "murders in Dallas in 2024");
assert.equal(ok({ ...base, measure: { id: "murder", evidence: "killings", from: "previous" }, places: [{ name: "Memphis", evidence: "Memphis", from: "previous" }],
  period: { kind: "year", years: [2024], evidence: "2024", from: "previous" }, statistic: { value: "rate", evidence: "as a rate", from: "question" } }, "as a rate", prev), "murder rate in Memphis in 2024");
no({ ...base, measure: { id: "murder", evidence: "robberies", from: "previous" } }, "same for 2024 in Memphis", "ungrounded", prev);
no({ ...base, measure: { id: "murder", evidence: "killings", from: "previous" } }, "same for Memphis in 2024", "ungrounded", null);

// "Since" a written year; a state the question doesn't name is dropped (the engine asks which Portland), one it names kept.
assert.equal(ok({ ...base, places: [{ name: "San Francisco", evidence: "san fran" }], period: { kind: "since", years: [2018], evidence: "since 2018" } }, "san fran killings since 2018"), "murders in San Francisco since 2018");
assert.equal(ok({ ...base, places: [{ name: "Portland, Oregon", evidence: "Portland" }] }, "killings in Portland in 2024"), "murders in Portland in 2024");
assert.equal(ok({ ...base, places: [{ name: "Portland, Oregon", evidence: "Portland Oregon" }] }, "killings in Portland Oregon in 2024"), "murders in Portland, Oregon in 2024");
assert.equal(ok({ ...base, places: [{ name: "Portland, OR", evidence: "Portland OR" }] }, "killings in Portland OR in 2024"), "murders in Portland, OR in 2024");
// Forms the canonical grammar doesn't write are refused, never approximated.
assert.equal(renderReading({ ...base, unit: { value: "victims", evidence: "victims" }, statistic: { value: "rate", evidence: "rate" } }), null);
assert.equal(renderReading({ ...base, statistic: { value: "share", evidence: "share" } }), null);
assert.equal(renderReading({ ...base, statistic: { value: "percent_change", evidence: "change" } }), null);

console.log("gemini reader: readings accepted only when grounded, complete and read back; the rest keep today's outcome");
