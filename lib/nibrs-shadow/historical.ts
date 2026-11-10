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
import { pct1, rankAgencies } from "../nibrs-plan/transforms";
import { fmt, fmtRate, periodWords, SRS_SOURCE } from "./deliver";
import { stateName } from "./places";
import { answerSrsSeveral, type SrsPlace } from "./srs";

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
  /**
   * States or the nation shown beside the agencies (answerBeside, population.ts), and every place's name in the order
   * asked (each statistic column's, `x.<i>`), for the title and the chart's series.
   */
  beside?: SrsPlace[];
  shown?: string[];
  /** A state's agencies listed by population (population.ts, item 11b): the state, how many, the largest few. */
  list?: { state: string; count: number; top: { label: string; population: number }[] };
  /** A ranking of a state's city agencies (answerHistoricalRanking): the state, the direction and how many. */
  ranking?: { state: string; direction: "top" | "bottom"; limit: number; minPopulation: number | null };
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
/**
 * Cities whose figures sit under another agency (Jeff 2026-11-10), until nibrs-model's crosswalk carries them: the
 * Jacksonville Sheriff's Office (consolidated with the city, typed "county") is the city of Jacksonville; the empty
 * duplicate city rows (Jacksonville's own, St. Louis's MO0956800, Louisville's KY0560200) are dropped, the reporting
 * departments (MOSPD0000, KY0568000) being those cities. Used by every city ranking and "largest cities" set.
 */
export const CITY_AS = { asCity: { FL0160000: "Jacksonville" } as Record<string, string>, drop: ["FL0160200", "MO0956800", "KY0560200"] };
/** SQL: a row is a city (Crime Index's type, or one of CITY_AS's), and not a dropped duplicate. */
export function citySql(col = ""): string {
  const c = col ? `${col}.` : "";
  return `(${c}type = 'city' OR ${c}ori IN (${Object.keys(CITY_AS.asCity).map((o) => `'${o}'`).join(", ")})) AND ${c}ori NOT IN (${CITY_AS.drop.map((o) => `'${o}'`).join(", ")})`;
}
/** SQL: an agency's name, with CITY_AS's city names. */
export function cityNameSql(col = ""): string {
  const c = col ? `${col}.` : "";
  return `CASE ${Object.entries(CITY_AS.asCity).map(([o, n]) => `WHEN ${c}ori = '${o}' THEN '${n.replace(/'/g, "''")}'`).join(" ")} ELSE ${c}name END`;
}

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
  // The years before and after the data named apart ("1959 and 2026 are outside them", never "1959 through 2026":
  // Codex clearance review 01.2).
  const before = outside.filter((y) => y < first), after = outside.filter((y) => y > build.lastYear);
  const outsideWords = [before, after].filter((ys) => ys.length).map((ys) => yearsWords(ys[0], ys[ys.length - 1])).join(" and ");
  const outsideLine = outside.length ? [`${span}; ${outsideWords} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
  const several = hq.agencies.length > 1;
  const where = several ? hq.agencies.map((a) => a.label).join(" and ") : hq.agencies[0].label;
  const meaningBase = { source: "historical" as const, places: hq.agencies.map(placeOf), filters: [] as string[] };
  const oris = hq.agencies.map((a) => q(a.ori)).join(", ");

  if (clearance) {
    // A change in a clearance rate is not computed here: said, never answered as the rates by year (Codex clearance
    // review 01.1).
    if (hq.comparison) return { kind: "historical-decline", explanation: "This isn't available yet: a change in a clearance rate. Ask for the clearance rate by year." };
    // The published clearance percentage, with its counts where the file has them; never averaged or recomputed.
    // Several agencies or several years (item 7, coordinator 2026-11-07: "murder clearance rate in Chicago since 2010",
    // "Compare murder clearance rates in Houston and Dallas since 2000"): each agency's published percentage for each
    // year, side by side, never combined; a year with none is blank and named; years outside the build are named.
    if (several || wanted.length !== 1 || hq.byYear) {
      const col = `${m.col}_cleared_rate`;
      const got = execute(`SELECT ori, year, ${col} FROM read_parquet(${q(`${build.root}/agency_clearances.parquet`)}) `
        + `WHERE ori IN (${oris}) AND year BETWEEN ${covered[0]} AND ${covered[covered.length - 1]} ORDER BY ori, year`);
      const at = new Map(got.map((r) => [`${r[0]}|${r[1]}`, num(r[2])]));
      const rateOf = (ori: string, y: number) => at.get(`${ori}|${y}`) ?? null;
      const header = `${ucFirst(m.words)} cleared (%)`;
      const meaningOf = (period: { from: string; to: string }, groupings: string[]) => ({ ...meaningBase, period, measures: [{ name: `${m.name} cleared`, unit: "offense" }], groupings, statistic: "rate" as const, denominator: `${m.words}, per 100` });
      const spansOf = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
      const yearsSaid = (sp: [number, number][]) => {
        const w = sp.map(([a, b]) => (a === b ? String(a) : `${a} to ${b}`));
        return sp.length === 1 && sp[0][0] !== sp[0][1] ? `from ${w[0]}` : `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
      };
      const blanks = (ys: number[]) => hq.agencies.flatMap((a) => {
        const miss = ys.filter((y) => rateOf(a.ori, y) === null);
        return miss.length ? [`Crime Index has no ${m.name} clearance rate for ${a.label} ${yearsSaid(spansOf(miss))}, shown blank.`] : [];
      });
      const notes = [...outsideLine, ...(hq.notes ?? [])];
      // Several agencies in one year: a row each.
      if (several && !hq.byYear && covered.length === 1) {
        const y = covered[0], period = { from: `${y}-01`, to: `${y}-12` };
        return {
          kind: "historical", question: hq, period, meaning: meaningOf(period, ["agency"]),
          delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Agency" }, { binding: { kind: "statistic", as: "clearance_rate" }, header }],
            rows: hq.agencies.map((a) => [a.label, rateOf(a.ori, y)]) },
            text: lines(hq, `${where}: the percentage of ${m.words} cleared in ${y}.`, ...notes, ...blanks([y]), SRS_SOURCE) },
          read: { table: "agency_clearances", column: col, release: build.release },
        };
      }
      // By year: the series starts at its first year with a figure for any agency, as a crime series does.
      const firstFigure = covered.findIndex((y) => hq.agencies.some((a) => rateOf(a.ori, y) !== null));
      if (firstFigure < 0) return { kind: "historical-decline", explanation: `Crime Index has no ${m.name} clearance rate for ${where} ${yearsSaid(spansOf(covered))}: not available in this data.` };
      const kept = covered.slice(firstFigure);
      const startNote = firstFigure > 0 ? [`Crime Index has no ${m.name} clearance rate for ${where} ${yearsSaid(spansOf(covered.slice(0, firstFigure)))}, so the chart and table start in ${kept[0]}.`] : [];
      const period = { from: `${kept[0]}-01`, to: `${kept[kept.length - 1]}-12` };
      const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
        ...hq.agencies.map((a, i) => ({ binding: { kind: "statistic" as const, as: several ? `clearance_rate.${i}` : "clearance_rate" }, header: several ? `${a.label}: ${m.words} cleared (%)` : header }))];
      return {
        kind: "historical", question: hq, period, meaning: meaningOf(period, ["year", ...(several ? ["agency"] : [])]),
        delivered: { table: { columns, rows: kept.map((y) => [String(y), ...hq.agencies.map((a) => rateOf(a.ori, y))]) },
          text: lines(hq, `${where}: the percentage of ${m.words} cleared by year, ${yearsWords(kept[0], kept[kept.length - 1])}.`, ...startNote, ...notes, ...blanks(kept), SRS_SOURCE) },
        read: { table: "agency_clearances", column: col, release: build.release },
      };
    }
    const y = covered[0], col = `${m.col}_cleared_rate`;
    const r = execute(`SELECT ${m.col}_cleared_rate, ${m.col}_cleared_total, ${m.col}_all_total FROM read_parquet(${q(`${build.root}/agency_clearances.parquet`)}) WHERE ori IN (${oris}) AND year = ${y}`)[0];
    const [rate, cleared, all] = r ? r.map(num) : [null, null, null];
    if (rate === null) return { kind: "historical-decline", explanation: `Crime Index has no ${m.name} clearance rate for ${where} in ${y}: not available in this data.` };
    // The counts in a sentence of their own: the lead gives the percentage, the page shows these as a note.
    const counts = cleared !== null && all !== null ? ` That is ${fmt(cleared)} of ${fmt(all)} ${m.words}.` : "";
    return {
      kind: "historical", question: hq, period: { from: `${y}-01`, to: `${y}-12` },
      meaning: { ...meaningBase, period: { from: `${y}-01`, to: `${y}-12` }, measures: [{ name: `${m.name} cleared`, unit: "offense" }], groupings: [], statistic: "rate", denominator: `${m.words}, per 100` },
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "clearance_rate" }, header: `${ucFirst(m.words)} cleared (%)` }], rows: [[rate]] },
        text: lines(hq, `${where}: ${rate}% of ${m.words} were cleared in ${y}.${counts}`, SRS_SOURCE) },
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
  // P75 "and the answer says so" (coordinator 2026-11-06): the years whose rate Crime Index leaves blank and the page
  // computes from the published count and population.
  const computedLine = (ys: number[]) => hq.statistic !== "rate" ? [] : hq.agencies.flatMap((a) => {
    const done = ys.filter((y) => { const c = cell.get(`${a.ori}|${y}`); return !!c && historicalRate(c.capita, c.total, c.population).computed; });
    return done.length ? [`Crime Index publishes no ${m.name} rate for ${a.label} ${yearsWords2(spansOf(done))}; ${done.length > 1 ? "those years' rates are" : "that year's rate is"} the count per 100,000 of the published population.`] : [];
  });
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
    const text = lines(hq, `${where}: ${m.words}${hq.statistic === "rate" ? " per 100,000" : ""} in ${y}.`, ...notes, ...computedLine([y]), ...blankLine([y]), SRS_SOURCE);
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
      ...startNote, ...notes, ...computedLine(kept), ...blankLine(kept), SRS_SOURCE);
    return {
      kind: "historical", question: hq, period,
      meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period, groupings: ["year", ...(several ? ["agency"] : [])], statistic: hq.statistic === "rate" ? "rate" : "count", ...rateMeaning },
      delivered: { table: { columns, rows }, text },
      read,
    };
  }
  const y = covered[0], v = value(hq.agencies[0].ori, y);
  if (v === null) return { kind: "historical-decline", explanation: `Crime Index has no ${hq.statistic === "rate" ? `${m.name} rate` : m.words} for ${where} in ${y}: not available in this data.` };
  const text = lines(hq, hq.statistic === "rate" ? `${where}: ${shown(v)} ${m.words} per 100,000 in ${y}.` : `${where}: ${fmt(v)} ${m.words} in ${y}.`, ...notes, ...computedLine([y]), SRS_SOURCE);
  return {
    kind: "historical", question: hq, period,
    meaning: { ...meaningBase, measures: [{ name: m.name, unit: m.unit }], period, groupings: [], statistic: hq.statistic === "rate" ? "rate" : "count", ...rateMeaning },
    delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header }], rows: [[v]] }, text },
    read,
  };
}

/** One place of a mixed question, in the order asked: an agency (the Crime Index build) or a state or the nation (the historical file). */
export type BesidePlace = { agency: HistoricalAgency } | { geo: SrsPlace };
const besideName = (p: SrsPlace) => (p.kind === "national" ? "United States" : stateName(p.code));

/**
 * An agency beside its state or the nation (item 3, coordinator 2026-11-07: "a place beside its state or the nation"):
 * each place's own published figures side by side, one column each by year, or one row each for one year; never
 * combined, never one place's figures computed from another's. The agencies' are the build's (answerHistorical), the
 * states' and nation's the historical file's (answerSrsSeveral), both Crime Index. A count or a rate only, as for
 * several states; each rate is per 100,000 of that place's own population as Crime Index publishes it.
 */
export function answerBeside(hq: HistoricalQuestion, places: BesidePlace[], build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const m = HISTORICAL_MEASURE[hq.measure];
  if (!m) return { kind: "historical-decline", explanation: "Historical has violent and property crime and the seven Part I offenses only." };
  if (hq.comparison || hq.statistic === "clearance_rate")
    return { kind: "historical-decline", explanation: `This isn't available yet: ${hq.comparison ? "a change" : "a clearance rate"} for an agency beside a state or the nation. Ask for one place.` };
  const agencies = places.flatMap((p) => ("agency" in p ? [p.agency] : []));
  const geos = places.flatMap((p) => ("geo" in p ? [p.geo] : []));
  // Each side by year, then joined: the series starts at the first year any place has a figure.
  const a = answerHistorical({ ...hq, agencies, byYear: true }, build, execute);
  if (a.kind !== "historical") return a;
  const g = answerSrsSeveral({ measure: hq.measure, from: hq.from, to: hq.to, byYear: true, statistic: hq.statistic, comparison: null }, geos);
  if (g.kind !== "srs") return { kind: "historical-decline", explanation: g.explanation };
  const agencyYears = a.delivered.table.rows.map((r) => String(r[0]));
  const years = [...new Set([...agencyYears, ...g.delivered.table.rows.map((r) => String(r[0]))])].sort();
  const agencyAt = new Map(a.delivered.table.rows.map((r) => [String(r[0]), r.slice(1) as (number | null)[]]));
  const geoAt = new Map(g.delivered.table.rows.map((r) => [String(r[0]), r.slice(1) as (number | null)[]]));
  const value = (p: BesidePlace, y: string): number | null =>
    ("agency" in p ? agencyAt.get(y)?.[agencies.indexOf(p.agency)] : geoAt.get(y)?.[geos.indexOf(p.geo)]) ?? null;
  const names = places.map((p) => ("agency" in p ? p.agency.label : besideName(p.geo)));
  // In a sentence the nation is "the United States"; a column header and the chart say "United States".
  const said = places.map((p, i) => ("geo" in p && p.geo.kind === "national" ? "the United States" : names[i]));
  const joined = said.length > 2 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said.join(" and ");
  const where = `${joined[0].toUpperCase()}${joined.slice(1)}`;
  const rate = hq.statistic === "rate";
  const words = `${m.words}${rate ? " per 100,000" : ""}`;
  const header = `${ucFirst(m.words)}${rate ? " per 100,000" : ""}`;
  // Years before an agency's first figure that a state or the nation has: the agency's own start and blank lines
  // (which describe its years only) give way to blank lines over the years shown.
  const earlier = years[0] !== agencyYears[0];
  const own = (t: string) => !earlier || !/^Crime Index has no .*(?:, shown blank\.|so the chart and table start in \d{4}\.)$/.test(t);
  const spans = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
  const spanWords = (sp: [number, number][]) => {
    const w = sp.map(([x, y]) => (x === y ? String(x) : `${x} to ${y}`));
    return sp.length === 1 && sp[0][0] !== sp[0][1] ? `from ${w[0]}` : `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
  };
  const what = hq.statistic === "rate" ? `${m.name} rate` : `${m.name} figure`;
  const blanks = !earlier ? [] : agencies.flatMap((ag) => {
    const miss = years.filter((y) => value({ agency: ag }, y) === null).map(Number);
    return miss.length ? [`Crime Index has no ${what}${miss.length > 1 ? "s" : ""} for ${ag.label} ${spanWords(spans(miss))}, shown blank.`] : [];
  });
  // Every other line of both answers but their titles and sources, once each, in order: the agencies named, the years
  // outside either source, blanks and computed rates.
  const rest = [...a.delivered.text.slice(1).filter(own), ...blanks, ...g.delivered.text.slice(1)].filter((t, i, all) => t !== SRS_SOURCE && all.indexOf(t) === i);
  // The rates' common denominator; where Crime Index publishes no rate, its own line says the rate is computed
  // (Codex beside review 01.3: never "as published" over a computed rate).
  const rateNote = rate ? ["Each rate is per 100,000 of that place's own population."] : [];
  const period = { from: `${years[0]}-01`, to: `${years[years.length - 1]}-12` };
  const oneYear = !hq.byYear && years.length === 1;
  const columns: ResultTable["columns"] = oneYear
    ? [{ binding: { kind: "grouping", dimension: "geo.place" }, header: "Place" }, { binding: { kind: "statistic", as: "x" }, header }]
    : [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
      ...places.map((_, i) => ({ binding: { kind: "statistic" as const, as: `x.${i}` }, header: `${names[i]}: ${header.toLowerCase()}` }))];
  const rows = oneYear ? places.map((p, i) => [names[i], value(p, years[0])]) : years.map((y) => [y, ...places.map((p) => value(p, y))]);
  const title = oneYear ? `${where}: ${words} in ${years[0]}.` : `${where}: ${words} by year, ${periodWords(period.from, period.to)}.`;
  const placeMeaning = (p: BesidePlace): Meaning["places"][number] => ("agency" in p ? placeOf(p.agency)
    : p.geo.kind === "national" ? { kind: "national", name: "United States" } : { kind: "state", name: stateName(p.geo.code), state: p.geo.code });
  return {
    kind: "historical", question: { ...hq, agencies, beside: geos, shown: names }, period,
    meaning: { source: "historical", places: places.map(placeMeaning), filters: [], measures: [{ name: m.name, unit: m.unit }], period,
      groupings: oneYear ? ["place"] : ["year", "place"], statistic: rate ? "rate" : "count",
      ...(rate ? { denominator: "each place's population as published by Crime Index, per 100,000" } : {}) },
    delivered: { table: { columns, rows }, text: [title, ...rest, ...rateNote, SRS_SOURCE] },
    read: { ...a.read, table: "agency_crime + historical_crime_states_nation_1960-2025.csv" },
  };
}

/**
 * A state's city agencies ranked from Crime Index for one year (Jeff 2026-11-10, option A: "any year from 1930 to 2025,
 * counts and rates"): the build's agency rows of type city in the state, with a figure for the year, by count or by
 * rate per 100,000 (P75: the published rate, else the count per 100,000 of the published population), ties ordered by
 * name and every place tied at the cut shown (P17, as the NIBRS ranking, rankAgencies); cut at the limit (D05: 20). An
 * agency with no figure is left out and counted; before 1960 the reporting caveat is said (fewer agencies reported).
 */
export type HistoricalRankingQuestion = {
  measure: string; state: string; year: number; statistic: "count" | "rate"; direction: "top" | "bottom"; limit: number;
  /** P08: "large" cities, 250,000 residents or more by the year's published population. */
  minPopulation: number | null;
  /**
   * What is ranked (Jeff 2026-11-10, ranking decisions 1, 3 and 5): city agencies (Crime Index's geography type
   * "city", whatever the agency) in a state, or in the nation when `state` is "US"; every agency, city and county, when
   * "agencies" are asked; or the states, 1960 on, without DC.
   */
  entity?: "city" | "state" | "agency";
  /** A Census region (bad-declines plan item 8): its states, and its name for the answer; `state` is then "US". */
  region?: { name: string; states: string[] };
};
export function answerHistoricalRanking(rq: HistoricalRankingQuestion, build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const m = HISTORICAL_MEASURE[rq.measure];
  if (!m) return { kind: "historical-decline", explanation: "Historical has violent and property crime and the seven Part I offenses only." };
  const states = rq.entity === "state", national = states || rq.state === "US", cities = !states && rq.entity !== "agency";
  // States and the nation are published from 1960 (the archive's 1958-59 state rows are partial).
  const first = states ? Math.max(1960, build.firstYear) : build.firstYear;
  if (rq.year < first || rq.year > build.lastYear)
    return { kind: "historical-decline", explanation: `Historical ${states ? "state" : "city"} figures in the data cover ${first} through ${build.lastYear}, so ${rq.year} is outside them.` };
  if (!national && !/^[A-Z]{2}$/.test(rq.state)) return { kind: "historical-decline", explanation: "This isn't available yet: a ranking outside one state or the nation." };
  const rate = rq.statistic === "rate";
  const floorSql = rq.minPopulation && !states ? ` AND population >= ${Math.floor(rq.minPopulation)}` : "";
  const got = states
    ? execute(`SELECT state, name, population, ${m.col}_total, ${m.col}_capita, state FROM read_parquet(${q(`${build.root}/state_crime.parquet`)}) `
      + `WHERE year = ${rq.year} AND state <> 'DC' ORDER BY state`)
    : execute(`SELECT ori, ${cities ? cityNameSql() : "name"}, population, ${m.col}_total, ${m.col}_capita, state FROM read_parquet(${q(`${build.root}/agency_crime.parquet`)}) `
      + `WHERE ${national ? (rq.region ? `state IN (${rq.region.states.map(q).join(", ")}) AND ` : "") : `state = ${q(rq.state)} AND `}${cities ? `${citySql()} AND ` : `ori NOT IN (${CITY_AS.drop.map(q).join(", ")}) AND `}year = ${rq.year}${floorSql} ORDER BY ori`);
  const entries = got.map((r) => {
    const total = num(r[3]), capita = num(r[4]), population = num(r[2]);
    const v = rate ? historicalRate(capita, total, population) : { rate: total, computed: false };
    // In the nation a city is named with its state ("Columbus, OH"), so places of one name stay apart.
    const name = national && !states ? `${String(r[1])}, ${String(r[5])}` : String(r[1]);
    return { ori: String(r[0]), name, state: national ? String(r[5]) : rq.state, population, value: v.rate, computed: v.computed, known: v.rate !== null };
  });
  const where = rq.region ? ucFirst(rq.region.name) : national ? "United States" : stateName(rq.state);
  const floor = rq.minPopulation && !states ? ` with a population of ${fmt(rq.minPopulation)} or more` : "";
  const figure = rate ? `${m.name} rate` : `${m.name} figure`;
  const unit = states ? "states" : cities ? "city agencies" : "agencies";
  if (!entries.length) return { kind: "historical-decline", explanation: `Crime Index has no ${unit}${floor} in ${where} for ${rq.year}.` };
  const { ranked, leftOut, tie } = rankAgencies(entries, rq.direction, rq.limit);
  if (!ranked.length) return { kind: "historical-decline", explanation: `Crime Index has no ${figure} for any ${states ? "state" : cities ? "city agency" : "agency"}${floor} in ${where} in ${rq.year}: not available in this data.` };
  const what = rate ? `${m.name} rates` : m.words;
  const most = rq.direction === "top" ? (rate ? "highest" : "most") : (rate ? "lowest" : "fewest");
  const andList = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(" and "));
  const text = [`${states ? "States" : rq.region ? `${ucFirst(unit)} in ${rq.region.name}` : `${where} ${unit}`}${floor}: the ${ranked.length} with the ${most} ${what}${rate ? " per 100,000" : ""}, ${rq.year}.`,
    states ? `Ranked: the 50 states with a ${figure} in Crime Index for ${rq.year} (the District of Columbia is not a state); ties are ordered by name.`
      : cities ? `Ranked: city agencies (Crime Index's city geography, whatever the agency) with a ${figure} in Crime Index for ${rq.year}; ties are ordered by agency name.`
        : `Ranked: every agency, city and county, with a ${figure} in Crime Index for ${rq.year}; ties are ordered by agency name.`];
  if (tie) {
    const nth = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
    text.push(`${andList(tie.names)} tie for ${nth(tie.position)}, so ${tie.shown} agencies are shown.`);
  }
  if (leftOut.length) text.push(`Not ranked because Crime Index has no ${figure} for them in ${rq.year}: ${leftOut.length <= 5 ? andList(leftOut.map((a) => a.name).sort((x, y) => x.localeCompare(y))) : `${leftOut.length} ${unit}`}.`);
  if (rate) {
    text.push(`Rates are per 100,000 of each ${states ? "state" : "agency"}'s population as published by Crime Index.`);
    const computed = ranked.filter((a) => a.computed).map((a) => a.name);
    if (computed.length) text.push(`Crime Index publishes no ${m.name} rate for ${andList(computed)} in ${rq.year}; ${computed.length > 1 ? "their rates are" : "its rate is"} the count per 100,000 of the published population.`);
  }
  if (rq.year < 1960) text.push("Data before 1960 may reflect incomplete or limited reporting: fewer agencies reported then, and only those that did are ranked.");
  text.push(SRS_SOURCE);
  const header = `${ucFirst(m.words)}${rate ? " per 100,000" : ""}`;
  const period = { from: `${rq.year}-01`, to: `${rq.year}-12` };
  const agencies = ranked.map((a) => ({ ori: a.ori, label: a.name, name: a.name, state: a.state }));
  return {
    kind: "historical", period,
    question: { measure: rq.measure, agencies, from: rq.year, to: rq.year, byYear: false, statistic: rq.statistic, comparison: null,
      ranking: { state: rq.state, direction: rq.direction, limit: rq.limit, minPopulation: rq.minPopulation } },
    meaning: { source: "historical", places: [national ? { kind: "national", name: "United States" } : { kind: "state", name: where, state: rq.state }],
      filters: [states ? "states (not the District of Columbia)" : unit, ...(floor ? [`population ${fmt(rq.minPopulation!)} or more`] : [])],
      measures: [{ name: m.name, unit: m.unit }], period, groupings: [states ? "state" : "agency"], statistic: "rank",
      rank: { by: rate ? `${m.name} rate` : m.words, direction: rq.direction, limit: rq.limit },
      ...(rate ? { denominator: `the ${states ? "state" : "agency"}'s residents as published by Crime Index, per 100,000` } : {}) },
    delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: states ? "geo.state" : "geo.agency" }, header: states ? "State" : "Agency" }, { binding: { kind: "statistic", as: "x" }, header }],
      rows: ranked.map((a) => [a.name, a.value]) }, text },
    read: { table: "agency_crime", column: `${m.col}_${rate ? "capita" : "total"}`, release: build.release },
  };
}

/**
 * "The N largest cities" (Jeff 2026-11-10, ranking decisions 1 and 2): the N city agencies (Crime Index's geography type
 * "city") with the most residents as published for the last year asked, in a state or the nation, and their figure for
 * each year asked. Ties at the cut by population are ordered by name. A city with no figure for a year shows a blank.
 */
export type HistoricalSetQuestion = { measure: string; state: string; from: number; to: number; statistic: "count" | "rate"; n: number };
export function answerHistoricalSet(sq: HistoricalSetQuestion, build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const m = HISTORICAL_MEASURE[sq.measure];
  if (!m) return { kind: "historical-decline", explanation: "Historical has violent and property crime and the seven Part I offenses only." };
  if (sq.from < build.firstYear || sq.to > build.lastYear)
    return { kind: "historical-decline", explanation: `Historical city figures in the data cover ${build.firstYear} through ${build.lastYear}, so ${sq.from === sq.to ? sq.from : `${sq.from} through ${sq.to}`} is outside them.` };
  const national = sq.state === "US";
  const file = q(`${build.root}/agency_crime.parquet`);
  const inState = national ? "" : `state = ${q(sq.state)} AND `;
  // Every city tied with the Nth by population is in the set too (P17; Codex rankings review 01.4).
  const base = `SELECT ori, ${cityNameSql()} AS name, state, population FROM read_parquet(${file}) WHERE ${inState}${citySql()} AND year = ${sq.to} AND population IS NOT NULL`;
  const set = execute(`WITH c AS (${base}), cut AS (SELECT population FROM c ORDER BY population DESC LIMIT 1 OFFSET ${Math.floor(sq.n) - 1}) `
    + `SELECT * FROM c WHERE population >= coalesce((SELECT population FROM cut), 0) ORDER BY population DESC, name`);
  const where = national ? "the United States" : stateName(sq.state);
  if (!set.length) return { kind: "historical-decline", explanation: `Crime Index has no city populations in ${where} for ${sq.to}.` };
  const oris = set.map((r) => String(r[0]));
  const got = execute(`SELECT ori, year, ${m.col}_total, ${m.col}_capita, population FROM read_parquet(${file}) WHERE ori IN (${oris.map(q).join(", ")}) `
    + `AND year BETWEEN ${sq.from} AND ${sq.to} ORDER BY ori, year`);
  const rate = sq.statistic === "rate";
  const byKey = new Map(got.map((r) => [`${String(r[0])}:${Number(r[1])}`, r]));
  const label = (r: unknown[]) => (national ? `${String(r[1])}, ${String(r[2])}` : String(r[1]));
  const years = Array.from({ length: sq.to - sq.from + 1 }, (_, i) => sq.from + i);
  let computed = 0;
  const rows: (string | number | null)[][] = [];
  for (const c of set) for (const y of years) {
    const r = byKey.get(`${String(c[0])}:${y}`);
    let v: number | null = null;
    if (r) {
      if (rate) { const x = historicalRate(num(r[3]), num(r[2]), num(r[4])); v = x.rate; if (x.computed) computed++; } else v = num(r[2]);
    }
    rows.push(years.length > 1 ? [label(c), String(y), v] : [label(c), v]);
  }
  const what = rate ? `${m.name} rate per 100,000` : m.words;
  const span = sq.from === sq.to ? `${sq.from}` : `${sq.from} through ${sq.to}`;
  const text = [`The ${set.length} largest cities in ${where} by population (${sq.to}): ${what}, ${span}.`,
    // Every city with the Nth city's population, wherever the tie starts (Codex rankings review 02.1).
    ...(set.length > sq.n ? [`${set.filter((r) => num(r[3]) === num(set[sq.n - 1][3])).length} cities tie at the ${ordinal(sq.n)} largest population, so ${set.length} are shown.`] : []),
    `The cities are Crime Index's city agencies with the most residents as published for ${sq.to}, largest first; "city" is the geography, whatever the agency.`];
  const blanks = rows.filter((r) => r[r.length - 1] === null).length;
  if (blanks) text.push(`A blank means Crime Index has no ${m.name} ${rate ? "rate" : "figure"} for that city that year.`);
  if (rate) {
    text.push("Rates are per 100,000 of each agency's population as published by Crime Index.");
    if (computed) text.push(`Where Crime Index publishes no ${m.name} rate, the rate is the count per 100,000 of the published population.`);
  }
  if (sq.from < 1960) text.push("Data before 1960 may reflect incomplete or limited reporting.");
  text.push(SRS_SOURCE);
  const header = `${ucFirst(m.words)}${rate ? " per 100,000" : ""}`;
  const period = { from: `${sq.from}-01`, to: `${sq.to}-12` };
  const columns = [{ binding: { kind: "grouping" as const, dimension: "geo.agency" }, header: "City" },
    ...(years.length > 1 ? [{ binding: { kind: "grouping" as const, dimension: "time.year" }, header: "Year" }] : []),
    { binding: { kind: "statistic" as const, as: "x" }, header }];
  const agencies = set.map((c) => ({ ori: String(c[0]), label: label(c), name: String(c[1]), state: String(c[2]) }));
  return {
    kind: "historical", period,
    question: { measure: sq.measure, agencies, from: sq.from, to: sq.to, byYear: years.length > 1, statistic: sq.statistic, comparison: null },
    meaning: { source: "historical", places: [national ? { kind: "national", name: "United States" } : { kind: "state", name: where, state: sq.state }],
      filters: [`the ${set.length} largest city agencies by population (${sq.to})`], measures: [{ name: m.name, unit: m.unit }], period,
      groupings: ["agency", ...(years.length > 1 ? ["year"] : [])], statistic: rate ? "rate" : "count",
      ...(rate ? { denominator: "the agency's residents as published by Crime Index, per 100,000" } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { table: "agency_crime", column: `${m.col}_${rate ? "capita" : "total"}`, release: build.release },
  };
}

function ordinal(n: number): string {
  return `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;
}

/**
 * A Census region's yearly total from Crime Index (bad-declines plan item 8): the sum of its states' published totals,
 * a year counted only when every one of its states has a figure (Jeff 2026-11-10: complete data only); a rate is the
 * sum per 100,000 of the states' summed population. The District of Columbia isn't in the state totals: said for the South.
 */
export type HistoricalRegionQuestion = { measure: string; region: { name: string; states: string[] }; from: number; to: number; statistic: "count" | "rate"; byYear: boolean };
export function answerHistoricalRegion(hq: HistoricalRegionQuestion, build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const m = HISTORICAL_MEASURE[hq.measure];
  if (!m) return { kind: "historical-decline", explanation: "Historical has violent and property crime and the seven Part I offenses only." };
  const first = Math.max(1960, build.firstYear);
  if (hq.from < first || hq.to > build.lastYear)
    return { kind: "historical-decline", explanation: `Historical state figures in the data cover ${first} through ${build.lastYear}, so ${hq.from === hq.to ? hq.from : `${hq.from} through ${hq.to}`} is outside them.` };
  const states = hq.region.states.filter((s) => s !== "DC");
  const got = execute(`SELECT year, sum(${m.col}_total), sum(population), count(${m.col}_total), count(*) FROM read_parquet(${q(`${build.root}/state_crime.parquet`)}) `
    + `WHERE state IN (${states.map(q).join(", ")}) AND year BETWEEN ${hq.from} AND ${hq.to} GROUP BY year ORDER BY year`);
  const byYear = new Map(got.map((r) => [Number(r[0]), r]));
  const years = Array.from({ length: hq.to - hq.from + 1 }, (_, i) => hq.from + i);
  const rate = hq.statistic === "rate";
  const value = (y: number): number | null => {
    const r = byYear.get(y);
    // Every state of the region with a figure, or the year is blank.
    if (!r || Number(r[3]) !== states.length) return null;
    const total = num(r[1]), pop = num(r[2]);
    if (total === null) return null;
    return rate ? (pop && pop > 0 ? Math.round((total * 1e6) / pop) / 10 : null) : total;
  };
  const name = ucFirst(hq.region.name);
  const what = rate ? `${m.words} per 100,000` : m.words;
  const span = hq.from === hq.to ? `${hq.from}` : `${hq.from} through ${hq.to}`;
  let rows: (string | number | null)[][];
  if (hq.byYear || hq.from !== hq.to) rows = years.map((y) => [String(y), value(y)]);
  else rows = [[value(hq.from)]];
  const text = [`${name} (${states.length} states): ${what}${hq.byYear || hq.from !== hq.to ? " by year" : ""}, ${span}.`,
    `The region's states summed from Crime Index's state totals${rate ? "; the rate is per 100,000 of their summed population" : ""}.`];
  if (hq.region.states.includes("DC")) text.push("The District of Columbia isn't in the state totals, so it isn't included.");
  if (rows.some((r) => r[r.length - 1] === null)) text.push("A blank year is one in which a state of the region has no figure.");
  text.push(SRS_SOURCE);
  const period = { from: `${hq.from}-01`, to: `${hq.to}-12` };
  const header = `${ucFirst(m.words)}${rate ? " per 100,000" : ""}`;
  const columns = [...(rows[0].length > 1 ? [{ binding: { kind: "grouping" as const, dimension: "time.year" }, header: "Year" }] : []), { binding: { kind: "statistic" as const, as: "x" }, header }];
  return {
    kind: "historical", period,
    question: { measure: hq.measure, agencies: [], from: hq.from, to: hq.to, byYear: rows[0].length > 1, statistic: hq.statistic, comparison: null },
    meaning: { source: "historical", places: [{ kind: "national", name }], filters: [`the states of ${hq.region.name}`], measures: [{ name: m.name, unit: m.unit }], period,
      groupings: rows[0].length > 1 ? ["year"] : [], statistic: rate ? "rate" : "count",
      ...(rate ? { denominator: "the states' summed residents as published by Crime Index, per 100,000" } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { table: "state_crime", column: `${m.col}_total`, release: build.release },
  };
}
