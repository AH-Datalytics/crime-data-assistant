/**
 * Police staffing for SETS of city agencies (Jeff 2026-11-23, rankings follow-up, PR 2): the question forms the staffing
 * answer for one agency (staffing.ts) can't take. Four closed forms, each read from the question's own words, nothing else:
 *   rank     "Which cities have the most officers per capita in 2023?", "What 5 city police departments had the most officers in 2025?"
 *   list     "a list of every city that had 500 or more officers in 2019 and the number of officers in 2019, 2022 ... 2025"
 *   share    "What share of city police departments that had 500 or more officers in 2024 gained officers in 2025?" (N of M, X percent)
 *   scatter  "a scatter plot of violent crime rate per 100k in 2024 vs officers per 100k in cities of 250k or more" (the table of the two)
 * Reads only the Crime Index build's agency_staffing (and agency_crime for the scatter's table); no new counting.
 * Jeff's ranking rules apply: 20 rows unless a number is asked, rates among cities of 100,000 or more (said in the title),
 * counts with no cut, latest year when none is named (said), ties per P17 (rankAgencies), every figure as published.
 */
import type { ResultTable } from "../nibrs-plan/result";
import { rankAgencies, truncatedTieSentence } from "../nibrs-plan/transforms";
import { fmt, SRS_SOURCE } from "./deliver";
import { titleTimeframe } from "./headline";
import { citySql, cityNameSql, historicalRate, type HistoricalAnswer, type HistoricalBuild, type HistoricalDecline } from "./historical";
import { STAFF_MEASURE, type StaffKind } from "./staffing";
import { titleCase } from "./titles";

export type StaffSetQuestion =
  | { form: "rank"; kind: StaffKind; rate: boolean; year: number | null; limit: number | null; direction: "top" | "bottom" }
  | { form: "list"; minCount: number; year: number; years: number[] }
  | { form: "share"; minCount: number; year: number; later: number }
  | { form: "scatter"; year: number; minPopulation: number };

const YEAR = "((?:19|20)\\d\\d)";
const NUM = "(\\d[\\d,]*)";
const toNum = (s: string) => Number(s.replace(/,/g, ""));

/** The question's form, or null when it is none of the four (the caller keeps its plain decline). */
export function parseStaffSet(question: string): StaffSetQuestion | null {
  const q = question.replace(/[“”"]/g, "").replace(/\s+/g, " ").replace(/^\s*historical[,:]?\s+/i, "").replace(/[?.!\s]+$/, "").trim();
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^(?:which|what)\\s+(?:${NUM}\\s+)?(?:city|cities|city police departments?|police departments?|city agencies)\\s+(?:have|had|has)\\s+the\\s+(most|highest|fewest|lowest)\\s+(?:police\\s+|sworn\\s+)?(officers?|cops|employees)(\\s+per\\s+capita|\\s+per\\s+100,?000(?:\\s+(?:people|residents))?)?(?:\\s+in\\s+${YEAR})?$`, "i").exec(q))) {
    return { form: "rank", kind: /employees/i.test(m[3]) ? "employees" : "officers", rate: !!m[4], year: m[5] ? Number(m[5]) : null,
      limit: m[1] ? Math.min(100, toNum(m[1])) : null, direction: /^(?:fewest|lowest)$/i.test(m[2]) ? "bottom" : "top" };
  }
  if ((m = new RegExp(`^(?:provide|give me|show me)?\\s*(?:me\\s+)?(?:a\\s+)?list of every city that had ${NUM} or more (?:police\\s+)?officers in ${YEAR} and the number of (?:police\\s+)?officers that agency had in ((?:(?:19|20)\\d\\d(?:\\s*,\\s*and\\s+|\\s*,\\s*|\\s+and\\s+)?)+)$`, "i").exec(q))) {
    const years = [...new Set([Number(m[2]), ...[...m[3].matchAll(/(?:19|20)\d\d/g)].map((x) => Number(x[0]))])].sort((a, b) => a - b);
    return { form: "list", minCount: toNum(m[1]), year: Number(m[2]), years };
  }
  if ((m = new RegExp(`^what (?:share|percent|percentage) of (?:city )?police departments (?:that )?had ${NUM} or more (?:police )?officers in ${YEAR} gained (?:police )?officers in ${YEAR}$`, "i").exec(q))) {
    return { form: "share", minCount: toNum(m[1]), year: Number(m[2]), later: Number(m[3]) };
  }
  if ((m = new RegExp(`^(?:give me )?a scatter plot of violent crime rate per 100k in ${YEAR} (?:vs\\.?|versus) (?:police )?officers per 100k in cities of (\\d+)k or more$`, "i").exec(q))) {
    return { form: "scatter", year: Number(m[1]), minPopulation: Number(m[2]) * 1000 };
  }
  return null;
}

const sq = (s: string) => `'${s.replace(/'/g, "''")}'`;
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const decline = (explanation: string): HistoricalDecline => ({ kind: "historical-decline", explanation });
const andList = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(" and "));
const yearOutside = (b: HistoricalBuild, ys: number[]) => ys.find((y) => y < b.firstYear || y > b.lastYear);
const outsideSentence = (b: HistoricalBuild, y: number) => `Staffing figures in the data cover ${b.firstYear} through ${b.lastYear}, so ${y} is outside them.`;

type Row = (string | number | null)[];
type Cols = ResultTable["columns"];
const nameCol = (header: string): Cols[number] => ({ binding: { kind: "grouping", dimension: "geo.agency" }, header });
const statCol = (i: number, header: string): Cols[number] => ({ binding: { kind: "statistic", as: i === 0 ? "x" : `x.${i}` }, header });

function wrap(kind: StaffKind | "crime", year: number, years: number[], columns: Cols, rows: Row[], text: string[], statistic: "rank" | "count" | "rate" | "share", build: HistoricalBuild,
  agencies: { ori: string; label: string; name: string; state: string }[], meaningMeasure: string, denominator?: string): HistoricalAnswer {
  const period = { from: `${years[0]}-01`, to: `${years[years.length - 1]}-12` };
  return {
    kind: "historical", period,
    question: { measure: `staffing:${kind}`, agencies, from: years[0], to: years[years.length - 1], byYear: years.length > 1, statistic: statistic === "rate" ? "rate" : "count", comparison: null },
    meaning: { source: "historical", places: [{ kind: "national", name: "United States" }], filters: ["city agencies"], measures: [{ name: meaningMeasure, unit: "person" }], period,
      groupings: ["agency"], statistic: statistic as never, ...(denominator ? { denominator } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { table: "agency_staffing", column: kind === "crime" ? "officer_capita" : `${STAFF_MEASURE[kind].col}_${statistic === "rate" ? "capita" : "total"}`, release: build.release },
  } as HistoricalAnswer;
}

export function answerStaffSet(sp: StaffSetQuestion, build: HistoricalBuild, execute: (sql: string) => unknown[][]): HistoricalAnswer | HistoricalDecline {
  const file = sq(`${build.root}/agency_staffing.parquet`);
  if (sp.form === "rank") return rankForm(sp, build, execute, file);
  if (sp.form === "list") return listForm(sp, build, execute, file);
  if (sp.form === "share") return shareForm(sp, build, execute, file);
  return scatterForm(sp, build, execute, file);
}

function rankForm(sp: Extract<StaffSetQuestion, { form: "rank" }>, build: HistoricalBuild, execute: (sql: string) => unknown[][], file: string): HistoricalAnswer | HistoricalDecline {
  const m = STAFF_MEASURE[sp.kind];
  const yearSaid = sp.year !== null, year = sp.year ?? build.lastYear;
  if (yearOutside(build, [year]) !== undefined) return decline(outsideSentence(build, year));
  const limit = sp.limit ?? 20;
  // Jeff's rule: a rate ranking among cities of 100,000 or more, said in the title; a count has no cut.
  const minPopulation = sp.rate ? 100_000 : null;
  const got = execute(`SELECT ori, ${cityNameSql()}, population, ${m.col}_total, ${m.col}_capita, state FROM read_parquet(${file}) `
    + `WHERE ${citySql()} AND year = ${year}${minPopulation ? ` AND population >= ${minPopulation}` : ""} ORDER BY ori`);
  if (!got.length) return decline(`Crime Index has no city agencies${minPopulation ? ` with a population of ${fmt(minPopulation)} or more` : ""} with staffing figures for ${year}.`);
  const entries = got.map((r) => {
    const total = num(r[3]), capita = num(r[4]), population = num(r[2]);
    const v = sp.rate ? historicalRate(capita, total, population) : { rate: total, computed: false };
    return { ori: String(r[0]), name: `${String(r[1])}, ${String(r[5])}`, state: String(r[5]), population, value: v.rate, computed: v.computed, known: v.rate !== null };
  });
  const { ranked, leftOut, tie } = rankAgencies(entries, sp.direction, limit);
  if (!ranked.length) return decline(`Crime Index has no ${m.name} ${sp.rate ? "rate" : "count"} for any city agency in ${year}: not available in this data.`);
  const most = sp.direction === "top" ? "most" : "fewest";
  const header = `${titleCase(m.words)}${sp.rate ? " per 100,000" : ""}`;
  const title = `${titleCase(`${m.name} ${sp.rate ? "rate" : "count"}`)} by City${minPopulation ? `, Population ${fmt(minPopulation)} or More` : ""}, ${titleTimeframe(String(year))}`;
  const text = [title, `The ${ranked.length} cities with the ${most} ${sp.rate ? `${m.words} per 100,000 people` : m.words} are shown.`];
  if (!yearSaid) text.push(`No year was asked, so the latest year in the data, ${year}, is shown.`);
  if (sp.rate) text.push(`Rates are among cities of ${fmt(100_000)} or more people, per 100,000 of each agency's population as published by Crime Index.`);
  if (tie?.truncated) text.push(truncatedTieSentence(tie, sp.rate));
  else if (tie) text.push(`${andList(tie.names)} tie for ${tie.position}${[ "th", "st", "nd", "rd" ][tie.position % 100 >= 11 && tie.position % 100 <= 13 ? 0 : tie.position % 10] ?? "th"}, so ${tie.shown} agencies are shown.`);
  if (leftOut.length) text.push(`${fmt(leftOut.length)} city ${leftOut.length === 1 ? "agency isn't" : "agencies aren't"} ranked because Crime Index has no ${m.name} ${sp.rate ? "rate" : "count"} for them in ${year}.`);
  text.push("Ties are ordered by agency name.", "Cities are Crime Index's city agencies, whatever the agency.", SRS_SOURCE);
  const agencies = ranked.map((a) => ({ ori: a.ori, label: a.name, name: a.name, state: a.state }));
  return wrap(sp.kind, year, [year], [nameCol("Agency"), statCol(0, header)], ranked.map((a) => [a.name, a.value]), text, sp.rate ? "rate" : "count", build, agencies, m.name,
    sp.rate ? "each agency's population as published by Crime Index, per 100,000" : undefined);
}

function listForm(sp: Extract<StaffSetQuestion, { form: "list" }>, build: HistoricalBuild, execute: (sql: string) => unknown[][], file: string): HistoricalAnswer | HistoricalDecline {
  const bad = yearOutside(build, sp.years);
  if (bad !== undefined) return decline(outsideSentence(build, bad));
  const got = execute(`SELECT ori, ${cityNameSql()}, state, year, officer_total FROM read_parquet(${file}) `
    + `WHERE ${citySql()} AND year IN (${sp.years.join(", ")}) AND ori IN (SELECT ori FROM read_parquet(${file}) WHERE ${citySql()} AND year = ${sp.year} AND officer_total >= ${sp.minCount}) ORDER BY ori, year`);
  const byOri = new Map<string, { name: string; state: string; by: Map<number, number | null> }>();
  for (const r of got) {
    const o = String(r[0]);
    const e = byOri.get(o) ?? { name: `${String(r[1])}, ${String(r[2])}`, state: String(r[2]), by: new Map() };
    e.by.set(Number(r[3]), num(r[4]));
    byOri.set(o, e);
  }
  if (!byOri.size) return decline(`No city agency had ${fmt(sp.minCount)} or more sworn officers in ${sp.year} in Crime Index.`);
  const list = [...byOri.entries()].map(([ori, e]) => ({ ori, ...e })).sort((a, b) => (b.by.get(sp.year) ?? 0) - (a.by.get(sp.year) ?? 0) || a.name.localeCompare(b.name));
  const rows: Row[] = list.map((e) => [e.name, ...sp.years.map((y) => e.by.get(y) ?? null)]);
  const columns: Cols = [nameCol("Agency"), ...sp.years.map((y, i) => statCol(i, `Sworn officers ${y}`))];
  const blanks = rows.reduce((n, r) => n + r.slice(1).filter((v) => v === null).length, 0);
  const text = [`City Police Departments With ${fmt(sp.minCount)} or More Sworn Officers in ${sp.year}, Sworn Officers ${sp.years.length > 1 ? `${sp.years[0]}-${sp.years[sp.years.length - 1]}` : sp.years[0]}`,
    `${list.length} city agencies had ${fmt(sp.minCount)} or more sworn officers in ${sp.year}; each is shown with its sworn officers in ${andList(sp.years.map(String))}.`,
    ...(blanks ? [`${fmt(blanks)} figures are blank where Crime Index has no sworn officer count for that agency and year.`] : []),
    "Ordered by sworn officers in " + sp.year + ", then by agency name.", "Cities are Crime Index's city agencies, whatever the agency.", SRS_SOURCE];
  return wrap("officers", sp.year, sp.years, columns, rows, text, "count", build, list.map((e) => ({ ori: e.ori, label: e.name, name: e.name, state: e.state })), "sworn officer");
}

function shareForm(sp: Extract<StaffSetQuestion, { form: "share" }>, build: HistoricalBuild, execute: (sql: string) => unknown[][], file: string): HistoricalAnswer | HistoricalDecline {
  const bad = yearOutside(build, [sp.year, sp.later]);
  if (bad !== undefined) return decline(outsideSentence(build, bad));
  if (sp.later <= sp.year) return decline("The later year has to come after the year of the department size, for example \"gained officers in 2025\" for departments counted in 2024.");
  const got = execute(`SELECT a.ori, ${cityNameSql("a")}, a.state, a.officer_total, b.officer_total FROM read_parquet(${file}) a LEFT JOIN read_parquet(${file}) b ON b.ori = a.ori AND b.year = ${sp.later} `
    + `WHERE ${citySql("a")} AND a.year = ${sp.year} AND a.officer_total >= ${sp.minCount} ORDER BY a.ori`);
  if (!got.length) return decline(`No city agency had ${fmt(sp.minCount)} or more sworn officers in ${sp.year} in Crime Index.`);
  const both = got.filter((r) => num(r[4]) !== null);
  const gained = both.filter((r) => Number(r[4]) > Number(r[3]));
  const missing = got.length - both.length;
  if (!both.length) return decline(`None of the ${got.length} city agencies with ${fmt(sp.minCount)} or more sworn officers in ${sp.year} has a sworn officer count for ${sp.later} in Crime Index.`);
  const percent = Math.round((gained.length / both.length) * 1000) / 10;
  const title = `Share of City Police Departments With ${fmt(sp.minCount)} or More Sworn Officers in ${sp.year} That Gained Officers in ${sp.later}`;
  const text = [title, `${gained.length} of ${both.length} city police departments with ${fmt(sp.minCount)} or more sworn officers in ${sp.year} had more sworn officers in ${sp.later}: ${percent} percent.`,
    ...(missing ? [`${missing} further ${missing === 1 ? "department has" : "departments have"} no sworn officer count for ${sp.later} in Crime Index and ${missing === 1 ? "is" : "are"} left out of both figures.`] : []),
    `Gained means more sworn officers in ${sp.later} than in ${sp.year} in Crime Index's counts.`, "Cities are Crime Index's city agencies, whatever the agency.", SRS_SOURCE];
  const columns: Cols = [statCol(0, `Departments with ${fmt(sp.minCount)} or more sworn officers in ${sp.year}`), statCol(1, `Gained officers in ${sp.later}`), statCol(2, "Share (percent)")];
  return wrap("officers", sp.year, [sp.year, sp.later], columns, [[both.length, gained.length, percent]], text, "share", build,
    both.map((r) => ({ ori: String(r[0]), label: `${String(r[1])}, ${String(r[2])}`, name: `${String(r[1])}, ${String(r[2])}`, state: String(r[2]) })), "sworn officer");
}

function scatterForm(sp: Extract<StaffSetQuestion, { form: "scatter" }>, build: HistoricalBuild, execute: (sql: string) => unknown[][], file: string): HistoricalAnswer | HistoricalDecline {
  if (yearOutside(build, [sp.year]) !== undefined) return decline(outsideSentence(build, sp.year));
  const crime = sq(`${build.root}/agency_crime.parquet`);
  const got = execute(`SELECT s.ori, ${cityNameSql("s")}, s.state, s.population, c.violent_total, c.violent_capita, s.officer_total, s.officer_capita FROM read_parquet(${file}) s `
    + `JOIN read_parquet(${crime}) c ON c.ori = s.ori AND c.year = s.year WHERE ${citySql("s")} AND s.year = ${sp.year} AND s.population >= ${sp.minPopulation} ORDER BY s.ori`);
  const rows = got.map((r) => ({ ori: String(r[0]), name: `${String(r[1])}, ${String(r[2])}`, state: String(r[2]),
    violent: historicalRate(num(r[5]), num(r[4]), num(r[3])).rate, officers: historicalRate(num(r[7]), num(r[6]), num(r[3])).rate }));
  const shown = rows.filter((r) => r.violent !== null && r.officers !== null).sort((a, b) => b.violent! - a.violent! || a.name.localeCompare(b.name));
  if (!shown.length) return decline(`Crime Index has no city agency of ${fmt(sp.minPopulation)} or more people with both a violent crime rate and a sworn officer rate for ${sp.year}.`);
  const left = rows.length - shown.length;
  const text = [`Violent Crime Rate and Sworn Officers per 100,000 by City, Population ${fmt(sp.minPopulation)} or More, ${sp.year}`,
    `${shown.length} cities of ${fmt(sp.minPopulation)} or more people are shown with their violent crime rate and sworn officers, each per 100,000 of the agency's population as published by Crime Index.`,
    "A scatter plot isn't drawn here; the table gives the two figures for each city, ordered by violent crime rate.",
    ...(left ? [`${left} city ${left === 1 ? "agency isn't" : "agencies aren't"} shown because Crime Index has no figure for one of the two in ${sp.year}.`] : []),
    "Cities are Crime Index's city agencies, whatever the agency.", SRS_SOURCE];
  const columns: Cols = [nameCol("Agency"), statCol(0, "Violent crime per 100,000"), statCol(1, "Sworn officers per 100,000")];
  return wrap("officers", sp.year, [sp.year], columns, shown.map((r) => [r.name, r.violent, r.officers]), text, "rate", build,
    shown.map((r) => ({ ori: r.ori, label: r.name, name: r.name, state: r.state })), "sworn officer", "each agency's population as published by Crime Index, per 100,000");
}
