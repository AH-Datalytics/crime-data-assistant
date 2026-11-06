/**
 * Historical for agencies (design note 2026-11-01-historical-engine-design.md; P75-P79): a Part I offense for one or
 * several named agencies in completed years, read from the Crime Index build (scripts/build-crimeindex.py), never
 * from the app's live tables, never summed from NIBRS and never spliced with another source (P14).
 *
 *   values     exactly as Crime Index publishes them: counts (*_total) and populations; rates per 100,000 (P75,
 *              amended by Jeff 2026-11-01): the published *_capita first; where the file has none but publishes the
 *              count and the population, the count per 100,000 of that population to one decimal, as crimeindex.org's
 *              page shows it (TX0200000 1960: 10 / 41,843 -> 23.9); blank only when either is missing
 *   blanks     a missing row or a blank cell is "not available in this data", never zero and never "not reported"
 *   years      from the earliest year Crime Index publishes for the agency (P76) through the build's last; a year
 *              outside the build is named
 *   clearance  the published clearance percentage (*_cleared_rate), with the counts where the file has them
 *   change     two years' counts; no change from a missing or zero base
 *   source     "Source: Crime Index." (P77)
 */
import fs from "node:fs";
import path from "node:path";
import type { Meaning } from "../answer-eval/case";
import type { ResultTable } from "../nibrs-plan/result";
import { pct1 } from "../nibrs-plan/transforms";
import { fmt, fmtRate, SRS_SOURCE } from "./deliver";

/** Where the Crime Index build is, and the years it holds. */
export type HistoricalBuild = { root: string; release: string; firstYear: number; lastYear: number; clearanceFirstYear: number };
/** The build at `root`, from its own manifest (release and years); undefined when there is none. */
export function historicalBuildAt(root: string | undefined): HistoricalBuild | undefined {
  if (!root) return undefined;
  const file = path.join(root, "manifest.json");
  if (!fs.existsSync(file)) return undefined;
  const m = JSON.parse(fs.readFileSync(file, "utf8")) as { release: string; inputs: Record<string, { years: [number, number] }> };
  const crime = m.inputs.historical_crime.years, clearances = m.inputs.historical_clearances.years;
  return { root: root.replace(/\\/g, "/"), release: m.release, firstYear: crime[0], lastYear: crime[1], clearanceFirstYear: clearances[0] };
}
/** P75: the published rate; otherwise the count per 100,000 of the population, one decimal, as crimeindex.org's page; null when either is missing. */
export function historicalRate(published: number | null, total: number | null, population: number | null): { rate: number | null; computed: boolean } {
  if (published !== null) return { rate: published, computed: false };
  if (total === null || population === null || population <= 0) return { rate: null, computed: false };
  return { rate: Math.round((total * 1e6) / population) / 10, computed: true };
}

/** The reader's Part I measures -> the build's column stem, the words for a count, and the label schema's name and unit. */
export const HISTORICAL_MEASURE: Record<string, { col: string; words: string; name: string; unit: string }> = {
  murder: { col: "murder", words: "murders", name: "murder", unit: "victim" },
  homicide: { col: "murder", words: "murders", name: "murder", unit: "victim" },
  rape: { col: "rape", words: "rapes", name: "rape", unit: "victim" },
  robbery: { col: "robbery", words: "robberies", name: "robbery", unit: "offense" },
  aggravated_assault: { col: "assault", words: "aggravated assaults", name: "aggravated assault", unit: "victim" },
  burglary: { col: "burglary", words: "burglaries", name: "burglary", unit: "offense" },
  theft: { col: "theft", words: "larceny-thefts", name: "theft", unit: "offense" },
  motor_vehicle_theft: { col: "motor", words: "motor vehicle thefts", name: "motor vehicle theft", unit: "offense" },
  violent_crime: { col: "violent", words: "violent crimes", name: "violent crime", unit: "victim (robbery by offense)" },
  property_crime: { col: "property", words: "property crimes", name: "property crime", unit: "offense" },
};
export const isHistoricalMeasure = (m: string) => m in HISTORICAL_MEASURE;
/**
 * The unit asked fits the file's count (Codex review 01.1): none named, or the offense's own unit (victims for murder,
 * rape and aggravated assault; offenses for robbery and the property offenses). Violent crime mixes the two, so only
 * the crime itself. "Robbery victims" is not the file's robbery count.
 */
/** How the file counts a crime, in words ("robberies as offenses"), for a decline that names it. */
export function historicalCounts(measure: string): string {
  const m = HISTORICAL_MEASURE[measure];
  return m.unit === "victim" ? `${m.words} by victim` : m.unit === "offense" ? `${m.words} as offenses` : `${m.words} as one total (murder, rape and aggravated assault by victim, robbery by offense)`;
}
export function historicalUnitFits(measure: string, unit: string | null): boolean {
  const m = HISTORICAL_MEASURE[measure];
  if (!m || unit === null) return !!m;
  return (unit === "victims" && m.unit === "victim") || (unit === "offenses" && m.unit === "offense");
}

/** `name`: the agency's name, for the meaning ("Denver"); `label`: what the answer shows ("Denver, Colorado"). */
export type HistoricalAgency = { ori: string; label: string; name: string; state: string };
export type HistoricalQuestion = {
  measure: string; agencies: HistoricalAgency[]; from: number; to: number; byYear: boolean;
  statistic: "count" | "rate" | "clearance_rate"; comparison: { earlier: number; later: number } | null;
  /** Lines after the title (a span reaching this year names it as Current Trends'). */
  notes?: string[];
  /** The agencies by their FBI names ("Figures for the Denver Police Department."): named, not "reported by" (design note, section 3). */
  agencyLine?: string;
  /** A line after the agency's (a county answered from its sheriff's office): shown as a note, never as restated. */
  agencyNote?: string;
};
export type HistoricalAnswer = {
  kind: "historical"; meaning: Meaning; period: { from: string; to: string };
  /** The question answered, for its presentation (lib/answer-contract). */
  question: HistoricalQuestion;
  delivered: { table: ResultTable; text: string[] };
  /** Provenance: the table and column read and the release, so every figure is shown to be the file's. */
  read: { table: string; column: string; release: string };
};
export type HistoricalDecline = { kind: "historical-decline"; explanation: string };

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const yearsWords = (a: number, b: number) => (a === b ? String(a) : `${a} through ${b}`);
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ucFirst = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
/** The answer's lines: the title, the agencies named, then the rest. */
const lines = (hq: HistoricalQuestion, title: string, ...rest: string[]) => [title, ...(hq.agencyLine ? [hq.agencyLine] : []), ...(hq.agencyNote ? [hq.agencyNote] : []), ...rest];
const placeOf = (a: HistoricalAgency): Meaning["places"][number] => ({ kind: "agency", name: a.name, ...(a.state ? { state: a.state } : {}) });

export function answerHistorical(hq: HistoricalQuestion, build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const m = HISTORICAL_MEASURE[hq.measure];
  if (!m) return { kind: "historical-decline", explanation: "Historical has violent and property crime and the seven Part I offenses only." };
  const clearance = hq.statistic === "clearance_rate";
  const first = clearance ? build.clearanceFirstYear : build.firstYear;
  // P76, D04: the part of the span the build holds; the rest named; nothing held: declined, the range named.
  const wanted = range(hq.from, hq.to);
  const covered = wanted.filter((y) => y >= first && y <= build.lastYear);
  const outside = wanted.filter((y) => !covered.includes(y));
  const span = `Historical ${clearance ? "clearance " : ""}figures in the data cover ${first} through ${build.lastYear}`;
  if (!covered.length) return { kind: "historical-decline", explanation: `${span}, so ${yearsWords(hq.from, hq.to)} ${hq.from === hq.to ? "is" : "are"} outside them.` };
  const outsideLine = outside.length ? [`${span}; ${yearsWords(outside[0], outside[outside.length - 1])} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
  const several = hq.agencies.length > 1;
  const where = several ? hq.agencies.map((a) => a.label).join(" and ") : hq.agencies[0].label;
  const meaningBase = { source: "historical" as const, places: hq.agencies.map(placeOf), filters: [] as string[] };
  const oris = hq.agencies.map((a) => q(a.ori)).join(", ");

  if (clearance) {
    // The published clearance percentage, with its counts where the file has them; never averaged or recomputed.
    // One agency and one year asked (Codex review 01.3: a span is never answered for the part it covers alone).
    if (several || wanted.length !== 1 || hq.byYear) return { kind: "historical-decline", explanation: "This isn't available yet: clearance rates for more than one agency or more than one year. Ask for one agency and one year." };
    const y = covered[0], col = `${m.col}_cleared_rate`;
    const r = execute(`SELECT ${m.col}_cleared_rate, ${m.col}_cleared_total, ${m.col}_all_total FROM read_parquet(${q(`${build.root}/agency_clearances.parquet`)}) WHERE ori IN (${oris}) AND year = ${y}`)[0];
    const [rate, cleared, all] = r ? r.map(num) : [null, null, null];
    if (rate === null) return { kind: "historical-decline", explanation: `Crime Index has no ${m.name} clearance rate for ${where} in ${y}: not available in this data.` };
    const counts = cleared !== null && all !== null ? ` (${fmt(cleared)} of ${fmt(all)})` : "";
    return {
      kind: "historical", question: hq, period: { from: `${y}-01`, to: `${y}-12` },
      meaning: { ...meaningBase, period: { from: `${y}-01`, to: `${y}-12` }, measures: [{ name: `${m.name} cleared`, unit: "offense" }], groupings: [], statistic: "rate", denominator: `${m.words}, per 100` },
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "clearance_rate" }, header: `${ucFirst(m.words)} cleared (%)` }], rows: [[rate]] },
        text: lines(hq, `${where}: ${rate}% of ${m.words} were cleared in ${y}${counts}.`, SRS_SOURCE) },
      read: { table: "agency_clearances", column: col, release: build.release },
    };
  }

  const col = `${m.col}_${hq.statistic === "rate" ? "capita" : "total"}`;
  const got = execute(`SELECT ori, year, ${m.col}_total, ${m.col}_capita, population FROM read_parquet(${q(`${build.root}/agency_crime.parquet`)}) `
    + `WHERE ori IN (${oris}) AND year BETWEEN ${covered[0]} AND ${covered[covered.length - 1]} ORDER BY ori, year`);
  const cell = new Map(got.map((r) => [`${r[0]}|${r[1]}`, { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
  const value = (ori: string, y: number) => {
    const c = cell.get(`${ori}|${y}`);
    if (!c) return null;
    if (hq.statistic !== "rate") return c.total;
    const r = historicalRate(c.capita, c.total, c.population);
    return r.rate;
  };
  const read = { table: "agency_crime", column: col, release: build.release };
  const header = `${ucFirst(m.words)}${hq.statistic === "rate" ? " per 100,000" : ""}`;
  const shown = (v: number) => (hq.statistic === "rate" ? fmtRate(v) : fmt(v));
  // The years shown blank, by place and in spans, in the words of a series' start note (redesign test, coordinator
  // 2026-11-04: "Memphis, Tennessee 1930, Memphis, Tennessee 1931" read as a list of places): "Crime Index has no robbery
  // figures for Memphis, Tennessee from 1930 to 1931, shown blank."
  const what = hq.statistic === "rate" ? `${m.name} rate` : `${m.name} figure`;
  const spansOf = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
  const yearsWords2 = (sp: [number, number][]) => {
    const w = sp.map(([a, b]) => (a === b ? String(a) : `${a} to ${b}`));
    return sp.length === 1 && sp[0][0] !== sp[0][1] ? `from ${w[0]}` : `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
  };
  const blankLine = (ys: number[]) => hq.agencies.flatMap((a) => {
    const miss = ys.filter((y) => value(a.ori, y) === null);
    return miss.length ? [`Crime Index has no ${what}${miss.length > 1 ? "s" : ""} for ${a.label} ${yearsWords2(spansOf(miss))}, shown blank.`] : [];
  });

  // A change (P54): two years' counts, the change and the percent change (P55: none from a zero base).
  if (hq.comparison && hq.statistic === "count") {
    if (several) return { kind: "historical-decline", explanation: "This isn't available yet: a change for more than one agency. Ask for one agency." };
    const [E, L] = [hq.comparison.earlier, hq.comparison.later];
    const ori = hq.agencies[0].ori;
    const two = execute(`SELECT year, ${m.col}_total FROM read_parquet(${q(`${build.root}/agency_crime.parquet`)}) WHERE ori = ${q(ori)} AND year IN (${E}, ${L})`);
    const at = (y: number) => num(two.find((r) => Number(r[0]) === y)?.[1]);
    const e = at(E), l = at(L);
    if (e === null || l === null) return { kind: "historical-decline", explanation: `Crime Index has no ${m.words} for ${where} in ${e === null ? E : L}: not available in this data, so there is no change to give.` };
    const change = l - e, pct = e === 0 ? null : pct1(change, e);
    const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "0");
    return {
      kind: "historical", question: hq, period: { from: `${E}-01`, to: `${L}-12` },
      meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period: { from: `${E}-01`, to: `${L}-12` }, groupings: [], statistic: "change" },
      delivered: { table: { columns: ["earlier", "later", "change", "pct_change"].map((k) => ({ binding: { kind: "statistic" as const, as: `x.${k}` }, header: k === "earlier" ? String(E) : k === "later" ? String(L) : k === "change" ? "Change" : "Percent change" })),
        rows: [[e, l, change, pct]] },
        text: lines(hq, `${where}: ${m.words}, ${E} against ${L}.`, `${fmt(e)} in ${E} and ${fmt(l)} in ${L}: a change of ${signed(change)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}.`,
          ...(pct === null ? ["The percent change cannot be computed from a zero base."] : []), SRS_SOURCE) },
      read,
    };
  }

  const period = { from: `${covered[0]}-01`, to: `${covered[covered.length - 1]}-12` };
  const rateMeaning = hq.statistic === "rate" ? { denominator: "the agency's residents as published by Crime Index, per 100,000" } : {};
  const notes = [...outsideLine, ...(hq.notes ?? [])];
  // Several agencies in one year: a row each, side by side (never combined: the file has no cohort to combine).
  if (several && !hq.byYear && covered.length === 1) {
    const y = covered[0];
    const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Agency" }, { binding: { kind: "statistic", as: "x" }, header }];
    const rows = hq.agencies.map((a) => [a.label, value(a.ori, y)]);
    const text = lines(hq, `${where}: ${m.words}${hq.statistic === "rate" ? " per 100,000" : ""} in ${y}.`, ...notes, ...blankLine([y]), SRS_SOURCE);
    return {
      kind: "historical", question: hq, period,
      meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period, groupings: ["agency"], statistic: hq.statistic === "rate" ? "rate" : "count", ...rateMeaning },
      delivered: { table: { columns, rows }, text },
      read,
    };
  }
  if (hq.byYear || covered.length > 1 || several) {
    // A series starts at its first year with a figure (coordinator 2026-11-02: "Memphis murders since 1930" has none for
    // 1930-31): the leading years with no figure for any agency are left out, and a note names the first year.
    const firstFigure = covered.findIndex((y) => hq.agencies.some((a) => value(a.ori, y) !== null));
    const kept = firstFigure > 0 ? covered.slice(firstFigure) : covered;
    // Only the years asked and left out are named, and the statistic asked (Codex period review 01.3).
    const what0 = hq.statistic === "rate" ? `${m.name} rate` : `${m.name} figure`;
    const startNote = firstFigure > 0 ? [`Crime Index has no ${what0}${firstFigure > 1 ? "s" : ""} for ${where} ${firstFigure > 1 ? `from ${covered[0]} to ${covered[firstFigure - 1]}` : `in ${covered[0]}`}, so the chart and table start in ${kept[0]}.`] : [];
    const period = { from: `${kept[0]}-01`, to: `${kept[kept.length - 1]}-12` };
    // Several agencies side by side, one column each (never combined: the file has no cohort to combine, design note 2).
    const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
      ...hq.agencies.map((a, i) => ({ binding: { kind: "statistic" as const, as: several ? `x.${i}` : "x" }, header: several ? `${a.label}: ${header.toLowerCase()}` : header }))];
    const rows = kept.map((y) => [String(y), ...hq.agencies.map((a) => value(a.ori, y))]);
    const text = lines(hq, `${where}: ${m.words}${hq.statistic === "rate" ? " per 100,000" : ""} by year, ${yearsWords(kept[0], kept[kept.length - 1])}.`,
      ...startNote, ...notes, ...blankLine(kept), SRS_SOURCE);
    return {
      kind: "historical", question: hq, period,
      meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period, groupings: ["year", ...(several ? ["agency"] : [])], statistic: hq.statistic === "rate" ? "rate" : "count", ...rateMeaning },
      delivered: { table: { columns, rows }, text },
      read,
    };
  }
  const y = covered[0], v = value(hq.agencies[0].ori, y);
  if (v === null) return { kind: "historical-decline", explanation: `Crime Index has no ${hq.statistic === "rate" ? `${m.name} rate` : m.words} for ${where} in ${y}: not available in this data.` };
  const text = lines(hq, hq.statistic === "rate" ? `${where}: ${shown(v)} ${m.words} per 100,000 in ${y}.` : `${where}: ${fmt(v)} ${m.words} in ${y}.`, ...notes, SRS_SOURCE);
  return {
    kind: "historical", question: hq, period,
    meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period, groupings: [], statistic: hq.statistic === "rate" ? "rate" : "count", ...rateMeaning },
    delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header }], rows: [[v]] }, text },
    read,
  };
}
