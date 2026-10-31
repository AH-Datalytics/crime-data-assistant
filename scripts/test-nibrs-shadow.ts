/**
 * The shadow slice (lib/nibrs-shadow) takes a question to an answer, a clarifying question or a decline as the decided
 * policy says, and its scoring (lib/answer-eval/shadow.ts) judges those outcomes. Offline: the DuckDB step is a stub
 * that returns rows shaped like the compiled query's, so this checks the pipeline and the delivered answer, never the
 * numbers (scripts/nibrs-compile-gate.ts and the runner do that against a canonical build). No database, no model.
 */
import assert from "node:assert/strict";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { agencyName, candidateLabel, loadPlaceIndex, reportedBy, resolvePlace } from "../lib/nibrs-shadow/places";
import { periodWords } from "../lib/nibrs-shadow/deliver";
import { scoreShadow, sliceValues } from "../lib/answer-eval/shadow";
import { compareMeaning, fbiNameFor, planToMeaning } from "../lib/answer-eval/compare";
import { gates } from "../lib/answer-eval/gates";
import type { Case } from "../lib/answer-eval/case";

const places = loadPlaceIndex();
const sqls: string[] = [];
/** Rows for the compiled query: every month (or year) of the period, 7 each, March 2024 unknown. */
function stub(sql: string): unknown[][] {
  sqls.push(sql);
  // Increment 4. Populations (the canonical agency file) and several agencies' monthly grids: see POP and GRID below.
  if (sql.includes("agency/data.parquet")) return popRows(sql);
  if (/unnest\(\[.*\]\) AS ori/.test(sql)) return gridRows(sql);
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
/** Populations by ORI (null: the FBI gives none), and Texas's city agencies. */
const POP: Record<string, number | null> = { OK0720500: 400_000, OK0550600: 700_000, KS0870300: 400_000, NC0410200: 300_000, NC0920100: null,
  TXHPD0000: 2_300_000, TXDPD0000: 1_300_000, TX2270100: 970_000, TX9999900: 0 };
const TX = { TXHPD0000: "HOUSTON", TXDPD0000: "DALLAS", TX2270100: "AUSTIN", TX9999900: "SMALLVILLE" } as Record<string, string>;
function popRows(sql: string): unknown[][] {
  const years = /data_year IN \(([\d, ]+)\)/.exec(sql)![1].split(", ").map(Number);
  // Increment 5's header universe (a state or the nation): Texas's agencies above, and two agencies of 100,000 in
  // each other state asked (SS0000001, SS0000002).
  const hdr = /u\.state_abbr IN \(([^)]*)\)/.exec(sql);
  if (hdr) {
    const states = hdr[1].split(", ").map((x) => x.slice(1, -1));
    // North Carolina: Raleigh (no FBI population) and Greensboro (300,000).
    const oris = states.flatMap((s) => (s === "TX" ? Object.keys(TX) : s === "NC" ? ["NC0920100", "NC0410200"] : [`${s}0000001`, `${s}0000002`]));
    return oris.flatMap((o) => years.map((y) => [o, y, POP[o] === undefined ? 100_000 : POP[o], o.slice(0, 2)]));
  }
  const oris = sql.includes("u.state_abbr = 'TX'") ? Object.keys(TX) : [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => m[1]);
  return oris.flatMap((o) => years.map((y) => [o, y, POP[o] ?? null, TX[o] ?? "", o.slice(0, 2)]));
}
/** An agency-month whose records conflict with its reporting status, when a test sets one. */
let CONFLICT: { ori: string; ym: string } | null = null;
/** Monthly grid: Houston 9 a month, Dallas 7, the rest 5; Greensboro unknown November-December 2025, Austin June 2024. */
function gridRows(sql: string): unknown[][] {
  const oris = /unnest\(\[(.*?)\]\) AS ori/.exec(sql)![1].split(", ").map((x) => x.slice(1, -1));
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const rows: unknown[][] = [];
  for (const o of oris) for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const unknown = (o === "NC0410200" && ym >= "2025-11" && ym <= "2025-12") || (o === "TX2270100" && ym === "2024-06");
    rows.push(CONFLICT && CONFLICT.ori === o && CONFLICT.ym === ym ? [o, ym, null, "EVIDENCE_CONFLICT"]
      : unknown ? [o, ym, null, "UNKNOWN"] : [o, ym, o === "TXHPD0000" ? 9 : o === "TXDPD0000" ? 7 : 5, "VALUE"]);
  }
  return rows;
}
const deps: ShadowDeps = {
  places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
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
assert.equal(a.delivered.text[0], "Memphis, Tennessee: 84 shoplifting offenses in 2023.");
assert.equal(a.delivered.text.at(-1), "Source: FBI NIBRS.", "P63: the source, plainly");
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
// Increment 5: the nation's shoplifting is summed over the agencies that reported (P61), with the button.
const usShop = as(noPlace.options[0].continuation!, "answer");
assert.ok(usShop.stateSum && usShop.buttons?.length === 1 && usShop.delivered.text.includes("The nation here is the 50 states and D.C.; territories and federal agencies are not included."));
assert.equal(noPlace.options[1].entry, "which state");
const noPeriod = as(ask("Shoplifting in Memphis"), "clarify");
assert.deepEqual(noPeriod.options.map((o) => o.label), ["The latest complete year (2025)", "This year so far", "Another year"]);
assert.deepEqual(as(noPeriod.options[0].continuation!, "answer").period, { from: "2025-01", to: "2025-12" });
const ytd = as(noPeriod.options[1].continuation!, "answer");
assert.deepEqual(ytd.period, { from: "2026-01", to: "2026-09" });
assert.ok(ytd.delivered.text.includes("The data runs through September 2026: this covers January through September 2026."), "D06: the months covered are named");
const trend = as(ask("Carjackings in Memphis by month"), "clarify");
assert.deepEqual(trend.options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);
assert.equal(as(trend.options[0].continuation!, "decline").notBuilt, true, "2016 is before this build");
assert.deepEqual(as(trend.options[1].continuation!, "answer").period, { from: "2017-01", to: "2026-09" });
assert.deepEqual(as(ask("How many crimes were there in Detroit in 2024?"), "clarify").options.map((o) => o.otherSource), ["historical", "historical", "historical"]);
const kc = as(ask("Shoplifting in Kansas City in 2024"), "clarify");
assert.deepEqual(kc.options.map((o) => o.label), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(kc.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MOKPD0000", label: "Kansas City, Missouri" }, { kind: "agency", ori: "KS1050200", label: "Kansas City, Kansas" }]);
// A city and a county of one name: a button each, and a choice is not asked again in a later question (P22).
const balt = as(ask("Shoplifting in Baltimore by month from 2022 to 2025"), "clarify");
assert.deepEqual(balt.options.map((o) => as(o.continuation!, "answer").plan.geography.places[0]), [
  { kind: "agency", ori: "MDBPD0000", label: "Baltimore, Maryland" }, { kind: "agency", ori: "MD0030100", label: "Baltimore County, Maryland" }]);
const stl = as(ask("St Louis carjackings per month"), "clarify");
assert.equal(stl.about, "which St. Louis");
const stlCity = as(stl.options[0].continuation!, "clarify");
assert.equal(stlCity.about, "which range of years", "the place is chosen; the period is asked next");
assert.equal(as(stlCity.options[1].continuation!, "answer").plan.geography.places[0].kind === "agency" && (as(stlCity.options[1].continuation!, "answer").plan.geography.places[0] as { ori: string }).ori, "MOSPD0000");
const wa = as(ask("Shoplifting in Washington in 2024"), "clarify");
assert.equal(as(wa.options[1].continuation!, "answer").plan.geography.places[0].kind, "state", "Washington state: a state sum (increment 5)");

// Declines: what the data does not record is declined before anything is asked; after the data, P24; before this build,
// not built; drug crimes (D19) are not one measure.
assert.equal(as(ask("crime by ZIP code in Chicago"), "decline").reason, "below_agency_level");
const future = as(ask("Shoplifting in Memphis in 2027"), "decline");
assert.equal(future.explanation, "2027 is not in the data; the latest month available is September 2026.");
assert.deepEqual(as(future.alternative!.continuation!, "answer").period, { from: "2026-01", to: "2026-09" });
assert.equal(as(ask("Shoplifting in Memphis in 2012"), "decline").notBuilt, true);
// D19: drug crimes are both drug measures, side by side, with their combined total (both known: 84 + 84).
const drugs = as(ask("Drug crimes in Detroit in 2023"), "answer");
assert.deepEqual(drugs.plan.measures.map((m) => m.id), ["offenses.drug_possession", "offenses.drug_equipment"]);
assert.deepEqual(drugs.delivered.table.columns.map((c) => c.header), ["Drug/narcotic violation offenses", "Drug equipment violation offenses"]);
assert.deepEqual(drugs.delivered.table.rows, [[84, 84]]);
assert.deepEqual(drugs.delivered.text.slice(0, 4), ["Drug crimes are drug/narcotic violations plus drug equipment violations.",
  "Detroit, Michigan, 2023: 84 drug/narcotic violation offenses; 84 drug equipment violation offenses.", "Reported by the Detroit Police Department.", "Together: 168 drug crimes in 2023."]);
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
assert.equal(as(ask("Shoplifting in Memphis in November 2026"), "decline").explanation, "November 2026 is not in the data; the latest month available is September 2026.");
// P52: the upload month itself is not reported.
assert.equal(as(ask("Shoplifting in Memphis in October 2026"), "decline").explanation, "October 2026 is not in the data; the latest month available is September 2026.");
assert.deepEqual(as(ask("Shoplifting in New York in 2024"), "clarify").options.map((o) => o.label), ["New York City", "New York state"]);
assert.deepEqual(as(ask("Shoplifting in Memphis by month"), "clarify").options.map((o) => o.label), ["The last 10 complete years", "Every year available", "Another range"]);

assert.equal(periodWords("2021-01", "2025-12"), "2021 to 2025");
assert.equal(periodWords("2021-03", "2025-06"), "March 2021 through June 2025");

// Scoring: a matching answer is unverified until independent values are given, then correct; a wrong value is a wrong
// answer; a not-built refusal is never scored.
const r = { firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
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
  { label: "This year so far", leads_to: "answer", meaning: shopIn({ from: "2026-01", to: "2026-09" }) },
  { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which year" }]);
const score = (vals?: Map<string, { key: string; value: number | null; status: string }[]>) => scoreShadow(label(np), noPeriod, r, ctx, vals).result!;
assert.deepEqual([score().outcome, score().values], ["unverified", "not measured"]);
const both = (a1: number) => new Map([["LS-999|The latest complete year (2025)", [{ key: "", value: a1, status: "VALUE" }]], ["LS-999|This year so far", [{ key: "", value: 63, status: "VALUE" }]]]);
assert.deepEqual([score(both(84)).outcome, score(both(84)).values], ["correct", "match"]);
assert.deepEqual([score(both(83)).outcome, score(both(83)).values], ["wrong_answer", "mismatch"]);
const wrongEntry = periodLabel([...(np as unknown as { options: never[] }).options.slice(0, 2), { label: "Another year", leads_to: "clarify", meaning: null as never, next_about: "which range of years" }]);
assert.equal(scoreShadow(label(wrongEntry), noPeriod, r, ctx, both(84)).result!.outcome, "incomplete");

// Codex review 2: no button answers "Shoplifting arrests in Washington" (arrests and state totals are not in the slice),
// so it declines rather than asks; a different question behind a button is a wrong answer; its text is checked; an
// answer behind a button with no values leaves the zero-wrong-answers gate NOT MEASURED.
// (Increment 2: arrests are built, so the city button answers; increment 5: the state button is a state sum.)
const waArrests = as(ask("Shoplifting arrests in Washington in 2024"), "clarify");
assert.deepEqual([waArrests.options[0].continuation?.kind, waArrests.options.find((o) => / state$/.test(o.label))?.continuation?.kind], ["answer", "answer"], "increment 5: the state button is a state sum (P61)");
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
const deep = (v: number) => new Map([["LS-999|St. Louis city, Missouri|Every year available", Array.from({ length: 117 }, (_, i) => {
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

// Codex review 02: compositions that would silently change what was asked are declined or kept whole.
assert.match(as(ask("Female simple assault victims by men and women in Detroit in 2023"), "decline").explanation, /victims restricted by sex/);
assert.match(as(ask("Drug crimes and shoplifting in Detroit in 2024"), "decline").explanation, /D19/);
for (const q of ["Gun crimes and murders in Detroit in 2024", "Stabbings and murders in Detroit in 2024"]) assert.match(as(ask(q), "decline").explanation, /beside other crimes/, q);
assert.match(as(ask("Robberies with a handgun in Detroit in 2023"), "answer").delivered.text[0], /robbery offenses with a weapon recorded as Handgun/);
assert.equal(ask("Simple assaults by men and men in Detroit in 2023").kind, "decline");
const chargedFor = as(ask("How many people were charged for shoplifting in Detroit in 2024?"), "decline");
assert.equal(as(chargedFor.alternative!.continuation!, "answer").plan.measures[0].id, "arrests.shoplifting");
// The combined total is checked exactly: 2520 is not 252 (gun crime stub: 84 each).
const gunLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2023-01", to: "2023-12" },
  measures: [{ name: "murder", unit: "victim" }, { name: "robbery", unit: "offense" }, { name: "aggravated assault", unit: "victim" }], filters: ["weapon: firearm"], groupings: [], statistic: "count" },
  values: { status: "pending_build" }, statements: ["gives the gun-crime total (firearm murder victims plus firearm robbery offenses plus firearm aggravated assault victims)"] });
const gunDiffs = (g: typeof gun) => scoreShadow(gunLabel, g, r, ctx).result!.diffs.filter((d) => d.field === "statement" && d.kind === "material");
assert.equal(gunDiffs(gun).length, 0);
assert.equal(gunDiffs({ ...gun, delivered: { ...gun.delivered, text: gun.delivered.text.map((t) => t.replace("252", "2520")) } }).length, 1);

// Codex P51 review: a known 0 denominator gives an expected blank share (not unverified); a share UNAVAILABLE for that
// reason is not a missing month.
const zeroDen = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "year", category: "sex", measures: { sa: "13B" }, totals: { sa: { status: "VALUE", value: 1 } },
  rows: [{ year: "2023", sex: "F", sa: { status: "VALUE", value: 1 } }, { year: "2024", sex: "F", sa: { status: "VALUE", value: 0 } }] }) }]).get("LS-999")!;
assert.deepEqual(zeroDen.map((x) => [x.key, x.share]), [["2023|Female", 100], ["2024|Female", null]]);
const unavailable = { ...bySex, delivered: { ...bySex.delivered, table: { ...bySex.delivered.table, rows: [["Female", 0, null]] },
  evidence: [{ row: 0, statistic: bySex.plan.statistics[0].as, status: "VALUE" as const }, { row: 0, statistic: bySex.plan.statistics[1].as, status: "UNAVAILABLE" as const }] } };
const missingLabel = label({ ...(sexLabel.expected as object), statements: ["names any months with no data as missing, not zero"] } as never);
assert.equal(scoreShadow(missingLabel, unavailable, r, ctx).result!.diffs.filter((d) => d.field === "statement" && d.kind === "material").length, 0);

// Increment 3 (time). The stub gives 7 per month, March 2024 unknown.
const chg = as(ask("Change in shoplifting in Detroit from 2022 to 2023"), "answer");
assert.deepEqual(chg.delivered.table.columns.map((c) => c.header), ["Shoplifting offenses, 2022", "Shoplifting offenses, 2023", "Change", "Percent change (%)"]);
assert.deepEqual(chg.delivered.table.rows, [[84, 84, 0, 0]]);
assert.ok(chg.delivered.text.includes("84 in 2022 and 84 in 2023: a change of 0 (0%)."));
// P54: no comparison year -> the year before; D17: no change from a year with a month unknown, the month named (D04).
const goUp = as(ask("Did shoplifting go up in Detroit in 2024?"), "answer");
assert.deepEqual(goUp.delivered.table.rows, [[84, null, null, null]]);
assert.ok(goUp.delivered.text.includes("No report is known for March 2024, so the 2024 total is not established and no change is given."));
assert.ok(!goUp.delivered.text.some((t) => /a change of/.test(t)));
// This year against last year: the same months, through the latest month (P52, D06).
const ytdCmp = as(ask("Is shoplifting in Detroit up this year compared with last year?"), "answer");
assert.deepEqual(ytdCmp.period, { from: "2025-01", to: "2026-09" });
assert.ok(ytdCmp.delivered.text.includes("Compares the same months of each year: January through September."));
assert.deepEqual(ytdCmp.delivered.table.rows, [[63, 63, 0, 0]]);
// "Compared with" and "percent change" read; a change with a NIBRS filter is a comparison too.
for (const q of ["Shoplifting in Detroit in 2023 compared with 2022", "Percent change in shoplifting in Detroit from 2022 to 2023", "Change in robberies with a firearm in Detroit from 2022 to 2023"])
  assert.equal(as(ask(q), "answer").plan.transforms[0].kind, "period_comparison", q);
// A change of several crimes or of a breakdown is not built.
assert.equal(ask("Change in shoplifting and burglary in Detroit from 2022 to 2023").kind, "decline");
// A set of years: only those years, grouped by year.
const sepYears = as(ask("Shoplifting in Detroit in 2019 and 2023"), "answer");
assert.deepEqual([sepYears.plan.period, sepYears.delivered.text[0]], [{ kind: "years", years: [2019, 2023] }, "Detroit, Michigan: shoplifting offenses by year, 2019 and 2023."]);
assert.ok(sqls.at(-1)!.includes("IN ('2019', '2023')"));
// Rolling windows reach back before the period; a window holding March 2024 is blank, never a shorter sum.
const roll = as(ask("Rolling 12-month shoplifting in Detroit since 2024"), "answer");
const rollRow = (ym: string) => roll.delivered.table.rows.find((r) => r[0] === ym)![1];
assert.deepEqual([rollRow("2024-02"), rollRow("2024-03"), rollRow("2025-02"), rollRow("2025-03")], [84, null, null, 84]);
assert.ok(roll.delivered.text.includes("Each month's figure is the total of that month and the 11 months before it."));
assert.ok(roll.delivered.text.some((t) => /^No report is known for March 2024: every window containing one of those months is shown blank/.test(t)));
// P56: the last 12 months, one total, months named.
const last12 = as(ask("Shoplifting in Detroit over the last 12 months"), "answer");
assert.deepEqual([last12.period, last12.plan.groupings, last12.delivered.text[0]], [{ from: "2025-10", to: "2026-09" }, [], "Detroit, Michigan: 84 shoplifting offenses in October 2025 through September 2026."]);
// Charlotte: found by its place name, named as its agency; a bare "Charlotte" is a city and a county (P28).
assert.match(as(ask("Shoplifting in Charlotte, North Carolina in 2023"), "answer").delivered.text[0], /^Charlotte, North Carolina/);
assert.equal(ask("Shoplifting in Charlotte in 2023").kind, "clarify");

// Codex increment-3 review. A future comparison declines with an alternative that answers its label (no recursion); a
// forecast's alternative is the trend it names; the reader's own change form keeps P01.
for (const q of ["Did shoplifting go up in Detroit in 2028?", "Change in shoplifting in Detroit from 2027 to 2028"]) {
  const d = as(ask(q), "decline");
  assert.equal(d.reason, "outside_release_coverage", q);
}
const fcCmp = as(ask("Will shoplifting increase in Detroit in 2027 compared with 2026?"), "decline");
assert.equal(fcCmp.reason, "forecast");
const fcAltCmp = as(fcCmp.alternative!.continuation!, "decline");
assert.deepEqual([fcAltCmp.notBuilt, /2016 to 2025/.test(fcAltCmp.explanation)], [true, true], "the trend alternative is the last 10 complete years (before this build), not the forecast's comparison");
assert.match(as(ask("Did burglaries increase in Detroit from 2022 to 2023?"), "decline").explanation, /P01/);
// Scoring: the comparison's periods are checked against the label; prose must be the templates with the table's numbers;
// a rolling answer must show every displayed month.
const lab309 = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { from: "2022-01", to: "2023-06" },
  measures: [{ name: "shoplifting", unit: "offense" }], filters: ["the same months of each year: January through June"], groupings: ["year"], statistic: "change" },
  values: { status: "pending_build" }, statements: ["gives both counts, the change and the percent change, with no adjectives", "names the months compared"] });
const half = as(ask("Shoplifting in Detroit January through June 2023 compared with January through June 2022"), "answer");
const material = (o: typeof half, c: Case) => scoreShadow(c, o, r, ctx).result!.diffs.filter((d) => d.kind === "material").map((d) => d.field);
assert.deepEqual(material(half, lab309), []);
const t0 = half.plan.transforms[0] as Extract<typeof half.plan.transforms[number], { kind: "period_comparison" }>;
const shifted = { ...half, plan: { ...half.plan, transforms: [{ ...t0, earlier: { ...t0.earlier, to: "2022-03" } }] } };
assert.ok(material(shifted, lab309).includes("comparison"), "an earlier period of January-March is not January-June");
const lab304 = label({ ...(lab309.expected as object), meaning: { ...(lab309.expected as { meaning: object }).meaning, period: { from: "2022-01", to: "2023-12" }, filters: [] } } as never);
const whole = as(ask("Change in shoplifting in Detroit from 2022 to 2023"), "answer");
assert.deepEqual(material(whole, lab304), []);
const lie = { ...whole, delivered: { ...whole.delivered, text: whole.delivered.text.map((x) => (/a change of/.test(x) ? "999 in 2022 and 1 in 2023: a catastrophic increase." : x)) } };
assert.ok(material(lie, lab304).includes("statement"), "prose that is not the table's numbers fails");
const rollLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Detroit Police Department", state: "MI" }], period: { rule: "2024 through the latest month in the data" },
  measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: ["month (rolling 12-month total ending that month)"], statistic: "count" },
  values: { status: "pending_build" }, statements: ["shows the windows ending March 2024 through February 2025 as missing (each contains March 2024), never zero or a shorter-window total"] });
assert.ok(!material(roll, rollLabel).includes("statement"));
const kept = roll.delivered.table.rows.map((row, i) => [row, i] as const).filter(([row]) => row[1] !== null);
const omitted = { ...roll, delivered: { ...roll.delivered, table: { ...roll.delivered.table, rows: kept.map(([row]) => row) },
  evidence: kept.map(([, i], j) => ({ ...roll.delivered.evidence[i], row: j })) } };
assert.ok(material(omitted, rollLabel).includes("statement"), "leaving the missing windows out does not pass");

// Batch 6 (time): a change's cells, a rolling series and a set of years load from their files and score the answers.
const v6 = (j: object) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", measures: { m: "x" }, rows: null, ...j }) }]).get("LS-999")!;
const chgCells = v6({ grouping: "change", periods: [{ from: "2022-01", to: "2022-12", total: { status: "VALUE", value: 84 } }, { from: "2023-01", to: "2023-12", total: { status: "VALUE", value: 84 } }],
  change: { change: 0, percent_change: 0 } });
assert.equal(scoreShadow(lab304, whole, r, ctx, new Map([["LS-999", chgCells]])).result!.values, "match");
const wrongChg = chgCells.map((c) => (c.key === "change" ? { ...c, value: 1 } : c));
assert.equal(scoreShadow(lab304, whole, r, ctx, new Map([["LS-999", wrongChg]])).result!.outcome, "wrong_answer");
// A second, wrong comparison row with valid-looking evidence never scores correct.
const extraRow = { ...whole, delivered: { ...whole.delivered, table: { ...whole.delivered.table, rows: [...whole.delivered.table.rows, [999, 1, -998, -99.9]] },
  evidence: [...whole.delivered.evidence, ...whole.delivered.evidence.map((e) => ({ ...e, row: 1 }))] } };
assert.equal(scoreShadow(lab304, extraRow, r, ctx, new Map([["LS-999", chgCells]])).result!.outcome, "wrong_answer");
assert.deepEqual(v6({ grouping: "change", periods: [{ from: "2022-01", to: "2022-12", total: { status: "VALUE", value: 0 } }, { from: "2023-01", to: "2023-12", total: { status: "VALUE", value: 6 } }],
  change: { change: 6, percent_change: null, percent_reason: "zero base (P55)" } }).at(-1), { key: "pct_change", value: null, status: "UNAVAILABLE" });
assert.deepEqual(v6({ grouping: "rolling", periods: [], rolling: [{ month: "2024-02", total: { status: "VALUE", value: 84 } }, { month: "2024-03", total: { status: "UNKNOWN", value: null, observed: 77 } }] }),
  [{ key: "2024-02", value: 84, status: "VALUE" }, { key: "2024-03", value: null, status: "UNKNOWN" }]);
assert.deepEqual(v6({ grouping: "years", periods: [{ from: "2019-01", to: "2019-12", total: { status: "VALUE", value: 1 } }, { from: "2024-01", to: "2024-12", total: { status: "VALUE", value: 2 } }] }).map((c) => c.key), ["2019", "2024"]);

// Batch 5's category fields and codes: the file names its field; age and unknown-offender codes map to NIBRSAI's labels;
// a multi-valued field's categories are never summed into a share's denominator.
const v5 = (category: string, rows: unknown[], extra = {}) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "total", category,
  measures: { m: "x" }, totals: { m: { status: "VALUE", value: 10 } }, rows, ...extra }) }]).get("LS-999")!;
assert.deepEqual(v5("age_group", [{ age_group: "under_18", m: { status: "VALUE", value: 4 } }, { age_group: "00", m: { status: "VALUE", value: 1 } }, { age_group: " ", m: { status: "VALUE", value: 1 } }]).map((x) => [x.key, x.share]),
  [["Under 18", 40], ["Unknown", 10], ["Not recorded", 10]]);
assert.deepEqual(v5("offender_sex", [{ offender_sex: "00", m: { status: "VALUE", value: 3 } }, { offender_sex: "M", m: { status: "VALUE", value: 9 } }]).map((x) => [x.key, x.share]),
  [["Unknown offender", 30], ["Male", 90]]);
const weaponYear = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "year", category: "weapon", measures: { m: "x" }, totals: { m: { status: "VALUE", value: 10 } },
  rows: [{ year: "2023", weapon: "12", m: { status: "VALUE", value: 8 } }, { year: "2023", weapon: "40", m: { status: "VALUE", value: 7 } }] }) }]).get("LS-999")!;
assert.deepEqual(weaponYear.map((x) => [x.key, x.share]), [["2023|Handgun", undefined], ["2023|Personal Weapons", undefined]], "overlapping categories are never summed");

// Increment 4: several agencies, combined totals, rates (P58, P59) and rankings (P60), on the grid and population stubs.
const ok4 = (q: string) => { const o = as(ask(q), "answer"); assert.deepEqual(o.delivered.contractProblems, [], q); return o; };
const tulsaOkc = ok4("Shoplifting in Tulsa and Oklahoma City in 2024");
assert.deepEqual(tulsaOkc.delivered.table.rows, [["Tulsa Police Department", 60], ["Oklahoma City Police Department", 60]]);
assert.equal(tulsaOkc.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma: shoplifting offenses by agency, 2024.");
assert.ok(sqls.some((s) => s.includes("unnest(['OK0550600', 'OK0720500']) AS ori")), "one grid query for both agencies");
const combinedTotal = ok4("Shoplifting in Tulsa and Oklahoma City combined in 2024");
assert.deepEqual(combinedTotal.delivered.table.rows, [[120]]);
assert.equal(combinedTotal.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma, combined: 120 shoplifting offenses in 2024.");
assert.deepEqual(ok4("Shoplifting in Tulsa Police Department, Tulsa, and Oklahoma City combined in 2024").delivered.table.rows, [[120]], "an agency named twice is counted once");
// A combined total needs every month of every agency (D6): Greensboro's unknown months blank the total, never a part-sum.
const gr = ok4("Shoplifting in Greensboro and Raleigh combined in 2025");
assert.deepEqual(gr.delivered.table.rows, [[null]]);
assert.ok(gr.delivered.text.includes("No report is known for November 2025 to December 2025 for Greensboro, North Carolina."));
// Rates: count over the FBI population, per 100,000; none from a missing or zero population (never 0 or infinite).
assert.deepEqual(ok4("Shoplifting rate in Wichita in 2024").delivered.table.rows, [[15]]);
const raleigh = ok4("Shoplifting rate in Raleigh in 2024");
assert.deepEqual(raleigh.delivered.table.rows, [[null]]);
assert.equal(raleigh.delivered.evidence[0].status, "UNAVAILABLE");
// A combined rate is the summed counts over the summed populations; a missing population blanks it.
assert.deepEqual(ok4("Shoplifting rate in Tulsa and Oklahoma City combined in 2024").delivered.table.rows, [[10.9]]);
assert.deepEqual(ok4("Shoplifting rate in Wichita and Raleigh combined in 2024").delivered.table.rows, [[null]]);
// P59: a part year's rate is for those months, not annualized.
const partYearRate = ok4("Shoplifting rate in Wichita this year");
assert.deepEqual(partYearRate.delivered.table.rows, [[11.3]], "45 offenses in January-September 2026 over 400,000");
assert.ok(partYearRate.delivered.text.some((t) => t.includes("not annualized")));
// P60: only full-year reporters are ranked; the rest are named with their months; no population is not ranked by rate.
const tx = ok4("Which Texas cities had the most shoplifting in 2024?");
assert.deepEqual(tx.delivered.table.rows, [["Houston Police Department", 108], ["Dallas Police Department", 84], ["TX9999900", 60]]);
assert.ok(tx.delivered.text.includes("Not ranked because they didn't report all 12 months of 2024: Austin Police Department (11 months)."));
const txRate = ok4("Which Texas cities had the highest shoplifting rate in 2024?");
assert.deepEqual(txRate.delivered.table.rows, [["Dallas Police Department", 6.5], ["Houston Police Department", 4.7]]);
assert.ok(txRate.delivered.text.includes("Not ranked because the FBI gives no population: TX9999900."));
assert.equal(as(ask("Which large Texas cities had the most shoplifting in 2024?"), "answer").delivered.table.rows.length, 2, "P08: 250,000 or more");
// Scoring increment 4: a ranking's filters, ranked statistic and P60 statements; a rate's denominator.
const year24 = { from: "2024-01", to: "2024-12" };
const txLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24, measures: [{ name: "shoplifting", unit: "offense" }],
  filters: ["city agencies", "agencies that reported every month of 2024"], groupings: ["agency"], statistic: "count", rank: { by: "count", direction: "top", limit: 20 } }, values: { status: "pending_build" },
  statements: ["shows exactly 3 agencies", "ranks only agencies that reported all 12 months of 2024, and names those left out with their months reported; no button to include them, and they appear in neither the chart nor the table (P60)",
    "orders ties alphabetically by agency name", "adds no other eligibility filter", "names its source at the end"] });
assert.deepEqual(material(tx, txLabel), []);
assert.ok(material({ ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.filter((t) => !t.startsWith("Ranked:")) } }, txLabel).includes("statement"), "the P60 rule must be said");
assert.ok(material({ ...tx, delivered: { ...tx.delivered, table: { ...tx.delivered.table, rows: [["Houston Police Department", 108], ["Dallas Police Department", 84]] } } }, txLabel).includes("statement"), "the row count is checked");
assert.ok(material(tx, label({ ...txLabel.expected!, meaning: { ...(txLabel.expected as { meaning: object }).meaning, rank: { by: "rate", direction: "top", limit: 20 } } } as Case["expected"])).includes("rank by"));
assert.ok(material(tx, label({ ...txLabel.expected!, meaning: { ...(txLabel.expected as { meaning: object }).meaning, filters: ["city agencies"] } } as Case["expected"])).includes("filters"), "the reporters rule is a filter of every ranking");
const okRates = ok4("Shoplifting rates in Tulsa and Oklahoma City in 2024");
const ratesLabel = (denominator: string) => label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Tulsa Police Department", state: "OK" }, { kind: "agency", name: "Oklahoma City Police Department", state: "OK" }],
  period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "rate", combine: "separate", denominator }, values: { status: "pending_build" },
  statements: ["gives each agency's rate over its own population", "names the agency (Tulsa Police Department)", "names the agency (Oklahoma City Police Department)", "names its source at the end"] });
assert.deepEqual(material(okRates, ratesLabel("each agency's residents (the FBI's agency population), per 100,000")), []);
assert.ok(material(okRates, ratesLabel("the two agencies' residents together (the FBI's agency populations), per 100,000")).includes("denominator"));

const wichita = ok4("Shoplifting rate in Wichita in 2024");
const wichitaLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Wichita Police Department", state: "KS" }], period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "rate",
  denominator: "residents of the Wichita Police Department's jurisdiction (the FBI's agency population), per 100,000" }, values: { status: "pending_build" },
  statements: ["gives the rate per 100,000 residents and names the population and its year", "names the agency (Wichita Police Department)", "names its source at the end"] });
assert.deepEqual(material(wichita, wichitaLabel), [], "the population sentence is any line, not the last");
assert.ok(material({ ...wichita, delivered: { ...wichita.delivered, text: wichita.delivered.text.filter((t) => !t.startsWith("Rates are")) } }, wichitaLabel).includes("statement"));
// Batch 7 values: a ranking's agencies by FBI name (or the ORI when the FBI gives none), its value and its place; a rate.
const v7 = (o: object) => sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", measures: { shoplifting: "23C" }, ...o }) }]);
const austinOut = [{ ori: "TX2270100", agency_name: "Austin Police Department", months_reported: Array(11).fill("2024") }];
const rankFile = (order: [string | null, string, number][], left = austinOut) => v7({ grouping: "ranking", ranked_by: "count",
  result: order.map(([agency_name, ori, count], i) => ({ agency_name, ori, count, rate: null, position: i + 1 })), left_out_months_unknown: left });
const scoredTx = (ev: ReturnType<typeof v7>) => scoreShadow(txLabel, tx, r, ctx, ev).result!;
assert.equal(scoredTx(rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]])).values, "match");
const swapped = scoredTx(rankFile([["Dallas Police Department", "TXDPD0000", 84], ["Houston Police Department", "TXHPD0000", 108], [null, "TX9999900", 60]]));
assert.deepEqual([swapped.values, swapped.diffs.some((d) => d.field === "position Houston Police Department")], ["mismatch", true], "the order is checked");
assert.equal(scoreShadow(wichitaLabel, wichita, r, ctx, v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] })).result!.values, "match");
assert.equal(scoreShadow(wichitaLabel, wichita, r, ctx, v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15.1 } }] })).result!.values, "mismatch");

// A label's agency in other words than the FBI's is the same agency; another agency is not.
assert.equal(fbiNameFor("Portland Police Bureau", "OR0260200"), "Portland Police Department");
assert.equal(fbiNameFor("Washington Metropolitan Police Department", "DCMPD0000"), "Washington Police Department");
assert.equal(fbiNameFor("Nashville Police Department", "TNMPD0000"), null);

// Codex review 02's findings, each a regression.
// 1. A set of years is those years only.
const setYears = as(ask("Shoplifting rate in Wichita in 2019 and 2023"), "answer");
assert.deepEqual(setYears.delivered.table.rows.map((x) => x[0]), ["2019", "2023"]);
assert.ok(setYears.delivered.text[0].includes("2019 and 2023"));
// 2. A conflict refuses a ranking (D6); it is never read as a month not reported.
CONFLICT = { ori: "TXHPD0000", ym: "2024-02" };
assert.match(as(ask("Which Texas cities had the most shoplifting in 2024?"), "decline").explanation, /conflict/);
CONFLICT = null;
// 3. The same agency twice, by month: the time grouping keeps its binding.
assert.equal(ask("Shoplifting in Tulsa Police Department and Tulsa by month in 2023").kind, "answer");
// 4. "Combined" of several crimes is declined, never answered as separate numbers.
assert.match(as(ask("Shoplifting and carjackings combined in Detroit in 2023"), "decline").explanation, /combined/);
// 5. The combined headline's number must be the table's.
const combinedLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "agency", name: "Tulsa Police Department", state: "OK" }, { kind: "agency", name: "Oklahoma City Police Department", state: "OK" }],
  period: year24, measures: [{ name: "shoplifting", unit: "offense" }], filters: [], groupings: [], statistic: "count", combine: "combined" }, values: { status: "pending_build" }, statements: ["gives one total of both agencies", "names its source at the end"] });
assert.deepEqual(material(combinedTotal, combinedLabel), []);
assert.ok(material({ ...combinedTotal, delivered: { ...combinedTotal.delivered, text: [combinedTotal.delivered.text[0].replace("120", "999"), ...combinedTotal.delivered.text.slice(1)] } }, combinedLabel).includes("statement"));
// 6. The left-out line must be there, with each agency's months.
const hide = (t: string[]) => scoreShadow(txLabel, { ...tx, delivered: { ...tx.delivered, text: t } }, r, ctx,
  rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]])).result!.values;
assert.equal(hide(tx.delivered.text.filter((t) => !t.startsWith("Not ranked"))), "mismatch", "a missing left-out line");
assert.equal(hide(tx.delivered.text.map((t) => t.replace("(11 months)", "(10 months)"))), "mismatch", "a wrong month count");
// Return A short names (Jeff 2026-10-30) say so, and are never "the <name> Police Department".
assert.equal(agencyName(places, "AK0014700"), "Kake (FBI Return A name)");
assert.equal(reportedBy([agencyName(places, "AK0014700")]), "Reported by Kake (FBI Return A name).");
assert.equal(reportedBy([agencyName(places, "TNMPD0000")]), "Reported by the Memphis Police Department.");
// 7. A sheriff's office is never matched to a police department.
assert.equal(fbiNameFor("Wichita Sheriff Office", "KS0870300"), null);
// Re-check A: several agencies by year are declined, never answered with the first agency alone.
assert.equal(ask("Shoplifting in Tulsa and Oklahoma City combined by year from 2021 to 2024").kind, "decline");
// Re-check B: one agency named twice, "combined", is that agency once.
assert.equal(ask("Shoplifting in Tulsa Police Department and Tulsa combined in 2024").kind, "answer");
// Review 04: several crimes "combined" is declined even when one agency is named twice.
assert.match(as(ask("Shoplifting and carjackings combined in Tulsa Police Department and Tulsa in 2023"), "decline").explanation, /combined/);
// Re-check C: more than five left out: the count and five distinct names, each with its months.
const six = ["A", "B", "C", "D", "E", "F"].map((x, i) => ({ ori: `TX000000${i}`, agency_name: `${x} Police Department`, months_reported: Array(i + 1).fill("2024") }));
const sixLine = (names: string[]) => `Not ranked because they didn't report all 12 months of 2024: 6 agencies, the largest ${names.join(", ")}.`;
const withLine = (line: string, left: typeof six) => scoreShadow(txLabel, { ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.map((t) => (t.startsWith("Not ranked") ? line : t)) } }, r, ctx,
  rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]], left)).result!.values;
assert.equal(withLine(sixLine(six.slice(0, 5).map((a, i) => `${a.agency_name} (${i + 1} month${i ? "s" : ""})`)), six), "match", "the first name follows \"the largest\"");
const twoOut = six.slice(0, 2);
assert.equal(withLine(`Not ranked because they didn't report all 12 months of 2024: A Police Department (1 month), A Police Department (1 month).`, twoOut), "mismatch", "names are distinct");
// 8. A blank rate says why: no population is not months unknown.
assert.match(raleigh.delivered.text[0], /because the FBI gives no 2024 population for the /);

// Increment 5. A Part I offense for a state or the nation, completed years: the historical file (P53), "Source: FBI SRS."
// (P63), with what it read; the covered part of a span with the rest named (D04, P14); a change (P54).
const srs = (q: string) => { const o = ask(q); assert.equal(o.kind, "srs", `${q}: ${JSON.stringify(o).slice(0, 200)}`); return o as Extract<ShadowOutcome, { kind: "srs" }>; };
const txRob = srs("Robberies in Texas in 2024");
assert.deepEqual([txRob.delivered.table.rows, txRob.delivered.text, txRob.read.column, txRob.read.uids], [[[19935]], ["Texas: 19,935 robberies in 2024.", "Source: FBI SRS."], "robbery_total", ["tx_2024"]]);
assert.deepEqual(srs("Burglary rate in Ohio in 2022").delivered.table.rows, [[259.5]]);
assert.equal(srs("Violent crime in California in 2024").read.column, "violent_total", "the file's own sum, never re-added");
assert.deepEqual(srs("Did robberies go up in Georgia in 2025?").delivered.table.rows, [[4426, 3799, -627, -14.2]]);
assert.deepEqual(srs("Murder clearance rate in the US in 2023").delivered.table.rows, [[57.8]]);
const span = srs("Robberies in Texas by year from 1955 to 1965");
assert.deepEqual(span.delivered.table.rows.map((x) => x[0]), ["1960", "1961", "1962", "1963", "1964", "1965"]);
assert.ok(span.delivered.text.includes("State figures in the data cover 1960 through 2025; 1955 through 1959 are outside them."));
assert.equal(as(ask("Robberies in Texas in 1955"), "decline").reason, "outside_release_coverage");
assert.equal(as(ask("Aggravated assault clearance rate in Ohio in 2023"), "decline").reason, "not_recorded_in_nibrs", "P18");
assert.match(as(ask("Carjacking clearance rate in Texas in 2024"), "decline").explanation, /no state clearance rate.*not yet decided/);
// Routes (P53): the current year to Current Trends, murders by relationship to Homicide Reports; named, not run.
assert.deepEqual([ask("Robberies in Texas this year").kind, (ask("Robberies in Texas this year") as { source: string }).source], ["route", "rtci"]);
assert.equal((ask("Murders in the US by victim-offender relationship in 2023") as { source?: string }).source, "shr");
// Increment 6 (P57): a Part I clearance rate for an agency in a completed year is Historical's, named, not run.
assert.equal((ask("Robbery clearance rate in Atlanta in 2023") as { source?: string }).source, "historical");
// Increment 6: plans. A clearance breakdown in a list with a period; the share cleared as the cleared units (with their
// incidents) over all units; arrests through the incident as every arrest on an incident with the condition. The plans
// only: the stub returns no rows.
const planOf = (q: string) => { const o = shadowAnswer(q, { ...deps, execute: () => [] }); return o.kind === "answer" ? o.plan : (assert.fail(`${q}: ${JSON.stringify(o).slice(0, 300)}`) as never); };
assert.deepEqual(planOf("Memphis shoplifting by year and clearance status, 2023 to 2024").groupings.map((g) => g.dimension), ["time.year", "offense.clearance_status"]);
assert.deepEqual(planOf("Memphis shoplifting by clearance type and year, 2023 to 2024").groupings.map((g) => g.dimension), ["time.year", "offense.clearance_type"]);
assert.deepEqual(planOf("What share of shoplifting offenses in Memphis in 2024 were cleared?").statistics.map((s) => s.kind), ["count", "incidents", "count", "ratio"]);
const through = planOf("Arrests in Memphis in 2024 for incidents that included a robbery");
assert.deepEqual([through.measures[0].id, through.timeBasis, JSON.stringify(through.filters[0])], ["arrests.all_crime", "arrest_date",
  JSON.stringify({ kind: "exists", scope: "incident", entity: "offense", where: [{ kind: "attribute", dimension: "offense.offense", op: "in", values: ["120"] }] })]);
assert.equal(planOf("Arrests in Memphis in 2024 for incidents where a firearm was stolen").measures[0].id, "arrests.all_crime");
// Codex increment-6 review 02. (1) A restricted clearance rate never routes with its restriction dropped.
assert.notEqual(ask("Robbery clearance rate in Atlanta in 2023 where a firearm was stolen").kind, "route");
// (2) A car is an automobile (03), not every vehicle.
const carWhere = (planOf("Motor vehicle thefts in Dallas in 2024 where a car was recovered").filters[0] as { where: { dimension: string; values: string[] }[] }).where;
assert.deepEqual(carWhere.find((w) => w.dimension === "property.description")!.values, ["03"]);
// (3) The share cleared's roles are read from the plan only against a denominator of the label's own measure.
const shareView = planToMeaning(planOf("What share of shoplifting offenses in Memphis in 2024 were cleared?"), { kind: "absolute", from: "2024-01", to: "2024-12" });
const shareLabel = (denominator: string) => ({ source: "nibrs", filters: ["cleared (by arrest or exceptional means)"], groupings: [], statistic: "share", denominator,
  places: [{ kind: "agency", name: "Memphis Police Department", state: "TN" }], period: { from: "2024-01", to: "2024-12" }, measures: [{ name: "shoplifting", unit: "offense" }] }) as unknown as Parameters<typeof compareMeaning>[0];
const rel = { firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
assert.deepEqual(compareMeaning(shareLabel("all shoplifting offenses in the period"), shareView, rel), []);
assert.ok(compareMeaning(shareLabel("all robbery offenses in the period"), shareView, rel).some((x) => x.field === "share roles" && x.kind === "unverified"));
// A NIBRS-only crime for a state (P61), on the stub: every reported month summed (Austin's 11 months included), the
// disclaimer, and the button's fixed every-month set; the rate over the agencies counted (P62); "according to NIBRS".
const txCj = as(ask("Carjackings in Texas in 2024"), "answer");
assert.deepEqual(txCj.delivered.table.rows, [[307]], "Houston 108 + Dallas 84 + Austin 55 (11 months) + 60");
assert.deepEqual(txCj.stateSum!.years.map((y) => [y.agencies, y.partial, y.every.agencies, y.every.sum]), [[4, 1, 3, 252]]);
assert.match(txCj.delivered.text[1], /^4 agencies reported at least one month of 2024, covering \d+\.\d% of the state's residents; 1 of them reported only some months and are included\. 3 reported every month/);
const txEvery = txCj.buttons![0].continuation as Extract<ShadowOutcome, { kind: "answer" }>;
assert.deepEqual([txEvery.plan.coverage.cohort, txEvery.delivered.table.rows], ["same_agencies", [[252]]]);
assert.deepEqual(as(ask("Carjackings in Texas in 2024, only agencies that reported every month"), "answer").delivered.table.rows, [[252]], "the button's question, typed");
assert.deepEqual(as(ask("Carjacking rate in Texas in 2024"), "answer").delivered.table.rows, [[6.7]], "307 per 4,570,000 residents of the agencies counted");
assert.equal(as(ask("Robberies in Texas in 2024 according to NIBRS"), "answer").plan.source, "nibrs", "P01: the source asked for in words");
// Scoring increment 5: the historical file's values with their column and row; a route verifies routing only; a state
// sum's view, rows and disclaimer figures.
const year24b = { from: "2024-01", to: "2024-12" };
const srsLabel = label({ action: "answer", meaning: { source: "historical", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24b, measures: [{ name: "robbery", unit: "offense" }], filters: [], groupings: [], statistic: "count" },
  values: { status: "pending_build" }, statements: ["names the state (Texas)", "ends with the source line \"Source: FBI SRS.\" (P63)"] });
const srsV = (value: number, column = "robbery_total") => sliceValues([{ name: "V", json: JSON.stringify({ basis: "crime_index_snapshot", nibrsai_cases: "LS-999", values: [{ uid: "tx_2024", year: 2024, column, value: String(value) }] }) }]);
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19935)).result!.outcome, "correct");
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19936)).result!.outcome, "wrong_answer");
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, srsV(19935, "robbery_capita")).result!.outcome, "wrong_answer", "provenance: the column read");
// A file listing supporting values after the answer's own (a sum's parts) scores on the first value of the year.
const withParts = sliceValues([{ name: "V", json: JSON.stringify({ basis: "crime_index_snapshot", nibrsai_cases: "LS-999", values: [{ uid: "tx_2024", year: 2024, column: "robbery_total", value: "19935" }, { uid: "tx_2024", year: 2024, column: "murder_total", value: "1" }] }) }]);
assert.equal(scoreShadow(srsLabel, txRob, r, ctx, withParts).result!.outcome, "correct");
const routeLabel = label({ action: "answer", meaning: { source: "rtci", places: [{ kind: "state", name: "Texas", state: "TX" }], period: { rule: "year to date through the latest reported month" }, measures: [{ name: "robbery", unit: "offense" }], filters: [], groupings: [], statistic: "count" }, values: { status: "pending_build" }, statements: [] });
assert.equal(scoreShadow(routeLabel, ask("Robberies in Texas this year"), r, ctx).result!.outcome, "unverified", "a route verifies the routing only");
const sumV = (sum: number, agencies = 4) => sliceValues([{ name: "V", json: JSON.stringify({ basis: "raw", nibrsai_cases: "LS-999", by_year: [{ year: 2024, agencies_counted: agencies, partial_reporters: 1, all_months_sum: sum, every_month_agencies_sum: 252,
  coverage: { any_month: { agencies, share: txCj.stateSum!.years[0].share }, every_month: { agencies: 3, share: txCj.stateSum!.years[0].every.share } } }] }) }]);
const sumLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24b, measures: [{ name: "carjacking", unit: "offense" }], filters: [], groupings: [], statistic: "count", cohort: "all_reporting" }, values: { status: "pending_build" },
  statements: ["states how many agencies are counted, what share of residents they cover, and that agencies reporting only some months are included (P61)", "offers a button to show only agencies that reported every month of the period; clicking it keeps Texas, carjackings and 2024 and counts only the agencies that reported all 12 months (P61)", "ends with the source line \"Source: FBI NIBRS.\" (P63)"] });
assert.equal(scoreShadow(sumLabel, txCj, r, ctx, sumV(307)).result!.outcome, "correct");
assert.equal(scoreShadow(sumLabel, txCj, r, ctx, sumV(306)).result!.values, "mismatch");
assert.equal(scoreShadow(sumLabel, txCj, r, ctx, sumV(307, 5)).result!.values, "mismatch", "the disclaimer's agencies are checked");
assert.ok(material({ ...txCj, buttons: [] }, sumLabel).includes("statement"), "the button must be there");

// Codex increment-5 review 2's findings, each a regression.
// 1. The historical file has whole years only: a month or a part-year comparison is declined, never answered as years.
assert.notEqual(ask("Robberies in Texas by month in 2024").kind, "srs");
assert.notEqual(ask("Robberies in Texas from January to June 2024 compared with January to June 2023").kind, "srs");
// 2. The every-month cohort survives source selection: a Part I crime with it is a NIBRS state sum over that set.
const txRobEvery = ask("Robberies in Texas in 2024, only agencies that reported every month");
assert.ok(txRobEvery.kind === "answer" && txRobEvery.plan.coverage.cohort === "same_agencies", JSON.stringify(txRobEvery).slice(0, 160));
// 3. Incidents are not the file's unit.
assert.notEqual(ask("Murder incidents in Texas in 2024").kind, "srs");
// 4. A conflict month is not summed, and is said; the agency leaves the every-month set.
CONFLICT = { ori: "TXHPD0000", ym: "2024-02" };
const txConflict = as(ask("Carjackings in Texas in 2024"), "answer");
assert.deepEqual([txConflict.delivered.table.rows, txConflict.stateSum!.years[0].conflicts, txConflict.stateSum!.years[0].every.agencies], [[[298]], 1, 2]);
assert.ok(txConflict.delivered.text.includes("1 agency-month whose records conflict with the agency's reporting status is not counted."));
CONFLICT = null;
// 5. A missing population is never 0: no rate, and the share covered is a lower bound.
assert.match(as(ask("Shoplifting rate in North Carolina in 2024"), "answer").delivered.text[0], /no rate is given for 2024, because 1 of the agencies counted have no FBI population/);
assert.match(as(ask("Shoplifting in North Carolina in 2024"), "answer").delivered.text[1], /covering at least [\d.]+% of the state's residents/);
// 6. A span reaching this year: its completed years, this year named; a future year is declined.
const toNow = srs("Robberies in Texas by year from 2020 to 2026");
assert.deepEqual([toNow.delivered.table.rows.map((x) => x[0]), toNow.delivered.text[1]], [["2020", "2021", "2022", "2023", "2024", "2025"], "2026 is this year: its figures come from Current Trends (Crime Index) and are not included here."]);
assert.equal(ask("Robberies in Texas in 2027").kind, "decline");
// 7. "According to NIBRS" overrides the Homicide Reports route (P01).
assert.notEqual(ask("Murders in the US by victim-offender relationship in 2023 according to NIBRS").kind, "route");
// 8. By year, one year: the Year cell is there.
assert.deepEqual(as(ask("Carjackings in Texas by year in 2024"), "answer").delivered.table.rows, [["2024", 307]]);
// 9. The disclaimer's figures are read in their roles: "14 agencies" never passes for 4.
const wrongCount = { ...txCj, delivered: { ...txCj.delivered, text: txCj.delivered.text.map((t, i) => (i === 1 ? t.replace(/^4 agencies/, "14 agencies") : t)) } };
assert.ok(material(wrongCount, sumLabel).includes("statement"));
// Codex review 03. 1: the every-month view over years qualifies a missing population too.
assert.match(as(ask("Shoplifting in North Carolina by year from 2023 to 2024, only agencies that reported every month"), "answer").delivered.text[1], /^Residents covered by those agencies: 2023 at least [\d.]+%; 2024 at least [\d.]+%\. Some of them have no FBI population/);
// 2: a span from this year into the future is declined, never routed as this year alone.
assert.equal(as(ask("Robberies in Texas by year from 2026 to 2027"), "decline").reason, "outside_release_coverage");

console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
