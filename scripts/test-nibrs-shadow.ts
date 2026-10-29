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
import { scoreShadow, sliceValues } from "../lib/answer-eval/shadow";
import { gates } from "../lib/answer-eval/gates";
import type { Case } from "../lib/answer-eval/case";

const places = loadPlaceIndex();
const sqls: string[] = [];
/** Rows for the compiled query: every month (or year) of the period, 7 each, March 2024 unknown. */
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  // A one-category breakdown over a period: F 30 (share 0.6), M 20 (0.4), U unknown.
  if (/cats AS/.test(sql) && !/AS period/.test(sql)) return [["F", 30, "VALUE", 0.6, "VALUE"], ["M", 20, "VALUE", 0.4, "VALUE"], ["U", null, "UNKNOWN", null, "UNKNOWN"]];
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
// D19: drug crimes are both drug measures, side by side, with their combined total (both known: 84 + 84).
const drugs = as(ask("Drug crimes in Detroit in 2023"), "answer");
assert.deepEqual(drugs.plan.measures.map((m) => m.id), ["offenses.drug_possession", "offenses.drug_equipment"]);
assert.deepEqual(drugs.delivered.table.columns.map((c) => c.header), ["Drug/narcotic violation offenses", "Drug equipment violation offenses"]);
assert.deepEqual(drugs.delivered.table.rows, [[84, 84]]);
assert.deepEqual(drugs.delivered.text.slice(0, 3), ["Drug crimes are drug/narcotic violations plus drug equipment violations.",
  "Detroit city police, MI, 2023: 84 drug/narcotic violation offenses; 84 drug equipment violation offenses.", "Together: 168 drug crimes in 2023."]);
assert.deepEqual(drugs.delivered.contractProblems, []);
assert.equal(as(ask("Drug possession in Detroit in 2023"), "answer").plan.measures.length, 1, "drug possession itself is one measure");
// A combined total is given only when every part is known (March 2024 is unknown in the stub).
const drugsMonth = as(ask("Drug crimes in Detroit in 2024"), "answer");
assert.ok(drugsMonth.delivered.text.includes("No combined total of drug crimes is given: the available evidence does not establish every part."));
assert.ok(!drugsMonth.delivered.text.some((t) => /^Together/.test(t)));
// No question is asked when every choice ends in a refusal (D28): "Shplftg" is near no crime word, so nothing reads it.
assert.equal(as(ask("Shplftg in baltimore per month, 2021-2025"), "decline").reason, "reader");

// Codex review 1: what the slice cannot deliver is declined before anything runs or is asked; P11 covers carjacking;
// a future month is named as asked; P26 asks city or state for "New York".
// Compiler increment 2: age groups (P30), named with what each holds.
const byAge = as(ask("Simple assault victims in Detroit by age in 2023"), "answer");
assert.equal(byAge.plan.groupings[0].dimension, "victim.age");
assert.match(byAge.delivered.text.find((t) => /^Age groups: /.test(t))!, /^Age groups: Under 18 \(ages 1-17 and infants under one year\), 18-24, .*65\+ \(65 and over\); Unknown is an age recorded as unknown, and Not recorded is no age recorded\.$/);
assert.ok(sqls.at(-1)!.includes("WHEN v.age IN ('NN', 'NB', 'BB') THEN 'Under 18'"));
// Compiler increment 1: one delivered category, with counts, each category's share of its period, and blanks named.
const bySex = as(ask("Simple assault victims in Detroit by sex in 2023"), "answer");
assert.deepEqual(bySex.delivered.table.columns.map((c) => c.header), ["Victim sex", "Simple assault victims", "Share of all simple assault victims (%)"]);
assert.deepEqual(bySex.delivered.table.rows, [["Female", 30, 60], ["Male", 20, 40], ["Unknown", null, null]]);
assert.ok(bySex.delivered.text.includes("Each share is that category's part of all simple assault victims in 2023."));
assert.match(bySex.delivered.text.find((t) => /^No total is established/.test(t))!, /Unknown/);
assert.deepEqual([bySex.delivered.contractProblems, bySex.delivered.chart], [[], null]);
assert.equal(ask("Simple assault victims in Detroit by race and sex in 2023").kind === "answer", false, "two-way breakdowns are not built");
// Weapons: multi-valued, with the overlap sentence; carjacking by offense has one location (not multi-valued, D18).
const byWeapon = as(ask("Robberies in Detroit by weapon in 2023"), "answer");
assert.deepEqual([byWeapon.plan.groupings[0].multiValue, byWeapon.delivered.answerStatements], ["each_value", ["categories_overlap"]]);
const cjLoc = as(ask("Carjackings in Detroit by location type in 2023"), "answer");
assert.deepEqual([cjLoc.plan.measures[0].id, cjLoc.plan.groupings[0].multiValue], ["offenses.carjacking", undefined]);
// P29/P49: "by men and women" -> the crimes by their offenders' sexes; one sex alone is still declined; "against" is victims.
const bySexes = as(ask("Simple assaults by men and women in Detroit in 2023"), "answer");
assert.deepEqual([bySexes.plan.filters, bySexes.plan.groupings.map((g) => `${g.dimension}:${g.multiValue}`)], [[], ["offender.sex:each_value"]]);
assert.deepEqual(bySexes.delivered.table.rows.map((r) => r[0]), ["Female", "Male", "Unknown"]);
assert.ok(sqls.at(-1)!.includes("'unknown_offender'"));
assert.match(as(ask("Simple assaults by women in Detroit in 2023"), "decline").explanation, /P29/);
// P44: offenders themselves, by their own sex.
assert.equal(as(ask("Robbery offenders in Detroit by sex in 2023"), "answer").plan.groupings[0].multiValue, undefined);
// P36: murders by strangers say so in their words.
assert.match(as(ask("Murders by strangers in Detroit in 2023"), "answer").delivered.text[0], /murder victims by a stranger in 2023/);
// P31: gun crime and stabbings, each crime in its unit with the weapon, and the total; gun violence and shooters declined.
const gun = as(ask("Gun crime in Detroit in 2023"), "answer");
assert.deepEqual(gun.plan.measures.map((m) => `${m.id}:${(m.filters?.[0] as { scope: string }).scope}`), ["victims.murder:victim", "offenses.robbery:offense", "victims.aggravated_assault:victim"]);
assert.deepEqual(gun.delivered.table.columns.map((c) => c.header), ["Murder victims with a firearm", "Robbery offenses with a firearm", "Aggravated assault victims with a firearm"]);
assert.ok(gun.delivered.text.includes("Together: 252 gun crimes in 2023."));
assert.ok(sqls.slice(-3).every((q) => q.includes("w2.weapon IN ('11', '12', '13', '14', '15')")));
const stab = as(ask("Stabbings in Detroit in 2023"), "answer");
assert.deepEqual([stab.plan.measures.length, stab.delivered.text[0]], [2, "Stabbings here are murder victims and aggravated assault victims with a knife or cutting instrument."]);
assert.match(as(ask("Gun violence in Detroit in 2023"), "decline").explanation, /non-fatal shootings/);
assert.match(as(ask("How many shooters were there in Detroit in 2023?"), "decline").explanation, /^"Shooters" is not a term/);
// P46, P48, P50: arrests by arrest date, counted once each; "people arrested for" is arrests; "charged" is declined with
// the arrests offered.
const arr = as(ask("How many people were arrested for burglary in Detroit in 2023?"), "answer");
assert.deepEqual([arr.plan.measures[0].id, arr.plan.timeBasis, arr.delivered.answerStatements], ["arrests.burglary", "arrest_date", ["arrests_counted_once"]]);
assert.ok(sqls.at(-1)!.includes("substr(a.arrest_date, 1, 6) AS ym"));
const charged = as(ask("How many robbery suspects were charged in Detroit in 2023?"), "decline");
assert.deepEqual([charged.reason, as(charged.alternative!.continuation!, "answer").plan.measures[0].id], ["court_outcome", "arrests.robbery"]);
// Several measures by month: a column each, and the months a crime is blank named.
const two = as(ask("Carjackings and shoplifting in Detroit by month in 2024"), "answer");
assert.deepEqual(two.delivered.table.columns.map((c) => c.header), ["Month", "Carjacking offenses", "Shoplifting offenses"]);
assert.deepEqual(two.delivered.table.rows[2], ["2024-03", null, null]);
assert.deepEqual(two.delivered.chart, { kind: "line", x: "Month", y: ["Carjacking offenses", "Shoplifting offenses"] });
assert.equal(as(ask("Simple assaults against men and women in Detroit in 2023"), "answer").plan.groupings[0].dimension, "victim.sex");
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
// (Increment 2: arrests are built, so the city button answers and the state button declines.)
const waArrests = as(ask("Shoplifting arrests in Washington in 2024"), "clarify");
assert.deepEqual([waArrests.options[0].continuation?.kind, waArrests.options.find((o) => / state$/.test(o.label))?.continuation?.kind], ["answer", "decline"]);
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
// Codex review 2: with the years present, the forecast's alternative reaches an annual answer (its two filled parts no
// longer share a binding); a real word is never corrected into a crime; P01 leaves a crime's details to NIBRS's limits.
const deeper: ShadowDeps = { ...deps, release: { ...deps.release, firstMonth: "2016-01" }, target: { ...deps.target, builtYears: [2016, ...deps.target.builtYears] } };
const fcAlt = as(as(shadowAnswer("Will shoplifting rise in Memphis next year?", deeper), "decline").alternative!.continuation!, "answer");
assert.deepEqual([fcAlt.period, fcAlt.plan.groupings.map((g) => g.dimension)], [{ from: "2016-01", to: "2025-12" }, ["time.year"]]);
assert.equal(as(shadowAnswer("Will shoplifting near schools rise in Memphis next year?", deeper), "decline").alternative!.continuation!.kind, "decline", "an unread qualifier stays, so the narrower alternative declines");
assert.notEqual(ask("Sample assaults in Memphis in 2023").kind, "answer");
// A Part I crime's details are NIBRS's (P01 is a plain count only): answered since increment 2.
for (const q of ["Robberies with a firearm in Memphis in 2023", "Robbery arrests in Memphis in 2023"]) as(ask(q), "answer");
assert.equal(as(ask("Shoplifting in Memphis next year"), "decline").reason, "outside_release_coverage", "P24, not a forecast");
assert.equal(as(ask("Predicting shoplifting in Memphis in 2027"), "decline").reason, "forecast");
const ct = as(ask("How many shoplifting arrests in Memphis in 2024 led to convictions?"), "decline");
assert.deepEqual([ct.reason, ct.alternative!.label], ["court_outcome", "Arrests for the same crime, place and period"]);
const typo = as(ask("Shoplfting in Memphis in 2023"), "answer");
assert.equal(typo.delivered.text.at(-2), 'Read "Shoplfting" as shoplifting.');
assert.match(as(ask("Burglaries in Memphis in 2023"), "decline").explanation, /P01/);

// Breakdown scoring: rows keyed by category name, counts and statuses compared, shares checked against the independent
// count over the independent total; nibrs-model's category rows load under those keys.
const sexLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "simple assault", unit: "victim" }], filters: [], groupings: ["victim sex"], statistic: "count" }, values: { status: "pending_build" }, statements: ["names its source at the end"] });
const sexCells = (male: number) => new Map([["LS-999", [{ key: "Female", value: 30, status: "VALUE", share: 60 }, { key: "Male", value: male, status: "VALUE", share: 40 }, { key: "Unknown", value: null, status: "UNKNOWN", share: null }]]]);
assert.equal(scoreShadow(sexLabel, bySex, r, ctx, sexCells(20)).result!.outcome, "correct");
assert.equal(scoreShadow(sexLabel, bySex, r, ctx, sexCells(21)).result!.outcome, "wrong_answer");
assert.equal(scoreShadow(sexLabel, bySex, r, ctx).result!.outcome, "unverified", "no values: not measured");
const loaded = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total", measures: { sa: "13B" }, totals: { sa: { status: "VALUE", value: 50 } },
  rows: [{ sex: "F", sa: { status: "VALUE", value: 30 } }, { sex: "M", sa: { status: "VALUE", value: 20 } }, { sex: "U", sa: { status: "UNKNOWN", value: null } }] }) }]);
assert.deepEqual(loaded.get("LS-999"), sexCells(20).get("LS-999"));
// Codex increment-1 review: a repeated category row, or a missing share column, never scores correct; a share within a
// year is checked against that year's own independent total, and with none it is unverified, not an expected blank.
const dup = { ...bySex, delivered: { ...bySex.delivered, table: { ...bySex.delivered.table, rows: [["Male", 999, 99], ...bySex.delivered.table.rows] },
  evidence: [{ row: 0, statistic: bySex.plan.statistics[0].as, status: "VALUE" as const }, ...bySex.delivered.evidence.map((e) => ({ ...e, row: e.row + 1 }))] } };
assert.equal(scoreShadow(sexLabel, dup, r, ctx, sexCells(20)).result!.outcome, "wrong_answer");
const countOnly = { ...bySex, delivered: { ...bySex.delivered, table: { columns: bySex.delivered.table.columns.slice(0, 2), rows: bySex.delivered.table.rows.map((x) => x.slice(0, 2)) } } };
assert.notEqual(scoreShadow(sexLabel, countOnly, r, ctx, sexCells(20)).result!.outcome, "correct");
const yearly = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-998", grouping: "year", measures: { sa: "13B" }, totals: { sa: { status: "UNKNOWN", value: null } },
  rows: [{ year: "2021", sex: "F", sa: { status: "VALUE", value: 3 } }, { year: "2021", sex: "M", sa: { status: "VALUE", value: 1 } },
    { year: "2022", sex: "F", sa: { status: "VALUE", value: 5 } }, { year: "2022", sex: "M", sa: { status: "UNKNOWN", value: null } }] }) }]).get("LS-998")!;
assert.deepEqual(yearly.map((x) => [x.key, x.share]), [["2021|Female", 75], ["2021|Male", 25], ["2022|Female", undefined], ["2022|Male", null]]);

// Several measures: each column is checked against the expected measure naming its codes and unit, wherever it sits.
const drugLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "drug/narcotic violation", unit: "offense" }, { name: "drug equipment violation", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" },
  statements: ["gives the combined drug-crimes total (drug/narcotic plus drug equipment offenses)", "names its source at the end"] });
const drugValues = (a: number, b: number) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total",
  measures: { equipment_35B: "offense segments (02) with code 35B", narcotic_35A: "offense segments (02) with code 35A" },
  totals: { equipment_35B: { status: "VALUE", value: b }, narcotic_35A: { status: "VALUE", value: a } }, rows: null }) }]);
assert.equal(scoreShadow(drugLabel, drugs, r, ctx, drugValues(84, 84)).result!.outcome, "correct");
assert.equal(scoreShadow(drugLabel, drugs, r, ctx, drugValues(84, 85)).result!.outcome, "wrong_answer");
// A total sentence that does not add the table's cells fails its statement.
const badSum = { ...drugs, delivered: { ...drugs.delivered, text: drugs.delivered.text.map((t) => t.replace("168", "170")) } };
assert.notEqual(scoreShadow(drugLabel, badSum, r, ctx, drugValues(84, 84)).result!.outcome, "correct");
// By month: a cell per measure per month.
const monthly = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "month", measures: { cj: "carjacking offenses (120, motor vehicle taken)", sh: "offense segments with code 23C" },
  totals: {}, rows: [{ month: "2024-01", cj: { status: "VALUE", value: 2 }, sh: { status: "VALUE", value: 9 } }] }) }]).get("LS-999")!;
assert.deepEqual(monthly.map((x) => [x.key, x.value, x.measure]), [["2024-01", 2, "cj: carjacking offenses (120, motor vehicle taken)"], ["2024-01", 9, "sh: offense segments with code 23C"]]);

console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
