// Replays the retained comma-join alias witness (09-22 nine-case diagnosis) against the current tree.
// Usage: npx tsx audit/phase3-comma-alias-2026-09-28/replay.ts <out.json>
import { writeFileSync } from "node:fs";
import { findNibrsSqlIssues } from "../../lib/sql-guardrails";

const GC032 =
  "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";

// Saved witnesses first (identical text to diagnose-independent-witnesses.json), then added controls.
// expectFire: true = the alias rule must fire (unsafe/undeclared), false = must stay clean.
const cases: Array<{ name: string; sql: string; expectFire: boolean }> = [
  { name: "saved:comma-declared", sql: "SELECT a.x, b.y FROM t1 a, t2 b", expectFire: false },
  { name: "saved:join-declared", sql: "SELECT a.x, b.y FROM t1 a JOIN t2 b ON a.id = b.id", expectFire: false },
  { name: "saved:undeclared", sql: "SELECT a.x, zz.y FROM t1 a", expectFire: true },
  { name: "saved:GC-032-retained-sql", sql: GC032, expectFire: false },
  { name: "comma-AS-aliases", sql: "SELECT a.x, b.y FROM t1 AS a, t2 AS b", expectFire: false },
  { name: "comma-three-items", sql: "SELECT a.x, b.y, c.z FROM t1 a, t2 b, t3 c", expectFire: false },
  { name: "comma-subquery-item", sql: "SELECT a.x, s.n FROM t1 a, (SELECT COUNT(*) AS n FROM t2) s", expectFire: false },
  { name: "comma-then-join", sql: "SELECT a.x, b.y, c.z FROM t1 a, t2 b JOIN t3 c ON b.id = c.id", expectFire: false },
  { name: "comma-bare-table-qualifier", sql: "SELECT t1.x, t2.y FROM t1, t2", expectFire: false },
  { name: "comma-with-where", sql: "SELECT a.x, b.y FROM t1 a, t2 b WHERE a.id = b.id", expectFire: false },
  { name: "unsafe:comma-plus-undeclared", sql: "SELECT a.x, b.y, zz.q FROM t1 a, t2 b", expectFire: true },
  { name: "unsafe:select-list-comma-not-from", sql: "SELECT a.x, zz.y FROM t1 a WHERE a.x IN (1, 2)", expectFire: true },
  { name: "unsafe:alias-only-in-select-list", sql: "SELECT a.x, b FROM t1 a WHERE b.y = 1", expectFire: true },
  { name: "unsafe:after-where-comma", sql: "SELECT a.x FROM t1 a WHERE a.x IN (1, 2) AND zz.y = 1", expectFire: true },
  { name: "unsafe:group-by-comma", sql: "SELECT a.x, COUNT(*) FROM t1 a GROUP BY a.x, zz.y", expectFire: true },
];

const results = cases.map((c) => {
  const r = findNibrsSqlIssues(c.sql);
  const fires = r.fired.includes("nibrs-undeclared-table-alias");
  return { ...c, fired: r.fired, issues: r.issues, aliasRuleFires: fires, asExpected: fires === c.expectFire };
});
const summary = {
  at: new Date().toISOString(),
  total: results.length,
  asExpected: results.filter((r) => r.asExpected).length,
  failing: results.filter((r) => !r.asExpected).map((r) => r.name),
};
const out = process.argv[2];
if (out) writeFileSync(out, JSON.stringify({ summary, results }, null, 2) + "\n");
console.log(JSON.stringify(summary));
for (const r of results) console.log(`${r.asExpected ? "ok  " : "FAIL"} ${r.name} fires=${r.aliasRuleFires} expect=${r.expectFire}`);
process.exit(summary.failing.length === 0 ? 0 : 1);
