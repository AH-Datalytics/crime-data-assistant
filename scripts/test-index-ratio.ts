/**
 * P206 indexed series and P207 ratio of two crimes (lib/nibrs-shadow/indexed-series.ts, crime-ratios.ts), offline: the wording read,
 * the index and the ratio computed from stand-in series answers, blanks and zeros handled, and anything that is not a series of one
 * source left as null (the question keeps its path).
 */
import assert from "node:assert/strict";
import { composeIndexed, readIndexed } from "../lib/nibrs-shadow/indexed-series";
import { composeRatios, readRatios } from "../lib/nibrs-shadow/crime-ratios";
import type { PartAnswer } from "../lib/nibrs-shadow/crime-over-time";

const YEAR = { binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true } as const;
const MONTH = { binding: { kind: "grouping", dimension: "time.month" }, header: "Month", ordered: true } as const;
const stat = (header: string, as = "x") => ({ binding: { kind: "statistic", as }, header }) as const;
const answer = (title: string, cols: unknown[], rows: unknown[][], extra: string[] = [], kind = "historical"): PartAnswer =>
  ({ kind, question: {}, meaning: { measures: [{}] }, delivered: { table: { columns: cols, rows }, text: [title, ...extra, "Source: Crime Index."] } }) as never;

// --- Reading the index words.
assert.deepEqual(readIndexed("murders in Chicago by year indexed to 100 in 2018"), { plain: "murders in Chicago by year", base: "2018" });
assert.deepEqual(readIndexed("murders in Chicago, indexed to 2019"), { plain: "murders in Chicago", base: "2019" });
assert.deepEqual(readIndexed("compare murders in Baltimore and the nation both indexed to the earliest date you have"), { plain: "compare murders in Baltimore and the nation", base: "earliest" });
assert.equal(readIndexed("murders in Chicago by year"), null);
// Jeff 2026-11-22: "benchmarked to <year> levels" is the index, the loose "(i.e., ...)" after it taken out with it.
assert.deepEqual(readIndexed("can you plot murders benchmarked to 2021 levels (i.e., % change year over year) for the cities A and B?"), { plain: "can you plot murders for the cities A and B?", base: "2021" });
assert.deepEqual(readIndexed("murders in Chicago benchmarked to 2019"), { plain: "murders in Chicago", base: "2019" });

// --- One place: index = value / base x 100, one decimal; raw figure beside it; the line; the title.
{
  const a = answer("Chicago, Illinois Murders Per Year, 2017-2019", [YEAR, stat("Murders")], [["2017", 650], ["2018", 500], ["2019", 600]], ["Figures for the Chicago Police Department."]);
  const r = composeIndexed(a, "2018", false)!;
  assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Year", "Murders", "Index (2018 = 100)"]);
  assert.deepEqual(r.delivered.table.rows, [["2017", 650, 130], ["2018", 500, 100], ["2019", 600, 120]]);
  assert.deepEqual(r.delivered.text, ["Chicago, Illinois Murders Per Year, 2017-2019, Indexed to 100 in 2018", "Figures for the Chicago Police Department.",
    "Each place's figure divided by its own 2018 figure, times 100.", "Source: Crime Index."]);
}
// --- Several places side by side; a place with a zero base has no index and a line says so; the earliest date is the first period every place has.
{
  const cols = [YEAR, stat("A: murders", "x.0"), stat("B: murders", "x.1")];
  const a = answer("A and B Murders Per Year, 2016-2018", cols, [["2016", null, 10], ["2017", 0, 12], ["2018", 5, 15]]);
  const e = composeIndexed(a, "earliest", false)!;
  // 2016 has no figure for A, so the base is 2017, where A is zero: A has no index; B's index is 100 at 2017.
  assert.deepEqual(e.delivered.table.rows, [["2016", null, null, 10, 83.3], ["2017", 0, null, 12, 100], ["2018", 5, null, 15, 125]]);
  assert.ok(e.delivered.text.includes("A has no 2017 figure, so no index."));
  assert.equal(composeIndexed(answer("t", cols, [["2017", 0, 0]]), "2017", false), null);   // nothing to index
}
// --- A rolling monthly series is indexed to the December of the year named; plain months and other tables are not series this indexes.
{
  const a = answer("X Murders Rolling Over 12 Months", [MONTH, stat("Murders")], [["2018-11", 90], ["2018-12", 100], ["2019-01", 110]], [], "current");
  const r = composeIndexed(a, "2018", true)!;
  assert.deepEqual(r.delivered.table.rows.map((x) => x[2]), [90, 100, 110]);
  assert.equal(composeIndexed(a, "2018", false), null);
  assert.equal(composeIndexed(answer("t", [stat("a"), stat("b")], [[1, 2]]), "2018", false), null);
  assert.equal(composeIndexed(answer("t", [YEAR, stat("v")], [["2017", 1]]), "2018", false), null);   // the base year has no row
}

// --- Reading ratios.
{
  const r = readRatios("Can you return the murder-to-robbery, robbery-to-aggravated assault, and murder-to-assault ratios for Memphis for the years 2010 to 2025?")!;
  assert.deepEqual(r.pairs.map(([a, b]) => `${a.key}/${b.key}`), ["murder/robbery", "robbery/aggravated_assault", "murder/aggravated_assault"]);
  assert.deepEqual(r.crimes.map((c) => c.key), ["murder", "robbery", "aggravated_assault"]);
  assert.equal(r.withCrime(r.crimes[0]), "murders for Memphis by year from 2010 to 2025?".replace("for Memphis", "in Memphis"));
  assert.equal(readRatios("ratio of burglary to theft in Denver by year")!.pairs.length, 1);
  assert.equal(readRatios("murders in Memphis by year"), null);
  assert.equal(readRatios("murder-to-robbery rate in Memphis"), null);   // a rate is not a ratio of counts
  assert.equal(readRatios("murder-to-murder ratio in Memphis"), null);
}
// --- One place: A / B two decimals with both counts beside it; zero or blank denominators give no ratio and a line says so.
{
  const ask = readRatios("murder-to-robbery and murder-to-assault ratios for Memphis by year")!;
  const mk = (crime: string, vals: (number | null)[]) => answer(`Memphis, Tennessee ${crime} Per Year, 2020-2022`, [YEAR, stat(crime)], ["2020", "2021", "2022"].map((y, i) => [y, vals[i]]), ["Figures for the Memphis Police Department."]);
  const r = composeRatios(ask, [mk("Murders", [10, 20, null]), mk("Robberies", [100, 0, 50]), mk("Aggravated assaults", [40, 80, 20])])!;
  assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Year", "Murders", "Robberies", "Aggravated assaults", "Murder-to-robbery ratio", "Murder-to-aggravated assault ratio"]);
  assert.deepEqual(r.delivered.table.rows, [["2020", 10, 100, 40, 0.1, 0.25], ["2021", 20, 0, 80, null, 0.25], ["2022", null, 50, 20, null, null]]);
  assert.equal(r.delivered.text[0], "Memphis, Tennessee Murder-to-Robbery Ratio, Murder-to-Aggravated Assault Ratio Per Year, 2020-2022");
  assert.ok(r.delivered.text.includes("A ratio is blank where the second count is zero or either count is blank."));
  assert.equal(r.delivered.text[r.delivered.text.length - 1], "Source: Crime Index.");
  // Different sources are never joined (P14): a different source line is null.
  const other = mk("Robberies", [100, 0, 50]);
  other.delivered.text[other.delivered.text.length - 1] = "Source: NIBRS.";
  assert.equal(composeRatios(ask, [mk("Murders", [10, 20, 30]), other, mk("Aggravated assaults", [1, 2, 3])]), null);
  // Every ratio blank is not a table of ratios.
  assert.equal(composeRatios(ask, [mk("Murders", [null, null, null]), mk("Robberies", [1, 2, 3]), mk("Aggravated assaults", [1, 2, 3])]), null);
}
// --- Several places: long, Place then Year.
{
  const ask = readRatios("ratio of murder to robbery in A and B by year")!;
  const placed = (crime: string, a: number[], b: number[]) => answer(`A and B ${crime} Per Year, 2020-2021`, [YEAR, stat(`A: ${crime}`, "x.0"), stat(`B: ${crime}`, "x.1")], [["2020", a[0], b[0]], ["2021", a[1], b[1]]]);
  const withAgencies = (p: PartAnswer) => ({ ...p, question: { agencies: [{ name: "A" }, { name: "B" }] } }) as PartAnswer;
  const r = composeRatios(ask, [withAgencies(placed("Murders", [1, 2], [3, 6])), withAgencies(placed("Robberies", [10, 10], [12, 24]))])!;
  assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Place", "Year", "Murders", "Robberies", "Murder-to-robbery ratio"]);
  assert.deepEqual(r.delivered.table.rows, [["A", "2020", 1, 10, 0.1], ["A", "2021", 2, 10, 0.2], ["B", "2020", 3, 12, 0.25], ["B", "2021", 6, 24, 0.25]]);
}
console.log("test-index-ratio: ok");
