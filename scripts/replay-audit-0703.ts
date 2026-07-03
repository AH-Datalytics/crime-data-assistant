#!/usr/bin/env npx tsx
/** Replay July 2-3 audit queries (F22/F23/F27) through current guardrails. */
import { extractQueryContext } from "../lib/query-context.js";
import { runGuardrails } from "../lib/guardrails.js";

const CASES = [
  {
    id: "#4586 DV vs violent comparison (was guardrail_override:nibrs-cross-summary-join)",
    tab: "nibrs" as const,
    question: "have domestic violence trends followed the same patterns as other types of violent crime in the past 5 years",
    sql: `WITH dv_trends AS (SELECT data_year AS year, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS dv_incidents FROM summary_domestic_violence dv WHERE dv.data_year BETWEEN 2021 AND 2025 GROUP BY dv.data_year), violent_trends AS (SELECT year, SUM(victim_count) AS violent_crimes FROM summary_victim_state_monthly WHERE ucr_offense_code IN ('09A','11A','11B','11C','120','13A') AND year BETWEEN 2021 AND 2025 GROUP BY year) SELECT dv.year, dv.dv_incidents, vc.violent_crimes FROM dv_trends dv JOIN violent_trends vc ON dv.year = vc.year ORDER BY dv.year LIMIT 1000`,
  },
  {
    id: "#4587 IPV trend (returned 1/year, should rewrite to incident_count)",
    tab: "nibrs" as const,
    question: "how have intimate partner violence cases trended in the past 5 years",
    sql: `SELECT data_year AS year, SUM(CASE WHEN dv_category = 'intimate_partner' THEN 1 ELSE 0 END) AS intimate_partner_incidents FROM (SELECT dv.data_year, dv.dv_category, COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num) AS incident_count FROM summary_domestic_violence dv WHERE dv.data_year BETWEEN 2021 AND 2025 GROUP BY dv.data_year, dv.dv_category) GROUP BY data_year ORDER BY data_year LIMIT 1000`,
  },
  {
    id: "#4705 race/sex rates w/ total-US denominator (should now hard-refuse)",
    tab: "shr" as const,
    question: "Population by race and sex and rate per 100000",
    sql: `WITH offender_counts AS (SELECT i.year, i.off_race, i.off_sex, COUNT(*) as murder_count FROM incidents i JOIN victims v ON v.incident_id = i.id WHERE i.year BETWEEN 2000 AND 2026 AND i.homicide_type = 'Murder' GROUP BY i.year, i.off_race, i.off_sex) SELECT oc.year, oc.off_race, oc.off_sex, oc.murder_count, ROUND(oc.murder_count * 100000.0 / NULLIF(sp.population, 0), 1) as rate_per_100k FROM offender_counts oc JOIN state_population sp ON sp.state = 'US' AND sp.year = oc.year LIMIT 1000`,
  },
  {
    id: "#4704 per capita by race+sex, no SQL yet (should hard-refuse)",
    tab: "shr" as const,
    question: "i want ir in per capita seperated by race and sex",
    sql: `SELECT i.year, i.off_race, i.off_sex, COUNT(*) as murder_count FROM incidents i WHERE i.homicide_type = 'Murder' GROUP BY i.year, i.off_race, i.off_sex LIMIT 1000`,
  },
  {
    id: "FP check: overall murder rate per capita by state (should NOT refuse)",
    tab: "shr" as const,
    question: "murder rate per capita by state in 2024",
    sql: `SELECT i.state, COUNT(*) * 100000.0 / sp.population AS rate FROM incidents i JOIN state_population sp ON sp.state = i.state AND sp.year = 2024 WHERE i.year = 2024 GROUP BY i.state, sp.population LIMIT 1000`,
  },
  {
    id: "FP check: share of murders by race (percent, should NOT refuse)",
    tab: "shr" as const,
    question: "what percent of murders were committed by each race in 2020",
    sql: `SELECT off_race, COUNT(*) FROM incidents WHERE year = 2020 GROUP BY off_race LIMIT 1000`,
  },
];

for (const c of CASES) {
  const ctx = extractQueryContext(c.sql, c.question, c.tab);
  const r = runGuardrails(ctx);
  console.log(`\n${c.id}`);
  console.log(`  fired: ${JSON.stringify(r.fired)}`);
  console.log(`  override: ${r.overrideGuardrail ?? "none"}${r.overrideResponse ? ` -> ${r.overrideResponse.slice(0, 120)}...` : ""}`);
  console.log(`  retryIssues: ${r.issues.length}`);
  if (r.sql !== c.sql) console.log(`  REWRITTEN: ${r.sql.slice(0, 220)}`);
}
