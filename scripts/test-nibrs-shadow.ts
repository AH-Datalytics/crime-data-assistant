/**
 * The shadow slice (lib/nibrs-shadow) takes a question to an answer, a clarifying question or a decline as the decided
 * policy says, and its scoring (lib/answer-eval/shadow.ts) judges those outcomes. Offline: the DuckDB step is a stub
 * that returns rows shaped like the compiled query's, so this checks the pipeline and the delivered answer, never the
 * numbers (scripts/nibrs-compile-gate.ts and the runner do that against a canonical build). No database, no model.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { candidateLabel, loadPlaceIndex, resolvePlace } from "../lib/nibrs-shadow/places";
import { periodWords } from "../lib/nibrs-shadow/deliver";
import { scoreShadow } from "../lib/answer-eval/shadow";
import { gates } from "../lib/answer-eval/gates";
import type { Case } from "../lib/answer-eval/case";

const places = loadPlaceIndex();
const sqls: string[] = [];
/** Rows for the compiled query: every month (or year) of the period, 7 each, March 2024 unknown. */
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const months: string[] = [];
  for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const cell = (k: string): [number | null, string] => (k === "2024-03" ? [null, "UNKNOWN"] : [7, "VALUE"]);
  if (/AS period/.test(sql) && /substr\(ym, 1, 4\) AS period/.test(sql)) {
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    return years.map((y) => (months.some((m) => m.startsWith(y) && cell(m)[0] === null) ? [y, null, "UNKNOWN"] : [y, 7 * months.filter((m) => m.startsWith(y)).length, "VALUE"]));
  }
  if (/AS period/.test(sql)) return months.map((m) => [m, ...cell(m)]);
  return months.some((m) => cell(m)[0] === null) ? [[null, "UNKNOWN"]] : [[7 * months.length, "VALUE"]];
}
const deps: ShadowDeps = {
  places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute: stub,
};
const ask = (q: string) => shadowAnswer(q, deps);
const as = <K extends ShadowOutcome["kind"]>(o: ShadowOutcome, k: K) => { assert.equal(o.kind, k, JSON.stringify(o).slice(0, 300)); return o as Extract<ShadowOutcome, { kind: K }>; };

// Places (P16, P28): a city is its principal police agency; a name with several real candidates of 100,000+ residents
// (cities in two states, a city and a county, a state) is asked about, cities first.
const at = (v: string, text: string) => resolvePlace(places, v, text);
const ori = (r: ReturnType<typeof at>) => (r.kind === "agency" ? r.agency.ori : r.kind);
const asked = (r: ReturnType<typeof at>) => (r.kind === "ask" ? r.candidates.map((c) => candidateLabel(c, r.candidates)) : r.kind);
assert.equal(ori(at("city:Memphis:TN", "Memphis")), "TNMPD0000");
assert.deepEqual(asked(at("ambiguous:Baltimore", "Baltimore")), ["Baltimore city, Maryland", "Baltimore County, Maryland"]);
assert.deepEqual(asked(at("ambiguous:St Louis", "St Louis")), ["St. Louis city, Missouri", "St. Louis County, Missouri"], "St. Louis County, Minnesota is under 100,000");
assert.deepEqual(asked(at("ambiguous:Washington", "Washington")), ["Washington, D.C.", "Washington state", "Washington County, Oregon", "Washington County, Maryland"]);
assert.deepEqual(asked(at("ambiguous:Kansas City", "Kansas City")), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(asked(at("city:Columbus:OH", "Columbus")), ["Columbus, Ohio", "Columbus, Georgia"], "the reader's filled-in state is not the question's");
assert.equal(ori(at("city:Columbus:OH", "Columbus, Ohio")), "OHCOP0000");
assert.equal(ori(at("city:Washington:DC", "Washington DC")), "DCMPD0000");
assert.equal(ori(at("county:Baltimore County:MD", "Baltimore County")), "MD0030100");
assert.equal(ori(at("city:Portland:OR", "Portland")), "OR0260200", "Portland, Maine is under 100,000");
assert.equal(at("city:Nowhere:TX", "Nowhere").kind, "unresolved");

// An answer: the plan, the compiled read, the delivered table and text (source statement last, D30).
const a = as(ask("How many shoplifting offenses were there in Memphis in 2023?"), "answer");
assert.deepEqual(a.period, { from: "2023-01", to: "2023-12" });
assert.equal(a.plan.measures[0].id, "offenses.shoplifting");
assert.ok(sqls.at(-1)!.includes("'TNMPD0000'") && sqls.at(-1)!.includes("'23C'"));
assert.deepEqual(a.delivered.table.rows, [[84]]);
assert.equal(a.delivered.text[0], "Memphis city police, TN: 84 shoplifting offenses in 2023.");
assert.match(a.delivered.text.at(-1)!, /^Source: FBI National Incident-Based Reporting System \(NIBRS\)/);
assert.deepEqual(a.delivered.contractProblems, []);
assert.equal(a.delivered.chart, null);

// A monthly series with an unknown month: blank, named as missing (D04), never zero.
const m = as(ask("Shoplifting in Memphis by month in 2024"), "answer");
assert.equal(m.delivered.table.rows.length, 12);
assert.deepEqual(m.delivered.table.rows[2], ["2024-03", null]);
assert.ok(m.delivered.text.includes("No report is known for March 2024: shown blank, not zero."));
assert.deepEqual(m.delivered.chart, { kind: "line", x: "Month", y: ["Shoplifting offenses"] });
assert.deepEqual(m.delivered.contractProblems, []);

// P11: victims of a property crime are offenses, with the fixed sentence before the source.
const v = as(ask("How many shoplifting victims were there in Memphis in 2024?"), "answer");
assert.equal(v.plan.measures[0].unit, "offense");
assert.equal(v.delivered.text.at(-2), "Property crimes are counted by offense, not by victim.");
// Person crimes stay by victim (D18); carjacking is counted by offense (D18).
assert.equal(as(ask("How many simple assaults were there in Detroit in 2023?"), "answer").plan.measures[0].id, "victims.simple_assault");
const cj = as(ask("carjackings in Memphis TN by month in 2025"), "answer");
assert.deepEqual([cj.plan.measures[0].id, cj.plan.measures[0].unit], ["offenses.carjacking", "offense"]);

// D31: a missing place, period or crime is asked about; each fixed option runs the question with that choice filled in.
const noPlace = as(ask("How many shoplifting offenses were there in 2024?"), "clarify");
assert.deepEqual(noPlace.options.map((o) => o.label), ["The United States", "A state", "A city or agency"]);
assert.match(as(noPlace.options[0].continuation!, "decline").explanation, /^Not in the slice yet: state and national/);
assert.equal(noPlace.options[1].entry, "which state");
const noPeriod = as(ask("Shoplifting in Memphis"), "clarify");
assert.deepEqual(noPeriod.options.map((o) => o.label), ["The latest complete year (2025)", "This year so far", "Another year"]);
assert.deepEqual(as(noPeriod.options[0].continuation!, "answer").period, { from: "2025-01", to: "2025-12" });
const ytd = as(noPeriod.options[1].continuation!, "answer");
assert.deepEqual(ytd.period, { from: "2026-01", to: "2026-10" });
assert.ok(ytd.delivered.text.includes("The data runs through October 2026: this covers January through October 2026."), "D06: the months covered are named");
const trend = as(ask("Carjackings in Memphis by month"), "clarify");
assert.deepEqual(trend.options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);
assert.equal(as(trend.options[0].continuation!, "decline").notBuilt, true, "2016 is before this build");
assert.deepEqual(as(trend.options[1].continuation!, "answer").period, { from: "2017-01", to: "2026-10" });
assert.deepEqual(as(ask("How many crimes were there in Detroit in 2024?"), "clarify").options.map((o) => o.otherSource), ["historical", "historical", "historical"]);
const kc = as(ask("Shoplifting in Kansas City in 2024"), "clarify");
assert.deepEqual(kc.options.map((o) => o.label), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(kc.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MOKPD0000", label: "Kansas City city police, MO" }, { kind: "agency", ori: "KS1050200", label: "Kansas City city police, KS" }]);
// A city and a county of one name: a button each, and a choice is not asked again in a later question (P22).
const balt = as(ask("Shoplifting in Baltimore by month from 2022 to 2025"), "clarify");
assert.deepEqual(balt.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MDBPD0000", label: "Baltimore city police, MD" }, { kind: "agency", ori: "MD0030100", label: "Baltimore County agency, MD" }]);
const stl = as(ask("St Louis carjackings per month"), "clarify");
assert.equal(stl.about, "which St. Louis");
const stlCity = as(stl.options[0].continuation!, "clarify");
assert.equal(stlCity.about, "which range of years", "the place is chosen; the period is asked next");
assert.equal(as(stlCity.options[1].continuation!, "answer").plan.geography.places[0].kind === "agency" && (as(stlCity.options[1].continuation!, "answer").plan.geography.places[0] as { ori: string }).ori, "MOSPD0000");
const wa = as(ask("Shoplifting in Washington in 2024"), "clarify");
assert.match(as(wa.options[1].continuation!, "decline").explanation, /^Not in the slice yet: state and national/);

// Declines: what the data does not record is declined before anything is asked; after the data, P24; before this build,
// not built; drug crimes (D19) are not one measure.
assert.equal(as(ask("crime by ZIP code in Chicago"), "decline").reason, "below_agency_level");
const future = as(ask("Shoplifting in Memphis in 2027"), "decline");
assert.equal(future.explanation, "2027 is not in the data; the latest month available is October 2026.");
assert.deepEqual(as(future.alternative!.continuation!, "answer").period, { from: "2026-01", to: "2026-10" });
assert.equal(as(ask("Shoplifting in Memphis in 2012"), "decline").notBuilt, true);
assert.match(as(ask("Drug crimes in Detroit in 2024"), "decline").explanation, /D19/);
// No question is asked when every choice ends in a refusal (D28): "Shplftg" is near no crime word, so nothing reads it.
assert.equal(as(ask("Shplftg in baltimore per month, 2021-2025"), "decline").reason, "reader");

// Codex review 1: what the slice cannot deliver is declined before anything runs or is asked; P11 covers carjacking;
// a future month is named as asked; P26 asks city or state for "New York".
assert.match(as(ask("Simple assault victims in Detroit by sex in 2023"), "decline").explanation, /^Not in the slice yet: breakdowns/);
assert.equal(as(ask("Shoplifting in Kansas City by ZIP code in 2024"), "decline").reason, "below_agency_level");
const cjv = as(ask("How many carjacking victims were there in Memphis in 2024?"), "answer");
assert.deepEqual([cjv.plan.measures[0].id, cjv.delivered.answerStatements], ["offenses.carjacking", ["property_counted_by_offense"]]);
assert.equal(as(ask("Shoplifting in Memphis in November 2026"), "decline").explanation, "November 2026 is not in the data; the latest month available is October 2026.");
assert.deepEqual(as(ask("Shoplifting in New York in 2024"), "clarify").options.map((o) => o.label), ["New York City", "New York state"]);
assert.deepEqual(as(ask("Shoplifting in Memphis by month"), "clarify").options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);

assert.equal(periodWords("2021-01", "2025-12"), "2021 to 2025");
assert.equal(periodWords("2021-03", "2025-06"), "March 2021 through June 2025");

// Scoring: a matching answer is unverified until independent values are given, then correct; a wrong value is a wrong
// answer; a not-built refusal is never scored.
const r = { firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-10-29" };
const ctx = { capability: "answer:nibrs count", era: "2021 and later" };
const label = (expected: Case["expected"]): Case => ({ id: "LS-999", group: "designed:slice-test", split: "dev", origin: { kind: "designed", ref: null }, tab: "nibrs", setup: [], question: "q", policy: [], expected, label: { status: "reviewed", drafted_by: "a", reviewed_by: "b", notes: "" } });
const shop: Case["expected"] = { action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2023-01", to: "2023-12" }, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" }, statements: ["names the agency (Memphis Police Department)", "names its source at the end"] };
assert.equal(scoreShadow(label(shop), a, r, ctx).result!.outcome, "unverified");
assert.equal(scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 84, status: "VALUE" }]]])).result!.outcome, "correct");
const wrong = scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 85, status: "VALUE" }]]])).result!;
assert.deepEqual([wrong.outcome, wrong.values], ["wrong_answer", "mismatch"]);
assert.equal(scoreShadow(label(shop), as(ask("Shoplifting in Memphis in 2012"), "decline"), r, ctx).result, null);
const zip = scoreShadow(label({ action: "decline", reason: "The data stops at the agency level; no source here has counts by ZIP code.", alternative: null }), as(ask("crime by ZIP code in Chicago"), "decline"), r, ctx).result!;
assert.equal(zip.outcome, "correct");
const court = scoreShadow(label({ action: "decline", reason: "Court outcomes such as convictions are not in the data.", alternative: null }), future, r, ctx).result!;
assert.equal(court.outcome, "incomplete", "a decline with the wrong reason is not correct");

// Continuations are scored like direct answers: a button's delivered number is checked against its own expected cells,
// a wrong one is a wrong answer, none given leaves it unverified; an entry must ask the part the label names.
const periodLabel = (opts: { label: string; leads_to: "answer" | "clarify"; meaning: Case["expected"] extends infer E ? (E extends { action: "answer"; meaning: infer M } ? M : never) : never | null; next_about?: string }[]): Case["expected"] => ({ action: "clarify", about: "which period", options: opts as never });
const shopIn = (period: { from: string; to: string }) => ({ ...(shop as { meaning: object }).meaning, period }) as never;
const np = periodLabel([
  { label: "The latest complete year (2025)", leads_to: "answer", meaning: shopIn({ from: "2025-01", to: "2025-12" }) },
  { label: "This year so far", leads_to: "answer", meaning: shopIn({ from: "2026-01", to: "2026-10" }) },
  { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which year" }]);
const score = (vals?: Map<string, { key: string; value: number | null; status: string }[]>) => scoreShadow(label(np), noPeriod, r, ctx, vals).result!;
assert.deepEqual([score().outcome, score().values], ["unverified", "not measured"]);
const both = (a1: number) => new Map([["LS-999|The latest complete year (2025)", [{ key: "", value: a1, status: "VALUE" }]], ["LS-999|This year so far", [{ key: "", value: 70, status: "VALUE" }]]]);
assert.deepEqual([score(both(84)).outcome, score(both(84)).values], ["correct", "match"]);
assert.deepEqual([score(both(83)).outcome, score(both(83)).values], ["wrong_answer", "mismatch"]);
const wrongEntry = periodLabel([...(np as unknown as { options: never[] }).options.slice(0, 2), { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which range of years" }]);
assert.equal(scoreShadow(label(wrongEntry), noPeriod, r, ctx, both(84)).result!.outcome, "incomplete");

// Codex review 2: no button answers "Shoplifting arrests in Washington" (arrests and state totals are not in the slice),
// so it declines rather than asks; a different question behind a button is a wrong answer; its text is checked; an
// answer behind a button with no values leaves the zero-wrong-answers gate NOT MEASURED.
assert.equal(ask("Shoplifting arrests in Washington in 2024").kind, "decline");
const detroitInstead = periodLabel([
  { label: "The latest complete year (2025)", leads_to: "answer", meaning: { ...(shopIn({ from: "2025-01", to: "2025-12" }) as object), places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }] } as never },
  ...(np as unknown as { options: never[] }).options.slice(1)]);
assert.equal(scoreShadow(label(detroitInstead), noPeriod, r, ctx, both(84)).result!.outcome, "wrong_answer");
const mute = { ...noPeriod, options: noPeriod.options.map((o, i) => (i ? o : { ...o, continuation: { ...(o.continuation as object), delivered: { ...(o.continuation as { delivered: object }).delivered, text: ["84."] } } as never })) };
assert.equal(scoreShadow(label(np), mute, r, ctx, both(84)).result!.outcome, "incomplete", "a button's answer must still name its agency and source");
const unv = scoreShadow(label(np), noPeriod, r, ctx).result!;
assert.equal(gates([unv])[0].categories.find((x) => x.name === "wrong answers")!.status, "not measured");
// Answers behind a second question are found and checked by their path of buttons.
const stlCase = label({ action: "clarify", about: "which St. Louis", options: [
  { label: "St. Louis city, Missouri", leads_to: "clarify", meaning: null, next_about: "which range of years" },
  { label: "St. Louis County, Missouri", leads_to: "clarify", meaning: null, next_about: "which range of years" }] });
const deep = (v: number) => new Map([["LS-999|St. Louis city, Missouri|Every year available", Array.from({ length: 118 }, (_, i) => {
  const m = `${2017 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`; return { key: m, value: m === "2024-03" ? null : v, status: m === "2024-03" ? "UNKNOWN" : "VALUE" }; })]]);
assert.equal(scoreShadow(stlCase, stl, r, ctx, deep(7)).result!.values, "not measured", "the county's answers have no values");
assert.equal(scoreShadow(stlCase, stl, r, ctx, deep(6)).result!.outcome, "wrong_answer");

// Codex review 3: every delivered answer is checked, expected by the label or not, and fixed sentences are checked on
// button answers (P11 behind a period button).
const zipLabel = label({ action: "decline", reason: "The data stops at the agency level; no source here has counts by ZIP code.", alternative: null });
const zipWithAlt = { ...as(ask("crime by ZIP code in Chicago"), "decline"), alternative: { label: "this year", continuation: a } };
const zipScore = scoreShadow(zipLabel, zipWithAlt, r, ctx).result!;
assert.equal(zipScore.outcome, "unverified");
assert.equal(gates([zipScore])[0].categories.find((x) => x.name === "wrong answers")!.status, "not measured");
const victimsNoPeriod = as(ask("Shoplifting victims in Memphis"), "clarify");
const latest = as(victimsNoPeriod.options[0].continuation!, "answer");
assert.equal(latest.delivered.text.at(-2), "Property crimes are counted by offense, not by victim.");
const stripped = { ...victimsNoPeriod, options: victimsNoPeriod.options.map((o, i) => (i ? o : { ...o, continuation: { ...latest, delivered: { ...latest.delivered, text: latest.delivered.text.filter((t) => !/^Property crimes/.test(t)) } } })) };
const vLabel: Case = { ...label(np), question: "Shoplifting victims in Memphis" };
assert.equal(scoreShadow(vLabel, victimsNoPeriod, r, ctx, both(84)).result!.outcome, "correct");
assert.equal(scoreShadow(vLabel, stripped, r, ctx, both(84)).result!.outcome, "incomplete");

// The reading pre-pass (reader round): forecasts and court outcomes decline with their alternatives (P20, D01); a
// corrected spelling is disclosed before the source; Part I counts are left to Historical and Current Trends (P01).
const fc = as(ask("Will shoplifting go up in Memphis next year?"), "decline");
assert.deepEqual([fc.reason, fc.alternative!.label], ["forecast", "The last 10 complete years, by year"]);
assert.equal(as(fc.alternative!.continuation!, "decline").notBuilt, true, "2016 is before this build");
// A forecast verb the reader reads as a change ("increase") is dropped from the alternative too.
assert.equal(as(as(ask("Will carjackings increase in Memphis in 2027?"), "decline").alternative!.continuation!, "decline").notBuilt, true);
const ct = as(ask("How many shoplifting arrests in Memphis in 2024 led to convictions?"), "decline");
assert.deepEqual([ct.reason, ct.alternative!.label], ["court_outcome", "Arrests for the same crime, place and period"]);
const typo = as(ask("Shoplfting in Memphis in 2023"), "answer");
assert.equal(typo.delivered.text.at(-2), 'Read "Shoplfting" as shoplifting.');
assert.match(as(ask("Burglaries in Memphis in 2023"), "decline").explanation, /P01/);

console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
