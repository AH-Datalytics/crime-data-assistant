/**
 * Population on its own (item 11, bad-decline audit 2026-11-06): an agency's, a state's or the nation's population for
 * a year or by year, several places side by side, never summed or estimated. As Crime Index publishes it: an agency's
 * from the build's agency_crime table (the population the agency covers), a state's and the nation's from the
 * historical file. A missing figure is blank and named, never zero.
 */
import type { Meaning } from "../answer-eval/case";
import type { ResultTable } from "../nibrs-plan/result";
import { fmt, periodWords, SRS_SOURCE } from "./deliver";
import type { HistoricalAgency, HistoricalAnswer, HistoricalBuild, HistoricalDecline } from "./historical";
import { stateName } from "./places";
import { srsPopulation, SRS_YEARS, type SrsPlace } from "./srs";

/** One place, in the order asked: an agency (the Crime Index build) or a state or the nation (the historical file). */
export type PopulationPlace = { agency: HistoricalAgency } | { geo: SrsPlace };

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const spans = (ys: number[]) => ys.reduce<[number, number][]>((out, y) => { const l = out[out.length - 1]; if (l && y === l[1] + 1) l[1] = y; else out.push([y, y]); return out; }, []);
const spanWords = (sp: [number, number][]) => {
  const w = sp.map(([x, y]) => (x === y ? String(x) : `${x} to ${y}`));
  return sp.length === 1 && sp[0][0] !== sp[0][1] ? `from ${w[0]}` : `in ${w.length > 1 ? `${w.slice(0, -1).join(", ")} and ${w[w.length - 1]}` : w[0]}`;
};

export function answerPopulation(places: PopulationPlace[], from: number, to: number, byYear: boolean, build: HistoricalBuild,
  execute: (sql: string) => unknown[][], extra: { agencyLine?: string; notes?: string[] } = {}): HistoricalAnswer | HistoricalDecline {
  const agencies = places.flatMap((p) => ("agency" in p ? [p.agency] : []));
  const geos = places.flatMap((p) => ("geo" in p ? [p.geo] : []));
  // The years either source holds, the rest named; none held: declined, the range named.
  const first = Math.min(...(agencies.length ? [build.firstYear] : []), ...(geos.length ? [SRS_YEARS.first] : []));
  const last = Math.max(...(agencies.length ? [build.lastYear] : []), ...(geos.length ? [SRS_YEARS.last] : []));
  const wanted = range(from, to), covered = wanted.filter((y) => y >= first && y <= last), outside = wanted.filter((y) => !covered.includes(y));
  const yearsWords = (a: number, b: number) => (a === b ? String(a) : `${a} through ${b}`);
  const span = `Population figures in the data cover ${first} through ${last}`;
  if (!covered.length) return { kind: "historical-decline", explanation: `${span}, so ${yearsWords(from, to)} ${from === to ? "is" : "are"} outside them.` };
  const got = agencies.length ? execute(`SELECT ori, year, population FROM read_parquet(${q(`${build.root}/agency_crime.parquet`)}) `
    + `WHERE ori IN (${agencies.map((a) => q(a.ori)).join(", ")}) AND year BETWEEN ${covered[0]} AND ${covered[covered.length - 1]} ORDER BY ori, year`) : [];
  const pop = new Map(got.map((r) => [`${r[0]}|${r[1]}`, r[2] === null || r[2] === undefined ? null : Number(r[2])]));
  const value = (p: PopulationPlace, y: number): number | null => ("agency" in p ? pop.get(`${p.agency.ori}|${y}`) ?? null : srsPopulation(p.geo, y));
  // A series starts at its first year with a figure for any place, as a crime series does.
  const firstFigure = covered.findIndex((y) => places.some((p) => value(p, y) !== null));
  if (firstFigure < 0) return { kind: "historical-decline", explanation: `Crime Index has no population for ${places.length > 1 ? "these places" : nameOf(places[0])} in ${yearsWords(covered[0], covered[covered.length - 1])}: not available in this data.` };
  const years = covered.slice(firstFigure);
  const names = places.map(nameOf);
  const said = places.map((p, i) => ("geo" in p && p.geo.kind === "national" ? "the United States" : names[i]));
  const joined = said.length > 2 ? `${said.slice(0, -1).join(", ")} and ${said[said.length - 1]}` : said.join(" and ");
  const where = `${joined[0].toUpperCase()}${joined.slice(1)}`;
  const blanks = places.flatMap((p, i) => {
    const miss = years.filter((y) => value(p, y) === null);
    return miss.length ? [`Crime Index has no population for ${names[i]} ${spanWords(spans(miss))}, shown blank.`] : [];
  });
  const lead = firstFigure > 0 ? [`Crime Index has no population for ${places.length > 1 ? "these places" : names[0]} ${spanWords(spans(covered.slice(0, firstFigure)))}, so the table starts in ${years[0]}.`] : [];
  const outsideLine = outside.length ? [`${span}; ${yearsWords(outside[0], outside[outside.length - 1])} ${outside.length > 1 ? "are" : "is"} outside them.`] : [];
  const agencyNote = agencies.length ? ["An agency's population is the population it covers, as Crime Index publishes it."] : [];
  const notes = [...(extra.agencyLine ? [extra.agencyLine] : []), ...lead, ...outsideLine, ...(extra.notes ?? []), ...blanks, ...agencyNote];
  const period = { from: `${years[0]}-01`, to: `${years[years.length - 1]}-12` };
  const several = places.length > 1;
  let columns: ResultTable["columns"], rows: (string | number | null)[][], title: string;
  if (!byYear && years.length === 1) {
    const y = years[0];
    if (several) {
      columns = [{ binding: { kind: "grouping", dimension: "geo.place" }, header: "Place" }, { binding: { kind: "statistic", as: "x" }, header: "Population" }];
      rows = places.map((p, i) => [names[i], value(p, y)]);
      title = `${where}: population in ${y}.`;
    } else {
      const v = value(places[0], y);
      columns = [{ binding: { kind: "statistic", as: "x" }, header: "Population" }];
      rows = [[v]];
      title = `${where}: population ${fmt(v!)} in ${y}.`;
    }
  } else {
    columns = [{ binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true },
      ...places.map((_, i) => ({ binding: { kind: "statistic" as const, as: several ? `x.${i}` : "x" }, header: several ? `${names[i]}: population` : "Population" }))];
    rows = years.map((y) => [String(y), ...places.map((p) => value(p, y))]);
    title = `${where}: population by year, ${periodWords(period.from, period.to)}.`;
  }
  const placeMeaning = (p: PopulationPlace): Meaning["places"][number] => ("agency" in p ? { kind: "agency", name: p.agency.name, ...(p.agency.state ? { state: p.agency.state } : {}) }
    : p.geo.kind === "national" ? { kind: "national", name: "United States" } : { kind: "state", name: stateName(p.geo.code), state: p.geo.code });
  return {
    kind: "historical", period,
    question: { measure: "population", agencies, from, to, byYear, statistic: "count", comparison: null, ...(geos.length ? { beside: geos } : {}), shown: names,
      ...(extra.agencyLine ? { agencyLine: extra.agencyLine } : {}) },
    meaning: { source: "historical", places: places.map(placeMeaning), filters: [], measures: [{ name: "population", unit: "person" }], period,
      groupings: [...(rows.length > 1 && columns[0].header === "Year" ? ["year"] : []), ...(several ? ["place"] : [])], statistic: "count" },
    delivered: { table: { columns, rows }, text: [title, ...notes, SRS_SOURCE] },
    read: { table: agencies.length ? `agency_crime${geos.length ? " + historical_crime_states_nation_1960-2025.csv" : ""}` : "historical_crime_states_nation_1960-2025.csv", column: "population", release: build.release },
  };
}

function nameOf(p: PopulationPlace): string {
  return "agency" in p ? p.agency.label : p.geo.kind === "national" ? "United States" : stateName(p.geo.code);
}
