#!/usr/bin/env npx tsx
/**
 * Regression tests for the local SQL structure guardrails
 * (lib/sql-guardrails.ts) — duplicate GROUP BY, ORDER BY before
 * UNION ALL, and undeclared alias detection.
 *
 * Usage: npx tsx scripts/test-sql-guardrails.ts
 */

import { findNibrsSqlIssues } from "../lib/sql-guardrails.js";

let pass = 0;
let fail = 0;
const failures: { name: string; detail?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    failures.push({ name, detail });
    console.log(`  FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fires(sql: string, guardrail: string): boolean {
  return findNibrsSqlIssues(sql).fired.includes(guardrail);
}

// ══════════════════════════════════════════════════════════════════════
//  Duplicate GROUP BY
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-duplicate-group-by ═══\n");

assert(
  "INVALID: two GROUP BY clauses in same SELECT",
  fires(
    "SELECT d.age_group, SUM(d.offender_count) FROM summary_offender_demographics d WHERE d.year BETWEEN 2015 AND 2025 GROUP BY d.age_group GROUP BY year",
    "nibrs-duplicate-group-by"
  )
);

assert(
  "VALID: single GROUP BY with multiple columns",
  !fires(
    "SELECT d.year, d.age_group, SUM(d.offender_count) FROM summary_offender_demographics d GROUP BY d.year, d.age_group ORDER BY d.year",
    "nibrs-duplicate-group-by"
  )
);

assert(
  "VALID: GROUP BY in two different SELECTs (UNION ALL)",
  !fires(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly GROUP BY year UNION ALL SELECT year, SUM(offense_count) FROM summary_state_monthly GROUP BY year",
    "nibrs-duplicate-group-by"
  )
);

assert(
  "VALID: GROUP BY in CTE + GROUP BY in outer query",
  !fires(
    "WITH agg AS (SELECT ori, SUM(victim_count) AS total FROM summary_victim_city_monthly GROUP BY ori) SELECT state, SUM(total) FROM agg JOIN agencies a ON a.ori = agg.ori GROUP BY state",
    "nibrs-duplicate-group-by"
  )
);

// ══════════════════════════════════════════════════════════════════════
//  ORDER BY before UNION ALL (depth-aware)
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-order-before-union-all ═══\n");

assert(
  "INVALID: top-level ORDER BY before UNION ALL",
  fires(
    "SELECT year, SUM(victim_count) FROM t1 GROUP BY year ORDER BY year UNION ALL SELECT year, SUM(victim_count) FROM t2 GROUP BY year",
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: ORDER BY inside CTE followed by outer UNION ALL",
  !fires(
    "WITH top AS (SELECT ori FROM summary_city_monthly GROUP BY ori ORDER BY SUM(offense_count) DESC LIMIT 10) SELECT * FROM top UNION ALL SELECT * FROM top",
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: ORDER BY inside scalar subquery before UNION ALL",
  !fires(
    "SELECT year, victim_count FROM summary_victim_city_monthly WHERE ori = (SELECT ori FROM agencies WHERE city = 'HOUSTON' ORDER BY pop_group LIMIT 1) UNION ALL SELECT year, victim_count FROM summary_victim_city_monthly WHERE ori = 'TX0001'",
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: ORDER BY after final UNION ALL (correct position)",
  !fires(
    "SELECT year, SUM(victim_count) FROM t1 GROUP BY year UNION ALL SELECT year, SUM(victim_count) FROM t2 GROUP BY year ORDER BY year",
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: ORDER BY inside IN subquery before UNION ALL",
  !fires(
    "SELECT year, SUM(victim_count) FROM summary_victim_city_monthly WHERE ori IN (SELECT ori FROM agencies WHERE city = 'DENVER' ORDER BY population DESC LIMIT 1) UNION ALL SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'CO' GROUP BY year",
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: multiple CTEs with ORDER BY, outer UNION ALL",
  !fires(
    `WITH cte1 AS (SELECT ori, SUM(offense_count) AS total FROM summary_city_monthly GROUP BY ori ORDER BY total DESC LIMIT 5),
     cte2 AS (SELECT ori, SUM(victim_count) AS total FROM summary_victim_city_monthly GROUP BY ori ORDER BY total DESC LIMIT 5)
     SELECT * FROM cte1 UNION ALL SELECT * FROM cte2`,
    "nibrs-order-before-union-all"
  )
);

assert(
  "VALID: nested subquery in FROM with ORDER BY, outer UNION ALL",
  !fires(
    "SELECT * FROM (SELECT year, SUM(offense_count) AS total FROM summary_city_monthly GROUP BY year ORDER BY year LIMIT 5) sub UNION ALL SELECT year, 0 FROM summary_state_monthly GROUP BY year",
    "nibrs-order-before-union-all"
  )
);

// ══════════════════════════════════════════════════════════════════════
//  Undeclared alias detection
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ nibrs-undeclared-table-alias ═══\n");

assert(
  "INVALID: alias s not declared (only d exists)",
  fires(
    "SELECT s.year, d.age_group, SUM(d.offender_count) FROM summary_offender_demographics d GROUP BY s.year, d.age_group",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: all aliases declared in FROM",
  !fires(
    "SELECT d.year, d.age_group, SUM(d.offender_count) FROM summary_offender_demographics d GROUP BY d.year, d.age_group",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: alias declared in JOIN",
  !fires(
    "SELECT d.year, a.city FROM summary_offender_demographics d JOIN agencies a ON a.ori = d.ori AND a.year = d.year",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: CTE name used as qualifier",
  !fires(
    "WITH consistent AS (SELECT ori FROM nibrs_agency_completeness GROUP BY ori HAVING COUNT(*) = 11) SELECT d.year FROM summary_offender_demographics d WHERE d.ori IN (SELECT consistent.ori FROM consistent)",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: subquery alias in FROM",
  !fires(
    "SELECT sub.year, sub.total FROM (SELECT year, SUM(offense_count) AS total FROM summary_city_monthly GROUP BY year) sub WHERE sub.total > 100",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: subquery alias in JOIN",
  !fires(
    "SELECT a.city, sub.total FROM agencies a JOIN (SELECT ori, SUM(offense_count) AS total FROM summary_city_monthly GROUP BY ori) sub ON sub.ori = a.ori",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: schema-qualified table name (main.table)",
  !fires(
    "SELECT s.year FROM main.summary_city_monthly s GROUP BY s.year",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: correlated subquery using outer alias",
  !fires(
    "SELECT a.city, a.state FROM agencies a WHERE EXISTS (SELECT 1 FROM summary_city_monthly s WHERE s.ori = a.ori AND s.year = 2024)",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: table without alias (unqualified columns)",
  !fires(
    "SELECT year, SUM(victim_count) FROM summary_victim_state_monthly WHERE state = 'TX' GROUP BY year",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: multiple CTEs with aliases in outer query",
  !fires(
    `WITH murder_data AS (SELECT year, SUM(offender_count) AS cnt FROM summary_offender_demographics WHERE ucr_offense_code = '09A' GROUP BY year),
     robbery_data AS (SELECT year, SUM(offender_count) AS cnt FROM summary_offender_demographics WHERE ucr_offense_code = '120' GROUP BY year)
     SELECT m.year, m.cnt AS murders, r.cnt AS robberies FROM murder_data m JOIN robbery_data r ON r.year = m.year`,
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "VALID: FROM table AS explicit_alias",
  !fires(
    "SELECT t.year FROM summary_city_monthly AS t GROUP BY t.year",
    "nibrs-undeclared-table-alias"
  )
);

assert(
  "INVALID: alias x never declared anywhere",
  fires(
    "SELECT x.year, d.age_group FROM summary_offender_demographics d WHERE x.state = 'TX'",
    "nibrs-undeclared-table-alias"
  )
);

// ══════════════════════════════════════════════════════════════════════
//  Combined: no false positives on realistic NIBRS queries
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ Realistic queries (no false positives) ═══\n");

{
  // Query 3716 pattern: multi-offense offender demographics
  const r = findNibrsSqlIssues(
    `SELECT d.year, d.ucr_offense_code,
       CASE d.age_group WHEN 'Under 18' THEN 'Under 18' WHEN '18-24' THEN '18-24' END AS age_group,
       SUM(d.offender_count) AS offender_count
     FROM summary_offender_demographics d
     WHERE d.ucr_offense_code IN ('09A','120','13A')
       AND d.year BETWEEN 2015 AND 2025
       AND d.ori IN (SELECT ori FROM nibrs_agency_completeness WHERE year BETWEEN 2015 AND 2025 GROUP BY ori HAVING COUNT(*) = 11)
     GROUP BY d.year, d.ucr_offense_code, d.age_group
     ORDER BY d.year`
  );
  assert("Realistic: multi-offense demographics — no issues", r.fired.length === 0, `fired: ${r.fired}`);
}

{
  // Query 3723 pattern: UNION ALL across offense types
  const r = findNibrsSqlIssues(
    `SELECT 'Murder (09A)' AS offense_type, d.age_group, SUM(d.offender_count) AS offenders
     FROM summary_offender_demographics d WHERE d.ucr_offense_code = '09A' GROUP BY d.age_group
     UNION ALL
     SELECT 'Robbery (120)', d.age_group, SUM(d.offender_count)
     FROM summary_offender_demographics d WHERE d.ucr_offense_code = '120' GROUP BY d.age_group
     ORDER BY offense_type, age_group`
  );
  assert("Realistic: UNION ALL with ORDER BY at end — no issues", r.fired.length === 0, `fired: ${r.fired}`);
}

{
  // Complex CTE + subquery + UNION ALL
  const r = findNibrsSqlIssues(
    `WITH consistent AS (
       SELECT ori FROM nibrs_agency_completeness
       WHERE year BETWEEN 2015 AND 2025
       GROUP BY ori HAVING COUNT(*) = 11
     ),
     top_cities AS (
       SELECT a.city, a.state, a.ori
       FROM agencies a
       WHERE a.ori IN (SELECT ori FROM consistent)
         AND a.year = 2025
       ORDER BY a.population DESC
       LIMIT 10
     )
     SELECT t.city, t.state, SUM(s.victim_count) AS murders
     FROM top_cities t
     JOIN summary_victim_city_monthly s ON s.ori = t.ori
     WHERE s.ucr_offense_code = '09A'
     GROUP BY t.city, t.state
     UNION ALL
     SELECT 'TOTAL', '', SUM(s.victim_count)
     FROM summary_victim_city_monthly s
     WHERE s.ori IN (SELECT ori FROM top_cities)
       AND s.ucr_offense_code = '09A'`
  );
  assert("Realistic: CTE with ORDER BY + outer UNION ALL — no issues", r.fired.length === 0, `fired: ${r.fired}`);
}

// ══════════════════════════════════════════════════════════════════════
//  String stripping: don't match inside quotes
// ══════════════════════════════════════════════════════════════════════

console.log("\n═══ String literal safety ═══\n");

assert(
  "VALID: 'GROUP BY' inside string literal is not a real GROUP BY",
  !fires(
    "SELECT year, 'GROUP BY clause' AS label FROM summary_state_monthly GROUP BY year",
    "nibrs-duplicate-group-by"
  )
);

assert(
  "VALID: alias-like pattern inside string literal",
  !fires(
    "SELECT 's.year is the column' AS note, d.year FROM summary_offender_demographics d GROUP BY d.year",
    "nibrs-undeclared-table-alias"
  )
);

// ══════════════════════════════════════════════════════════════════════
//  Summary
// ══════════════════════════════════════════════════════════════════════

// ------------------------------------------------------------------
//  nibrs_offense_codes schema
// ------------------------------------------------------------------

console.log("\n--- nibrs-offense-codes-column ---\n");

{
  const sql = `SELECT DISTINCT ucr_offense_code, offense_name FROM nibrs_offense_codes WHERE offense_name LIKE '%force%' OR offense_name LIKE '%use of%' OR offense_name LIKE '%assault%' OR offense_name LIKE '%police%' ORDER BY ucr_offense_code LIMIT 1000`;
  const r = findNibrsSqlIssues(sql);
  assert("INVALID: #4221 nibrs_offense_codes.ucr_offense_code fires",
    r.fired.includes("nibrs-offense-codes-column"),
    `fired: ${r.fired}`);
  assert("INVALID: #4221 issue explains code column",
    r.issues.some((issue) => issue.includes("code") && issue.includes("ucr_offense_code")),
    `issues: ${r.issues}`);
}

assert(
  "VALID: nibrs_offense_codes code column with output alias",
  !fires(
    "SELECT DISTINCT code AS ucr_offense_code, offense_name FROM nibrs_offense_codes WHERE offense_name LIKE '%assault%' ORDER BY code LIMIT 1000",
    "nibrs-offense-codes-column"
  )
);

assert(
  "VALID: joined nibrs_offense_codes may group by fact-table ucr_offense_code",
  !fires(
    "SELECT s.year, s.month, o.code AS ucr_offense_code, o.offense_name, SUM(s.offense_count) AS offense_count FROM summary_city_monthly s JOIN nibrs_offense_codes o ON o.code = s.ucr_offense_code WHERE s.ori = 'CA0019700' GROUP BY s.year, s.month, s.ucr_offense_code, o.offense_name ORDER BY s.year, s.month, o.code LIMIT 1000",
    "nibrs-offense-codes-column"
  )
);

assert(
  "INVALID: nibrs_offense_codes alias cannot reference missing ucr_offense_code",
  fires(
    "SELECT o.ucr_offense_code, o.offense_name FROM nibrs_offense_codes o ORDER BY o.ucr_offense_code",
    "nibrs-offense-codes-column"
  )
);

console.log("\n" + "═".repeat(60));
console.log(`SUMMARY: ${pass} passed, ${fail} failed out of ${pass + fail} tests`);
console.log("═".repeat(60));

if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) {
    console.log(`  ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  }
}

process.exit(fail > 0 ? 1 : 0);
