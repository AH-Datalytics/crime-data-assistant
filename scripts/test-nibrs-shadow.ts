/**
 * The shadow slice (lib/nibrs-shadow) takes a question to an answer, a clarifying question or a decline as the decided
 * policy says, and its scoring (lib/answer-eval/shadow.ts) judges those outcomes. Offline: the DuckDB step is a stub
 * that returns rows shaped like the compiled query's, so this checks the pipeline and the delivered answer, never the
 * numbers (scripts/nibrs-compile-gate.ts and the runner do that against a canonical build). No database, no model.
 */
import { CIRCUMSTANCE } from "../lib/nibrs-plan/draft-layer";
import assert from "node:assert/strict";
import fs from "node:fs";
import { applyDefaults, askInsteadChecks, heavyNationalSentence, isDeferred, listedNicknames, shadowAnswer, shadowFollowUp, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { toPreview } from "../lib/nibrs-shadow/preview";
import { jargon, UNMAPPED } from "../lib/nibrs-shadow/wording";
import { agencyLabel, agencyName, candidateLabel, loadPlaceIndex, nearestPlaceName, reportedBy, resolvePlace, STATE_NAMES } from "../lib/nibrs-shadow/places";
import { agencyPopulationSql } from "../lib/nibrs-plan/compile";
import { coveredText } from "../lib/nibrs-shadow/state-sum";
import { deliver, periodWords } from "../lib/nibrs-shadow/deliver";
import { readQuestion } from "../lib/nibrs-shadow/reading";
import { matchNibrsType, MEASURE_CODES } from "../lib/nibrs-question-types";
import { presentationOf, sentencesOf, unsaid } from "../lib/nibrs-shadow/presentation";
import { ANSWER_STATEMENTS } from "../lib/nibrs-plan/result";
import { chartOptionsOf, NOTE_TEXT } from "../lib/answer-contract/contract";
import { answerSrsSeveral } from "../lib/nibrs-shadow/srs";
import { missingGroupings, namedGroupings } from "../lib/nibrs-shadow/named-groupings";
import { scoreShadow, sliceValues, valueDiffs } from "../lib/answer-eval/shadow";
import { compareMeaning, fbiNameFor, planToMeaning } from "../lib/answer-eval/compare";
import { gates } from "../lib/answer-eval/gates";
import type { Case } from "../lib/answer-eval/case";
import { titleCase } from "../lib/nibrs-shadow/titles";
// P185 (Jeff 2026-11-21): the FBI master-files sentence follows the note under a NIBRS state or national sum (never under one agency's answer).
const FBI_MASTER_FILES = "The FBI's master files, which this tool uses, don't always match the aggregated totals the FBI publishes on its Crime Data Explorer, so counts here may differ from the FBI's published figures.";
import { seriesTitle, titleTimeframe } from "../lib/nibrs-shadow/headline";
import { allBlankMonthly, CHART_MARKER_SENTENCE, isChartEdit, plainMeanings, withYearlyOffer } from "../lib/nibrs-shadow/answer";
import { deterministicRewriter } from "../lib/nibrs-shadow/follow-up";
// P147: a monthly count series with every month blank is declined in one sentence, without the timeframe; part blank keeps its table.
{
  const monthCols = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Place" }, { binding: { kind: "grouping", dimension: "time.month" }, header: "Month" },
    { binding: { kind: "statistic", as: "x" }, header: "Murders" }];
  const series = (a: (number | null)[], b: (number | null)[]) => ({ kind: "current", question: { measure: "murder", place: { kind: "agency", label: "Dallas, Texas" }, agencies: [{ label: "New Orleans, Louisiana" }], form: "months", statistic: "count" },
    delivered: { table: { columns: monthCols, rows: [...a.map((v, i) => ["Dallas", `2025-0${i + 1}`, v]), ...b.map((v, i) => ["New Orleans", `2025-0${i + 1}`, v])] }, text: [] } }) as never;
  const none = allBlankMonthly(series([null, null], [null, null]));
  assert.ok(none && none.kind === "decline" && none.explanation === "No data is available for murders in Dallas, Texas and New Orleans, Louisiana.", JSON.stringify(none));
  // P150: several measures at once (a NIBRS table with a column each) name them all.
  const nibrsTwo = (a: (number | null)[], b: (number | null)[]) => ({ kind: "answer", plan: { measures: [{ id: "victims.homicide", unit: "victim" }, { id: "victims.murder", unit: "victim" }], statistics: [{ kind: "count", as: "a" }, { kind: "count", as: "b" }],
    filters: [], geography: { places: [{ kind: "agency", label: "Oakland, California" }] } },
    delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "a" }, header: "Homicide victims" }, { binding: { kind: "statistic", as: "b" }, header: "Murder victims" }],
      rows: a.map((v, i) => [`2021-0${i + 1}`, v, b[i]]) }, text: [] } }) as never;
  const two = allBlankMonthly(nibrsTwo([null, null], [null, null]));
  assert.ok(two && two.kind === "decline" && /^No data is available for .+ and .+ in Oakland, California\.$/.test(two.explanation), JSON.stringify(two));
  assert.equal(allBlankMonthly(nibrsTwo([null, null], [1, null])), null, "one column has a figure: the table stays");
  assert.equal(allBlankMonthly(series([4, null], [null, null])), null, "some months have figures: the table stays");
  assert.equal(allBlankMonthly(series([null, null], [3, 3])), null, "one place blank only: the table and its gap sentence stay");
}
// P143: phrases with one plain meaning.
assert.equal(plainMeanings("Baltimore carjackings per month until January 2026 in a bar chart", "2017-01"), "Baltimore carjackings per month from January 2017 through January 2026 in a bar chart");
assert.equal(plainMeanings("murders in Dallas until January 2026", "2017-01"), "murders in Dallas until January 2026", "no month series, no start: left as it is");
assert.equal(plainMeanings("Baltimore murders per month since 2020 until January 2026", "2017-01"), "Baltimore murders per month since 2020 until January 2026", "a start is named: left as it is");
assert.equal(plainMeanings("Can I get the raw numbers, not rates, for New Orleans homicides, monthly", "2017-01"), "Can I get counts, for New Orleans homicides, monthly");
assert.equal(plainMeanings("denver coloradocrime data for the last three years by month", "2017-01"), "denver colorado crime data for the last three years by month");
assert.equal(titleCase("drug/narcotic violation offenses"), "Drug/Narcotic Violation Offenses");

const places = loadPlaceIndex();
const sqls: string[] = [];
/** Rows for the compiled query: every month (or year) of the period, 7 each, March 2024 unknown. */
/** One agency's month reported as zero crimes (AZERO, "2024-07"): the stub marks it NOT_REPORTED, as the compiler does for one agency. */
let AZERO: string[] = [];
let withLeftOut = false;
/** Clearance types the state-clearance stub leaves out of its rows (P192: the answer still lists all seven). */
let OMIT_TYPES: string[] = [];
let EMPTY_CLEARANCE = false;
/** A year or total's rows end with `left_out` (the zero-report months, "202407"); a stub branch that built it says so. */
function stub(sql: string): unknown[][] {
  withLeftOut = false;
  const rows = stub0(sql);
  return /AS left_out/.test(sql) && !withLeftOut ? rows.map((r) => [...r, ""]) : rows;
}
function stub0(sql: string): unknown[][] {
  sqls.push(sql);
  // Increment 4. Populations (the canonical agency file) and several agencies' monthly grids: see POP and GRID below.
  // P90: the Consistent Reporting Agencies' current populations (an agency with none has no row).
  if (/current_population/.test(sql)) return [...sql.matchAll(/'([A-Z]{2}[A-Z0-9]{7})'/g)].map((m) => [m[1], POP[m[1]] === undefined ? 100_000 : POP[m[1]]]).filter((r) => r[1] !== null);
  if (sql.includes("agency/data.parquet")) return popRows(sql);
  // P171: a state's clearance by type, read once (state-sum.ts, "grid once"): each agency-year's coverage row ('c') and its sums by type ('s'):
  // half the year's units cleared by arrest (one incident fewer than units), the rest not cleared.
  if (/g AS MATERIALIZED/.test(sql) && /cleared_exceptionally/.test(sql)) {
    const by = new Map<string, number[]>(), oris = new Map<string, string>();
    for (const [ori, ym, n, st] of gridRows(sql) as [string, string, number | null, string][]) {
      const k = `${ori}|${ym.slice(0, 4)}`, rep = st === "VALUE" || st === "REPORTED_ZERO";
      const a = by.get(k) ?? by.set(k, [Number(ym.slice(0, 4)), 0, 0, 0, 0, 0]).get(k)!;
      oris.set(k, ori);
      a[1]++; if (rep) { a[2]++; a[3] += n ?? 0; } if (st === "EVIDENCE_CONFLICT") a[4]++; if (st === "VALUE") a[5]++;
    }
    const out: unknown[][] = [];
    for (const [k, a] of by) {
      out.push(["c", oris.get(k), a[0], a[1], a[2], a[3], a[4], a[5], null, null]);
      // Half by arrest, one in twelve under each exceptional type A to E (the stub's Smallville has none of C), the rest not cleared.
      const arrest = Math.floor(a[3] / 2), ex = Math.floor(a[3] / 12), none = a[3] - arrest - 5 * ex;
      const cats = ([["arrest", arrest], ["A", ex], ["B", ex], ["C", ex], ["D", ex], ["E", ex], ["none", none]] as [string, number][]).filter(([c]) => !OMIT_TYPES.includes(c));
      for (const [c, n] of cats) out.push(["s", oris.get(k), a[0], n, null, null, null, null, c, Math.max(n - 1, 0)]);
    }
    return out;
  }
  // A state sum's grid summed by agency and year (state-sum.ts): the stub sums its own monthly grid the same way.
  if (/repsum/.test(sql)) {
    const by = new Map<string, unknown[]>();
    for (const [ori, ym, n, st] of gridRows(sql) as [string, string, number | null, string][]) {
      const k = `${ori}|${ym.slice(0, 4)}`, rep = st === "VALUE" || st === "REPORTED_ZERO";
      const a = (by.get(k) ?? by.set(k, [ori, Number(ym.slice(0, 4)), 0, 0, 0, 0, 0]).get(k)!) as number[];
      a[2]++; if (rep) { a[3]++; a[4] += n ?? 0; } if (st === "EVIDENCE_CONFLICT") a[5]++; if (st === "VALUE") a[6]++;
    }
    return [...by.values()];
  }
  if (/unnest\(\[.*\]\) AS ori/.test(sql)) return gridRows(sql);
  // P192: one agency's clearance by type, only the types that occurred (arrest 704, uncleared 8,170: Chicago robbery 2024's real shape).
  // (EMPTY_CLEARANCE: no type occurred, the statement's placeholder row alone, which carries the period's status.)
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /cleared_exceptionally/.test(sql) && /_incidents"/.test(sql))
    return EMPTY_CLEARANCE ? [["__none__", 0, "VALUE", 0, "VALUE", null, "UNAVAILABLE"]] : [["arrest", 704, "VALUE", 704, "VALUE", 0.079, "VALUE"], ["none", 8170, "VALUE", 8170, "VALUE", 0.921, "VALUE"]];
  // A one-category breakdown over a period: F 30 (share 0.6), M 20 (0.4), U unknown.
  // The same with the incidents beside the count (P66): one incident had a female and a male victim (12 + 9 > 20).
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /_incidents"/.test(sql)) return [["F", 14, "VALUE", 12, "VALUE", 0.6, "VALUE"], ["M", 10, "VALUE", 9, "VALUE", 0.4, "VALUE"], ["U", null, "UNKNOWN", null, "UNKNOWN", null, "UNKNOWN"]];
  // Age groups out of order, with an age recorded as unknown and one not recorded (P86 merges them into one Unknown).
  // Offenders by their own race: Unknown the largest, still listed last (coordinator 2026-11-02).
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /ELSE f\.race END/.test(sql)) return [["U", 50, "VALUE", 0.625, "VALUE"], ["W", 10, "VALUE", 0.125, "VALUE"], ["B", 20, "VALUE", 0.25, "VALUE"]];
  if (/cats AS/.test(sql) && !/AS period/.test(sql) && /THEN 'Under 18'/.test(sql))
    return [["25-34", 20, "VALUE", 0.4, "VALUE"], ["Unknown", 5, "VALUE", 0.1, "VALUE"], ["Under 18", 15, "VALUE", 0.3, "VALUE"], [null, 10, "VALUE", 0.2, "VALUE"]];
  if (/cats AS/.test(sql) && !/AS period/.test(sql)) return [["F", 30, "VALUE", 0.6, "VALUE"], ["M", 20, "VALUE", 0.4, "VALUE"], ["U", null, "UNKNOWN", null, "UNKNOWN"]];
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const months: string[] = [];
  for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) months.push(`${y}-${String(m).padStart(2, "0")}`);
  const cell = (k: string): [number | null, string] => (k === "2024-03" ? [null, "UNKNOWN"] : AZERO.includes(k) ? [null, "NOT_REPORTED"] : [7, "VALUE"]);
  // A year or total: the months with crimes are summed, the zero-report ones named (`left_out`), a blank only for an unknown month or no month with crimes.
  const rolled = (ms: string[]): unknown[] => {
    if (ms.some((m) => cell(m)[1] === "UNKNOWN")) return [null, "UNKNOWN"];
    const zero = ms.filter((m) => cell(m)[1] === "NOT_REPORTED");
    return zero.length === ms.length ? [null, "NOT_REPORTED"] : [7 * (ms.length - zero.length), "VALUE"];
  };
  const leftOut = (ms: string[]) => ms.filter((m) => cell(m)[1] === "NOT_REPORTED").map((m) => m.replace("-", "")).join(",");
  if (/AS period/.test(sql) && /substr\(ym, 1, 4\) AS period/.test(sql)) {
    const years = [...new Set(months.map((m) => m.slice(0, 4)))];
    withLeftOut = true;
    return years.map((y) => [y, ...rolled(months.filter((m) => m.startsWith(y))), leftOut(months.filter((m) => m.startsWith(y)))]);
  }
  if (/AS period/.test(sql)) return months.map((m) => [m, ...cell(m)]);
  // A total with its incidents beside it (P66): the count, then the incidents (5 a month), each with its status.
  if (/_incidents"/.test(sql)) return months.some((m) => cell(m)[0] === null) ? [[null, "UNKNOWN", null, "UNKNOWN"]] : [[7 * months.length, "VALUE", 5 * months.length, "VALUE"]];
  withLeftOut = true;
  return [[...rolled(months), leftOut(months)]];
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
let ZERO: { ori: string; ym: string } | null = null;
/** Monthly grid: Houston 9 a month, Dallas 7, the rest 5; Greensboro unknown November-December 2025, Austin June 2024. */
function gridRows(sql: string): unknown[][] {
  const oris = /unnest\(\[(.*?)\]\) AS ori/.exec(sql)![1].split(", ").map((x) => x.slice(1, -1));
  const [, from, to] = /range\(DATE '(\d{4}-\d{2})-01', DATE '(\d{4}-\d{2})-01'/.exec(sql)!;
  const rows: unknown[][] = [];
  // The cleared offenses (a clearance-status filter): 40% of each agency's month, rounded down (Houston 9 to 3, Dallas 7 to 2, the rest 5 to 2).
  const clearedGrid = /WHEN 'none' THEN 'none'/.test(sql);
  const base = (o: string) => { const n = o === "TXHPD0000" ? 9 : o === "TXDPD0000" ? 7 : 5; return clearedGrid ? Math.floor(n * 0.4) : n; };
  for (const o of oris) for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) {
    const ym = `${y}-${String(m).padStart(2, "0")}`;
    const unknown = (o === "NC0410200" && ym >= "2025-11" && ym <= "2025-12") || (o === "TX2270100" && ym === "2024-06");
    rows.push(ZERO && (ZERO.ori === "*" || ZERO.ori === o) && ZERO.ym === ym ? [o, ym, 0, "REPORTED_ZERO"]
      : CONFLICT && CONFLICT.ori === o && CONFLICT.ym === ym ? [o, ym, null, "EVIDENCE_CONFLICT"]
      : unknown ? [o, ym, null, "UNKNOWN"] : [o, ym, base(o), "VALUE"]);
  }
  return rows;
}
const deps: ShadowDeps = {
  places, release: { id: "test-release", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute: stub,
  noDefaults: true, // these tests exercise the asks themselves; the defaults (P180 to P182) have their own block at the end
};
const ask = (q: string) => shadowAnswer(q, deps);
const SENT = "We don't track non-fatal shootings. You can choose firearm murders or aggravated assault involving a firearm (NIBRS).";
const as = <K extends ShadowOutcome["kind"]>(o: ShadowOutcome, k: K) => { assert.equal(o.kind, k, JSON.stringify(o).slice(0, 300)); return o as Extract<ShadowOutcome, { kind: K }>; };
// P168 (Jeff 2026-11-19): offenders or arrests by age for the crimes of an incident with a weapon, for one agency; the answer says how a person is counted.
{
  const byAge = as(ask("violent crimes involving a firearm in Houston in 2025 by offender age"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(byAge.plan.measures[0].id, "offenders.person_crimes");
  assert.ok(byAge.delivered.text.includes("A person is counted when the incident's crime involved the weapon; the data does not link a person to one offense."), JSON.stringify(byAge.delivered.text));
  const arrests = as(ask("violent crime with a firearm in Houston in 2025 by age of arrestee"), "answer") as unknown as { delivered: { text: string[] } };
  assert.ok(arrests.delivered.text.some((t) => /^A person is counted when the incident's crime/.test(t)), JSON.stringify(arrests.delivered.text));
  assert.ok(sqls.some((s) => /w2\.offense_code IN \('09A'.*weapon IN \('11', '12', '13', '14', '15'\)/.test(s)), "the weapon is asked of the incident's offenses of the measure's codes");
}
// P170 (P82, Jeff 2026-11-19): domestic violence is the victims of the P82 crimes with an intimate partner or a family or household relationship to any offender, for one agency first.
{
  const dv = as(ask("Domestic violence in Houston in 2024"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(dv.plan.measures[0].id, "victims.domestic_violence");
  assert.ok(dv.delivered.text.some((t) => /^Domestic violence counts each victim of murder or manslaughter, a sex offense, assault, kidnapping, incest, statutory rape or human trafficking whose offender/.test(t)), JSON.stringify(dv.delivered.text));
  const n0 = sqls.length;
  as(ask("Domestic violence in Houston in 2024"), "answer");
  const dvSql = sqls.slice(n0).find((s) => /o9\.offense_code = vo\.connected_offense/.test(s)) ?? "";
  assert.ok(/vo\.connected_offense IN \('09A', '09B', '11A', '11B', '11C', '11D', '13A', '13B', '13C', '100', '36A', '36B', '64A', '64B'\)/.test(dvSql), "the 14 P82 crimes");
  assert.ok(/r9\.offender_relationship IN \('SE', 'CS', 'BG', 'XS', 'XR', 'HR', 'CH', 'PA', 'SB', 'OF', 'SC', 'SP', 'GP', 'GC', 'IL', 'CF', 'BE', 'SS', 'FP', 'FC', 'CO'\)/.test(dvSql), "any pair to any offender, intimate partner or family or household");
  const ipv = as(ask("intimate partner violence in Houston in 2024"), "answer") as unknown as { plan: { filters: { kind: string }[] } };
  assert.ok(ipv.plan.filters.length >= 1, "intimate partner is the partner relationships beside the domestic definition");
  as(ask("family violence in Houston in 2024"), "answer");
  // An offender's occupation is not recorded: "police involved" is never dropped (QL-nibrs-846998f783 expects a decline).
  const police = ask("how many police involved domestic violence victims were reported in Houston in 2024?");
  assert.ok(police.kind === "decline" && /police involved/.test(police.explanation), JSON.stringify(police).slice(0, 300));
  // Not built yet: other units, and a state, the nation or several places (never the crimes alone).
  // 3d: offenses and arrests, the unit asked, each with its own definition sentence.
  const n2 = sqls.length;
  const off = as(ask("domestic violence offenses in Houston in 2024"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(off.plan.measures[0].id, "offenses.domestic_violence");
  assert.ok(off.delivered.text.includes("Offenses are the offenses of those crimes in incidents that had a domestic violence victim."), JSON.stringify(off.delivered.text));
  const arr = as(ask("domestic violence arrests in Houston in 2024"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(arr.plan.measures[0].id, "arrests.domestic_violence");
  assert.ok(arr.delivered.text.includes("Arrests are the people arrested on incidents that had a domestic violence victim; the data does not link an arrest to the victim, so this is not arrests of domestic violence offenders."), JSON.stringify(arr.delivered.text));
  assert.ok(sqls.slice(n2).filter((s) => /dvo\.connected_offense/.test(s)).length >= 2, "both ask the incident for a qualifying victim");
  for (const q of ["Domestic violence in Texas in 2024", "domestic violence nationally in 2024", "domestic violence arrests in Texas in 2024", "domestic violence offenses nationally in 2024", "domestic violence incidents in Texas in 2024"])
    assert.equal(ask(q).kind, "decline", q);
  // 3b: the incidents with at least one domestic violence victim (the same P82 victim membership, each incident once).
  const n1 = sqls.length;
  const inc = as(ask("How have domestic violence incidents trended in Houston since 2019"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(inc.plan.measures[0].id, "incidents.domestic_violence");
  assert.ok(inc.delivered.text.includes("An incident is counted once when at least one of its victims is counted as a domestic violence victim."), JSON.stringify(inc.delivered.text));
  const incSql = sqls.slice(n1).find((s) => /o9\.offense_code = vo\.connected_offense/.test(s)) ?? "";
  assert.ok(/r9\.offender_relationship IN \('SE'/.test(incSql) && /SELECT DISTINCT o\.data_year, o\.ori, o\.incident_num, NULL AS sub/.test(incSql), "distinct incidents from the qualifying victims");
}
// P153: a line, an annotation or a marker at a date on a chart is declined with its own sentence.
for (const q of ["DC violent crime rolling over 12 months with a line at August 2025", "Houston murders per month with an annotation at May 2020",
  "Give me a chart of the monthly murder counts in Baltimore and Detroit. Add some kind of marker to show August 2025 on the chart."]) {
  const o = ask(q);
  assert.ok(o.kind === "decline" && o.explanation === "Changing a chart this way isn't available here. The table can be sorted by clicking a column heading.", `${q}: ${JSON.stringify(o).slice(0, 200)}`);
}
// P157 (Jeff 2026-11-19): every request to change a chart is declined with the one sentence, as a follow-up or as a first turn; nothing returns the
// previous answer unchanged any more. A data question that merely names a chart stays a question.
{
  const CHART = "Changing a chart this way isn't available here. The table can be sorted by clicking a column heading.";
  for (const [prev, f] of [["murders in Memphis by month in 2024", "make it a bar chart"], ["violent crime in cincinnati by month from 2018 to 2025", "create a bar chart"],
    ["Top 10 auto theft rates in 2025", "Label the columns on the chart"], ["murders in Memphis by month in 2024", "make it a pie chart"], ["murders in Memphis by month in 2024", "sort by value"],
    ["murders in Memphis by month in 2024", "change the colors to red"], ["murders in Memphis by month in 2024", "add labels"], ["murders in Memphis by month in 2024", "show it as a table"],
    ["show me violent crime numbers in wilimington nc since 2018", "show linear regression line for this data"],
    ["Using UCR data only, give me a graph that tracks the U.S. Violent and Property crime rate from 1990 to 2024.", "can you make the chart where the left Y-Axis maps property crime and the Y-axis on the left side tracks violent crime"]]) {
    const o = shadowFollowUp(prev, f, deps);
    assert.ok(o.kind === "decline" && o.explanation === CHART, `${f}: ${JSON.stringify(o).slice(0, 200)}`);
  }
  for (const q of ["Chart New Orleans Part 1 UCR offenses by month", "murders in Memphis by month in 2024 as a line chart", "Present this data as a historical trend line by city"]) {
    const o = ask(q);
    assert.ok(o.kind !== "decline" || o.explanation !== CHART, `a data question is not a chart edit: ${q}`);
  }
  // The family never catches a label that is not a chart edit: exactly these labels (the questions of qlog-labels.json) are chart edits.
  const labels = (JSON.parse(fs.readFileSync(`${__dirname}/fixtures/answer-eval/qlog-labels.json`, "utf8")) as { labels: { id: string; kind: string; question: string; previous: string | null }[] }).labels;
  const edits = labels.filter((l) => isChartEdit(l.question) || (l.kind === "follow-up" && deterministicRewriter.rewrite(l.previous ?? "", l.question).kind === "presentation")).map((l) => l.id).sort();
  assert.deepEqual(edits, ["QL-ct-00d6ec868c", "QL-ct-27712b6b3b", "QL-ct-3190b22821", "QL-ct-6017ec600f", "QL-ct-7a7d5d78a4", "QL-ct-a68c73fa1d", "QL-ct-c9f8fc224a", "QL-ct-d0202d45b2", "QL-ct-eae798a9bd",
    "QL-ct-f6669e281d", "QL-ct-f71801135d", "QL-hist-18271ffa99", "QL-hist-3bf7843018", "QL-hist-5aaf80d9e8", "QL-hist-8cd529ba4e", "QL-hist-c70d2fda83", "QL-shr-0c808347cd", "QL-shr-3d41c7a12c", "QL-shr-8ce8361162", "QL-shr-f493f3140e"].sort());
}

// Places (P16, P28): a city is its principal police agency; a name with several real candidates of 100,000+ residents
// (cities in two states, a city and a county, a state) is asked about, cities first.
const at = (v: string, text: string) => resolvePlace(places, v, text);
const ori = (r: ReturnType<typeof at>) => (r.kind === "agency" ? r.agency.ori : r.kind);
const asked = (r: ReturnType<typeof at>) => (r.kind === "ask" ? r.candidates.map((c) => candidateLabel(c, r.candidates)) : r.kind);
assert.equal(ori(at("city:Memphis:TN", "Memphis")), "TNMPD0000");
assert.deepEqual(asked(at("ambiguous:Baltimore", "Baltimore")), ["Baltimore city, Maryland", "Baltimore County, Maryland"]);
// Jeff 2026-11-07: "Los Angeles should ask whether they mean the county sheriff or police department": the buttons name
// the two agencies; a county police department beside its city keeps the place's name.
const named = (r: ReturnType<typeof at>) => (r.kind === "ask" ? r.candidates.map((c) => candidateLabel(c, r.candidates, places)) : r.kind);
assert.deepEqual(named(at("city:Los Angeles:", "Los Angeles")), ["Los Angeles Police Department", "Los Angeles County Sheriff's Department"]);
assert.deepEqual(named(at("ambiguous:Baltimore", "Baltimore")), ["Baltimore city, Maryland", "Baltimore County, Maryland"]);
// P16 and P28 (Jeff 2026-11-16): "the city of X" names the city's principal police agency, so a county of the name is not asked about;
// the plain name still asks (P28). A city of the name in several states still asks which.
assert.equal(ori(at("ambiguous:San Diego", "City of San Diego, California")), "CA0371100");
assert.equal(ori(at("ambiguous:Los Angeles", "the city of Los Angeles")), "CA0194200");
assert.equal(ori(at("ambiguous:St. Louis", "City of St. Louis")), "MOSPD0000");
assert.deepEqual(named(at("ambiguous:San Diego", "San Diego, California")), ["San Diego Police Department", "San Diego County Sheriff's Office"]);
assert.equal(at("ambiguous:Kansas City", "city of Kansas City").kind, "ask", "two states have a Kansas City");
assert.equal(ori(at("county:St. Louis County:MO", "St. Louis County")), "MO0950000", "a county named stays the county");
assert.equal(agencyName(places, "CA0190000"), "Los Angeles County Sheriff's Department");
assert.deepEqual(asked(at("ambiguous:St Louis", "St Louis")), ["St. Louis city, Missouri", "St. Louis County, Missouri"], "St. Louis County, Minnesota is under 100,000");
assert.deepEqual(asked(at("ambiguous:Washington", "Washington")), ["Washington, D.C.", "Washington state", "Washington County, Oregon", "Washington County, Maryland"]);
assert.deepEqual(asked(at("ambiguous:Kansas City", "Kansas City")), ["Kansas City, Missouri", "Kansas City, Kansas"]);
assert.deepEqual(asked(at("city:Columbus:OH", "Columbus")), ["Columbus, Ohio", "Columbus, Georgia"], "the reader's filled-in state is not the question's");
assert.equal(ori(at("city:Columbus:OH", "Columbus, Ohio")), "OHCOP0000");
assert.equal(ori(at("city:Washington:DC", "Washington DC")), "DCMPD0000");
assert.equal(ori(at("county:Baltimore County:MD", "Baltimore County")), "MD0030100");
assert.equal(ori(at("city:Portland:OR", "Portland")), "OR0260200", "Portland, Maine is under 100,000");
assert.equal(at("city:Nowhere:TX", "Nowhere").kind, "unresolved");
// The shared index (coordinator 2026-11-02): the crosswalk's place names are aliases; Crime Index agencies NIBRS lacks are
// in it; an agency's own name wins over another's alias in the same state.
assert.equal(ori(at("city:New York City:NY", "New York City")), "NY0303000", "the crosswalk's \"new york city\"");
assert.equal(ori(at("county:Jefferson County:LA", "Jefferson Parish")), "LA0260000", "a Crime Index parish NIBRS lacks");
assert.equal(ori(at("county:Jefferson Parish:LA", "Jefferson Parish, Louisiana")), "LA0260000");
assert.equal(ori(at("city:Louisville:KY", "Louisville")), "KY0568000", "not the old county police's \"louisville county\"");
assert.equal(ori(at("city:Flint:MI", "Flint")), "MI2539800", "not Flint Township's mailing city \"flint\"");
// "Borough" is a town's, never a county's (Codex places review 01).
assert.equal(ori(at("ambiguous:Baldwin Borough", "Baldwin Borough")), "PA0020100");
assert.equal(ori(at("city:Freehold Borough:NJ", "Freehold Borough")), "NJ0131500");
assert.equal(ori(at("ambiguous:Middlesex Borough", "Middlesex Borough")), "NJ0121100");
assert.equal(at("ambiguous:Orleans Parish", "Orleans Parish").kind, "unresolved", "never Orleans County, New York");
assert.equal(at("county:Orleans County:LA", "Orleans Parish, Louisiana").kind, "unresolved");
// No population floor (Jeff 2026-11-03): every city and county agency is in the index, so same-name towns ask a short
// list, never dozens; a name with one clearly main city (twice the next) is that city; a city's name is a city (P16).
assert.ok(places.byName.get("clinton")!.length > 20 && places.byName.get("franklin")!.length > 20, "dozens of same-name agencies");
assert.deepEqual(asked(at("ambiguous:Springfield", "Springfield")), ["Springfield, Missouri", "Springfield, Massachusetts", "Springfield, Illinois"]);
const clinton = at("city:Clinton:IA", "Clinton");
assert.ok(clinton.kind === "ask" && clinton.candidates.length === 3 && clinton.more, "Clinton: three towns, one per state, and the rest one step away");
assert.deepEqual(asked(at("city:Greenville:SC", "Greenville")), ["Greenville, North Carolina", "Greenville city, South Carolina", "Greenville, Texas", "Greenville County, South Carolina"]);
assert.equal(ori(at("city:Franklin:TN", "Franklin")), places.byName.get("franklin")!.find((x) => x.state === "TN" && x.kind === "city")!.ori, "Franklin, Tennessee is twice any other Franklin");
assert.equal(at("city:Clinton:MI", "Clinton, Michigan").kind, "agency", "a state named settles it");
assert.equal((at("city:Clinton:MI", "Clinton, Michigan") as { agency: { kind: string } }).agency.kind, "city", "Clinton, Michigan is the city, not Clinton County");
{
  const c = as(ask("Shoplifting in Clinton in 2024"), "clarify");
  assert.equal(c.options.length, 4);
  assert.deepEqual(c.options.at(-1), { label: "Another Clinton", entry: "which city or agency" });
}

// "LA" asks Los Angeles or Louisiana; after a place it qualifies, it stays the state (coordinator 2026-11-03).
{
  const la = as(ask("LA murder trend"), "clarify");
  // Never a button that leads to a decline (Jeff 2026-11-14, no note): in this fixture Los Angeles declines, so only Louisiana is offered.
  assert.deepEqual(la.options.map((o) => o.label), ["Louisiana"]);
  assert.notEqual(ask("Shoplifting in Baton Rouge, LA in 2024").kind, "clarify");
  assert.notEqual((ask("Shoplifting in La Crosse in 2024") as { about?: string }).about, "which LA");
  assert.notEqual((ask("Shoplifting in LA CROSSE in 2024") as { about?: string }).about, "which LA", "Codex review 01.6: a name in capitals");
  // P141: listed with other cities, LA is Los Angeles (never asked, never the state); a state qualifier or a list of states keeps Louisiana.
  assert.equal(listedNicknames("Chicago violent crime vs. LA, NYC, Houston over the past 35 years"), "Chicago violent crime vs. Los Angeles, NYC, Houston over the past 35 years");
  assert.equal(listedNicknames("Chicago, Houston, LA murders"), "Chicago, Houston, Los Angeles murders");
  assert.equal(listedNicknames("Houston, TX and SF murders"), "Houston, TX and San Francisco murders");
  for (const q of ["Baton Rouge, LA murders in 2024", "Baton Rouge, LA and Houston, TX murders", "murders in CA, LA, TX", "Shreveport and Baton Rouge, LA murders"])
    assert.equal(listedNicknames(q), q);
  assert.notEqual(ask("Chicago violent crime vs. LA, NYC, Houston in 2024").kind === "clarify" && (ask("Chicago violent crime vs. LA, NYC, Houston in 2024") as { about?: string }).about, "which LA");
}
// A misspelled large place is read as it: one large place within two edits, same first letter (coordinator 2026-11-03).
assert.equal(nearestPlaceName(places, "batlimore"), "Baltimore");
assert.equal(nearestPlaceName(places, "phialdelphia"), "Philadelphia");
assert.equal(nearestPlaceName(places, "Memphis"), null, "a place the index has is not corrected");
assert.equal(nearestPlaceName(places, "index"), null);
// Wrong places in silence (coordinator 2026-11-05, Codex's baseline findings and the query-log search).
// A misspelling never takes the state the geo resolver chose for it; words naming more than the place still do.
assert.equal(ori(at("city:Philadelphia:MS", "Philadlephia")), ori(at("city:Philadelphia:PA", "Philadelphia, Pennsylvania")), "not Philadelphia, Mississippi");
assert.equal((at("city:San Antonio:FL", "san antnio") as { agency: { state: string } }).agency.state, "TX");
assert.equal((at("city:Charlotte:NC", "City of Charlotte") as { agency: { state: string } }).agency.state, "NC");
assert.equal((at("city:Kansas City:KS", "kck") as { agency: { state: string } }).agency.state, "KS");
// A small place a letter or two from a large one asks, the large one first.
assert.deepEqual(asked(at("ambiguous:Pittsburg", "Pittsburg")), ["Pittsburgh, Pennsylvania", "Pittsburg, California"]);
assert.deepEqual(asked(at("ambiguous:Berkley", "Berkley")), ["Berkeley, California", "Berkley, Michigan"]);
assert.deepEqual(asked(at("county:Prince George County:", "prince George county")), ["Prince George's County, Maryland", "Prince George County, Virginia"]);
// A county named without its state, in several states, none large, asks: a sheriff's population is not the county's.
assert.deepEqual(asked(at("county:Mecklenburg County:", "mecklenburg county")), ["Mecklenburg County, Virginia", "Mecklenburg County, North Carolina"]);
assert.equal(ori(at("county:Harris County:", "Harris County")), places.byName.get("harris")!.find((x) => x.state === "TX" && x.kind === "county")!.ori, "one large county of the name is it");
// "<name> Police Department": the city's, unless a large county police department of the name is in another state
// (query-log scorecard 2026-11-05: Arlington, Texas or Arlington County, Virginia); an agency's noun names no state.
assert.deepEqual(asked(at("city:Arlington:TX", "Arlington Police Department")), ["Arlington, Texas", "Arlington County, Virginia"]);
assert.equal((at("city:Baltimore:MD", "Baltimore Police Department") as { agency: { kind: string } }).agency.kind, "city", "Baltimore County's police is \"Baltimore County\"");
assert.equal(ori(at("city:Los Angeles:CA", "Los Angeles Police Department")), places.byName.get("los angeles")!.find((x) => x.kind === "city" && x.state === "CA")!.ori);
assert.equal((at("city:Salem:VA", "Salem City Police Department") as { agency: { state: string } }).agency.state, "VA", "Codex place review 07");
assert.equal((at("county:Worcester:MA", "Worcester Sheriff") as { agency: { state: string } }).agency.state, "MA", "Codex place review 07");
assert.equal(ori(at("city:Arlington:TX", "Arlington Police Department, Texas")),places.byName.get("arlington")!.find((x) => x.kind === "city" && x.state === "TX")!.ori);
// Words before a county at the start of a question are not its name.
assert.equal((at("county:Just Show Worcester County:MD", "just show worcester county, md") as { agency: { name: string } }).agency.name, "Worcester County");
{
  // "Tarrant County, Texas" is the county, never Tarrant, Alabama; a state code in lower case counts, "in" does not.
  const county = (q: string) => readQuestion(q, 2026, "2026-09").ledger.parts.filter((p) => p.concept === "place").map((p) => p.value);
  assert.deepEqual(county("show me homicides in tarrant county, texas 2020 - 2025"), ["county:Tarrant County:TX"]);
  assert.deepEqual(county("murders in Tarrant County in 2024"), ["county:Tarrant County:"]);
  assert.deepEqual(county("number of homicides in richland county oh in 2025"), ["county:Richland County:OH"]);
  assert.deepEqual(county("Show me violent crime trends in Mecklenburg county in North Carolina between 2002 and 2024"), ["county:Mecklenburg County:NC"]);
  assert.deepEqual(county("murders in Orleans Parish in 2024"), ["county:Orleans Parish:"]);
  assert.deepEqual(county("murders in each county in Texas in 2024").filter((v) => /^county/.test(v ?? "")), []);
  // Codex place review 01: "in" is Indiana only in capitals; "South King County" keeps its "South"; a sheriff's office
  // belongs to the county.
  assert.deepEqual(county("murders in Montgomery County, in 2024"), ["county:Montgomery County:"]);
  assert.deepEqual(county("murders in Montgomery County, IN in 2024"), ["county:Montgomery County:IN"]);
  assert.deepEqual(county("violent crime for tarrant county sheriff's office, texas in 2024"), ["county:Tarrant County:TX"]);
  assert.deepEqual(county("murders in King County Sheriff's Office, Washington in 2024"), ["county:King County:WA"], "Codex place review 02");
  assert.deepEqual(county("murders in King County Sheriffs Office, Washington in 2024"), ["county:King County:WA"], "Codex place review 03");
  assert.notEqual(ask("murders of King County sheriffs in Washington in 2024").kind, "historical", "sheriffs killed are people, not the agency (Codex place review 04)");
  assert.equal(at("county:South King County:WA", "South King County, Washington").kind, "unresolved");
  assert.notEqual(ask("murders in Big Spring 2024").kind, "clarify", "Big Spring is a city, not a season");
  // A season before a year is never a place ("Spring 2024" had answered Spring Township, Pennsylvania).
  assert.deepEqual(county("murders in Spring 2024"), []);
  assert.notEqual(ask("murders in Spring 2024").kind, "historical");
}
// "in total" with the period asked: each button answers, never the same question again ("murders in Total" crashed).
{
  const c = as(ask("murders in total nationally"), "clarify");
  assert.equal(c.about, "which period");
  assert.ok(c.options.every((o) => o.entry || (o.continuation && o.continuation.kind !== "clarify")), "every button runs");
  assert.notEqual(ask("murders in Total").kind, "decline");
}
// A misspelled large place the reader left unread ("Philadlephia murders 2024": no "in" before it) is read as the place;
// unread ordinary words near a place name are not (the query log's "line", "columns", "median", "dollar").
assert.equal(nearestPlaceName(places, "Philadlephia", true), "Philadelphia");
assert.equal(nearestPlaceName(places, "Clevland", true), "Cleveland");
for (const w of ["line", "like", "columns", "median", "dollar", "killed", "region", "control", "summer", "places", "bolder", "garlands"]) assert.equal(nearestPlaceName(places, w, true), null, w);
{
  // Offered first, never substituted in silence ("fontina thefts" is not Fontana: Codex spelling review 03).
  const c = as(ask("Philadlephia murders 2024"), "clarify");
  const right = ask("Philadelphia murders 2024");
  // Offered when the place's own question runs here (the stub build may not answer it; the real build does).
  if (right.kind !== "decline" && right.kind !== "route") {
    assert.equal(c.options[0].label, "Philadelphia");
    assert.equal(JSON.stringify(c.options[0].continuation), JSON.stringify(right));
  } else assert.ok(!c.options.some((o) => o.label === "Philadelphia"), "never a button that can't run");
  assert.notEqual(ask("fontina thefts 2024").kind, "historical");
}
assert.doesNotMatch(JSON.stringify(ask("bolder robberies in Philadelphia in 2024")), /Boulder/, "not a second place (Codex spelling review 01)");
// A county asked by name and answered from its sheriff's office says so; a sheriff named in the question needs no note.
{
  const text = (q: string) => JSON.stringify(ask(q));
  const note = "not the whole county's: cities in the county with their own police report separately.";
  const bare = text("Tarrant County, Texas murders 2024");
  if (/Tarrant County Sheriff/.test(bare)) assert.ok(bare.includes(note), bare.slice(0, 300));
  assert.ok(!text("murders in Tarrant County Sheriff's Office in 2024").includes(note));
  assert.ok(!text("murders in Baltimore County in 2024").includes(note), "a county police department covers its county");
  // Its own line, so the page shows it as a note: glued to the agency line it was filtered out as restated (redesign
  // public check, 2026-11-06). Every source that answered it here.
  for (const q of ["Tarrant County, Texas murders 2024", "shoplifting in King County Washington in 2024", "murders in Harris County by month in 2025", "shoplifting in King County Washington and Seattle Washington in 2024"]) {
    const o = ask(q) as { delivered?: { text: string[] } };
    if (!o.delivered || !JSON.stringify(o).includes("Sheriff")) continue;
    assert.ok(o.delivered.text.some((t) => t.includes(note)), q);
    const p = presentationOf(o as ShadowOutcome, places) as { notes?: { lines: string[] } };
    assert.ok(p.notes?.lines.some((t) => t.includes(note)), `${q}: the note is in notes.lines`);
  }
}
// Notes conformance (coordinator 2026-11-06, the Memphis monthly rate): every sentence of an answer's text is either
// said by the lead or header (the headline's first sentence, the reporter or "Figures for" line, the source line, a
// note key's own text) or shown in notes.lines. Never a line dropped because part of it was restated.
{
  const keyed = new Set<string>([...Object.values(ANSWER_STATEMENTS), ...Object.values(NOTE_TEXT)]);
  for (const q of ["robberies rate in Memphis in 2025 by month", "Murder rate in Memphis in June 2025", "Carjacking rate in Houston by month from 2023 to 2024",
    "Shoplifting rate in Wichita this year", "murder rate in Memphis this year", "Which Texas cities had the most aggravated assaults in 2024?", "Tarrant County, Texas murders 2024",
    "murder rate in Ohio and Texas in 2023", "assaults during an argument in Houston in 2024", "Houston murders by year 2015 to 2024", "murders in the United States in 2023",
    "robberies in Memphis by month in 2025", "rape rate in Memphis from 1990 to 1995", "Houston murder clearance rate in 2025", "violent crimes in the United States, rolling 12-month average"]) {
    const o = ask(q) as ShadowOutcome & { delivered?: { text: string[] } };
    if (!o.delivered) continue;
    const p = presentationOf(o, places) as { notes?: { lines: string[] } };
    const shown = (p.notes?.lines ?? []).join(" ");
    o.delivered.text.forEach((t, i) => sentencesOf(t).forEach((s, j) => {
      if (i === 0 && j === 0) return;
      if (/^(?:Reported by|Figures for|Source:) /.test(s) || keyed.has(s) || keyed.has(t)) return;
      assert.ok(shown.includes(s), `${q}: "${s}" is in the text but not in notes.lines`);
    }));
  }
  assert.deepEqual(sentencesOf("St. Louis, Missouri: 12 murders in 2024. Reported by the St. Louis Metropolitan Police Department."), ["St. Louis, Missouri: 12 murders in 2024.", "Reported by the St. Louis Metropolitan Police Department."]);
  // A rolling average is said as one in the lead, never as the window's total (redesign public check, 2026-11-06).
  const avg = ask("violent crimes in the United States, rolling 12-month average") as ShadowOutcome;
  if (avg.kind === "current") assert.match(JSON.stringify((presentationOf(avg, places) as { lead: unknown }).lead), /a month on average/);
  assert.deepEqual(unsaid(["A. B: 1 murder. Not scaled to a full year.", "Figures for X."], new Set(["A. B: 1 murder.", "Figures for X."])), ["Not scaled to a full year."]);
}
// Jeff 2026-11-06 ("Include 09B"): homicide in NIBRS is 09A and 09B; murder stays 09A.
assert.deepEqual(MEASURE_CODES.homicide, ["09A", "09B"]);
assert.deepEqual(MEASURE_CODES.murder, ["09A"]);
// The same months of each year (Jeff 2026-11-16, Q1): "through April", "first 6 months": one year is that month range; several years are the table
// Year | figure, each year counting the same months, titled with them; never the whole year in place of the months.
{
  type Del = { delivered: { table: { columns: { header: string }[]; rows: unknown[][] }; text: string[]; chart: unknown } };
  const one = as(ask("Murders through April in Houston in 2024"), "answer") as unknown as Del;
  assert.equal(one.delivered.text[0], "Houston, Texas Murder Victims January Through April Per Year, 2024");
  assert.deepEqual(one.delivered.table.columns.map((c) => c.header), ["Year", "Murder victims"]);
  // The 2024 fixture has no March report: the year's figure is blank, never the three months that are known.
  assert.deepEqual(one.delivered.table.rows, [["2024", null]]);
  assert.ok(one.delivered.text.includes("Each year counts the same months: January through April."));
  const many = as(ask("Murders through April in Houston from 2022 to 2024"), "answer") as unknown as Del;
  assert.equal(many.delivered.text[0], "Houston, Texas Murder Victims January Through April Per Year, 2022-2024");
  assert.deepEqual(many.delivered.table.rows, [["2022", 28], ["2023", 28], ["2024", null]]);
  assert.ok(many.delivered.text.some((t) => /^No figure is available for 2024: shown blank, not zero\.$/.test(t)));
  assert.deepEqual(many.delivered.chart, { kind: "bar", x: "Year", y: ["Murder victims"] });
  // Runner gate 2026-11-17: the period fields cover what the table shows (the whole span, not the first year's window), grouped by year.
  const m = many as unknown as { period: unknown; plan: { period: unknown; groupings: { dimension: string }[] } };
  assert.deepEqual(m.period, { from: "2022-01", to: "2024-04" });
  assert.deepEqual(m.plan.period, { kind: "absolute", from: "2022-01", to: "2024-04" });
  assert.deepEqual(m.plan.groupings.map((g) => g.dimension), ["time.year"]);
  // "The first 6 months of each year" is January through June; the months are never dropped for the whole year.
  const half = ask("Houston murders in the first 6 months of 2023");
  assert.ok(half.kind !== "answer" || /January through June/i.test((half as unknown as Del).delivered.text[0]), JSON.stringify(half).slice(0, 200));
  const asked = ask("Murders through April");
  assert.ok(asked.kind !== "answer", "no place: asked or declined, never an answer for the whole year");
  // Homicide Reports (Jeff 2026-11-17, "Start the table in 1985"): the years before the source starts are not blank rows; the table starts in
  // 1985 and the source's own sentence says so. (The Nashville question: "murders through May going back to 1935".)
  {
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    const sstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      if (/AS k1/.test(sql)) { const [, a, b] = /BETWEEN (\d{6}) AND (\d{6})/.exec(sql)!; const out: unknown[][] = []; for (let v = Number(a); v <= Number(b); v = v % 100 === 12 ? v + 89 : v + 1) out.push([Math.floor(v / 100), v % 100, 3]); return out; }
      return [];
    };
    const sdeps = { ...deps, execute: sstub, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
      historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
    const early = as(shadowAnswer("Houston murders through May from 1983 to 1987", sdeps), "shr");
    assert.equal(early.delivered.text[0], "Houston, Texas Murder Victims January Through May Per Year, 1985-1987");
    assert.equal(early.delivered.text[2], "Homicide Reports here start in 1985, so 1983 through 1984 aren't included.");
    assert.ok(!early.delivered.text.some((t) => /^No figure is available for /.test(t)), "no blank rows for the years before the source");
    assert.deepEqual(early.delivered.table.rows, [["1985", 15], ["1986", 15], ["1987", 15]]);
    assert.deepEqual(early.period, { from: "1985-01", to: "1987-05" });
    // P152 (Jeff 2026-11-19): "Homicide Reports" in the words is a source word: the murders come from that series, said in the Source line.
    for (const q of ["Houston murders per month in 2024 Homicide Reports", "Houston murders per month in 2024 according to Homicide Reports", "Homicide Reports murders per month in Houston in 2024"]) {
      const hr = shadowAnswer(q, sdeps);
      assert.equal(hr.kind, "shr", `${q}: ${JSON.stringify(hr).slice(0, 240)}`);
      if (hr.kind === "shr") {
        assert.equal(hr.delivered.text[hr.delivered.text.length - 1], "Source: FBI Supplementary Homicide Reports.", q);
        assert.ok(!hr.delivered.text.some((t) => /\bSHR\b/.test(t)), "never the abbreviation");
      }
    }
    // A question asked back keeps the source words the user wrote (gate, QL-hist-333df04e0a).
    const askedBack = shadowAnswer("which jurisdictions are included in homicide reports", sdeps);
    assert.ok(askedBack.kind === "clarify" && askedBack.question === "which jurisdictions are included in homicide reports", JSON.stringify(askedBack).slice(0, 240));
    // The runner's probes (canon2): by year the Crime Index route must not win over the named source, and another crime is said so before any ask.
    const byYear = shadowAnswer("Houston murders by year according to Homicide Reports", sdeps);
    assert.equal(byYear.kind, "shr", JSON.stringify(byYear).slice(0, 240));
    const noPeriod = shadowAnswer("Homicide Reports robberies in Houston", sdeps);
    assert.ok(noPeriod.kind === "decline" && noPeriod.explanation === "Homicide Reports hold murders and homicides only.", JSON.stringify(noPeriod).slice(0, 240));
    const notMurder = shadowAnswer("Houston robberies per month in 2024 according to Homicide Reports", sdeps);
    assert.ok(notMurder.kind === "decline" && notMurder.explanation === "Homicide Reports hold murders and homicides only.", JSON.stringify(notMurder).slice(0, 240));
    // A span wholly inside the source has no such line.
    assert.ok(!as(shadowAnswer("Houston murders through May from 1985 to 1987", sdeps), "shr").delivered.text.some((t) => /start in 1985/.test(t)));
    // P163 (Jeff 2026-11-19): justifiable homicide is Homicide Reports' own measure; "police" alone is the felons killed by police (81), "civilians"
    // alone the felons killed by a private citizen (80), neither word both together, both words the two side by side. Never counted as murder.
    const jsql: string[] = [];
    const jstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      if (/FROM read_parquet\('\/shr/.test(sql)) { jsql.push(sql); return /AS k0/.test(sql) ? [["80", 3], ["81", 2]] : [[5]]; }
      return [];
    };
    const jdeps = { ...sdeps, execute: jstub } as ShadowDeps;
    const first = (q: string) => { const n = jsql.length; const o = as(shadowAnswer(q, jdeps), "shr"); return { o, sql: jsql[n] }; };
    const jboth = first("justifiable homicides in Houston in 2023");
    assert.ok(/homicide_type = 'A' AND r\.circumstance IN \('80', '81'\) AND r\.agency_key/.test(jboth.sql), jboth.sql);
    assert.ok(jboth.o.delivered.text.some((t) => /ustifiable/.test(t)), JSON.stringify(jboth.o.delivered.text));
    assert.ok(/r\.circumstance IN \('80', '81'\) .* AND r\.circumstance IN \('81'\)$/.test(first("justifiable homicides by police in Houston in 2023").sql));
    assert.ok(/r\.circumstance IN \('80', '81'\) .* AND r\.circumstance IN \('80'\)$/.test(first("justifiable homicides by civilians in Houston in 2023").sql));
    const jvs = first("justifiable homicides by police vs civilians in Houston in 2023").o;
    assert.ok(jvs.delivered.table.columns.some((c) => c.header === "Circumstance") && jvs.delivered.table.rows.length === 2, JSON.stringify(jvs.delivered.table));
    // P164 (Jeff 2026-11-19): two details of the same people are one table, the first down the side and the second across.
    const wstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      if (!/FROM read_parquet\('\/shr\/canonical\/shr_(?:victim|offender)/.test(sql)) return [];
      const two = /AS k1/.test(sql);
      return two ? [["B", "M", 5], ["B", "F", 2], ["W", "M", 3]] : [["B", 7], ["W", 3]];
    };
    const wdeps = { ...sdeps, execute: wstub } as ShadowDeps;
    for (const q of ["Houston murder victims by race and sex in 2023", "Houston murder victims by race and gender in 2023", "Houston murder victim race and gender in 2023"]) {
      const o = as(shadowAnswer(q, wdeps), "shr");
      assert.deepEqual(o.delivered.table.columns.map((c) => c.header), ["Victim's race", "Male", "Female"], q);
      assert.deepEqual(o.delivered.table.rows, [["White", 3, 0], ["Black", 5, 2]], q);
      assert.equal(o.delivered.text[0], "Houston, Texas Murder Victims by The Victims' Race and the Victims' Sex, 2023");
    }
    // The same detail twice, or a detail of the other person, stays declined as a second breakdown.
    assert.notEqual(shadowAnswer("Houston murder victims by race and race in 2023", wdeps).kind, "shr");
    // P165 (Jeff 2026-11-19): the share of murders that involved a firearm is the murders by weapon with each share, and one sentence for the firearms together.
    const gstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      if (!/FROM read_parquet\('\/shr\/canonical\/shr_victim/.test(sql)) return [];
      return /AS k0/.test(sql) ? [["12", 6], ["11", 2], ["20", 2]] : [[10]];
    };
    const gdeps = { ...sdeps, execute: gstub } as ShadowDeps;
    for (const q of ["what share of murders in Houston in 2023 involved a firearm", "What percentage of murders in Houston in 2023 were committed with a gun?", "what weapons were used in murders in Houston in 2023"]) {
      const o = as(shadowAnswer(q, gdeps), "shr");
      assert.deepEqual(o.delivered.table.columns.map((c) => c.header), ["Weapon", "Murder victims", "Share (%)"], q);
      assert.ok(/^Houston, Texas .* by Weapon, 2023$/.test(o.delivered.text[0]), o.delivered.text[0]);
      if (!/weapons were used/.test(q)) assert.equal(o.delivered.text[1], "Firearms (handguns, rifles, shotguns, other guns and firearms of a type not stated) are 80% of the murder victims.", q);
    }
    {
    // P169 (Jeff 2026-11-19): domestic homicides are the murders whose victim was an intimate partner or a family or household member; the answer
    // names the relationships Homicide Reports do not record.
    const rsql: string[] = [];
    const rstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      if (/FROM read_parquet\('\/shr\/canonical\/shr_victim/.test(sql)) { rsql.push(sql); return /AS k0/.test(sql) ? [["2023", 4]] : [[7]]; }
      return [];
    };
    const rdeps = { ...sdeps, execute: rstub } as ShadowDeps;
    for (const q of ["domestic murders in Houston in 2023", "domestic violence murders in Houston in 2023", "domestic homicides in Houston in 2023"]) {
      const o = as(shadowAnswer(q, rdeps), "shr");
      assert.ok(/where the victim was an intimate partner or a family member of the offender/.test(o.delivered.text[0]), `${q}: ${o.delivered.text[0]}`);
      assert.ok(o.delivered.text.includes("Homicide Reports do not record a child of a boyfriend or girlfriend, a babysittee, a foster parent, a foster child or a cohabitant, so those relationships are not counted."), JSON.stringify(o.delivered.text));
      assert.ok(o.delivered.text.includes("This data source does not record ex-boyfriend and ex-girlfriend relationships."), JSON.stringify(o.delivered.text));
    }
    const relSql = rsql.find((s) => /r\.relationship IN \(/.test(s)) ?? "";
    assert.ok(/r\.relationship IN \('OF', 'HU', 'WI', 'CH', 'CW', 'BF', 'GF', 'XH', 'XW', 'HO', 'SO', 'DA', 'MO', 'FA', 'BR', 'SI', 'SS', 'SD', 'SF', 'SM', 'IL'\)/.test(relSql), relSql);
    const ipv = as(shadowAnswer("intimate partner homicides in Houston in 2023", rdeps), "shr");
    assert.ok(/where the victim was an intimate partner of the offender/.test(ipv.delivered.text[0]), ipv.delivered.text[0]);
    assert.ok(!ipv.delivered.text.some((t) => /a babysittee/.test(t)), "an intimate-partner question names no family relationship");
    // P160 to P162 (Jeff 2026-11-19): a victim's or offender's detail as a noun phrase, a share of a sex, and no period for a breakdown.
    const dstub = (sql: string): unknown[][] => {
      if (/count\(DISTINCT agency_key\)/.test(sql)) { const [, a, b] = /data_year BETWEEN (\d{4}) AND (\d{4})/.exec(sql)!; return range(Number(a), Number(b)).map((y) => [y, 1, ["ori9:TXHPD0000"]]); }
      const m = /data_year \* 100 \+ r\.offense_month BETWEEN (\d{6}) AND (\d{6})/.exec(sql);
      if (m && /AS k0/.test(sql)) {
        const ys = range(Math.floor(Number(m[1]) / 100), Math.floor(Number(m[2]) / 100));
        const byYear = /r\.data_year AS k0/.test(sql);
        const code = /shr_offender p/.test(sql) ? "B" : /p\.sex/.test(sql) ? "M" : "B";
        return byYear ? ys.flatMap((y) => [[y, code, 6], [y, "W", 4]]) : [[code, 6], ["W", 4]];
      }
      return [];
    };
    const ddeps = { ...sdeps, execute: dstub } as ShadowDeps;
    for (const q of ["murder victim race in Houston since 2010", "Houston murder victims by race since 2010", "What's the racial breakdown of murder victims in Houston since 2010?", "homicide offender race in Houston since 2010"]) {
      const o = as(shadowAnswer(q, ddeps), "shr");
      assert.ok(o.delivered.table.columns.some((c) => c.header === "Victim's race" || c.header === "Offender's race"), `${q}: ${JSON.stringify(o.delivered.table.columns)}`);
      assert.ok(["White", "Black"].includes(String(o.delivered.table.rows[0][0])) && !o.delivered.text.some((t) => /No years were given/.test(t)), `${q}: ${JSON.stringify(o.delivered.table.rows[0])}`);
    }
    const circ = as(shadowAnswer("Break down homicide circumstances in Houston in 2023", ddeps), "shr");
    assert.ok(circ.delivered.table.columns.some((c) => c.header === "Circumstance"), JSON.stringify(circ.delivered.table.columns));
    const every = as(shadowAnswer("Houston murder victim race", ddeps), "shr");
    assert.equal(every.delivered.table.rows[0][0], "1985");
    assert.ok(every.delivered.text.includes("No years were given, so every year in the data is shown: 1985 through 2026."), JSON.stringify(every.delivered.text));
    const share = as(shadowAnswer("What percentage of murder victims in Houston were male in 2023?", ddeps), "shr");
    assert.ok(share.delivered.table.columns.some((c) => c.header === "Share (%)") && share.delivered.table.columns.some((c) => c.header === "Victim's sex"), JSON.stringify(share.delivered.table.columns));
    }
  }
  // Runner gate 2026-11-17: no year named is not "every year in the data" (the old decline stays); no place and "each year" asks the place, as before.
  for (const q of ["Murders through april New york city", "Murders through April in Houston"]) {
    const o = ask(q) as unknown as { kind: string; reason?: string };
    assert.deepEqual([o.kind, o.reason], ["decline", "reader"], q);
  }
  assert.equal((ask("Murders through july of each year") as { about?: string }).about, "which place");
  // A place with "each year" and no year range: the years the data holds, said (Jeff's "first 6 months of each year").
  const each = as(ask("Houston murders in the first 6 months of each year"), "answer") as unknown as Del;
  assert.ok(each.delivered.text.some((t) => /^No years were given, so every year in the data is shown: /.test(t)), JSON.stringify(each.delivered.text).slice(0, 300));
}
// "wanna" opens a request like "want to" (scorecard 2026-11-16: "I wanna see shootings nationwide." was declined, not asked, P102).
assert.equal((ask("I wanna see shootings nationwide.") as { about?: string }).about, "We don't track non-fatal shootings. You can choose firearm murders or aggravated assault involving a firearm (NIBRS).");
assert.ok(!/I didn't understand "I wanna/.test((ask("I wanna see murders in Houston in 2024") as { explanation?: string }).explanation ?? ""));
// "By state" (Jeff 2026-11-16, Q2): one year is the plain table State | figure; years named, or a trend, the long table State | Year |
// figure with no chart; no year asks the year.
{
  const ST = "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split(" ");
  const sx = (sql: string): unknown[][] => {
    if (!/state_crime\.parquet/.test(sql)) return [];
    const one = /year = (\d{4})/.exec(sql), span = /year BETWEEN (\d{4}) AND (\d{4})/.exec(sql);
    const ys = one ? [Number(one[1])] : span ? Array.from({ length: Number(span[2]) - Number(span[1]) + 1 }, (_, i) => Number(span[1]) + i) : [];
    return ys.flatMap((y) => ST.map((s, i) => (one ? [s, s, 1_000_000 + i, 100 + i, 5 + i / 10, s] : [s, y, 1_000_000 + i, 100 + i, 5 + i / 10])));
  };
  const sdeps = { ...deps, execute: sx, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
  const tab = (q: string) => (as(shadowAnswer(q, sdeps), "historical") as unknown as { delivered: { table: { columns: { header: string }[]; rows: unknown[][] }; text: string[] } }).delivered;
  for (const q of ["murders by state in 2024", "murders for each state in 2024", "murders in all 50 states in 2024"]) {
    const d = tab(q);
    assert.deepEqual(d.table.columns.map((c) => c.header), ["State", "Murders"], q);
    assert.equal(d.table.rows.length, 50, q);
  }
  assert.deepEqual(tab("Murder rates by state in 2024").table.columns.map((c) => c.header), ["State", "Murders per 100,000"]);
  const long = tab("Murder rates 1960 to 2024, broken down by all 50 states");
  assert.deepEqual(long.table.columns.map((c) => c.header), ["State", "Year", "Murders per 100,000"]);
  assert.equal(long.table.rows.length, 50 * 65);
  assert.equal(long.text[0], "1960 to 2024 Murder Rate by State and Year");
  assert.deepEqual(chartOptionsOf(long.table as never).allowed, [], "a table only");
  assert.equal(tab("trends in murder by state").table.rows.length, 50 * 66, "a trend with no years is every year, 1960 to 2025");
  assert.equal(tab("dispaly murder totals by year for each state").table.rows.length, 50 * 66);
  assert.equal(tab("Can I see murders by state from 2020 to 2024").table.rows.length, 250);
  assert.equal(as(shadowAnswer("murders by state", sdeps), "clarify").about, "which period");
  // Not changed: a NIBRS-only detail by state keeps its own handling.
  assert.equal(as(shadowAnswer("carjacking by state in 2024", sdeps), "clarify").about, "which place");
}
// The current year's clearance rate (P129; Jeff 2026-11-16): cleared offenses over offenses in the months the data holds, from NIBRS. The stub's
// cleared grid is 40% of each agency's month rounded down (Houston 9 to 3, Dallas 7 to 2, the rest 5 to 2).
{
  const clr = (q: string) => as(ask(q), "answer").delivered;
  // An agency: Jeff's answer, whole: the sentence and the source; the rate only.
  for (const q of ["Robbery clearance rate in Detroit in 2026", "Robbery clearance rate in Detroit so far this year", "Robbery clearance rate in Detroit in 2026 according to NIBRS"]) {
    const d = clr(q);
    assert.deepEqual(d.text, ["Detroit cleared 40% of the robberies reported in January through September 2026.", "Source: NIBRS."], q);
    assert.deepEqual(d.table.rows, [[40]], q);
    assert.deepEqual(d.table.columns.map((c) => c.header), ["Robberies cleared (%)"], q);
  }
  assert.deepEqual(clr("Murder clearance rate in Houston in 2026").text, ["Houston cleared 33.3% of the murders reported in January through September 2026.", "Source: NIBRS."]);
  // A state or the nation: only the Consistent Reporting Agencies, said, with their number; one set for both figures.
  assert.deepEqual(clr("Murder clearance rate in Texas in 2026").text, ["Texas cleared 34.6% of the murders reported in January through September 2026, counting only the 4 Consistent Reporting Agencies that reported every month from January 2026 through September 2026.",
    "Source: NIBRS."]);
  assert.match(clr("Murder clearance rate in the US in 2026").text[0], /^The United States cleared 39\.7% of the murders reported in January through September 2026, counting only the 106 Consistent Reporting Agencies that reported every month from January 2026 through September 2026\.$/);
  // An agency with a month not reported is out of the set (Houston, March 2026): 3 agencies, 54 of 153.
  CONFLICT = { ori: "TXHPD0000", ym: "2026-03" };
  assert.match(clr("Murder clearance rate in Texas in 2026").text[0], /^Texas cleared 35\.3% of the murders .* counting only the 3 Consistent Reporting Agencies /);
  // An agency's month with no report is named and no rate is given.
  assert.match(as(ask("Murder clearance rate in Houston in 2026"), "decline").explanation, /^No clearance rate is given: no data is available for March 2026\./);
  CONFLICT = null;
  // A completed year keeps the FBI annual method from Crime Index (P57).
  assert.equal(as(ask("Murder clearance rate in Detroit in 2025"), "route").source, "historical");
}
{
  // All the cities (Jeff 2026-11-16, P128): "all American cities", "all Texas cities", "major cities" are the cities of 250,000 or more, ranked by the
  // figure, every one shown, the floor and the number said in the title; one year; a table and a bar chart.
  const CITIES: unknown[][] = [["TX0000001", "Houston", 2300000, 400, 17.4, "TX"], ["TX0000002", "Dallas", 1300000, 200, 15.3, "TX"], ["TX0000003", "El Paso", 680000, 30, 4.4, "TX"], ["TX0000004", "Lubbock", 260000, 25, 9.6, "TX"], ["NY0000001", "New York City", 8400000, 450, 5.3, "NY"], ["TX0000005", "Smallville", 40000, 3, 7.5, "TX"]];
  const cx = (sql: string): unknown[][] => {
    if (!/agency_crime\.parquet/.test(sql)) return [];
    const floor = /population >= 250000/.test(sql), tx = /state = 'TX'/.test(sql);
    return CITIES.filter((c) => (!floor || Number(c[2]) >= 250000) && (!tx || c[5] === "TX"));
  };
  const cdeps = { ...deps, execute: cx, historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
  const cities = (q: string) => (as(shadowAnswer(q, cdeps), "historical") as unknown as { delivered: { table: { columns: { header: string }[]; rows: unknown[][] }; text: string[] } }).delivered;
  for (const q of ["murders in all American cities in 2024", "murders in all cities in the US in 2024", "murders in all U.S. cities in 2024"]) {
    const d = cities(q);
    assert.equal(d.text[0], "United States Murder Count by City, Population 250,000 or More, 2024", q);
    assert.equal(d.text[1], "The 5 cities with the most murders are shown.", q);
    assert.deepEqual(d.table.rows, [["New York City, NY", 450], ["Houston, TX", 400], ["Dallas, TX", 200], ["El Paso, TX", 30], ["Lubbock, TX", 25]], q);
    assert.deepEqual(d.table.columns.map((c) => c.header), ["Agency", "Murders"], q);
    assert.deepEqual(chartOptionsOf(d.table as never).allowed, ["horizontal_bar"], "a bar chart as well as the table");
  }
  for (const q of ["murders in all Texas cities in 2024", "murders in every city in Texas in 2024"]) {
    const d = cities(q);
    assert.equal(d.text[0], "Texas Murder Count by City, Population 250,000 or More, 2024", q);
    assert.deepEqual(d.table.rows.map((r) => r[0]), ["Houston", "Dallas", "El Paso", "Lubbock"], q);
  }
  assert.equal(cities("murder rate in all U.S. cities 2024").text[0], "United States Murder Rate by City, Population 250,000 or More, 2024");
  assert.equal(cities("murder rate in all U.S. cities 2024").text[1], "The 5 cities with the highest rates are shown.");
  // "Major cities" with no rank word, and no place, are the nation's, said (the old reading gave the national total).
  const major = cities("murders in major cities in 2024");
  assert.equal(major.text[0], "United States Murder Count by City, Population 250,000 or More, 2024");
  assert.ok(major.text.includes("No place was named, so these are cities across the United States."));
  // One year: none asks the year; several years are declined with the one-year ask.
  assert.equal(as(shadowAnswer("murders in all American cities", cdeps), "clarify").about, "which period");
  // Only a plain count or rate of one crime for one year (runner gate 2026-11-17): a time series, a total, or a condition of its own keeps its old
  // reading (the lost ids: by month over several years; officers with its own size condition; a weapon share; a sum across the cities).
  const isSet = (q: string) => !!(readQuestion(q, 2026, "2026-09").ledger as unknown as { allCities?: boolean }).allCities;
  for (const q of ["Murder rate in 2026 for all American cities", "murders in all American cities in 2024", "murders in major cities in 2024"]) assert.ok(isSet(q), q);
  for (const q of ["murders in all American cities from 2020 to 2024", "Can I see murders in major cities by month from 2022 to 2026", "murders in all Texas cities since 2018",
    "provide a list of every city that had 500 or more officers in 2019 and the number of officers in 2019, 2022, 2023, 2024 and 2025",
    "Big cities with the biggest share of homicides by knife or sharp object", "Sum of murders across all Texas cities in 2024", "total murders in all American cities in 2024",
    // Comparisons, "other cities", year to date, a weapon or detail, a series, another population bound: their old readings (runner gate 2026-11-17).
    "los angeles homicide rate in 2025 vs. other large cities", "how does memphis compare to other large cities over the same time frame?",
    "How is Chicago doing on homicide counts and clearances compared to other large cities?", "Compare assault rates in Seattle vs other major cities",
    "el paso, texas thefts compared to other texas large cities", "murders so far this year across major cities", "gun arrests in major American cities in 2025",
    "cannabis cultivation arrests in major us cities annually", "Share of vehicle burglaries where a firearm was stolen in big cities in Texas broken down by city",
    "murder by city in north carolina largest cities only", "locations of crimes in cities over 1M"]) assert.ok(!isSet(q), q);
  // Not changed: a ranking word, or a number, keeps the old readings.
  assert.equal(cities("which large Texas cities had the most murders in 2024").text[0], "Texas Murder Count by City, Population 250,000 or More, 2024");
  assert.match(cities("the 10 largest cities murders 2024").text[0], /^The 6 largest cities in the United States by population/);
}
// P120 (Jeff 2026-11-16): with a victim word, juvenile, minor, child and kid mean victims under 18 and teen means victims aged 13 to 19,
// for every crime, and the answer's title says the range; with no victim word, juvenile is an offender under 18 (P107).
{
  const title = (q: string) => (as(ask(q), "answer") as { delivered: { text: string[] } }).delivered.text[0];
  for (const w of ["juvenile", "minor", "kid", "child"]) {
    assert.equal(title(`${w} robbery victims in Houston in 2024 by month`), "Houston, Texas Robbery Victims Under 18 Per Month, 2024", w);
    assert.equal(title(`${w} homicide victims in Houston in 2024 by month`), "Houston, Texas Homicide Victims Under 18 Per Month, 2024", w);
  }
  assert.equal(title("teen robbery victims in Houston in 2024 by month"), "Houston, Texas Robbery Victims Aged 13 to 19 Per Month, 2024");
  assert.equal(title("teenage homicide victims in Houston in 2024 by month"), "Houston, Texas Homicide Victims Aged 13 to 19 Per Month, 2024");
  assert.equal(title("child victims of burglary in Houston in 2024 by month"), "Houston, Texas Burglary Victims Under 18 Per Month, 2024");
  assert.ok(/^Ohio had 120 robbery victims under 18 in 2024/.test(title("How many juvenile robbery victims in Ohio in 2024?")));
  assert.equal(title("juvenile robberies in Houston in 2024 by month"), "Houston, Texas Robbery Offenses With an Offender Under 18 Per Month, 2024");
  assert.equal(title("robbery victims in Houston in 2024 by month"), "Houston, Texas Robbery Offenses Per Month, 2024", "no age: property victims stay counted by offense (P11)");
}
// P120 on every side (Jeff 2026-11-16, Coordinator): teen and teenage are 13 to 19 for victims, offenders and arrestees, the range said;
// juvenile, minor, child and kid stay under 18 (P107).
{
  const title = (q: string) => (as(ask(q), "answer") as { delivered: { text: string[] } }).delivered.text[0];
  assert.equal(title("teen robbery offenders in Houston in 2024 by month"), "Houston, Texas Robbery Offenders Aged 13 to 19 Per Month, 2024");
  assert.equal(title("robberies by teens in Houston in 2024 by month"), "Houston, Texas Robbery Offenses With an Offender Aged 13 to 19 Per Month, 2024");
  assert.equal(title("teen arrests for robbery in Houston in 2024 by month"), "Houston, Texas Robbery Arrests of Arrestees Aged 13 to 19 Per Month, 2024");
  assert.equal(title("juvenile arrests for robbery in Houston in 2024 by month"), "Houston, Texas Robbery Arrests of Arrestees Under 18 Per Month, 2024");
  assert.equal(title("juvenile robbery offenders in Houston in 2024 by month"), "Houston, Texas Robbery Offenders Under 18 Per Month, 2024");
  assert.ok(/^Ohio had [\d,]+ robbery offenders aged 13 to 19 in 2024, summed over the agencies that reported\.$/.test(title("How many teen robbery offenders in Ohio in 2024?")));
  assert.equal(title("murders against teens in Houston in 2024 by month"), "Houston, Texas Murder Victims Aged 13 to 19 Per Month, 2024");
  assert.equal(title("murders against juveniles in Houston in 2024 by month"), "Houston, Texas Murder Victims Under 18 Per Month, 2024");
  assert.equal(as(ask("teen offenders in Ohio in 2024"), "clarify").about, "which kind of crime");
  // The age word plural, and after the crime (Coordinator 2026-11-16): the same meaning as the singular.
  for (const [q, want] of [
    ["teenagers arrested for robbery in Ohio in 2024", /robbery arrests of arrestees aged 13 to 19 in 2024/], ["teens arrested for robbery in Ohio in 2024", /robbery arrests of arrestees aged 13 to 19 in 2024/],
    ["kids arrested for robbery in Ohio in 2024", /robbery arrests of arrestees under 18 in 2024/], ["minors arrested for robbery in Ohio in 2024", /robbery arrests of arrestees under 18 in 2024/],
    ["juveniles arrested for robbery in Ohio in 2024", /robbery arrests of arrestees under 18 in 2024/],
    ["kids robbery offenders in Ohio in 2024", /robbery offenders under 18 in 2024/], ["children robbery offenders in Ohio in 2024", /robbery offenders under 18 in 2024/],
  ] as [string, RegExp][]) assert.match(title(q), want, q);
  assert.match(title("murders in Chicago in 2024 with a teen victim"), /murder victims aged 13 to 19 (?:for Chicago )?in 2024/);
  assert.match(title("murders of teenagers in Chicago in 2024"), /murder victims aged 13 to 19 (?:for Chicago )?in 2024/);
  assert.match(title("children murdered in Chicago in 2024"), /murder victims under 18 (?:for Chicago )?in 2024/);
  // PR 190 run: the words "juvenile", "juveniles" and "minor" keep their old reading, so a restated question or a decline still
  // carries the user's own word (never "with a offender", never "arrests" without "juvenile").
  for (const [q, said] of [
    ["share of juveniles arrested for murder by year", "share of juveniles arrested for murder by year"],
    ["share of juveniles arrested for homicide over time", "share of juveniles arrested for homicide over time"],
    ["show me crimes with a juvenile offender 2017 to 2025", "show me crimes with a juvenile offender 2017 to 2025"],
    ["show me incidents with a juvenile offender for weapons possession offenses", "show me incidents with a juvenile offender for weapons possession offenses"],
    ["show me offenses with a juvenile offender involving firearms by offense category in 2025", "show me offenses with a juvenile offender involving firearms by offense category in 2025"],
    ["What is the most juvenile arrest data available?", "What is the most juvenile arrest data available?"],
  ] as [string, string][]) {
    const o = ask(q) as ShadowOutcome & { question?: string };
    assert.equal(o.kind, "clarify", q);
    assert.equal(o.question, said, q);
  }
  assert.ok(/juvenile/.test((as(ask("How do juvenile arrest rates compare to adult rates"), "decline") as { detail: string }).detail), "the decline keeps the user's word");
  // A question asked back keeps the user's age word, whatever form (Coordinator 2026-11-16): never "with a offender", never without "teen".
  for (const q of ["show me crimes with a teen offender 2017 to 2025", "teen offenders in Ohio in 2024", "kid offenders in Ohio in 2024", "teenager offenders in Ohio in 2024",
    "children victims in Ohio in 2024", "juvenile victims in Ohio in 2024", "show me crimes with a kid offender",
    // "by", "committed by" and "against" an age group (QL-ct-cbfbd38920, QL-nibrs-7c3023629c), and the two murder forms.
    "What percent of car thefts are committed by kids under the age of 18 in the last 7 years?", "Show me crimes by juveniles YOY for the last 10 years",
    "show me crimes against teens", "show me crimes committed by teens", "crimes in Ohio committed by teens?", "murders of teenagers in Chicago", "children murdered in Chicago"])
    assert.equal((as(ask(q), "clarify") as { question: string }).question, q, q);
  // A rate for an age group has no population base and is declined (existing rule); the plural word is read.
  assert.match(as(ask("Murder rate for teenagers in Chicago since 2019"), "decline").explanation, /^A rate for a group of people needs population figures/);
}
// Scorecard 2026-11-16, groups 1 and 2: a "why", an effect, "safest" and a state's clearance rate are declined before a place is asked (P13, P18,
// the explanation rule); the nation as "the us", "us", "U.S" and "American", and San Francisco as "SF", "SFPD" and "San fran", are places.
{
  const declined = (q: string) => as(ask(q), "decline");
  const WHY = "The data shows how many crimes were reported; it can't say why they rose or fell.";
  for (const q of ["Why is murder falling?", "What's the effect of politics on violent crime?", "What factors correlate with higher violent crime?", "Why do people commit crime?",
    "Effect of politics on hate crime", "tell me about how marijuana legalization has affected crime?"]) {
    const d = declined(q);
    assert.equal(d.reason, "explanation_requested", q);
    assert.ok(d.explanation.startsWith(WHY), q);
  }
  for (const q of ["safest city in the us", "safest city in 2023", "most dangerous city in 2024"])
    assert.ok(declined(q).explanation.startsWith("There's no agreed definition of safest or most dangerous; ask for a specific offense and a count or rate."), q);
  // P172 (Jeff 2026-11-21, reversing P18): one state's clearance rate is answered; every state at once is not, and says what to ask.
  {
    const d = declined("clearance rates by state");
    assert.equal(d.reason, "not_recorded_in_nibrs");
    assert.match(d.explanation, /^A clearance rate for every state at once isn't available\./);
    assert.equal((ask("What is the homicide clearance rate in Kansas?") as { about?: string }).about, "which period", "a state's clearance rate with no year asks the year");
  }
  // Not changed: a number asked with a trailing "why" is answered and the why declined; a state's NIBRS-only clearance rate keeps its own sentence.
  assert.notEqual((ask("murders in Houston in 2024 and why?") as { reason?: string }).reason, "explanation_requested");
  assert.match(as(ask("Carjacking clearance rate in Texas in 2024"), "decline").explanation, /state clearance rate for a NIBRS-only offense.*not decided/);
  const placed = (q: string) => { const o = ask(q) as { kind: string; about?: string }; assert.ok(!(o.kind === "clarify" && /^which (?:place|LA)/.test(o.about ?? "")), `${q}: the place is read, not asked`); return o; };
  for (const q of ["us homicide trend from 1950 to 2024", "murders in the us in 2024", "American violent crime since 2018", "show me the annual number of murders in the U.S.", "murders in the U.S in 2024",
    "SF aggravated assault in 2025", "What is SFPD rape clearance rate in 2024?", "San fran agg assaults since 2018", "Sf murders in 2024"]) placed(q);
  // The pronoun is not the nation, and American Indian is not "American".
  assert.equal((ask("show us murders in 2024") as { about?: string }).about, "which place");
  assert.equal((ask("American Indian murders in 2024") as { about?: string }).about, "which place");
  // PR 195 run: a national city ranking with no year asks the year (P05), never "a state or the nation together with other places";
  // "the annual number of murders" is by year (P06); a "why" about the data (no crime named) is not an explanation decline.
  const hdeps = { ...deps, execute: () => [], historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  for (const q of ["what city has the highest murder rate in the us?", "which cities had the most murders nationwide?", "show me the top 10 cities with the highest murder in the us"])
    assert.equal(as(shadowAnswer(q, hdeps), "clarify").about, "which period", q);
  assert.ok(!/number of/.test(readQuestion("show me the annual number of murders in the us", 2026).text), "read as annual murders, a series by year");
  // A question about the data itself is answered from the release's agency lists (Jeff 2026-11-18, test-nibrs-coverage.ts), no longer asked "which place".
  assert.equal(shadowAnswer("why can't you tell me which states are not represented?", { ...deps, execute: () => [] }).kind, "coverage");
}
// P10 (Jeff 2026-11-16): "all homicides" adds justifiable homicide (09C) in NIBRS and says what it counted; on Crime Index it
// is the murder count with no disclaimer.
assert.deepEqual(MEASURE_CODES.homicide_all, ["09A", "09B", "09C"]);
{
  const sqlOf = (q: string) => { sqls.length = 0; const o = ask(q); return { o, codes: (sqls[0]?.match(/'(09[ABC])'/g) ?? []).join(",") }; };
  const plain = sqlOf("homicides in Houston in 2024 by month"), every = sqlOf("all homicides in Houston in 2024 by month"), murder = sqlOf("murders in Houston in 2024 by month");
  assert.equal(plain.codes, "'09A','09B'");
  assert.equal(every.codes, "'09A','09B','09C'");
  assert.equal(murder.codes, "'09A'");
  const everyText = (as(every.o, "answer") as { delivered: { text: string[] } }).delivered.text;
  assert.ok(everyText.includes("All homicides are murder and nonnegligent manslaughter, negligent manslaughter and justifiable homicide."), everyText.join(" | "));
  assert.ok(!(as(plain.o, "answer") as { delivered: { text: string[] } }).delivered.text.some((t) => /justifiable/.test(t)));
  for (const q of ["all homicides in Texas in 2024", "all homicides in the United States in 2024"]) {
    const o = as(ask(q), "srs") as { delivered: { text: string[] } };
    assert.ok(/ murders in 2024\.$/.test(o.delivered.text[0]), `${q}: ${o.delivered.text[0]}`);
    assert.equal(o.delivered.text.length, 2, `${q}: no disclaimer, only the count and the source`);
  }
}
// Bad-decline audit root causes (coordinator 2026-11-06).
{
  // 1. A place and no crime asks which crime (D31), never "I couldn't tell what this asks"; staffing keeps its decline.
  for (const q of ["minneapolis", "texas", "Show me South Carolina data"]) {
    const o = ask(q);
    if (o.kind === "clarify") assert.equal(o.about, "which kind of crime", q);
    else assert.doesNotMatch((o as { explanation?: string }).explanation ?? "", /couldn't tell what this question asks/, q);
  }
  assert.notEqual((ask("how many cops does Houston have?") as { about?: string }).about, "which kind of crime");
  // 2. Bare shootings ask fatal or non-fatal (D14) when a choice runs; fatal and mass shootings keep their declines.
  const s = ask("Shootings in Chicago in 2024");
  if (s.kind === "clarify") {
    assert.equal(s.about, SENT);
    // Jeff 2026-11-14: the sentence is the ask and the choices are named with their sources. These deps hold no Homicide Reports,
    // so the firearm murders choice is left out and said, never offered as a button that would answer from NIBRS.
    assert.deepEqual(s.options.map((o) => o.label), ["Aggravated assault involving a firearm (NIBRS)"]);
    assert.match(s.note ?? "", /^Firearm murders isn't available for this question: /);
    assert.ok(s.options[0].continuation && s.options[0].continuation.kind !== "decline");
  } else assert.equal(s.kind, "decline");
  assert.notEqual((ask("fatal shootings in Chicago in 2024") as { about?: string }).about, SENT);
  assert.notEqual((ask("mass shootings in 2024") as { about?: string }).about, SENT);
  // Ask instead of decline (Jeff 2026-11-10, bad-declines plan clusters 1, 11, 12, 16): only a reader's decline whose
  // unread words are all filler is asked instead, and only an ask is given, never an answer.
  {
    const { fillerOnly, garbledYear } = askInsteadChecks;
    for (const t of ["scorecard", "more about", "up in", "an overview for", "look like in", "average", "side-by-side", "going up or down in"]) assert.ok(fillerOnly(t), t);
    for (const t of ["VA", "Saint Augustine", "carjackings", "tecas", "aggregating both county"]) assert.ok(!fillerOnly(t), t);
    for (const t of ["since 20210", "to 202", "back to 1`980", "in2p2t"]) assert.ok(garbledYear(t), t);
    for (const t of ["since 2021", "to 2025", "in 1995", "hi", "202 robberies"]) assert.ok(!garbledYear(t), t);
    const ANSWERS = new Set(["answer", "srs", "historical", "current"]);
    for (const q of ["Toledo crime scorecard", "Minneapolis scorecard", "is crime up in milwaukee", "What does crime look like in pierce county?", "Tell me more about crime in Pittsburgh"]) {
      const o = ask(q);
      assert.ok(!ANSWERS.has(o.kind), `${q}: never an answer`);
      if (o.kind === "clarify") assert.ok(/^which /.test(o.about), q);
      else assert.equal(o.kind, "decline", q);
    }
    // The rewrites (read no data; the tests' stub has no Crime Index build, so its crime choices can't run here):
    // the question without the filler, and the words left out that mean something, to be said (Codex 01.2).
    const { fillerRewrite, covers } = askInsteadChecks;
    assert.deepEqual(fillerRewrite("Minneapolis scorecard"), { rest: "Minneapolis", left: [] });
    assert.deepEqual(fillerRewrite("Toledo crime scorecard"), { rest: "Toledo crime", left: [] });
    // "up" is read now (P188, the trend by year over the past five years), so no filler is left to drop.
    assert.equal(fillerRewrite("is crime up in milwaukee"), null);
    // Comparison wording (Jeff 2026-11-11): "vs national average" is now read in full, the city beside the United States.
    assert.equal(fillerRewrite("Murder rate in New York City vs national average"), null);
    assert.equal(readQuestion("Murder rate in New York City vs national average", 2026, "2026-09").text, "Murder rate in New York City and the United States");
    // The question without the unread words (P74) never changes its place or period: "district" names a place smaller than an agency,
    // and the date after "with an annotation" belongs to the annotation (PR 246 gate, 2026-11-19).
    const { stripped } = askInsteadChecks;
    assert.equal(stripped("can I see violent crime rolling over 12 months for the garden district in New Orleans for 2000 to the present?"), null);
    assert.equal(stripped("national murder trend rolling over 12 months with an annotation in May 2020"), "national murder trend rolling over 12 months");
    // A word that isn't filler keeps the decline: "VA" left unread would ask about Arlington, Texas.
    assert.equal(fillerRewrite("Tell me more about crime in Arlington, VA"), null);
    assert.equal(ask("Tell me more about crime in Arlington, VA").kind, "decline");
    // The reader's rewritten text is never read again: "Midwest" would become the United States (Codex 01.1).
    assert.equal(fillerRewrite("crime in the Midwest scorecard in 2024"), null);
    assert.equal(ask("crime in the Midwest scorecard in 2024").kind, "decline");
    // Peers (Jeff 2026-11-21: no partial answers): never the place alone; the reader's decline, which asks for the agencies to compare.
    for (const q of ["Crime trends in Philadelphia compared to similar cities", "i want to know how crime in nashville compares to peer cities"]) {
      const o = ask(q);
      assert.ok(o.kind === "decline" && /Name the agencies to compare instead/.test(o.explanation), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
    }
    for (const q of ["Do you have any data for NYC?", "Do we have data for the United States?", "does Olathe KS report NIBRS data?"]) assert.ok(covers(q), q);
    for (const q of ["Did Los Angeles have more homicides than ny city?", "has violent crime in baltimore gone down", "Show me the crime data for Jersey Village, Texas"]) assert.ok(!covers(q), q);
    // With no place, the crime is asked (no data needed): the ask is given, never an answer.
    // Both crime and place missing: the place is asked first (Jeff 2026-11-14); a place named asks the crime.
    assert.equal((ask("national crime scorecard") as { about?: string }).about, "which kind of crime");
    // Peers with no place named are declined for the peers, never asked for a place first (P187, no partial answers).
    for (const q of ["Crime trends compared to similar cities", "murders compared to peer cities"]) {
      const o = ask(q);
      assert.ok(o.kind === "decline" && /Name the agencies to compare instead/.test(o.explanation), `${q}: ${JSON.stringify(o).slice(0, 300)}`);
    }
    // The shootings ask never leaves out an average (Codex 01.2).
    assert.notEqual((ask("shootings in Chicago in 2025 average") as { about?: string }).about, SENT);
    // A question about what data there is is never asked about a crime instead (Codex 01.4: "do we have").
    for (const q of ["Do you have any data for NYC?", "does Olathe KS report NIBRS data?", "do you have shootings data", "Do we have data for the United States?"]) assert.notEqual(ask(q).kind, "clarify", q);
    // A year that can't be read: the years are asked.
    for (const q of ["San Diego, California murders since 20210", "Can I see gun crimes in each month in Boston from 2022 to 202"]) {
      const o = ask(q);
      assert.ok(o.kind === "clarify" && o.about === "which years" && o.options.length === 1 && !!o.options[0].entry, q);
    }
    // A named crime with peers keeps its decline (the ask is only for the crime type).
    assert.notEqual(ask("robberies in Philadelphia compared to similar cities in 2024").kind, "clarify");
    // Rankings PR A (coordinator 2026-11-11; job S4): a set never turns a capability decline into a place ask, and the
    // reader's unread words alone don't stop the place being asked as before.
    assert.equal(ask("Chart domestic violence calls over time in the four largest cities in the country").kind, "decline");
    assert.equal((ask("homicide totals in top 15 cities") as { about?: string }).about, "which place");
    // No place: the whole country's ask (the period), said (Jeff 2026-11-11).
    // (With Crime Index's history, as deployed: the cities of 250,000 or more are a set from Crime Index, P128.)
    const withHistory = { ...deps, execute: () => [], historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 } } as unknown as ShadowDeps;
    assert.equal((shadowAnswer("Other large cities and violent crime", withHistory) as { about?: string }).about, "which period");
  }
  // 3. A crime named once per place is one crime.
  const sp = (q: string) => (matchNibrsType(readQuestion(q, 2026, "2026-09").ledger, { allowExplanation: false } as never) as { spec?: { measures: string[] } }).spec;
  assert.deepEqual(sp("Ohio murder rate vs Louisiana murder rate per year")?.measures, ["murder"]);
  // Drug offenses are the crime, not "drug" unread before the counting unit.
  assert.ok(readQuestion("drug offenses in Ohio in 2024", 2026, "2026-09").ledger.parts.some((p) => p.concept === "measure" && p.value === "drug_possession"));
  // The District of Columbia is Washington, D.C., never a district inside a city; a police district still is.
  assert.equal(JSON.stringify(ask("murders in the District of Columbia in 2024")), JSON.stringify(ask("murders in Washington, D.C. in 2024")));
  assert.match((ask("robberies by police district in Chicago") as { explanation?: string }).explanation ?? "", /below the level of an agency/);
  // Places grouped by politics are named plainly, once.
  const e = as(ask("murder rates in red states vs blue states in 2024"), "decline");
  assert.equal((e.explanation.match(/no election results/g) ?? []).length, 1);
}
{
  // Several states, or a state beside the nation, side by side from the historical file (answerSrsSeveral).
  const r = answerSrsSeveral({ measure: "murder", from: 2020, to: 2021, byYear: true, statistic: "rate", comparison: null }, [{ kind: "state", code: "OH" }, { kind: "national" }]);
  assert.equal(r.kind, "srs");
  if (r.kind === "srs") {
    assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Year", "Ohio: murders per 100,000", "United States: murders per 100,000"]);
    assert.equal(r.delivered.table.rows.length, 2);
    assert.equal(r.meaning.places.length, 2);
  }
  assert.equal(answerSrsSeveral({ measure: "murder", from: 2020, to: 2021, byYear: false, statistic: "count", comparison: { earlier: 2020, later: 2021 } }, [{ kind: "state", code: "OH" }, { kind: "national" }]).kind, "srs-decline", "a change is one place at a time");
  // Codex root-causes review 01: combined places and a count beside a rate keep the decline; "police shootings" and
  // "shooting incidents" are never rewritten as firearm murders or assaults.
  for (const q of ["murders in Ohio and Texas combined in 2024", "Ohio murder count vs Texas murder rate in 2024", "How many murders in Ohio vs Texas murder rate in 2024", "Ohio murder counts vs Texas murder rates in 2024"]) assert.notEqual(ask(q).kind, "srs", q);
  for (const q of ["police shootings in Chicago in 2024", "shootings of sheriffs in Chicago in 2024"]) assert.notEqual((ask(q) as { about?: string }).about, SENT, q);
  // Jeff 2026-11-14 (D14): "shooting incidents" and "people shot" are asked like "shootings"; the choices name what they count.
  for (const q of ["shooting incidents in Houston", "people shot in Dallas"]) assert.equal((ask(q) as { about?: string }).about, SENT, q);
}
// A bare "assault" (coordinator 2026-11-06): read, never "I couldn't tell what this asks"; Crime Index and Current Trends
// answer aggravated assault, named; NIBRS asks which kind, offering only kinds that run.
{
  const parts = readQuestion("San Francisco assaults per month", 2026, "2026-09").ledger.parts;
  assert.ok(parts.some((p) => p.concept === "measure" && p.value === "assault"), "\"assaults\" is read");
  const o = ask("San Francisco assaults per month") as { kind: string; about?: string; explanation?: string; delivered?: { text: string[] }; options?: { label: string }[] };
  assert.doesNotMatch(o.explanation ?? "", /couldn't tell what this question asks/);
  if (o.kind === "current" || o.kind === "historical" || o.kind === "srs") assert.match(o.delivered!.text[0], /aggravated assaults/);
  // Asked which kind, or first what else is missing (here the period, where Current Trends isn't loaded).
  else if (o.kind === "clarify" && o.about === "which assaults") assert.ok(o.options!.every((x) => /^(?:Aggravated assault|Simple assault|Intimidation|All assaults)/.test(x.label)));
  else if (o.kind === "clarify") assert.match(o.about ?? "", /period|years/);
  for (const [q, v] of [["intimidation in Houston in 2024", "intimidation"], ["all assaults in Houston in 2024", "assault_offenses"], ["simple assaults in Houston in 2024", "simple_assault"],
    ["aggravated assaults in Houston in 2024", "aggravated_assault"]] as const)
    assert.ok(readQuestion(q, 2026, "2026-09").ledger.parts.some((p) => p.concept === "measure" && p.value === v), q);
  assert.deepEqual(MEASURE_CODES.assault_offenses, ["13A", "13B", "13C"]);
  assert.deepEqual(MEASURE_CODES.intimidation, ["13C"]);
  // Codex ties/P75 review 01: "assault offenses" is all three, never "offenses" read as the unit; a weapon is not a crime;
  // the user's own words survive the rewrite ("during an argument" keeps its circumstance).
  assert.ok(readQuestion("assault offenses in Houston in 2024", 2026, "2026-09").ledger.parts.some((p) => p.concept === "measure" && p.value === "assault_offenses"));
  for (const q of ["assault rifle in Houston in 2024", "assault weapons in Houston in 2024"])
    assert.ok(!readQuestion(q, 2026, "2026-09").ledger.parts.some((p) => p.concept === "measure" && p.value === "assault"), q);
  assert.equal(JSON.stringify(ask("assaults during an argument in Houston in 2024")), JSON.stringify(ask("aggravated assaults during an argument in Houston in 2024")));
  // Codex ties/P75 review 02: a misspelling the reader corrects keeps the user's other words too.
  assert.equal(JSON.stringify(ask("assualts during an argument in Houston in 2024")), JSON.stringify(ask("assaults during an argument in Houston in 2024")));
  // Scorecard 2026-11-06: an "assault" already qualified earlier in the question is left alone; the rewrite is made
  // once, never again on its own result (these ran without end); a decline is of the user's words.
  for (const q of ["What is the count of felony assaults and simply assaults in New York City between 2018 and 2025",
    "Can you return the murder-to-robbery, robbery-to-aggravated assault, and murder-to-assault ratios for St. Louis, MO; Chicago, IL; Los Angeles, CA; Memphis, TN; and New Orleans, LA for the years 2010 to 2025?"]) {
    const o = ask(q) as { kind: string; alternative?: { question?: string } | null };
    assert.equal(o.kind, "decline", q);
    assert.doesNotMatch(o.alternative?.question ?? "", /\b(?:of|in) (?:and|or)\b|aggravated aggravated/, q);
  }
  // Something else missing comes first (labels: which place, which period, which New York); a period button is the
  // user's question with the period, so Crime Index answers aggravated assaults.
  assert.equal((ask("breakdown of weapons used in assaults 2024") as { about?: string }).about, "which place");
  const nc = ask("Assault in North Carolina") as { kind: string; about?: string; options?: { label: string; continuation?: { kind: string; delivered?: { text: string[] } } }[] };
  assert.equal(nc.about, "which period");
  const latest = nc.options!.find((o) => /^The latest complete year/.test(o.label))!.continuation!;
  assert.equal(latest.kind, "srs");
  assert.match(latest.delivered!.text[0], /aggravated assaults/);
  assert.equal((ask("What's the assault trend in New York over the past 5 years?") as { about?: string }).about, "which New York");
  // Two choices in a row (Codex ties review 03): "assaults" -> The United States -> a year answers.
  type C = { kind: string; options?: { label: string; continuation?: C }[] };
  const us = (ask("assaults") as C).options?.find((o) => o.label === "The United States")?.continuation;
  if (us?.kind === "clarify") assert.ok(us.options!.some((o) => o.continuation && ["srs", "current", "answer"].includes(o.continuation.kind)), "a year answers after the nation");
  const opts =(q: string) => JSON.stringify((ask(q) as { options?: unknown }).options);
  assert.equal(opts("uncleared assualts in Houston in 2024"), opts("uncleared assaults in Houston in 2024"));
  assert.match(opts("uncleared assualts in Houston in 2024"), /not cleared/);
}
// Officers as victims are declined by name, never answered with the total (coordinator 2026-11-05); agencies and people
// killed by police are not officers as victims.
for (const q of ["murders of sheriffs in King County, Washington in 2024", "murders of King County sheriffs in Washington in 2024",
  "how many officers were killed in action", "assaults on police officers in Chicago in 2024", "police officers killed in Texas in 2023",
  "how many officers were shot in 2024", "officers shot in Chicago in 2024", "police deaths in 2024", "Homicides of police in the line of duty",
  "murders with sheriffs as victims in King County, Washington in 2024", "murders in King County, Washington in 2024 with sheriff victims",
  "police officers shot dead in Chicago in 2024", "officers shot and killed in Chicago in 2024",
  "murders with sheriffs killed with firearms in King County, Washington in 2024", "officers killed by gunfire in 2024",
  "assaults on police officers in Chicago by zip code in 2024"]) {
  const d = as(ask(q), "decline");
  assert.equal(d.explanation, "We don't have LEOKA data (officers killed and assaulted).", q);
  assert.equal(d.alternative, null, q);
  assert.equal(jargon(d.explanation).length, 0, q);
}
for (const q of ["murders in King County Sheriff's Office, Washington in 2024", "murders for Baltimore Police Department in 2024", "assaults on women by police in 2024", "officers shot 10 people in Chicago in 2024", "officers killed 10 people in Chicago in 2024", "officers shot and killed a suspect in Chicago in 2024", "officers killed five suspects in Chicago in 2024"])
  assert.doesNotMatch((ask(q) as { explanation?: string }).explanation ?? "", /LEOKA/, q);
// P96 (Jeff 2026-11-06): a crime rate month by month is answered, each month's count per 100,000, not annualized; a
// clearance rate by month is still declined, with the whole period's and the counts by month as buttons.
{
  const o = ask("robberies rate in Memphis in 2025 by month") as { kind: string; explanation?: string; delivered?: { table: { columns: { header: string }[] }; text: string[] } };
  assert.doesNotMatch(o.explanation ?? "", /not for one month or month by month|whole years, not single months/);
  if (o.delivered) {
    assert.match(o.delivered.table.columns[1].header, / per 100,000 for the month$/);
    assert.ok(!o.delivered.text.some((t) => /not scaled to a full year/.test(t)), "P145: a rate needs no note saying what it is");
    assert.doesNotMatch(o.delivered.text.join(" "), /\bresidents?\b/i, "never \"residents\" in what a user reads");
  }
  const d = as(ask("murder clearance rate by month in Chicago in 2024"), "decline");
  assert.equal(d.explanation.split(" For example")[0], "Clearance rates are given for a whole year, not month by month.");
  // The question type no longer declines a crime rate by month (P96); a clearance rate by month it still does.
  const ty = (q: string) => matchNibrsType(readQuestion(q, 2026, "2026-09").ledger, { allowExplanation: false } as never).kind;
  assert.notEqual(ty("carjacking rate in Houston by month in 2024"), "decline");
  assert.equal(ty("murder clearance rate by month in Chicago in 2024"), "decline");
  // A population column asked beside monthly rates: NIBRS gives it (P72); Current Trends says it isn't built, never drops it.
  const ctCol = ask("Murder rate in Chicago by month in 2025, with a column showing the population used to calculate the rate") as { kind: string; explanation?: string };
  if (ctCol.kind === "decline") assert.match(ctCol.explanation ?? "", /population column/);
  else assert.notEqual(ctCol.kind, "current");
}

// A place's state is its postal code, never an ORI prefix (coordinator 2026-11-03: Nebraska's agencies are "NB...").
assert.ok([...places.byName.values()].flat().every((x) => x.state in STATE_NAMES), "every agency's state is a postal code");
assert.equal(ori(at("city:Omaha:NE", "Omaha, NE")), "NB0280200");
assert.equal(agencyLabel(places.byName.get("omaha")![0]), "Omaha, Nebraska");
assert.ok(agencyPopulationSql("r", { state: "NE", city: true }, [2024]).includes("IN ('NE', 'NB')"), "a state's city agencies under every header code");
assert.ok(places.byName.get("new york city")!.every((x) => x.ori === "NY0303000"));

// Shared decline wording (coordinator 2026-11-03, Historical step one causes 3 and 7): a place the index doesn't have
// says so, never P01's "figures don't answer"; asks outside the data name their limit; the nation is "the United States"
// in an offered question, never "in nationwide".
{
  // Every agency is in the index (no population floor, Jeff 2026-11-03), so the place is taken out of a copy of it.
  const noEcorse = { ...places, byName: new Map([...places.byName].filter(([k]) => k !== "ecorse")) };
  const unfound = as(shadowAnswer("Murders in Ecorse, Michigan in 2020", { ...deps, places: noEcorse }), "decline");
  assert.equal(unfound.reason, "unresolved_place");
  assert.match(unfound.explanation, /^I couldn't find "Ecorse, Michigan" among the city and county police agencies, states and the nation here\./);
  assert.equal(at("city:Ecorse:MI", "Ecorse, Michigan").kind, "agency", "a town of under 10,000 people is in the index");
  assert.doesNotMatch(unfound.explanation, /don't answer this question/);
  const outside: [string, RegExp][] = [
    ["Memphis crime on a map", /^Maps aren't available here/],
    ["US population per year since 1960", /^Population is answered on its own for an agency, a state or the nation/], // without the Crime Index build
    ["Can you give me a list of Hawaii law enforcement agencies ordered by population covered in 2024?", /^A list of agencies/],
    ["How common is cybercrime in New Hampshire?", /^Cybercrime isn't one category/],
    ["Thefts on college campuses in New Jersey in 2020", /^College and university police agencies/],
    ["Can I see a data set of all crimes by type across the US from 2020 to present", /^A whole data set isn't available here/],
  ];
  for (const [q, re] of outside) assert.match(as(ask(q), "decline").explanation, re, q);
  assert.equal(ask("College Station robberies in 2024").kind !== "decline" || !/College and university/.test((ask("College Station robberies in 2024") as { explanation: string }).explanation), true, "a place named College is not a campus");
  assert.ok(ask("Memphis population and robbery rate in 2023").kind === "decline" ? !/^Population is answered on its own/.test((ask("Memphis population and robbery rate in 2023") as { explanation: string }).explanation) : true, "population beside a crime is not the population-only limit");
  const nation = as(ask("show homicides and total violent crimes nationwide by year for 2000 to 2025"), "decline");
  assert.doesNotMatch(nation.explanation + (nation.alternative?.question ?? ""), /\bin nationwide\b/);
}

// An answer: the plan, the compiled read, the delivered table and text (source statement last, D30).
const a = as(ask("How many shoplifting offenses were there in Memphis in 2023?"), "answer");
assert.deepEqual(a.period, { from: "2023-01", to: "2023-12" });
assert.equal(a.plan.measures[0].id, "offenses.shoplifting");
assert.ok(sqls.at(-1)!.includes("'TNMPD0000'") && sqls.at(-1)!.includes("'23C'"));
assert.deepEqual(a.delivered.table.rows, [[84]]);
assert.equal(a.delivered.text[0], "Memphis had 84 shoplifting offenses in 2023.");
assert.equal(a.delivered.text.at(-1), "Source: FBI NIBRS.", "P63: the source, plainly");
assert.deepEqual(a.delivered.contractProblems, []);
assert.equal(a.delivered.chart, null);

// A monthly series with an unknown month: blank, named as missing (D04), never zero.
const m = as(ask("Shoplifting in Memphis by month in 2024"), "answer");
assert.equal(m.delivered.table.rows.length, 12);
assert.deepEqual(m.delivered.table.rows[2], ["2024-03", null]);
assert.ok(m.delivered.text.includes("No data is available for March 2024: shown blank, not zero."));
assert.deepEqual(m.delivered.chart, { kind: "line", x: "Month", y: ["Shoplifting offenses"] });
assert.deepEqual(m.delivered.contractProblems, []);

// P11: victims of a property crime are offenses, with the fixed sentence before the source.
const v = as(ask("How many shoplifting victims were there in Memphis in 2024?"), "answer");
assert.equal(v.plan.measures[0].unit, "offense");
// P86: carried, not shown (the title says "offenses").
assert.equal(v.delivered.text.at(-2), "Property crimes are counted by offense, not by victim.", "P86: shown, since victims were asked for");
// Person crimes stay by victim (D18); carjacking is counted by offense (D18).
assert.equal(as(ask("How many simple assaults were there in Detroit in 2023?"), "answer").plan.measures[0].id, "victims.simple_assault");
const cj = as(ask("carjackings in Memphis TN by month in 2025"), "answer");
assert.deepEqual([cj.plan.measures[0].id, cj.plan.measures[0].unit], ["offenses.carjacking", "offense"]);

// D31: a missing place, period or crime is asked about; each fixed option runs the question with that choice filled in.
const noPlace = as(ask("How many shoplifting offenses were there in 2024?"), "clarify");
assert.deepEqual(noPlace.options.map((o) => o.label), ["The United States", "A state", "A city or agency"]);
// Increment 5: the nation's shoplifting is summed over the agencies that reported (P61), with the button.
const usShop = as(noPlace.options[0].continuation!, "answer");
assert.ok(usShop.stateSum && usShop.buttons?.length === 1 && usShop.delivered.text.includes("Includes all agencies.") && !usShop.delivered.text.some((t) => /counts reported to NIBRS|territories/.test(t)));
assert.equal(noPlace.options[1].entry, "which state");
const noPeriod = as(ask("Shoplifting in Memphis"), "clarify");
assert.deepEqual(noPeriod.options.map((o) => o.label), ["The latest complete year (2025)", "This year so far", "Another year"]);
assert.deepEqual(as(noPeriod.options[0].continuation!, "answer").period, { from: "2025-01", to: "2025-12" });
const ytd = as(noPeriod.options[1].continuation!, "answer");
assert.deepEqual(ytd.period, { from: "2026-01", to: "2026-09" });
assert.ok(ytd.delivered.text.includes("The data runs through September 2026: this covers January through September 2026."), "D06: the months covered are named");
// All years by default (Jeff 2026-11-11): a trend with no range is answered for every month in the data, not asked.
assert.deepEqual(as(ask("Carjackings in Memphis by month"), "answer").period, { from: "2017-01", to: "2026-09" });
// No Historical build here: no crime-kind button could run, so a plain decline, never dead buttons (coordinator 2026-11-02).
assert.match(as(ask("How many crimes were there in Detroit in 2024?"), "decline").explanation, /^This isn.t available here\./, "no source that is not loaded is named");
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
// The place is chosen, then every month in the data (all years by default, Jeff 2026-11-11).
const stlCity = as(stl.options[0].continuation!, "answer");
assert.equal((stlCity.plan.geography.places[0] as { ori: string }).ori, "MOSPD0000");
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
  "Detroit had 84 drug/narcotic violation offenses and 84 drug equipment violation offenses in 2023.", "Reported by the Detroit Police Department.", "Together: 168 drug crimes in 2023."]);
assert.deepEqual(drugs.delivered.contractProblems, []);
assert.equal(as(ask("Drug possession in Detroit in 2023"), "answer").plan.measures.length, 1, "drug possession itself is one measure");
// A combined total is given only when every part is known (March 2024 is unknown in the stub).
const drugsMonth = as(ask("Drug crimes in Detroit in 2024"), "answer");
assert.ok(drugsMonth.delivered.text.includes("No combined total of drug crimes is given: the available evidence does not establish every part."));
assert.ok(!drugsMonth.delivered.text.some((t) => /^Together/.test(t)));
// Drug crimes by year (Jeff 2026-11-15): each part per year plus the total as a third column, "Drug crimes together".
const drugsYears = as(ask("Drug crimes in Detroit from 2021 to 2023"), "answer");
assert.deepEqual(drugsYears.delivered.table.columns.map((c) => c.header), ["Year", "Drug/narcotic violation offenses", "Drug equipment violation offenses", "Drug crimes together"]);
assert.equal(drugsYears.delivered.text[0], "Drug crimes are drug/narcotic violations plus drug equipment violations.");
assert.deepEqual(drugsYears.delivered.contractProblems, []);
// Marijuana (Jeff 2026-11-15): "Marijuana possession arrests", with one line saying what is counted.
const weed = as(ask("marijuana possession arrests in Texas in 2024"), "answer");
assert.deepEqual(weed.delivered.table.columns.map((c) => c.header), ["Marijuana possession arrests"]);
assert.ok(weed.delivered.text.includes("Counts arrests on incidents where marijuana was recorded among the drugs."));
// Violent crime by age (Jeff 2026-11-15): NIBRS crimes against persons for the victim or the offender, with the line saying so.
for (const [q, who] of [["violent crimes by victim age in Detroit in 2023", "victims"], ["violent crimes by offender age in Detroit in 2023", "offenders"]] as const) {
  const raw = ask(q);
  if (raw.kind !== "answer") console.error("VCAGE", q, JSON.stringify(raw).slice(0, 700));
  const o = as(raw, "answer");
  assert.equal(o.plan.measures[0].id, `${who}.person_crimes`, q);
  assert.ok(o.delivered.text.includes("Counts NIBRS crimes against persons: homicide, kidnapping, sex offenses, assault, intimidation and human trafficking."), q);
  assert.ok(!o.delivered.text.some((t) => /robber/i.test(t)), "robbery is not named");
  assert.deepEqual(o.delivered.contractProblems, [], q);
}
{
  const ask2 = as(ask("violent crimes by age in Detroit in 2023"), "clarify");
  assert.deepEqual(ask2.options!.map((o) => o.label), ["Offender", "Victim"], "Jeff's words on this ask");
  assert.equal(as(ask2.options![0].continuation!, "answer").plan.measures[0].id, "offenders.person_crimes");
  assert.equal(as(ask2.options![1].continuation!, "answer").plan.measures[0].id, "victims.person_crimes");
  assert.deepEqual(as(ask("murders by age in Detroit in 2023"), "clarify").options!.map((o) => o.label), ["Victims", "Offenders"], "other questions keep their own buttons");
}
// Time of day (Jeff 2026-11-15): the incident's hour in four buckets, the line saying which hours each holds.
{
  const before = sqls.length;
  ask("Robberies in Detroit by time of day in 2023");
  const sql = sqls.slice(before).find((x) => /ih\.incident_hour/.test(x));
  assert.ok(sql, "the query groups the incident's hour");
  assert.ok(/BETWEEN 6 AND 11 THEN 'Morning'/.test(sql!) && /BETWEEN 0 AND 5 THEN 'Night'/.test(sql!), "the buckets are 6-11, 12-17, 18-23 and 0-5");
}
// Violent crime by age nationally over several years is too large to count here: declined in words, never run (BD3 out-of-memory).
{
  const before = sqls.length;
  const d = as(ask("show me nationwide violent crimes by victim age by year for 2017 to 2025"), "decline");
  assert.match(d.explanation, /violent crime in the United States broken down by victim age over several years takes too long to count here/);
  assert.equal(sqls.slice(before).filter((x) => /person_crimes|victim_offense/.test(x) && /GROUP BY/.test(x) && /victim/.test(x)).length, 0, "nothing heavy is run");
}
// Property crime by an offender's age nationally over several years: the same, declined up front (never a pointer elsewhere), never run, also
// from a question with no place (the runner's QL-shr-349398af53 computed it for 5 minutes before asking which place). One year, a state still answer.
{
  const before = sqls.length;
  const d = as(ask("property crime offenders by age by year 2019 to 2025 for the United States"), "decline");
  assert.equal(d.explanation, heavyNationalSentence("property crime", "offender age", 2025));
  assert.equal(d.explanation, `This isn't available: property crime in the United States broken down by offender age over several years takes too long to count here. Ask for one year, for example "nationwide property crime by offender age in 2025", or for one state.`);
  assert.doesNotMatch(d.explanation, /Savant|in chat|\byet\b/i);
  const asked = ask("annual counts of offenders by age from 1986 through 2025");
  assert.equal(asked.kind, "clarify");
  assert.equal(sqls.slice(before).filter((x) => /'23H'/.test(x) && /offender/.test(x)).length, 0, "no national property-crime statement is run, before or instead of the ask");
  assert.equal(as(ask("property crime offenders by age in the United States in 2024"), "answer").kind, "answer");
  assert.equal(as(ask("property crime offenders by age by year 2019 to 2025 in Texas"), "answer").kind, "answer");
}
// Heavy national choices are built when chosen (speed plan option C, 2026-11-17): the national statements of a place-less ask are not run before
// the ask is shown; the choice that is clicked answers exactly as the eager one did; a plan a guard declines is still never offered.
{
  const heavy = { ...deps, deferChars: 5000 }; // the stub's plan statements are far longer than its header lookups: only they count as heavy here
  const q = "Carjackings in 2024";
  const before = sqls.length;
  const lazy = as(shadowAnswer(q, heavy), "clarify");
  const us = lazy.options.find((o) => o.label === "The United States")!;
  assert.ok(us && isDeferred(us), "the national choice is offered unbuilt");
  assert.equal(sqls.slice(before).filter((x) => /unnest\(\[|WITH units AS/.test(x)).length, 0, "no statement of the national plan ran to offer it: " + sqls.slice(before).filter((x) => /unnest\(\[|WITH units AS/.test(x)).map((x) => `${x.length} chars: ${x.slice(0, 120)}`).join(" || "));
  const eagerAsk = as(shadowAnswer(q, deps), "clarify");
  const usEager = eagerAsk.options.find((o) => o.label === "The United States")!;
  assert.ok(!isDeferred(usEager), "without a heavy statement it is built as before");
  const mark0 = sqls.length;
  const built = us.continuation!, same = usEager.continuation!;
  assert.equal(built.kind, same.kind, "chosen, it answers as the eager one did");
  if (built.kind === "answer" && same.kind === "answer") assert.deepEqual(built.delivered.table.rows, same.delivered.table.rows);
  assert.ok(sqls.length >= mark0, "its statements run when it is chosen");
  // The preview lists it without building it.
  const again = as(shadowAnswer(q, heavy), "clarify");
  const mark = sqls.length;
  const pv = toPreview(again, [], places, q);
  assert.equal(sqls.slice(mark).filter((x) => /unnest\(\[|WITH units AS/.test(x)).length, 0, "listing the buttons builds nothing");
  assert.ok(pv.kind === "clarify" && pv.buttons.some((b) => b.label === "The United States" && b.kind === "continuation"));
  // Walking an outcome (JSON, Object.keys, for-in, spread, structuredClone) never builds a deferred choice, and reading one never throws.
  {
    const walk = as(shadowAnswer(q, heavy), "clarify");
    const m = sqls.length;
    const isPlan = (x: string) => /unnest\(\[|WITH units AS/.test(x);
    JSON.stringify(walk); Object.keys(walk.options[0]); for (const o of walk.options) { for (const k in o) void k; void { ...o }; Object.keys(o); }
    structuredClone(JSON.parse(JSON.stringify(walk)));
    try { structuredClone(walk.options.map((o) => ({ ...o }))); } catch { /* functions in other fields are not this test's concern */ }
    assert.equal(sqls.slice(m).filter(isPlan).length, 0, "walking an outcome runs no plan statement");
    const boom = { ...heavy, execute: (sql: string) => { if (isPlan(sql)) throw new Error("boom"); return deps.execute(sql); } };
    const broken = as(shadowAnswer(q, boom), "clarify").options.find((o) => o.label === "The United States")!;
    assert.ok(isDeferred(broken));
    const c = broken.continuation!;
    assert.equal(c.kind, "decline", "a failing deferred answer reads as a decline, not an exception");
    assert.equal(broken.continuation, c, "and is remembered");
  }
  // A plan a guard declines never reaches a statement: it is not offered at all (the national choice of the P122 question).
  const guarded = as(shadowAnswer("annual counts of offenders by age from 1986 through 2025", heavy), "clarify");
  assert.ok(!guarded.options.some((o) => o.label === "The United States"), "a guard-declined plan is dropped as a dead button, not deferred");
}
// Codex review of the group-4 branch: the explicit units get the person-crimes definition, race and sex keep theirs, and a
// carjacking incident by time of day has its join.
for (const [q, id] of [["violent crime victims by age in Detroit in 2023", "victims.person_crimes"], ["violent crime offenders by age in Detroit in 2023", "offenders.person_crimes"]] as const)
  assert.equal(as(ask(q), "answer").plan.measures[0].id, id, q);
for (const q of ["violent crimes by offender race in Detroit in 2023", "violent crimes by offender sex in Detroit in 2023"]) {
  const o = ask(q);
  if (o.kind === "answer") assert.ok(!/person_crimes/.test(o.plan.measures[0].id), `${q}: race and sex keep the four-crime definition`);
}
{
  const before = sqls.length;
  ask("Carjacking incidents by time of day in Detroit in 2023");
  const sql = sqls.slice(before).find((x) => /ih\.incident_hour/.test(x));
  assert.ok(sql && /LEFT JOIN .* ih ON/.test(sql), "the hour join is in the carjacking incident query");
}
// Property crime by a victim's age (Jeff 2026-11-15): victims of NIBRS crimes against property, the short line, Unknown for non-persons.
{
  const o = as(ask("property crimes by victim age in Detroit in 2023"), "answer");
  assert.equal(o.plan.measures[0].id, "victims.against_property");
  assert.ok(o.delivered.text.includes("Counts victims of NIBRS crimes against property, such as robbery, burglary, theft, fraud and vandalism. Businesses and other victims that are not people have no age and show as Unknown."));
  assert.deepEqual(o.delivered.contractProblems, []);
  // Other property victim counts stay by offense (P11).
  assert.equal(as(ask("burglary victims in Detroit in 2023 according to NIBRS"), "answer").plan.measures[0].id, "offenses.burglary");
  const kind = as(ask("victim age breakdown in Detroit in 2023"), "clarify");
  assert.deepEqual(kind.options.map((x) => x.label), ["Violent crime", "Property crime", "Another crime"]);
  assert.equal(kind.options[2].entry, "which crime");
  // The crime typed after "Another crime" completes the question: age, place and year kept.
  const typed = shadowFollowUp("victim age breakdown in Detroit in 2023", "murder", deps);
  const done = as(typed as ShadowOutcome, "answer");
  assert.equal(done.plan.measures[0].id, "victims.murder");
  assert.equal(done.plan.groupings.some((g) => g.dimension === "victim.age"), true);
  assert.equal(done.period.from, "2023-01");
}
{
  for (const q of ["nationwide property crimes by victim age by year for 2017 to 2025", "nationwide property crimes by victim age in 2024"]) {
    const d = as(ask(q), "decline");
    assert.equal(d.explanation, `This isn't available: property crime in the United States broken down by victim age takes too long to count here. Ask for one state, for example "property crimes by victim age in Texas in 2024", or for one agency.`, q);
    assert.ok(!/\byet\b/.test(d.explanation));
  }
}
// No question is asked when every choice ends in a refusal (D28): "Shplftg" is near no crime word, so nothing reads it.
assert.equal(as(ask("Shplftg in baltimore per month, 2021-2025"), "decline").reason, "reader");

// Codex review 1: what the slice cannot deliver is declined before anything runs or is asked; P11 covers carjacking;
// a future month is named as asked; P26 asks city or state for "New York".
// Compiler increment 2: age groups (P30), named with what each holds.
const byAge = as(ask("Simple assault victims in Detroit by age in 2023"), "answer");
assert.equal(byAge.plan.groupings[0].dimension, "victim.age");
assert.ok(!byAge.delivered.text.some((t) => /^Age groups: /.test(t)), "P86: the age groups are named by their rows, not a note");
assert.deepEqual(byAge.delivered.table.rows, [["Under 18", 15, 30], ["25-34", 20, 40], ["Unknown", 15, 30]], "P86: age order, one Unknown row last");
assert.equal(byAge.delivered.table.columns[0].binding.kind === "grouping" && "ordered" in byAge.delivered.table.columns[0] && byAge.delivered.table.columns[0].ordered, true, "P86: age groups keep their order");
assert.ok(sqls.at(-1)!.includes("WHEN v.age IN ('NN', 'NB', 'BB') THEN 'Under 18'"));
// Compiler increment 1: one delivered category, with counts, each category's share of its period, and blanks named.
const bySex = as(ask("Simple assault victims in Detroit by sex in 2023"), "answer");
assert.deepEqual(bySex.delivered.table.columns.map((c) => c.header), ["Victim sex", "Simple assault victims", "Share of all simple assault victims (%)"]);
assert.ok(!("ordered" in bySex.delivered.table.columns[0]), "categories by count are not ordered");
assert.deepEqual(bySex.delivered.table.rows, [["Female", 30, 60], ["Male", 20, 40], ["Unknown", null, null]]);
assert.ok(!bySex.delivered.text.some((t) => /^Each share is/.test(t)), "P86: the share's header says what it is");
assert.ok(bySex.delivered.text.includes("Shown blank, not zero, because reporting isn't complete: Unknown."));
// A one-period breakdown by one category is a bar chart of the count, in the table's order (Jeff 2026-11-21, issue 3).
assert.deepEqual([bySex.delivered.contractProblems, bySex.delivered.chart], [[], { kind: "bar", x: "Victim sex", y: ["Simple assault victims"] }]);
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
assert.ok(sqls.at(-1)!.includes("WHEN f2.offender_seq = '00' THEN 'U'"), "P86: no offender identified is Unknown, merged in SQL");
assert.match(as(ask("Simple assaults by women in Detroit in 2023"), "decline").explanation, /^"By" a group of people means the offenders/);
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
assert.match(as(ask("How many shooters were there in Detroit in 2023?"), "decline").explanation, /not who fired a gun, so "shooters" can.t be counted/);
// P46, P48, P50: arrests by arrest date, counted once each; "people arrested for" is arrests; "charged" is declined with
// the arrests offered.
const arr = as(ask("How many people were arrested for burglary in Detroit in 2023?"), "answer");
assert.deepEqual([arr.plan.measures[0].id, arr.plan.timeBasis, arr.delivered.answerStatements], ["arrests.burglary", "arrest_date", ["arrests_counted_once"]]);
assert.ok(sqls.at(-1)!.includes("substr(a.arrest_date, 1, 6) AS ym"));
// Job AR6: arrests for a Group B offense with a period answer from the standalone Group B arrests, by arrest date.
const dui = as(ask("DUI arrests in Detroit in 2023"), "answer");
assert.deepEqual([dui.plan.measures[0].id, dui.plan.timeBasis], ["group_b_arrests.dui", "arrest_date"]);
assert.ok(sqls.some((x) => x.includes("group_b_arrest") && x.includes("a.arrest_offense IN ('90D')")), "read from Group B arrests");
// P149: the internal unit name never reaches a reader ("DUI Group_b_arrest").
assert.ok(!dui.delivered.text.some((t) => /group_b_arrest/i.test(t)), dui.delivered.text.join(" / "));
assert.ok(/DUI arrests/i.test(dui.delivered.text[0]), dui.delivered.text[0]);
// Job AR6: gun possession is a weapon law violation (520), never drug possession; a gun as a weapon stays a condition;
// a leading "Please" keeps the every-arrest reading.
for (const q of ["gun possession arrests in Detroit in 2023", "possession of a firearm arrests in Detroit in 2023"])
  assert.equal(as(ask(q), "answer").plan.measures[0].id, "arrests.weapon_law", q);
assert.equal(as(ask("drug possession arrests in Detroit in 2023"), "answer").plan.measures[0].id, "arrests.drug_possession");
assert.equal(as(ask("robberies with a gun in Detroit in 2023"), "answer").plan.filters[0].kind, "exists");
assert.equal(as(ask("Please show me the number of arrests of people under age 18 by year in Detroit from 2020 through 2023."), "answer").plan.measures[0].id, "arrests.all_crime");
// Codex arrests review 06: a charge is never an offense count; Group B arrests are counted alone; handgun possession is
// a weapon law violation; a person's condition or breakdown on Group B arrests uses their own columns.
assert.notEqual(ask("How many gun charges in Detroit in 2023?").kind, "answer");
assert.notEqual(ask("DUI arrests involving robbery in Detroit in 2023").kind, "answer");
assert.equal(as(ask("handgun possession arrests in Detroit in 2023"), "answer").plan.measures[0].id, "arrests.weapon_law");
const juvDui = as(ask("juvenile DUI arrests in Detroit in 2023"), "answer");
assert.deepEqual([juvDui.plan.measures[0].id, juvDui.plan.filters[0]], ["group_b_arrests.dui", { kind: "attribute", dimension: "group_b_arrest.age", op: "between", values: [1, 17] }]);
assert.equal(as(ask("DUI arrests by age in Detroit in 2023"), "answer").plan.groupings.at(-1)!.dimension, "group_b_arrest.age");
// Jeff 2026-11-12 ("Yes, B then A"): every national arrest by a person's attribute over several years is declined as too
// large for now, one year offered in words (never run); one year, a crime, a state, or no breakdown still answer.
for (const q of ["show me nationwide arrests by age by year for 2021 to 2025 for consistent reporters", "show me nationwide arrests by age by year for 2015 to 2025 for consistent reporters"]) {
  const d = as(ask(q), "decline");
  assert.match(d.explanation, /takes too long to count here\. Ask for one year/, q);
  assert.ok(!d.alternative, q);
}
for (const q of ["nationwide arrests by age in 2024", "show me nationwide arrests for violent crimes by age by year for 2017 to 2025", "show me nationwide juvenile arrests 2017 to 2025", "arrests by sex by year in Texas from 2021 to 2025"])
  as(ask(q), "answer");
const charged = as(ask("How many robbery suspects were charged in Detroit in 2023?"), "decline");
// Jeff 2026-11-11, all years by default: by year / per month / a trend with no range is every year the source has, said.
const perYear = as(ask("Carjackings per year in houston"), "answer");
assert.equal(perYear.delivered.text[1], "No years were given, so every year in the data is shown: 2017 through 2025.");
const perMonth = as(ask("Houston carjackings per month"), "answer");
assert.match(perMonth.delivered.text[1], /^No years were given, so every year in the data is shown: January 2017 through September 2026\.$/);
assert.equal(as(ask("Carjackings in Detroit in 2023"), "answer").delivered.text.some((t) => /No years were given/.test(t)), false, "a period given: no note");
// Codex all-years review 01: a quarterly default stops at the latest complete year; "all years" never overrides a grain or
// a range the question names.
assert.deepEqual(as(ask("Carjackings in Memphis by quarter"), "answer").period, { from: "2017-01", to: "2025-12" });
assert.deepEqual(as(ask("Carjackings in Memphis by month for all years since 2020"), "answer").period, { from: "2020-01", to: "2026-09" });
assert.equal(ask("carjackings in Detroit").kind, "clarify", "no grain: the period is still asked");
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
assert.deepEqual(as(ask("Shoplifting in Memphis by month"), "answer").period, { from: "2017-01", to: "2026-09" }, "all years by default (Jeff 2026-11-11)");

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
// (All years by default: a trend now answers once the place is chosen, so a question with no grain is the path here.)
const stl0 = as(ask("St Louis carjackings"), "clarify");
const stlCase = label({ action: "clarify", about: "which St. Louis", options: [
  { label: "St. Louis city, Missouri", leads_to: "clarify", meaning: null, next_about: "which period" },
  { label: "St. Louis County, Missouri", leads_to: "clarify", meaning: null, next_about: "which period" }] });
const deep = (v: number) => new Map([["LS-999|St. Louis city, Missouri|The latest complete year (2025)", [{ key: "", value: v, status: "VALUE" }]]]);
assert.equal(scoreShadow(stlCase, stl0, r, ctx, deep(84)).result!.values, "not measured", "the county's answers have no values");
assert.equal(scoreShadow(stlCase, stl0, r, ctx, deep(83)).result!.outcome, "wrong_answer");

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
// A statement the plan calls for but the answer does not carry is caught (P86: carried in answerStatements).
const stripped = { ...victimsNoPeriod, options: victimsNoPeriod.options.map((o, i) => (i ? o : { ...o, continuation: { ...latest, delivered: { ...latest.delivered, answerStatements: latest.delivered.answerStatements.filter((x) => x !== "property_counted_by_offense") } } })) };
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
const burg = as(ask("Burglaries in Memphis in 2023"), "decline");
assert.match(burg.explanation, /^This isn.t available here\./);
// P74: the nearest answerable question, shown whole on the button, run only when chosen.
assert.deepEqual(burg.alternative, { label: 'Ask instead: "Burglaries in Memphis in 2023 according to NIBRS"', question: "Burglaries in Memphis in 2023 according to NIBRS", role: "other_source", targetSource: "nibrs" });

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
assert.match(as(ask("Drug crimes and shoplifting in Detroit in 2024"), "decline").explanation, /drug equipment violations. beside other crimes/);
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
assert.ok(chg.delivered.text.includes("Detroit had 84 shoplifting offenses in 2022 and 84 in 2023, a change of 0 (0%)."), chg.delivered.text.join(" / "));
// P54: no comparison year -> the year before; D17: no change from a year with a month unknown, the month named (D04).
const goUp = as(ask("Did shoplifting go up in Detroit in 2024?"), "answer");
assert.deepEqual(goUp.delivered.table.rows, [[84, null, null, null]]);
assert.ok(goUp.delivered.text.includes("No data is available for March 2024, so the 2024 total is not established and no change is given."));
assert.ok(!goUp.delivered.text.some((t) => /a change of/.test(t)));
// P140: what is known and what is not, in one sentence (the missing month is the cause).
assert.equal(goUp.delivered.text[0], "Detroit had 84 shoplifting offenses in 2023, but the data for 2024 is incomplete, so no change is given.");
// This year against last year: the same months, through the latest month (P52, D06).
const ytdCmp = as(ask("Is shoplifting in Detroit up this year compared with last year?"), "answer");
assert.deepEqual(ytdCmp.period, { from: "2025-01", to: "2026-09" });
assert.ok(ytdCmp.delivered.text.includes("Compares the same months of each year: January through September."));
assert.deepEqual(ytdCmp.delivered.table.rows, [[63, 63, 0, 0]]);
// The year to date against another year (Jeff 2026-11-16, P127): both years count January through the latest month, as "this year compared with last year" does.
for (const q of ["YTD 2026 compared to 2025 shoplifting in Detroit", "Shoplifting in Detroit year to date 2026 vs 2025", "Shoplifting in Detroit so far this year compared to the same period last year",
  "Shoplifting in Detroit 2026 YTD versus 2025 YTD", "Shoplifting in Detroit this year to date compared with 2025", "Shoplifting in Detroit YTD 2025 compared to 2026 YTD"]) {
  const y = as(ask(q), "answer");
  assert.deepEqual(y.period, { from: "2025-01", to: "2026-09" }, q);
  assert.ok(y.delivered.text.includes("Compares the same months of each year: January through September."), q);
  assert.deepEqual(y.delivered.table.rows, [[63, 63, 0, 0]], q);
}
{
  // A named year with a month unknown: the same months of both, no change from a total that is not established (D17).
  const o = as(ask("Shoplifting in Detroit this year to date compared with 2024"), "answer");
  assert.deepEqual(o.period, { from: "2024-01", to: "2026-09" });
  assert.deepEqual(o.delivered.table.rows, [[null, 63, null, null]]);
  assert.ok(o.delivered.text.includes("Compares the same months of each year: January through September."));
  assert.equal(o.delivered.text[0], "Detroit had 63 shoplifting offenses in January through September 2026, but the data for January through September 2024 is incomplete, so no change is given.");
  assert.ok(o.delivered.text.includes("No data is available for March 2024, so the January through September 2024 total is not established and no change is given."));
}
// A year named beside the to-date word is one period, not a second one ("gun homicides in Memphis 2026 year-to-date" was declined).
for (const q of ["Shoplifting in Detroit 2025 year-to-date", "Shoplifting in Detroit YTD 2025", "Shoplifting in Detroit year to date for 2025", "Shoplifting in Detroit in 2025 YTD"]) {
  const o = ask(q);
  assert.ok(o.kind !== "decline" || !/one period at a time/.test(o.explanation), `${q}: ${o.kind === "decline" ? o.explanation : o.kind}`);
}
// Not changed: no to-date word keeps today's reading; one year to date alone is not a comparison.
assert.equal(as(ask("Is shoplifting in Detroit up this year compared with last year?"), "answer").delivered.text.includes("Compares the same months of each year: January through September."), true);
// "Compared with" and "percent change" read; a change with a NIBRS filter is a comparison too.
for (const q of ["Shoplifting in Detroit in 2023 compared with 2022", "Percent change in shoplifting in Detroit from 2022 to 2023", "Change in robberies with a firearm in Detroit from 2022 to 2023"])
  assert.equal(as(ask(q), "answer").plan.transforms[0].kind, "period_comparison", q);
// A change of several crimes or of a breakdown is not built.
assert.equal(ask("Change in shoplifting and burglary in Detroit from 2022 to 2023").kind, "decline");
// A set of years: only those years, grouped by year.
const sepYears = as(ask("Shoplifting in Detroit in 2019 and 2023"), "answer");
assert.deepEqual([sepYears.plan.period, sepYears.delivered.text[0]], [{ kind: "years", years: [2019, 2023] }, "Detroit, Michigan Shoplifting Offenses Per Year, 2019 and 2023"]);
assert.ok(sqls.at(-1)!.includes("IN ('2019', '2023')"));
// Rolling windows reach back before the period; a window holding March 2024 is blank, never a shorter sum.
const roll = as(ask("Rolling 12-month shoplifting in Detroit since 2024"), "answer");
const rollRow = (ym: string) => roll.delivered.table.rows.find((r) => r[0] === ym)![1];
assert.deepEqual([rollRow("2024-02"), rollRow("2024-03"), rollRow("2025-02"), rollRow("2025-03")], [84, null, null, 84]);
assert.ok(!roll.delivered.text.some((t) => /^Each month's figure/.test(t)), "P86: the rolling header says what it is");
assert.ok(roll.delivered.text.some((t) => /^No data is available for March 2024: every window containing one of those months is shown blank/.test(t)));
// P56: the last 12 months, one total, months named.
const last12 = as(ask("Shoplifting in Detroit over the last 12 months"), "answer");
assert.deepEqual([last12.period, last12.plan.groupings, last12.delivered.text[0]], [{ from: "2025-10", to: "2026-09" }, [], "Detroit had 84 shoplifting offenses in October 2025 through September 2026."]);
// Charlotte: found by its place name, named as its agency; a bare "Charlotte" is a city and a county (P28).
assert.match(as(ask("Shoplifting in Charlotte, North Carolina in 2023"), "answer").delivered.text[0], /^Charlotte had /);
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
assert.match(as(ask("Did burglaries increase in Detroit from 2022 to 2023?"), "decline").explanation, /^This isn.t available here\./);
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
  [["Under 18", 40], ["Unknown", 20]]);
// Codex guard review 01.2: overlapping categories (an offense's offenders) merged into one Unknown are not summed: the
// cell is left unverified, never judged against a double count.
assert.deepEqual(v5("offender_sex", [{ offender_sex: " ", m: { status: "VALUE", value: 1 } }, { offender_sex: "U", m: { status: "VALUE", value: 1 } }, { offender_sex: "M", m: { status: "VALUE", value: 9 } },
  { offender_sex: "seq_00", m: { status: "VALUE", value: 2 } }]).map((x) => [x.key, !!x.unverifiable]), [["Unknown", true], ["Male", false]], "the Unknown row required, its value not judged; Male kept");
assert.deepEqual(v5("offender_sex", [{ offender_sex: "00", m: { status: "VALUE", value: 3 } }, { offender_sex: "M", m: { status: "VALUE", value: 9 } }]).map((x) => [x.key, x.share]),
  [["Unknown", 30], ["Male", 90]]);
const weaponYear = sliceValues([{ name: "V", json: JSON.stringify({ nibrsai_cases: "LS-999", grouping: "year", category: "weapon", measures: { m: "x" }, totals: { m: { status: "VALUE", value: 10 } },
  rows: [{ year: "2023", weapon: "12", m: { status: "VALUE", value: 8 } }, { year: "2023", weapon: "40", m: { status: "VALUE", value: 7 } }] }) }]).get("LS-999")!;
assert.deepEqual(weaponYear.map((x) => [x.key, x.share]), [["2023|Handgun", undefined], ["2023|Personal Weapons", undefined]], "overlapping categories are never summed");

// Increment 4: several agencies, combined totals, rates (P58, P59) and rankings (P60), on the grid and population stubs.
const ok4 = (q: string) => { const o = as(ask(q), "answer"); assert.deepEqual(o.delivered.contractProblems, [], q); return o; };
const tulsaOkc = ok4("Shoplifting in Tulsa and Oklahoma City in 2024");
assert.deepEqual(tulsaOkc.delivered.table.rows, [["Tulsa Police Department", 60], ["Oklahoma City Police Department", 60]]);
assert.equal(tulsaOkc.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma Shoplifting Offenses by Agency, 2024");
assert.ok(sqls.some((s) => s.includes("unnest(['OK0550600', 'OK0720500']) AS ori")), "one grid query for both agencies");
const combinedTotal = ok4("Shoplifting in Tulsa and Oklahoma City combined in 2024");
assert.deepEqual(combinedTotal.delivered.table.rows, [[120]]);
assert.equal(combinedTotal.delivered.text[0], "Tulsa, Oklahoma and Oklahoma City, Oklahoma had a combined 120 shoplifting offenses in 2024.");
assert.deepEqual(ok4("Shoplifting in Tulsa Police Department, Tulsa, and Oklahoma City combined in 2024").delivered.table.rows, [[120]], "an agency named twice is counted once");
// A combined total needs every month of every agency (D6): Greensboro's unknown months blank the total, never a part-sum.
const gr = ok4("Shoplifting in Greensboro and Raleigh combined in 2025");
assert.deepEqual(gr.delivered.table.rows, [[null]]);
assert.ok(gr.delivered.text.includes("No data is available for November 2025 to December 2025 for Greensboro, North Carolina."));
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
assert.ok(tx.delivered.text.includes("Austin Police Department isn't ranked because it has data for only 11 of the 12 months of 2024."), JSON.stringify(tx.delivered.text));
assert.ok(tx.delivered.text.includes("Only agencies with data for all 12 months of 2024 are ranked, and ties are ordered by agency name."), JSON.stringify(tx.delivered.text));
assert.equal(tx.delivered.text[0], "Texas Shoplifting Offenses by City, 2024");
const txRate = ok4("Which Texas cities had the highest shoplifting rate in 2024?");
assert.deepEqual(txRate.delivered.table.rows, [["Dallas Police Department", 6.5], ["Houston Police Department", 4.7]]);
assert.ok(txRate.delivered.text.includes("TX9999900 isn't ranked because the FBI gives no population."), JSON.stringify(txRate.delivered.text));
assert.equal(as(ask("Which large Texas cities had the most shoplifting in 2024?"), "answer").delivered.table.rows.length, 2, "P08: 250,000 or more");
// Scoring increment 4: a ranking's filters, ranked statistic and P60 statements; a rate's denominator.
const year24 = { from: "2024-01", to: "2024-12" };
const txLabel = label({ action: "answer", meaning: { source: "nibrs", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24, measures: [{ name: "shoplifting", unit: "offense" }],
  filters: ["city agencies", "agencies that reported every month of 2024"], groupings: ["agency"], statistic: "count", rank: { by: "count", direction: "top", limit: 20 } }, values: { status: "pending_build" },
  statements: ["shows exactly 3 agencies", "ranks only agencies that reported all 12 months of 2024, and names those left out with their months reported; no button to include them, and they appear in neither the chart nor the table (P60)",
    "orders ties alphabetically by agency name", "adds no other eligibility filter", "names its source at the end"] });
assert.deepEqual(material(tx, txLabel), []);
assert.ok(material({ ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.filter((t) => !t.startsWith("Only agencies with data for")) } }, txLabel).includes("statement"), "the P60 rule must be said");
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
// Increment 7b (LS-424): one agency's rate file also gives its count, for a follow-up that asks for the count.
assert.deepEqual(v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] }).get("LS-999|count"),
  [{ key: "", value: 60, status: "VALUE" }]);

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
assert.match(as(ask("Which Texas cities had the most shoplifting in 2024?"), "decline").explanation, /disagree with its record of which months it reported, so no ranking is given/);
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
const LEFT_OUT = /(?:aren't|isn't) ranked because (?:data is missing|it has data for only)/;
assert.equal(hide(tx.delivered.text.filter((t) => !LEFT_OUT.test(t))), "mismatch", "a missing left-out line");
assert.equal(hide(tx.delivered.text.map((t) => t.replace("only 11 of the", "only 10 of the"))), "mismatch", "a wrong month count");
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
const sixLine = (names: string[]) => `6 agencies aren't ranked because data is missing for some of the 12 months of 2024. The five with the largest populations are ${names.join(", ")}.`;
const withLine = (line: string, left: typeof six) => scoreShadow(txLabel, { ...tx, delivered: { ...tx.delivered, text: tx.delivered.text.map((t) => (LEFT_OUT.test(t) ? line : t)) } }, r, ctx,
  rankFile([["Houston Police Department", "TXHPD0000", 108], ["Dallas Police Department", "TXDPD0000", 84], [null, "TX9999900", 60]], left)).result!.values;
assert.equal(withLine(sixLine(six.slice(0, 5).map((a, i) => `${a.agency_name} (population ${i + 1},${i}00, ${i + 1} month${i ? "s" : ""})`)), six), "match", "each named with its population and months");
assert.equal(withLine(`6 agencies aren't ranked because data is missing for some of the 12 months of 2024, the largest ${six.slice(0, 5).map((a, i) => `${a.agency_name} (${i + 1} month${i ? "s" : ""})`).join(", ")}.`, six), "mismatch", "the old \"the largest\" wording");
const twoOut = six.slice(0, 2);
assert.equal(withLine(`A Police Department (1 month) and A Police Department (1 month) aren't ranked because data is missing for some of the 12 months of 2024.`, twoOut), "mismatch", "names are distinct");
// 8. A blank rate says why: no population is not months unknown.
assert.match(raleigh.delivered.text[0], /because the FBI gives no 2024 population for the /);

// Increment 5. A Part I offense for a state or the nation, completed years: the historical file (P53), "Source: Crime Index."
// (P63), with what it read; the covered part of a span with the rest named (D04, P14); a change (P54).
const srs = (q: string) => { const o = ask(q); assert.equal(o.kind, "srs", `${q}: ${JSON.stringify(o).slice(0, 200)}`); return o as Extract<ShadowOutcome, { kind: "srs" }>; };
const txRob = srs("Robberies in Texas in 2024");
assert.deepEqual([txRob.delivered.table.rows, txRob.delivered.text, txRob.read.column, txRob.read.uids], [[[19935]], ["Texas had 19,935 robberies in 2024.", "Source: Crime Index."], "robbery_total", ["tx_2024"]]);
assert.deepEqual(srs("Burglary rate in Ohio in 2022").delivered.table.rows, [[259.5]]);
assert.equal(srs("Violent crime in California in 2024").read.column, "violent_total", "the file's own sum, never re-added");
assert.deepEqual(srs("Did robberies go up in Georgia in 2025?").delivered.table.rows, [[4426, 3799, -627, -14.2]]);
assert.deepEqual(srs("Murder clearance rate in the US in 2023").delivered.table.rows, [[57.8]]);
// Item 7: the national clearance rate by year, as published.
assert.deepEqual(srs("Murder clearance rate in the US from 2021 to 2023").delivered.table.rows, [["2021", 49.4], ["2022", 52.3], ["2023", 57.8]]);
assert.equal(srs("National murder clearance rate by year").delivered.table.rows[0][0], "1960", "an open span starts in 1960");
assert.ok(srs("Murder clearance rate in the US from 1959 to 2026").delivered.text.some((t) => /; 1959 and 2026 are outside them\.$/.test(t)), "the years outside named apart");
for (const q of ["Percent change in murder clearance rate in the US from 2020 to 2023", "Did the national murder clearance rate rise from 2020 to 2023?"])
  assert.notEqual(ask(q).kind, "srs", `${q}: a change in a clearance rate is never the rates by year`);
const span = srs("Robberies in Texas by year from 1955 to 1965");
assert.deepEqual(span.delivered.table.rows.map((x) => x[0]), ["1960", "1961", "1962", "1963", "1964", "1965"]);
assert.ok(span.delivered.text.includes("State figures in the data cover 1960 through 2025; 1955 through 1959 are outside them."));
assert.equal(as(ask("Robberies in Texas in 1955"), "decline").reason, "outside_release_coverage");
// P172 (Jeff 2026-11-21, reversing P18): a completed year's clearance rate for a state is the reporting agencies' cleared offenses over their offenses.
{
  const tx = as(ask("Murder clearance rate in Texas in 2025"), "answer");
  assert.equal(tx.delivered.text[0], "Texas cleared 34.6% of the murders reported in 2025, summed over the 4 agencies that reported.");
  assert.ok(tx.delivered.text.includes("Includes all agencies.") && tx.delivered.text.at(-1) === "Source: NIBRS.", JSON.stringify(tx.delivered.text));
  assert.equal(as(ask("Aggravated assault clearance rate in Ohio in 2023"), "answer").delivered.text.length > 0, true);
  // Several years: one row a year, each the single-year figure; years before NIBRS's first are said, not answered.
  for (const q of ["What is the murder clearance rate in Texas by year from 2023 to 2025?", "Show the murder clearance rate in Texas since 2023"]) {
    const by = as(ask(q), "answer");
    assert.deepEqual(by.delivered.table.rows.map((r) => r[0]), ["2023", "2024", "2025"], q);
    // (2024 is 34.5: the stub's Austin did not report June 2024, so its other months are summed without it.)
    assert.deepEqual(by.delivered.table.rows.map((r) => r[1]), [34.6, 34.5, 34.6], JSON.stringify(by.delivered.table.rows));
    assert.ok(/^2023 to 2025 Murders Cleared \(%\) by Year, Texas$/.test(by.delivered.text[0]), by.delivered.text[0]);
  }
  const early = as(ask("Show the burglary clearance rate in Texas since 2000"), "answer");
  assert.ok(early.delivered.text.includes("NIBRS state figures start in 2017; 2000 through 2016 are outside them."), JSON.stringify(early.delivered.text));
}
assert.match(as(ask("Carjacking clearance rate in Texas in 2024"), "decline").explanation, /state clearance rate for a NIBRS-only offense.*not decided/);
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
const first = (o: ShadowOutcome) => as(o, "answer").delivered.table.rows.map((x) => x[0]);
assert.deepEqual(txCj.delivered.table.rows, [[307]], "Houston 108 + Dallas 84 + Austin 55 (11 months) + 60");
// P87 (Jeff 2026-11-01): the agencies and the population they cover are columns only when asked for; carried in stateSum.
assert.deepEqual(txCj.delivered.table.columns.map((c) => c.header), ["Carjacking offenses"]);
assert.ok(!txCj.delivered.text.some((t) => /residents covered|share of residents|Residents covered/i.test(t)), txCj.delivered.text.join(" / "));
assert.equal(txCj.buttons![0].label, "Consistent Reporting Agencies");
assert.deepEqual(txCj.stateSum!.years.map((y) => [y.agencies, y.partial, y.every.agencies, y.every.sum]), [[4, 1, 3, 252]]);
// One short note line, then the source (Jeff 2026-11-01).
// Jeff (2026-11-01): his note, then the source; nothing else.
assert.deepEqual(txCj.delivered.text.slice(1), ["Includes all agencies.", FBI_MASTER_FILES, "Source: FBI NIBRS."]);
const txEvery = txCj.buttons![0].continuation as Extract<ShadowOutcome, { kind: "answer" }>;
assert.deepEqual([txEvery.plan.coverage.cohort, txEvery.delivered.table.rows], ["same_agencies", [[252]]]);
assert.deepEqual(txEvery.delivered.table.columns.map((c) => c.header), ["Carjacking offenses"]);
// The fixed set named with its whole span (Jeff 2026-11-01), never a bare "every month".
assert.match(txEvery.delivered.text[0], /counting only the 3 Consistent Reporting Agencies that reported every month from January 2024 through December 2024\.$/);
assert.deepEqual(first(ask("Carjackings in Texas in 2024, only agencies that reported every month")), [252], "the button's question, typed");
assert.deepEqual(first(ask("Carjacking rate in Texas in 2024")), [6.7], "307 per 4,570,000 residents of the agencies counted");
assert.equal(as(ask("Robberies in Texas in 2024 according to NIBRS"), "answer").plan.source, "nibrs", "P01: the source asked for in words");
// Scoring increment 5: the historical file's values with their column and row; a route verifies routing only; a state
// sum's view, rows and disclaimer figures.
const year24b = { from: "2024-01", to: "2024-12" };
const srsLabel = label({ action: "answer", meaning: { source: "historical", places: [{ kind: "state", name: "Texas", state: "TX" }], period: year24b, measures: [{ name: "robbery", unit: "offense" }], filters: [], groupings: [], statistic: "count" },
  values: { status: "pending_build" }, statements: ["names the state (Texas)", "ends with the source line \"Source: Crime Index.\" (P63)"] });
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
{ const sc = scoreShadow(sumLabel, txCj, r, ctx, sumV(307)).result!; assert.equal(sc.outcome, "correct", JSON.stringify(sc.diffs)); }
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
assert.deepEqual([first(txConflict), txConflict.stateSum!.years[0].conflicts, txConflict.stateSum!.years[0].every.agencies], [[298], 1, 2]);
// Jeff (2026-11-01): one note only; a conflict month is still not counted (the figures above), no longer said.
assert.ok(!txConflict.delivered.text.some((t) => /disagree/.test(t)), txConflict.delivered.text.join(" / "));
CONFLICT = null;
// 5. A missing population is never 0: no rate, and the share covered is a lower bound.
assert.match(as(ask("Shoplifting rate in North Carolina in 2024"), "answer").delivered.text[0], /^No rate is given for North Carolina in 2024, because 1 of the agencies counted have no FBI population/);
const nc = as(ask("Shoplifting in North Carolina in 2024, with the number of agencies reporting"), "answer");
assert.match(String(nc.delivered.table.rows[0][2]), /^≥[\d.]+%$/, "a lower bound is marked in its cell");
assert.deepEqual(nc.delivered.text.slice(1), ["Includes all agencies.", FBI_MASTER_FILES, "Source: FBI NIBRS."]);
// 6. A span reaching this year: its completed years, this year named; a future year is declined.
const toNow = srs("Robberies in Texas by year from 2020 to 2026");
assert.deepEqual([toNow.delivered.table.rows.map((x) => x[0]), toNow.delivered.text[1]], [["2020", "2021", "2022", "2023", "2024", "2025"], "2026 is this year: its figures come from Current Trends (Crime Index) and are not included here."]);
assert.equal(ask("Robberies in Texas in 2027").kind, "decline");
// 7. "According to NIBRS" overrides the Homicide Reports route (P01).
assert.notEqual(ask("Murders in the US by victim-offender relationship in 2023 according to NIBRS").kind, "route");
// 8. By year, one year: the Year cell is there.
assert.deepEqual(as(ask("Carjackings in Texas by year in 2024"), "answer").delivered.table.rows, [["2024", 307]]);
// 9. The disclaimer's figures are read in their roles: "14 agencies" never passes for 4.
const txCjA = as(ask("Carjackings in Texas in 2024, with the number of agencies reporting"), "answer");
const share24 = `${txCjA.stateSum!.years[0].share.toFixed(1)}%`;
assert.deepEqual(txCjA.delivered.table.rows, [[307, 4, share24]], "asked for: 4 agencies reporting; their population covered");
assert.equal(material(txCjA, sumLabel).includes("statement"), false);
const wrongCount = { ...txCjA, delivered: { ...txCjA.delivered, table: { ...txCjA.delivered.table, rows: [[307, 14, share24]] } } };
assert.ok(material(wrongCount, sumLabel).includes("statement"));
// Codex review 03. 1: the every-month view over years qualifies a missing population too.
const ncEvery = as(ask("Shoplifting in North Carolina by year from 2023 to 2024, only agencies that reported every month, with the number of agencies reporting"), "answer");
assert.ok(ncEvery.delivered.table.rows.every((r) => /^≥[\d.]+%$/.test(String(r[3]))), JSON.stringify(ncEvery.delivered.table.rows));
assert.ok(ncEvery.delivered.text.includes("Includes only agencies that reported complete data."));
// 2: a span from this year into the future is declined, never routed as this year alone.
assert.equal(as(ask("Robberies in Texas by year from 2026 to 2027"), "decline").reason, "outside_release_coverage");

// Increment 7: people (P29, P30, P44, P49, P65). The reading pre-pass takes the people wording; the plan carries it.
{
  const rq = (q: string) => readQuestion(q, 2026, "2026-09");
  assert.deepEqual(rq("Aggravated assaults in Memphis in 2024 by offender race").people, { by: { who: "offender", attr: "race", paired: false }, where: [], ask: null });
  assert.deepEqual(rq("Murder victims in Memphis in 2024 by the race of the offender who killed them").people?.by, { who: "offender", attr: "race", paired: true });
  assert.deepEqual(rq("Aggravated assaults by juveniles in Memphis in 2024").people?.where, [{ who: "offender", attr: "age", range: [1, 17], paired: false }]);
  assert.deepEqual(rq("Aggravated assaults against juveniles in Memphis in 2024").people?.where, [{ who: "victim", attr: "age", range: [1, 17], paired: false }]);
  assert.deepEqual(rq("Juvenile arrests for robbery in Detroit in 2024").people?.where, [{ who: "arrestee", attr: "age", range: [1, 17], paired: false }]);
  assert.equal(rq("Arrests in Denver in 2023 by arrestee race").text, "All crime arrests in Denver in 2023");
  assert.equal(rq("Murders by young adults in Memphis in 2024").people?.ask, "young adults");
  // "By juveniles" is read, so it is no longer an unread offender group (P29's decline).
  assert.equal(rq("Aggravated assaults by juveniles in Memphis in 2024").offenders, false);
  const g = (q: string) => planOf(q).groupings.map((x) => `${x.dimension}${x.multiValue ? "*" : ""}${x.bins ? "[bins]" : ""}`);
  const f = (q: string) => JSON.stringify(planOf(q).filters);
  assert.deepEqual(g("Aggravated assaults in Memphis in 2024 by offender race"), ["offender.race*"]);
  assert.deepEqual(g("Robberies in Detroit in 2024 by offender age"), ["offender.age*[bins]"]);
  assert.deepEqual(g("According to NIBRS, murder victims in Memphis in 2024 by the race of the offender who killed them"), ["victim_offender.offender_race*"]);
  assert.deepEqual(g("Arrests in Denver in 2023 by arrestee age"), ["arrestee.age[bins]"]);
  assert.match(f("Aggravated assaults by juveniles in Memphis in 2024"), /"scope":"incident","entity":"offender".*"offender.age","op":"between","values":\[1,17\]/);
  assert.match(f("Aggravated assaults against juveniles in Memphis in 2024"), /"dimension":"victim.age","op":"between"/);
  assert.match(f("Aggravated assault victims of offenders who were under 18, in Memphis in 2024, by victim race"), /"scope":"victim","entity":"victim_offender".*"victim_offender.offender_age"/);
  assert.match(f("Offenders in aggravated assaults in Memphis in 2024 by sex, where the victim was a stranger"), /"scope":"offender","entity":"victim_offender".*"values":\["ST"\]/);
  // Codex 05: "by victim race" for victims is the victims' own breakdown, answered.
  assert.deepEqual(g("Aggravated assault victims in Memphis in 2024, by victim race"), ["victim.race"]);
  // Codex 04.2: a victim's attribute on arrests is declined, never answered as the arrestee's.
  assert.match(as(ask("Arrests in Denver in 2023 by victim race"), "decline").explanation, /a victim's race for arrests/);
  // Element 31 (coordinator 2026-11-04): a breakdown of victims; a filter on murder or aggravated assault victims, named
  // and with the unknown-circumstance note; other crimes declined; a state's murder by circumstance is Homicide Reports'.
  {
    const by = as(ask("Murder victims in Memphis by circumstance in 2024"), "answer");
    assert.ok(by.plan.groupings.some((x) => x.dimension === "victim_circumstance.circumstance" && x.multiValue === "each_value"));
    // Code 06 is held back until the domestic violence note (Jeff 2026-11-04): no row, no name, its count in a plain note
    // with no DV wording; and no filter can name it.
    {
      const stats = by.plan.statistics.map((x) => x.as);
      const cols = ["victim_circumstance.circumstance", ...stats.flatMap((x) => [x, `${x}_status`])];
      const row = (c: string, n: number) => [c, ...stats.flatMap((x, i) => [i === 0 ? n : n / 251, "VALUE"])];
      const d = deliver(by.plan, { from: "2024-01", to: "2024-12" }, "2024-12", cols, [row("01", 54), row("06", 3), row("10", 170)], [], "r", [], null);
      assert.deepEqual(d.table.rows.map((r) => r[0]), ["Argument", "Unknown circumstances"]);
      assert.ok(d.text.includes("One circumstance category is left out of this table for now: 3 murder victims were recorded under it."), JSON.stringify(d.text));
      assert.ok(!/lover|domestic|intimate|partner/i.test(JSON.stringify(d)), "no DV wording, no FBI name for 06");
      assert.ok(!("06" in CIRCUMSTANCE));
    }
    const f = as(ask("Murders during an argument in Memphis in 2024"), "answer");
    assert.ok(f.plan.filters.some((x) => x.kind === "exists" && x.entity === "victim_circumstance"));
    assert.ok(/where the circumstance was argument/i.test(f.delivered.text[0]), JSON.stringify(f.delivered.text));
    assert.ok(f.delivered.answerStatements.includes("circumstance_unknown"));
    assert.match(as(ask("Robberies during an argument in Memphis in 2024"), "decline").explanation, /recorded for murder and aggravated assault victims/);
    assert.equal(as(ask("Murders during an argument in Tennessee in 2024"), "route").source, "shr");
    // Codex circumstance review 01.1: an offered question keeps the circumstance, or none is offered.
    const fb = ask("Aggravated assaults during an argument in Memphis by sex and race in 2024");
    if (fb.kind === "decline" && fb.alternative) assert.match(fb.alternative.question ?? "", /argument/i);
    // P38 (Jeff 2026-11-09): gang wording is declined for every source (NIBRS, Homicide Reports, Crime Index, Current
    // Trends), in plain words; a next step never keeps the gang words, and drops only them where it can.
    assert.equal(as(ask("Gang-related murders in Tennessee in 2024"), "decline").alternative?.question, "murders in Tennessee in 2024");
    // Follow-ups in gang words are declined the same way, with no follow-up reading offered (Codex review 19.2, 19.3).
    for (const fu of ["only gang-related", "what about gangs?", "gang murders in Los Angeles"]) {
      const d = shadowFollowUp("murders in Memphis in 2024", fu, deps);
      assert.equal(d.kind, "decline", fu);
      if (d.kind === "decline") {
        assert.ok(d.explanation.startsWith("Gang involvement is loosely defined"), fu);
        assert.ok(!/not recorded|isn't recorded|doesn't record/i.test(JSON.stringify([d.explanation, d.alternative])), fu);
        assert.ok(!/gang/i.test(d.alternative?.question ?? "") && !/follow-up/i.test(d.alternative?.label ?? ""), `${fu}: ${JSON.stringify(d.alternative)}`);
      }
    }
    for (const q of ["Gang-related murders in Memphis in 2024", "Gang-related murders in Tennessee in 2024", "Gang related murders in Chicago over time",
      "gang murders in Chicago over time", "gangland killings in the United States since 2010", "gangs in Houston", "gang homicides in Chicago by year since 1990",
      "How many gang members were arrested in Dallas in 2023", "gang violence in Los Angeles this year",
      // Codex review 19: before a place is asked ("LA") or a forecast declined; joined forms.
      "gang murders in LA in 2024", "Will gang murders in Houston rise next year?", "gangrelated murders in Memphis in 2024"]) {
      const d = as(ask(q), "decline");
      assert.ok(d.explanation.startsWith("Gang involvement is loosely defined and inconsistently reported to the FBI, so counts of gang-related crime would be misleading."), q);
      assert.ok(!/gang/i.test(d.alternative?.question ?? "") && !/gang/i.test(d.explanation.slice(130)), q);
      // What the user sees (the preview renders the text and buttons, never the reason code) never says "not recorded".
      assert.ok(!/not recorded|isn't recorded|doesn't record/i.test(JSON.stringify([d.explanation, d.alternative, (d as { more?: unknown }).more])), q);
    }
  }
  // P53 (Codex state-categories review 01.2): murder by a Homicide Report detail for a state or the nation, NIBRS not
  // named, is Homicide Reports'; named, NIBRS sums it.
  assert.equal(as(ask("Murder victims in Tennessee by race in 2024"), "route").source, "shr");
  assert.equal(ask("Murder victims in Tennessee by race in 2024, according to NIBRS").kind, "answer");
  assert.notEqual(ask("Murders in Tennessee in 2024 by clearance type").kind, "route", "a clearance is not a Homicide Report detail");
  // A detail selected, not only broken down (query-log scorecard 2026-11-04): a state's female victims, the nation's
  // handgun murders; a city stays NIBRS's, and so does a state with NIBRS named.
  assert.equal(as(ask("How many murders of females were there in Minnesota in 2023"), "route").source, "shr");
  assert.equal(as(ask("Handgun murders in the United States in 2024"), "route").source, "shr");
  assert.equal(ask("Female murder victims in Memphis in 2023").kind, "answer");
  assert.equal(ask("Murders of females in Minnesota in 2023 according to NIBRS").kind, "answer");
  // Codex P53 review 01: only when every filter is such a detail, and only for victims.
  assert.notEqual(ask("Female murder victims in Texas in 2024 cleared by arrest").kind, "route");
  assert.notEqual(ask("Female murder offenders in Ohio in 2022").kind, "route");
  // Reader cluster 2: a change over a span ("changed since 2020", "over the past 5 years") is the series over it;
  // "trended"/"trending" read as "trend"; two named years stay a comparison.
  for (const q of ["How has robbery changed in Denver since 2020?", "How have robberies in Denver trended since 2020?", "Is the Denver robbery rate trending up over the past 5 years?"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell|two named years|two years/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  // Reader cluster 3: a year to the latest data ("2015 to present", "to the most recent month") is "since" that year;
  // "as far back as you can", "full history", "historical", "all available years" are every year (D5).
  for (const q of ["Denver robberies 2018 to present", "Denver robberies from 2018 to the most recent data", "Denver robberies as far back as you can", "the full history of robberies in Denver", "historical robbery counts in Denver"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  // "Current trend" (Jeff 2026-11-05): Current Trends' recent months, by month from January of last year; never declined
  // for "current".
  {
    const o = ask("What are the current robbery trends in Denver?");
    assert.ok(!(o.kind === "decline" && /didn't understand/.test(o.explanation)), JSON.stringify(o).slice(0, 200));
    if (o.kind === "answer") assert.ok(o.plan.groupings.some((g) => g.dimension === "time.month"), "by month");
  }
  // Redesign case: a place outside the U.S. is declined plainly (never a U.S. place). (An unknown U.S.-looking place,
  // "Zzyzxville", still asks which place, as on dev: a "couldn't find" rule is a later item.)
  assert.match(as(ask("robberies in Paris, France in 2025"), "decline").explanation, /U\.S\. law enforcement agencies only/);
  assert.notEqual(ask("robberies in New Mexico in 2024").kind, "decline");
  // Codex re-check: a country name that continues a U.S. place name is never declined as foreign.
  for (const q of ["murders in Mexico Missouri in 2024", "murders in Brazil Indiana in 2024", "murders in China Grove, Texas in 2024", "murders in New  Mexico in 2024"])
    assert.ok(!/U\.S\. law enforcement agencies only/.test(JSON.stringify(ask(q))), q);
  // Codex reader-change review 01: a percent change over a span is never answered as counts.
  for (const q of ["What is the % change in robberies in Denver since 2019?", "percent change in robberies in Denver since 2019"]) assert.notEqual(ask(q).kind, "answer", q);
  // Reader cluster 1 and P94 (Jeff 2026-11-05): a rolling window of any length named is read and computed at that
  // length; an average is the window's total over its months, labeled as an average; no length named asks which.
  for (const q of ["Pittsburgh murders rolling over 12 months since 2018", "Denver robberies 12 months rolling since 2020", "Denver robberies on a rolling 12 month basis since 2020", "Denver robberies 12m rolling since 2020"]) {
    const o = ask(q);
    assert.ok(!(o.kind === "decline" && /didn't understand|couldn't tell/.test(o.explanation)), `${q}: ${JSON.stringify(o).slice(0, 160)}`);
  }
  {
    const six = ask("Denver robberies rolling over 6 months since 2025");
    if (six.kind === "answer") assert.ok(six.plan.transforms.some((t) => t.kind === "rolling" && t.months === 6) && six.delivered.text[0].includes("Rolling Over 6 Months"), JSON.stringify(six.delivered.text));
    else assert.ok(!(six.kind === "decline" && /didn't understand/.test(six.explanation)), JSON.stringify(six).slice(0, 200));
    const avg = ask("Denver robberies 3-month rolling average since 2025");
    if (avg.kind === "answer") assert.ok(avg.delivered.text[0].includes("Rolling Average Over 3 Months") && avg.delivered.table.columns.some((c) => /average per month/.test(c.header)), JSON.stringify(avg.delivered.text));
    assert.equal(as(ask("Denver robberies rolling average since 2025"), "clarify").about, "which rolling window");
    // Codex P94 review 01: a length the engine can't compute is asked about, never 12; a 1-month window runs.
    assert.equal(as(ask("Denver robberies rolling 0 months since 2025"), "clarify").about, "which rolling window");
    assert.ok(!(ask("Denver robberies rolling 1-month since 2025").kind === "decline"));
  }
  // P32: "sex offenses", "sex crimes", "sexual assaults" ask which (rape; all sex offenses), each button running.
  for (const q of ["Sex crimes in Denver in 2023", "Sexual assaults in Ohio in 2024"]) {
    const c = as(ask(q), "clarify");
    assert.equal(c.about, "which sex offenses");
    // Only buttons that run are offered: rape from Crime Index where it is loaded, all sex offenses from NIBRS.
    assert.ok(c.options.some((o) => o.label === "All sex offenses") && c.options.every((o) => ["Rape", "All sex offenses"].includes(o.label)), JSON.stringify(c.options.map((o) => o.label)));
    assert.ok(c.options.every((o) => o.continuation && o.continuation.kind !== "decline"), q);
  }
  // Codex P32 review 01: "forcible sex offenses" is read and asked about (not all six codes); kits are not an offense.
  assert.equal(as(ask("forcible sex offenses in Denver in 2023"), "clarify").about, "which sex offenses");
  assert.notEqual(ask("all sex offenses in Denver in 2023").kind, "clarify");
  assert.ok(!(ask("sexual assault kits in Denver in 2023").kind === "clarify"));
  for (const q of ["crime and murder rates in Chicago in 2024", "murder and crime in Chicago in 2024", "crime and drug possession in Chicago in 2024", "crime rates and aggravated assault rates in Chicago in 2024"]) {
    const o = ask(q);
    assert.ok(o.kind === "clarify" ? o.about === "which kind of crime" : o.kind === "decline" && /isn't one category/.test(o.explanation), q);
  }
  assert.ok(!/isn't one category/.test(JSON.stringify(ask("murders and crimes against persons in Chicago in 2024"))));
  // D09 beside another crime: the bare "crime" is never dropped; the crime named is offered on its own.
  {
    const o = ask("murder and crime in Chicago in 2024");
    // (Its alternative, the crime named on its own, is offered where it runs: Crime Index is not loaded in these tests.)
    assert.ok(o.kind === "clarify" ? o.about === "which kind of crime" : o.kind === "decline" && /isn't one category/.test(o.explanation), JSON.stringify(o).slice(0, 200));
  }
  // A people breakdown for a state is NIBRS's sum by category (coordinator 2026-11-04), never the historical file's.
  {
    const o = as(ask("Aggravated assaults in Tennessee in 2024 by offender sex"), "answer");
    assert.ok(o.plan.groupings.some((x) => /offender_sex|offender\.sex/.test(x.dimension)) && o.stateSum && o.delivered.text.at(-1) === "Source: FBI NIBRS.");
  }
  // "Young adults" and "attackers" are asked about, with buttons that keep the rest of the question (P22).
  assert.deepEqual(as(ask("Murders by young adults in Memphis in 2024"), "clarify").options.map((o) => o.label), ["18 to 24", "18 to 29"]);
  assert.deepEqual(as(ask("How many attackers were there in aggravated assaults in Detroit in 2024?"), "clarify").options.map((o) => o.label), ["Offenders", "People arrested"]);
  // A bare "by race" names no person: victims' or offenders' is asked (QL-hist-0c09c89043, D.C. murders by race); each
  // button answers with the person named. Named people and arrests are answered as before.
  {
    const o = as(ask("Murders in Memphis in 2024 by race"), "clarify");
    assert.equal(o.about, "victim or offender race");
    assert.deepEqual(o.options.map((x) => x.label), ["Victims", "Offenders"]);
    assert.deepEqual(o.options.map((x) => x.continuation?.kind), ["answer", "answer"]);
    assert.equal(as(ask("Murders in Memphis in 2024 by gender"), "clarify").about, "victim or offender sex");
    assert.equal(ask("Murders in Memphis in 2024 by victim race").kind, "answer");
    assert.equal(ask("Murders in Memphis in 2024 by offender race").kind, "answer");
    // "Committed by <people>" names the offenders: not asked about (runner job G, QL-shr-34ce1c60e0).
    assert.notEqual((ask("Murders committed by men in Memphis in 2024 by race") as { about?: string }).about, "victim or offender race");
    assert.notEqual((ask("murder comited by blacks and whites in Memphis in 2024 also seperated by sex") as { about?: string }).about, "victim or offender sex");
    // "Committed by race" (either order) is the offenders' race, never the victims' (found live on /redesign, 2026-11-09);
    // "committed in" names no one, so it is asked.
    for (const q of ["Murders in Memphis in 2024 committed by race", "Murders in Memphis in 2024 by race committed by"])
      assert.deepEqual(as(ask(q), "answer").plan.groupings.map((x) => x.dimension), ["offender.race"], q);
    assert.equal(as(ask("Murders committed in Memphis in 2024 by race"), "clarify").about, "victim or offender race");
    // "By race of the offender" is "by offender race" (Jeff 2026-11-08): the same plan; counting offenders stays offenders.
    {
      const plan = (q: string) => JSON.stringify(as(ask(q), "answer").plan);
      assert.equal(plan("Murders in Memphis in 2024 by race of the offender"), plan("Murders in Memphis in 2024 by offender race"));
      assert.equal(plan("Murders in Memphis in 2024 by the race of the offenders"), plan("Murders in Memphis in 2024 by offender race"));
      const offenders = as(ask("Murder offenders in Memphis in 2024 by race of the offender"), "answer").plan;
      assert.ok(offenders.measures[0].unit === "offender" && offenders.groupings.some((g) => g.dimension === "offender.race"), JSON.stringify(offenders));
    }
    // Phrasing probe (2026-11-08) misses, kept: "race breakdown of murders" is a bare breakdown, asked; "broken down by
    // race committed by" is the offenders' race.
    assert.equal(as(ask("race breakdown of murders in Memphis in 2023"), "clarify").about, "victim or offender race");
    assert.deepEqual(as(ask("give me Memphis murders in 2024 broken down by race committed by"), "answer").plan.groupings.map((x) => x.dimension), ["offender.race"]);
    // Offenders counted by a victim's race: declined, never the offenders' own race (Codex gap-2 review 04).
    assert.match(as(ask("Murder offenders in Memphis in 2024 by victim race"), "decline").explanation, /a victim's race for offenders/);
    // Codex gap-2 review 05: any opener; "victims of offenders" counts victims.
    for (const q of ["Give me the number of murder offenders in Memphis in 2024 by victim race", "List aggravated assault offenders in Memphis in 2024 by victim race"])
      assert.match(as(ask(q), "decline").explanation, /a victim's race for offenders/, q);
    assert.ok(!/for offenders/.test(JSON.stringify(ask("Victims of offenders who were under 18 in Memphis in 2024 by victim race"))));
    assert.deepEqual(as(ask("Murders in Memphis in 2024 by victim race"), "answer").plan.groupings.map((x) => x.dimension), ["victim.race"]);
    // "Committed against" names victims, never offenders (Codex gap-2 review 01.1).
    assert.ok(!JSON.stringify(ask("Murders in Memphis in 2024 by race committed against women")).includes("offender.race"));
    // Each button keeps what else the question set (Codex review 02: "unsolved" had been dropped).
    const u = as(ask("Unsolved murders in Memphis in 2024 by race"), "clarify");
    const [uv, uo] = u.options.map((x) => as(x.continuation!, "answer"));
    for (const c of [uv, uo]) assert.ok(c.plan.filters.some((f) => JSON.stringify(f).includes("clearance")), JSON.stringify(c.plan.filters));
    assert.deepEqual([uv.plan.groupings.map((x) => x.dimension), uo.plan.groupings.map((x) => x.dimension)], [["victim.race"], ["offender.race"]]);
  }
}

// Increment 7b. P71: each quarter is the sum of its three months; a quarter with a month not known (March 2024 in the
// stub) is blank and named incomplete, never shown as a whole quarter.
{
  const qa = as(ask("Shoplifting in Memphis by quarter in 2024"), "answer");
  assert.deepEqual(qa.plan.groupings.map((g) => g.dimension), ["time.quarter"]);
  assert.deepEqual(qa.delivered.table.rows, [["2024-Q1", null], ["2024-Q2", 21], ["2024-Q3", 21], ["2024-Q4", 21]]);
  assert.ok(!qa.delivered.text.some((t) => /^Each quarter's figure/.test(t)), "P86: no quarter note");
  assert.ok(qa.delivered.text.some((t) => /^Q1 2024\b.* shown blank, not as (?:a whole quarter|whole quarters), because the agency has data for only some of/.test(t)), qa.delivered.text.join("\n"));
  assert.equal(as(ask("Shoplifting rate in Memphis by quarter in 2024"), "decline").kind, "decline");
  // Codex 7b-04.3: quarters never widen the period asked (a set of years; a period starting or ending inside a quarter).
  assert.match(as(ask("Shoplifting in Memphis by quarter in 2021 and 2024"), "decline").explanation, /quarters of a set of years/);
  assert.match(as(ask("Shoplifting in Memphis by quarter from February 2024 to December 2024"), "decline").explanation, /starts or ends inside a quarter/);
  // Codex 7b-04.4: both supporting columns at once are declined, never one dropped.
  assert.match(as(ask("Shoplifting rate in Kansas in 2024, with a column showing the population used to calculate the rate, with the number of agencies reporting"), "decline").explanation,
    /population and the agencies reporting together/);
  // P72: the population a rate divides by, in its own column beside the unchanged rate.
  const pa = as(ask("Shoplifting rate in Wichita in 2024, with a column showing the population used to calculate the rate"), "answer");
  const plain = as(ask("Shoplifting rate in Wichita in 2024"), "answer");
  assert.deepEqual(pa.delivered.table.columns.map((c) => c.header), [...plain.delivered.table.columns.map((c) => c.header), "Population"]);
  assert.deepEqual(pa.delivered.table.rows, [[plain.delivered.table.rows[0][0], 400_000]]);
  assert.ok(pa.plan.statistics.some((s) => s.kind === "population" && s.of === plain.plan.statistics[0].as));
  // Codex 7b-04.6: the population column is checked against the independent file's population, not found in the text.
  const popFile = (population: number) => v7({ grouping: "rate", agencies: [{ agency_name: "Wichita Police Department", population, total: { status: "VALUE", value: 60 }, rate: { status: "VALUE", value: 15 } }] });
  assert.equal(scoreShadow(wichitaLabel, pa, r, ctx, popFile(400_000)).result!.values, "match");
  assert.equal(scoreShadow(wichitaLabel, pa, r, ctx, popFile(15)).result!.values, "mismatch");
  assert.equal(as(ask("Shoplifting in Wichita in 2024, with a column showing the population used to calculate the rate"), "decline").explanation,
    "A population column goes with a rate; this answer has no rate.");
  // P72: the agencies reporting beside a state total, the answer's own cohort; never beside an agency.
  const ka = as(ask("Shoplifting in Kansas in 2024, with the number of agencies reporting"), "answer");
  // Asked for (P87): the agencies and the population they cover, once each, in both views.
  assert.deepEqual(ka.delivered.table.columns.map((c) => c.header), ["Shoplifting offenses", "Agencies reporting", "Population covered"]);
  assert.deepEqual(ka.delivered.table.rows[0].slice(1), [ka.stateSum!.years[0].agencies, coveredText(ka.stateSum!.years[0].share, ka.stateSum!.years[0].noPopulation > 0)]);
  const every = as(ka.buttons![0].continuation!, "answer");
  assert.equal(every.delivered.table.rows[0][1], ka.stateSum!.years[0].every.agencies);
  assert.equal(as(ask("Shoplifting in Wichita in 2024, with the number of agencies reporting"), "decline").explanation,
    "The number of agencies reporting goes with a state or national total.");
}

// P74 (Jeff 2026-11-01: "much, much more crystal clear"): every case question, setup and follow-up, and every button
// behind them three levels deep, on the stub: no user-facing string (a decline, a question back, a button, an answer's
// text, a column header, a table's text cell) holds engine words, and no reader sentence went unmapped. An exception is
// a failure of its own, never a passing string.
{
  const casesFile = JSON.parse(fs.readFileSync("scripts/fixtures/answer-eval/cases.json", "utf8"));
  const all = (casesFile.cases ?? casesFile) as Case[];
  const bad: string[] = [], errors: string[] = [];
  const seen = new Set<string>();
  const check = (text: string | undefined, where: string) => {
    if (!text || seen.has(text)) return;
    seen.add(text);
    const j = jargon(text);
    if (j.length) bad.push(`${where}: [${j.join(", ")}] ${text}`);
  };
  const walk = (o: ShadowOutcome | undefined, where: string, depth: number): void => {
    if (!o) return;
    const opts = o.kind === "clarify" ? o.options : o.kind === "decline" ? (o.alternative ? [o.alternative] : []) : o.kind === "answer" ? o.buttons ?? [] : [];
    if (o.kind === "decline" || o.kind === "route") check(o.explanation, where);
    if (o.kind === "clarify") check(o.about, where);
    if (o.kind === "answer") {
      for (const t of o.delivered.text) check(t, where);
      for (const c of o.delivered.table.columns) check(c.header, where);
      for (const r of o.delivered.table.rows) for (const v of r) if (typeof v === "string") check(v, where);
    }
    for (const x of opts) { check(x.label, where); check(x.question, where); if (depth < 3) walk(x.continuation, `${where} > ${x.label}`, depth + 1); }
  };
  const noNextStep: string[] = [];
  const nextStep = (o: ShadowOutcome, where: string) => {
    // P157: the chart sentence is a plain decline whose second sentence is its only next step (the table sort); it offers no example question.
    if (o.kind === "decline" && !o.notBuilt && !o.alternative && o.explanation !== CHART_MARKER_SENTENCE && !/\bfor example\b|\bask for\b|\bname the\b|\btry\b/i.test(o.explanation)) noNextStep.push(`${where}: ${o.explanation}`);
  };
  UNMAPPED.length = 0;
  for (const c of all) {
    const turns: [string, () => ShadowOutcome][] = [...(c.setup ?? []).map((s): [string, () => ShadowOutcome] => [`${c.id} setup`, () => ask(s.question)]),
      [c.id, () => (c.setup?.length && c.rewrite !== undefined ? (shadowFollowUp(c.setup[c.setup.length - 1].question, c.question, deps) as ShadowOutcome) : ask(c.question))]];
    for (const [where, run] of turns) {
      try { const o = run(); walk(o, where, 0); nextStep(o, where); } catch (e) { errors.push(`${where}: ${String(e).slice(0, 160)}`); }
    }
  }
  // Questions no case asks: the preview findings' and the Codex review's inputs, and the coordinator's weak declines.
  for (const q of ["Rape clearances by type by victim in Memphis in 2024", "Robberies where a firearm was seized in Memphis in 2024", "Burglaries in Memphis in 2023",
    "Shoplifting and carjackings combined in Memphis in 2024", "aggravated assault victims by weapon in Detroit in 2023", "murders rolling over 12 months in Detroit in 2024",
    "fentanyl offenses in Detroit in 2024", "Did shoplifting go up in Detroit from 2022 to 2023?", "Simple assault victims in Detroit by race and sex in 2023",
    "Shoplifting in Memphis in 2024 and in 2025", "Which Texas cities had the biggest increase in robberies in 2024?", "robberies in Denver compared with peer agencies in 2024"]) {
    try { const o = ask(q); walk(o, q, 0); nextStep(o, q); } catch (e) { errors.push(`${q}: ${String(e).slice(0, 160)}`); }
  }
  // Jeff's rule (coordinator, 2026-11-01): every decline offers a concrete next step, a button or a working example.
  assert.deepEqual(noNextStep, [], "every decline offers a button or an example");
  assert.ok(seen.size > 300, `the walk covers the strings (${seen.size})`);
  assert.deepEqual(errors, [], "no case question throws");
  assert.deepEqual(bad, [], "no engine words reach a user");
  assert.deepEqual(UNMAPPED, [], "every reader sentence has a plain wording");
  // Jeff's example (Codex preview-blockers review 1): the reader's own reason, reworded, never "didn't understand".
  assert.match(as(ask("Rape clearances by type by victim in Memphis in 2024"), "decline").explanation, /^Clearances are recorded for each offense, not for each person, so they can't be counted by "victim"\./);
}

// Jeff (2026-11-01): "it assumes everything is a follow up." A turn that stands on its own is a new question, answered
// as a first question would be, whatever came before; never "could not be placed ... ask the full question".
{
  const chicago = shadowFollowUp("Shoplifting in Memphis by year from 2021 to 2024", "Murders in Chicago in 2024", deps);
  assert.equal(chicago.rewriteKind, "new");
  assert.deepEqual({ ...chicago, rewrite: undefined, rewriteKind: undefined }, { ...ask("Murders in Chicago in 2024"), rewrite: undefined, rewriteKind: undefined });
  const det = shadowFollowUp("Murder victims in Houston by race in 2024", "Did shoplifting go up in Detroit from 2022 to 2023?", deps);
  assert.equal(det.rewriteKind, "new");
  assert.ok(det.kind !== "clarify" || !/could not be placed/.test(det.about), "never 'could not be placed' for a question of its own");
  // PR1 (follow-up failures, Jeff 2026-11-19): a turn the rules find no edit in, that points back at nothing, is a question of its own
  // ("Puerto Rico Crime" asked what it changes); when its first-turn result would be a decline, the question back stays.
  const own = shadowFollowUp("robberies in Memphis in 2024", "Puerto Rico Crime", deps);
  assert.equal(own.rewriteKind, "new");
  assert.deepEqual({ ...own, rewrite: undefined, rewriteKind: undefined }, { ...ask("Puerto Rico Crime"), rewrite: undefined, rewriteKind: undefined });
  const kept = shadowFollowUp("conviction rates for murders in Houston", "how many offenders were sentenced to prison", deps);
  assert.equal(kept.rewriteKind, "ask", "a first-turn decline keeps the question about the last turn");
  const pointing = shadowFollowUp("robberies in Memphis in 2024", "Puerto Rico Crime again", deps);
  assert.notEqual(pointing.rewriteKind, "new", "a turn that points back is not a new question");
  // A new question with no period, after one with a period: that period is offered as a button, never assumed.
  const shop = shadowFollowUp("Shoplifting in Memphis in 2023", "Shoplifting in Detroit", deps);
  assert.equal(shop.rewriteKind, "new");
  const offered = shop.kind === "answer" ? shop.buttons ?? [] : shop.kind === "clarify" ? shop.options : shop.kind === "decline" && shop.alternative ? [shop.alternative] : [];
  assert.ok(offered.some((b) => b.question === "Shoplifting in Detroit in 2023" && !b.continuation), JSON.stringify(offered));
  // A turn that points back stays a follow-up.
  assert.equal(shadowFollowUp("Shoplifting in Memphis in 2024", "what about Nashville?", deps).rewriteKind, "rewrite");
  // Codex review 1: a comparison is never answered as a single place; it stays on the follow-up path (asked or proposed).
  for (const f of ["How does that compare to shoplifting in Nashville in 2024?", "Can you compare shoplifting in Nashville in 2024?"]) {
    const cmp = shadowFollowUp("Shoplifting in Memphis in 2024", f, deps);
    assert.notEqual(cmp.rewriteKind, "new", f);
    assert.ok(cmp.kind !== "answer" || cmp.plan.geography.places.length > 1, `no single-place answer: ${f}`);
  }
}

// Jeff (2026-11-01): stacked and 100% charts only when honest. A category grouping says whether its categories are
// exclusive (sum to the total): one per kind. Time and place groupings carry no flag.
{
  const flag = (q: string) => as(ask(q), "answer").delivered.table.columns.filter((c) => c.binding.kind === "grouping").map((c) => [(c.binding as { dimension: string }).dimension, "exclusive" in c ? c.exclusive : "none"]);
  assert.deepEqual(flag("Simple assault victims in Detroit by sex in 2023"), [["victim.sex", true]]);
  assert.deepEqual(flag("Aggravated assault victims in Memphis in 2024 by race"), [["victim.race", true]]);
  assert.deepEqual(flag("Robberies in Memphis in 2024 by weapon"), [["offense_weapon.weapon", false]]);                 // a crime can have several weapons
  assert.deepEqual(flag("Aggravated assault victims in Memphis in 2024 by offender race"), [["offender.race", false]]);  // an incident's several offenders (P49)
  assert.deepEqual(flag("Simple assault victims in Detroit in 2023 by relationship to the offender"), [["victim_offender.relationship", false]]);
  assert.deepEqual(flag("Shoplifting in Memphis by month in 2024"), [["time.month", "none"]]);
  // The grouping's flag is for the primary count; the incidents beside it (P66) carry their own. Codex review 01 (P1):
  // the cleared victims' incidents overlap across sexes; a clearance grouping is of the incident, so its incidents sum.
  const incidents = (q: string) => (as(ask(q), "answer").delivered.table.columns.find((c) => c.header === "Incidents") as { exclusive?: boolean }).exclusive;
  assert.deepEqual(flag("Simple assault victims in Detroit by sex in 2023 that were cleared"), [["victim.sex", true]]);
  assert.equal(incidents("Simple assault victims in Detroit by sex in 2023 that were cleared"), false);
  assert.deepEqual(flag("Carjacking offenses in Memphis by clearance status in 2024"), [["offense.clearance_status", true]]);
  assert.equal(incidents("Carjacking offenses in Memphis by clearance status in 2024"), true);
  // Exclusive exactly when the overlap note is not given.
  for (const q of ["Robberies in Memphis in 2024 by weapon", "Simple assault victims in Detroit by sex in 2023"]) {
    const a = as(ask(q), "answer");
    const cat = a.delivered.table.columns.find((c) => c.binding.kind === "grouping" && "exclusive" in c) as { exclusive: boolean };
    assert.equal(cat.exclusive, !a.delivered.answerStatements.includes("categories_overlap"), q);
  }
}

// Jeff (2026-11-01): never a percent contrasted with a rate, and never "resident" (banned wording, wording.ts).
{
  const text = (q: string) => as(ask(q), "answer").delivered.text.join(" / ");
  assert.doesNotMatch(text("Simple assault victims in Detroit by sex in 2023"), /not a rate|resident/);
  assert.doesNotMatch(text("Shoplifting rate in Wichita in 2024"), /resident/);
  assert.ok(jargon("Shoplifting per 100,000 residents").length > 0 && jargon("a percent, not a rate").length > 0, "both banned");
  for (const t of ["Sorry, I can't answer that.", "I apologize", "Unfortunately the data", "I'm afraid not"]) assert.ok(jargon(t).length > 0, `apology banned: ${t}`);
}

// The nearest question that works, the breakdown kept (coordinator, 2026-11-01): victims by weapon as offenses by
// weapon; "cleared" read into the crime's name asked as "that were cleared".
{
  const weapon = as(ask("Murder victims in Memphis in 2024 by weapon"), "decline");
  assert.match(weapon.explanation, /^Weapons are recorded for each offense, not for each victim/);
  assert.equal(weapon.alternative?.question, "Murder offenses in Memphis in 2024 by weapon");
  const cleared = as(ask("Homicide victims cleared in Memphis 2024"), "decline");
  assert.equal(cleared.alternative?.question, "Homicide victims in Memphis 2024 that were cleared");
  assert.equal(as(ask("Aggravated assaults cleared in Memphis in 2024"), "decline").alternative?.question, "Aggravated assaults in Memphis in 2024 that were cleared");
  // Codex decline review 01 (P2): a button keeps the conditions the reader set aside from its text.
  const two = ask("Shoplifting in Memphis in 2024 and in 2025 that were cleared");
  const twoQs = two.kind === "clarify" ? two.options.map((x) => x.question) : two.kind === "decline" && two.alternative ? [two.alternative.question] : [];
  assert.ok(twoQs.every((t) => !t || /that were cleared/.test(t)), JSON.stringify(twoQs));
  const wc = ask("Murder victims in Memphis in 2024 by weapon that were cleared");
  assert.ok(wc.kind !== "decline" || !wc.alternative?.question || /cleared/.test(wc.alternative.question), JSON.stringify(wc).slice(0, 300));
  // Follow-up options: only those the reader reads whole ("...victims with a female offender" is two counting units).
  const fem = shadowFollowUp("Simple assault victims in Memphis in 2024", "female", deps);
  assert.ok(fem.kind === "clarify" && fem.options.every((x) => x.label !== "Count female offenders"), JSON.stringify(fem).slice(0, 400));
}
// Jeff (2026-11-01): the Consistent Reporting Agencies are one set, complete for every month of the WHOLE span asked,
// used for every year; never a per-year every-month set. Austin misses June 2024 only: it is out of the set for 2023 too.
{
  const span = as(ask("Carjackings in Texas by year from 2023 to 2024, with the number of agencies reporting"), "answer");
  const ev = as(span.buttons![0].continuation!, "answer");
  assert.equal(span.stateSum!.everyAgencies, 3);
  assert.deepEqual(ev.delivered.table.rows.map((r) => r[2]), [3, 3], "the same set each year");
  assert.ok(ev.delivered.text.some((t) => /^Counts only the 3 Consistent Reporting Agencies that reported every month from January 2023 through December 2024\.$/.test(t)), ev.delivered.text.join(" / "));
  assert.ok(span.stateSum!.years.find((y) => y.year === 2023)!.agencies > 3, "Austin reported 2023 in full, yet is not in the set");
}
// Jeff (2026-11-16): for ONE agency a month reported as zero crimes is NOT reported: left out of a total, blank in a chart, no rolling window
// over it. The 2025 total of the other 11 months is shown and says July is left out; never a 0 for July.
{
  const total = () => as(ask("Shoplifting in Memphis in 2025"), "answer");
  const clean = total();
  assert.ok(!clean.delivered.text.some((t) => /left out|is blank/.test(t)), "no month left out, no sentence");
  AZERO = ["2025-07"];
  const one = total();
  assert.equal(one.delivered.table.rows[0][0], 77, "11 months of 7");
  assert.ok(one.delivered.text.includes("July 2025 is left out: the agency reported no crimes that month."), one.delivered.text.join(" | "));
  const monthly = as(ask("Shoplifting in Memphis by month in 2025"), "answer");
  assert.equal(monthly.delivered.table.rows.length, 12);
  assert.equal(monthly.delivered.table.rows.find((r) => r[0] === "2025-07")![1], null, "a gap, never 0");
  assert.ok(monthly.delivered.text.includes("July 2025 is blank: the agency reported no crimes that month."), monthly.delivered.text.join(" | "));
  const rollz = as(ask("Rolling 12-month shoplifting in Detroit since 2025"), "answer");
  assert.equal(rollz.delivered.table.rows.find((r) => r[0] === "2025-12")![1], null, "a window holding July 2025 is blank");
  assert.ok(rollz.delivered.text.includes("No crimes were reported in July 2025, so no rolling total is given for any window containing it."), rollz.delivered.text.join(" | "));
  AZERO = ["2025-03", "2025-07"];
  assert.ok(total().delivered.text.includes("March and July 2025 are left out: the agency reported no crimes in those months."));
  assert.equal(total().delivered.table.rows[0][0], 70);
  AZERO = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, "0")}`);
  const none = total();
  assert.equal(none.delivered.table.rows[0][0], null);
  assert.ok(none.delivered.text.includes("The agency has no reported crimes or data for any month of 2025, so no total is given."), none.delivered.text.join(" | "));
  AZERO = [];
  const sameAgain = total();
  assert.equal(sameAgain.delivered.table.rows[0][0], 84, "the ordinary figure is back");
}
// Follow-up errors (2026-11-17): a complete question typed as a follow-up runs as a question of its own (never "I couldn't tell how this changes
// your last question"), and "crime in <place>" asks which kind of crime (D09); a real edit still rewrites.
{
  const fu = (prev: string, q: string) => shadowFollowUp(prev, q, deps) as { kind: string; rewriteKind?: string; about?: string };
  assert.equal(fu("Indianapolis homicide rate trend", "Compare homicide rates in Tampa, New York City, and San Francisco since 1980").rewriteKind, "new");
  const crime = fu("murders in Houston since 2010", "crime in Portland since 2010");
  assert.equal(crime.rewriteKind, "new");
  assert.notEqual(crime.kind, "answer", "a bare 'crime' is asked about, never answered");
  assert.equal(fu("Shoplifting in Memphis in 2024", "now for 2023").rewriteKind, "rewrite", "a real edit still rewrites");
  assert.equal(fu("Shoplifting in Memphis in 2024", "just females").rewriteKind === "new", false, "an edit is not run as a new question");
}
// Jeff (2026-11-16): a month reported as zero crimes is NOT reported. Dallas has a REPORTED_ZERO month in March 2023: it is out of the
// Consistent Reporting Agencies for a span holding that month, in the set for a span that avoids it, and the ordinary view keeps its sums.
{
  const Q = (span: string) => `Carjackings in Texas ${span}, with the number of agencies reporting`;
  const base = as(ask(Q("by year from 2023 to 2024")), "answer");
  ZERO = { ori: "TXDPD0000", ym: "2023-03" };
  const withZero = as(ask(Q("by year from 2023 to 2024")), "answer");
  const avoids = as(ask(Q("in 2024")), "answer");
  ZERO = null;
  const clean = as(ask(Q("in 2024")), "answer");
  // No agency reported every month: no button for an empty set (never "counting only the 0 Consistent Reporting Agencies").
  ZERO = { ori: "*", ym: "2024-03" };
  const nobody = as(ask(Q("in 2024")), "answer");
  ZERO = null;
  assert.equal(nobody.stateSum!.everyAgencies, 0);
  assert.ok(!nobody.buttons || nobody.buttons.length === 0, "no button for an empty set");
  // Asked for the Consistent Reporting Agencies when no agency reported every month: a plain decline, never "counting only the 0".
  ZERO = { ori: "*", ym: "2024-03" };
  const noneAsked = as(ask("Carjackings in Texas in 2024 for consistent reporters"), "decline");
  ZERO = null;
  assert.equal(noneAsked.explanation, "No agency reported crimes in every month from January 2024 through December 2024, so there are no Consistent Reporting Agencies for Texas.");
  // The same by a category (QL-nibrs-cc6769f8d6: "violent crimes by offender age by year for california ... for consistent reporters" threw
  // "Cannot access 'span' before initialization": the category path read a name declared after it returned).
  ZERO = { ori: "*", ym: "2024-03" };
  const byCat = ask("Simple assault victims in Kansas by sex in 2024 for consistent reporters");
  ZERO = null;
  assert.ok(byCat.kind === "decline" && /^No agency reported crimes in every month from January 2024 through December 2024, so there are no Consistent Reporting Agencies for Kansas\.$/.test(byCat.explanation), JSON.stringify(byCat).slice(0, 300));
  assert.equal(withZero.stateSum!.everyAgencies, base.stateSum!.everyAgencies - 1, "the agency with a zero month leaves the set");
  assert.equal(avoids.stateSum!.everyAgencies, clean.stateSum!.everyAgencies, "and stays in for a span that avoids the month");
  assert.deepEqual(withZero.stateSum!.years.map((y) => y.agencies), base.stateSum!.years.map((y) => y.agencies), "the ordinary view still counts it as reporting");
  assert.equal(withZero.stateSum!.years[0].sum, base.stateSum!.years[0].sum - 7, "the ordinary view sums the zero month as 0 (Dallas had 7 that month)");
}
// P83, P84 (Jeff 2026-11-01): gun violence offers gun crime; car break-ins say how they are counted.
{
  const gv = as(ask("Gun violence in Memphis in 2024"), "decline");
  assert.match(gv.explanation, /no counts of non-fatal shootings/);
  assert.equal(gv.alternative?.question, "Gun crime in Memphis in 2024");
  assert.ok(as(ask("Car break-ins in Memphis in 2024"), "answer").delivered.text.includes("Car break-ins are counted as theft from motor vehicles."));
  assert.ok(!as(ask("Theft from motor vehicles in Memphis in 2024"), "answer").delivered.text.some((t) => /Car break-ins/.test(t)));
  // Codex coverage review 01.1: the gun-crime button keeps every condition asked, or is not offered.
  const gvc = as(ask("Gun violence in Texas in 2024, only agencies that reported every month"), "decline");
  assert.ok(!gvc.alternative || /only agencies that reported every month/.test(gvc.alternative.question ?? ""), JSON.stringify(gvc.alternative));
  // Never more than 100% covered (Jeff 2026-11-01): the agencies' own population estimates can sum past the place's.
  assert.equal(coveredText(100.1, false), "100.0%");
  assert.equal(coveredText(84.06, true), "≥84.1%");
  // Codex coverage review 01.2: the button's coverage columns are checked too, whatever the label asks (shown when asked, P87).
  const tampered = { ...txCjA, buttons: txCjA.buttons!.map((x) => ({ ...x, continuation: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>),
    delivered: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>).delivered, table: { ...(x.continuation as Extract<ShadowOutcome, { kind: "answer" }>).delivered.table, rows: [[252, 999, "99.9%"]] } } } })) };
  assert.equal(scoreShadow(sumLabel, tampered as ShadowOutcome, r, ctx, sumV(307)).result!.values, "mismatch");
}
// Jeff (2026-11-01), his exact question: "vs" joins places, and an offered question must answer and keep every place
// and crime asked; never one built by deleting words ("chicago memphis carjackings per year since 2022").
{
  const jeff = ask("chicago vs memphis carjackings per year since 2022");
  assert.ok(jeff.kind !== "decline" || !jeff.alternative || /chicago/i.test(jeff.alternative.question ?? "") && /memphis/i.test(jeff.alternative.question ?? ""), JSON.stringify(jeff).slice(0, 300));
  assert.ok(jeff.kind !== "decline" || !/^This isn't available: to compare/i.test(jeff.explanation), "vs is read as places side by side");
  const cmp = ask("Chicago compared to Memphis carjackings in 2024");
  assert.ok(cmp.kind === "answer" && cmp.plan.geography.places.length === 2, JSON.stringify(cmp).slice(0, 200));
}
// A period starting before the data: the covered part, to the month asked, never widened (Codex period review 01.1).
{
  // Jeff 2026-11-14: the one monthly source that reaches into the span answers, saying why; the asked end is kept.
  const before = as(ask("Shoplifting in Memphis from January 2016 to March 2024"), "answer");
  assert.deepEqual(before.period, { from: "2017-01", to: "2024-03" });
  assert.equal(before.delivered.text[1], "Monthly figures for Memphis, Tennessee start in January 2017 (NIBRS). Showing NIBRS monthly figures from January 2017.");
  assert.equal(readQuestion("Chicago robberies after 2010", 2026, "2026-09").ledger.parts.find((p) => p.concept === "period")?.value, "since:2011", "after 2010 starts with 2011");
}
// Coordinator 2026-11-02 (the redesign's retest of #96). 1: a breakdown the question names is never dropped.
{
  assert.deepEqual(namedGroupings("Robbery offenders in Memphis by age and year from 2022 to 2024").map((g) => g.word), ["year", "age"]);
  assert.deepEqual(namedGroupings("Robbery rate per 100,000 in Memphis in 2024, by men and women").map((g) => g.word), []);
  assert.deepEqual(missingGroupings("Robbery offenders in Memphis by age and year from 2022 to 2024", ["offender.age"]), ["year"]);
  assert.deepEqual(missingGroupings("Shoplifting in Memphis per month in 2024", ["time.month"]), []);
  // Codex guard review 01: how often agencies reported is not a breakdown; a comma or parenthesis before the period
  // ends the phrase, never hides it; "had" is not a request for the agencies reporting.
  assert.deepEqual(namedGroupings("Shoplifting in Texas by year from 2023 to 2024, only agencies that reported each month").map((g) => g.word), ["year"]);
  assert.deepEqual(missingGroupings("Robbery offenders in Detroit by age and year, 2022 to 2024", ["offender.age"]), ["year"]);
  assert.deepEqual(namedGroupings("How many robberies did Detroit report each year from 2022 to 2024?").map((g) => g.word), ["year"]);
  assert.deepEqual(missingGroupings("Robbery offenders in Detroit by age and year (2022 to 2024)", ["offender.age"]), ["year"]);
  assert.equal((readQuestion("How many agencies had shoplifting in Kansas in 2024", 2026, "2026-09").ledger as unknown as { column: unknown }).column, null);
  assert.equal((readQuestion("How many agencies reported shoplifting in Kansas in 2024", 2026, "2026-09").ledger as unknown as { column: unknown }).column, "agencies");
  // (Age by year itself is read in test-nibrs-shadow-reading; this stub has no year-by-category rows.)
  // 2: one Unknown row, last, even when it is the largest; no offender identified counted in it in SQL.
  const race = as(ask("Robbery offenders in Detroit by race in 2023"), "answer");
  assert.deepEqual(race.delivered.table.rows.map((r) => r[0]), ["Black", "White", "Unknown"]);
  // 3: the agencies reporting, asked in other words.
  for (const q of ["how many agencies reported shoplifting in Kansas in 2024", "agencies reporting shoplifting in Kansas in 2024", "shoplifting in Kansas in 2024 with coverage"])
    assert.deepEqual(as(ask(q), "answer").delivered.table.columns.map((c) => c.header), ["Shoplifting offenses", "Agencies reporting", "Population covered"], q);
}
// Codex month review 02.1: the leading-gap exemption applies only where delivery trims (its first row reported); an
// answer of unknown months that leaves rows out is still a mismatch.
{
  const base = as(ask("Shoplifting in Detroit by month in 2024"), "answer");
  const st = base.plan.statistics[0].as;
  const allBlank = { ...base, delivered: { ...base.delivered, table: { ...base.delivered.table, rows: [["2024-12", null]] }, evidence: [{ row: 0, statistic: st, status: "UNKNOWN" as const }] } };
  const want = Array.from({ length: 12 }, (_, i) => ({ key: `2024-${String(i + 1).padStart(2, "0")}`, value: null, status: "UNKNOWN" }));
  assert.equal(valueDiffs("", allBlank, want).values, "mismatch");
  const trimmed = { ...base, delivered: { ...base.delivered, table: { ...base.delivered.table, rows: [["2024-03", 7]] }, evidence: [{ row: 0, statistic: st, status: "VALUE" as const }] } };
  const wantTrim = [{ key: "2024-01", value: null, status: "UNKNOWN" }, { key: "2024-02", value: null, status: "UNKNOWN" }, { key: "2024-03", value: 7, status: "VALUE" }];
  assert.equal(valueDiffs("", trimmed, wantTrim).values, "match", "a real leading gap, trimmed");
  // Zero categories (ZERO_CATEGORIES): a known 0 listed on one side only is no difference, but never with a share that
  // is not 0 (Codex scorer check 01).
  const sexes = as(ask("Simple assault victims in Detroit by sex in 2023"), "answer");
  const cs = sexes.plan.statistics.map((s) => s.as);
  const withZero = (share: number) => ({ ...sexes, delivered: { ...sexes.delivered,
    table: { ...sexes.delivered.table, rows: [["Female", 30, 60], ["Male", 20, 40], ["Non-binary", 0, share]] },
    evidence: [0, 1, 2].flatMap((row) => cs.map((statistic) => ({ row, statistic, status: "VALUE" as const }))) } });
  const wantSexes = [{ key: "Female", value: 30, status: "VALUE", share: 60 }, { key: "Male", value: 20, status: "VALUE", share: 40 }];
  assert.equal(valueDiffs("", withZero(0), wantSexes).values, "match", "a 0 category listed: the same as left out");
  assert.equal(valueDiffs("", withZero(99), wantSexes).values, "mismatch", "a 0 count with a 99% share is wrong");
}
// Jeff 2026-11-02 ("we can't breakdown by month?"): the shadow answers a breakdown by month or quarter from the monthly
// build; the live route's reader (yearly summary tables) still declines it.
{
  const led = readQuestion("Aggravated assault victims in Nashville by sex and month in 2023", 2026, "2026-09").ledger;
  assert.equal(matchNibrsType(led).kind, "decline", "live: unchanged");
  const d = matchNibrsType(led, { monthlyBreakdowns: true });
  assert.ok(d.kind === "spec" && d.spec.type === "breakdown" && d.spec.byMonth === true, JSON.stringify(d));
  assert.equal(matchNibrsType(readQuestion("Aggravated assault victims in Nashville by sex by year by month in 2023", 2026, "2026-09").ledger, { monthlyBreakdowns: true }).kind, "decline", "by year and by month at once");
}

// Before NIBRS's years (Jeff 2026-11-09): murder is Homicide Reports' from 1976 (by month, weapon), never "not in the
// data"; another crime says NIBRS's span and that Crime Index has yearly figures (agencies from 1930, states from 1960).
for (const q of ["oakland murders per month in 1996", "firearm murders in Louisville in 2003", "DC murders per month in 1996 and 1997"]) {
  const o = ask(q);
  assert.ok(o.kind === "route" && o.source === "shr", `${q}: ${JSON.stringify(o).slice(0, 200)}`);
}
{
  const o = ask("robberies per month in Oakland in 1996");
  assert.ok(o.kind === "decline" && o.explanation.startsWith("NIBRS figures here cover") && !/^The data here/.test(o.explanation), JSON.stringify(o).slice(0, 300));
  const m = ask("murders per month in Oakland in 1970");
  assert.ok(!(m.kind === "route" && m.source === "shr"), "1970 is before Homicide Reports");
  // Only Homicide Reports' own units and details (Codex coverage review 1).
  for (const q of ["murder offenders in Oakland in 1996", "murders at residences in Oakland in 1996", "murders cleared by arrest in Oakland in 1996"]) {
    const x = ask(q);
    assert.ok(!(x.kind === "route" && x.source === "shr"), `${q}: ${JSON.stringify(x).slice(0, 200)}`);
  }
}
// SHR-B: big cities ranked by a murder detail come from Homicide Reports when a release is loaded (Jeff's order after
// the population carry); without a period the period is asked; the ask's button runs; a detail the reader didn't place
// is never dropped silently.
{
  const rankStub = (sql: string): unknown[][] => (/WITH big AS/.test(sql)
    ? [["TXHPD0000", "HOUSTON", "TX", 2300000, true, 300, 240], ["TXDPD0000", "DALLAS", "TX", 1300000, true, 100, 90], ["ILCPD0000", "CHICAGO", "IL", 2700000, false, 0, 0]] : []);
  const rdeps = { ...deps, execute: rankStub, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const fire = shadowAnswer("Big cities with highest share of murders via firearm in 2024", rdeps);
  assert.equal(fire.kind, "shr", JSON.stringify(fire).slice(0, 300));
  if (fire.kind === "shr") {
    assert.deepEqual(fire.delivered.table.rows, [["DALLAS, TX", 90], ["HOUSTON, TX", 80]]);
    assert.ok(fire.question.ranking && fire.question.share && fire.question.filters[0].dim === "weapon");
  }
  for (const [q, text] of [["Big cities with the highest number of homicides by knife or sharp object", "Homicide Victims Killed With a Weapon Recorded as Knife or Cutting Instrument"],
    ["Big cities with the highest % of teenage homicide victims", "Share of Homicide Victims Aged 13 to 19"],
    ["Big cities with the highest proportion of teenage homicide victims (13-19)", "Share of Homicide Victims Aged 13 to 19"]]) {
    const ask1 = as(shadowAnswer(q, rdeps), "clarify");
    assert.equal(ask1.about, "which period", q);
    const go = ask1.options[0].continuation!;
    // The title reads the question back: the place, the measure, "by City", then the timeframe (Jeff 2026-11-21).
    assert.ok(go.kind === "shr" && go.delivered.text[0].includes(text) && go.delivered.text[0].startsWith("United States ") && go.delivered.text[0].endsWith(", 2025"), `${q}: ${JSON.stringify(go).slice(0, 300)}`);
  }
  assert.equal(shadowAnswer("Show me which big cities had the highest share of firearm murders in 2024", rdeps).kind, "shr", "an opener and \"which\" are only words");
  // Without a release it stays Homicide Reports' (the tab has them), as before.
  const old = shadowAnswer("Big cities with highest share of murders via firearm in 2024", deps);
  assert.ok(old.kind === "route" && old.source === "shr", JSON.stringify(old).slice(0, 200));
  // Another detail or a juvenile ("under 18") isn't this ranking's: still routed, never read as teens.
  // Codex review: nothing the reader read is silently dropped; each of these stays off the ranking route.
  for (const q of ["Big cities with highest firearm murder rates in 2024", "Big cities with highest share of firearm murders in 2024 by month",
    "Big cities with highest share of firearm murders in 2024 compared with 2023", "Big cities with highest share of firearm murders of juvenile victims in 2024",
    "Big cities with highest share of murders with a firearm during an argument in 2024", "Big cities with highest share of murders via firearm or sharp object in 2024",
    "Big cities with the highest share of teenage homicide victims aged 15 to 17 in 2024"]) {
    const x = shadowAnswer(q, rdeps);
    assert.ok(x.kind !== "shr", `${q}: ${JSON.stringify(x).slice(0, 200)}`);
  }
  const juv = shadowAnswer("Big cities with the highest share of juvenile homicide victims in 2024", rdeps);
  assert.ok(juv.kind !== "shr", JSON.stringify(juv).slice(0, 200));
}
// Group 5: several agencies by month (a row per agency and month; a month not reported is blank, never 0).
{
  const m = as(ask("Dallas vs Austin murders by month in 2024"), "answer");
  assert.deepEqual(m.delivered.table.columns.map((c) => c.header), ["Agency", "Month", "Murder victims"]);
  assert.equal(m.delivered.table.rows.length, 24);
  assert.deepEqual(m.delivered.table.rows.find((r) => r[0] === "Austin Police Department" && r[1] === "2024-06"), ["Austin Police Department", "2024-06", null], "a month not known is blank");
  assert.equal(m.delivered.table.rows.find((r) => r[0] === "Dallas Police Department" && r[1] === "2024-06")![2], 7);
  assert.ok(m.delivered.text.some((t) => /^No data is available for June 2024 for Austin/.test(t)), JSON.stringify(m.delivered.text));
  assert.equal(m.delivered.contractProblems.length, 0);
  // No period named: every month in the data, said, not an ask.
  const all = as(ask("Dallas vs Houston murders per month"), "answer");
  assert.ok(all.delivered.text.some((t) => /^No years were given, so every year in the data is shown: January 2017 through September 2026\.$/.test(t)), JSON.stringify(all.delivered.text));
  // "LAPD" is the Los Angeles Police Department, never an ask beside the County Sheriff.
  assert.equal(ask("LAPD vs NYPD murders per month in 2024").kind, "answer");
  // A rate, or both agencies combined by month, is still not this table.
  assert.notEqual(ask("Dallas vs Houston murder rates per month in 2024").kind, "answer");
}
// Item 2 and the intimate partner rule (Jeff 2026-11-15), through the engine: two weapons compared, and the trend of
// intimate partner homicides with no years named, are Homicide Reports answers; the one sentence about ex-partners is said.
{
  const cstub = (sql: string): unknown[][] => (/count\(DISTINCT agency_key\)/.test(sql) ? Array.from({ length: 42 }, (_, i) => [1985 + i, 100, ["ori9:A"]])
    : /nation_crime/.test(sql) ? Array.from({ length: 42 }, (_, i) => [1985 + i, 1000]) : /sum\(population\)/.test(sql) ? [[800]]
    : /GROUP BY/.test(sql) ? (/k1/.test(sql) ? [[2024, "0", 7], [2024, "1", 9]] : /k0/.test(sql) && /CASE WHEN r\.weapon/.test(sql) ? [["0", 7], ["1", 9]] : [[2024, 11]]) : []);
  const cdeps = { ...deps, execute: cstub, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const gk = shadowAnswer("Compare gun murders vs knife murders nationally in 2024", cdeps);
  assert.equal(gk.kind, "shr", JSON.stringify(gk).slice(0, 300));
  if (gk.kind === "shr") assert.deepEqual(gk.delivered.table.rows.map((r) => r[0]), ["Knife or cutting instrument", "Firearm"]);
  const ip = shadowAnswer("How have intimate partner homicides trended nationwide?", cdeps);
  assert.equal(ip.kind, "shr", JSON.stringify(ip).slice(0, 300));
  if (ip.kind === "shr") assert.ok(ip.delivered.text.includes("This data source does not record ex-boyfriend and ex-girlfriend relationships."));
  // Without a compare word, two weapons stay off this path.
  assert.notEqual(shadowAnswer("Handgun murders and rifle murders nationally in 2024", cdeps).kind, "shr");
}
// Jeff 2026-11-15: several agencies by month come from Current Trends (Crime Index) for the whole table, one source line;
// an agency it has no figure for is blank; NIBRS only by name, and then an agency with no NIBRS reports is declined with
// Crime Index offered.
{
  const ctStub = (sql: string): unknown[][] => {
    if (/count\(\*\) FROM read_parquet\('[^']*current_crime/.test(sql)) return [[20]];
    // A group's published months (the nation, 2025-01 on): the sample-flagged agencies, 3,000 murders a month from 547 agencies of 111 million people.
    if (/WHERE sample/.test(sql)) {
      const [, a, b] = /BETWEEN '(\d{4}-\d{2})' AND '(\d{4}-\d{2})'/.exec(sql)!;
      const out: unknown[][] = [];
      for (let y = +a.slice(0, 4), m = +a.slice(5); `${y}-${String(m).padStart(2, "0")}` <= b; m === 12 ? (y++, (m = 1)) : m++) if (y >= 2025) out.push([`${y}-${String(m).padStart(2, "0")}`, 3000, 547, 111272916, 0]);
      return out;
    }
    // A group over a span (the nation): the agencies with a figure in every month of it, 3,000 murders a month from 547 agencies of 111 million people.
    if (/full_span/.test(sql)) {
      if (/count\(\*\), coalesce/.test(sql)) return [[547, 111210214]];
      const [, a, b] = /BETWEEN '(\d{4}-\d{2})' AND '(\d{4}-\d{2})'/.exec(sql)!;
      const out: unknown[][] = [];
      for (let y = +a.slice(0, 4), m = +a.slice(5); `${y}-${String(m).padStart(2, "0")}` <= b; m === 12 ? (y++, (m = 1)) : m++) out.push([`${y}-${String(m).padStart(2, "0")}`, 3000]);
      return out;
    }
    if (/current_crime\.parquet[\s\S]*UNION ALL/.test(sql)) {
      const ori = /WHERE ori = '([^']+)'/.exec(sql)![1];
      const [, from, to] = /BETWEEN '(\d{4}-\d{2})' AND '(\d{4}-\d{2})'/.exec(sql)!;
      const out: unknown[][] = [];
      for (let y = +from.slice(0, 4), m = +from.slice(5); `${y}-${String(m).padStart(2, "0")}` <= to; m === 12 ? (y++, (m = 1)) : m++) out.push([`${y}-${String(m).padStart(2, "0")}`, ori === "TXHPD0000" && y === 2026 && m === 8 ? null : 11]);
      return out;
    }
    return stub(sql);
  };
  const cdeps = { ...deps, execute: ctStub, current: { root: "/ct", release: "ct-test", firstMonth: "2025-01", lastMonth: "2026-08", finalFirstMonth: "2017-01" } } as unknown as ShadowDeps;
  const sev = shadowAnswer("Dallas vs Houston murders per month", cdeps);
  assert.equal(sev.kind, "current", JSON.stringify(sev).slice(0, 300));
  if (sev.kind === "current") {
    assert.deepEqual(sev.delivered.table.columns.map((c) => c.header), ["Place", "Month", "Murders"]);
    assert.equal(sev.delivered.table.rows.length, 2 * 116, "every month of 2017-01 to 2026-08 for each");
    assert.ok(sev.delivered.text.includes("No years were given, so every month in the data is shown: January 2017 through August 2026."), JSON.stringify(sev.delivered.text));
    assert.ok(sev.delivered.text.some((t) => /^No figure is available for August 2026 for Houston, Texas: shown blank, not zero\.$/.test(t)));
    assert.equal(sev.delivered.text[sev.delivered.text.length - 1], "Source: Crime Index.");
  }
  // P154 (Jeff 2026-11-19): rolling totals by month, from Current Trends. No timespan named: the first row is the first January with a full
  // window; "since 2019": January 2019; "since 2016" (before the data): the first full January and the outside sentence.
  {
    const roll = (q: string) => { let r: ShadowOutcome; try { r = shadowAnswer(q, cdeps); } catch (e) { assert.fail(`${q}: ${(e as Error).stack?.split("\n").slice(0, 6).join(" | ")}`); } assert.equal(r.kind, "current", `${q}: ${JSON.stringify(r).slice(0, 300)}`); return r as Extract<ShadowOutcome, { kind: "current" }>; };
    const r1 = roll("Dallas murders rolling over 12 months");
    assert.equal(r1.delivered.text[0], "Dallas, Texas Murders Rolling Over 12 Months, Jan 2018-Aug 2026");
    assert.deepEqual(r1.delivered.table.rows[0], ["2018-01", 132]);
    assert.deepEqual(r1.delivered.table.rows[r1.delivered.table.rows.length - 1], ["2026-08", 132]);
    assert.ok(!r1.delivered.text.some((t) => /Current Trends figures in the data cover/.test(t)), "no note about when Current Trends starts");
    const r2 = roll("Dallas murders rolling over 12 months since 2019");
    assert.equal(r2.delivered.text[0], "Dallas, Texas Murders Rolling Over 12 Months, Jan 2019-Aug 2026");
    assert.deepEqual(r2.delivered.table.rows[0], ["2019-01", 132]);
    const r3 = roll("Dallas murders rolling over 12 months since 2016");
    assert.deepEqual(r3.delivered.table.rows[0], ["2018-01", 132]);
    assert.ok(r3.delivered.text.includes("Current Trends figures in the data cover January 2017 through August 2026; January 2016 through December 2016 are outside them."), r3.delivered.text.join(" / "));
    const r4 = roll("Houston murders rolling over 12 months");
    assert.deepEqual(r4.delivered.table.rows[r4.delivered.table.rows.length - 1], ["2026-08", null], "a window with a month that has no figure is blank");
    assert.ok(r4.delivered.text.includes("No figure is available for August 2026: every 12-month window containing that month is shown blank, not zero."), r4.delivered.text.join(" / "));
    const r5 = roll("Dallas and Houston murders rolling over 12 months since 2025");
    assert.deepEqual(r5.delivered.table.columns.map((c) => c.header), ["Place", "Month", "Rolling 12-month murders"]);
    assert.equal(r5.delivered.text[0], "Dallas, Texas and Houston, Texas Murders Rolling Over 12 Months, Jan 2025-Aug 2026");
    // The nation (Jeff 2026-11-19): the agencies with a figure in every month of the span asked, summed; their number and people said once.
    const nat = roll("murders rolling over 12 months since 2016 nationally");
    assert.ok(nat.delivered.text.includes("Current Trends figures in the data cover January 2017 through August 2026; January 2016 through December 2016 are outside them."), nat.delivered.text.join(" / "));
    assert.ok(nat.delivered.text.includes("This counts only the 547 Consistent Reporting Agencies, covering roughly 110 million people, that reported every month from February 2017 through August 2026."), nat.delivered.text.join(" / "));
    assert.deepEqual(nat.delivered.table.rows[0], ["2018-01", 36000]);
    assert.ok(nat.delivered.table.rows.every((r) => r[1] !== null), "no blank rows");
    // Windows whose whole lookback is inside 2025 on use the published Consistent Reporting Agencies (the flag), said with the published span.
    const nat3 = roll("murders rolling over 12 months since 2026 nationally");
    assert.ok(nat3.delivered.text.includes("This counts only the 547 Consistent Reporting Agencies, covering roughly 110 million people, that reported every month from January 2025 through August 2026."), nat3.delivered.text.join(" / "));
    assert.deepEqual(nat3.delivered.table.rows[0], ["2026-01", 36000]);
    const nat2 = roll("murders rolling over 12 months since 2024 nationally");
    assert.ok(nat2.delivered.text.includes("This counts only the 547 Consistent Reporting Agencies, covering roughly 110 million people, that reported every month from February 2023 through August 2026."), nat2.delivered.text.join(" / "));
    assert.deepEqual(nat2.delivered.table.rows[0], ["2024-01", 36000]);
    // The plain monthly national answer (P155): a span inside the published sample's life (2025-01 on) is the published sample; a span that
    // reaches before 2025 is the agencies with a figure in every month of it, said with the span.
    const m18 = roll("murders by month since 2018 nationally");
    assert.ok(m18.delivered.text.includes("This counts only the 547 Consistent Reporting Agencies, covering roughly 110 million people, that reported every month from January 2018 through August 2026."), m18.delivered.text.join(" / "));
    assert.deepEqual(m18.delivered.table.rows[0], ["2018-01", 3000]);
    const m25 = roll("murders by month since 2025 nationally");
    assert.ok(m25.delivered.text.includes("This counts only the 547 Consistent Reporting Agencies, covering roughly 110 million people, that reported every month from January 2025 through August 2026."), m25.delivered.text.join(" / "));
    // A span wholly before 2025 has no population in the final panel: the people clause is left out, never "roughly 0 people".
    const noPop = { ...cdeps, execute: (sql: string) => (/coalesce\(sum\(p\.population\), 0\)/.test(sql) ? ctStub(sql).map((r) => [r[0], 0]) : ctStub(sql)) } as unknown as ShadowDeps;
    const m24 = shadowAnswer("murders by month in 2024 nationally", noPop);
    assert.equal(m24.kind, "current", JSON.stringify(m24).slice(0, 300));
    if (m24.kind === "current") {
      assert.ok(m24.delivered.text.some((t) => /^This counts only the \d+ Consistent Reporting Agencies that reported every month from January 2024 through December 2024\.$/.test(t)), m24.delivered.text.join(" / "));
      assert.ok(!m24.delivered.text.some((t) => /roughly 0|covering roughly/.test(t)), "no people clause when the population is unknown");
    }
    // "the last 12 months" stays one total.
    assert.equal(shadowAnswer("Dallas murders in the last 12 months", cdeps).kind, "current");
  }
  // P148 (Jeff 2026-11-18): crime by month for one agency is violent and property beside their sum (blank when either is), from Current Trends.
  for (const q of ["Dallas crime per month", "Dallas overall crime per month", "Dallas all crimes by month"]) {
    let po: ShadowOutcome;
    try { po = shadowAnswer(q, cdeps); } catch (e) { assert.fail(`${q}: ${(e as Error).stack?.split("\n").slice(0, 7).join(" | ")}`); }
    assert.equal(po.kind, "current", `${q}: ${JSON.stringify(po).slice(0, 200)}`);
    if (po.kind === "current") {
      assert.deepEqual(po.delivered.table.columns.map((c) => c.header), ["Month", "Violent crime", "Property crime", "Part I crime"], q);
      assert.deepEqual(po.delivered.table.rows[0], ["2025-01", 11, 11, 22], q);
      assert.equal(po.delivered.text[0], "Dallas, Texas Crime Per Month, Jan 2025-Aug 2026", q);
      assert.equal(po.delivered.text[po.delivered.text.length - 1], "Source: Crime Index.");
    }
  }
  const poGap = shadowAnswer("Houston crime per month", cdeps);
  assert.ok(poGap.kind === "current" && poGap.delivered.table.rows.some((r) => r[0] === "2026-08" && r[1] === null && r[2] === null && r[3] === null)
    && poGap.delivered.text.includes("No figure is available for August 2026 for Violent crime: shown blank, not zero."), JSON.stringify(poGap).slice(0, 400));
  // Named, NIBRS keeps the table; an agency with no reports at all is declined and Crime Index offered.
  const nib = shadowAnswer("Dallas vs Houston murders per month in 2024 according to NIBRS", cdeps);
  assert.equal(nib.kind, "answer", JSON.stringify(nib).slice(0, 200));
  const none = { ...deps, execute: (sql: string) => stub(sql).map((r) => (typeof r[r.length - 1] === "string" && /^(VALUE|UNKNOWN|REPORTED_ZERO|EVIDENCE_CONFLICT)$/.test(String(r[r.length - 1])) ? [...r.slice(0, -2), null, "UNKNOWN"] : r)) } as unknown as ShadowDeps;
  const dec = shadowAnswer("Dallas murders per month in 2024 according to NIBRS", none);
  assert.ok(dec.kind === "decline" && /^NIBRS has no data from the Dallas Police Department in this period\./.test(dec.explanation), JSON.stringify(dec).slice(0, 300));
  // P147: in this stub the Current Trends series the button would lead to has every month blank too, so it is not offered.
  if (dec.kind === "decline") assert.equal(dec.alternative, null);
  // P151 (Jeff 2026-11-19): when the yearly Crime Index answer has a figure it is offered under the all-blank decline.
  const blankCt = { kind: "current", period: { from: "2023-01", to: "2023-12" }, question: { measure: "murder", place: { kind: "agency", ori: "TNMPD0000", label: "Memphis, Tennessee" }, form: "months", statistic: "count" },
    delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.month" }, header: "Month" }, { binding: { kind: "statistic", as: "x" }, header: "Murders" }], rows: [["2023-01", null], ["2023-02", null]] }, text: [] } } as never;
  const blankDecl = allBlankMonthly(blankCt)!;
  const yearlyWith = (v: number | null) => () => ({ kind: "historical", delivered: { table: { columns: [{ header: "Year" }, { header: "Murders" }], rows: [["2023", v]] }, text: [] } }) as never;
  // One year asked: a one-cell row with no Year column (Oakland murders 2021: [[127]]).
  const oneYear = () => ({ kind: "historical", delivered: { table: { columns: [{ header: "Murders" }], rows: [[127]] }, text: [] } }) as never;
  // The table opened from the button ends at its last year with a figure; the years after it are named (New Orleans rape: 2017 to 2023).
  const longYearly = () => ({ kind: "historical", period: { from: "2022-01", to: "2025-12" }, delivered: { table: { columns: [{ header: "Year" }, { header: "Murders" }], rows: [["2022", 5], ["2023", 9], ["2024", null], ["2025", null]] }, text: ["Memphis, Tennessee Murders Per Year, 2022-2025", "Source: Crime Index."] } }) as never;
  const trimmed = withYearlyOffer(blankDecl, blankCt, deps, longYearly);
  const opened = trimmed.kind === "decline" ? (trimmed.alternative as { continuation?: { delivered: { table: { rows: unknown[][] }; text: string[] }; period: { to: string } } } | null)?.continuation : undefined;
  assert.deepEqual(opened?.delivered.table.rows, [["2022", 5], ["2023", 9]]);
  assert.deepEqual(opened?.delivered.text, ["Memphis, Tennessee Murders Per Year, 2022-2025", "Crime Index has no murder figures for Memphis, Tennessee from 2024 to 2025, so the chart and table end in 2023.", "Source: Crime Index."]);
  assert.equal(opened?.period.to, "2023-12");
  const offered = withYearlyOffer(blankDecl, blankCt, deps, yearlyWith(351));
  assert.ok(offered.kind === "decline" && offered.alternative?.label === 'Ask instead: "murders in Memphis, Tennessee in 2023"', JSON.stringify(offered).slice(0, 300));
  assert.equal(offered.kind === "decline" ? offered.explanation : "", "No data is available for murders in Memphis, Tennessee.");
  const single = withYearlyOffer(blankDecl, blankCt, deps, oneYear);
  assert.ok(single.kind === "decline" && single.alternative?.label === 'Ask instead: "murders in Memphis, Tennessee in 2023"', "one-cell yearly answer is offered");
  const notOffered = withYearlyOffer(blankDecl, blankCt, deps, yearlyWith(null));
  assert.ok(notOffered.kind === "decline" && notOffered.alternative === null, "no figure in the yearly series: no button");
}
// Rolling 12 months from Homicide Reports (shared helper rolling.ts): a state's firearm murders, with no step left for a
// year or a window the source can't give.
{
  const rstub = (sql: string): unknown[][] => (/count\(DISTINCT agency_key\)/.test(sql) ? [2017, 2018, 2019, 2020].map((y) => [y, 10, ["ori9:A"]])
    : /state_crime|sum\(population\)/.test(sql) ? [] : /GROUP BY/.test(sql) ? [2017, 2018, 2019, 2020].flatMap((y) => Array.from({ length: 12 }, (_, m) => [y, m + 1, 2])) : []);
  const rdeps2 = { ...deps, execute: rstub, shr: { root: "/shr", release: "shr-test", latestMonth: "2020-12", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const nc = shadowAnswer("North Carolina firearm homicides rolling over 12 months since 2018", rdeps2);
  assert.equal(nc.kind, "shr", JSON.stringify(nc).slice(0, 300));
  if (nc.kind === "shr") { assert.equal(nc.delivered.table.rows.length, 36); assert.deepEqual(nc.delivered.table.rows[0], ["2018-01", 24]); }
}
// Several agencies' murder details by month come from Homicide Reports (Jeff 2026-11-15): one table Agency | Month | count,
// a blank where an agency filed nothing, one source line.
{
  const hs = (sql: string): unknown[][] => (/count\(DISTINCT agency_key\)/.test(sql) ? [[2024, 1, ["ori9:X"]]] : /agency_crime/.test(sql) ? [] : /AS k1/.test(sql) ? Array.from({ length: 12 }, (_, m) => [2024, m + 1, 3]) : []);
  const d2 = { ...deps, execute: hs, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const two = shadowAnswer("Compare Chicago and Houston firearm murders by month in 2024", d2);
  assert.equal(two.kind, "shr", JSON.stringify(two).slice(0, 300));
  if (two.kind === "shr") {
    assert.deepEqual(two.delivered.table.columns.map((c) => c.header), ["Agency", "Month", "Murder victims"]);
    assert.equal(two.delivered.table.rows.length, 24);
    assert.deepEqual(two.delivered.table.rows[0], ["Chicago", "2024-01", 3]);
    assert.equal(two.delivered.text[0], "Chicago, Illinois and Houston, Texas Murder Victims With a Firearm Per Month, 2024");
    assert.equal(two.delivered.text.filter((t) => /^Source: /.test(t)).length, 1);
  }
}
// Jeff 2026-11-15: a Homicide Reports rate is per 100,000 people of the agencies that reported, one year or by year.
{
  const rstub = (sql: string): unknown[][] => (/count\(DISTINCT agency_key\)/.test(sql) ? [[2023, 3, ["ori9:A", "ori9:B"]]] : /nation_crime|state_crime/.test(sql) ? []
    : /sum\(population\)/.test(sql) ? [[2_000_000]] : /shr_victim/.test(sql) ? [[100]] : []);
  const rdeps3 = { ...deps, execute: rstub, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const pa = shadowAnswer("What is the firearm murder rate in Pennsylvania in 2023?", rdeps3);
  assert.equal(pa.kind, "shr", JSON.stringify(pa).slice(0, 300));
  if (pa.kind === "shr") {
    assert.deepEqual(pa.delivered.table.rows, [[5]]);
    assert.ok(pa.delivered.text.includes("Rate per 100,000 people in the agencies that reported."));
    assert.ok(/per 100,000 people in 2023\.$/.test(pa.delivered.text[0]), pa.delivered.text[0]);
  }
}
// 284's re-gate: a follow-up's default guards read what was typed and asked before, not only the rewrite. "compare with statewide ..." rewrites to
// the state alone, and "Durham, North Carolina and population" leans on a larceny-from-motor-vehicle question: neither is answered in part by a default.
{
  const gd = { ...deps, execute: () => [], historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  // (A pin of the outcome: with no stub data the default never lands here; the real-data check is the 1,242 follow-up labels, where only these two change.)
  const cmp = shadowFollowUp("countywide total", "compare with statewide violent crime rate in maryland", gd);
  assert.equal(cmp.kind, "clarify", JSON.stringify(cmp).slice(0, 300));
  const pop = shadowFollowUp("Larceny - from motor vehicle incidents per month from 2022-2025 durham compared to other cities of a similar size", "Durham, North Carolina and population", gd);
  assert.ok(!["srs", "historical", "current"].includes(pop.kind), JSON.stringify(pop).slice(0, 300));
}
// P10 (Jeff 2026-11-16): "all homicides" as a plain count is Crime Index (murders by year, nothing else); with a breakdown of anything
// it is Homicide Reports, and justifiable homicides are counted and said so.
{
  const seen: string[] = [];
  const hs = (sql: string): unknown[][] => { seen.push(sql); return /count\(DISTINCT agency_key\)/.test(sql) ? [[2020, 1, ["ori9:X"]], [2021, 1, ["ori9:X"]]] : /AS k1/.test(sql) ? [[2020, "Firearm", 5], [2021, "Knife", 2]] : []; };
  const d2 = { ...deps, execute: hs, shr: { root: "/shr", release: "shr-test", latestMonth: "2026-09", crosswalk: "cw" },
    historical: { root: "/hist", release: "h", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1964 } } as unknown as ShadowDeps;
  const plainCount = shadowAnswer("Show me data about all homicides reported in South Carolina since 2020", d2);
  assert.equal(plainCount.kind, "srs", JSON.stringify(plainCount).slice(0, 300));
  if (plainCount.kind === "srs") {
    assert.ok(/^South Carolina Murders Per Year, 2020-\d{4}$/.test(plainCount.delivered.text[0]), plainCount.delivered.text[0]);
    assert.deepEqual(plainCount.delivered.table.columns.length, 2, "a year and a count, no breakdown");
    assert.ok(!plainCount.delivered.text.some((t) => /homicide|justifiable|disclaim/i.test(t)), "no disclaimer on Crime Index");
  }
  seen.length = 0;
  const byWeapon = shadowAnswer("all homicides in South Carolina by weapon since 2020", d2);
  assert.equal(byWeapon.kind, "shr", JSON.stringify(byWeapon).slice(0, 300));
  if (byWeapon.kind === "shr") {
    assert.ok(byWeapon.delivered.text.some((t) => /^All homicides are murder, nonnegligent manslaughter, negligent manslaughter and justifiable homicides/.test(t)), JSON.stringify(byWeapon.delivered.text));
  }
  assert.ok(seen.some((q) => /homicide_type IN \('A', 'B'\)/.test(q)) && !seen.some((q) => /circumstance NOT IN \('80', '81'\)/.test(q)), "justifiable homicides are counted");
}
// Never a button that leads to a decline, at any depth (Jeff 2026-11-14, no note when hidden): every path through an ask's
// options ends in an answer, an entry or another source, never a decline or a route. The fixture's data is thin, so many
// choices that run on the real build decline here; they are the ones that must not be shown.
{
  type Opt = { label: string; continuation?: ShadowOutcome; entry?: string };
  const deadPaths = (o: ShadowOutcome, path: string[] = []): string[] =>
    o.kind !== "clarify" ? [] : (o.options as Opt[]).flatMap((x) => !x.continuation ? []
      : x.continuation.kind === "decline" || x.continuation.kind === "route" ? [[...path, x.label].join(" > ")] : deadPaths(x.continuation, [...path, x.label]));
  let asks = 0;
  for (const q of ["LA murder trend", "Assault in North Carolina", "assaults", "Compare total crime in Miami and Fort Worth", "Naperville, IL crime per month", "Give me total shootings per year",
    "Shoplifting in Memphis and Nashville by month", "robbery in Clinton", "Shoplifting in Houston", "violent crime trend in Dallas", "how bad is crime in LA right now?", "murders in New York"]) {
    const o = ask(q);
    if (o.kind === "clarify") asks++;
    assert.deepEqual(deadPaths(o), [], `${q}: a button leads to a decline`);
  }
  assert.ok(asks >= 5, "the questions above are mostly asks");
  // The ask behind a decline's alternative is held to the same rule (a forecast's "which New York").
  const fc = ask("Will robberies rise in New York next year?");
  assert.ok(fc.kind === "decline", fc.kind);
  if (fc.kind === "decline" && fc.alternative?.continuation) assert.deepEqual(deadPaths(fc.alternative.continuation), [], "the forecast's alternative");
  // An ask whose buttons all decline is the decline they ended in, with its reason; one with a single live button keeps it.
  const none = ask("how bad is crime in LA right now?");
  assert.ok(none.kind === "decline" && /how bad is|right now/.test(none.explanation), JSON.stringify(none).slice(0, 300));
  // Follow-up asks are held to the same rule.
  for (const [prev, next] of [["Shoplifting in Houston in 2024", "what about the change"], ["murders in Memphis in 2024", "and the rate"]] as const) {
    const f = shadowFollowUp(prev, next, deps);
    assert.deepEqual(deadPaths(f as ShadowOutcome), [], `${prev} / ${next}`);
  }
}
// "The carjacking trend ... by month": the word "trend" beside an explicit grain is the series, not a grain left unapplied
// (query-log ids QL-nibrs-0db9574c2f and its kin, group 4). A firearm selected on carjackings is the offense's own weapon.
{
  const trend = as(ask("Show me the carjacking trend in Houston by month for 2024"), "answer");
  assert.ok(trend.plan.groupings.some((g) => g.dimension === "time.month"), "trend by month is a monthly series");
  const gun = as(ask("Firearm carjackings per month in Houston since 2019"), "answer");
  assert.ok(gun.plan.filters.some((f) => f.kind === "exists" && f.entity === "offense_weapon" && f.scope === "offense"), "a firearm on carjackings is the offense's weapon");
  assert.notEqual(ask("Give me the carjacking trend in Houston by month and year").kind, "answer", "month and year together is still not answered as one");
}
// P180 to P182 (Jeff 2026-11-21): a missing place, period or kind of crime is filled with its default, said, with buttons; an ask whose default
// cannot answer now stays an ask. Tested on synthetic asks (no data): the wrapper reads only the ask's options and their continuations.
{
  const answerOf = (years: string[]): ShadowOutcome => ({ kind: "srs", delivered: { table: { columns: [], rows: years.map((y) => [y, 1]) }, text: ["Title", "Source: Crime Index."] } }) as unknown as ShadowOutcome;
  const ask = (about: string, question: string, options: { label: string; continuation?: ShadowOutcome; entry?: string }[]): ShadowOutcome => ({ kind: "clarify", about, question, options }) as unknown as ShadowOutcome;
  const live = { ...deps, noDefaults: false };
  const text = (o: ShadowOutcome) => (o as unknown as { delivered: { text: string[] } }).delivered.text;
  // No place: the United States, said, with buttons for a state and an agency.
  const place = applyDefaults("murder rate in 2024", ask("which place", "murder rate in 2024", [{ label: "The United States", continuation: answerOf(["2024"]) }, { label: "A state", entry: "which state" }]), live);
  assert.equal(place.kind, "srs");
  assert.deepEqual(text(place), ["Title", "No place was named, so the United States is shown.", "Source: Crime Index."]);
  assert.deepEqual((place as unknown as { buttons: { label: string }[] }).buttons.map((b) => b.label), ["A state", "A city or agency"]);
  // No period: every year, said with its span; a ranking: the latest complete year.
  const years = applyDefaults("murders in Philadelphia", ask("which period", "murders in Philadelphia", [{ label: "Every year available", continuation: answerOf(["1960", "1961", "2025"]) }, { label: "Another year", entry: "which year" }]), live);
  assert.equal(text(years)[1], "No years were given, so every year in the data is shown: 1960 through 2025.");
  const ranking = applyDefaults("Top 10 cities for homicide rate", ask("which period", "Top 10 cities for homicide rate", [{ label: "The latest complete year (2025)", continuation: answerOf(["x"]) }, { label: "Another year", entry: "which year" }]), live);
  assert.equal(text(ranking)[1], "No year was given, so the latest complete year, 2025, is shown.");
  // No kind of crime: violent and property crime.
  const crime = applyDefaults("crime in Texas in 2024", ask("which kind of crime", "crime in Texas in 2024", [{ label: "Violent crime" }, { label: "Both", continuation: answerOf(["2024"]) }]), live);
  assert.equal(text(crime)[1], "No kind of crime was named, so violent crime and property crime are shown.");
  // Place, then period, then crime in one chain: three notes in that order.
  const chain = applyDefaults("crime trends", ask("which place", "crime trends", [{ label: "The United States", continuation: ask("which period", "crime trends", [{ label: "Every year available", continuation: ask("which kind of crime", "crime trends", [{ label: "Both", continuation: answerOf(["2023", "2024"]) }]) }]) }]), live);
  assert.equal(text(chain).length, 5, JSON.stringify(text(chain)));
  // Stays an ask: the default is a decline, there is no default option, noDefaults is set.
  const decline = { kind: "decline", reason: "unsupported_capability", explanation: "x", alternative: null } as unknown as ShadowOutcome;
  assert.equal(applyDefaults("q", ask("which place", "q", [{ label: "The United States", continuation: decline }]), live).kind, "clarify");
  assert.equal(applyDefaults("q", ask("which place", "q", [{ label: "A state", entry: "which state" }]), live).kind, "clarify");
  assert.equal(applyDefaults("q", ask("which place", "q", [{ label: "The United States", continuation: answerOf(["2024"]) }]), { ...deps, noDefaults: true }).kind, "clarify");
}
// P190 (Jeff 2026-11-21, reader class): small words and slips read as the question they are, never "I didn't understand".
{
  const readerDecline = (q: string) => { const o = ask(q); return o.kind === "decline" && o.reason === "reader"; };
  for (const q of ["how many murders ocurred in Memphis in 2024", "how many murders occurredin Memphis in 2024", "how mnay murders in Memphis in 2024", "murders in Memphis for year 2024",
    "Houston retail theft in 2024", "Houston larceny from auto in 2024", "Houston murders sincce 2020 by year"])
    assert.ok(!readerDecline(q), q);
  // A sentence that merely holds a similar word keeps its own handling: "occurred in" still reads as "in" and nothing else.
  assert.deepEqual(ask("how many murders occurred in Memphis in 2024").kind, ask("how many murders in Memphis in 2024").kind);
  assert.deepEqual(ask("Houston retail theft in 2024").kind, ask("Houston shoplifting in 2024").kind);
}
// P192 (Jeff 2026-11-21): clearance by type always shows all seven rows, zeros included, in one fixed order.
{
  OMIT_TYPES = ["C", "E"];
  try {
    const tx = as(ask("Texas murder clearance by type in 2025"), "answer");
    assert.deepEqual(tx.delivered.table.rows.map((r) => r[0]), ["Cleared by arrest", "Exceptional: death of the offender", "Exceptional: prosecution declined",
      "Exceptional: in custody of another jurisdiction", "Exceptional: victim refused to cooperate", "Exceptional: juvenile, no custody", "Uncleared"]);
    const zero = tx.delivered.table.rows.filter((r) => /custody of another|juvenile/.test(String(r[0])));
    assert.ok(zero.length === 2 && zero.every((r) => r[1] === 0 && r[2] === 0), JSON.stringify(zero));
    assert.equal(tx.delivered.table.rows.reduce((s, r) => s + Number(r[1]), 0), 260, "the zero rows add nothing (312 less the 52 the stub left out)");
  } finally { OMIT_TYPES = []; }
  // One agency: only arrest and uncleared occurred; all seven rows are listed, the five exceptional types with zero and zero incidents.
  const hou = as(ask("Houston robbery clearance by type in 2024"), "answer");
  const names = hou.delivered.table.rows.map((r) => r[0]);
  assert.deepEqual(names, ["Cleared by arrest", "Exceptional: death of the offender", "Exceptional: prosecution declined", "Exceptional: in custody of another jurisdiction",
    "Exceptional: victim refused to cooperate", "Exceptional: juvenile, no custody", "Uncleared"], JSON.stringify(hou.delivered.table));
  assert.deepEqual(hou.delivered.table.rows.map((r) => [r[1], r[2]]), [[704, 704], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [8170, 8170]]);
  // No type occurred at all (a clearance condition with no case): never an empty table, the allowed types are zero rows.
  EMPTY_CLEARANCE = true;
  try {
    const none = as(ask("Houston robberies cleared by exception by type in 2024"), "answer");
    assert.equal(none.delivered.table.rows.length, 5, JSON.stringify(none.delivered.table));
    assert.ok(none.delivered.table.rows.every((r) => /^Exceptional:/.test(String(r[0])) && r[1] === 0 && r[2] === 0), JSON.stringify(none.delivered.table.rows));
    const all7 = as(ask("Houston robbery clearance by type in 2024"), "answer");
    assert.equal(all7.delivered.table.rows.length, 7);
    assert.ok(all7.delivered.table.rows.every((r) => r[1] === 0), "no case of any type: seven zero rows");
  } finally { EMPTY_CLEARANCE = false; }
  // A state or the nation with no type at all: seven zero rows, never an empty table.
  OMIT_TYPES = ["arrest", "A", "B", "C", "D", "E", "none"];
  try {
    const t = as(ask("Texas murder clearance by type in 2025"), "answer");
    assert.equal(t.delivered.table.rows.length, 7, JSON.stringify(t.delivered.table));
    assert.ok(t.delivered.table.rows.every((r) => r[1] === 0 && r[2] === 0));
  } finally { OMIT_TYPES = []; }
}
// P188 (Jeff 2026-11-21): loose words are read as a set meaning, each said in a note.
{
  // The note reaches the answer, just before the source line.
  const up = ask("is shoplifting going up or down in Detroit?") as unknown as { kind: string; delivered?: { text: string[] } };
  assert.ok(up.delivered, JSON.stringify(up).slice(0, 200));
  const sayings = up.delivered!.text.filter((t) => / is read as /.test(t));
  assert.deepEqual(sayings, ["Going up or down is read as its trend by year over the past five years."], up.delivered!.text.join(" | "));
  assert.ok(/^Source/.test(up.delivered!.text[up.delivered!.text.length - 1]), "the source line stays last");
  const cur = ask("shoplifting in Detroit right now") as unknown as { delivered?: { text: string[] } };
  assert.ok(cur.delivered?.text.includes("Right now is read as the latest complete year, 2025."), JSON.stringify(cur.delivered?.text));
  const rd = (q: string) => readQuestion(q, 2026, "2026-09");
  const note = (q: string) => (rd(q).ledger as unknown as { readings?: { from: string; to: string }[] }).readings ?? [];
  // CURRENT is the latest complete year (2025 in 2026), only when no period is named.
  assert.equal(rd("What is Chicago's current homicide rate").text, "What is Chicago's homicide rate in 2025");
  assert.equal(rd("Compare the current homicide rates in Chicago and Houston.").text, "Compare homicide rates in Chicago and Houston in 2025.");
  assert.equal(rd("What is Chicago's current homicide rate in 2022").text, "What is Chicago's current homicide rate in 2022");
  assert.ok(note("What is Chicago's current homicide rate").some((r) => /latest complete year, 2025/.test(r.to)));
  assert.ok(!/in 2025/.test(rd("Chicago current year to date murders").text));
  // UP / DOWN / GOING UP OR DOWN / DROPPING with no timeframe is the trend by year over the past five years; with a timeframe, that one.
  assert.equal(rd("is crime up in milwaukee").text, "crime in milwaukee by year over the past 5 years");
  assert.equal(rd("are robberies going up or down in Miami?").text, "robberies in Miami by year over the past 5 years?");
  assert.equal(rd("Has crime gone up in Asheville, NC since 2022").text, "crime in Asheville, NC since 2022 by year");
  assert.equal(rd("Crime and homicide rates are down").text, "Crime and homicide rates by year over the past 5 years");
  assert.ok(note("is crime up in milwaukee").some((r) => r.from === "up" && /past five years/.test(r.to)));
  // Approved synonyms: "right now" and "these days" are current; "rising", "falling", "increasing", "getting worse/better" are up/down;
  // "the national average" is the nation.
  assert.equal(rd("What is the murder rate in Chicago right now?").text, "What is the murder rate in Chicago in 2025?");
  assert.equal(rd("How is crime in Houston these days").text, "How is crime in Houston in 2025");
  assert.equal(rd("is crime rising in Houston").text, "crime in Houston by year over the past 5 years");
  assert.equal(rd("are murders falling in Houston?").text, "murders in Houston by year over the past 5 years?");
  assert.equal(rd("is crime in Houston getting worse").text, "crime in Houston by year over the past 5 years");
  assert.equal(rd("Murders in Houston are increasing since 2020").text, "Murders in Houston since 2020 by year");
  assert.equal(rd("How does Houston compare to the national average in 2024?").text, readQuestion("How does Houston compare to the nation in 2024?", 2026, "2026-09").text);
  // Not other uses of the words.
  assert.equal(rd("murders in Houston broken down by year").text, "murders in Houston broken down by year");
  assert.equal(rd("is the murder rate in Houston down 10% from 2020").text, "is the murder rate in Houston down 10% from 2020");
  // OVERALL is violent plus property crime; the crime named beside it keeps its own meaning.
  // ("overall crime" beside a place was already violent plus property: the all-seven measure of P148.)
  assert.equal(rd("Houston overall violent crime in 2024").text, "Houston violent crime in 2024");
  assert.equal(rd("national overall and violent crime rates monthly in 2024").text, "national violent crime and property crime and violent crime rates monthly in 2024");
  // COMPARED TO THE (REST OF THE) NATION is the nation's rates beside the place's.
  assert.equal(rd("How does Houston compare to the rest of the nation in 2024?").text, readQuestion("How does Houston compare to the nation in 2024?", 2026, "2026-09").text);
}
// P171 (Jeff 2026-11-21): a state's clearance by type is the reporting agencies' sum, with the incidents beside each count (P66, as for one agency).
{
  const tx = as(ask("Texas murder clearance by type in 2025"), "answer");
  assert.ok(tx.stateSum && tx.plan.statistics.some((s) => s.kind === "incidents"), "the reporting agencies' sum, with incidents");
  const rows = tx.delivered.table.rows.map((r) => [r[0], r[1], r[2]]);
  // Houston 9 + Dallas 7 + Austin 5 + Smallville 5 a month for 12 months = 312 units, half cleared by arrest; the incidents are one fewer per agency and type.
  assert.deepEqual(rows.map((r) => r[1] === undefined ? r[0] : r.slice(0, 3)).flat().filter((x) => typeof x === "number").slice(0, 4).length > 0, true, JSON.stringify(tx.delivered.table));
  // Jeff 2026-11-21: one row for arrest, each exceptional type A to E and not cleared, named as one agency's answer names them (no codes).
  const names = tx.delivered.table.rows.map((r) => String(r[0]));
  assert.deepEqual([...names].sort(), ["Cleared by arrest", "Exceptional: death of the offender", "Exceptional: in custody of another jurisdiction", "Exceptional: juvenile, no custody",
    "Exceptional: prosecution declined", "Exceptional: victim refused to cooperate", "Uncleared"].sort(), JSON.stringify(names));
  assert.ok(names.every((n) => !/^Code |^[A-E]$/.test(n)));
  const byName = (n: string) => tx.delivered.table.rows.find((r) => r[0] === n)!;
  // Houston 108 + Dallas 84 + Austin 60 + Smallville 60 = 312 units; arrest 54 + 42 + 30 + 30 = 156, each exceptional type 9 + 7 + 5 + 5 = 26; the rest 26; incidents one fewer per agency.
  assert.deepEqual([byName("Cleared by arrest")[1], byName("Cleared by arrest")[2], byName("Exceptional: prosecution declined")[1], byName("Exceptional: prosecution declined")[2], byName("Uncleared")[1]], [156, 152, 26, 22, 26]);
  assert.equal(tx.delivered.table.rows.reduce((s, r) => s + Number(r[1]), 0), 312, "the types add up to the units counted");
  assert.ok(tx.delivered.text.some((t) => /Summed over the 4 agencies that reported/.test(t)), tx.delivered.text.join(" | "));
  // The nation is the same sum over every state (the runner timed it: 4.3 s); a state's clearance rate is answered (P172).
  const us = as(ask("murder clearance by type in the United States in 2025"), "answer");
  assert.ok(us.stateSum && us.delivered.table.rows.length >= 2, "the nation by clearance type");
  assert.ok(/United States/.test(us.delivered.text[0]), us.delivered.text[0]);
  assert.equal(ask("Texas murder clearance rate in 2025").kind, "answer");
}
// P159 (Jeff 2026-11-21): a title is PLACE, OFFENSE, PERIOD, TIMEFRAME.
{
  const t = (period: string, what: string, grouping: string, place: string) => seriesTitle(period, what, grouping, place);
  assert.equal(t("January 2019 through October 2026", "Carjackings", "Month", "Houston, Texas"), "Houston, Texas Carjackings Per Month, Jan 2019-Oct 2026");
  assert.equal(t("2015 to 2025", "Aggravated Assaults", "Year", "Texas"), "Texas Aggravated Assaults Per Year, 2015-2025");
  assert.equal(t("January 2018 to August 2026", "Murders, Rolling 12-Month Totals", "Month", "Chicago, Illinois"), "Chicago, Illinois Murders Rolling Over 12 Months, Jan 2018-Aug 2026");
  assert.equal(t("2024", "Robberies", "Weapon", "Chicago, Illinois"), "Chicago, Illinois Robberies by Weapon, 2024");
  assert.equal(t("2015 to 2025", "Murders", "Year", "The United States"), "United States Murders Per Year, 2015-2025");
  assert.equal(t("2026 Year to Date", "Murders", "Agency", "Texas"), "Texas Murders by Agency, Year to Date 2026");
  assert.equal(titleTimeframe("January through October 2026"), "Jan-Oct 2026");
  assert.equal(titleTimeframe("January 2025 to March 2025"), "Jan-Mar 2025");
  assert.equal(titleTimeframe("2019 and 2023"), "2019 and 2023");
}
// P166 and P167 (Jeff 2026-11-19): a victim crime by weapon is counted by offense and says so; "violent crime with a firearm" is crimes against persons.
{
  const byWeapon = as(ask("Aggravated assault victims by weapon type in Houston 2022-2024"), "answer") as unknown as { plan: { measures: { id: string }[] }; delivered: { text: string[] } };
  assert.equal(byWeapon.plan.measures[0].id, "offenses.aggravated_assault");
  assert.ok(byWeapon.delivered.text.includes("Counts are aggravated assault offenses by weapon, not victims."), JSON.stringify(byWeapon.delivered.text));
  const gunViolent = as(ask("violent crime with a firearm in Houston in 2024"), "answer") as unknown as { plan: { measures: { id: string }[]; filters: { kind: string; entity?: string; scope?: string }[] }; delivered: { text: string[] } };
  assert.equal(gunViolent.plan.measures[0].id, "victims.person_crimes");
  assert.ok(gunViolent.plan.filters.some((f) => f.kind === "exists" && f.entity === "offense_weapon" && f.scope === "victim"));
  assert.ok(gunViolent.delivered.text.some((t) => /^Counts NIBRS crimes against persons: /.test(t)), JSON.stringify(gunViolent.delivered.text));
  // A crime already counted by offense, and the murder path, are left as they were.
  assert.equal((as(ask("robberies by weapon in Houston in 2024"), "answer") as unknown as { plan: { measures: { id: string }[] } }).plan.measures[0].id, "offenses.robbery");
}
console.log("nibrs shadow: answers, clarifications and declines follow the slice's policy; scoring judges them");
