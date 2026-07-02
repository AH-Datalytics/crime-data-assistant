import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { extractReferencedTables, validateTablesForTab } from "../lib/table-allowlist";

const db = new Database(":memory:");
db.exec(`
  CREATE TABLE summary_state_monthly (year INTEGER, month INTEGER, state TEXT);
  CREATE TABLE agencies (ori TEXT, year INTEGER);
`);

assert.deepEqual(
  extractReferencedTables("SELECT * FROM agency_monthly WHERE year = 2026"),
  ["agency_monthly"],
  "extracts simple FROM table"
);

assert.deepEqual(
  extractReferencedTables(`
    WITH latest AS (
      SELECT year, month FROM summary_state_monthly
    )
    SELECT * FROM latest JOIN agencies a ON a.year = latest.year
  `).sort(),
  ["agencies", "summary_state_monthly"].sort(),
  "ignores CTE name while keeping real tables"
);

assert.deepEqual(
  extractReferencedTables(`
    WITH agency AS (
      SELECT ori FROM agencies LIMIT 1
    ),
    years AS (
      SELECT 2000 AS year
    ),
    yr AS (
      SELECT year FROM years UNION ALL SELECT year + 1 FROM yr WHERE year < 2024
    )
    SELECT y.year
    FROM yr y
    JOIN agency a ON 1=1
  `),
  ["agencies"],
  "ignores every CTE name in a recursive CTE chain"
);

{
  const result = validateTablesForTab("SELECT * FROM summary_state_monthly JOIN agencies ON 1=1", "nibrs", db);
  assert.equal(result.ok, true, "known active-tab tables pass");
}

{
  const result = validateTablesForTab("SELECT * FROM agency_monthly", "nibrs", db);
  assert.equal(result.ok, false, "foreign tab table fails");
  assert.deepEqual(result.unknown, ["agency_monthly"]);
  assert.match(result.message, /do not exist in the active nibrs database/i);
}

db.close();
console.log("table allowlist tests passed");
