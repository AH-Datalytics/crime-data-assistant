/**
 * Part I offenses for a state or the nation, completed years (P53): read from the Crime Index snapshot's historical
 * file (scripts/fixtures/nibrs-shadow/crimeindex, byte-pinned to nibrs-model's manifest, snapshot 20261030), never
 * summed from NIBRS agencies and never spliced with another source (P14). The national clearance rate comes from the
 * snapshot's historical clearances (P57); there is no state clearance rate (P18). Answers end "Source: Crime Index." (P77, amending P63).
 *
 * The file has the seven offenses' totals, year-over-year change and rates per 100,000 (its "capita" columns) for each
 * state and the nation, 1960-2025, and its own violent and property sums, which are read as given, never re-added.
 */
import { carriedPopulation } from "./population-carry";
import fs from "node:fs";
import path from "node:path";
import type { Meaning } from "../answer-eval/case";
import type { ResultTable } from "../nibrs-plan/result";
import { pct1 } from "../nibrs-plan/transforms";
import { fmt, periodWords, SRS_SOURCE } from "./deliver";
import { stateName } from "./places";
import { changeSentence, countSentence, nationSubject, rateChangeSentence, rateSentence, seriesTitle, stateSubject } from "./headline";
import { titleCase } from "./titles";

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
  homicide_all: { col: "murder", words: "murders", name: "murder", unit: "victim" },
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
  statistic: "count" | "rate" | "clearance_rate"; comparison: { earlier: number; later: number; change?: true } | null;
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
    if (q.place.kind !== "national") return { kind: "srs-decline", explanation: "A state clearance rate for several years at once isn't available. Ask for one year, for example \"Texas murder clearance rate in 2024\"." };
    // A change in a clearance rate is not computed here (Codex clearance review 01.1).
    if (q.comparison) return { kind: "srs-decline", explanation: "This isn't available: a change in a clearance rate. Ask for the clearance rate by year." };
    // By year (item 7: "National murder clearance rate since 1960"): the file's published percentage for each year; a
    // year with none is blank and named; years outside the file are named.
    if (covered.length !== 1 || q.byYear || wanted.length !== 1) {
      const col = `${m.col}_cleared_rate`;
      const rows = covered.map((y) => ({ y, row: rowFor(clearances(), q.place, y) }));
      const rate = (r: Row | undefined) => (r && r[col] !== "" ? Number(r[col]) : null);
      const miss = rows.filter((r) => rate(r.row) === null).map((r) => r.y);
      const period = { from: `${covered[0]}-01`, to: `${covered[covered.length - 1]}-12` };
      const spans = miss.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
      const missWords = spans.map(([a, b]) => (a === b ? String(a) : `${a} to ${b}`));
      const missLine = miss.length ? [`The data has no national ${m.name} clearance rate for ${missWords.length > 1 ? `${missWords.slice(0, -1).join(", ")} and ${missWords[missWords.length - 1]}` : missWords[0]}, shown blank.`] : [];
      // The years before and after the file named apart (Codex clearance review 01.2).
      const outsideWords = [outside.filter((y) => y < SRS_YEARS.first), outside.filter((y) => y > SRS_YEARS.last)].filter((ys) => ys.length).map((ys) => yearsWords(ys[0], ys[ys.length - 1])).join(" and ");
      const outsideLine = outside.length ? [`${span}; ${outsideWords} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
      return {
        kind: "srs", question: q, period,
        meaning: { source: "historical", places: [placeOf(q.place)], period, measures: [{ name: `${m.name} cleared`, unit: "offense" }], filters: [], groupings: ["year"], statistic: "rate", denominator: `${m.words}, per 100` },
        delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true }, { binding: { kind: "statistic", as: "clearance_rate" }, header: `${m.words[0].toUpperCase()}${m.words.slice(1)} cleared (%)` }],
          rows: rows.map((r) => [String(r.y), rate(r.row)]) },
          text: [seriesTitle(periodWords(period.from, period.to), `${m.words[0].toUpperCase()}${m.words.slice(1)} Cleared (%)`, "Year", where), ...outsideLine, ...(q.notes ?? []), ...missLine, SRS_SOURCE] },
        read: { file: "historical_clearances_states_nation_1960-2025.csv", column: col, uids: rows.flatMap((r) => (r.row ? [r.row.uid] : [])) },
      };
    }
    const y = covered[0], col = `${m.col}_cleared_rate`, row = rowFor(clearances(), q.place, y);
    const v = row?.[col] ? Number(row[col]) : null;
    if (v === null) return { kind: "srs-decline", explanation: `The data has no national ${m.name} clearance rate for ${y}.` };
    return {
      kind: "srs", question: q, period: { from: `${y}-01`, to: `${y}-12` },
      meaning: { source: "historical", places: [placeOf(q.place)], period: { from: `${y}-01`, to: `${y}-12` }, measures: [{ name: `${m.name} cleared`, unit: "offense" }], filters: [], groupings: [], statistic: "rate", denominator: `${m.words}, per 100` },
      delivered: { table: { columns: [{ binding: { kind: "statistic", as: "clearance_rate" }, header: `${m.words[0].toUpperCase()}${m.words.slice(1)} cleared (%)` }], rows: [[v]] },
        text: [`${(q.place.kind === "national" ? nationSubject : stateSubject(where)).text} cleared ${v}% of its ${m.words} in ${y}.`, SRS_SOURCE] },
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
  // A rate's change only when the change is asked in words ("2022 vs 2025" of a rate stays the two years side by side, as before).
  if (q.comparison && (q.statistic === "count" || q.comparison.change)) {
    const [E, L] = [q.comparison.earlier, q.comparison.later];
    const rate = q.statistic === "rate";
    const e = value(rowFor(crime(), q.place, E)), l = value(rowFor(crime(), q.place, L));
    if (e === null || l === null) return { kind: "srs-decline", explanation: `The data has no ${m.words}${rate ? " rate" : ""} for ${where} in ${e === null ? E : L}.` };
    // A rate's change is in points per 100,000, to one decimal; its percent change is on the published rates.
    const change = rate ? Math.round((l - e) * 10) / 10 : l - e, pct = e === 0 ? null : pct1(l - e, e);
    const shown = (n: number) => (rate ? String(n) : fmt(n));
    const signed = (n: number) => (n > 0 ? `+${shown(n)}` : n < 0 ? `-${shown(-n)}` : "0");
    const who = q.place.kind === "national" ? nationSubject : stateSubject(where);
    const text = [rate ? rateChangeSentence(who, m.name, shown(e), shown(l), String(E), String(L), signed(change), pct) : changeSentence(who, m.words, shown(e), shown(l), String(E), String(L), signed(change), pct),
      ...(pct === null ? ["The percent change cannot be computed from a zero base."] : []), SRS_SOURCE];
    return {
      kind: "srs", question: q, period: { from: `${E}-01`, to: `${L}-12` },
      meaning: { ...meaningBase, period: { from: `${E}-01`, to: `${L}-12` }, groupings: [], statistic: "change", ...(rate ? { denominator: "the state's population, per 100,000" } : {}) },
      delivered: { table: { columns: ["earlier", "later", "change", "pct_change"].map((k) => ({ binding: { kind: "statistic" as const, as: `x.${k}` }, header: k === "earlier" ? `${E}${rate ? ", per 100,000" : ""}` : k === "later" ? `${L}${rate ? ", per 100,000" : ""}` : k === "change" ? `Change${rate ? ", per 100,000" : ""}` : "Percent change" })),
        rows: [[e, l, change, pct]] }, text },
      read: { ...read, uids: [rowFor(crime(), q.place, E)!.uid, rowFor(crime(), q.place, L)!.uid] },
    };
  }

  const period = { from: `${covered[0]}-01`, to: `${covered[covered.length - 1]}-12` };
  if (q.byYear || covered.length > 1) {
    const text = [seriesTitle(periodWords(period.from, period.to), q.statistic === "rate" ? titleCase(`${m.name} rate`) : `${m.words[0].toUpperCase()}${m.words.slice(1)}`, "Year", where), ...missingLine, SRS_SOURCE];
    return {
      kind: "srs", question: q, period,
      meaning: { ...meaningBase, period, groupings: ["year"], statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's population, per 100,000" } : {}) },
      delivered: { table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true }, { binding: { kind: "statistic", as: "x" }, header }], rows: rows.map((r) => [String(r.y), value(r.row)]) }, text },
      read,
    };
  }
  const v = value(rows[0].row);
  if (v === null) return { kind: "srs-decline", explanation: `The data has no ${m.words} for ${where} in ${covered[0]}.` };
  const who = q.place.kind === "national" ? nationSubject : stateSubject(where);
  const text = [q.statistic === "rate" ? rateSentence(who, m.name, String(covered[0]), String(v)) : countSentence(who, fmt(v), m.words, String(covered[0])), ...missingLine, SRS_SOURCE];
  return {
    kind: "srs", question: q, period,
    meaning: { ...meaningBase, period, groupings: [], statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's population, per 100,000" } : {}) },
    delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header }], rows: [[v]] }, text },
    read,
  };
}

/**
 * The year the national rate was highest ("When was violent crime the highest?"): the maximum of the published national
 * rate series, its count beside it. A year with no published rate cannot win; a tie names every tied year.
 */
export function answerSrsPeak(measure: string, source: Row[] = crime()): SrsAnswer | SrsDecline {
  const m = SRS_MEASURE[measure];
  const place: SrsPlace = { kind: "national" };
  const rateCol = `${m.col}_capita`, totalCol = `${m.col}_total`;
  const years = range(SRS_YEARS.first, SRS_YEARS.last).map((y) => ({ y, row: rowFor(source, place, y) }))
    .filter((r) => r.row && r.row[rateCol] !== "" && Number.isFinite(Number(r.row[rateCol])));
  if (!years.length) return { kind: "srs-decline", explanation: `The data has no national ${m.name} rate.` };
  const top = Math.max(...years.map((r) => Number(r.row![rateCol])));
  const won = years.filter((r) => Number(r.row![rateCol]) === top);
  const count = (r: Row) => (r[totalCol] !== "" ? Number(r[totalCol]) : null);
  const period = { from: `${years[0].y}-01`, to: `${years[years.length - 1].y}-12` };
  const yearsList = won.map((r) => String(r.y));
  const when = yearsList.length > 1 ? `${yearsList.slice(0, -1).join(", ")} and ${yearsList[yearsList.length - 1]}` : yearsList[0];
  const n0 = count(won[0].row!);
  const sentence = `The national ${m.name} rate was highest in ${when}, at ${top} per 100,000${yearsList.length === 1 && n0 !== null ? `, with ${fmt(n0)} ${m.words}` : ""}.`;
  const cap = `${m.words[0].toUpperCase()}${m.words.slice(1)}`;
  return {
    kind: "srs", period,
    question: { measure, place, from: years[0].y, to: years[years.length - 1].y, byYear: false, statistic: "rate", comparison: null },
    meaning: { source: "historical", places: [placeOf(place)], period, measures: [{ name: m.name, unit: m.unit }], filters: [], groupings: ["year"], statistic: "rate", denominator: "the national population, per 100,000" },
    delivered: {
      table: { columns: [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true }, { binding: { kind: "statistic", as: "x" }, header: `${cap} per 100,000` }, { binding: { kind: "statistic", as: "count" }, header: cap }],
        rows: won.map((r) => [String(r.y), Number(r.row![rateCol]), count(r.row!)]) },
      text: [`United States ${titleCase(`${m.name} rate`)}, Peak Year`, sentence, `Compared over the published national series, ${years[0].y} through ${years[years.length - 1].y}; a year with no published rate is not counted.`, SRS_SOURCE],
    },
    read: { file: "historical_crime_states_nation_1960-2025.csv", column: rateCol, uids: won.map((r) => r.row!.uid) },
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
    return { kind: "srs-decline", explanation: `This isn't available: ${q.comparison ? "a change" : "a clearance rate"} for more than one state or the nation. Ask for one place.` };
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
  const what = q.statistic === "rate" ? titleCase(`${m.name} rate`) : `${m.words[0].toUpperCase()}${m.words.slice(1)}`;
  const text = [covered.length > 1 ? seriesTitle(periodWords(period.from, period.to), what, "Year", where) : seriesTitle(String(covered[0]), what, "Place", where), ...missingLine, SRS_SOURCE];
  return {
    kind: "srs", question: { ...q, place: places[0], places }, period,
    meaning: { source: "historical", places: places.map(placeOf), measures: [{ name: m.name, unit: m.unit }], filters: [], period, groupings: ["year"],
      statistic: q.statistic === "rate" ? "rate" : "count", ...(q.statistic === "rate" ? { denominator: "the state's population, per 100,000" } : {}) },
    delivered: { table: { columns, rows }, text },
    read: { file: "historical_crime_states_nation_1960-2025.csv", column: col, uids: places.flatMap((p) => covered.flatMap((y) => { const r = rowFor(crime(), p, y); return r ? [r.uid] : []; })) },
  };
}

/** The Crime Index population of a state or the nation for a year (coverage's denominator, P61's note); null when absent. */
export function srsPopulation(p: SrsPlace, year: number): number | null {
  const own = (y: number): number | null => { const r = rowFor(crime(), p, y); return r && r.population !== "" ? Number(r.population) : null; };
  // The current year takes the latest completed year's population until it is formally reported (population-carry.ts).
  return carriedPopulation(own, year, srsLastYear());
}
/** The latest completed year the state and national file holds, read from the file. */
const srsLastYear = () => crime().reduce((m, r) => Math.max(m, Number(r.year)), 0);
