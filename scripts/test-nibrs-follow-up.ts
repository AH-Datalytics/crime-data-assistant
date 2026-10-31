/**
 * Increment 7b (P69): the follow-up rewriter. A follow-up becomes one standalone question, or a presentation-only
 * edit, or a complete question of its own; anything it cannot place fully is asked about, never guessed (the
 * coordinator's rule 2). The rewriter sits behind an interface, so a model-backed one can replace this baseline.
 * Offline: no database, no model.
 */
import assert from "node:assert/strict";
import { deterministicRewriter as R, type FollowUpRewriter, type Rewrite } from "../lib/nibrs-shadow/follow-up";
import { shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const P = "Shoplifting in Memphis by year from 2021 to 2024";
const rw = (prev: string, f: string) => R.rewrite(prev, f);
const q = (r: Rewrite) => { assert.notEqual(r.kind, "ask", JSON.stringify(r)); return (r as Extract<Rewrite, { question: string }>).question; };
const asked = (r: Rewrite) => { assert.equal(r.kind, "ask", JSON.stringify(r)); return r as Extract<Rewrite, { kind: "ask" }>; };

// Rewrites: the previous question with the follow-up's change, and nothing else.
assert.equal(q(rw(P, "what about Nashville?")), "Shoplifting in Nashville by year from 2021 to 2024");
assert.equal(q(rw(P, "rate instead")), "Shoplifting rate in Memphis by year from 2021 to 2024");
assert.equal(q(rw(P, "by month")), "Shoplifting in Memphis by month from 2021 to 2024");
assert.equal(q(rw("carjackings in Memphis TN by month in 2025", "make it quarterly")), "carjackings in Memphis TN by quarter in 2025");
// P72: a population column goes with a rate; agencies reporting with a state or national total.
assert.equal(q(rw("Shoplifting rate in Wichita in 2024", "add a column for population")), "Shoplifting rate in Wichita in 2024, with a column showing the population used to calculate the rate");
assert.equal(q(rw("Shoplifting in Kansas in 2024", "how many agencies reported")), "Shoplifting in Kansas in 2024, with the number of agencies reporting");
assert.match(asked(rw(P, "add a column for population")).why, /goes with a rate/);
assert.match(asked(rw(P, "how many agencies reported")).why, /state or national total/);

// A complete question of its own is asked as it is; a presentation edit keeps the data question (P69).
const own = rw(P, "How many robberies were there in Detroit in 2023?");
assert.equal(own.kind, "new");
assert.equal(q(own), "How many robberies were there in Detroit in 2023?");
const pres = rw(P, "show it as a line chart");
assert.equal(pres.kind, "presentation");
assert.equal(q(pres), P);

// Rule 2: what cannot be placed fully is asked about, never a partial guess.
asked(rw(P, "why did it go up?"));
asked(rw(P, "same for 2020"));
asked(rw(P, "make the bars blue but only for violent crime"));
// A new place after several: replace or add is asked, each option a complete question (places joined by "and": a
// comma reads "Tulsa, Oklahoma City" as Tulsa, Oklahoma).
assert.deepEqual(asked(rw("Shoplifting in Tulsa and Oklahoma City in 2024", "what about Wichita?")).options, [
  { label: "Wichita only", question: "Shoplifting in Wichita in 2024" },
  { label: "Add Wichita; show all three separately", question: "Shoplifting in Tulsa and Oklahoma City and Wichita in 2024" }]);
// Codex 7b-04.1: a form inside longer words is asked about, never applied with the rest dropped.
const M = "Shoplifting in Memphis by month in 2024";
for (const f of ["make it a bar chart for 2023", "make it quarterly for Nashville in 2023", "add a column for population and make it 2023",
  "what about Nashville by month", "now murders in Nashville instead", "only the offenders linked to each victim in 2023"]) asked(rw(M, f));
// Codex 7b-04.2: "add" adds a year; a period of months, a range or a set is asked about, never overwritten.
assert.equal(q(rw("Shoplifting in Memphis in 2024", "add 2023")), "Shoplifting in Memphis in 2023 and 2024");
asked(rw("Shoplifting in Memphis in January 2024", "same for 2023"));
asked(rw("Shoplifting in Memphis in 2019 and 2024", "same for 2023"));
// Codex 7b-04.4: a second supporting column is asked about, never swapped for the first.
asked(rw("Shoplifting rate in Kansas in 2024, with a column showing the population used to calculate the rate", "how many agencies reported"));
// Codex 7b-04 re-check: an additive or comparative opening keeps its meaning; a color is a color; quarters replace the
// grain; an existing column is found by the reader, whatever the punctuation.
const Y = "Shoplifting in Memphis in 2024";
assert.equal(q(rw(Y, "also 2023")), "Shoplifting in Memphis in 2023 and 2024");
assert.equal(q(rw(Y, "and Nashville")), "Shoplifting in Memphis and Nashville in 2024");
asked(rw(Y, "compare shoplifting in Nashville in 2023"));
asked(rw(Y, "also by month"));
asked(rw(Y, "make the lines quarterly"));
assert.equal(rw(Y, "make the bars blue").kind, "presentation");
assert.equal(q(rw(P, "quarterly")), "Shoplifting in Memphis by quarter from 2021 to 2024");
asked(rw("Shoplifting rate in Kansas in 2024 with a column showing the population used to calculate the rate", "how many agencies reported"));
// Codex 7b-04 third pass: a comparison never joins a combined total; words pointing back make a question not its own.
asked(rw("Shoplifting in Memphis and Nashville combined in 2024", "compare to Knoxville"));
asked(rw(Y, "please now compare shoplifting in Nashville in 2023"));
asked(rw(Y, "show shoplifting in Nashville in 2023 alongside that"));
// Codex 7b-04 fourth pass: each option's question says what its label says; a word the reader leaves unread keeps a
// question from being its own.
const comb = asked(rw("Shoplifting in Memphis and Nashville combined in 2024", "what about Knoxville?")).options;
assert.deepEqual(comb.map((o) => o.question), ["Shoplifting in Knoxville in 2024", "Shoplifting in Memphis and Nashville and Knoxville in 2024",
  "Shoplifting in Memphis and Nashville and Knoxville combined in 2024"]);
assert.deepEqual(comb.map((o) => o.label), ["Knoxville only", "Add Knoxville; show all three separately", "Add Knoxville to the combined total"]);
asked(rw(Y, "show shoplifting in Nashville in 2023 using the same breakdown"));
asked(rw(Y, "please include shoplifting in Nashville in 2023"));
// Codex 7b-04 fifth pass: filler or context words that point back ("same", "side by side", "for comparison") are asked.
for (const f of ["show the same shoplifting breakdown in Nashville in 2023", "show shoplifting in Nashville in 2023 side by side",
  "show shoplifting in Nashville in 2023 for comparison"]) asked(rw(M, f));
assert.equal(rw(M, "What was the number of robberies in Detroit in 2023?").kind, "new");
// Codex 7b-04 sixth pass: no option drops the year asked; a place with other words is asked about.
assert.deepEqual(asked(rw("Shoplifting in Memphis and Nashville in 2024", "what about Knoxville in 2023?")).options, []);
asked(rw("Shoplifting in Memphis and Nashville in 2024", "combined with Knoxville"));
assert.equal(q(rw(Y, "what about Knoxville in 2023?")), "Shoplifting in Knoxville in 2023");
// Codex 7b-04 seventh pass: with two sex words, which one "male" replaces is asked.
asked(rw("Female murder victims with female offenders in Memphis in 2024", "male"));
// Every placed rewrite is certain; there is no "probably".
for (const f of ["what about Nashville?", "rate instead", "by month", "show it as a line chart"]) {
  const r = rw(P, f);
  assert.ok(r.kind !== "ask" && r.confidence === "certain");
}

// Rule 1: the interface. A stand-in rewriter is used by shadowFollowUp in place of the baseline; an ask becomes a
// clarify whose options are complete questions (each run only as its own continuation).
const places = loadPlaceIndex();
let ran = 0;
const deps: ShadowDeps = { places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2024] }, execute: () => { ran++; return []; } };
const stand: FollowUpRewriter = { rewrite: () => ({ kind: "ask", why: "which place", options: [{ label: "Nashville", question: "Shoplifting in Nashville in 2024" }] }) };
const c = shadowFollowUp(P, "there", deps, stand);
assert.equal(c.kind, "clarify");
assert.equal(c.rewrite, null);
const opt = (c as Extract<typeof c, { kind: "clarify" }>).options;
assert.deepEqual(opt.map((o) => o.label), ["Nashville"]);
assert.ok("continuation" in opt[0] && opt[0].continuation, "the option is its complete question's own answer");
// The baseline's ask with no options is a clarify that runs nothing: the user asks the full question.
const before = ran, b = shadowFollowUp(P, "why did it go up?", deps);
assert.equal(b.kind, "clarify");
assert.equal(b.rewrite, null);
assert.equal(ran, before, "an ask with no options runs nothing");

console.log("nibrs follow-up: rewrites are standalone and certain, the rest is asked; the rewriter is replaceable");
