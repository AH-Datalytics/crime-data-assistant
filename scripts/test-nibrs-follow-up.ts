/**
 * Increment 7b (P69): the follow-up rewriter. A follow-up becomes one standalone question, or a presentation-only
 * edit, or a complete question of its own; anything it cannot place fully is asked about, never guessed (the
 * coordinator's rule 2). The rewriter sits behind an interface, so a model-backed one can replace this baseline.
 * Offline: no database, no model.
 */
import assert from "node:assert/strict";
import { deterministicRewriter as R, PLACE_ASK, standsAlone, type FollowUpRewriter, type Rewrite } from "../lib/nibrs-shadow/follow-up";
import { shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { readQuestion } from "../lib/nibrs-shadow/reading";

const P = "Shoplifting in Memphis by year from 2021 to 2024";
// A fixed calendar year (2026), so no test depends on today's date (timing-gate inventory: no clock reads).
const rw = (prev: string, f: string, thisYear = 2026) => R.rewrite(prev, f, thisYear);
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
// P69 amendment: "show 10 years" and its kin are the last N complete years by year, from the release (the reader reads
// "over the last N years"); a month period asks; "go back further" asks how far. "Make the graph green" is presentation.
assert.equal(q(rw(P, "show 10 years")), "Shoplifting in Memphis by year over the last 10 years");
assert.equal(q(rw(P, "show the seven-year trend")), "Shoplifting in Memphis by year over the last 7 years");
assert.equal(q(rw(M, "Past 5 years")), "Shoplifting in Memphis by year over the last 5 years");
asked(rw("Shoplifting in Memphis in January 2024", "show 10 years"));
asked(rw(P, "can you go back further in time?"));
assert.equal(rw(M, "Make the graph green").kind, "presentation");
// The preview's chart and table commands (coordinator, 2026-11-01): presentation, never "could not be placed".
for (const f of ["as bars", "show as a line", "table only", "show it as bars", "as a table", "just the table", "chart only", "hide the chart", "in a table"]) assert.equal(rw(M, f).kind, "presentation", f);
// A data change in the same words stays a data change.
assert.notEqual(rw(M, "as bars by year").kind, "presentation");
// Codex full review 1: a previous period of several years is not one phrase to replace: asked.
asked(rw("Shoplifting in Memphis in 2023 and 2024", "show 5 years"));
// Real conversations (hand check of the production log's follow-up turns): a previous turn that was itself a follow-up
// is not a question to change (#13); a bare state names an ambiguous city's state (#46), and after a placed city it asks.
asked(rw("Make it per capita", "Show counts instead"));
// The sweep of the real turns: a complete new question after an incomplete previous turn still runs as itself.
assert.equal(q(rw("where is it", "How many murders in Chicago in 2024")), "How many murders in Chicago in 2024");
assert.equal(q(rw("show me springfield murders", "Missouri")), "show me springfield, Missouri murders");
// Codex review of the rule fixes, 1: "instead" still replaces; "what about" after an ambiguous city asks.
assert.equal(q(rw("show me springfield murders", "Missouri instead")), "show me Missouri murders");
asked(rw("show me springfield murders", "what about Missouri?"));
asked(rw("murders in Chicago in 2024", "Illinois"));
assert.equal(q(rw("Shoplifting in Missouri in 2024", "Kansas")), "Shoplifting in Kansas in 2024");
// Jeff (2026-11-01): "it assumes everything is a follow up." A turn with its own crime and place, pointing back at
// nothing, is a new question; one missing the crime or the place, or pointing back, is a follow-up.
for (const t of ["Murders in Chicago in 2024", "Did shoplifting go up in Detroit from 2022 to 2023?", "violent crime in Kansas City", "How many simple assaults were there in Detroit in 2023?"])
  assert.ok(standsAlone(t), `new: ${t}`);
for (const t of ["what about Denver in 2023?", "now murders instead", "male", "compare to Dallas", "Nashville", "2024", "by month", "same for Houston",
  "show it for Memphis", "and robberies in Detroit in 2023", "robberies in Detroit in 2023 too",
  "How does that compare to shoplifting in Nashville in 2024?", "Can you compare shoplifting in Nashville in 2024?", "Is shoplifting in Nashville higher than that?"])
  assert.ok(!standsAlone(t), `follow-up: ${t}`);
// Follow-up cluster A (2026-11-05): a comparison naming both sides, a ranking or set of places, a unit with a place, or
// an unread county is the turn's own question (answered, asked about or declined as a new one, never "couldn't tell").
for (const t of ["shoplifting in Nashville in 2024 versus Memphis", "Murder rate comparison between Houston and Chicago for 2026", "Top 10 auto theft rates in 2025",
  "Victim age breakdown in Texas in 2023", "number of homicides in bexar county tx in 2025", "Murder rates in Bexar County versus Travis County", "Murder rates in Houston versus Dallas this year"])
  assert.ok(standsAlone(t), `new: ${t}`);
// Codex follow-up review 01.1: a comparison referring to the answer ("that", "it") points back, whatever it names.
for (const t of ["How does that compare to robberies in Houston and Dallas?", "Is it higher in Houston than in Dallas?", "Murder rates in Houston versus Dallas that year",
  "How does this last comparison of murder rates in Houston and Dallas differ?"]) assert.ok(!standsAlone(t), `follow-up: ${t}`);
// Every placed rewrite is certain; there is no "probably".
for (const f of ["what about Nashville?", "rate instead", "by month", "show it as a line chart"]) {
  const r = rw(P, f);
  assert.ok(r.kind !== "ask" && r.kind !== "propose" && r.confidence === "certain");
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

// The other sex (coordinator, 2026-11-01): a button for each reading, each a complete question; the plain ask otherwise.
{
  const who = asked(rw("Aggravated assaults in Memphis in 2024", "female"));
  assert.equal(who.why, "Do you mean female victims, offenders or arrestees?");
  assert.deepEqual(who.options, [
    { label: "Count female victims", question: "Aggravated assaults in Memphis in 2024 with a female victim" },
    { label: "Count female offenders", question: "Aggravated assaults in Memphis in 2024 with a female offender" },
    { label: "Count arrests of females", question: "Aggravated assaults in Memphis in 2024 with a female arrestee" }]);
  const two = asked(rw("Female simple assault victims with female offenders in Memphis in 2024", "male"));
  assert.deepEqual(two.options.map((o) => o.question), ["Male simple assault victims with female offenders in Memphis in 2024", "Female simple assault victims with male offenders in Memphis in 2024"]);
  assert.equal(q(rw("Female simple assault victims in Memphis in 2024", "male")), "Male simple assault victims in Memphis in 2024");
  assert.equal(asked(rw(P, "hmm that seems off")).why, PLACE_ASK);
  assert.doesNotMatch(PLACE_ASK, /could not be placed|follow-up/);
}

// Jeff's real follow-up (coordinator, 2026-11-01): "show me 2023" after a monthly question is the first period swap most
// people try. Every lead-in, a year, a range of years or a month; relative periods from the previous question's period.
{
  const M = "Carjacking offenses in Memphis by month in 2024";
  for (const f of ["show me 2023", "give me 2023", "how about 2023", "now 2023", "do 2023", "what about 2023", "for 2023", "in 2023", "same for 2023", "the same for 2023", "2023", "show me 2023?"])
    assert.equal(q(rw(M, f)), "Carjacking offenses in Memphis by month in 2023", f);
  assert.equal(q(rw(M, "and 2023")), "Carjacking offenses in Memphis by month in 2023 and 2024", "\"and\" adds, as before");
  assert.equal(q(rw(M, "show me 2021 to 2023")), "Carjacking offenses in Memphis by month from 2021 to 2023");
  assert.equal(q(rw(M, "what about from 2021 through 2023")), "Carjacking offenses in Memphis by month from 2021 to 2023");
  assert.equal(q(rw(M, "show me March 2023")), "Carjacking offenses in Memphis by month in March 2023");
  assert.equal(q(rw("Shoplifting in Memphis in January 2024", "show me March 2023")), "Shoplifting in Memphis in March 2023");
  assert.equal(q(rw("Shoplifting in Memphis by year from 2021 to 2024", "show me 2017 to 2020")), "Shoplifting in Memphis by year from 2017 to 2020");
  // Relative periods, from the previous question's period.
  for (const f of ["what about the year before?", "the previous year", "the prior year", "the year before that"]) assert.equal(q(rw(M, f)), "Carjacking offenses in Memphis by month in 2023", f);
  for (const f of ["the year after", "what about the following year?", "next year"]) assert.equal(q(rw(M, f)), "Carjacking offenses in Memphis by month in 2025", f);
  assert.equal(q(rw("Shoplifting in Memphis by year from 2021 to 2024", "the five years before that")), "Shoplifting in Memphis by year from 2016 to 2020");
  assert.equal(q(rw("Shoplifting in Memphis in 2024", "the three years before that")), "Shoplifting in Memphis from 2021 to 2023");
  // Codex follow-up review 01.2, 01.3: "three years before that" is one year; an offset from a range, or "last year"
  // after a range, is asked about.
  assert.equal(q(rw("Shoplifting in Memphis in 2024", "three years before that")), "Shoplifting in Memphis in 2021");
  // A first question with "vs" between places is places side by side, as "and" (coordinator, 2026-11-01); "2024 vs
  // 2023" stays a period comparison.
  assert.equal(readQuestion("Memphis vs Nashville carjacking offenses in 2024", 2026).ledger.question, readQuestion("Memphis and Nashville carjacking offenses in 2024", 2026).ledger.question);
  assert.equal(readQuestion("Robberies in Memphis versus Nashville in 2023", 2026).ledger.question, readQuestion("Robberies in Memphis and Nashville in 2023", 2026).ledger.question);
  assert.ok(readQuestion("Shoplifting in Memphis in 2024 vs 2023", 2026).comparison);
  assert.deepEqual(asked(rw("Shoplifting in Memphis from 2021 to 2024", "three years before that")).options.map((o) => o.label), ["2018", "2018 to 2020"]);
  const lastAfterRange = rw("Shoplifting in Memphis from 2021 to 2024", "last year");
  assert.equal(asked(lastAfterRange).options.length, 2);
  // Ambiguous: asked, with a button for each reading.
  const before = asked(rw("Shoplifting in Memphis by year from 2021 to 2024", "the year before"));
  assert.deepEqual(before.options.map((o) => o.question), ["Shoplifting in Memphis by year in 2020", "Shoplifting in Memphis by year from 2020 to 2023"]);
  assert.deepEqual(asked(rw(M, "last year")).options.map((o) => o.label), ["2025", "2023"]);
  assert.equal(q(rw(M, "last year", 2024)), "Carjacking offenses in Memphis by month in 2023", "both readings the same year: no question");
  // A previous question with more than one period, or none, is asked about; so is an impossible range.
  asked(rw("Shoplifting in Memphis in 2019 and 2024", "show me 2021 to 2023"));
  asked(rw("Shoplifting in Memphis in 2019 and 2024", "the year before"));
  asked(rw(M, "show me 2023 to 2021"));
  // A complete question for any source stands alone for every caller of the rewriter (coordinator, 2026-11-01).
  assert.equal(R.rewrite("Robberies in Memphis by year from 1990 to 2024", "Robberies in Memphis and Nashville by year from 2015 to 2024").kind, "new");
  // A previous question with no period takes the range (real turns), as a bare year does.
  assert.equal(q(rw("which city had the steepest decline in total violent crime?", "from 2015 to 2024")), "which city had the steepest decline in total violent crime from 2015 to 2024");
}

// Two places side by side replace the previous place, nothing else changes, with no model (coordinator 2026-11-02).
{
  const cj = "Carjackings in Chicago by year since 2022";
  for (const f of ["Chicago vs Memphis", "Chicago versus Memphis", "Chicago and Memphis", "compare Chicago and Memphis", "Chicago vs. Memphis"])
    assert.equal(q(rw(cj, f)), "Carjackings in Chicago and Memphis by year since 2022", f);
  assert.equal(q(rw("Robberies in Memphis in 2024", "Nashville vs Knoxville")), "Robberies in Nashville and Knoxville in 2024");
  asked(rw("Robberies in Memphis and Dallas combined in 2024", "Memphis vs Nashville"));
  // Not two places: left to the other forms.
  assert.equal(q(rw("Robberies in Memphis in 2024", "what about Nashville")), "Robberies in Nashville in 2024");
}

// A full question naming a place the reader doesn't know stands on its own (redesign test, 2026-11-04): answered or
// declined as a new question, never read as a change to the previous one; a bare place or year still follows up.
assert.equal(standsAlone("murders in Zzyzxville in 2024"), true);
assert.equal(standsAlone("How many murders were there in Zzyzxville in 2024?"), true);
assert.equal(standsAlone("now in Nashville"), false);
assert.equal(standsAlone("and in 2023"), false);

// Follow-up cluster B (2026-11-05): the query log's wordings of these follow-ups, each a certain rewrite.
assert.equal(q(rw("Dallas murders by year since 2020", "show me the same for Houston")), "Houston murders by year since 2020");
assert.equal(q(rw("violent crime rates in Philadelphia from 2024 to 2025", "calculate the same for chicago, IL")), "violent crime rates in chicago, IL from 2024 to 2025");
assert.equal(q(rw("Allentown, PA violent crime per year since 1930", "give it to me as a per capita rate")), "Allentown, PA violent crime rate per year since 1930");
assert.equal(q(rw("Baltimore homicides by month in 2025", "Do it per year and not each month")), "Baltimore homicides by year in 2025");
assert.equal(q(rw("murders per capita in St. Louis by year since 2000", "modify so the date range is 1960 through 2024")), "murders per capita in St. Louis by year from 1960 to 2024");
// A state written after its county is that county's, not a second place ("same for" replaces it).
assert.equal(q(rw("Tarrant County, Texas murders in 2024", "same for Dallas County, Texas")), "Dallas County, Texas murders in 2024");
assert.equal(rw("Houston and Austin murders in 2024", "same for Dallas").kind, "ask");
// A bare range after a "since" period is still asked about (replace or add).
assert.equal(rw("murders per capita in St. Louis by year since 2000", "1990 to 2000").kind, "ask");

console.log("nibrs follow-up: rewrites are standalone and certain, the rest is asked; the rewriter is replaceable");
