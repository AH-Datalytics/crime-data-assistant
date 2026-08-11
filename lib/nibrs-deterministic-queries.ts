import { buildQueryContract, type QueryContractGeography, type QueryContractOffense } from "./query-contract";
import { pastCompleteCalendarYearsRange, relativeYearRangeForQuestion } from "./time-conventions";
import { hasUnresolvedDemographicToken } from "./demographic-rate-intent";
import { asksClearanceTypeBreakdown } from "./clearance-type-intent";
import {
  resolvedPlaceForContractIndex,
  type NibrsPlaceResolutionPlan,
} from "./nibrs-place-resolver";
import {
  NIBRS_COMPLETENESS_PROXY_DISCLOSURE,
  NIBRS_COUNT_COMPLETENESS_DISCLOSURE,
  NIBRS_RECENT_MATURATION_DISCLOSURE,
  nibrsAnnualValueSql,
  nibrsDemographicCompletenessPredicate,
} from "./nibrs-completeness";
import incidentOffenseScopes from "./nibrs-incident-offense-scopes.json";

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

export function asksForIncidentsWithJuvenileOffender(question: string): boolean {
  return /\b(?:incidents?|crimes?)\b/i.test(question) &&
    /\boffenders?\b/i.test(question) &&
    /\b(?:under|younger\s+than|below)\s+(?:age\s*)?18\b/i.test(question);
}

export function buildNibrsJuvenileOffenderIncidentQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (!asksForIncidentsWithJuvenileOffender(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.unit !== "count") return null;

  const knownScopes = incidentOffenseScopes as Record<string, string[]>;
  const offenseScope = knownScopes[contract.metric.topic]
    ? contract.metric.topic
    : contract.metric.offenseCodes.length === 1 && /^[0-9A-Z]{3}$/.test(contract.metric.offenseCodes[0])
      ? contract.metric.offenseCodes[0]
      : null;
  if (!offenseScope) return null;

  const years = yearScope("s.year", question);
  const monthly = contract.breakdowns.includes("month");
  let geographyPredicate = "1 = 1";
  let placeLabel = "NIBRS-reporting agencies nationwide";

  if (contract.geography.kind === "state" && contract.geography.state) {
    const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
    geographyPredicate = statePredicate("s.state", sourceState);
    placeLabel = contract.geography.canonicalName ?? contract.geography.name ?? contract.geography.state;
  } else if (contract.geography.kind === "city" || contract.geography.kind === "agency") {
    const resolved = resolvedPlaceForContractIndex(resolutionPlan, 0);
    if (!resolved || resolved.oriYears.length === 0) return null;
    geographyPredicate = "(" + resolved.oriYears.map((item) =>
      `(s.ori = ${sqlString(item.ori)} AND s.year = ${item.year})`
    ).join(" OR ") + ")";
    placeLabel = resolved.label;
  } else if (contract.geography.kind !== "national" && contract.geography.kind !== "unknown") {
    return null;
  }

  const dimensions = monthly ? ["s.year", "s.month"] : ["s.year"];
  const selectDimensions = monthly ? "s.year, s.month" : "s.year";
  const offenseLabel = contract.metric.offenses[0]?.label ?? contract.metric.topic.replace(/_/g, " ");
  return {
    sql: `SELECT ${selectDimensions}, SUM(s.incident_count) AS juvenile_offender_incidents
FROM summary_juvenile_offender_incidents s
WHERE s.offense_scope = ${sqlString(offenseScope)}
  AND ${years.predicate}
  AND ${geographyPredicate}
${monthly ? "  AND s.month BETWEEN 1 AND 12\n" : ""}
GROUP BY ${dimensions.join(", ")}
ORDER BY ${dimensions.join(", ")}`,
    title: `${offenseLabel} Incidents With an Offender Under 18 — ${placeLabel}`,
    explanation: `Distinct ${offenseLabel.toLowerCase()} incidents with at least one known offender age 1-17 for ${placeLabel}. Incidents with multiple qualifying offenders or multiple offenses in the requested category are counted once. Unknown offender ages are not classified as juveniles. These are incidents reported to NIBRS, not a national estimate. ${NIBRS_RECENT_MATURATION_DISCLOSURE}`,
    chartHint: monthly || years.startYear !== years.endYear ? "line" : "bar",
    xAxis: monthly ? "month" : "year",
    yAxis: "juvenile_offender_incidents",
    xAxisLabel: monthly ? "Month" : "Year",
    yAxisLabel: "Incidents",
    guardrail: "deterministic-nibrs-juvenile-offender-incidents",
  };
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
  startYear: number | null;
  endYear: number | null;
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
    if (start === end) {
      return { predicate: `${column} = ${start}`, periodText: " for the requested year", startYear: start, endYear: end };
    }
    return {
      predicate: `${column} BETWEEN ${start} AND ${end}`,
      periodText: " for the requested years",
      startYear: start,
      endYear: end,
    };
  }
  if (start !== null) {
    return {
      predicate: `${column} >= ${start}`,
      periodText: " for the requested years",
      startYear: start,
      endYear: new Date().getFullYear(),
    };
  }
  if (end !== null) {
    return {
      predicate: `${column} <= ${end}`,
      periodText: " for the requested years",
      startYear: null,
      endYear: end,
    };
  }
  if (allAvailableYearsRequested(question)) {
    return { predicate: "1 = 1", periodText: " over all available years", startYear: null, endYear: null };
  }

  const fallback = pastCompleteCalendarYearsRange(5);
  return {
    predicate: `${column} BETWEEN ${fallback.start} AND ${fallback.end}`,
    periodText: " for the default last five complete calendar years",
    startYear: fallback.start,
    endYear: fallback.end,
  };
}

function requestedYearsSql(years: YearScope): string {
  if (years.startYear !== null && years.endYear !== null) {
    const values: string[] = [];
    for (let year = years.startYear; year <= years.endYear; year += 1) values.push(`(${year})`);
    return "VALUES " + values.join(", ");
  }
  return "SELECT DISTINCT year FROM nibrs_agency_completeness WHERE " + years.predicate;
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
  // "clearances" is at least as common as the singular; without the optional s
  // the plural skipped the deterministic path entirely and fell to the model.
  const hasClearance = /\bclear(?:ances?|ed|ing)\b/i.test(question);
  const hasArrest = /\b(?:by\s+)?arrest\b/i.test(question);
  const hasExceptional = /\bexception(?:al|ally)?(?:\s+means)?\b/i.test(question);
  return hasClearance && hasArrest && hasExceptional;
}

/**
 * Clearances broken out by every category, uncleared included.
 *
 * Production 8388 asked for Las Vegas murder clearances by type in 2025. The
 * model returned two rows: one labelled "Cleared by Arrest" that actually held
 * all six measures, and one labelled "Not Cleared" whose every numeric column
 * was the literal 0. The real answer is 82 offenses = 62 arrest + 11 death of
 * offender + 9 not cleared. A renderer can draw that payload perfectly and still
 * show a chart that is wrong, so the fix belongs here, in the shape of the data.
 *
 * Emits tidy long format -- one row per category per year -- because that is what
 * a categorical chart needs, and because a wide row invites exactly the
 * mislabelling 8388 produced.
 */
export function buildNibrsClearanceTypeBreakdownQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (!asksClearanceTypeBreakdown(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.offenseCodes.length !== 1) return null;
  if (contract.geography.kind !== "city" && contract.geography.kind !== "state") return null;
  // One geography predicate only -- see buildNibrsClearanceMethodQuery.
  if ((contract.geographies?.length ?? 0) > 1) return null;

  const offenseCode = contract.metric.offenseCodes[0];
  const years = yearScope("scd.year", question);
  const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
  if (!sourceState) return null;

  let tableIndex: string;
  let geographyPredicate: string;
  let place: string;
  if (contract.geography.kind === "city") {
    const resolvedCity = resolutionPlan?.places.find(
      (item) => item.status === "resolved" && item.kind === "city_police"
    );
    const oris = [...new Set(resolvedCity?.oriYears.map((item) => item.ori) ?? [])];
    if (oris.length === 0) return null;
    tableIndex = "idx_scd_ori_year";
    geographyPredicate = `scd.ori IN (${oris.map(sqlString).join(", ")})`;
    place = resolvedCity?.label ?? `${contract.geography.name}, ${contract.geography.state}`;
  } else {
    tableIndex = "idx_scd_state_year";
    geographyPredicate = compactStatePredicate("scd.state", sourceState);
    place = contract.geography.canonicalName ?? contract.geography.name ?? contract.geography.state ?? "the requested state";
  }

  // Not cleared is derived, never assumed. It is deliberately NOT clamped at
  // zero: no murder row in any year has clearances exceeding offenses, so a
  // negative here would be a real data problem and should be visible rather
  // than quietly rounded away.
  const categories: [string, string][] = [
    ["Cleared by arrest", "t.cleared_by_arrest"],
    ["Death of offender", "t.cleared_a"],
    ["Prosecution declined", "t.cleared_b"],
    ["In custody elsewhere", "t.cleared_c"],
    ["Victim refused to cooperate", "t.cleared_d"],
    ["Juvenile, no custody", "t.cleared_e"],
    ["Not cleared", "t.total_offenses - (t.cleared_by_arrest + t.cleared_a + t.cleared_b + t.cleared_c + t.cleared_d + t.cleared_e)"],
  ];
  const branches = categories
    .map(([label, expr]) => `  SELECT t.year AS year, ${sqlString(label)} AS clearance_type, ${expr} AS offenses FROM totals t`)
    .join("\n  UNION ALL\n");
  const ordering = categories
    .map(([label], index) => `WHEN ${sqlString(label)} THEN ${index + 1}`)
    .join(" ");

  const sql = `
WITH totals AS (
  SELECT scd.year AS year,
    SUM(scd.total_offenses) AS total_offenses,
    SUM(scd.cleared_by_arrest) AS cleared_by_arrest,
    SUM(scd.cleared_A) AS cleared_a,
    SUM(scd.cleared_B) AS cleared_b,
    SUM(scd.cleared_C) AS cleared_c,
    SUM(scd.cleared_D) AS cleared_d,
    SUM(scd.cleared_E) AS cleared_e
  FROM summary_clearance_detail scd INDEXED BY ${tableIndex}
  WHERE scd.ucr_offense_code = ${sqlString(offenseCode)}
    AND ${years.predicate}
    AND ${geographyPredicate}
  GROUP BY scd.year
)
SELECT year, clearance_type, offenses FROM (
${branches}
)
ORDER BY year, CASE clearance_type ${ordering} END
LIMIT 1000`.trim();

  const offenseLabel = contract.metric.offenses?.[0]?.label ?? "offense";
  return {
    sql,
    title: `${place} ${offenseLabel} clearances by type`,
    explanation:
      `Every clearance category for ${offenseLabel} in ${place}${years.periodText}, with uncleared offenses shown as their own category so the parts sum to the reported total. ` +
      "FBI clearance means cleared by arrest or exceptional means; it is not a conviction. Recent NIBRS data may be incomplete.",
    chartHint: "bar",
    xAxis: "clearance_type",
    yAxis: "offenses",
    xAxisLabel: "Clearance type",
    yAxisLabel: "Offenses",
    guardrail: "deterministic-nibrs-clearance-type-breakdown",
  };
}

export function buildNibrsClearanceMethodQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (!asksClearanceMethodBreakdown(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.offenseCodes.length !== 1) return null;
  if (contract.geography.kind !== "city" && contract.geography.kind !== "state") return null;
  // This builder emits ONE geography predicate. Asked about several places it
  // would answer for whichever the contract happens to list first and drop the
  // rest without saying so -- the worst failure shape available, because the
  // answer looks complete. Hand multi-place requests to the model, where
  // resolvedOriEnforcementIssue checks every resolved place appears in the SQL.
  if ((contract.geographies?.length ?? 0) > 1) return null;

  const offenseCode = contract.metric.offenseCodes[0];
  const years = yearScope("sct.year", question);
  const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
  if (!sourceState) return null;

  let tableIndex: string;
  let geographyPredicate: string;
  let place: string;
  if (contract.geography.kind === "city" && contract.geography.name) {
    // Never select the agency by city name here. agencies.city is a mailing-city
    // field: 'SAINT LOUIS' matches 53 agencies, so the old predicate summed the
    // whole metro into one "St. Louis" clearance figure -- the same defect the
    // model path was producing, but inside the path that is supposed to be
    // trustworthy, and downstream of the ORI enforcement that catches it there.
    // Without a resolved agency there is nothing safe to build, so fall through
    // to the model, where that enforcement applies.
    const resolvedCity = resolutionPlan?.places.find(
      (item) => item.status === "resolved" && item.kind === "city_police"
    );
    const oris = [...new Set(resolvedCity?.oriYears.map((item) => item.ori) ?? [])];
    if (oris.length === 0) return null;
    tableIndex = "idx_sct_ori_year";
    geographyPredicate = `sct.ori IN (${oris.map(sqlString).join(", ")})`;
    place = resolvedCity?.label ?? contract.geography.canonicalName ?? `${contract.geography.name}, ${contract.geography.state}`;
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

function requestedPeerCount(question: string): number {
  const match = question.match(/\b(\d{1,2})\s+agencies\s+of\s+(?:similar|comparable)\s+size\b/i) ||
    question.match(/\b(\d{1,2})\s+(?:most\s+)?(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\b/i) ||
    question.match(/\b(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies\s*)?(\d{1,2})\b/i);
  return Math.max(1, Math.min(20, match ? Number(match[1]) : 5));
}

export function buildNibrsComparableAgencyClearanceQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (!/\b(?:clearance|clearances|cleared|solve[ds]?)\b/i.test(question) ||
      !/\b(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies|departments)|\bagencies\s+(?:of\s+)?(?:similar|comparable)\s+size\b/i.test(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || contract.metric.offenseCodes.length === 0 || !resolutionPlan) return null;
  const targets = resolutionPlan.places.filter((place) => place.status === "resolved" && place.kind === "city_police");
  if (targets.length !== 1 || resolutionPlan.places.length !== 1) return null;
  const target = targets[0];
  const targetYears = target.oriYears
    .filter((item) => item.year >= resolutionPlan.startYear && item.year <= resolutionPlan.endYear && item.population && item.population > 0);
  if (targetYears.length === 0) return null;
  const reference = [...targetYears].sort((a, b) => b.year - a.year)[0];
  const peerCount = requestedPeerCount(question);
  const codes = contract.metric.offenseCodes.map(sqlString).join(", ");
  const targetRows = targetYears.map((item) =>
    `(${item.year}, ${sqlString(item.ori)}, ${Number(item.population)})`
  ).join(",\n    ");
  const methodBreakdown = asksClearanceMethodBreakdown(question);
  const sql = `WITH
target_years(year, ori, population) AS (
  VALUES ${targetRows}
),
candidate_pool AS MATERIALIZED (
  SELECT a.ori,
    COALESCE(NULLIF(a.city, ''), a.ori) || ', ' || a.state AS agency_label,
    a.population
  FROM agencies a INDEXED BY idx_agencies_year_state_population
  WHERE a.year = ${reference.year}
    AND a.agency_type = 'City'
    AND a.population > 0
    AND a.ori <> ${sqlString(reference.ori)}
  ORDER BY ABS(a.population - ${Number(reference.population)}), a.ori
  LIMIT 100
),
target_data AS MATERIALIZED (
  SELECT 1 AS available
  FROM target_years ty
  CROSS JOIN summary_clearance_type target_probe INDEXED BY idx_sct_ori_year
  WHERE target_probe.ori = ty.ori
    AND target_probe.year = ty.year
    AND target_probe.ucr_offense_code IN (${codes})
  LIMIT 1
),
peer_candidates AS MATERIALIZED (
  SELECT cp.ori, cp.agency_label, cp.population
  FROM candidate_pool cp
  WHERE EXISTS (SELECT 1 FROM target_data)
    AND EXISTS (
      SELECT 1
      FROM summary_clearance_type probe INDEXED BY idx_sct_ori_year
      WHERE probe.ori = cp.ori
        AND probe.year BETWEEN ${resolutionPlan.startYear} AND ${resolutionPlan.endYear}
        AND probe.ucr_offense_code IN (${codes})
    )
  LIMIT ${peerCount}
),
selected_agencies(place_label, ori, effective_year) AS (
  SELECT ${sqlString(target.label)}, ty.ori, ty.year FROM target_years ty
  WHERE EXISTS (SELECT 1 FROM target_data)
  UNION ALL
  SELECT pc.agency_label, pc.ori, NULL FROM peer_candidates pc
),
clearances AS (
  SELECT sct.year, sa.place_label,
    SUM(sct.total_offenses) AS total_offenses,
    SUM(sct.cleared_by_arrest) AS cleared_by_arrest,
    SUM(sct.cleared_exceptional) AS cleared_exceptional
  FROM selected_agencies sa
  CROSS JOIN summary_clearance_type sct INDEXED BY idx_sct_ori_year
  WHERE sct.ori = sa.ori
    AND (sa.effective_year IS NULL OR sa.effective_year = sct.year)
    AND sct.year BETWEEN ${resolutionPlan.startYear} AND ${resolutionPlan.endYear}
    AND sct.ucr_offense_code IN (${codes})
  GROUP BY sct.year, sa.place_label
)
SELECT year, place_label,
  total_offenses,
  cleared_by_arrest,
  cleared_exceptional,
  ROUND(100.0 * (cleared_by_arrest + cleared_exceptional) / NULLIF(total_offenses, 0), 1) AS clearance_rate_pct,
  ROUND(100.0 * cleared_by_arrest / NULLIF(total_offenses, 0), 1) AS arrest_rate_pct,
  ROUND(100.0 * cleared_exceptional / NULLIF(total_offenses, 0), 1) AS exceptional_rate_pct
FROM clearances
ORDER BY year, place_label
LIMIT 1000`;

  const offenseLabel = contract.metric.offenses.map((item) => item.label.toLowerCase()).join(", ");
  return {
    sql,
    title: `${target.label} clearance rates and similar-size agencies`,
    explanation: `This compares ${offenseLabel} clearance rates for ${target.label} with the ${peerCount} city police agencies whose ${reference.year} service populations are closest to ${Number(reference.population).toLocaleString("en-US")}. ` +
      (methodBreakdown ? "Arrest and exceptional clearances are shown separately. " : "The overall rate includes arrest and exceptional clearances. ") +
      "Peer selection is based on agency service population, not broader socioeconomic similarity. Recent NIBRS data may be incomplete.",
    chartHint: "line",
    xAxis: "year",
    yAxis: methodBreakdown ? "arrest_rate_pct,exceptional_rate_pct" : "clearance_rate_pct",
    xAxisLabel: "Year",
    yAxisLabel: "Clearance rate (%)",
    guardrail: "deterministic-nibrs-comparable-agency-clearance",
  };
}

export function buildNibrsLocalCityOffenseCountQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
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
  const sourceState = contract.geography.sourceCodes?.nibrs ?? contract.geography.state;
  const factStateFilter = compactStatePredicate("s.state", sourceState);
  const years = yearScope("year", question);
  const monthly = contract.breakdowns.includes("month");
  const codePredicate = codes.length === 1
    ? `ucr_offense_code = ${sqlString(codes[0])}`
    : `ucr_offense_code IN (${codes.map(sqlString).join(",")})`;
  const currentYear = new Date().getFullYear();
  const target = structuredTargetSelect(contract.geography, 0, resolutionPlan);
  if (!target) return null;

  const sql = monthly
    ? `
WITH target_places AS (
  ${target.sql}
)
SELECT s.year, s.month, SUM(s.${valueColumn}) AS ${alias}
FROM target_places AS tp
CROSS JOIN ${table} AS s INDEXED BY ${tableIndex}
WHERE ${codePredicate.replace(/\bucr_offense_code\b/g, "s.ucr_offense_code")}
  AND ${factStateFilter}
  AND ${years.predicate.replace(/\byear\b/g, "s.year")}
  AND s.ori = tp.ori
  AND (tp.effective_year IS NULL OR tp.effective_year = s.year)
GROUP BY s.year, s.month
ORDER BY s.year, s.month
LIMIT 1000`.trim()
    : [
      "WITH target_places AS (",
      "  " + target.sql,
      "),",
      "requested_years(year) AS (" + requestedYearsSql(years) + "),",
      "current_year_reporting AS (",
      "  SELECT s.year, COUNT(DISTINCT s.month) AS summary_months_reported",
      "  FROM target_places AS tp",
      "  CROSS JOIN " + table + " AS s INDEXED BY " + tableIndex,
      "  WHERE s.ori = tp.ori AND s.year = " + currentYear,
      "    AND (tp.effective_year IS NULL OR tp.effective_year = s.year)",
      "  GROUP BY s.year",
      "),",
      "place_reporting AS (",
      "  SELECT y.year, MAX(c.months_reported) AS months_reported, MAX(cyr.summary_months_reported) AS summary_months_reported",
      "  FROM requested_years AS y",
      "  CROSS JOIN target_places AS tp",
      "  LEFT JOIN nibrs_agency_completeness AS c INDEXED BY idx_nac_ori_year",
      "    ON c.ori = tp.ori AND c.year = y.year",
      "  LEFT JOIN current_year_reporting AS cyr ON cyr.year = y.year",
      "  WHERE tp.effective_year IS NULL OR tp.effective_year = y.year",
      "  GROUP BY y.year",
      "),",
      "annual_counts AS (",
      "  SELECT s.year, SUM(s." + valueColumn + ") AS " + alias,
      "  FROM target_places AS tp",
      "  CROSS JOIN " + table + " AS s INDEXED BY " + tableIndex,
      "  WHERE s.ori = tp.ori",
      "    AND (tp.effective_year IS NULL OR tp.effective_year = s.year)",
      "    AND " + codePredicate.replace(/\bucr_offense_code\b/g, "s.ucr_offense_code"),
      "    AND " + years.predicate.replace(/\byear\b/g, "s.year"),
      "  GROUP BY s.year",
      ")",
      "SELECT pr.year,",
      "  " + nibrsAnnualValueSql({
        yearExpression: "pr.year",
        reportingMonthsExpression: "pr.months_reported",
        summaryMonthsExpression: "pr.summary_months_reported",
        valueExpression: "COALESCE(ac." + alias + ", 0)",
        unit: "count",
        currentYear,
      }) + " AS " + alias,
      "FROM place_reporting AS pr",
      "LEFT JOIN annual_counts AS ac ON ac.year = pr.year",
      "ORDER BY pr.year",
      "LIMIT 1000",
    ].join("\n");

  const place = contract.geography.canonicalName ?? `${contract.geography.name}, ${contract.geography.state}`;
  return {
    sql,
    title: `NIBRS ${label} in ${place}`,
    explanation:
      `This returns reported ${label} for ${place}${years.periodText}. ` +
      (monthly
        ? "Recent monthly NIBRS data may be incomplete because agencies submit on different schedules."
        : [NIBRS_COUNT_COMPLETENESS_DISCLOSURE, NIBRS_COMPLETENESS_PROXY_DISCLOSURE, NIBRS_RECENT_MATURATION_DISCLOSURE].join(" ")),
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

function structuredTargetSelect(
  geography: QueryContractGeography,
  index: number,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): {
  key: string;
  label: string;
  sql: string;
} | null {
  const key = "place_" + (index + 1);
  const resolved = resolvedPlaceForContractIndex(resolutionPlan, index);
  if (resolved) {
    return {
      key,
      label: resolved.label,
      sql: resolved.oriYears.map((item) =>
        "SELECT " + sqlString(key) + " AS place_key, " + sqlString(resolved.label) +
        " AS place_label, " + sqlString(item.ori) + " AS ori, " + item.year + " AS effective_year"
      ).join("\n    UNION ALL\n    "),
    };
  }

  if (!geography.name || !geography.state || geography.confidence === "low") return null;
  const label = geography.kind === "agency"
    ? agencyDisplayName(geography.name)
    : geography.canonicalName ?? geography.name + ", " + geography.state;
  const sourceState = geography.sourceCodes?.nibrs ?? geography.state;

  const cityTargetSql = (city: string): string => {
    const agencyStateFilter = compactStatePredicate("a.state", sourceState);
    const primaryAgencyStateFilter = compactStatePredicate("primary_agency.state", sourceState);
    return [
      "SELECT DISTINCT " + sqlString(key) + " AS place_key, " + sqlString(label) + " AS place_label, a.ori, NULL AS effective_year",
      "    FROM agencies a",
      "    WHERE a.city = " + sqlString(nibrsCityLiteral(city)),
      "      AND " + agencyStateFilter,
      "      AND a.agency_type = 'City'",
      "      AND a.population > 0",
      "      AND a.ori = (",
      "        SELECT primary_agency.ori",
      "        FROM agencies primary_agency",
      "        WHERE primary_agency.city = a.city",
      "          AND primary_agency.year = a.year",
      "          AND " + primaryAgencyStateFilter,
      "          AND primary_agency.agency_type = 'City'",
      "          AND primary_agency.population > 0",
      "        ORDER BY primary_agency.pop_group, primary_agency.population DESC, primary_agency.ori",
      "        LIMIT 1",
      "      )",
    ].join("\n");
  };

  if (geography.kind === "city") {
    return {
      key,
      label,
      sql: cityTargetSql(geography.name),
    };
  }

  if (geography.kind !== "agency") return null;

  // Sheriff and county-police names need a unique ORI resolver. Substring
  // crosswalk matching can combine unrelated agencies, so keep them off the
  // deterministic path until resolution is explicit.
  if (/\b(?:county\s+police|sheriff)\b/i.test(geography.name)) return null;

  const cityPolice = geography.name.match(/^(.+?)\s+(?:city\s+)?police\s+(?:department|dept\.?)$/i);
  if (cityPolice) {
    return {
      key,
      label,
      sql: cityTargetSql(cityPolice[1]),
    };
  }

  return null;
}

type NibrsDemographicRole = "victim" | "offender" | "arrestee";
type NibrsDemographicDimension = "race" | "sex" | "age_group" | "ethnicity";

function demographicRole(question: string): NibrsDemographicRole | null {
  if (/\b(?:arrests?|arrestees?|arrested)\b/i.test(question)) return "arrestee";
  if (/\b(?:offenders?|suspects?|perpetrators?)\b/i.test(question)) return "offender";
  if (/\bvictims?\b/i.test(question)) return "victim";
  return null;
}

function demographicLabelSql(column: string, dimension: NibrsDemographicDimension): string {
  if (dimension === "race") {
    return "CASE UPPER(COALESCE(NULLIF(TRIM(" + column + "), ''), 'U')) " +
      "WHEN 'W' THEN 'White' WHEN 'B' THEN 'Black or African American' " +
      "WHEN 'A' THEN 'Asian' WHEN 'I' THEN 'American Indian or Alaska Native' " +
      "WHEN 'P' THEN 'Native Hawaiian or Other Pacific Islander' ELSE 'Unknown' END";
  }
  if (dimension === "sex") {
    return "CASE UPPER(COALESCE(NULLIF(TRIM(" + column + "), ''), 'U')) " +
      "WHEN 'M' THEN 'Male' WHEN 'F' THEN 'Female' ELSE 'Unknown' END";
  }
  if (dimension === "ethnicity") {
    return "CASE UPPER(COALESCE(NULLIF(TRIM(" + column + "), ''), 'U')) " +
      "WHEN 'H' THEN 'Hispanic or Latino' WHEN 'N' THEN 'Not Hispanic or Latino' ELSE 'Unknown' END";
  }
  return "COALESCE(NULLIF(TRIM(" + column + "), ''), 'Unknown')";
}

export function buildNibrsLocalDemographicQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || !["count", "ratio"].includes(contract.metric.unit)) return null;
  if (contract.metric.unsupportedReason) return null;
  const role = demographicRole(question);
  if (!role) return null;
  const dimensions = contract.breakdowns.filter((breakdown): breakdown is NibrsDemographicDimension =>
    ["race", "sex", "age_group", "ethnicity"].includes(breakdown)
  );
  if (dimensions.length !== 1) return null;
  if (contract.metric.offenses.length !== 1) return null;
  const offense = contract.metric.offenses[0];
  if (offense.codes.length === 0 || offense.codes.some((code) => !/^[0-9A-Z]{3}$/.test(code))) return null;
  if (contract.geographies.length !== 1 || !["city", "agency"].includes(contract.geographies[0].kind)) return null;
  if (contract.geography.kind === "campus" || contract.comparability.continuousReporters) return null;
  if (contract.breakdowns.includes("month")) return null;
  if (/\b(?:weapon|firearm|gun|shooting|domestic\s+violence|intimate\s+partner|circumstance|injury|relationship|clearance|cleared)\b/i.test(question)) return null;

  const target = structuredTargetSelect(contract.geographies[0], 0, resolutionPlan);
  if (!target) return null;
  const dimension = dimensions[0];
  const annual = contract.breakdowns.includes("year");
  const isShare = contract.metric.unit === "ratio";
  const years = yearScope("d.year", question);
  const roleConfig: Record<NibrsDemographicRole, {
    table: string;
    index: string;
    offenseColumn: string;
    countColumn: string;
    countAlias: string;
    label: string;
  }> = {
    victim: {
      table: "summary_victim_demographics",
      index: "idx_svd_new_ori_year",
      offenseColumn: "ucr_offense_code",
      countColumn: "victim_count",
      countAlias: "victims",
      label: "victims",
    },
    offender: {
      table: "summary_offender_demographics",
      index: "idx_sod_new_ori_year",
      offenseColumn: "ucr_offense_code",
      countColumn: "offender_count",
      countAlias: "offenders",
      label: "offenders",
    },
    arrestee: {
      table: "summary_arrestee_demographics",
      index: "idx_sad_new_ori_year",
      offenseColumn: "ucr_arrest_offense",
      countColumn: "arrestee_count",
      countAlias: "arrestees",
      label: "arrestees",
    },
  };
  const config = roleConfig[role];
  const dimensionSql = demographicLabelSql("d." + dimension, dimension);
  const offensePredicate = offense.codes.length === 1
    ? "d." + config.offenseColumn + " = " + sqlString(offense.codes[0])
    : "d." + config.offenseColumn + " IN (" + offense.codes.map(sqlString).join(",") + ")";
  const groupedColumns = annual ? "d.year, " + dimensionSql + " AS " + dimension : dimensionSql + " AS " + dimension;
  const groupedBy = annual ? "d.year, " + dimensionSql : dimensionSql;
  const finalColumns = [
    ...(annual ? ["year", dimension, "CAST(year AS TEXT) || ' - ' || " + dimension + " AS chart_category"] : [dimension]),
    config.countAlias,
    ...(isShare ? [
      "ROUND(100.0 * " + config.countAlias + " / NULLIF(SUM(" + config.countAlias + ") OVER (" +
      (annual ? "PARTITION BY year" : "") + "), 0), 1) AS share_pct",
    ] : []),
  ];
  const sql = [
    "WITH target_places AS (",
    "  " + target.sql,
    "),",
    "grouped AS (",
    "  SELECT " + groupedColumns + ", SUM(d." + config.countColumn + ") AS " + config.countAlias,
    "  FROM target_places AS tp",
    "  CROSS JOIN " + config.table + " AS d INDEXED BY " + config.index,
    "  WHERE d.ori = tp.ori",
    "    AND (tp.effective_year IS NULL OR tp.effective_year = d.year)",
    "    AND " + offensePredicate,
    "    AND " + years.predicate,
    "    AND " + nibrsDemographicCompletenessPredicate("d.ori", "d.year"),
    "  GROUP BY " + groupedBy,
    ")",
    "SELECT " + finalColumns.join(", "),
    "FROM grouped",
    "ORDER BY " + (annual ? "year, " : "") + config.countAlias + " DESC",
    "LIMIT 1000",
  ].join("\n");

  const dimensionLabel = dimension === "age_group" ? "age group" : dimension;
  return {
    sql,
    title: "NIBRS " + offense.label.toLowerCase() + " " + config.label + " by " + dimensionLabel + " in " + target.label,
    explanation:
      "This returns " + offense.label.toLowerCase() + " " + config.label + " by " + dimensionLabel + " in " + target.label + years.periodText + ". " +
      "These are counts of people, not incidents; one incident can involve multiple people. " +
      (isShare
        ? "Shares are calculated within the returned " + config.label + " and include the Unknown category in the denominator. "
        : "Unknown or unreported demographic values remain visible as Unknown. ") +
      "No demographic population denominator is used. Historical demographic rows are included only for complete 12-month reporting years; current-year rows are partial. " +
      NIBRS_RECENT_MATURATION_DISCLOSURE,
    chartHint: "bar",
    xAxis: annual ? "chart_category" : dimension,
    yAxis: isShare ? "share_pct" : config.countAlias,
    xAxisLabel: annual ? "Year and " + dimensionLabel : dimensionLabel.charAt(0).toUpperCase() + dimensionLabel.slice(1),
    yAxisLabel: isShare ? "Share (%)" : config.label.charAt(0).toUpperCase() + config.label.slice(1),
    guardrail: isShare ? "deterministic-nibrs-local-demographic-share" : "deterministic-nibrs-local-demographic-count",
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
      "    AND (tp.effective_year IS NULL OR tp.effective_year = s.year)",
      "    AND " + codePredicate,
      "    AND " + years.predicate.replace(/\byear\b/g, "s.year"),
      "  GROUP BY s.year, tp.place_key",
    ].join("\n"),
  };
}

function isExcludedStructuredLocalQuestion(question: string): boolean {
  return /\b(?:clearance|cleared|solve[ds]?|share|percent(?:age)?|ratio|top|highest|lowest|rank(?:ing)?|by\s+(?:state|city|agency|race|sex|gender|age|ethnicity|weapon|injury|relationship|circumstance)|weapon|firearm|gun|shooting|shootings|domestic\s+violence|intimate\s+partner|demographic|continuous|consistent\s+report)\b/i.test(question);
}

export function buildNibrsStructuredLocalTrendQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  const contract = buildQueryContract(question, "nibrs");
  if (!contract || !["count", "rate_per_100k"].includes(contract.metric.unit)) return null;
  const isRate = contract.metric.unit === "rate_per_100k";
  if (isRate && /\bper\s*(?:10k|10,?000|1k|1,?000|million|1m)\b/i.test(question)) return null;
  if (isRate && hasUnresolvedDemographicToken(question)) return null;
  if (contract.metric.offenses.length === 0 || contract.metric.offenses.length > 4) return null;
  const allCodes = contract.metric.offenses.flatMap((offense) => offense.codes);
  if (new Set(allCodes).size !== allCodes.length) return null;
  const targetGeographies = resolutionPlan && !resolutionPlan.hasStateComparison
    ? contract.geographies
        .map((geography, contractIndex) => ({ geography, contractIndex }))
        .filter(({ geography }) => ["city", "agency"].includes(geography.kind))
    : contract.geographies.map((geography, contractIndex) => ({ geography, contractIndex }));
  if (targetGeographies.length === 0 || targetGeographies.length > 4) return null;
  if (!isRate && contract.metric.offenses.length === 1 && contract.geographies.length === 1) return null;
  if (targetGeographies.some(({ geography }) => !["city", "agency"].includes(geography.kind))) return null;
  if (contract.breakdowns.includes("month")) return null;
  if (contract.breakdowns.some((breakdown) => breakdown !== "year")) return null;
  if (!isRate && !hasSimpleLocalTimeIntent(question, contract.time.startYear, contract.time.endYear)) return null;
  if (isExcludedStructuredLocalQuestion(question)) return null;
  if (contract.comparability.continuousReporters) return null;

  const targets = targetGeographies.map(({ geography, contractIndex }) =>
    structuredTargetSelect(geography, contractIndex, resolutionPlan)
  );
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
      const baseAlias = seriesKey(target.label + "_" + offense.label + (isRate ? "_rate_per_100k" : ""));
      let alias = baseAlias;
      let suffix = 2;
      while (aliases.has(alias)) alias = baseAlias + "_" + suffix++;
      aliases.add(alias);
      series.push({
        alias,
        placeKey: target.key,
        offenseKey: offense.key,
      });
    }
  }

  const currentYear = new Date().getFullYear();
  const pivotColumns = series.map((item) => {
    const reportingMonths = "MAX(CASE WHEN pr.place_key = " + sqlString(item.placeKey) +
      " THEN pr.months_reported END)";
    const countValue = "COALESCE(SUM(CASE WHEN sc.place_key = " + sqlString(item.placeKey) +
      " AND sc.offense_key = " + sqlString(item.offenseKey) +
      " THEN sc.reported_count END), 0)";
    const valueExpression = isRate
      ? "ROUND(100000.0 * " + countValue + " / NULLIF(MAX(CASE WHEN pr.place_key = " +
        sqlString(item.placeKey) + " THEN pr.population END), 0), 1)"
      : countValue;
    return nibrsAnnualValueSql({
      yearExpression: "pr.year",
      reportingMonthsExpression: reportingMonths,
      summaryMonthsExpression: "MAX(CASE WHEN pr.place_key = " + sqlString(item.placeKey) +
        " THEN pr.summary_months_reported END)",
      valueExpression,
      unit: isRate ? "rate" : "count",
      currentYear,
    }) + " AS " + item.alias;
  });
  const reportingCte = [
    "requested_years(year) AS (" + requestedYearsSql(years) + "),",
    "current_year_reporting AS (",
    "  SELECT tp.place_key, COUNT(DISTINCT s.month) AS summary_months_reported",
    "  FROM " + targetCte + " AS tp",
    "  CROSS JOIN summary_city_monthly AS s INDEXED BY idx_scm_ori_year",
    "  WHERE s.ori = tp.ori AND s.year = " + currentYear,
    "    AND (tp.effective_year IS NULL OR tp.effective_year = s.year)",
    "  GROUP BY tp.place_key",
    "),",
    "place_reporting AS (",
    "  SELECT y.year, tp.place_key, MAX(a.population) AS population, MAX(c.months_reported) AS months_reported, MAX(cyr.summary_months_reported) AS summary_months_reported",
    "  FROM requested_years AS y",
    "  CROSS JOIN " + targetCte + " AS tp",
    "  LEFT JOIN agencies AS a ON a.ori = tp.ori AND a.year = y.year AND a.population > 0",
    "  LEFT JOIN nibrs_agency_completeness AS c INDEXED BY idx_nac_ori_year",
    "    ON c.ori = tp.ori AND c.year = y.year",
    "  LEFT JOIN current_year_reporting AS cyr ON cyr.place_key = tp.place_key AND y.year = " + currentYear,
    "  WHERE tp.effective_year IS NULL OR tp.effective_year = y.year",
    "  GROUP BY y.year, tp.place_key",
    ")",
  ];
  const sql = [
    "WITH " + targetCte + " AS (",
    "  " + resolvedTargets.map((target) => target.sql).join("\n  UNION\n  "),
    "),",
    "series_counts AS (",
    "  " + resolvedOffenses.map((offense) => offense.sql).join("\n  UNION ALL\n  "),
    "),",
    ...reportingCte,
    "SELECT pr.year,",
    "  " + pivotColumns.join(",\n  "),
    "FROM place_reporting AS pr LEFT JOIN series_counts AS sc ON sc.year = pr.year AND sc.place_key = pr.place_key",
    "GROUP BY pr.year",
    "ORDER BY pr.year",
    "LIMIT 1000",
  ].join("\n");

  const places = resolvedTargets.map((target) => target.label).join(" and ");
  const offenseLabels = resolvedOffenses.map((offense) => offense.label.toLowerCase()).join(", ");
  return {
    sql,
    title: "NIBRS offense " + (isRate ? "rate " : "") + "trends for " + places,
    explanation:
      "This returns annual reported " + offenseLabels + (isRate ? " rates per 100,000" : "") + " for " + places + years.periodText + ". " +
      "Named city police departments are resolved to city-agency ORIs; named sheriff agencies are resolved through the agency crosswalk. " +
      "Person crimes use victim summaries while robbery and other non-person offenses use offense summaries. " +
      (contract.metric.offenses.some((offense) => offense.topic === "sex_offense")
        ? "The sex-offense category includes forcible and nonforcible NIBRS offenses, including statutory rape. "
        : "") +
      (isRate
        ? "Rates use each agency's year-specific service population and are left blank unless the agency reported all 12 months. Recent annual values may still change as agencies submit revisions."
        : [NIBRS_COUNT_COMPLETENESS_DISCLOSURE, NIBRS_COMPLETENESS_PROXY_DISCLOSURE, NIBRS_RECENT_MATURATION_DISCLOSURE].join(" ")),
    chartHint: "line",
    xAxis: "year",
    yAxis: series.map((item) => item.alias).join(","),
    xAxisLabel: "Year",
    yAxisLabel: isRate ? "Rate per 100,000" : "Reported count",
    guardrail: isRate ? "deterministic-nibrs-structured-local-rate" : "deterministic-nibrs-structured-local-trend",
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
