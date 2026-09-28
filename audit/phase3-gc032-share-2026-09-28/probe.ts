// Which statement form does the share proof refuse: as written, or after the rollup planner routes it?
// Usage: npx tsx audit/phase3-gc032-share-2026-09-28/probe.ts <out.json>
import "../../scripts/offline-evidence-guard";
import { writeFileSync } from "node:fs";
import { validateQueryContractSql } from "../../lib/query-contract-validator";
import { optimizeNibrsSql } from "../../lib/nibrs-sql-optimizer";
import { routeNibrsRollupSql } from "../../lib/nibrs-rollup-router";

const q = "what share of serious violent crimes in California are committed by youth under 18?";
const SCOPE = "d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025";
const YOUTH = "SUM(CASE WHEN d.age_group = 'Under 18' THEN d.offender_count ELSE 0 END)";
const SINGLE = `SELECT ROUND(100.0 * ${YOUTH} / SUM(d.offender_count), 1) AS youth_share_pct, ${YOUTH} AS youth_count, SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE ${SCOPE}`;
const RETAINED = "WITH youth_offenders AS (SELECT SUM(d.offender_count) AS youth_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.age_group = 'Under 18' AND d.year BETWEEN 2021 AND 2025), total_offenders AS (SELECT SUM(d.offender_count) AS total_count FROM summary_offender_demographics d WHERE d.state = 'CA' AND d.ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND d.year BETWEEN 2021 AND 2025) SELECT ROUND(100.0 * y.youth_count / t.total_count, 1) AS youth_share_pct, y.youth_count, t.total_count FROM youth_offenders y, total_offenders t";

const out: Record<string, unknown> = {};
for (const [id, sql] of Object.entries({ SINGLE, RETAINED })) {
  const routed = routeNibrsRollupSql(sql, true);
  let optimized: string | null = null;
  try { optimized = optimizeNibrsSql(sql, true as never); } catch (e) { optimized = `error: ${String(e)}`; }
  const verdict = (s: string) => { const v = validateQueryContractSql({ question: q, source: "nibrs", sql: s }); return { enforced: v.enforced, warnings: v.warnings }; };
  out[id] = { asWritten: verdict(sql), routed: { reason: routed.reason, sql: routed.sql, verdict: verdict(routed.sql) }, optimized };
  console.log(id, JSON.stringify({ asWritten: verdict(sql).enforced, routedReason: routed.reason, routed: verdict(routed.sql).enforced }));
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n");
