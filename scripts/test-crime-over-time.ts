/**
 * Crime in a place over time (lib/nibrs-shadow/crime-over-time.ts): the composite of the nine per-measure answers, offline.
 * One place by year; several places side by side (Crime Index) and long (Current Trends); a rate (no Part I column); a blank
 * cell kept blank (the legacy rape gap), never a decline; notes said once or merged; anything that is not nine series of one
 * source for the same places is null (the question keeps its path); every cell blank is "none"; the chart's table-only columns.
 */
import assert from "node:assert/strict";
import { chartOptionsOf } from "../lib/answer-contract/contract";
import { COMPOSITE_PARTS, COMPOSITE_SEVERAL_NOTE, COMPOSITE_TABLE_ONLY, COMPOSITE_TABLE_ONLY_SEVERAL, composeCrimeOverTime, isComposite, type PartAnswer } from "../lib/nibrs-shadow/crime-over-time";

const YEAR = { binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true } as const;
const MONTH = { binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true } as const;
const NAMES: Record<string, string> = { violent_crime: "Violent Crimes", property_crime: "Property Crimes", murder: "Murders", rape: "Rapes", robbery: "Robberies",
  aggravated_assault: "Aggravated Assaults", burglary: "Burglaries", theft: "Larceny-thefts", motor_vehicle_theft: "Motor Vehicle Thefts" };
/** One per-measure answer: one place, a value per period from `values(i)` (i = the measure's index). */
const one = (kind: string, period: typeof YEAR | typeof MONTH, periods: string[], value: (m: number, p: number) => number | null, text: (m: string) => string[] = () => [], rate = false) =>
  COMPOSITE_PARTS.map((part, m): PartAnswer => ({
    kind, question: { place: { label: "Memphis, Tennessee" } }, meaning: { measures: [{ name: part.measure }] },
    delivered: { table: { columns: [period, { binding: { kind: "statistic", as: "x" }, header: rate ? `${NAMES[part.measure]} per 100,000` : NAMES[part.measure] }], rows: periods.map((p, i) => [p, value(m, i)]) },
      text: [`Memphis, Tennessee ${NAMES[part.measure]}${rate ? " Rate" : ""} Per ${period === YEAR ? "Year" : "Month"}, ${periods[0]}-${periods[periods.length - 1]}`, ...text(part.measure), "Source: Crime Index."] },
  }));

// One place by year: Part I is violent plus property; blank when either is; a blank rape cell stays blank.
{
  const parts = one("historical", YEAR, ["2023", "2024"], (m, p) => (m === 3 && p === 0 ? null : m === 1 && p === 1 ? null : 10 * (m + 1) + p),
    (m) => (m === "rape" ? ["Crime Index has no rape figure for Memphis, Tennessee in 2023, shown blank."] : m === "property_crime" ? ["Crime Index has no property crime figure for Memphis, Tennessee in 2024, shown blank."] : []));
  const c = composeCrimeOverTime(parts, false);
  assert.ok(c && c.kind === "historical", JSON.stringify(c));
  const t = (c as PartAnswer).delivered;
  assert.deepEqual(t.table.columns.map((x) => x.header), ["Year", "Violent crime", "Property crime", "Part I crime", "Murder", "Rape", "Robbery", "Aggravated assault", "Burglary", "Larceny-theft", "Motor vehicle theft"]);
  assert.deepEqual(t.table.rows, [["2023", 10, 20, 30, 30, null, 50, 60, 70, 80, 90], ["2024", 11, null, null, 31, 41, 51, 61, 71, 81, 91]]);
  // Notes in column order.
  assert.deepEqual(t.text, ["Memphis, Tennessee Violent and Property Crime Per Year, 2023-2024", "Crime Index has no property crime figure for Memphis, Tennessee in 2024, shown blank.",
    "Crime Index has no rape figure for Memphis, Tennessee in 2023, shown blank.", "Source: Crime Index."]);
  assert.equal((c as PartAnswer).meaning.measures.length, 9);
  assert.ok(isComposite(t.table));
  // The chart: violent and property crime only.
  assert.deepEqual(chartOptionsOf(t.table, [], COMPOSITE_TABLE_ONLY).columns, ["Violent crime", "Property crime"]);
}
// Notes: a line every answer has is said once; blank lines for the same place and year are one line naming the crimes; all nine: no names.
{
  const blank = (m: string, y: string) => `Crime Index has no ${m.replace(/_/g, " ")} figure for Memphis, Tennessee in ${y}, shown blank.`;
  const parts = one("historical", YEAR, ["1951", "1952", "1953"], (m, p) => (p === 1 || (p === 2 && m < 2) ? null : 5),
    (m) => ["Figures for the Memphis Police Department.", blank(m, "1952"), ...(["violent_crime", "property_crime"].includes(m) ? [blank(m, "1953")] : [])]);
  const t = (composeCrimeOverTime(parts, false) as PartAnswer).delivered.text;
  assert.deepEqual(t, ["Memphis, Tennessee Violent and Property Crime Per Year, 1951-1953", "Figures for the Memphis Police Department.",
    "Crime Index has no figures for Memphis, Tennessee in 1952, shown blank.", "Crime Index has no violent crime and property crime figures for Memphis, Tennessee in 1953, shown blank.", "Source: Crime Index."]);
}
// A line that differs between columns and names no crime is prefixed with its column.
{
  const parts = one("current", MONTH, ["2026-07", "2026-08"], (m, p) => (m === 0 && p === 1 ? null : 1), (m) => (m === "violent_crime" ? ["No figure is available for August 2026: shown blank, not zero."] : []));
  const t = (composeCrimeOverTime(parts, false) as PartAnswer).delivered.text;
  assert.deepEqual(t.slice(1, -1), ["Violent crime: No figure is available for August 2026: shown blank, not zero."]);
  assert.equal(t[0], "Memphis, Tennessee Violent and Property Crime Per Month, 2026-07-2026-08");
}
// A rate: no Part I column (Engine 2.0 2026-11-21: summed rounded rates are not the Part I rate); headers per 100,000.
{
  const c = composeCrimeOverTime(one("srs", YEAR, ["2024"], () => 1.5, () => [], true), true) as PartAnswer;
  assert.deepEqual(c.delivered.table.columns.map((x) => x.header).slice(0, 4), ["Year", "Violent crime per 100,000", "Property crime per 100,000", "Murder per 100,000"]);
  assert.ok(!c.delivered.table.columns.some((x) => x.binding.kind === "statistic" && x.binding.as === "part_one"));
  assert.equal(c.delivered.table.rows[0].length, 10);
  assert.equal(c.delivered.text[0], "Memphis, Tennessee Violent and Property Crime Rate Per Year, 2024-2024");
}
// Several places by year, side by side (Crime Index x.<i>): Place, then Year; the chart is violent crime only, with its note.
{
  const parts = COMPOSITE_PARTS.map((part, m): PartAnswer => ({ kind: "historical", question: { agencies: [{ name: "Houston", label: "Houston, Texas" }, { name: "Dallas", label: "Dallas, Texas" }] },
    meaning: { measures: [{ name: part.measure }] },
    delivered: { table: { columns: [YEAR, { binding: { kind: "statistic", as: "x.0" }, header: `Houston, Texas: ${NAMES[part.measure].toLowerCase()}` }, { binding: { kind: "statistic", as: "x.1" }, header: `Dallas, Texas: ${NAMES[part.measure].toLowerCase()}` }],
      rows: [["2024", m + 1, m + 100]] }, text: [`Houston, Texas and Dallas, Texas ${NAMES[part.measure]} Per Year, 2024`, "Source: Crime Index."] } }));
  const c = composeCrimeOverTime(parts, false) as PartAnswer;
  assert.deepEqual(c.delivered.table.columns.slice(0, 3).map((x) => x.header), ["Place", "Year", "Violent crime"]);
  assert.deepEqual(c.delivered.table.rows, [["Houston", "2024", 1, 2, 3, 3, 4, 5, 6, 7, 8, 9], ["Dallas", "2024", 100, 101, 201, 102, 103, 104, 105, 106, 107, 108]]);
  assert.deepEqual(c.delivered.text, ["Houston, Texas and Dallas, Texas Violent and Property Crime Per Year, 2024", COMPOSITE_SEVERAL_NOTE, "Source: Crime Index."]);
  assert.deepEqual(chartOptionsOf(c.delivered.table, [], COMPOSITE_TABLE_ONLY_SEVERAL).columns, ["Violent crime"]);
}
// Several places by month, long (Current Trends: Place, Month, value).
{
  const PLACE = { binding: { kind: "grouping", dimension: "geo.agency" }, header: "Place" } as const;
  const parts = COMPOSITE_PARTS.map((part, m): PartAnswer => ({ kind: "current", meaning: { measures: [{ name: part.measure }] },
    delivered: { table: { columns: [PLACE, MONTH, { binding: { kind: "statistic", as: "x" }, header: NAMES[part.measure] }], rows: [["Houston", "2026-01", m], ["Dallas", "2026-01", m === 4 ? null : 2 * m]] },
      text: [`Houston, Texas and Dallas, Texas ${NAMES[part.measure]} Per Month, Jan 2026`, "Source: Crime Index."] } }));
  const c = composeCrimeOverTime(parts, false) as PartAnswer;
  assert.deepEqual(c.delivered.table.rows, [["Houston", "2026-01", 0, 1, 1, 2, 3, 4, 5, 6, 7, 8], ["Dallas", "2026-01", 0, 2, 2, 4, 6, null, 10, 12, 14, 16]]);
}
// Not one source, not the same places, not a series, or not nine answers: null (the question keeps its path).
{
  const base = one("historical", YEAR, ["2024"], () => 1);
  assert.equal(composeCrimeOverTime([...base.slice(0, 8), { ...base[8], kind: "srs" }], false), null, "two sources");
  assert.equal(composeCrimeOverTime([...base.slice(0, 8), one("current", MONTH, ["2024-01"], () => 1)[8]], false), null, "two grains");
  assert.equal(composeCrimeOverTime(base.slice(0, 8), false), null, "eight answers");
  const total = { ...base[2], delivered: { table: { columns: [{ binding: { kind: "statistic", as: "x" }, header: "Murders" }], rows: [[3]] }, text: ["Memphis had 3 murders in 2024."] } } as PartAnswer;
  assert.equal(composeCrimeOverTime([...base.slice(0, 2), total, ...base.slice(3)], false), null, "a total, not a series");
  const noTitle = one("historical", YEAR, ["2024"], () => 1).map((a, i) => (i === 0 ? { ...a, delivered: { ...a.delivered, text: ["Something else", "Source: Crime Index."] } } : a));
  assert.equal(composeCrimeOverTime(noTitle, false), null, "a title that does not name violent crime");
  const twice = one("historical", YEAR, ["2023", "2024", "2024"], () => 1);
  assert.equal(composeCrimeOverTime(twice, false), null, "a year twice is never one cell silently");
}
// Every cell blank: none, with the place.
{
  const c = composeCrimeOverTime(one("current", MONTH, ["2026-01"], () => null), false);
  assert.deepEqual(c, { kind: "none", label: "Memphis, Tennessee" });
}
console.log("crime over time: nine answers of one source become one table; anything else keeps its path");
