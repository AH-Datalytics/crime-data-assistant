import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { validateSqlSchema } from "../lib/schema-validation";

const db = new Database(":memory:");
db.exec("CREATE TABLE summary_arrestee_demographics (year INTEGER, month INTEGER, arrestee_count INTEGER, ucr_arrest_offense TEXT)");

const invalid = validateSqlSchema(db, "SELECT year, arrest_count FROM summary_arrestee_demographics");
assert.equal(invalid.ok, true);
assert.equal(invalid.corrected, true);
assert.match(invalid.sql, /arrestee_count/);
assert.doesNotMatch(invalid.sql, /arrest_count/);

const unknown = validateSqlSchema(db, "SELECT year, nonexistent_count FROM summary_arrestee_demographics");
assert.equal(unknown.ok, false);
assert.equal(unknown.corrected, false);
assert.match(unknown.error ?? "", /no such column/i);

const valid = validateSqlSchema(db, "SELECT year, arrestee_count FROM summary_arrestee_demographics");
assert.deepEqual(valid, {
  ok: true,
  sql: "SELECT year, arrestee_count FROM summary_arrestee_demographics",
  corrected: false,
});

console.log("schema validation tests passed");
