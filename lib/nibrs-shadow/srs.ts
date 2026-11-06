/**
 * Part I offenses for a state or the nation, completed years (P53): read from the Crime Index snapshot's historical
 * file (scripts/fixtures/nibrs-shadow/crimeindex, byte-pinned to nibrs-model's manifest, snapshot 20261030), never
 * summed from NIBRS agencies and never spliced with another source (P14). The national clearance rate comes from the
 * snapshot's historical clearances (P57); there is no state clearance rate (P18). Answers end "Source: Crime Index." (P77, amending P63).
 *
 * The file has the seven offenses' totals, year-over-year change and rates per 100,000 (its "capita" columns) for each
 * state and the nation, 1960-2025, and its own violent and property sums, which are read as given, never re-added.
 */
import fs from "node:fs";
import path from "node:path";
import type { Meaning } from "../answer-eval/case";
import type { ResultTable } from "../nibrs-plan/result";
import { pct1 } from "../nibrs-plan/transforms";
import { fmt, periodWords, SRS_SOURCE } from "./deliver";
import { stateName } from "./places";

// From the working directory (the repository root): a Next bundle has no source __dirname.
const DIR = path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/crimeindex");
type Row = Record<string, string>;
function readCsv(file: string): Row[] {
  const [head, ...lines] = fs.readFileSync(path.join(DIR, file), "utf8").trim().split("\n");
  const cols = head.split(",");
  // The file's names have no commas (states and "United States"), so a plain split is exact.
  return lines.map((l) => Object.fromEntries(l.split(",").map((v, i) => [cols[i], v])));
}
let CRIME: Row[] | null = null, CLEAR: Row[] | null = null;
const crime = () => (CRIME ??= readCsv("historical_crime_states_nation_1960-2025.csv"));
const clearances = () => (CLEAR ??= readCsv("historical_clearances_states_nation_1960-2025.csv"));
export const SRS_YEARS = { first: 1960, last: 2025 };

/** The reader's Part I measures -> the file's column stem, the words for a count, and the label schema's name and unit. */
export const SRS_MEASURE: Record<string, { col: string; words: string; name: string; unit: string }> = {
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
export const isSrsMeasure = (m: string) => m in SRS_MEASURE;

export type SrsPlace = { kind: "state"; code: string } | { kind: "national" };
export type SrsQuestion = {
  measure: string; place: SrsPlace; from: number; to: number; byYear: boolean;
  /** Several states or the nation side by side (answerSrsSeveral); `place` is then the first. */
  places?: SrsPlace[];
  statistic: "count" | "rate" | "clearance_rate"; comparison: { earlier: number; later: number } | null;
  /** Lines after the title (a span reaching this year names it as Current Trends'). */
  notes?: string[];
};
/** A Part I answer from the historical file: the table, its text, its meaning in the labels' terms, and what it read. */
export type SrsAnswer = {
  kind: "srs"; meaning: Meaning; period: { from: string; to: string };
  /** The question answered, for its presentation (lib/answer-contract). */
  question: SrsQuestion;
  delivered: { table: ResultTable; text: string[] };
  /** Provenance: the file and column read and the rows used (uid), so a total is shown to be the file's, not re-added. */
  read: { file: string; column: string; uids: string[] };
};
export type SrsDecline = { kind: "srs-decline"; explanation: string };

const placeName = (p: SrsPlace) => (p.kind === "national" ? "United States" : stateName(p.code));
const placeOf = (p: SrsPlace): Meaning["places"][number] => (p.kind === "national" ? { kind: "national", name: "United States" } : { kind: "state", name: stateName(p.code), state: p.code });
const rowFor = (rows: Row[], p: SrsPlace, year: number) =>
  rows.find((r) => Number(r.year) === year && (p.kind === "national" ? r.type === "nation" : r.type === "state" && r.id === p.code.toLowerCase()));
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const yearsWords = (a: number, b: number) => (a === b ? String(a) : `${a} through ${b}`);

export function answerSrs(q: SrsQuestion): SrsAnswer | SrsDecline {
  const m = SRS_MEASURE[q.measure];
  const where = placeName(q.place);
  const level = q.place.kind === "national" ? "National" : "State";
  // D04, P14: the covered part of the span, the rest named; nothing covered: declined, the range named.
  const wanted = range(q.from, q.to);
  const covered = wanted.filter((y) => y >= SRS_YEARS.first && y <= SRS_YEARS.last);
  const outside = wanted.filter((y) => !covered.includes(y));
  const span = `${level} figures in the data cover ${SRS_YEARS.first} through ${SRS_YEARS.last}`;
  if (!covered.length) return { kind: "srs-decline", explanation: `${span}, so ${yearsWords(q.from, q.to)} ${q.from === q.to ? "is" : "are"} outside them.` };

  // P57: the national clearance rate, from the historical clearances (the file states it as a percent).
  if (q.statistic === "clearance_rate") {
    if (q.place.kind !== "national") return { kind: "srs-decline", explanation: "There is no state clearance rate in the data: the FBI publishes clearance for agencies and the nation, not states, and a figure from the reporting agencies is not a state rate." };
    if (covered.length !== 1 || q.byYear) return { kind: "srs-decline", explanation: "This isn't available yet: national clearance rates for more than one year." };
    const y = covered[0], col = `${m.col}_cleared_rate`, row = rowFor(clearances(), q.place, y);
    const v = row?.[col] ? Number(row[col]) : null;
    if (v === null) return { kind: "srs-decline", explanation: `The data has no national ${m.name} clearance rate for ${y}.` };
    return {
      kind: "srs", question: q, period: { from: `${y}-01`, to: `${y}-12` },
      meaning: { source: "historical", places: [placeOf(q.place)], period: { from: `${y}-01`, to: `${y}-12` }, measures: [{ name: `${m.name} cleared`, unit: "offense" }], filters: [], groupings: [], statistic: "rate", denominator: `${m.words}, per 100` },
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "clearance_rate" }, header: `${m.words[0].toUpperCase()}${m.words.slice(1)} cleared (%)` }], rows: [[v]] },
        text: [`${where}: ${v}% of ${m.words} were cleared in ${y}.`, SRS_SOURCE] },
      read: { file: "historical_clearances_states_nation_1960-2025.csv", column: col, uids: [row!.uid] },
    };
  }

  const col = `${m.col}_${q.statistic === "rate" ? "capita" : "total"}`;
  const rows = covered.map((y) => ({ y, row: rowFor(crime(), q.place, y) }));
  const value = (r: Row | undefined) => (r && r[col] !== "" ? Number(r[col]) : null);
  const uids = rows.flatMap((r) => (r.row ? [r.row.uid] : []));
  const missingLine = [...(outside.length ? [`${span}; ${yearsWords(outside[0], outside[outside.length - 1])} ${outside.length > 1 ? "are" : "is"} outside them.`] : []), ...(q.notes ?? [])];
  const meaningBase = { source: "historical" as const, places: [placeOf(q.place)], measures: [{ name: m.name, unit: m.unit }], filters: [] as string[] };
  const read = { file: "historical_crime_states_nation_1960-2025.csv", column: col, uids };
  const header = `${m.words[0].toUpperCase()}${m.words.slice(1)}${q.statistic === "rate" ? " per 100,000" : ""}`;

  // A change (P54): the earlier and later years, the change and percent change (P55: none from a zero base).
  if (q.comparison && q.statistic === "count") {
    const [E, L] = [q.comparison.earlier, q.comparison.later];
    const e = value(rowFor(crime(), q.place, E)), l = value(rowFor(crime(), q.place, L));
    if (e === null || l === null) return { kind: "srs-decline", explanation: `The data has no ${m.words} for ${where} in ${e === null ? E : L}.` };
    const change = l - e, pct = e === 0 ? null : pct1(change, e);
    const signed = (n: number) => (n > 0 ? `+${fmt(n)}` : n < 0 ? `-${fmt(-n)}` : "0");
    const text = [`${where}: ${m.words}, ${E} against ${L}.`,
      `${fmt(e)} in ${E} and ${fmt(l)} in ${L}: a change of ${signed(change)}${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""}.`,
      ...(pct === null ? ["The percent change cannot be computed from a zero base."] : []), SRS_SOURCE];
    return {
      kind: "srs", question: q, period: { from: `${E}-01`, to: `${L}-12` },
      meaning: { ...meaningBase, period: { from: `${E}-01`, to: `${L}-12` }, groupings: [], statistic: "change" },
      delivered: { table: { columns: ["earlier", "later", "change", "pct_change"].map((k) => ({ binding: { kind: "statistic" as const, as: `x.${k}` }, header: k === "earlier" ? String(E) : k === "later" ? String(L) : k === "change" ? "Change" : "Percent change" })),
        rows: [[e, l, change, pct]] }, text },
      read: { ...read, uids: [rowFor(crime(), q.place, E)!.uid, rowFor(crime(), q.place, L)!.uid] },
    };
  }

  const period = { from: `${covered[0]}-01`, to: `${covered[covered.length - 1]}-12` };
  if (q.byYear || covered.length > 1) {
    const text = [`${where}: ${m.words}${q.statistic === "rate" ? " per 100,000" : ""} by year, ${periodWords(period.from, period.to)}.`, ...missingLine, SRS_SOURCE];
    return {
      kind: "srs", question: q, period,
      meaning: { ...meaningBase, period, groupings: ["year"], statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's residents, per 100,000" } : {}) },
      delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true }, { binding: { kind: "statistic", as: "x" }, header }], rows: rows.map((r) => [String(r.y), value(r.row)]) }, text },
      read,
    };
  }
  const v = value(rows[0].row);
  if (v === null) return { kind: "srs-decline", explanation: `The data has no ${m.words} for ${where} in ${covered[0]}.` };
  const text = [q.statistic === "rate" ? `${where}: ${v} ${m.words} per 100,000 in ${covered[0]}.` : `${where}: ${fmt(v)} ${m.words} in ${covered[0]}.`, ...missingLine, SRS_SOURCE];
  return {
    kind: "srs", question: q, period,
    meaning: { ...meaningBase, period, groupings: [], statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's residents, per 100,000" } : {}) },
    delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header }], rows: [[v]] }, text },
    read,
  };
}

/**
 * Several states, or states and the nation, side by side by year, one column each, never combined ("california vs.
 * texas violent crime rate per year", "Louisiana vs US murder rate": bad-decline audit root cause 3, 2026-11-06), as
 * several agencies are (historical.ts). A count or a rate only; a change or a clearance rate is asked one place at a time.
 */
export function answerSrsSeveral(q: Omit<SrsQuestion, "place">, places: SrsPlace[]): SrsAnswer | SrsDecline {
  const m = SRS_MEASURE[q.measure];
  if (q.comparison || q.statistic === "clearance_rate")
    return { kind: "srs-decline", explanation: `This isn't available yet: ${q.comparison ? "a change" : "a clearance rate"} for more than one state or the nation. Ask for one place.` };
  const wanted = range(q.from, q.to);
  const covered = wanted.filter((y) => y >= SRS_YEARS.first && y <= SRS_YEARS.last);
  const outside = wanted.filter((y) => !covered.includes(y));
  const span = `State and national figures in the data cover ${SRS_YEARS.first} through ${SRS_YEARS.last}`;
  if (!covered.length) return { kind: "srs-decline", explanation: `${span}, so ${yearsWords(q.from, q.to)} ${q.from === q.to ? "is" : "are"} outside them.` };
  const col = `${m.col}_${q.statistic === "rate" ? "capita" : "total"}`;
  const value = (p: SrsPlace, y: number) => { const r = rowFor(crime(), p, y); return r && r[col] !== "" ? Number(r[col]) : null; };
  const where = places.map(placeName).join(" and ");
  const header = `${m.words}${q.statistic === "rate" ? " per 100,000" : ""}`;
  const period = { from: `${covered[0]}-01`, to: `${covered[covered.length - 1]}-12` };
  const columns: ResultTable["columns"] = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
    ...places.map((p, i) => ({ binding: { kind: "statistic" as const, as: `x.${i}` }, header: `${placeName(p)}: ${header}` }))];
  const rows = covered.map((y) => [String(y), ...places.map((p) => value(p, y))]);
  const missingLine = [...(outside.length ? [`${span}; ${yearsWords(outside[0], outside[outside.length - 1])} ${outside.length > 1 ? "are" : "is"} outside them.`] : []), ...(q.notes ?? [])];
  const text = [covered.length > 1 ? `${where}: ${header} by year, ${periodWords(period.from, period.to)}.` : `${where}: ${header} in ${covered[0]}.`, ...missingLine, SRS_SOURCE];
  return {
    kind: "srs", question: { ...q, place: places[0], places }, period,
    meaning: { source: "historical", places: places.map(placeOf), measures: [{ name: m.name, unit: m.unit }], filters: [], period, groupings: ["year"],
      statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's residents, per 100,000" } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { file: "historical_crime_states_nation_1960-2025.csv", column: col, uids: places.flatMap((p) => covered.flatMap((y) => { const r = rowFor(crime(), p, y); return r ? [r.uid] : []; })) },
  };
}

/** The Crime Index population of a state or the nation for a year (coverage's denominator, P61's note); null when absent. */
export function srsPopulation(p: SrsPlace, year: number): number | null {
  const r = rowFor(crime(), p, year);
  return r && r.population !== "" ? Number(r.population) : null;
}
