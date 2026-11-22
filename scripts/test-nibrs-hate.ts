/**
 * Hate crimes in the shadow (lib/nibrs-shadow/hate.ts): answered from the hate crime export only, never from NIBRS.
 * Stub executor: no database. Checks the question's reading, the SQL it runs, the lines it says and the declines.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { hateBuildAt, HATE_BIASES_OVERLAP, HATE_REPORTING_CAVEAT, HATE_SOURCE, SCHOOL_LINE } from "../lib/nibrs-shadow/hate";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

// A release folder as the export writes it: the latest incident date is mid-October 2026, so the last complete month is September 2026.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "hate-build-"));
fs.mkdirSync(path.join(root, "hate_crime_incident"));
fs.writeFileSync(path.join(root, "hate_crime_incident", "data.parquet"), "");
fs.writeFileSync(path.join(root, "release.json"), JSON.stringify({ source_sha256: "ab".repeat(32), rows: 293112, first_incident_date: "1991-01-01", latest_incident_date: "2026-10-13", rows_whose_stored_label_differs: 0 }));
const build = hateBuildAt(root)!;
assert.equal(build.latestMonth, "2026-09", "a month is complete only when the latest date is its last day");
assert.equal(hateBuildAt(path.join(root, "nowhere")), undefined);
// A release whose stored labels differ from the decoder is refused.
const bad = fs.mkdtempSync(path.join(os.tmpdir(), "hate-bad-"));
fs.mkdirSync(path.join(bad, "hate_crime_incident")); fs.writeFileSync(path.join(bad, "hate_crime_incident", "data.parquet"), "");
fs.writeFileSync(path.join(bad, "release.json"), JSON.stringify({ source_sha256: "cd".repeat(32), rows: 1, first_incident_date: "1991-01-01", latest_incident_date: "2025-12-31", rows_whose_stored_label_differs: 3 }));
assert.throws(() => hateBuildAt(bad), /no stored label that differs/);

const sqls: string[] = [];
const execute = (sql: string): unknown[][] => {
  sqls.push(sql);
  // A breakdown (H2/H3): per bias or location, by year when asked; the incidents left out of a school count (H4).
  if (/AS k, \w+ AS c/.test(sql)) return [[2023, "Anti-Jewish", 7], [2023, "Location not confirmed", 9], [2023, "Anti-Black or African American", 8], [2024, "Anti-Jewish", 3]];
  if (/ AS c,/.test(sql)) return [["Anti-Black or African American", 5], ["Location not confirmed", 9], ["Anti-Jewish", 7], [null, 1]];
  if (/^SELECT count\(\*\) FROM \(/.test(sql)) return [[4]];
  if (/GROUP BY k/.test(sql)) {
    const keys = /year\(incident_date\) AS k/.test(sql) ? [2022, 2023, 2024] : [202301, 202302, 202303, 202304, 202305, 202306, 202307, 202308, 202309, 202310, 202311, 202312, 202201, 202202];
    return keys.map((k, i) => [k, 10 + i]);
  }
  return [[857]];
};
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute, hate: build, noDefaults: true,
};
const ask = (q: string, d: ShadowDeps = deps): ShadowOutcome => shadowAnswer(q, d);
const as = <K extends ShadowOutcome["kind"]>(o: ShadowOutcome, k: K) => { assert.equal(o.kind, k, JSON.stringify(o).slice(0, 400)); return o as Extract<ShadowOutcome, { kind: K }>; };

// Jeff's form for a named bias in a state and year; the SQL is the hate crime table, the bias code 32, distinct incidents.
const hispanic = as(ask("anti-Hispanic hate crimes in Texas in 2024"), "hate");
assert.equal(hispanic.delivered.text[0], "Texas had 857 anti-Hispanic or Latino hate crimes in 2024.");
assert.ok(hispanic.delivered.text.includes(HATE_REPORTING_CAVEAT) && hispanic.delivered.text.includes(HATE_SOURCE));
assert.equal(hispanic.meaning.source, "hate_crime");
const sql = sqls[sqls.length - 1];
assert.ok(/hate_crime_incident\/data\.parquet/.test(sql) && /bias_code = '32'/.test(sql) && /state = 'TX'/.test(sql) && /count\(DISTINCT year \|\| '\|' \|\| ori \|\| '\|' \|\| incident_number\)/.test(sql), sql);
assert.ok(!/read_parquet\([^)]*(?:offense|victim)\//.test(sql), "never a NIBRS table");

// A plain count by year and by month, and a rolling window; nothing is NIBRS's.
const byYear = as(ask("hate crimes in Texas by year from 2022 to 2024"), "hate");
assert.deepEqual(byYear.delivered.table.columns.map((c) => c.header), ["Year", "Hate crimes"]);
assert.deepEqual(byYear.delivered.table.rows, [["2022", 10], ["2023", 11], ["2024", 12]]);
const byMonth = as(ask("hate crimes per month in Texas in 2023"), "hate");
assert.equal(byMonth.delivered.table.rows.length, 12);
assert.deepEqual(byMonth.delivered.table.columns.map((c) => c.header), ["Month", "Hate crimes"]);

// A span past the last complete month stops there and says why, in words.
const partial = as(ask("hate crimes in Texas in 2026"), "hate");
assert.ok(partial.delivered.text.some((t) => /run through October 13, 2026, so the answer ends with September 2026, the last complete month/.test(t)), partial.delivered.text.join(" / "));
assert.equal(partial.period.to, "2026-09");

// NIBRS's data start does not limit hate crimes (1991 on): "since 2015" is a series, not a NIBRS coverage decline.
const since = as(ask("hate crimes in Texas by year since 2015"), "hate");
assert.equal(since.period.from, "2015-01");
// A rolling window is complete from the data's first month: the first 11 months of 1991 are not shown, with no blank row and no gap sentence.
const roll = as(ask("hate crimes in Texas rolling 12 months since 1991"), "hate");
assert.equal(roll.delivered.table.rows[0][0], "1991-12");
assert.ok(roll.delivered.table.rows.every((r) => r[1] !== null), "no blank row");
assert.ok(!roll.delivered.text.some((x) => /rolling total is blank/.test(x)), "no gap sentence");
// No period named: a count asks which period (D31), as every count does; a series with no range is every year the data have, said.
const noPeriod = as(ask("hate crime data in Texas"), "clarify");
assert.equal(noPeriod.about, "which period");
const everyYear = as(ask("hate crimes by year in Texas"), "hate");
assert.equal(everyYear.period.from, "1991-01");
assert.ok(everyYear.delivered.text.includes("No years were given, so every year in the data is shown: 1991 through 2026."), everyYear.delivered.text.join(" / "));
// Codex review of the branch: a total across years counts an incident once per ORI and year; a rolling window checks the bias meaning over its
// whole span; spans wholly outside the data say where the data are; other units and supporting columns are declined; the latest-date line
// shows whenever a later partial month exists.
const total = ask("hate crimes in Texas from 2020 to 2024");
as(total, "hate");
assert.match(sqls[sqls.length - 1], /count\(DISTINCT year \|\| '\|' \|\| ori \|\| '\|' \|\| incident_number\)/);
assert.notEqual(ask("anti-Asian hate crimes in Texas rolling 12 months in 2013").kind, "hate", "the window reaches 2012, when code 14 meant another group");
assert.equal(as(ask("hate crimes in Texas in 1980"), "decline").explanation, "Hate crime data here start in 1991, so 1980 isn't included.");
assert.equal(as(ask("hate crimes in Texas from 1960 to 1990"), "decline").explanation, "Hate crime data here start in 1991, so 1960 through 1990 aren't included.");
assert.ok(as(ask("hate crimes in Texas by year from 1990 to 1993"), "hate").delivered.text.includes("Hate crime data here start in 1991, so 1990 isn't included."));
assert.notEqual(ask("hate crime victims in Texas in 2024").kind, "hate", "victims are not incidents");
assert.notEqual(ask("hate crimes in Texas in 2024 with the number of agencies reporting").kind, "hate", "a supporting column is not dropped");
// Without a build, or for a shape this source does not answer, a plain decline: never a NIBRS answer, never the weapon sentence.
const noBuild = as(ask("anti-Hispanic hate crimes in Texas in 2024", { ...deps, hate: undefined }), "decline");
assert.ok(!/weapon or relationship/.test(noBuild.explanation));
const rate = ask("hate crimes per 100,000 in Texas in 2024");
assert.notEqual(rate.kind, "answer", "a rate is not built");
// H1 (2026-11-21): several biases named are side by side, one column each in the order asked, each its own count (never an
// incident with both, never added), with the overlap line.
{
  const n0 = sqls.length;
  const two = as(ask("anti-Islamic and anti-Jewish hate crimes in Texas by year from 2022 to 2024"), "hate");
  assert.deepEqual(two.delivered.table.columns.map((c) => c.header), ["Year", "Anti-Islamic (Muslim) hate crimes", "Anti-Jewish hate crimes"]);
  assert.deepEqual(two.delivered.table.rows, [["2022", 10, 10], ["2023", 11, 11], ["2024", 12, 12]]);
  assert.equal(two.delivered.text[0], "Texas Anti-Islamic (Muslim) and Anti-Jewish Hate Crimes Per Year, 2022-2024");
  assert.ok(two.delivered.text.includes(HATE_BIASES_OVERLAP) && two.delivered.text[two.delivered.text.length - 1] === HATE_SOURCE);
  const run = sqls.slice(n0);
  assert.equal(run.length, 2, "one statement per bias");
  assert.ok(/bias_code = '24'/.test(run[0]) && /bias_code = '21'/.test(run[1]) && run.every((s) => !/bias_code IN|bias_code = '\d+' AND bias_code/.test(s)), run.join("\n"));
  const total = as(ask("anti-Islamic and anti-Jewish hate crimes in Texas in 2024"), "hate");
  assert.equal(total.delivered.text[0], "Texas had 857 anti-Islamic (Muslim) hate crimes and 857 anti-Jewish hate crimes in 2024.");
  assert.deepEqual(total.delivered.table.rows, [[857, 857]]);
  // A rolling window of several biases is not built.
  assert.equal(ask("anti-Asian and anti-Black hate crimes in Texas rolling 12 months").kind, "decline");
}
// H2, H3 (Jeff 2026-11-21): by bias, by location: one row each, incidents, largest first, "Location not confirmed" and no location last;
// an incident in several rows, said with the period's total; no share column; a breakdown by bias is for hate crimes only.
{
  const byBias = as(ask("hate crimes by bias nationally in 2024"), "hate");
  assert.deepEqual(byBias.delivered.table.columns.map((c) => c.header), ["Bias", "Hate crimes"]);
  assert.deepEqual(byBias.delivered.table.rows, [["Anti-Jewish", 7], ["Anti-Black or African American", 5], ["Location not confirmed", 9], ["Not recorded", 1]]);
  assert.ok(byBias.delivered.text.includes("An incident with more than one bias is counted under each, so the rows add to more than 857 hate crimes."), byBias.delivered.text.join(" / "));
  assert.ok(/ GROUP BY c$/.test(sqls[sqls.length - 2]) && /bias_label AS c/.test(sqls[sqls.length - 2]), sqls[sqls.length - 2]);
  const yearly = as(ask("hate crimes by bias in Texas by year from 2023 to 2024"), "hate");
  assert.deepEqual(yearly.delivered.table.columns.map((c) => c.header), ["Year", "Bias", "Hate crimes"]);
  assert.deepEqual(yearly.delivered.table.rows, [["2023", "Anti-Black or African American", 8], ["2023", "Anti-Jewish", 7], ["2023", "Location not confirmed", 9], ["2024", "Anti-Jewish", 3]]);
  assert.ok(yearly.delivered.text.includes("An incident with more than one bias is counted under each, so a year's rows can add to more than its hate crimes."));
  const byLoc = as(ask("hate crimes by location in Texas in 2024"), "hate");
  assert.deepEqual(byLoc.delivered.table.columns.map((c) => c.header), ["Location", "Hate crimes"]);
  assert.ok(/location AS c/.test(sqls[sqls.length - 2]) && byLoc.delivered.text.includes("An incident at more than one location is counted under each, so the rows add to more than 857 hate crimes."));
  assert.ok(byLoc.delivered.table.columns.every((c) => !/share/i.test(c.header)), "no share column");
  assert.equal(ask("robberies by bias in Texas in 2024").kind, "decline", "a breakdown by bias is for hate crimes only");
}
// H4 (Jeff 2026-11-21): at schools: incidents with any offense at a school location; the incidents with no confirmed location are not
// counted, and a line says how many.
{
  const school = as(ask("anti-Black hate crimes at schools in Texas in 2024"), "hate");
  const counted = sqls[sqls.length - 2], left = sqls[sqls.length - 1];
  assert.ok(/location IN \('School\/College', 'School-College\/University', 'School-Elementary\/Secondary'\)/.test(counted) && /bias_code = '12'/.test(counted), counted);
  assert.ok(/HAVING bool_or\(location = 'Location not confirmed'\) AND NOT bool_or\(location IN/.test(left), left);
  assert.equal(school.delivered.text[0], "Texas had 857 anti-Black or African American hate crimes at schools in 2024.");
  assert.ok(school.delivered.text.includes(SCHOOL_LINE) && school.delivered.text.includes("4 hate crimes in 2024 have no confirmed location and are not counted."), school.delivered.text.join(" / "));
  assert.equal(as(ask("hate crimes at schools by year nationally"), "hate").delivered.table.columns[1].header, "Hate crimes at schools");
}
console.log("nibrs hate: hate crime questions are answered from the hate crime data only, with its caveat and its latest-date rule");
