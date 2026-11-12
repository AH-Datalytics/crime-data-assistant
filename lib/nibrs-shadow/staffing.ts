/**
 * Police staffing (item 1; query-log step one, 2026-11-02: one in eight of the Historical tab's first questions): an
 * agency's sworn officers, civilian employees or all employees, as counts or per 100,000 people, a year or by year,
 * several agencies side by side, from the Crime Index build's agency_staffing table. As published: the count and the
 * published rate (the *_capita column); where Crime Index publishes the count and the population but no rate, the
 * count per 100,000 of that population, said (P75's rule). Crime Index publishes no state or national staffing.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { fmt, fmtRate, SRS_SOURCE } from "./deliver";
import { historicalRate, type HistoricalAgency, type HistoricalAnswer, type HistoricalBuild, type HistoricalDecline } from "./historical";

export type StaffKind = "officers" | "civilians" | "employees";
/** Each kind's column stem in agency_staffing, and its words ("sworn officers"). */
export const STAFF_MEASURE: Record<StaffKind, { col: string; words: string; name: string }> = {
  officers: { col: "officer", words: "sworn officers", name: "sworn officer" },
  civilians: { col: "civilian", words: "civilian employees", name: "civilian employee" },
  employees: { col: "all", words: "police employees (officers and civilians)", name: "police employee" },
};

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const yearsWords = (a: number, b: number) => (a === b ? String(a) : `${a} through ${b}`);
const spans = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
const spanWords = (sp: [number, number][]) => {
  const w = sp.map(([x, y]) => (x === y ? String(x) : `${x} to ${y}`));
  return sp.length === 1 && sp[0][0] !== sp[0][1] ? `from ${w[0]}` : `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
};

/**
 * `per`: the base a rate is asked at (P97, Jeff 2026-11-07: "Convert to per 1,000"): Crime Index's published rate per
 * 100,000 converted to it (divided by 100 for per 1,000), its decimals kept, labeled with that base and said once.
 */
export function answerStaffing(kind: StaffKind, statistic: "count" | "rate", agencies: HistoricalAgency[], from: number, to: number, byYear: boolean,
  build: HistoricalBuild, execute: (sql: string) => unknown[][], extra: { agencyLine?: string; notes?: string[]; per?: number } = {}): HistoricalAnswer | HistoricalDecline {
  const m = STAFF_MEASURE[kind];
  const rate = statistic === "rate";
  const per = extra.per ?? 100_000;
  // One decimal per 100,000; each tenfold smaller base one more (308.4 per 100,000 is 3.084 per 1,000), never fewer than one.
  const decimals = Math.max(1, 1 + Math.round(Math.log10(100_000 / per)));
  const atBase = (v: number | null) => (v === null || per === 100_000 ? v : Number((v * per / 100_000).toFixed(decimals)));
  const perWords = `per ${fmt(per)}`;
  const shownRate = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const wanted = range(from, to), covered = wanted.filter((y) => y >= build.firstYear && y <= build.lastYear), outside = wanted.filter((y) => !covered.includes(y));
  const span = `Staffing figures in the data cover ${build.firstYear} through ${build.lastYear}`;
  if (!covered.length) return { kind: "historical-decline", explanation: `${span}, so ${yearsWords(from, to)} ${from === to ? "is" : "are"} outside them.` };
  const outsideWords = [outside.filter((y) => y < build.firstYear), outside.filter((y) => y > build.lastYear)].filter((ys) => ys.length).map((ys) => yearsWords(ys[0], ys[ys.length - 1])).join(" and ");
  const outsideLine = outside.length ? [`${span}; ${outsideWords} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
  const got = execute(`SELECT ori, year, ${m.col}_total, ${m.col}_capita, population FROM read_parquet(${q(`${build.root}/agency_staffing.parquet`)}) `
    + `WHERE ori IN (${agencies.map((a) => q(a.ori)).join(", ")}) AND year BETWEEN ${covered[0]} AND ${covered[covered.length - 1]} ORDER BY ori, year`);
  const cell = new Map(got.map((r) => [`${r[0]}|${r[1]}`, { total: num(r[2]), capita: num(r[3]), population: num(r[4]) }]));
  const value = (ori: string, y: number): number | null => {
    const c = cell.get(`${ori}|${y}`);
    if (!c) return null;
    return rate ? atBase(historicalRate(c.capita, c.total, c.population).rate) : c.total;
  };
  const several = agencies.length > 1;
  const where = agencies.map((a) => a.label).join(" and ");
  const what = `${m.words}${rate ? ` ${perWords} people` : ""}`;
  const header = `${m.words[0].toUpperCase()}${m.words.slice(1)}${rate ? ` ${perWords}` : ""}`;
  const baseNote = rate && per !== 100_000 ? [`Rates ${perWords} are Crime Index's published rates per 100,000, ${per < 100_000 ? `divided by ${fmt(100_000 / per)}` : `multiplied by ${fmt(per / 100_000)}`}.`] : [];
  const firstFigure = covered.findIndex((y) => agencies.some((a) => value(a.ori, y) !== null));
  if (firstFigure < 0) return { kind: "historical-decline", explanation: `Crime Index has no ${m.name} ${rate ? "rate" : "count"} for ${where} ${spanWords(spans(covered))}: not available in this data.` };
  const years = covered.slice(firstFigure);
  const startNote = firstFigure > 0 ? [`Crime Index has no ${m.name} ${rate ? "rate" : "count"} for ${where} ${spanWords(spans(covered.slice(0, firstFigure)))}, so the chart and table start in ${years[0]}.`] : [];
  const blanks = agencies.flatMap((a) => {
    const miss = years.filter((y) => value(a.ori, y) === null);
    return miss.length ? [`Crime Index has no ${m.name} ${rate ? "rate" : "count"} for ${a.label} ${spanWords(spans(miss))}, shown blank.`] : [];
  });
  // P75's rule, said: the years whose rate Crime Index leaves blank and the answer computes from its count and population.
  const computed = !rate ? [] : agencies.flatMap((a) => {
    const done = years.filter((y) => { const c = cell.get(`${a.ori}|${y}`); return !!c && historicalRate(c.capita, c.total, c.population).computed; });
    return done.length ? [`Crime Index publishes no ${m.name} rate for ${a.label} ${spanWords(spans(done))}; ${done.length > 1 ? "those years' rates are" : "that year's rate is"} the count ${perWords} of the published population.`] : [];
  });
  // With a computed rate among them, the base line doesn't call every rate published (Codex staffing review 04).
  const baseLine = !baseNote.length ? [] : computed.length
    ? [`Rates ${perWords} are rates per 100,000, ${per < 100_000 ? `divided by ${fmt(100_000 / per)}` : `multiplied by ${fmt(per / 100_000)}`}.`] : baseNote;
  const notes = [...(extra.agencyLine ? [extra.agencyLine] : []), ...baseLine, ...startNote, ...outsideLine, ...(extra.notes ?? []), ...computed, ...blanks];
  const period = { from: `${years[0]}-01`, to: `${years[years.length - 1]}-12` };
  let columns: ResultTable["columns"], rows: (string | number | null)[][], title: string;
  if (!byYear && years.length === 1 && wanted.length === 1) {
    const y = years[0];
    if (several) {
      columns = [{ binding: { kind: "grouping", dimension: "geo.agency" }, header: "Agency" }, { binding: { kind: "statistic", as: "x" }, header }];
      rows = agencies.map((a) => [a.label, value(a.ori, y)]);
      title = `${where}: ${what} in ${y}.`;
    } else {
      const v = value(agencies[0].ori, y);
      columns = [{ binding: { kind: "statistic", as: "x" }, header }];
      rows = [[v]];
      title = `${where}: ${rate ? shownRate(v!) : fmt(v!)} ${what} in ${y}.`;
    }
  } else {
    columns = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
      ...agencies.map((a, i) => ({ binding: { kind: "statistic" as const, as: several ? `x.${i}` : "x" }, header: several ? `${a.label}: ${header.toLowerCase()}` : header }))];
    rows = years.map((y) => [String(y), ...agencies.map((a) => value(a.ori, y))]);
    title = `${where}: ${what} by year, ${yearsWords(years[0], years[years.length - 1])}.`;
  }
  return {
    kind: "historical", period,
    question: { measure: `staffing:${kind}`, agencies, from, to, byYear, statistic, comparison: null, ...(extra.agencyLine ? { agencyLine: extra.agencyLine } : {}) },
    meaning: { source: "historical", places: agencies.map((a) => ({ kind: "agency" as const, name: a.name, ...(a.state ? { state: a.state } : {}) })), filters: [],
      measures: [{ name: m.name, unit: "person" }], period, groupings: [...(columns[0].header === "Year" ? ["year"] : []), ...(several ? ["agency"] : [])],
      statistic: rate ? "rate" : "count", ...(rate ? { denominator: `the agency's population as published by Crime Index, ${perWords}` } : {}) },
    delivered: { table: { columns, rows }, text: [title, ...notes, SRS_SOURCE] },
    read: { table: "agency_staffing", column: `${m.col}_${rate ? "capita" : "total"}`, release: build.release },
  };
}

/**
 * Staffing named beside a crime ("violent crime vs number of police officers in Kansas City"): staff words, and none
 * that make the officers a crime's victims or a ratio ("officers killed", "assaults on officers", "murders per officer").
 */
const STAFF_WORDS = /\b(?:staffing|staff levels?|(?:police |sworn )?officers?|sworn|cops?|civilian employees|police employees|headcount|police force size)\b/i;
const NOT_STAFF = /\b(?:kill\w*|assault\w*|attack\w*|shot|shoot\w*|murdered|injur\w*|victims?|line of duty|on duty|died|deaths?|arrest\w*|use of force|per\s+(?:police\s+)?(?:officer|cop|employee)s?|(?:against|by|on)\s+(?:the\s+)?(?:(?:police|sworn)\s+)?(?:officer|cop|employee)s?|(?<!\b(?:number|numbers|count|counts|total|rate|rates|level|levels|size)\s)of\s+(?:the\s+)?(?:(?:police|sworn|civilian|uniformed|law\s+enforcement)\s+)*(?:officer|cop|employee|personnel|staff)s?)\b/i;
export const staffingBesideWords = (question: string) => STAFF_WORDS.test(question) && !NOT_STAFF.test(question);
