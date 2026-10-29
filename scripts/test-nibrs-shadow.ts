/**
 * The shadow slice (lib/nibrs-shadow) takes a question to an answer, a clarifying question or a decline as the decided
 * policy says, and its scoring (lib/answer-eval/shadow.ts) judges those outcomes. Offline: the DuckDB step is a stub
 * that returns rows shaped like the compiled query's, so this checks the pipeline and the delivered answer, never the
 * numbers (scripts/nibrs-compile-gate.ts and the runner do that against a canonical build). No database, no model.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex, resolveCity } from "../lib/nibrs-shadow/places";
import { periodWords } from "../lib/nibrs-shadow/deliver";
import { scoreShadow } from "../lib/answer-eval/shadow";
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

// Places (P16, D28): a city is its principal police agency; a name two states use for large cities is asked about.
const at = (v: string, text: string) => resolveCity(places, v, text);
assert.equal((at("city:Memphis:TN", "Memphis") as { agency: { ori: string } }).agency.ori, "TNMPD0000");
assert.equal((at("ambiguous:Baltimore", "Baltimore") as { agency: { ori: string } }).agency.ori, "MDBPD0000");
assert.equal((at("ambiguous:St Louis", "St Louis") as { agency: { ori: string } }).agency.ori, "MOSPD0000");
assert.equal((at("city:Portland:OR", "Portland") as { agency: { state: string } }).agency.state, "OR", "Portland, Maine is under 100,000");
assert.deepEqual((at("ambiguous:Kansas City", "Kansas City") as { candidates: { state: string }[] }).candidates.map((a) => a.state), ["MO", "KS"]);
assert.deepEqual((at("city:Columbus:OH", "Columbus") as { candidates: { state: string }[] }).candidates.map((a) => a.state), ["OH", "GA"], "the reader's filled-in state is not the question's");
assert.equal((at("city:Columbus:OH", "Columbus, Ohio") as { agency: { ori: string } }).agency.ori, "OHCOP0000");
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
assert.ok(m.delivered.text.includes("No data for March 2024: the agency reported nothing for that month. Shown blank, not zero."));
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
assert.deepEqual(noPeriod.options.map((o) => o.label), ["The latest complete year", "This year so far", "Another year"]);
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

// Declines: what the data does not record is declined before anything is asked; after the data, P24; before this build,
// not built; drug crimes (D19) are not one measure.
assert.equal(as(ask("crime by ZIP code in Chicago"), "decline").reason, "below_agency_level");
const future = as(ask("Shoplifting in Memphis in 2027"), "decline");
assert.equal(future.explanation, "2027 is not in the data; the latest month available is October 2026.");
assert.deepEqual(as(future.alternative!.continuation!, "answer").period, { from: "2026-01", to: "2026-10" });
assert.equal(as(ask("Shoplifting in Memphis in 2012"), "decline").notBuilt, true);
assert.match(as(ask("Drug crimes in Detroit in 2024"), "decline").explanation, /D19/);

assert.equal(periodWords("2021-01", "2025-12"), "2021 to 2025");
assert.equal(periodWords("2021-03", "2025-06"), "March 2021 through June 2025");

// Scoring: a matching answer is unverified until independent values are given, then correct; a wrong value is a wrong
// answer; a not-built refusal is never scored.
const r = { firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-10-29" };
const ctx = { capability: "answer:nibrs count", era: "2021 and later" };
const label = (expected: Case["expected"]): Case => ({ id: "LS-999", group: "designed:slice-test", split: "dev", origin: { kind: "designed", ref: null }, tab: "nibrs", setup: [], question: "q", policy: [], expected, label: { status: "reviewed", drafted_by: "a", reviewed_by: "b", notes: "" } });
const shop: Case["expected"] = { action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2023-01", to: "2023-12" }, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" }, statements: ["names the agency (Memphis Police Department)", "names its source at the end"] };
assert.equal(scoreShadow(label(shop), a, r, ctx).result!.outcome, "unverified");
assert.equal(scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 84 }]]])).result!.outcome, "correct");
const wrong = scoreShadow(label(shop), a, r, ctx, new Map([["LS-999", [{ key: "", value: 85 }]]])).result!;
assert.deepEqual([wrong.outcome, wrong.values], ["wrong_answer", "mismatch"]);
assert.equal(scoreShadow(label(shop), as(ask("Shoplifting in Memphis in 2012"), "decline"), r, ctx).result, null);
const zip = scoreShadow(label({ action: "decline", reason: "The data stops at the agency level; no source here has counts by ZIP code.", alternative: null }), as(ask("crime by ZIP code in Chicago"), "decline"), r, ctx).result!;
assert.equal(zip.outcome, "correct");
const court = scoreShadow(label({ action: "decline", reason: "Court outcomes such as convictions are not in the data.", alternative: null }), future, r, ctx).result!;
assert.equal(court.outcome, "incomplete", "a decline with the wrong reason is not correct");

console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
