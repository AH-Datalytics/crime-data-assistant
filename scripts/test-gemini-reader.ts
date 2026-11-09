/**
 * The Gemini reader's validator (lib/nibrs-shadow/gemini-reader.ts): Gemini's replacements for the words the pattern
 * reader left unread are accepted only when grounded in their span, nothing is left unhandled, and the rewritten
 * question reads in full, keeps everything the original read and gains only what was declared. No model calls:
 * proposals are written for the test.
 */
import assert from "node:assert/strict";
import { MEASURE_WORDS, qualifies, replacementText, unreadSpans, validateProposal, type Proposal, type Replacement } from "../lib/nibrs-shadow/gemini-reader";
import { readQuestion } from "../lib/nibrs-shadow/reading";

const Y = 2026;
// Every measure's words read back as that measure.
for (const [id, [, many]] of Object.entries(MEASURE_WORDS)) {
  const parts = readQuestion(`${many} in Memphis, Tennessee in 2024`, Y).ledger.parts.filter((p) => p.clause === 0);
  assert.deepEqual(parts.filter((p) => p.concept === "measure").map((p) => p.value), [id], many);
}

const P = (...replacements: Replacement[]): Proposal => ({ replacements, unhandled: [] });
const ok = (p: Proposal, q: string) => { const v = validateProposal(p, q, Y); assert.ok(v.ok, `${q}: ${JSON.stringify(v)}`); return (v as { question: string }).question; };
const no = (p: Proposal | null, q: string, reason: RegExp) => { const v = validateProposal(p, q, Y); assert.ok(!v.ok && reason.test(v.reason), `${q}: ${JSON.stringify(v)}`); };
const slayings: Replacement = { span: "slayings", kind: "measure", measure: "murder" };

// The question's own words stay; only the unread span is replaced, and the result reads in full.
assert.ok(unreadSpans("slayings in Memphis in 2024", Y).some((s) => /slayings/i.test(s)));
assert.equal(ok(P(slayings), "slayings in Memphis in 2024"), "murders in Memphis in 2024");
assert.equal(ok(P(slayings, { span: "San fran", kind: "place", place: "San Francisco" }), "slayings in San fran in 2024"), "murders in San Francisco in 2024");
assert.equal(ok(P(slayings, { span: "broken out by race of the killers", kind: "breakdown", breakdown: { value: "race", person: "offender" } }), "slayings in Memphis in 2024 broken out by race of the killers"),
  "murders in Memphis in 2024 by offender race");
// A condition the reader read is kept by the user's own words ("unsolved" is a clearance setting), and can't be
// swallowed into a span.
assert.equal(ok(P(slayings), "unsolved slayings in Memphis in 2024"), "unsolved murders in Memphis in 2024");
no(P({ span: "unsolved slayings", kind: "measure", measure: "murder" }), "unsolved slayings in Memphis in 2024", /unread words|clearance was lost/);
// A part the reader read can't be replaced (Memphis read as a place, swapped for Dallas).
no(P(slayings, { span: "Memphis", kind: "place", place: "Dallas" }), "slayings in Memphis in 2024", /lost or changed|place|unread words/);
// An unread condition left in place keeps the question unread.
no(P(slayings), "slayings near schools in Memphis in 2024", /still unread/);
// Grounding in the span: years written; whose named; a state named (never "in" for Indiana); vocabulary only.
assert.equal(replacementText({ span: "since twenty eighteen", kind: "period", period: { kind: "since", years: [2018] } }), null);
assert.equal(replacementText({ span: "between 2019 and 2023", kind: "period", period: { kind: "range", years: [2019, 2023] } }), "from 2019 to 2023");
assert.equal(replacementText({ span: "by race", kind: "breakdown", breakdown: { value: "race", person: "offender" } }), null);
assert.equal(replacementText({ span: "broken out by race of the killers", kind: "breakdown", breakdown: { value: "race", person: "offender" } }), "by offender race");
assert.equal(replacementText({ span: "by race", kind: "breakdown", breakdown: { value: "race", person: null } }), "by race");
assert.equal(replacementText({ span: "portland", kind: "place", place: "Portland, Oregon" }), "Portland");
assert.equal(replacementText({ span: "portland in", kind: "place", place: "Portland, IN" }), "Portland");
assert.equal(replacementText({ span: "Portland IN", kind: "place", place: "Portland, IN" }), "Portland, IN");
assert.equal(replacementText({ span: "portland oregon", kind: "place", place: "Portland, Oregon" }), "Portland, Oregon");
assert.equal(replacementText({ span: "killings", kind: "measure", measure: "genocide" }), null);
assert.equal(replacementText({ span: "by weapon", kind: "breakdown", breakdown: { value: "weapon", person: "victim" } }), null);
// Refusals: anything unhandled; a span not in the question, or found twice; no proposal.
no({ replacements: [slayings], unhandled: ["near schools"] }, "slayings near schools in Memphis in 2024", /unhandled/);
no(P({ span: "homicides", kind: "measure", measure: "murder" }), "slayings in Memphis in 2024", /span not found once|unread words/);
no(null, "anything", /no proposal/);
no(P(), "slayings in Memphis in 2024", /no replacements/);

// Codex review 02: a measure span carrying a condition, a place swallowing a qualifier, a rate or unit that isn't what
// the words count: all refused.
no(P({ span: "slayings near schools", kind: "measure", measure: "murder" }), "slayings near schools in Memphis in 2024", /measure/);
no(P({ span: "downtown Memphis", kind: "place", place: "Memphis" }), "murders in downtown Memphis in 2024", /unread words|place/);
no(P({ span: "downtown San fran", kind: "place", place: "San Francisco" }), "murders in downtown San fran in 2024", /place/);
assert.equal(replacementText({ span: "per household", kind: "statistic", statistic: "rate" }), null);
assert.equal(replacementText({ span: "per capita", kind: "statistic", statistic: "rate" }), "rate");
assert.equal(replacementText({ span: "counting families", kind: "unit", unit: "victims" }), null);
assert.equal(replacementText({ span: "people killed", kind: "unit", unit: "victims" }), "victims");
// When Gemini is consulted: not for policy declines, nor a fully read question, nor an answer.
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "decline", reason: "reader" }, Y), true);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "clarify" }, Y), true);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "decline", reason: "unsupported_capability" }, Y), false);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "answer" }, Y), false);
assert.equal(qualifies("murders in Memphis in 2024", { kind: "clarify" }, Y), false);
assert.equal(qualifies("will slayings in Memphis rise next year", { kind: "decline", reason: "reader" }, Y), false);

console.log("gemini reader: replacements accepted only when grounded and the rewritten question reads in full, keeping what was read");
