import assert from "node:assert/strict";
import { buildNibrsJuvenileArrestsByRaceQuery } from "../lib/nibrs-rollup-deterministic";
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
console.log("nibrs rollup deterministic tests passed");
