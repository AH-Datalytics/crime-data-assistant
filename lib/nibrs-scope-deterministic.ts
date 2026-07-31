import { buildQueryContract, type QueryContract } from "./query-contract";
import { pastCompleteCalendarYearsRange } from "./time-conventions";
import type { DeterministicNibrsQuery } from "./nibrs-deterministic-queries";

type DemoDimension = "age_group" | "race" | "sex" | "ethnicity";
type RoleConfig = {
  table: string;
  offenseColumn: string;
  countColumn: string;
  countAlias: string;
};

const VIOLENT_CODES = ["09A", "11A", "11B", "11C", "120", "13A"];
const PERSON_CODES = new Set(VIOLENT_CODES);

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function yearRange(contract: QueryContract): { start: number; end: number } {
  const fallback = pastCompleteCalendarYearsRange(5);
  return {
    start: contract.time.startYear ?? fallback.start,
    end: contract.time.endYear ?? contract.time.startYear ?? fallback.end,
  };
}

function offenseCodes(question: string, contract: QueryContract): string[] {
  if (contract.metric.offenseCodes.length) return contract.metric.offenseCodes;
  return /\bviolent\s+(?:crime|crimes|offenses?)\b/i.test(question) ? VIOLENT_CODES : [];
}

function dimension(contract: QueryContract): DemoDimension | null {
  const values = contract.breakdowns.filter((value): value is DemoDimension =>
    ["age_group", "race", "sex", "ethnicity"].includes(value)
  );
  return values.length === 1 ? values[0] : null;
}

function role(question: string): RoleConfig | null {
  if (/\boffenders?\b/i.test(question)) {
    return { table: "summary_offender_demographics", offenseColumn: "ucr_offense_code", countColumn: "offender_count", countAlias: "offenders" };
  }
  if (/\barrests?|arrestees?\b/i.test(question)) {
    return { table: "summary_arrestee_demographics", offenseColumn: "ucr_arrest_offense", countColumn: "arrestee_count", countAlias: "arrests" };
  }
  if (/\bvictims?\b/i.test(question)) {
    return { table: "summary_victim_demographics", offenseColumn: "ucr_offense_code", countColumn: "victim_count", countAlias: "victims" };
  }
  return null;
}

function dimensionExpression(column: string, value: DemoDimension): string {
  if (value === "race") {
    return `CASE UPPER(COALESCE(NULLIF(TRIM(${column}), ''), 'U'))
      WHEN 'W' THEN 'White' WHEN 'B' THEN 'Black or African American'
      WHEN 'A' THEN 'Asian' WHEN 'I' THEN 'American Indian or Alaska Native'
      WHEN 'P' THEN 'Native Hawaiian or Other Pacific Islander' ELSE 'Unknown' END`;
  }
  if (value === "sex") {
    return `CASE UPPER(COALESCE(NULLIF(TRIM(${column}), ''), 'U'))
      WHEN 'M' THEN 'Male' WHEN 'F' THEN 'Female' ELSE 'Unknown' END`;
  }
  return `COALESCE(NULLIF(TRIM(${column}), ''), 'Unknown')`;
}

function stateCode(contract: QueryContract): string | null {
  const explicit = contract.geographies.find((geo) => geo.kind === "state" && geo.state);
  const value = explicit?.sourceCodes?.nibrs ?? explicit?.state;
  if (Array.isArray(value)) return value.length === 1 ? value[0] : null;
  return value ?? null;
}

function countShape(codes: string[]): RoleConfig | null {
  if (!codes.every((code) => PERSON_CODES.has(code))) return null;
  return { table: "summary_victim_city_monthly", offenseColumn: "ucr_offense_code", countColumn: "victim_count", countAlias: "victims" };
}

function buildScopedSql(
  config: RoleConfig,
  codes: string[],
  range: { start: number; end: number },
  demo: DemoDimension | null,
  extraPredicates: string[]
): string {
  const demoExpr = demo ? dimensionExpression(`d.${demo}`, demo) : null;
  const selectDemo = demoExpr ? `,\n  ${demoExpr} AS ${demo}` : "";
  const groupDemo = demo ? `, ${demo}` : "";
  return `SELECT
  d.year${selectDemo},
  SUM(d.${config.countColumn}) AS ${config.countAlias}
FROM ${config.table} d
WHERE d.${config.offenseColumn} IN (${codes.map(sqlString).join(", ")})
  AND d.year BETWEEN ${range.start} AND ${range.end}
  AND ${extraPredicates.join("\n  AND ")}
GROUP BY d.year${groupDemo}
ORDER BY d.year${demo ? `, ${demo}` : ""}
LIMIT 1000`;
}

export function buildNibrsContinuousReporterQuery(question: string): DeterministicNibrsQuery | null {
  if (!/\b(?:continuous(?:ly)?|consistent(?:ly)?\s+report(?:ing|ers?)?|reported\s+all\s+12\s+months|reported\s+every\s+year)\b/i.test(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.unit !== "count" || !contract.comparability.continuousReporters) return null;
  if (contract.geographies.some((geo) => ["city", "county", "campus"].includes(geo.kind) || Boolean(geo.name))) return null;
  if (/\b(?:rate|per\s*(?:capita|100k|100,?000)|share|percent(?:age)?|monthly|by\s+month)\b/i.test(question)) return null;

  const codes = offenseCodes(question, contract);
  if (!codes.length) return null;
  const demo = dimension(contract);
  const config = demo ? role(question) : countShape(codes);
  if (!config) return null;
  const range = yearRange(contract);
  const reporterEnd = Math.min(range.end, new Date().getFullYear() - 1);
  if (range.start > reporterEnd) return null;

  const predicates = [
    `d.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = ${range.start} AND end_year = ${reporterEnd})`,
  ];
  const state = stateCode(contract);
  if (state) predicates.push(`d.state = ${sqlString(state)}`);
  const sql = buildScopedSql(config, codes, range, demo, predicates);
  const scope = state ? ` in ${contract.geographies.find((geo) => geo.kind === "state")?.canonicalName ?? state}` : "";
  const breakdown = demo ? ` by ${demo.replace("_", " ")}` : "";
  const partial = range.end > reporterEnd
    ? ` The ${range.end} rows are partial; reporter eligibility is based on complete reporting through ${reporterEnd}.`
    : "";
  return {
    sql,
    title: `Continuous-reporting NIBRS ${config.countAlias}${breakdown}`,
    explanation: `This shows ${config.countAlias}${breakdown}${scope} from ${range.start} through ${range.end}, restricted to agencies that reported all 12 months in every complete year from ${range.start} through ${reporterEnd}.${partial} NIBRS participation still limits comparability outside this fixed agency set.`,
    chartHint: "line",
    xAxis: "year",
    yAxis: config.countAlias,
    xAxisLabel: "Year",
    yAxisLabel: config.countAlias[0].toUpperCase() + config.countAlias.slice(1),
    guardrail: "deterministic-nibrs-continuous-reporters",
  };
}

export function buildNibrsCountywideDemographicQuery(question: string): DeterministicNibrsQuery | null {
  if (!/\bcountywide\b/i.test(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.unit !== "count" || contract.comparability.continuousReporters) return null;
  if (/\b(?:rate|per\s*(?:capita|100k|100,?000)|share|percent(?:age)?|monthly|by\s+month)\b/i.test(question)) return null;
  const county = contract.geographies.find((geo) => geo.kind === "county" && geo.name);
  const state = stateCode(contract);
  if (!county?.name || !state) return null;

  const codes = offenseCodes(question, contract);
  if (!codes.length) return null;
  const demo = dimension(contract);
  const config = demo ? role(question) : countShape(codes);
  if (!config) return null;
  const range = yearRange(contract);
  const countyKey = county.name.replace(/\s+county\b/i, "").trim().toUpperCase();
  if (!countyKey) return null;
  const oriFilter = `d.ori IN (
    SELECT DISTINCT a.ori
    FROM agencies a
    JOIN agency_county_crosswalk ac
      ON a.ori = ac.ori9 OR SUBSTR(a.ori, 1, 7) = ac.ori
    WHERE UPPER(ac.county_key) = ${sqlString(countyKey)}
      AND ac.state = ${sqlString(state)}
      AND a.year BETWEEN ${range.start} AND ${range.end}
  )`;
  const sql = buildScopedSql(config, codes, range, demo, [oriFilter]);
  const breakdown = demo ? ` by ${demo.replace("_", " ")}` : "";
  const stateName = contract.geographies.find((geo) => geo.kind === "state")?.canonicalName ?? state;
  return {
    sql,
    title: `${countyKey} County NIBRS ${config.countAlias}${breakdown}`,
    explanation: `This shows ${config.countAlias}${breakdown} for all NIBRS agencies mapped to ${countyKey} County, ${stateName}, from ${range.start} through ${range.end}. Countywide totals depend on each mapped agency's NIBRS participation and should not be treated as complete county estimates when reporting is incomplete.`,
    chartHint: "line",
    xAxis: "year",
    yAxis: config.countAlias,
    xAxisLabel: "Year",
    yAxisLabel: config.countAlias[0].toUpperCase() + config.countAlias.slice(1),
    guardrail: "deterministic-nibrs-countywide-demographic",
  };
}
