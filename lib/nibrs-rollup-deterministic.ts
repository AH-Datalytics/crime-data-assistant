import { buildQueryContract } from "./query-contract";
import { pastCompleteCalendarYearsRange } from "./time-conventions";
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Priority path for the recurring 38-second juvenile-arrests-by-race query. */
export function buildNibrsJuvenileArrestsByRaceQuery(
  question: string,
  rollupAvailable: boolean
): DeterministicNibrsQuery | null {
  if (!rollupAvailable) return null;
  if (!/\b(?:juvenile|youth|under\s*18)\b/i.test(question) || !/\barrests?\b/i.test(question) || !/\b(?:by|breakdown)\s+race\b/i.test(question)) return null;
  if (/\b(?:continuous(?:ly)?|consistent(?:ly)?|city|county|agency|ori)\b/i.test(question)) return null;

  const contract = buildQueryContract(question, "nibrs");
  if (!contract || (contract.geography.kind !== "state" && contract.geography.kind !== "national" && contract.geography.kind !== "unknown")) return null;
  const fallback = pastCompleteCalendarYearsRange(5);
  const start = contract.time.startYear ?? fallback.start;
  const end = contract.time.endYear ?? fallback.end;
  const offenseFilter = contract.metric.offenseCodes.length
    ? `\n  AND d.ucr_arrest_offense IN (${contract.metric.offenseCodes.map(sqlString).join(", ")})`
    : "";

  const isState = contract.geography.kind === "state" && Boolean(contract.geography.state);
  const stateCodes = isState ? (contract.geography.sourceCodes?.nibrs ?? contract.geography.state) : null;
  const table = isState ? "rollup.state_summary_arrestee_demographics" : "rollup.national_summary_arrestee_demographics";
  const stateFilter = Array.isArray(stateCodes)
    ? `\n  AND d.state IN (${stateCodes.map(sqlString).join(", ")})`
    : stateCodes ? `\n  AND d.state = ${sqlString(stateCodes)}` : "";
  const place = isState ? (contract.geography.canonicalName ?? contract.geography.name ?? contract.geography.state!) : "the United States";
  const sql = `SELECT
  CASE d.race
    WHEN 'W' THEN 'White'
    WHEN 'B' THEN 'Black'
    WHEN 'I' THEN 'American Indian or Alaska Native'
    WHEN 'A' THEN 'Asian'
    WHEN 'P' THEN 'Native Hawaiian or Pacific Islander'
    ELSE 'Unknown'
  END AS race,
  SUM(d.arrestee_count) AS arrests
FROM ${table} d
WHERE d.age_group = 'Under 18'
  AND d.year BETWEEN ${start} AND ${end}${stateFilter}${offenseFilter}
GROUP BY d.race
ORDER BY arrests DESC
LIMIT 1000`;

  return {
    sql,
    title: `Juvenile arrests by race in ${place}`,
    explanation: `This shows NIBRS arrests of people in the Under 18 age group by race in ${place} from ${start} through ${end}. NIBRS coverage varies by state and year, and recent data may be incomplete.`,
    chartHint: "bar",
    xAxis: "race",
    yAxis: "arrests",
    xAxisLabel: "Race",
    yAxisLabel: "Arrests",
    guardrail: "deterministic-nibrs-rollup-juvenile-arrests-race",
  };
}

