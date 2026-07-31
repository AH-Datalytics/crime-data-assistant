import assert from "node:assert/strict";
import { buildNibrsJuvenileArrestsByRaceQuery, buildNibrsNationalArrestQuery } from "../lib/nibrs-rollup-deterministic";
import { validateAndSanitize } from "../lib/sql-safety";
import { pastCompleteCalendarYearsRange } from "../lib/time-conventions";

const national = buildNibrsJuvenileArrestsByRaceQuery("juvenile arrests by race nationally", true);
assert.ok(national);
assert.match(national.sql, /rollup\.national_summary_arrestee_demographics/);
const fallback = pastCompleteCalendarYearsRange(5);
assert.match(national.sql, new RegExp(`year BETWEEN ${fallback.start} AND ${fallback.end}`));
assert.equal(validateAndSanitize(national.sql).valid, true);

const texas = buildNibrsJuvenileArrestsByRaceQuery("juvenile arrests by race in Texas from 2020 to 2024", true);
assert.ok(texas);
assert.match(texas.sql, /rollup\.state_summary_arrestee_demographics/);
assert.match(texas.sql, /d\.state = 'TX'/);
assert.match(texas.sql, /year BETWEEN 2020 AND 2024/);

assert.equal(buildNibrsJuvenileArrestsByRaceQuery("juvenile arrests by race in Chicago", true), null);
assert.equal(buildNibrsJuvenileArrestsByRaceQuery("juvenile arrests by race nationally", false), null);

const exactNational = buildNibrsNationalArrestQuery("How many arrests were made in 2024 in the United States?", true);
assert.ok(exactNational);
assert.match(exactNational.sql, /year BETWEEN 2024 AND 2024/);
assert.match(exactNational.sql, /rollup\.national_summary_arrestee_demographics/);
assert.equal(validateAndSanitize(exactNational.sql).valid, true);

const violentByOffense = buildNibrsNationalArrestQuery("Show the national violent crime arrest trend by offense type since 2018", true);
assert.ok(violentByOffense);
assert.match(violentByOffense.sql, /ucr_arrest_offense IN \('09A', '11A', '11B', '11C', '120', '13A'\)/);
assert.match(violentByOffense.sql, /GROUP BY d\.year, d\.ucr_arrest_offense/);
assert.equal(validateAndSanitize(violentByOffense.sql).valid, true);

const implicitNationalOffenseTrend = buildNibrsNationalArrestQuery("Arrest trends for violent offenses broken out by offense type", true);
assert.ok(implicitNationalOffenseTrend);
assert.match(implicitNationalOffenseTrend.sql, /rollup\.national_summary_arrestee_demographics/);
assert.match(implicitNationalOffenseTrend.sql, /GROUP BY d\.year, d\.ucr_arrest_offense/);

const implicitNationalExactYear = buildNibrsNationalArrestQuery("How many arrests were made in 2024?", true);
assert.ok(implicitNationalExactYear);
assert.match(implicitNationalExactYear.sql, /year BETWEEN 2024 AND 2024/);

assert.equal(buildNibrsNationalArrestQuery("arrests in Chicago in 2024", true), null);
assert.equal(buildNibrsNationalArrestQuery("national arrests by race in 2024", true), null);
assert.equal(buildNibrsNationalArrestQuery("national arrests in 2024", false), null);
console.log("nibrs rollup deterministic tests passed");
