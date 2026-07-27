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

{
  // Recursive CTE with a column list and no space before the parens —
  // "spine(ym) AS (" — must be recognized as a CTE, not an unknown table
  // (production failure: table_allowlist:spine on hate-crime rolling queries).
  const sql = `WITH monthly AS (SELECT year AS ym, COUNT(*) AS cnt FROM summary_state_monthly GROUP BY ym),
    bounds AS (SELECT MIN(ym) AS start_ym, MAX(ym) AS end_ym FROM monthly),
    spine(ym) AS (SELECT start_ym FROM bounds UNION ALL SELECT ym + 1 FROM spine, bounds WHERE ym < end_ym),
    rolling AS (SELECT s.ym, SUM(COALESCE(m.cnt, 0)) OVER (ORDER BY s.ym) AS r FROM spine s LEFT JOIN monthly m ON m.ym = s.ym)
    SELECT ym, r FROM rolling`;
  const result = validateTablesForTab(sql, "nibrs", db);
  assert.equal(result.ok, true, `column-list CTE without space must be recognized; unknown: ${result.unknown.join(",")}`);
  const spaced = validateTablesForTab(sql.replace("spine(ym)", "spine (ym)"), "nibrs", db);
  assert.equal(spaced.ok, true, "column-list CTE with space must be recognized");
}

db.close();
console.log("table allowlist tests passed");
