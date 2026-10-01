// Does the lineage tracer fail GC-032 because of the comma join, or because of the CTE arithmetic?
import { writeFileSync } from "node:fs";
import { analyzeSql } from "../../lib/sql-lineage";
const GC032 = "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";
const forms = {
  comma: GC032,
  crossJoin: GC032.replace("FROM youth_offenders y, total_offenders t", "FROM youth_offenders y CROSS JOIN total_offenders t"),
  joinOn: GC032.replace("FROM youth_offenders y, total_offenders t", "FROM youth_offenders y JOIN total_offenders t ON 1 = 1"),
};
const out: Record<string, unknown> = {};
for (const [k, sql] of Object.entries(forms)) {
  const l = analyzeSql(sql) as unknown as { parsed: boolean; items: Array<{ alias: string | null; resolved: boolean; refs: unknown[] }> };
  out[k] = { parsed: l.parsed, items: l.items.map((i) => ({ alias: i.alias, resolved: i.resolved, refs: i.refs })) };
  console.log(k, JSON.stringify(out[k]));
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
