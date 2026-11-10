/**
 * The Gemini reader's validator (lib/nibrs-shadow/gemini-reader.ts): Gemini's replacements for the words the pattern
 * reader left unread are accepted only when grounded in their span, nothing is left unhandled, and the rewritten
 * question reads in full, keeps everything the original read and gains only what was declared. No model calls:
 * proposals are written for the test.
 */
import assert from "node:assert/strict";
import { MEASURE_WORDS, qualifies, replacementText, looksPersonal, unreadSpans, validateProposal, type Proposal, type Replacement } from "../lib/nibrs-shadow/gemini-reader";
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
const murdered: Replacement = { span: "murdered", kind: "measure", measure: "murder" };

// The question's own words stay; only the unread span is replaced, and the result reads in full.
assert.ok(unreadSpans("murdered in Memphis in 2024", Y).some((s) => /murdered/i.test(s)));
assert.equal(ok(P(murdered), "murdered in Memphis in 2024"), "murders in Memphis in 2024");
assert.equal(ok(P(murdered, { span: "San fran", kind: "place", place: "San Francisco" }), "murdered in San fran in 2024"), "murders in San Francisco in 2024");
assert.equal(ok(P(murdered, { span: "broken out by race of the killers", kind: "breakdown", breakdown: { value: "race", person: "offender" } }), "murdered in Memphis in 2024 broken out by race of the killers"),
  "murders in Memphis in 2024 by offender race");
// A condition the reader read is kept by the user's own words ("unsolved" is a clearance setting), and can't be
// swallowed into a span.
assert.equal(ok(P(murdered), "unsolved murdered in Memphis in 2024"), "unsolved murders in Memphis in 2024");
no(P({ span: "unsolved murdered", kind: "measure", measure: "murder" }), "unsolved murdered in Memphis in 2024", /unread words|clearance was lost|measure/);
// A part the reader read can't be replaced (Memphis read as a place, swapped for Dallas).
no(P(murdered, { span: "Memphis", kind: "place", place: "Dallas" }), "murdered in Memphis in 2024", /lost or changed|place|unread words/);
// An unread condition left in place keeps the question unread.
no(P(murdered), "murdered near schools in Memphis in 2024", /still unread/);
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
no({ replacements: [murdered], unhandled: ["near schools"] }, "murdered near schools in Memphis in 2024", /unhandled/);
no(P({ span: "homicides", kind: "measure", measure: "murder" }), "murdered in Memphis in 2024", /span not found once|unread words|measure/);
no(null, "anything", /no proposal/);
no(P(), "murdered in Memphis in 2024", /no replacements/);

// Only shorthand or a misspelling of the measure's own words, never another term or legal category (Jeff 2026-11-09;
// the step 1 run read "felony assaults" as aggravated assaults: QL-ct-15ffa7d9ce).
no(P({ span: "felony assaults", kind: "measure", measure: "aggravated_assault" }), "what are the count of felony assaults in new york city in 2025", /measure/);
assert.equal(replacementText({ span: "felony assaults", kind: "measure", measure: "aggravated_assault" }), null);
assert.equal(replacementText({ span: "assaults", kind: "measure", measure: "aggravated_assault" }), null);
assert.equal(replacementText({ span: "slayings", kind: "measure", measure: "murder" }), null);
assert.equal(replacementText({ span: "killings", kind: "measure", measure: "murder" }), null);
assert.equal(replacementText({ span: "agg assaults", kind: "measure", measure: "aggravated_assault" }), "aggravated assaults");
assert.equal(replacementText({ span: "murdered", kind: "measure", measure: "murder" }), "murders");
// A word for the person is another term (Codex review 19.1).
for (const [span, measure] of [["arsonist", "arson"], ["murderer", "murder"], ["murderers", "murder"], ["robber", "robbery"], ["burglar", "burglary"]])
  assert.equal(replacementText({ span, kind: "measure", measure }), null, span);
// Codex review 02: a measure span carrying a condition, a place swallowing a qualifier, a rate or unit that isn't what
// the words count: all refused.
no(P({ span: "murdered near schools", kind: "measure", measure: "murder" }), "murdered near schools in Memphis in 2024", /measure/);
no(P({ span: "downtown Memphis", kind: "place", place: "Memphis" }), "murders in downtown Memphis in 2024", /unread words|place/);
no(P({ span: "downtown San fran", kind: "place", place: "San Francisco" }), "murders in downtown San fran in 2024", /place/);
assert.equal(replacementText({ span: "per household", kind: "statistic", statistic: "rate" }), null);
assert.equal(replacementText({ span: "per capita", kind: "statistic", statistic: "rate" }), "rate");
assert.equal(replacementText({ span: "counting families", kind: "unit", unit: "victims" }), null);
assert.equal(replacementText({ span: "people killed", kind: "unit", unit: "victims" }), "victims");
// Spelling: one unread word for its correct spelling, close enough to be a typo; the pattern reader then reads it, and
// may join it with a part it already read ("aggravates assaults" -> aggravated assaults).
assert.equal(ok(P({ span: "aggravates", kind: "spelling", spelling: "aggravated" }), "show me aggravates assaults in salem oregon from 2004 to 2025"),
  "show me aggravated assaults in salem oregon from 2004 to 2025");
assert.equal(replacementText({ span: "aggravates", kind: "spelling", spelling: "aggravating" }), null);   // too far
assert.equal(replacementText({ span: "rob", kind: "spelling", spelling: "rod" }), null);                 // too short to judge
assert.equal(replacementText({ span: "comparied to", kind: "spelling", spelling: "compared to" }), null); // one word only
assert.equal(replacementText({ span: "comparied", kind: "spelling", spelling: "compared" }), "compared");
assert.equal(replacementText({ span: "willful", kind: "spelling", spelling: "willful" }), null);         // the same word
// A prefix added, dropped or changed is another word, not a typo (Codex review 08).
for (const [f, t] of [["unreported", "reported"], ["deported", "reported"], ["unrelated", "related"]]) assert.equal(replacementText({ span: f, kind: "spelling", spelling: t }), null, f);
// A question that may hold a personal detail is withheld (never sent, never cached): the blunt rule (the coordinator,
// 2026-11-09). An at sign; seven or more digits once separators are taken out; any number but a year 1900-2099, a
// percent or one or two digits; box, apt, suite or unit next to a number.
for (const q of ["jane@example.com", "jane\uFF20example.com", "(314)555-0199", "314 555 0199", "+33 6 12 34 56 78", "call 555-0199",
  "is my business at 910 st. louis street 62025 risky", "crime in 123 Main St", "crime in 63101.", "crime near 1600 Pennsylvania",
  "PO Box 12", "crime near Apt 4B", "suite 12", "12 unit building fire", "murders per 100,000 in St. Louis",
  "murders in 2019 2020 2021", "murders from 2015-2024", "20‐20‐20‐20‐12", "20‑20‑20‑20‑12", "12.345", "2024.1"]) assert.equal(looksPersonal(q), true, q);
for (const q of ["2024 murders in St. Louis", "top 10 cities in St. Louis County", "victims age 18", "50% of murders", "murders in 2020 Chicago",
  "last 12 months", "murders in Memphis from 2019 to 2023", "robberies in the 1990s", "murders among 18 to 24 year olds", "123.45% increase", "123.45 percent"])
  assert.equal(looksPersonal(q), false, q);
// What the blunt rule lets through by design (a one- or two-digit or year-like house number; the coordinator's rule):
for (const q of ["crime near 12 Oak Rd", "crime near 12-14 Park Place", "crime in 1900 Main St"]) assert.equal(looksPersonal(q), false, q);
// When Gemini is consulted: not for policy declines, nor a fully read question, nor an answer.
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "decline", reason: "reader" }, Y), true);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "clarify" }, Y), true);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "decline", reason: "unsupported_capability" }, Y), false);
assert.equal(qualifies("slayings in Memphis in 2024", { kind: "answer" }, Y), false);
assert.equal(qualifies("murders in Memphis in 2024", { kind: "clarify" }, Y), false);
// Gang wording is declined by policy (P38), so never sent to Gemini.
assert.equal(qualifies("Gang related murdered in Chicago over time", { kind: "decline", reason: "reader" }, Y), false);
assert.equal(qualifies("will slayings in Memphis rise next year", { kind: "decline", reason: "reader" }, Y), false);

console.log("gemini reader: replacements accepted only when grounded and the rewritten question reads in full, keeping what was read");
