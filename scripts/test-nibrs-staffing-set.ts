/**
 * Police staffing for sets of cities (Jeff 2026-11-23, rankings PR 2): the four closed forms, read from the question's own
 * words, answered from Crime Index's staffing tables. Offline: a stub executor stands in for DuckDB; its SQL is checked.
 */
import assert from "node:assert/strict";
import { answerStaffSet, parseStaffSet } from "../lib/nibrs-shadow/staffing-set";
import type { HistoricalBuild } from "../lib/nibrs-shadow/historical";
import { shadowAnswer } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const build: HistoricalBuild = { root: "/ci", release: "crimeindex-20261101", firstYear: 1930, lastYear: 2025, clearanceFirstYear: 1960 };

// The seven ids' questions, word for word.
assert.deepEqual(parseStaffSet("provide a list of every city that had 500 or more officers in 2019 and the number of officers that agency had in 2019, 2022, 2023,2024 and 2025"),
  { form: "list", minCount: 500, year: 2019, years: [2019, 2022, 2023, 2024, 2025] });
assert.deepEqual(parseStaffSet("What share of city police departments that had 500 or more officers in 2024 gained officers in 2025?"), { form: "share", minCount: 500, year: 2024, later: 2025 });
assert.deepEqual(parseStaffSet("Historical give me a scatter plot of violent crime rate per 100k in 2024 vs officers per 100k in cities of 250k or more"), { form: "scatter", year: 2024, minPopulation: 250000 });
assert.deepEqual(parseStaffSet("give me a scatter plot of violent crime rate per 100k in 2024 vs officers per 100k in cities of 250k or more"), { form: "scatter", year: 2024, minPopulation: 250000 });
assert.deepEqual(parseStaffSet("Which cities have the most officers per capita?"), { form: "rank", kind: "officers", rate: true, year: null, limit: null, direction: "top" });
assert.deepEqual(parseStaffSet("What 5 city police departments had the most officers in 2025?"), { form: "rank", kind: "officers", rate: false, year: 2025, limit: 5, direction: "top" });
assert.deepEqual(parseStaffSet("“Which cities had the most police officers per capita in 2023?”"), { form: "rank", kind: "officers", rate: true, year: 2023, limit: null, direction: "top" });
// Not these forms: left to the existing staffing path.
assert.equal(parseStaffSet("How many police officers does Dallas have?"), null);
assert.equal(parseStaffSet("Which cities have the most murders in 2025?"), null);

type Sql = string[];
const mk = (rows: (s: string) => unknown[][], sql: Sql) => (s: string) => { sql.push(s); return rows(s); };

// Rank, a rate: cities of 100,000 or more, said in the title; the year said when none was asked.
{
  const sql: Sql = [];
  const r = answerStaffSet(parseStaffSet("Which cities have the most officers per capita?")!, build, mk(() => [
    ["A", "Alpha", 300000, 900, 300.0, "NY"], ["B", "Beta", 200000, 700, 350.0, "NJ"], ["C", "Gamma", 150000, null, null, "TX"]], sql));
  assert.ok(r.kind === "historical", JSON.stringify(r));
  if (r.kind === "historical") {
    assert.deepEqual(r.delivered.table.rows, [["Beta, NJ", 350], ["Alpha, NY", 300]]);
    assert.match(r.delivered.text[0], /Population 100,000 or More, 2025/);
    assert.ok(r.delivered.text.some((t) => /No year was asked, so the latest year in the data, 2025/.test(t)), JSON.stringify(r.delivered.text));
    assert.ok(r.delivered.text.some((t) => /1 city agency isn't ranked/.test(t)), JSON.stringify(r.delivered.text));
  }
  assert.match(sql[0], /agency_staffing\.parquet/);
  assert.match(sql[0], /year = 2025 AND population >= 100000/);
}
// Rank, a count with a number asked: no population cut.
{
  const sql: Sql = [];
  const r = answerStaffSet(parseStaffSet("What 5 city police departments had the most officers in 2025?")!, build, mk(() => [
    ["A", "Alpha", 300000, 900, 300.0, "NY"], ["B", "Beta", 20000, 950, 4750, "NJ"]], sql));
  assert.ok(r.kind === "historical" && JSON.stringify(r.delivered.table.rows) === '[["Beta, NJ",950],["Alpha, NY",900]]', JSON.stringify(r));
  assert.doesNotMatch(sql[0], /population >=/);
}
// A year outside the data is said, never answered.
{
  const r = answerStaffSet(parseStaffSet("What 5 city police departments had the most officers in 2031?")!, build, () => []);
  assert.ok(r.kind === "historical-decline" && /outside them/.test(r.explanation), JSON.stringify(r));
}
// List: the qualifying cities with each year's officers; blanks stay blank.
{
  const sql: Sql = [];
  const r = answerStaffSet(parseStaffSet("provide a list of every city that had 500 or more officers in 2019 and the number of officers that agency had in 2019, 2022 and 2023")!, build, mk(() => [
    ["A", "Alpha", "NY", 2019, 600], ["A", "Alpha", "NY", 2022, 650], ["A", "Alpha", "NY", 2023, null], ["B", "Beta", "NJ", 2019, 900], ["B", "Beta", "NJ", 2022, 880], ["B", "Beta", "NJ", 2023, 870]], sql));
  assert.ok(r.kind === "historical", JSON.stringify(r));
  if (r.kind === "historical") {
    assert.deepEqual(r.delivered.table.rows, [["Beta, NJ", 900, 880, 870], ["Alpha, NY", 600, 650, null]]);
    assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Agency", "Sworn officers 2019", "Sworn officers 2022", "Sworn officers 2023"]);
    assert.ok(r.delivered.text.some((t) => /1 figures are blank/.test(t)));
  }
  assert.match(sql[0], /officer_total >= 500/);
}
// Share: N of M, X percent; a department with no later-year figure is left out and said.
{
  const sql: Sql = [];
  const r = answerStaffSet(parseStaffSet("What share of city police departments that had 500 or more officers in 2024 gained officers in 2025?")!, build, mk(() => [
    ["A", "Alpha", "NY", 600, 650], ["B", "Beta", "NJ", 900, 880], ["C", "Gamma", "TX", 700, 701], ["D", "Delta", "OH", 800, null]], sql));
  assert.ok(r.kind === "historical", JSON.stringify(r));
  if (r.kind === "historical") {
    assert.deepEqual(r.delivered.table.rows, [[3, 2, 66.7]]);
    assert.ok(r.delivered.text.some((t) => /2 of 3 city police departments.*66\.7 percent/.test(t)), JSON.stringify(r.delivered.text));
    assert.ok(r.delivered.text.some((t) => /1 further department has no sworn officer count for 2025/.test(t)));
  }
}
// Scatter: the table of the two rates, ordered by violent crime rate; no plot is drawn, said.
{
  const sql: Sql = [];
  const r = answerStaffSet(parseStaffSet("give me a scatter plot of violent crime rate per 100k in 2024 vs officers per 100k in cities of 250k or more")!, build, mk(() => [
    ["A", "Alpha", "NY", 300000, 3000, 1000.0, 900, 300.0], ["B", "Beta", "NJ", 400000, 1600, 400.0, 1200, 300.0], ["C", "Gamma", "TX", 500000, null, null, 500, 100.0]], sql));
  assert.ok(r.kind === "historical", JSON.stringify(r));
  if (r.kind === "historical") {
    assert.deepEqual(r.delivered.table.rows, [["Alpha, NY", 1000, 300], ["Beta, NJ", 400, 300]]);
    assert.ok(r.delivered.text.some((t) => /scatter plot isn't drawn here/.test(t)));
  }
  assert.match(sql[0], /agency_crime\.parquet/);
  assert.match(sql[0], /s\.population >= 250000/);
}
// Through the shadow: the seven questions reach the staffing tables, never the old decline.
{
  const places = loadPlaceIndex();
  for (const q of ["Which cities have the most officers per capita?", "What 5 city police departments had the most officers in 2025?", "“Which cities had the most police officers per capita in 2023?”"]) {
    const sql: Sql = [];
    const out = shadowAnswer(q, { noDefaults: true, places, release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" }, target: { root: "/b", builtYears: [2023] },
      execute: mk(() => [["A", "Alpha", 300000, 900, 300.0, "NY"]], sql), historical: build } as never);
    assert.ok(out.kind === "historical", `${q}: ${JSON.stringify(out).slice(0, 300)}`);
    assert.ok(sql.some((s) => /agency_staffing/.test(s)), q);
  }
}
console.log("staffing-set: all checks passed");
