/**
 * Hate crimes in the shadow (lib/nibrs-shadow/hate.ts): answered from the hate crime export only, never from NIBRS.
 * Stub executor: no database. Checks the question's reading, the SQL it runs, the lines it says and the declines.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shadowAnswer, type ShadowDeps, type ShadowOutcome } from "../lib/nibrs-shadow/answer";
import { hateBuildAt, HATE_REPORTING_CAVEAT, HATE_SOURCE } from "../lib/nibrs-shadow/hate";
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
  if (/GROUP BY k/.test(sql)) {
    const keys = /year\(incident_date\) AS k/.test(sql) ? [2022, 2023, 2024] : [202301, 202302, 202303, 202304, 202305, 202306, 202307, 202308, 202309, 202310, 202311, 202312, 202201, 202202];
    return keys.map((k, i) => [k, 10 + i]);
  }
  return [[857]];
};
const deps: ShadowDeps = {
  places: loadPlaceIndex(), release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" },
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] }, execute, hate: build,
};
const ask = (q: string, d: ShadowDeps = deps): ShadowOutcome => shadowAnswer(q, d);
const as = <K extends ShadowOutcome["kind"]>(o: ShadowOutcome, k: K) => { assert.equal(o.kind, k, JSON.stringify(o).slice(0, 400)); return o as Extract<ShadowOutcome, { kind: K }>; };

// Jeff's form for a named bias in a state and year; the SQL is the hate crime table, the bias code 32, distinct incidents.
const hispanic = as(ask("anti-Hispanic hate crimes in Texas in 2024"), "hate");
assert.equal(hispanic.delivered.text[0], "Anti-Hispanic or Latino hate crimes: 857 in Texas in 2024.");
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
console.log("nibrs hate: hate crime questions are answered from the hate crime data only, with its caveat and its latest-date rule");
