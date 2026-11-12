/**
 * Police staffing beside a crime (engine 2, bad-declines 2026-11-11: "Compare violent crime to number of police officers
 * in Kansas City in 2022 vs 2025"): one agency's sworn officers, civilian employees or all employees next to one or
 * more Part I crimes, the same years, from the Crime Index build's agency_staffing and agency_crime tables. Counts sit
 * beside counts and rates beside rates (the staffing rate at the base asked, the crime rate per 100,000). A year either
 * one lacks shows blank and is said; nothing is paired across years.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { fmt, SRS_SOURCE } from "./deliver";
import { cityNameSql, citySql, HISTORICAL_MEASURE, historicalRate, type HistoricalAgency, type HistoricalAnswer, type HistoricalBuild, type HistoricalDecline } from "./historical";
import { stateName } from "./places";
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
    ...headers.map((header, i) => ({ binding: { kind: "statistic" as const, as: i === 0 ? "staffing" : `crime.${crimeData[i - 1].key}` }, header }))];
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

/**
 * The N largest cities beside staffing and crime (engine 2: "Compare crime rates vs police staffing levels across the 20
 * largest cities in the US", once the crime and the year are chosen): the city agencies with the most residents in the
 * nation or a state for the year (every city tied with the Nth included), each one's staffing next to the crime. Complete
 * data only (Jeff's ranking rule): a city lacking a staffing or crime figure that year is left out and named.
 */
export function answerStaffingSet(kind: StaffKind, statistic: "count" | "rate", state: string, year: number, n: number, crimes: string[], build: HistoricalBuild,
  execute: (sql: string) => unknown[][], extra: { per?: number } = {}): HistoricalAnswer | HistoricalDecline {
  const sm = STAFF_MEASURE[kind];
  const rate = statistic === "rate";
  const per = extra.per ?? 100_000;
  const decimals = Math.max(1, 1 + Math.round(Math.log10(100_000 / per)));
  const atBase = (v: number | null) => (v === null || per === 100_000 ? v : Number((v * per / 100_000).toFixed(decimals)));
  if (year < build.firstYear || year > build.lastYear)
    return { kind: "historical-decline", explanation: `Figures in the data cover ${build.firstYear} through ${build.lastYear}, so ${year} is outside them.` };
  const national = state === "US";
  const crimeFile = q(`${build.root}/agency_crime.parquet`);
  const inState = national ? "" : `state = ${q(state)} AND `;
  const base = `SELECT ori, ${cityNameSql()} AS name, state, population FROM read_parquet(${crimeFile}) WHERE ${inState}${citySql()} AND year = ${year} AND population IS NOT NULL`;
  const set = execute(`WITH c AS (${base}), cut AS (SELECT population FROM c ORDER BY population DESC LIMIT 1 OFFSET ${Math.floor(n) - 1}) `
    + `SELECT * FROM c WHERE population >= coalesce((SELECT population FROM cut), 0) ORDER BY population DESC, name`);
  const where = national ? "the United States" : stateName(state);
  if (!set.length) return { kind: "historical-decline", explanation: `Crime Index has no city populations in ${where} for ${year}.` };
  const oris = set.map((r) => q(String(r[0]))).join(", ");
  const staffRows = execute(`SELECT ori, year, ${sm.col}_total, ${sm.col}_capita, population FROM read_parquet(${q(`${build.root}/agency_staffing.parquet`)}) `
    + `WHERE ori IN (${oris}) AND year BETWEEN ${year} AND ${year} ORDER BY ori, year`);
  const staff = new Map(staffRows.map((r) => [String(r[0]), { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
  const staffValue = (ori: string) => { const c = staff.get(ori); return !c ? null : rate ? atBase(historicalRate(c.capita, c.total, c.population).rate) : c.total; };
  const crimeData = crimes.map((key) => {
    const m = HISTORICAL_MEASURE[key];
    const got = execute(`SELECT ori, year, ${m.col}_total, ${m.col}_capita, population FROM read_parquet(${crimeFile}) WHERE ori IN (${oris}) AND year BETWEEN ${year} AND ${year} ORDER BY ori, year`);
    const cell = new Map(got.map((r) => [String(r[0]), { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
    return { key, m, value: (ori: string) => { const c = cell.get(ori); return !c ? null : rate ? historicalRate(c.capita, c.total, c.population).rate : c.total; } };
  });
  const label = (r: unknown[]) => (national ? `${String(r[1])}, ${String(r[2])}` : String(r[1]));
  const complete = set.filter((r) => staffValue(String(r[0])) !== null && crimeData.every((c) => c.value(String(r[0])) !== null));
  const left = set.filter((r) => !complete.includes(r));
  if (!complete.length) return { kind: "historical-decline", explanation: `No city among the ${set.length} largest in ${where} has both staffing and crime figures for ${year}.` };
  const staffPerWords = `per ${fmt(per)}`;
  const sw = staffingMeasureOf(besideMeasure(kind, crimes));
  const text = [`The ${n} largest cities in ${where} by population (${year}): ${sw.words}${rate ? (per === 100_000 ? " as rates per 100,000" : ` as rates (staffing ${staffPerWords}, crime per 100,000)`) : ""}.`,
    ...(set.length > n ? [`${set.filter((r) => num(r[3]) === num(set[n - 1][3])).length} cities tie at the ${n}th largest population, so ${set.length} are in the set.`] : []),
    `The cities are Crime Index's city agencies with the most residents as published for ${year}, largest first; "city" is the geography, whatever the agency.`,
    ...(rate && per !== 100_000 ? [`${ucFirst(sm.words)} ${staffPerWords} are rates per 100,000, ${per < 100_000 ? `divided by ${fmt(100_000 / per)}` : `multiplied by ${fmt(per / 100_000)}`}.`] : []),
    ...(left.length ? [`Left out because Crime Index lacks a staffing or crime figure for ${year}: ${listWords(left.map(label))}.`] : []),
    SRS_SOURCE];
  const headers = [`${ucFirst(sm.words)}${rate ? ` ${staffPerWords}` : ""}`, ...crimeData.map((c) => `${ucFirst(c.m.words)}${rate ? " per 100,000" : ""}`)];
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "City" },
    { binding: { kind: "statistic", as: "staffing" }, header: headers[0] }, ...crimeData.map((c, i) => ({ binding: { kind: "statistic" as const, as: `crime.${c.key}` }, header: headers[i + 1] }))];
  const rows = complete.map((r) => [label(r), staffValue(String(r[0])), ...crimeData.map((c) => c.value(String(r[0])))]) as (string | number | null)[][];
  const period = { from: `${year}-01`, to: `${year}-12` };
  const agencies = complete.map((r) => ({ ori: String(r[0]), label: label(r), name: String(r[1]), state: String(r[2]) }));
  return {
    kind: "historical", period,
    question: { measure: besideMeasure(kind, crimes), agencies, from: year, to: year, byYear: false, statistic, comparison: null },
    meaning: { source: "historical", places: [national ? { kind: "national", name: "United States" } : { kind: "state", name: where, state }],
      filters: [`the ${n} largest city agencies by population (${year})`], measures: [{ name: sm.name, unit: "person" }, ...crimeData.map((c) => ({ name: c.m.name, unit: c.m.unit }))], period,
      groupings: ["agency"], statistic: rate ? "rate" : "count", ...(rate ? { denominator: `each agency's population as published by Crime Index (staffing ${staffPerWords}, crime per 100,000)` } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { table: "agency_staffing, agency_crime", column: `${sm.col}_${rate ? "capita" : "total"}, ${crimeData.map((c) => `${c.m.col}_${rate ? "capita" : "total"}`).join(", ")}`, release: build.release },
  };
}
