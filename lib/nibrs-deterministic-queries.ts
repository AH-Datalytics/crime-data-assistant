import { buildQueryContract, type QueryContractGeography, type QueryContractOffense } from "./query-contract";
import { pastCompleteCalendarYearsRange, relativeYearRangeForQuestion } from "./time-conventions";

export interface DeterministicNibrsQuery {
  sql: string;
  title: string;
  explanation: string;
  chartHint: "line" | "bar" | "pie" | "stacked_bar" | "scatter" | "none";
  xAxis: string;
  yAxis: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  guardrail: string;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function statePredicate(column: string, state: string | string[]): string {
  const states = Array.isArray(state) ? state : [state];
  if (states.length === 1) return `${column} = ${sqlString(states[0].toUpperCase())}`;
  return `${column} IN (${states.map((value) => sqlString(value.toUpperCase())).join(", ")})`;
}

function asksDomesticViolenceAggravatedAssaultShare(question: string): boolean {
  const asksShare = /\b(?:share|percent(?:age)?|pct|proportion|what\s+portion)\b/i.test(question);
  const asksAggAssault = /\baggravated\s+assaults?\b/i.test(question);
  const asksDv = /\bdomestic\s+violence\b|\bintimate\s+partner\b|\b(?<![a-z])dv(?![a-z])\b/i.test(question);
  return asksShare && asksAggAssault && asksDv;
}

interface YearScope {
  predicate: string;
  periodText: string;
}

function allAvailableYearsRequested(question: string): boolean {
  return /\b(?:all|every|available)\s+years?\b|\ball\s+available\s+data\b/i.test(question);
}

function yearScope(column: string, question: string): YearScope {
  const relative = relativeYearRangeForQuestion(question);
  const contract = buildQueryContract(question, "nibrs");
  const start = relative?.start ?? contract?.time.startYear ?? null;
  const end = relative?.end ?? contract?.time.endYear ?? null;

  if (start !== null && end !== null) {
    if (start === end) return { predicate: `${column} = ${start}`, periodText: " for the requested year" };
    return { predicate: `${column} BETWEEN ${start} AND ${end}`, periodText: " for the requested years" };
  }
  if (start !== null) return { predicate: `${column} >= ${start}`, periodText: " for the requested years" };
  if (end !== null) return { predicate: `${column} <= ${end}`, periodText: " for the requested years" };
  if (allAvailableYearsRequested(question)) return { predicate: "1 = 1", periodText: " over all available years" };

  const fallback = pastCompleteCalendarYearsRange(5);
  return {
    predicate: `${column} BETWEEN ${fallback.start} AND ${fallback.end}`,
    periodText: " for the default last five complete calendar years",
  };
}

function scopeForQuestion(question: string): {
  label: string;
  dvFilter: string;
  totalFilter: string;
} | null {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract) return null;

  if (contract.geography.kind === "state" && contract.geography.state) {
    const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
    return {
      label: `${contract.geography.canonicalName ?? contract.geography.name ?? contract.geography.state}`,
      dvFilter: statePredicate("state", sourceState),
      totalFilter: statePredicate("state", sourceState),
    };
  }

  if (contract.geography.kind === "national" || contract.geography.kind === "unknown") {
    return {
      label: "nationally",
      dvFilter: "1 = 1",
      totalFilter: "1 = 1",
    };
  }

  return null;
}

const PERSON_COUNT_CODES = new Set([
  "09A", "09B", "09C", "11A", "11B", "11C", "11D",
  "13A", "13B", "13C", "100", "36A", "36B",
]);

const SIMPLE_LOCAL_COUNT_ALIASES: Record<string, string> = {
  murder: "murders",
  rape: "rapes",
  robbery: "robberies",
  aggravated_assault: "aggravated_assaults",
  burglary: "burglaries",
  theft: "thefts",
  motor_vehicle_theft: "motor_vehicle_thefts",
};

function compactStatePredicate(column: string, state: string | string[]): string {
  return statePredicate(column, state).replace(/,\s+/g, ",");
}

function nibrsCityLiteral(name: string): string {
  const normalized = name.replace(/\s+/g, " ").trim().toUpperCase().replace(/\./g, "");
  if (normalized === "ST LOUIS") return "SAINT LOUIS";
  if (normalized === "ST PAUL") return "SAINT PAUL";
  return normalized;
}

function simpleLocalOffenseCodes(codes: string[]): string[] | null {
  if (codes.length === 0 || codes.length > 4) return null;
  const expanded: string[] = [];
  for (const code of codes) {
    if (!/^[0-9A-Z]{3}$/.test(code)) return null;
    expanded.push(code);
  }
  const usesPersonTable = expanded.some((code) => PERSON_COUNT_CODES.has(code));
  const usesOffenseTable = expanded.some((code) => !PERSON_COUNT_CODES.has(code));
  if (usesPersonTable && usesOffenseTable) return null;
  return expanded;
}

function hasSimpleLocalTimeIntent(question: string, startYear: number | null, endYear: number | null): boolean {
  return startYear !== null || endYear !== null ||
    /\b(?:by|per|each)\s+(?:year|month)\b|\bmonthly\b|\btrends?\b|\bsince\b|\bfrom\b|\bbetween\b|\blast\b|\bpast\b|\ball\s+available\b/i.test(question);
}

function isExcludedSimpleLocalQuestion(question: string): boolean {
  return /\b(?:rates?|per\s*(?:capita|100k|100,?000|10k|10,?000)|clearance|cleared|solve[ds]?|share|percent(?:age)?|ratio|compare|versus|vs\.?|top|highest|lowest|rank(?:ing)?|which\s+cit(?:y|ies)|by\s+(?:state|city|agency|race|sex|gender|age|ethnicity|weapon|injury|relationship|circumstance)|weapon|firearm|gun|shooting|shootings|domestic\s+violence|intimate\s+partner|demographic|continuous|consistent\s+report)/i.test(question);
}

function asksClearanceMethodBreakdown(question: string): boolean {
  const hasClearance = /\bclear(?:ance|ed|ing)\b/i.test(question);
  const hasArrest = /\b(?:by\s+)?arrest\b/i.test(question);
  const hasExceptional = /\bexception(?:al|ally)?(?:\s+means)?\b/i.test(question);
  return hasClearance && hasArrest && hasExceptional;
}

export function buildNibrsClearanceMethodQuery(
  question: string
): DeterministicNibrsQuery | null {
  if (!asksClearanceMethodBreakdown(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.offenseCodes.length !== 1) return null;
  if (contract.geography.kind !== "city" && contract.geography.kind !== "state") return null;

  const offenseCode = contract.metric.offenseCodes[0];
  const years = yearScope("sct.year", question);
  const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
  if (!sourceState) return null;

  let tableIndex: string;
  let geographyPredicate: string;
  let place: string;
  if (contract.geography.kind === "city" && contract.geography.name) {
    const city = nibrsCityLiteral(contract.geography.name);
    tableIndex = "idx_sct_ori_year";
    geographyPredicate = `sct.ori IN (
    SELECT DISTINCT ori
    FROM agencies
    WHERE city = ${sqlString(city)}
      AND ${compactStatePredicate("state", sourceState)}
      AND agency_type = 'City'
      AND population > 0
  )`;
    place = contract.geography.canonicalName ?? `${contract.geography.name}, ${contract.geography.state}`;
  } else {
    tableIndex = "idx_sct_state_year";
    geographyPredicate = compactStatePredicate("sct.state", sourceState);
    place = contract.geography.canonicalName ?? contract.geography.name ?? contract.geography.state ?? "the requested state";
  }

  const sql = `
SELECT sct.year,
  SUM(sct.total_offenses) AS total_offenses,
  SUM(sct.cleared_by_arrest) AS cleared_by_arrest,
  SUM(sct.cleared_exceptional) AS cleared_exceptional,
  ROUND(100.0 * SUM(sct.cleared_by_arrest) / NULLIF(SUM(sct.total_offenses), 0), 1) AS arrest_rate_pct,
  ROUND(100.0 * SUM(sct.cleared_exceptional) / NULLIF(SUM(sct.total_offenses), 0), 1) AS exceptional_rate_pct
FROM summary_clearance_type sct INDEXED BY ${tableIndex}
WHERE sct.ucr_offense_code = ${sqlString(offenseCode)}
  AND ${years.predicate}
  AND ${geographyPredicate}
GROUP BY sct.year
ORDER BY sct.year
LIMIT 1000`.trim();

  return {
    sql,
    title: `NIBRS clearance methods in ${place}`,
    explanation:
      `This compares offenses cleared by arrest with offenses cleared through exceptional means in ${place}${years.periodText}. ` +
      "Percentages use reported offenses as the denominator. Recent NIBRS data may be incomplete.",
    chartHint: "line",
    xAxis: "year",
    yAxis: "arrest_rate_pct,exceptional_rate_pct",
    xAxisLabel: "Year",
    yAxisLabel: "Clearance rate (%)",
    guardrail: "deterministic-nibrs-clearance-method",
  };
}

export function buildNibrsLocalCityOffenseCountQuery(
  question: string
): DeterministicNibrsQuery | null {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract) return null;
  if (contract.geography.kind !== "city" || !contract.geography.name || !contract.geography.state) return null;
  if (contract.metric.unit !== "count") return null;
  if (!hasSimpleLocalTimeIntent(question, contract.time.startYear, contract.time.endYear)) return null;
  if (isExcludedSimpleLocalQuestion(question)) return null;
  if (contract.comparability.continuousReporters) return null;
  if (contract.breakdowns.some((breakdown) => breakdown !== "year" && breakdown !== "month")) return null;
  if (contract.metric.topic === "violent_crime" || contract.metric.topic === "property_crime" || contract.metric.topic === "domestic_violence" || contract.metric.topic === "carjacking") return null;

  const codes = simpleLocalOffenseCodes(contract.metric.offenseCodes);
  if (!codes) return null;

  const usesPersonTable = codes.every((code) => PERSON_COUNT_CODES.has(code));
  const table = usesPersonTable ? "summary_victim_city_monthly" : "summary_city_monthly";
  const tableIndex = usesPersonTable ? "idx_svcm_ori" : "idx_scm_ori_year";
  const valueColumn = usesPersonTable ? "victim_count" : "offense_count";
  const alias = SIMPLE_LOCAL_COUNT_ALIASES[contract.metric.topic] ?? "offenses";
  const label = alias.replace(/_/g, " ");
  const city = nibrsCityLiteral(contract.geography.name);
  const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
  const factStateFilter = compactStatePredicate("state", sourceState);
  const agencyStateFilter = compactStatePredicate("state", sourceState);
  const years = yearScope("year", question);
  const monthly = contract.breakdowns.includes("month");
  const codePredicate = codes.length === 1
    ? `ucr_offense_code = ${sqlString(codes[0])}`
    : `ucr_offense_code IN (${codes.map(sqlString).join(",")})`;
  const selectColumns = monthly
    ? `year, month, SUM(${valueColumn}) AS ${alias}`
    : `year, SUM(${valueColumn}) AS ${alias}`;
  const groupOrder = monthly ? "year, month" : "year";

  const sql = `
SELECT ${selectColumns}
FROM ${table} INDEXED BY ${tableIndex}
WHERE ${codePredicate}
  AND ${factStateFilter}
  AND ${years.predicate}
  AND ori IN (
    SELECT DISTINCT ori
    FROM agencies
    WHERE city = ${sqlString(city)}
      AND ${agencyStateFilter}
      AND agency_type = 'City'
      AND population > 0
  )
GROUP BY ${groupOrder}
ORDER BY ${groupOrder}
LIMIT 1000`.trim();

  const place = contract.geography.canonicalName ?? `${contract.geography.name}, ${contract.geography.state}`;
  return {
    sql,
    title: `NIBRS ${label} in ${place}`,
    explanation:
      `This returns reported ${label} for ${place}${years.periodText}. ` +
      "If some requested years do not appear, this NIBRS dataset has no rows for that city and offense in those years. " +
      "Recent NIBRS data may be incomplete because agencies submit on different schedules.",
    chartHint: "line",
    xAxis: "year",
    yAxis: alias,
    xAxisLabel: monthly ? "Year / month" : "Year",
    yAxisLabel: label.charAt(0).toUpperCase() + label.slice(1),
    guardrail: "deterministic-nibrs-local-city-offense-count",
  };
}
function seriesKey(value: string): string {
  const key = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return key || "series";
}

function agencyDisplayName(value: string): string {
  return value
    .replace(/\bpolice\s+(?:department|dept\.?)\b/i, "Police Department")
    .replace(/\bcounty\s+sheriff(?:'?s)?(?:\s+office)?\b/i, "County Sheriff")
    .replace(/\s+/g, " ")
    .trim();
}

function agencyNamePredicate(column: string, name: string): string | null {
  const upper = name.toUpperCase();
  const location = upper
    .replace(/\bPOLICE\s+(?:DEPARTMENT|DEPT)\b/g, " ")
    .replace(/\bCOUNTY\s+SHERIFF(?:'?S)?(?:\s+OFFICE)?\b/g, " ")
    .replace(/\bSHERIFF(?:'?S)?(?:\s+OFFICE)?\b/g, " ")
    .replace(/\bCOUNTY\s+POLICE(?:\s+DEPARTMENT)?\b/g, " ")
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  if (!location) return null;

  const terms = ["UPPER(" + column + ") LIKE " + sqlString("%" + location + "%")];
  if (/\bSHERIFF\b/.test(upper)) terms.push("UPPER(" + column + ") LIKE '%SHERIFF%'");
  else if (/\bPOLICE\b/.test(upper)) terms.push("UPPER(" + column + ") LIKE '%POLICE%'");
  else return null;
  return terms.join(" AND ");
}

function structuredTargetSelect(geography: QueryContractGeography, index: number): {
  key: string;
  label: string;
  sql: string;
} | null {
  if (!geography.name || !geography.state || geography.confidence === "low") return null;

  const key = "place_" + (index + 1);
  const label = geography.kind === "agency"
    ? agencyDisplayName(geography.name)
    : geography.canonicalName ?? geography.name + ", " + geography.state;
  const sourceState = geography.sourceCodes?.nibrs ?? geography.state;
  const stateFilter = compactStatePredicate("state", sourceState);

  if (geography.kind === "city") {
    return {
      key,
      label,
      sql: [
        "SELECT DISTINCT " + sqlString(key) + " AS place_key, " + sqlString(label) + " AS place_label, ori",
        "    FROM agencies",
        "    WHERE city = " + sqlString(nibrsCityLiteral(geography.name)),
        "      AND " + stateFilter,
        "      AND agency_type = 'City'",
        "      AND population > 0",
      ].join("\n"),
    };
  }

  if (geography.kind !== "agency") return null;

  const cityPolice = geography.name.match(/^(.+?)\s+(?:city\s+)?police\s+(?:department|dept\.?)$/i);
  if (cityPolice) {
    return {
      key,
      label,
      sql: [
        "SELECT DISTINCT " + sqlString(key) + " AS place_key, " + sqlString(label) + " AS place_label, ori",
        "    FROM agencies",
        "    WHERE city = " + sqlString(nibrsCityLiteral(cityPolice[1])),
        "      AND " + stateFilter,
        "      AND agency_type = 'City'",
        "      AND population > 0",
      ].join("\n"),
    };
  }

  const sheriff = geography.name.match(/^(.+?)\s+county\s+sheriff(?:'?s)?(?:\s+office)?$/i);
  const sheriffLocation = sheriff?.[1].trim().toUpperCase();
  const namePredicate = sheriffLocation
    ? "UPPER(agency_name) LIKE " + sqlString("%" + sheriffLocation + "%") +
      " AND (UPPER(agency_name) LIKE '%SHERIFF%' OR UPPER(county_name) LIKE " +
      sqlString("%" + sheriffLocation + "%") + ")"
    : agencyNamePredicate("agency_name", geography.name);
  if (!namePredicate) return null;
  const crosswalkState = compactStatePredicate("state", sourceState);
  return {
    key,
    label,
    sql: [
      "SELECT DISTINCT " + sqlString(key) + " AS place_key, " + sqlString(label) + " AS place_label, ori9 AS ori",
      "    FROM agency_county_crosswalk",
      "    WHERE " + crosswalkState,
      "      AND ori9 IS NOT NULL",
      "      AND " + namePredicate,
      "    UNION",
      "    SELECT DISTINCT " + sqlString(key) + " AS place_key, " + sqlString(label) + " AS place_label, ori",
      "    FROM agency_county_crosswalk",
      "    WHERE " + crosswalkState,
      "      AND ori IS NOT NULL",
      "      AND " + namePredicate,
    ].join("\n"),
  };
}

function structuredOffenseSelect(
  offense: QueryContractOffense,
  targetCte: string,
  years: YearScope
): { key: string; label: string; sql: string } | null {
  if (offense.codes.length === 0 || offense.codes.some((code) => !/^[0-9A-Z]{3}$/.test(code))) return null;
  const usesPersonTable = offense.codes.every((code) => PERSON_COUNT_CODES.has(code));
  const usesOffenseTable = offense.codes.every((code) => !PERSON_COUNT_CODES.has(code));
  if (!usesPersonTable && !usesOffenseTable) return null;

  const table = usesPersonTable ? "summary_victim_city_monthly" : "summary_city_monthly";
  const tableIndex = usesPersonTable ? "idx_svcm_ori" : "idx_scm_ori_year";
  const valueColumn = usesPersonTable ? "victim_count" : "offense_count";
  const key = seriesKey(offense.topic);
  const codePredicate = offense.codes.length === 1
    ? "s.ucr_offense_code = " + sqlString(offense.codes[0])
    : "s.ucr_offense_code IN (" + offense.codes.map(sqlString).join(",") + ")";

  return {
    key,
    label: offense.label,
    sql: [
      "SELECT s.year, tp.place_key, " + sqlString(key) + " AS offense_key, SUM(s." + valueColumn + ") AS reported_count",
      "  FROM " + targetCte + " AS tp",
      "  CROSS JOIN " + table + " AS s INDEXED BY " + tableIndex,
      "  WHERE s.ori = tp.ori",
      "    AND " + codePredicate,
      "    AND " + years.predicate.replace(/\byear\b/g, "s.year"),
      "  GROUP BY s.year, tp.place_key",
    ].join("\n"),
  };
}

function isExcludedStructuredLocalQuestion(question: string): boolean {
  return /\b(?:rates?|per\s*(?:capita|100k|100,?000|10k|10,?000)|clearance|cleared|solve[ds]?|share|percent(?:age)?|ratio|top|highest|lowest|rank(?:ing)?|by\s+(?:state|city|agency|race|sex|gender|age|ethnicity|weapon|injury|relationship|circumstance)|weapon|firearm|gun|shooting|shootings|domestic\s+violence|intimate\s+partner|demographic|continuous|consistent\s+report)\b/i.test(question);
}

export function buildNibrsStructuredLocalTrendQuery(
  question: string
): DeterministicNibrsQuery | null {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.unit !== "count") return null;
  if (contract.metric.offenses.length === 0 || contract.metric.offenses.length > 4) return null;
  const allCodes = contract.metric.offenses.flatMap((offense) => offense.codes);
  if (new Set(allCodes).size !== allCodes.length) return null;
  if (contract.geographies.length === 0 || contract.geographies.length > 4) return null;
  if (contract.metric.offenses.length === 1 && contract.geographies.length === 1) return null;
  if (contract.geographies.some((geography) => !["city", "agency"].includes(geography.kind))) return null;
  if (contract.breakdowns.includes("month")) return null;
  if (contract.breakdowns.some((breakdown) => breakdown !== "year")) return null;
  if (!hasSimpleLocalTimeIntent(question, contract.time.startYear, contract.time.endYear)) return null;
  if (isExcludedStructuredLocalQuestion(question)) return null;
  if (contract.comparability.continuousReporters) return null;

  const targets = contract.geographies.map(structuredTargetSelect);
  if (targets.some((target) => target === null)) return null;
  const resolvedTargets = targets.filter((target): target is NonNullable<typeof target> => target !== null);
  const targetCte = "target_places";
  const years = yearScope("year", question);
  const offenses = contract.metric.offenses.map((offense) => structuredOffenseSelect(offense, targetCte, years));
  if (offenses.some((offense) => offense === null)) return null;
  const resolvedOffenses = offenses.filter((offense): offense is NonNullable<typeof offense> => offense !== null);

  const aliases = new Set<string>();
  const series: { alias: string; placeKey: string; offenseKey: string }[] = [];
  for (const target of resolvedTargets) {
    for (const offense of resolvedOffenses) {
      let alias = seriesKey(target.label + "_" + offense.label);
      let suffix = 2;
      while (aliases.has(alias)) alias = seriesKey(target.label + "_" + offense.label) + "_" + suffix++;
      aliases.add(alias);
      series.push({
        alias,

        placeKey: target.key,
        offenseKey: offense.key,
      });
    }
  }

  const pivotColumns = series.map((item) =>
    "COALESCE(SUM(CASE WHEN place_key = " + sqlString(item.placeKey) +
    " AND offense_key = " + sqlString(item.offenseKey) +
    " THEN reported_count END), 0) AS " + item.alias
  );
  const sql = [
    "WITH " + targetCte + " AS (",
    "  " + resolvedTargets.map((target) => target.sql).join("\n  UNION\n  "),
    "),",
    "series_counts AS (",
    "  " + resolvedOffenses.map((offense) => offense.sql).join("\n  UNION ALL\n  "),
    ")",
    "SELECT year,",
    "  " + pivotColumns.join(",\n  "),
    "FROM series_counts",
    "GROUP BY year",
    "ORDER BY year",
    "LIMIT 1000",
  ].join("\n");

  const places = resolvedTargets.map((target) => target.label).join(" and ");
  const offenseLabels = resolvedOffenses.map((offense) => offense.label.toLowerCase()).join(", ");
  return {
    sql,
    title: "NIBRS offense trends for " + places,
    explanation:
      "This returns annual reported " + offenseLabels + " for " + places + years.periodText + ". " +
      "Named city police departments are resolved to city-agency ORIs; named sheriff agencies are resolved through the agency crosswalk. " +
      "Person crimes use victim summaries while robbery and other non-person offenses use offense summaries. Recent NIBRS data may be incomplete.",
    chartHint: "line",
    xAxis: "year",
    yAxis: series.map((item) => item.alias).join(","),
    xAxisLabel: "Year",
    yAxisLabel: "Reported count",
    guardrail: "deterministic-nibrs-structured-local-trend",
  };
}

export function buildNibrsDomesticViolenceAggravatedAssaultShareQuery(
  question: string
): DeterministicNibrsQuery | null {
  if (!asksDomesticViolenceAggravatedAssaultShare(question)) return null;

  const scope = scopeForQuestion(question);
  if (!scope) return null;

  const years = yearScope("year", question);
  const dvYearFilter = years.predicate;
  const totalYearFilter = years.predicate;
  const periodText = years.periodText;

  const sql = `
WITH dv AS (
  SELECT year, SUM(victim_count) AS domestic_violence_aggravated_assault_victims
  FROM summary_victim_circumstance
  WHERE ucr_offense_code = '13A'
    AND circumstance_code = '06'
    AND ${scope.dvFilter}
    AND ${dvYearFilter}
  GROUP BY year
),
total AS (
  SELECT year, SUM(victim_count) AS total_aggravated_assault_victims
  FROM summary_victim_state_monthly
  WHERE ucr_offense_code = '13A'
    AND ${scope.totalFilter}
    AND ${totalYearFilter}
  GROUP BY year
)
SELECT total.year,
  COALESCE(dv.domestic_violence_aggravated_assault_victims, 0) AS domestic_violence_aggravated_assault_victims,
  total.total_aggravated_assault_victims,
  ROUND(
    100.0 * COALESCE(dv.domestic_violence_aggravated_assault_victims, 0) /
      NULLIF(total.total_aggravated_assault_victims, 0),
    1
  ) AS domestic_violence_share_pct
FROM total
LEFT JOIN dv ON dv.year = total.year
WHERE total.total_aggravated_assault_victims > 0
ORDER BY total.year
LIMIT 1000`.trim();

  const title = `Domestic Violence Share of Aggravated Assaults`;
  const explanation =
    `This shows the share of aggravated-assault victims ${scope.label} whose NIBRS circumstance was coded as domestic violence${periodText}. ` +
    "The numerator is victim_count from summary_victim_circumstance where ucr_offense_code = '13A' and circumstance_code = '06'. " +
    "The denominator is all aggravated-assault victim_count from summary_victim_state_monthly at the same year and geography. " +
    "Note: This data comes from the FBI's NIBRS program. Not all agencies report to this system, and recent data may be incomplete.";

  return {
    sql,
    title,
    explanation,
    chartHint: "line",
    xAxis: "year",
    yAxis: "domestic_violence_share_pct",
    xAxisLabel: "Year",
    yAxisLabel: "Domestic violence share (%)",
    guardrail: "deterministic-nibrs-dv-assault-share",
  };
}
