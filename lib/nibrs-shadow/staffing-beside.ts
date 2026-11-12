/**
 * Police staffing beside a crime (engine 2, bad-declines 2026-11-11: "Compare violent crime to number of police officers
 * in Kansas City in 2022 vs 2025"): one agency's sworn officers, civilian employees or all employees next to one or
 * more Part I crimes, the same years, from the Crime Index build's agency_staffing and agency_crime tables. Counts sit
 * beside counts and rates beside rates (the staffing rate at the base asked, the crime rate per 100,000). A year either
 * one lacks shows blank and is said; nothing is paired across years.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { fmt, SRS_SOURCE } from "./deliver";
import { HISTORICAL_MEASURE, historicalRate, type HistoricalAgency, type HistoricalAnswer, type HistoricalBuild, type HistoricalDecline } from "./historical";
import { STAFF_MEASURE, type StaffKind } from "./staffing";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const ucFirst = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
const spans = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
const spanWords = (sp: [number, number][]) => {
  const w = sp.map(([x, y]) => (x === y ? String(x) : `${x} to ${y}`));
  return `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
};
const listWords = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs[0]);

/** The measure string of a staffing answer: "staffing:officers", or with crimes beside it "staffing:officers|violent_crime,property_crime". */
export const besideMeasure = (kind: StaffKind, crimes: string[]) => `staffing:${kind}${crimes.length ? `|${crimes.join(",")}` : ""}`;
/** The words and name of a staffing measure string, with any crimes beside it ("sworn officers and violent crimes"). */
export function staffingMeasureOf(measure: string): { words: string; name: string } {
  const [head, crimes] = measure.slice(9).split("|");
  const s = STAFF_MEASURE[head as StaffKind];
  const cs = (crimes ?? "").split(",").filter((c) => c in HISTORICAL_MEASURE).map((c) => HISTORICAL_MEASURE[c]);
  return cs.length ? { words: `${s.words} and ${listWords(cs.map((c) => c.words))}`, name: `${s.name} and ${listWords(cs.map((c) => c.name))}` } : s;
}

/**
 * `years`: the years asked (a range or the years named); `per`: the base the staffing rate is asked at. A rate for
 * several crimes is each crime's published rate per 100,000.
 */
export function answerStaffingBeside(kind: StaffKind, statistic: "count" | "rate", agency: HistoricalAgency, years: number[], crimes: string[], build: HistoricalBuild,
  execute: (sql: string) => unknown[][], extra: { agencyLine?: string; per?: number } = {}): HistoricalAnswer | HistoricalDecline {
  const sm = STAFF_MEASURE[kind];
  const rate = statistic === "rate";
  const per = extra.per ?? 100_000;
  const decimals = Math.max(1, 1 + Math.round(Math.log10(100_000 / per)));
  const atBase = (v: number | null) => (v === null || per === 100_000 ? v : Number((v * per / 100_000).toFixed(decimals)));
  const asked = [...new Set(years)].sort((a, b) => a - b);
  const covered = asked.filter((y) => y >= build.firstYear && y <= build.lastYear), outside = asked.filter((y) => !covered.includes(y));
  const span = `Figures in the data cover ${build.firstYear} through ${build.lastYear}`;
  if (!covered.length) return { kind: "historical-decline", explanation: `${span}, so ${listWords(outside.map(String))} ${outside.length > 1 ? "are" : "is"} outside them.` };
  const lo = covered[0], hi = covered[covered.length - 1];
  const staffRows = execute(`SELECT ori, year, ${sm.col}_total, ${sm.col}_capita, population FROM read_parquet(${q(`${build.root}/agency_staffing.parquet`)}) `
    + `WHERE ori IN (${q(agency.ori)}) AND year BETWEEN ${lo} AND ${hi} ORDER BY ori, year`);
  const staff = new Map(staffRows.map((r) => [Number(r[1]), { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
  const staffValue = (y: number) => { const c = staff.get(y); return !c ? null : rate ? atBase(historicalRate(c.capita, c.total, c.population).rate) : c.total; };
  const staffComputed = (y: number) => { const c = staff.get(y); return !!c && rate && historicalRate(c.capita, c.total, c.population).computed; };
  const crimeData = crimes.map((key) => {
    const m = HISTORICAL_MEASURE[key];
    const got = execute(`SELECT ori, year, ${m.col}_total, ${m.col}_capita, population FROM read_parquet(${q(`${build.root}/agency_crime.parquet`)}) `
      + `WHERE ori IN (${q(agency.ori)}) AND year BETWEEN ${lo} AND ${hi} ORDER BY ori, year`);
    const cell = new Map(got.map((r) => [Number(r[1]), { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
    const value = (y: number) => { const c = cell.get(y); return !c ? null : rate ? historicalRate(c.capita, c.total, c.population).rate : c.total; };
    const computed = (y: number) => { const c = cell.get(y); return !!c && rate && historicalRate(c.capita, c.total, c.population).computed; };
    return { key, m, value, computed };
  });
  const figures = (y: number) => [staffValue(y), ...crimeData.map((c) => c.value(y))];
  const contiguous = covered.length === hi - lo + 1;
  // A span of years starts at the first year with a staffing figure (as staffing alone does); years named stay as asked.
  const firstFigure = contiguous ? covered.findIndex((y) => staffValue(y) !== null) : 0;
  if (firstFigure < 0) return { kind: "historical-decline", explanation: `Crime Index has no ${sm.name} ${rate ? "rate" : "count"} for ${agency.label} ${spanWords(spans(covered))}: not available in this data.` };
  const shown = covered.slice(firstFigure);
  const startNote = firstFigure > 0 ? [`Crime Index has no ${sm.name} ${rate ? "rate" : "count"} for ${agency.label} ${spanWords(spans(covered.slice(0, firstFigure)))}, so the table starts in ${shown[0]}.`] : [];
  const outsideNote = outside.length ? [`${span}; ${listWords(outside.map(String))} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
  const blank = (label: string, ys: number[]) => (ys.length ? [`Crime Index has no ${label} for ${agency.label} ${spanWords(spans(ys))}, shown blank.`] : []);
  const blanks = [...blank(`${sm.name} ${rate ? "rate" : "count"}`, shown.filter((y) => staffValue(y) === null)),
    ...crimeData.flatMap((c) => blank(`${c.m.name} ${rate ? "rate" : "count"}`, shown.filter((y) => c.value(y) === null)))];
  const staffPerWords = `per ${fmt(per)}`;
  const computedNotes = [
    ...(shown.some(staffComputed) ? [`Crime Index publishes no ${sm.name} rate for ${agency.label} ${spanWords(spans(shown.filter(staffComputed)))}; ${shown.filter(staffComputed).length > 1 ? "those years' rates are" : "that year's rate is"} the count ${staffPerWords} of the published population.`] : []),
    ...crimeData.flatMap((c) => (shown.some(c.computed) ? [`Crime Index publishes no ${c.m.name} rate for ${agency.label} ${spanWords(spans(shown.filter(c.computed)))}; ${shown.filter(c.computed).length > 1 ? "those years' rates are" : "that year's rate is"} the count per 100,000 of the published population.`] : [])),
  ];
  const baseNote = rate && per !== 100_000 ? [`${ucFirst(sm.words)} ${staffPerWords} are rates per 100,000, ${per < 100_000 ? `divided by ${fmt(100_000 / per)}` : `multiplied by ${fmt(per / 100_000)}`}.`] : [];
  const sw = staffingMeasureOf(besideMeasure(kind, crimes));
  const when = shown.length === 1 ? String(shown[0]) : shown.length === 2 ? `${shown[0]} and ${shown[1]}` : contiguous ? `${shown[0]} through ${shown[shown.length - 1]}` : listWords(shown.map(String));
  const title = `${agency.label}: ${sw.words}${rate ? (per === 100_000 ? " as rates per 100,000" : ` as rates (staffing ${staffPerWords}, crime per 100,000)`) : ""}, ${when}.`;
  const headers = [`${ucFirst(sm.words)}${rate ? ` ${staffPerWords}` : ""}`, ...crimeData.map((c) => `${ucFirst(c.m.words)}${rate ? " per 100,000" : ""}`)];
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
    ...headers.map((header, i) => ({ binding: { kind: "statistic" as const, as: `x.${i}` }, header }))];
  const rows = shown.map((y) => [String(y), ...figures(y)]) as (string | number | null)[][];
  const period = { from: `${shown[0]}-01`, to: `${shown[shown.length - 1]}-12` };
  const notes = [...(extra.agencyLine ? [extra.agencyLine] : []), ...baseNote, ...startNote, ...outsideNote, ...computedNotes, ...blanks];
  return {
    kind: "historical", period,
    question: { measure: besideMeasure(kind, crimes), agencies: [agency], from: shown[0], to: shown[shown.length - 1], byYear: true, statistic, comparison: null,
      ...(extra.agencyLine ? { agencyLine: extra.agencyLine } : {}) },
    meaning: { source: "historical", places: [{ kind: "agency" as const, name: agency.name, ...(agency.state ? { state: agency.state } : {}) }], filters: [],
      measures: [{ name: sm.name, unit: "person" }, ...crimeData.map((c) => ({ name: c.m.name, unit: c.m.unit }))], period, groupings: ["year"],
      statistic: rate ? "rate" : "count", ...(rate ? { denominator: `the agency's population as published by Crime Index (staffing ${staffPerWords}, crime per 100,000)` } : {}) },
    delivered: { table: { columns, rows }, text: [title, ...notes, SRS_SOURCE] },
    read: { table: "agency_staffing, agency_crime", column: `${sm.col}_${rate ? "capita" : "total"}, ${crimeData.map((c) => `${c.m.col}_${rate ? "capita" : "total"}`).join(", ")}`, release: build.release },
  };
}
