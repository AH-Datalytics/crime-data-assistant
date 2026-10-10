import { buildQueryContract, hasCodelessFamily } from "./query-contract";
import { pastCompleteCalendarYearsRange } from "./time-conventions";
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";
import { appliedFromContract } from "./nibrs-legacy-binding";

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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
    applied: appliedFromContract(contract, { startYear: start, endYear: end, defaulted: contract.time.startYear === null }, {
      ...(contract.metric.offenseCodes.length ? {} : { codeGroups: [], allOffenses: true }),
      units: ["arrests"], statistic: "count", filters: ["age:Under 18"], breakdowns: ["race"],
    }),
  };
}

/** Fast path for national arrest totals and offense trends that otherwise scan the agency rollup. */
export function buildNibrsNationalArrestQuery(
  question: string,
  rollupAvailable: boolean
): DeterministicNibrsQuery | null {
  if (!rollupAvailable || !/\barrests?\b/i.test(question)) return null;
  if (/\b(?:city|county|agency|department|sheriff|ori|continuous(?:ly)?|consistent(?:ly)?)\b/i.test(question)) return null;
  if (/\b(?:race|racial|ethnicity|hispanic|latino|sex|gender|age|juvenile|youth|weapon|rate|per\s*(?:capita|100k|100,?000)|share|percent|monthly|by\s+month)\b/i.test(question)) return null;

  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
  if (!contract) return null;
  const explicitlyNational = /\b(?:national(?:ly)?|nationwide|united states|america)\b|\bu\.?s\.?(?:\s|$)/i.test(question);
  const implicitNational = contract.geography.kind === "unknown";
  if (contract.geography.kind !== "national" && !explicitlyNational && !implicitNational) return null;

  const fallback = pastCompleteCalendarYearsRange(5);
  const start = contract.time.startYear ?? fallback.start;
  const end = contract.time.endYear ?? fallback.end;
  const codes = contract.metric.offenseCodes;
  const offenseFilter = codes.length
    ? `\n  AND d.ucr_arrest_offense IN (${codes.map(sqlString).join(", ")})`
    : "";
  const byOffense = /\b(?:by|breakdown\s+(?:by|of))\s+offense(?:\s+(?:type|code))?\b|\boffense\s+(?:type|code|breakdown)\b/i.test(question);
  const offenseLabel = `CASE d.ucr_arrest_offense
    WHEN '09A' THEN 'Murder and nonnegligent manslaughter'
    WHEN '11A' THEN 'Rape'
    WHEN '11B' THEN 'Sodomy'
    WHEN '11C' THEN 'Sexual assault with an object'
    WHEN '120' THEN 'Robbery'
    WHEN '13A' THEN 'Aggravated assault'
    ELSE d.ucr_arrest_offense
  END`;
  const sql = byOffense
    ? `SELECT
  d.year,
  ${offenseLabel} AS offense,
  SUM(d.arrestee_count) AS arrests
FROM rollup.national_summary_arrestee_demographics d
WHERE d.year BETWEEN ${start} AND ${end}${offenseFilter}
GROUP BY d.year, d.ucr_arrest_offense
ORDER BY d.year, offense
LIMIT 1000`
    : `SELECT
  d.year,
  SUM(d.arrestee_count) AS arrests
FROM rollup.national_summary_arrestee_demographics d
WHERE d.year BETWEEN ${start} AND ${end}${offenseFilter}
GROUP BY d.year
ORDER BY d.year
LIMIT 1000`;

  const topic = contract.metric.topic === "unknown" ? "all reported offenses" : contract.metric.offenses.map((item) => item.label.toLowerCase()).join(", ");
  return {
    sql,
    title: byOffense ? "National NIBRS arrests by offense" : "National NIBRS arrests",
    explanation: `This shows NIBRS arrest counts for ${topic} in the United States from ${start} through ${end}. Counts reflect participating NIBRS agencies and are not a complete national arrest census; recent data may be incomplete.`,
    chartHint: "line",
    xAxis: "year",
    yAxis: "arrests",
    xAxisLabel: "Year",
    yAxisLabel: "Arrests",
    guardrail: "deterministic-nibrs-rollup-national-arrests",
    applied: appliedFromContract({ ...contract, geographies: [], geography: { ...contract.geography, kind: "national" } }, { startYear: start, endYear: end, defaulted: contract.time.startYear === null }, {
      ...(codes.length ? {} : { codeGroups: [], allOffenses: true }),
      units: ["arrests"], statistic: "count", grains: ["year"],
    }),
  };
}

