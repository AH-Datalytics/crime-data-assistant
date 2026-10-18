import { buildQueryContract, hasCodelessFamily, type QueryContractGeography, type QueryContractOffense } from "./query-contract";
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
import { selectPopulationPeers, type PeerCandidate } from "./peer-comparison";
import { fetchNibrsPeerCandidates, type PeerCandidateSource } from "./peer-adapters";
import { getNibrsDb } from "./nibrs-db";
import type { EstablishedIdentity } from "./answer-evidence";
import type { CompletenessPlan } from "./city-ranking-completeness";

export interface DeterministicNibrsQuery {
  sql: string;
  /**
   * Increment 5: the selected peers as IDENTITIES (ORI + display label), for comparing
   * selection with the evidence that actually came back. Review §2B: the id is what
   * membership is decided on, because the executed result labels agencies with a state
   * suffix the pre-execution selection does not carry.
   */
  selectedPeers?: EstablishedIdentity[];
  /**
   * Which member each pivoted measure column belongs to, recorded by the producer.
   *
   * The column name is composed with `seriesKey`, which maps every run of non-alphanumerics to "_",
   * so the separator is indistinguishable from the content: `union_city_murders` could be
   * ("Union City", "murders") or ("Union", "city murders"). The composition is LOSSY, and no shared
   * copy of a lossy function makes it invertible -- exporting `seriesKey` fixes drift between reader
   * and producer, not ambiguity. When two members slug identically the builder also appends "_2" to
   * keep the SQL valid, and that suffix carries no identity at all.
   *
   * So the binding is carried rather than recovered. A reader with this list never parses a slug.
   */
  memberColumns?: { column: string; placeKey: string; contractIndex: number; placeLabel: string }[];
  /**
   * COVER batch (Codex :34982): disclosure-only metadata the statement projects next to a withheld-able rate, per
   * place: the completeness record's months reported (the rate gate), the service population, and the distinct
   * months with summary offense activity (a proxy, not certified reporting) with the number of ORIs they span.
   * Read by `nibrsWithheldRateNote`, then REMOVED from the delivered rows and columns -- never a chart measure.
   */
  metadataColumns?: { placeKey: string; placeLabel: string; monthsReported: string; population: string; activityMonths: string; activityOris: string }[];
  title: string;
  explanation: string;
  chartHint: "line" | "bar" | "pie" | "stacked_bar" | "scatter" | "none";
  xAxis: string;
  yAxis: string;
  xAxisLabel?: string;
  yAxisLabel?: string;
  guardrail: string;
  /** City rankings only: the shared S1 completeness plan (lib/city-ranking-completeness.ts). */
  completeness?: CompletenessPlan;
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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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

export const PEER_COMPARISON_GUARDRAIL = "deterministic-nibrs-comparable-agency-clearance";
/** Decision 16: a peer plan the structural proof refuses is declined, never handed to model-written SQL. */
export const PEER_COMPARISON_REFUSED_TEXT =
  "I can't show this peer comparison: the comparison built from population evidence did not pass this site's " +
  "checks, and choosing peers another way would give you a group you can't check. Ask for specific agencies by " +
  "name and I'll compare those.";

/** The request shape this builder owns: a clearance comparison against agencies of similar size. */
export function asksComparableAgencyClearance(question: string): boolean {
  return /\b(?:clearance|clearances|cleared|solve[ds]?)\b/i.test(question) &&
    /\b(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies|departments)|\bagencies\s+(?:of\s+)?(?:similar|comparable)\s+size\b/i.test(question);
}

function requestedPeerCount(question: string): number {
  const match = question.match(/\b(\d{1,2})\s+agencies\s+of\s+(?:similar|comparable)\s+size\b/i) ||
    question.match(/\b(\d{1,2})\s+(?:most\s+)?(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\b/i) ||
    question.match(/\b(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies\s*)?(\d{1,2})\b/i);
  return Math.max(1, Math.min(20, match ? Number(match[1]) : 5));
}

/**
 * Subject-data check (local repair after the release-g window; Codex :37036, :37148; correction r1 per Codex :37200).
 * The release-g live P1 asked for San Francisco PD (CA0380100), which is in the agency directory with populations but
 * has NO rows in the clearance summary for the checked years (audit/source-check-peer-clearance-2026-10-06). The plan
 * still chose peers, returned no rows, and the final answer was the generic empty-state message. This establishes the
 * SUBJECT's data BEFORE any peer is selected, and gives the reason in an owned, specific sentence that reaches final
 * delivery unchanged.
 *
 * r1: availability is checked on EXACTLY the subject-year pairs the comparison can use -- the resolved ORI/year pairs
 * inside the period with a positive population, the same filter the peer builder applies. Counting any row over the
 * whole period said "present" for records the comparison cannot return (a year with no usable population), so peers
 * were still selected and the answer came back empty.
 *
 * Outcomes (only for the request the peer builder would take: same gate, the single resolved city-police subject, the
 * same period and offense codes):
 *   - "present": at least one clearance-summary row on an eligible subject-year pair. A row whose total is 0 is data
 *     (a genuine zero), so the plan proceeds and reports it as such.
 *   - "ineligible": no row on an eligible pair, but records exist for the subject in other years of the period (years
 *     without a usable population figure). Stated as that, with both year lists -- never as "no records".
 *   - "absent": the reads succeeded and found no row for the subject in the period at all. Confirmed absence in this
 *     source for this period, stated as such.
 *   - "unreadable": a read threw (failure or timeout). Never presented as absence, ineligibility or zero.
 * When the subject has no eligible pair at all (no positive population in the period), this returns null and the
 * existing population-evidence decline applies, unchanged.
 */
export type SubjectRowCount = (q: { pairs: { ori: string; year: number }[]; codes: string[] }) => number;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same minimal shape as peer-adapters MinimalDb
type SubjectCountDb = { prepare: (sql: string) => { get: (...params: any[]) => unknown } };

/**
 * The production subject-row count over explicit ORI/year pairs: the same clearance summary and index the peer plan's
 * own `target_data` probe reads (which also joins on exact ORI and year). Exported so tests run THIS statement against a
 * fixture database rather than a re-written copy.
 */
export function subjectRowCountFrom(db: SubjectCountDb): SubjectRowCount {
  return (q) => {
    if (q.pairs.length === 0) return 0;
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM summary_clearance_type INDEXED BY idx_sct_ori_year
       WHERE (${q.pairs.map(() => "(ori = ? AND year = ?)").join(" OR ")}) AND ucr_offense_code IN (${q.codes.map(() => "?").join(", ")})`
    ).get(...q.pairs.flatMap((p) => [p.ori, p.year]), ...q.codes) as { n: number } | undefined;
    return Number(row?.n ?? 0);
  };
}

export type ComparableSubjectCheck =
  | { kind: "present" }
  | { kind: "absent" | "ineligible" | "unreadable"; title: string; explanation: string };

const yearList = (ys: number[]) => {
  const u = [...new Set(ys)].sort((a, b) => a - b);
  return u.length <= 1 ? u.join("") : `${u.slice(0, -1).join(", ")} and ${u[u.length - 1]}`;
};

export function comparableAgencySubjectCheck(
  question: string,
  resolutionPlan: NibrsPlaceResolutionPlan | null | undefined,
  rowCount?: SubjectRowCount
): ComparableSubjectCheck | null {
  if (!asksComparableAgencyClearance(question) || !resolutionPlan) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
  if (!contract || contract.metric.offenseCodes.length === 0) return null;
  const targets = resolutionPlan.places.filter((place) => place.status === "resolved" && place.kind === "city_police");
  if (targets.length !== 1 || resolutionPlan.places.length !== 1) return null;
  const target = targets[0];
  const { startYear, endYear } = resolutionPlan;
  const inPeriod = target.oriYears.filter((item) => item.year >= startYear && item.year <= endYear);
  // Exactly the builder's eligibility: resolved ORI/year pairs in the period with a positive population.
  const eligible = inPeriod.filter((item) => item.population && item.population > 0).map((item) => ({ ori: item.ori, year: item.year }));
  if (eligible.length === 0) return null;   // no usable subject year: the existing population-evidence decline applies
  const count: SubjectRowCount = rowCount ?? ((q) => subjectRowCountFrom(getNibrsDb() as unknown as SubjectCountDb)(q));
  const codes = contract.metric.offenseCodes;
  const offense = contract.metric.topic.replace(/_/g, " ");
  const period = startYear === endYear ? `${startYear}` : `${startYear}–${endYear}`;
  const agency = target.label;
  const unreadable = (): ComparableSubjectCheck => ({
    kind: "unreadable",
    title: "Peer comparison unavailable",
    explanation: `I couldn't check whether ${agency} has ${offense} clearance records for ${period}, so no comparison is shown. ` +
      "This is a failure to read the data, not a finding that the records are missing or zero.",
  });
  try {
    if (count({ pairs: eligible, codes }) > 0) return { kind: "present" };
  } catch {
    return unreadable();
  }
  // No row on a usable pair: are there records in the period at all (any of the subject's ORIs, any year)?
  const oris = [...new Set(inPeriod.map((item) => item.ori))];
  const otherYears: number[] = [];
  try {
    for (let y = startYear; y <= endYear; y += 1) {
      if (eligible.some((p) => p.year === y)) continue;
      if (count({ pairs: oris.map((ori) => ({ ori, year: y })), codes }) > 0) otherYears.push(y);
    }
  } catch {
    return unreadable();
  }
  if (otherYears.length > 0) {
    const eligibleYears = [...new Set(eligible.map((p) => p.year))];
    return {
      kind: "ineligible",
      title: "Peer comparison unavailable",
      explanation: `${agency} has ${offense} clearance records in the available NIBRS source only for ${yearList(otherYears)}, ` +
        `and ${otherYears.length === 1 ? "that year has" : "those years have"} no population figure for the agency, which the comparison with agencies of similar size needs. ` +
        `${eligibleYears.length === 1 ? "The year that does have one" : "The years that do have one"} (${yearList(eligibleYears)}) ${eligibleYears.length === 1 ? "has" : "have"} no ${offense} clearance records, so no comparison is shown and peers are not selected.`,
    };
  }
  return {
    kind: "absent",
    title: "No clearance records for this agency",
    explanation: `No ${offense} clearance records were found for ${agency} in the available NIBRS source for ${period}; ` +
      "a comparison with agencies of similar size cannot be calculated. Peers are not shown because a comparison without the requested agency would be misleading.",
  };
}

export function buildNibrsComparableAgencyClearanceQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null,
  /**
   * Increment 5: the candidate source. Defaults to the NIBRS agencies table; injected in
   * tests so the selected set, the band and the named peers can be pinned without a DB.
   */
  candidateSource?: PeerCandidateSource
): DeterministicNibrsQuery | null {
  if (!asksComparableAgencyClearance(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
  if (!contract || contract.metric.offenseCodes.length === 0 || !resolutionPlan) return null;
  const targets = resolutionPlan.places.filter((place) => place.status === "resolved" && place.kind === "city_police");
  if (targets.length !== 1 || resolutionPlan.places.length !== 1) return null;
  const target = targets[0];
  const targetYears = target.oriYears
    .filter((item) => item.year >= resolutionPlan.startYear && item.year <= resolutionPlan.endYear && item.population && item.population > 0);
  if (targetYears.length === 0) return null;
  const reference = [...targetYears].sort((a, b) => b.year - a.year)[0];
  const peerCount = requestedPeerCount(question);
  // Increment 5 (Decision 16): SELECT THE PEERS HERE, not in SQL. A LIMIT over an
  // ordered pool picks agencies the answer cannot then name; Decision 16 requires every
  // peer named and the real population band stated, so the chosen set must be a value we
  // hold. The deterministic query below reads these identities.
  const subject: PeerCandidate = {
    ori: reference.ori,
    agency: target.label.replace(/,\s*[A-Z]{2}$/, ""),
    // AGENCY+RANK batch: a department label ("San Francisco Police Department") has no ", CA" suffix; the resolved
    // place carries its state, so the disclosure never reads "Department,  (808,000)".
    state: /,\s*([A-Z]{2})$/.exec(target.label)?.[1] ?? target.state ?? "",
    population: Number(reference.population),
  };
  const source: PeerCandidateSource = candidateSource
    ?? ((q) => fetchNibrsPeerCandidates(getNibrsDb() as unknown as Parameters<typeof fetchNibrsPeerCandidates>[0], q));
  let candidates: PeerCandidate[];
  try {
    candidates = source({ year: reference.year, excludeOri: reference.ori, population: Number(reference.population) });
  } catch {
    return null;   // no candidate evidence -> fall through to the model rather than guess
  }
  if (candidates.length === 0) return null;
  const selection = selectPopulationPeers(subject, candidates, peerCount);
  if (selection.peers.length === 0) return null;
  // AGENCY+RANK batch: literal identities are projected with `AS`, never through a CTE column list. The structural
  // proof traces an `AS` literal as supplied by the query; the column-list form left `place_label` untraceable, so
  // every plan from this builder was refused and the request fell through to model-written peer SQL (GC-115). For the
  // same reason no CTE is declared `AS MATERIALIZED`: the lineage reader stops at that header and every later CTE
  // becomes an unknown table. The uncorrelated EXISTS probe is evaluated once either way.
  const peerRows = selection.peers
    .map((p) => `SELECT ${sqlString(p.ori ?? "")} AS ori, ${sqlString(`${p.agency}, ${p.state}`)} AS place_label`)
    .join("\n  UNION ALL\n  ");

  const codes = contract.metric.offenseCodes.map(sqlString).join(", ");
  const targetRows = targetYears.map((item) =>
    `SELECT ${item.year} AS year, ${sqlString(item.ori)} AS ori, ${Number(item.population)} AS population`
  ).join("\n  UNION ALL\n  ");
  const methodBreakdown = asksClearanceMethodBreakdown(question);
  const sql = `WITH
target_years AS (
  ${targetRows}
),
peer_selected AS (
  ${peerRows}
),
target_data AS (
  SELECT 1 AS available
  FROM target_years ty
  CROSS JOIN summary_clearance_type target_probe INDEXED BY idx_sct_ori_year
  WHERE target_probe.ori = ty.ori
    AND target_probe.year = ty.year
    AND target_probe.ucr_offense_code IN (${codes})
  LIMIT 1
),
peer_candidates AS (
  SELECT ps.ori AS ori, ps.place_label AS place_label
  FROM peer_selected ps
  WHERE EXISTS (SELECT 1 FROM target_data)
),
selected_agencies AS (
  SELECT ${sqlString(target.label)} AS place_label, ty.ori AS ori, ty.year AS effective_year FROM target_years ty
  WHERE EXISTS (SELECT 1 FROM target_data)
  UNION ALL
  SELECT pc.place_label AS place_label, pc.ori AS ori, NULL AS effective_year FROM peer_candidates pc
),
clearances AS (
  SELECT sct.year, sa.place_label, sa.ori,
    SUM(sct.total_offenses) AS total_offenses,
    SUM(sct.cleared_by_arrest) AS cleared_by_arrest,
    SUM(sct.cleared_exceptional) AS cleared_exceptional
  FROM selected_agencies sa
  CROSS JOIN summary_clearance_type sct INDEXED BY idx_sct_ori_year
  WHERE sct.ori = sa.ori
    AND (sa.effective_year IS NULL OR sa.effective_year = sct.year)
    AND sct.year BETWEEN ${resolutionPlan.startYear} AND ${resolutionPlan.endYear}
    AND sct.ucr_offense_code IN (${codes})
  GROUP BY sct.year, sa.place_label, sa.ori
)
SELECT year, place_label, ori,
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
    selectedPeers: selection.peers.map((p) => ({ id: p.ori ?? null, label: `${p.agency}, ${p.state}` })),
    explanation: `This compares ${offenseLabel} clearance rates for ${target.label} with its population peers. ${selection.disclosure} ` +
      (methodBreakdown ? "Arrest and exceptional clearances are shown separately. " : "The overall rate includes arrest and exceptional clearances. ") +
      "Peer selection is based on agency service population, not broader socioeconomic similarity. Recent NIBRS data may be incomplete.",
    chartHint: "line",
    xAxis: "year",
    yAxis: methodBreakdown ? "arrest_rate_pct,exceptional_rate_pct" : "clearance_rate_pct",
    xAxisLabel: "Year",
    yAxisLabel: "Clearance rate (%)",
    guardrail: "deterministic-nibrs-comparable-agency-clearance",   // literal: the taxonomy enumerates families by it (= PEER_COMPARISON_GUARDRAIL)
  };
}

export function buildNibrsLocalCityOffenseCountQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
/**
 * The column-name rule for pivoted comparison series. Exported so the reader that attributes a figure
 * to an agency uses the producer's own rule instead of a copy that can drift from it.
 */
export function seriesKey(value: string): string {
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
  contractIndex: number;
  sql: string;
} | null {
  const key = "place_" + (index + 1);
  const resolved = resolvedPlaceForContractIndex(resolutionPlan, index);
  if (resolved) {
    return {
      key,
      label: resolved.label,
      contractIndex: index,
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
      contractIndex: index,
      sql: cityTargetSql(geography.name),
    };
  }

  if (geography.kind !== "agency") return null;

  // Sheriff and county-police names need a unique ORI resolver. Substring
  // crosswalk matching can combine unrelated agencies, so keep them off the
  // deterministic path until resolution is explicit.
  if (/\b(?:county\s+police|sheriff)\b/i.test(geography.name)) return null;

  const cityPolice = geography.name.match(/^(.+?)\s+police\s+(?:department|dept\.?)$/i);
  if (cityPolice) {
    const asWritten = cityPolice[1];
    const stripped = asWritten.replace(/\s+city$/i, "");
    // Reaching here means resolution already failed, so there is no ORI to key on and only the
    // string is left -- and the string cannot settle this. In `agencies`, 27 (state, name) pairs
    // have both `X` and `X CITY`: some are one agency renamed across the source's 2017
    // re-normalization, and some are genuinely different municipalities with different ORIs and
    // wildly different populations (CA REDWOOD, 5,604, against REDWOOD CITY, 88,161). A query
    // covering both spellings would merge two real places; a query picking one would be a guess.
    // Decline instead, and let the model path answer under the omitted-member enforcement.
    if (stripped !== asWritten) return null;
    return {
      key,
      label,
      contractIndex: index,
      sql: cityTargetSql(asWritten),
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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
  if (contract.geographies.length === 0 || contract.geographies.some((geography) => !["city", "agency"].includes(geography.kind))) return null;
  if (contract.geography.kind === "campus" || contract.comparability.continuousReporters) return null;
  if (contract.breakdowns.includes("month")) return null;
  if (/\b(?:weapon|firearm|gun|shooting|domestic\s+violence|intimate\s+partner|circumstance|injury|relationship|clearance|cleared)\b/i.test(question)) return null;
  if (contract.geographies.length > 1) {
    return buildOwnedMultiAgencyOffenderAgeQuery(question, contract, role, dimensions[0], offense, resolutionPlan);
  }

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

const OWNED_DEMOGRAPHIC_MAX_MEMBERS = 5;

/**
 * Offender age-group counts for 2-5 named agencies, built here so every figure is attributable
 * (GC-084; Codex design ruling 2026-09-26).
 *
 * The multi-agency ownership refusal in the NIBRS route is unchanged: this makes one bounded
 * request something the application builds, and everything outside the bound still reaches that
 * refusal. The bound is offender role, age group, counts, one offense family, no annual breakdown.
 *
 * Attribution rests on three things. Every requested member must carry the resolver's own
 * ORI/year binding -- the name-based fallback in `structuredTargetSelect` is never reached,
 * because it guesses. No ORI may belong to two members in the same year, so nothing is pooled.
 * And each member gets one count column, declared by contract index in `memberColumns`, which the
 * route binds to the executed statement.
 *
 * The pivot has no ELSE: an age group a member has no rows for stays NULL, never a fabricated 0,
 * while a recorded zero sums to 0. Each member keeps its own complete-reporting years; the
 * comparison is not narrowed to a period the members share.
 */
function buildOwnedMultiAgencyOffenderAgeQuery(
  question: string,
  contract: NonNullable<ReturnType<typeof buildQueryContract>>,
  role: NibrsDemographicRole,
  dimension: NibrsDemographicDimension,
  offense: QueryContractOffense,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (role !== "offender" || dimension !== "age_group") return null;
  if (contract.metric.unit !== "count") return null;
  if (contract.breakdowns.some((breakdown) => breakdown !== "age_group")) return null;
  const memberCount = contract.geographies.length;
  if (memberCount < 2 || memberCount > OWNED_DEMOGRAPHIC_MAX_MEMBERS) return null;
  if (!resolutionPlan || resolutionPlan.hasStateComparison || resolutionPlan.places.length !== memberCount) return null;
  const members = contract.geographies.map((_, index) => resolvedPlaceForContractIndex(resolutionPlan, index));
  if (members.some((member) => !member || member.oriYears.length === 0)) return null;
  const owners = new Map<string, number>();
  for (const [index, member] of members.entries()) {
    for (const item of member!.oriYears) {
      const key = item.ori + ":" + item.year;
      if (owners.has(key) && owners.get(key) !== index) return null;
      owners.set(key, index);
    }
  }
  // Every member is resolved, so this takes the resolver-bound branch for each.
  const targets = contract.geographies.map((geography, index) => structuredTargetSelect(geography, index, resolutionPlan));
  if (targets.some((target) => target === null)) return null;
  const resolvedTargets = targets.filter((target): target is NonNullable<typeof target> => target !== null);

  const years = yearScope("d.year", question);
  const ageSql = demographicLabelSql("d.age_group", "age_group");
  const offensePredicate = offense.codes.length === 1
    ? "d.ucr_offense_code = " + sqlString(offense.codes[0])
    : "d.ucr_offense_code IN (" + offense.codes.map(sqlString).join(",") + ")";

  const aliases = new Set<string>();
  const series = resolvedTargets.map((target) => {
    // Apostrophes dropped first, so "sheriff's" reads back as "Sheriffs", not "Sheriff S".
    const baseAlias = seriesKey(target.label.replace(/['’]/g, "") + "_offenders");
    let alias = baseAlias;
    let suffix = 2;
    while (aliases.has(alias)) alias = baseAlias + "_" + suffix++;
    aliases.add(alias);
    return { alias, placeKey: target.key, contractIndex: target.contractIndex, placeLabel: target.label };
  });

  const sql = [
    "WITH target_places AS (",
    "  " + resolvedTargets.map((target) => target.sql).join("\n  UNION\n  "),
    "),",
    "grouped AS (",
    "  SELECT tp.place_key, " + ageSql + " AS age_group, SUM(d.offender_count) AS offenders",
    "  FROM target_places AS tp",
    "  CROSS JOIN summary_offender_demographics AS d INDEXED BY idx_sod_new_ori_year",
    "  WHERE d.ori = tp.ori",
    "    AND (tp.effective_year IS NULL OR tp.effective_year = d.year)",
    "    AND " + offensePredicate,
    "    AND " + years.predicate,
    "    AND " + nibrsDemographicCompletenessPredicate("d.ori", "d.year"),
    "  GROUP BY tp.place_key, " + ageSql,
    ")",
    "SELECT age_group,",
    "  " + series.map((item) =>
      "SUM(CASE WHEN place_key = " + sqlString(item.placeKey) + " THEN offenders END) AS " + item.alias
    ).join(",\n  "),
    "FROM grouped",
    "GROUP BY age_group",
    "ORDER BY CASE WHEN age_group = 'Unknown' THEN 1 ELSE 0 END, age_group",
    "LIMIT 1000",
  ].join("\n");

  const places = resolvedTargets.map((target) => target.label).join(" and ");
  return {
    sql,
    title: "NIBRS " + offense.label.toLowerCase() + " offenders by age group for " + places,
    explanation:
      "This returns " + offense.label.toLowerCase() + " offenders by age group for " + places +
      ", one column per agency" + years.periodText + ". " +
      "These are recorded offender counts, not incidents and not unique people; one incident can involve several offenders. " +
      "Unknown or unreported ages remain visible as Unknown. " +
      "A blank cell is a missing contribution for that agency and age group, not a count. " +
      // GC-084 correction C3: the completeness predicate admits current-year rows without the 12-month
      // test, so the prose must not claim every counted year is complete.
      "Past years are counted only when the agency reported all 12 months; if the period includes " + new Date().getFullYear() +
      ", its counts are partial-year counts that can cover only some months. " +
      NIBRS_COMPLETENESS_PROXY_DISCLOSURE + " " +
      "The agencies can cover different years; the comparison is not narrowed to a shared period. " +
      NIBRS_RECENT_MATURATION_DISCLOSURE,
    chartHint: "bar",
    xAxis: "age_group",
    yAxis: series.map((item) => item.alias).join(","),
    xAxisLabel: "Age group",
    yAxisLabel: "Offenders",
    guardrail: "deterministic-nibrs-local-demographic-count",
    // Carried, not recoverable from the column names: see `memberColumns` on the type.
    memberColumns: series.map((item) => ({
      column: item.alias, placeKey: item.placeKey, contractIndex: item.contractIndex, placeLabel: item.placeLabel,
    })),
  };
}
/*
 * ONE RELATION PER OFFENCE, AND THE OFFENCE IDENTITY LIVES IN ITS NAME.
 *
 * These branches used to be UNIONed into a single `series_counts` CTE, each tagging its rows with
 * `'murder' AS offense_key` so the outer pivot could select them. That label is a constant with no
 * source table, and the pre-execution structural check — correctly — could not trace a returned
 * series that inherited it, so a correctly built plan was refused before it ever ran.
 *
 * The fix is not to teach the checker about constants. It is to stop projecting one: each offence
 * gets its own relation, and which offence a column holds is carried by the CTE's name and the
 * output column's name rather than by a value in the data. Nothing downstream has to trust a
 * string to know what it is looking at.
 *
 * Each relation groups by `(year, place_key)`, so it contributes at most one row per join key and
 * cannot multiply the others when they are joined side by side. That is a property of the shape,
 * not of any particular request.
 */
function structuredOffenseSelect(
  offense: QueryContractOffense,
  targetCte: string,
  years: YearScope,
  index: number
): { key: string; label: string; sql: string; cte: string; alias: string } | null {
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
    cte: "offense_counts_" + (index + 1),
    alias: "oc" + (index + 1),
    sql: [
      "SELECT s.year, tp.place_key, SUM(s." + valueColumn + ") AS reported_count",
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
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
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
  const offenses = contract.metric.offenses.map((offense, index) => structuredOffenseSelect(offense, targetCte, years, index));
  if (offenses.some((offense) => offense === null)) return null;
  const resolvedOffenses = offenses.filter((offense): offense is NonNullable<typeof offense> => offense !== null);

  const aliases = new Set<string>();
  const series: { alias: string; placeKey: string; contractIndex: number; placeLabel: string; offenseAlias: string }[] = [];
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
        // The contract index the key was derived from: `place_N` is assigned from it, and it is the
        // only part of this binding a label collision cannot reach. Two members labelled "Mobile"
        // have one label and two contract indices.
        contractIndex: target.contractIndex,
        placeLabel: target.label,
        // Which RELATION holds this offence, rather than which label value to match on.
        offenseAlias: offense.alias,
      });
    }
  }

  const currentYear = new Date().getFullYear();
  const pivotColumns = series.map((item) => {
    const reportingMonths = "MAX(CASE WHEN pr.place_key = " + sqlString(item.placeKey) +
      " THEN pr.months_reported END)";
    const countValue = "COALESCE(SUM(CASE WHEN " + item.offenseAlias + ".place_key = " +
      sqlString(item.placeKey) + " THEN " + item.offenseAlias + ".reported_count END), 0)";
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
    // COVER batch: the months with summary offense activity, per place and requested year (one row per pair, so the
    // join below cannot fan out). Rate plans only; disclosure metadata, removed before delivery.
    ...(isRate ? [
      ",observed_months AS (",
      "  SELECT tp.place_key, s.year, GROUP_CONCAT(DISTINCT s.month) AS activity_months, COUNT(DISTINCT s.ori) AS activity_oris",
      "  FROM " + targetCte + " AS tp",
      "  CROSS JOIN summary_city_monthly AS s INDEXED BY idx_scm_ori_year",
      "  WHERE s.ori = tp.ori AND s.year IN (SELECT year FROM requested_years)",
      "    AND (tp.effective_year IS NULL OR tp.effective_year = s.year)",
      "  GROUP BY tp.place_key, s.year",
      ")",
    ] : []),
  ];
  const metadataColumns = isRate ? resolvedTargets.map((target) => {
    const base = "meta_" + seriesKey(target.key);
    return { placeKey: target.key, placeLabel: target.label, monthsReported: base + "_months_reported", population: base + "_population", activityMonths: base + "_activity_months", activityOris: base + "_activity_oris" };
  }) : [];
  const metadataSelect = metadataColumns.flatMap((m) => [
    "MAX(CASE WHEN pr.place_key = " + sqlString(m.placeKey) + " THEN pr.months_reported END) AS " + m.monthsReported,
    "MAX(CASE WHEN pr.place_key = " + sqlString(m.placeKey) + " THEN pr.population END) AS " + m.population,
    "MAX(CASE WHEN om.place_key = " + sqlString(m.placeKey) + " THEN om.activity_months END) AS " + m.activityMonths,
    "MAX(CASE WHEN om.place_key = " + sqlString(m.placeKey) + " THEN om.activity_oris END) AS " + m.activityOris,
  ]);
  const sql = [
    "WITH " + targetCte + " AS (",
    "  " + resolvedTargets.map((target) => target.sql).join("\n  UNION\n  "),
    "),",
    ...resolvedOffenses.flatMap((offense) => [
      offense.cte + " AS (",
      "  " + offense.sql,
      "),",
    ]),
    ...reportingCte,
    "SELECT pr.year,",
    "  " + [...pivotColumns, ...metadataSelect].join(",\n  "),
    "FROM place_reporting AS pr",
    // One join per offence relation, each keyed on (year, place_key) and therefore one-to-one with
    // the reporting row. Side by side they cannot fan out, so no measure is counted twice.
    ...resolvedOffenses.map((offense) =>
      "LEFT JOIN " + offense.cte + " AS " + offense.alias +
      " ON " + offense.alias + ".year = pr.year AND " + offense.alias + ".place_key = pr.place_key"),
    ...(isRate ? ["LEFT JOIN observed_months AS om ON om.year = pr.year AND om.place_key = pr.place_key"] : []),
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
    // Carried, not recoverable from the column names: see `memberColumns` on the type.
    memberColumns: series.map((item) => ({
      column: item.alias, placeKey: item.placeKey, contractIndex: item.contractIndex, placeLabel: item.placeLabel,
    })),
    ...(metadataColumns.length ? { metadataColumns } : {}),
  };
}
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * COVER batch (Codex :34982): for each blank rate in a structured local rate answer, say why it is blank using only
 * the evidence the same statement returned -- the completeness record's months reported (the rate is shown only at
 * 12), else a missing population -- and name the months with summary offense activity, labelled as a proxy, not
 * certified reporting. A union over several ORIs is labelled as combined. Unknown causes stay unknown.
 */
export function nibrsWithheldRateNote(query: Pick<DeterministicNibrsQuery, "memberColumns" | "metadataColumns">, rows: Record<string, unknown>[]): string | null {
  if (!query.metadataColumns?.length || !query.memberColumns?.length) return null;
  const notes: string[] = [];
  for (const row of rows) {
    const year = Number(row.year);
    if (!Number.isInteger(year)) continue;
    for (const meta of query.metadataColumns) {
      const rateCols = query.memberColumns.filter((m) => m.placeKey === meta.placeKey).map((m) => m.column);
      if (rateCols.length === 0 || !rateCols.some((c) => row[c] == null)) continue;
      const months = row[meta.monthsReported];
      const population = row[meta.population];
      const reason = months == null
        ? `the NIBRS completeness record has no months-reported entry for ${year}, and a rate is shown only for a year with all 12 months reported`
        : Number(months) !== 12
          ? `the NIBRS completeness record shows ${Number(months)} of 12 months reported for ${year}, and a rate is shown only for a year with all 12`
          : population == null || Number(population) <= 0
            ? `no service population is recorded for ${year}`
            : `the reason is not established from the returned evidence`;
      const activity = String(row[meta.activityMonths] ?? "").split(",").map((m) => Number(m.trim())).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12);
      const uniq = [...new Set(activity)].sort((a, b) => a - b);
      const oris = Number(row[meta.activityOris] ?? 0);
      const activityText = uniq.length
        ? `Summary data show offense activity in ${uniq.map((m) => MONTH_NAMES[m - 1]).join(", ")}${oris > 1 ? ` (across its ${oris} agency records combined)` : ""}; months with recorded offenses are a proxy, not certified reporting coverage.`
        : `Summary data show no offense activity for ${year}.`;
      notes.push(`${meta.placeLabel}, ${year}: the rate is left blank because ${reason}. ${activityText}`);
    }
  }
  return notes.length ? notes.join(" ") : null;
}

/** The delivered rows and columns without the disclosure-only metadata columns. */
export function withoutNibrsMetadata(query: Pick<DeterministicNibrsQuery, "metadataColumns">, columns: string[], rows: Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } {
  const meta = new Set((query.metadataColumns ?? []).flatMap((m) => [m.monthsReported, m.population, m.activityMonths, m.activityOris]));
  if (meta.size === 0) return { columns, rows };
  return {
    columns: columns.filter((c) => !meta.has(c)),
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !meta.has(k)))),
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

/**
 * Does abandoning this deterministic query lose a peer selection contract?
 *
 * A peer comparison selected its members on population alone. If its execution fails and
 * the route continues into the model path, those members are gone and the model may
 * invent a different set — exactly the Decision 16 failure this batch exists to fix. The
 * route uses this to stop honestly instead.
 */
export function deterministicPeerSelectionLost(query: Pick<DeterministicNibrsQuery, "selectedPeers">): boolean {
  return Boolean(query.selectedPeers && query.selectedPeers.length > 0);
}

/*
 * ============================================================================================
 * A CHECKED CALCULATION PATH: yearly offence and clearance figures for one agency.
 *
 * Everything else in this file builds SQL and lets a general checker decide afterwards whether the
 * number means what the answer says. That approach failed the same bounded milestone twice: a
 * statement can sum months into a month, or aggregate in one scope and claim a period in another,
 * and no amount of static reading of unrestricted SQL settled it. This path inverts that. It owns
 * the offence, the contributing rows, the period and the arithmetic together, so the figure is
 * correct by construction rather than inspected for correctness later.
 *
 * WHAT THE SOURCE ACTUALLY SAYS, measured on the restored backup on 2026-09-12 for Houston and
 * `23F` across 2018-2026 (source gate recorded in the 2026-09-11 handoff):
 *
 *   - `summary_clearance_detail` is keyed `(year, state, ori, ucr_offense_code)`. It is ALREADY
 *     ANNUAL, so this path performs no month-to-year aggregation at all -- the defect class that
 *     failed twice cannot arise here.
 *   - For 2018-2025 its `total_offenses` equals the monthly table's `SUM(offense_count)` EXACTLY,
 *     every year, and the monthly `cleared_count` equals `cleared_by_arrest + cleared_A..E`
 *     exactly. So the monthly `cleared_count` is TOTAL clearances including exceptional means.
 *   - For 2026 the three tables DISAGREE: 8,967 offences over six months, 2,478 in the annual
 *     table, and a completeness row saying one month.
 *
 * SO NOTHING IS ASSUMED TO AGREE. The query returns the evidence for each requested year -- the
 * other table's offence AND clearance totals, the month counts, and the smallest clearance
 * component -- and `partitionAnnualClearanceRows` decides per year whether a figure is supportable.
 * Every test it applies is a reason to WITHHOLD, and a withheld year keeps its own reason all the
 * way to the reader.
 *
 * WHAT THIS PATH DOES NOT DO: a month-constrained figure. A request naming specific months is
 * declined rather than answered as a whole year, because answering a narrower question with a wider
 * one is the same class of error this path exists to end.
 * ============================================================================================
 */

/** One requested year as the query returns it, before any disposition is decided. */
export type AnnualClearanceRow = {
  year: number;
  total_offenses: number | null;
  cleared: number | null;
  not_cleared: number | null;
  clearance_rate: number | null;
  /**
   * The smallest clearance component on the row.
   *
   * SQLite's scalar `MIN` returns NULL when any argument is NULL, so this one column answers both
   * questions the sum cannot: is any component missing, and is any component negative. Checking the
   * sum alone let `20 + (-10)` deliver as a clean 10, with the invalid input cancelled out of sight.
   */
  min_component: number | null;
  months_reported: number | null;
  months_with_data: number | null;
  monthly_offenses: number | null;
  monthly_cleared: number | null;
};

export type WithheldYear = { year: number; reason: string };

export type AnnualClearancePartition = {
  delivered: AnnualClearanceRow[];
  withheld: WithheldYear[];
};

/** Does this request name particular months rather than whole years? */
function asksSpecificMonths(question: string): boolean {
  const q = question ?? "";
  const month = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
  return new RegExp("\\b" + month + "\\b", "i").test(q)
    || /\b(?:first|last)\s+(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven)\s+months\b/i.test(q)
    || /\byear[-\s]to[-\s]date\b|\bytd\b/i.test(q)
    || /\bthrough\s+\w+\s+only\b/i.test(q);
}

/**
 * Is this the family this path owns?
 *
 * Asked of the CONTRACT, not of the saved question, so any agency, offence and span that fit are
 * owned and none is recognised by matching a remembered sentence. Recognition happens before plan
 * construction AND before the follow-up switch: once a request is owned, a missing plan is an
 * honest decline, never a handover to model-generated SQL for the same question.
 *
 * A month-restricted request IS owned -- deliberately. It belongs to this family and this family
 * cannot calculate it, so it must be declined here; leaving it unowned would hand it back to the
 * generated calculation and it would come back as an unrestricted year.
 */
export function asksAnnualClearanceFamily(question: string): boolean {
  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return false; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
  if (!contract) return false;
  if (contract.metric.unit !== "clearance_rate") return false;
  if (!contract.breakdowns.includes("year")) return false;
  if (contract.breakdowns.some((breakdown) => breakdown !== "year")) return false;
  if (contract.time.startYear === null || contract.time.endYear === null) return false;
  if (contract.metric.offenses.length !== 1) return false;
  if (contract.metric.offenseCodes.length !== 1) return false;
  if ((contract.geographies?.length ?? 0) > 1) return false;
  if (contract.geography.kind !== "city" && contract.geography.kind !== "agency") return false;
  // The clearance tables count OFFENCES. Person crimes are counted per victim in this product, and
  // borrowing an offence-row source for them would answer a different measure under the same name.
  if (PERSON_COUNT_CODES.has(contract.metric.offenseCodes[0])) return false;
  // A clearance-TYPE breakdown is a different answer with its own builder.
  if (asksClearanceTypeBreakdown(question)) return false;
  return true;
}

/** Why an owned request cannot be served here, in the reader's terms. */
export function annualClearanceDeclineReason(
  question: string, resolutionPlan?: NibrsPlaceResolutionPlan | null
): string {
  if (asksSpecificMonths(question)) {
    return "I can give you whole reporting years for one agency, but not a figure limited to " +
      "particular months -- and I'm not going to answer a narrower question with a wider one. Ask " +
      "for the years and I'll tell you what each one covers.";
  }
  const resolved = resolvedPlaceForContractIndex(resolutionPlan, 0);
  if ((resolved?.oriYears.length ?? 0) === 0) {
    return "I couldn't resolve that place to a single reporting agency in this source, and a " +
      "clearance figure attributed to the wrong agency is worse than none. Naming the police " +
      "department directly, with a year range, usually works.";
  }
  return "I couldn't build a yearly clearance answer for that request from this source, and I'd " +
    "rather say so than hand you a figure I can't account for.";
}

/**
 * The controlled plan. Returns null only when the request cannot be served; the caller owns the
 * honest decline, and must not fall through to a generated query for an owned request.
 */
export function buildNibrsAnnualClearanceQuery(
  question: string,
  resolutionPlan?: NibrsPlaceResolutionPlan | null
): DeterministicNibrsQuery | null {
  if (!asksAnnualClearanceFamily(question)) return null;
  // Owned, but out of this family's reach: the caller declines with the reason above.
  if (asksSpecificMonths(question)) return null;
  const contract = buildQueryContract(question, "nibrs");
  if (contract && hasCodelessFamily(contract)) return null; // Carjacking hotfix (2026-10-10): a requested offense with no NIBRS code (carjacking, domestic violence) is not built from codes here.
  if (!contract) return null;

  const startYear = contract.time.startYear!;
  const endYear = contract.time.endYear!;
  if (endYear < startYear || endYear - startYear > 30) return null;

  const code = contract.metric.offenseCodes[0];
  if (!/^[0-9A-Z]{3}$/.test(code)) return null;

  const resolved = resolvedPlaceForContractIndex(resolutionPlan, 0);
  const oris = [...new Set(resolved?.oriYears.map((item) => item.ori) ?? [])];
  if (oris.length !== 1) return null;          // one agency, established, or nothing
  const ori = oris[0];
  const place = resolved?.label ?? contract.geography.canonicalName ?? contract.geography.name ?? "the requested agency";

  const offense = contract.metric.offenses[0];
  const yearValues: string[] = [];
  for (let year = startYear; year <= endYear; year += 1) yearValues.push("(" + year + ")");

  const componentColumns = ["cleared_by_arrest", "cleared_A", "cleared_B", "cleared_C", "cleared_D", "cleared_E"];
  const componentSum = componentColumns.map((column) => "scd." + column).join(" + ");
  const componentMin = "MIN(" + componentColumns.map((column) => "scd." + column).join(", ") + ")";

  const sql = [
    "WITH requested_years(year) AS (VALUES " + yearValues.join(", ") + "),",
    "annual AS (",
    "  SELECT scd.year, scd.total_offenses, " + componentSum + " AS cleared,",
    "    " + componentMin + " AS min_component",
    "  FROM summary_clearance_detail scd INDEXED BY idx_scd_ori_year",
    "  WHERE scd.ori = " + sqlString(ori) + " AND scd.ucr_offense_code = " + sqlString(code),
    "    AND scd.year BETWEEN " + startYear + " AND " + endYear,
    "),",
    "monthly AS (",
    "  SELECT s.year, COUNT(DISTINCT s.month) AS months_with_data,",
    "    SUM(s.offense_count) AS monthly_offenses, SUM(s.cleared_count) AS monthly_cleared",
    "  FROM summary_city_monthly s INDEXED BY idx_scm_ori_year",
    "  WHERE s.ori = " + sqlString(ori) + " AND s.ucr_offense_code = " + sqlString(code),
    "    AND s.year BETWEEN " + startYear + " AND " + endYear,
    "  GROUP BY s.year",
    "),",
    "reporting AS (",
    "  SELECT nac.year, nac.months_reported",
    "  FROM nibrs_agency_completeness nac INDEXED BY idx_nac_ori_year",
    "  WHERE nac.ori = " + sqlString(ori),
    "    AND nac.year BETWEEN " + startYear + " AND " + endYear,
    ")",
    "SELECT y.year AS year,",
    "  a.total_offenses AS total_offenses,",
    "  a.cleared AS cleared,",
    "  a.total_offenses - a.cleared AS not_cleared,",
    "  ROUND(100.0 * a.cleared / NULLIF(a.total_offenses, 0), 1) AS clearance_rate,",
    "  a.min_component AS min_component,",
    "  r.months_reported AS months_reported,",
    "  m.months_with_data AS months_with_data,",
    "  m.monthly_offenses AS monthly_offenses,",
    "  m.monthly_cleared AS monthly_cleared",
    "FROM requested_years y",
    "LEFT JOIN annual a ON a.year = y.year",
    "LEFT JOIN monthly m ON m.year = y.year",
    "LEFT JOIN reporting r ON r.year = y.year",
    "ORDER BY y.year",
  ].join("\n");

  return {
    sql,
    title: offense.label + " and clearances, " + place + ", " + startYear + "-" + endYear,
    explanation: annualClearanceMeaning(offense),
    chartHint: "line",
    xAxis: "year",
    yAxis: "total_offenses,cleared",
    xAxisLabel: "Year",
    yAxisLabel: offense.label,
    guardrail: "nibrs-annual-clearance",
  };
}

/** What the offence actually is, said plainly, because the wording invites the wrong reading. */
function annualClearanceMeaning(offense: QueryContractOffense): string {
  if (offense.topic === "vehicle_burglary") {
    return "Theft from a motor vehicle (NIBRS offense 23F) -- articles taken from a vehicle, which " +
      "many departments call burglary of a motor vehicle. It is not burglary of a building (220), " +
      "theft of the vehicle itself (240), or theft of its parts and accessories (23G).";
  }
  return offense.label + " (NIBRS offense " + offense.codes.join(", ") + ").";
}

/**
 * Which years can be answered, and why the rest cannot.
 *
 * EVERY TEST HERE IS A REASON TO WITHHOLD, and every delivered figure has passed all of them --
 * including a zero, which is a figure like any other and gets no shortcut past the evidence. Nothing
 * is repaired, clamped or coerced: a contradiction between two sources is reported as one, because
 * the alternative is publishing whichever number the query happened to reach first.
 */
export function partitionAnnualClearanceRows(rows: AnnualClearanceRow[]): AnnualClearancePartition {
  const delivered: AnnualClearanceRow[] = [];
  const withheld: WithheldYear[] = [];

  for (const row of rows) {
    if (row.total_offenses === null) {
      withheld.push({ year: row.year, reason: "this source has no record for that year" });
      continue;
    }
    // An annual row that exists but cannot be added up is a different problem from an absent one,
    // and saying "no record" about it would be false.
    if (row.cleared === null || row.min_component === null) {
      withheld.push({ year: row.year, reason: "the clearance figures for that year are incomplete" });
      continue;
    }
    if (row.total_offenses < 0 || row.min_component < 0) {
      withheld.push({ year: row.year, reason: "the recorded figures include a negative value" });
      continue;
    }
    if (row.cleared > row.total_offenses) {
      withheld.push({ year: row.year, reason: "more clearances are recorded than offenses" });
      continue;
    }
    if (row.monthly_offenses === null || row.monthly_offenses !== row.total_offenses) {
      withheld.push({
        year: row.year,
        reason: "the yearly and monthly records disagree about how many offenses there were",
      });
      continue;
    }
    // The clearances need the same agreement the offences do. Checking only the offence total let
    // two sources differ by an order of magnitude on clearances and still publish one of them.
    if (row.monthly_cleared === null || row.monthly_cleared !== row.cleared) {
      withheld.push({
        year: row.year,
        reason: "the yearly and monthly records disagree about how many offenses were cleared",
      });
      continue;
    }
    if (row.months_reported === null || row.months_with_data === null
      || row.months_reported !== row.months_with_data) {
      withheld.push({
        year: row.year,
        reason: "how much of the year was reported could not be established",
      });
      continue;
    }
    /*
     * A PARTIAL YEAR IS WITHHELD, NOT LABELLED.
     *
     * This source records how MANY months an agency reported, never WHICH. Equal counts do not
     * establish that the reported months are the months carrying this offence, so a partial figure
     * cannot be given a basis the reader could check -- and the approved boundary is to withhold a
     * partial figure whose basis is unestablished rather than to publish it with a caveat.
     */
    if (row.months_reported !== 12) {
      withheld.push({
        year: row.year,
        reason: "only part of that year was reported, and this source does not record which months",
      });
      continue;
    }
    // A real zero is an answer. It has passed every check above; it simply has no rate.
    if (row.total_offenses === 0) {
      delivered.push({ ...row, clearance_rate: null });
      continue;
    }
    delivered.push(row);
  }
  return { delivered, withheld };
}

/** What the reader is shown: the reconciliation evidence stays behind, its conclusion does not. */
const ANNUAL_CLEARANCE_COLUMNS = [
  "year", "total_offenses", "cleared", "not_cleared", "clearance_rate", "months_reported",
];

export type AnnualClearanceDelivery = {
  rows: Record<string, unknown>[];
  columns: string[];
  /** The answer's own wording, which the route puts through its ordinary disclosure chokepoint. */
  explanation: string;
  /**
   * The withholding reasons, kept SEPARATE and appended after disclosures.
   *
   * They are established by this query's own evidence -- rows it fetched and checked -- not by the
   * rows being returned, so the ordinary chokepoint cannot see what supports them and replaced them
   * with a generic omission notice. Carrying them alongside keeps the specific reason in front of
   * the reader without exempting arbitrary narrative or weakening any empty-result protection.
   */
  withheldNote: string;
  title: string;
};

/**
 * Turn executed rows into what the route delivers, or into an honest decline.
 *
 * Lives here rather than in the route so the whole decision -- which years are supportable, what
 * the reader is told, and when there is nothing to tell -- is one function the tests drive directly
 * and the handler merely calls.
 */
export function annualClearanceDelivery(
  question: string, place: string, rows: AnnualClearanceRow[]
): AnnualClearanceDelivery | { decline: string } {
  const contract = buildQueryContract(question, "nibrs");
  const offense = contract?.metric.offenses[0];
  if (!offense) return { decline: "I couldn't establish which offense that question is about." };

  const partition = partitionAnnualClearanceRows(rows);
  const withheldNote = annualClearanceWithheldNote(partition);
  if (partition.delivered.length === 0) {
    // Nothing supportable. The reasons are still the answer, and they are what the reader gets --
    // never an empty table under a confident title.
    return {
      decline: [
        annualClearanceMeaning(offense),
        "No year in the requested range can be reported for " + place + " from this source.",
        withheldNote,
      ].filter(Boolean).join("\n\n"),
    };
  }
  const years = partition.delivered.map((row) => row.year);
  return {
    rows: partition.delivered.map((row) => Object.fromEntries(
      ANNUAL_CLEARANCE_COLUMNS.map((column) => [column, (row as unknown as Record<string, unknown>)[column]]))),
    columns: ANNUAL_CLEARANCE_COLUMNS,
    explanation: [
      annualClearanceMeaning(offense),
      "Clearance here means cleared by arrest or by exceptional means, as recorded by the FBI; it " +
      "is not the same as a conviction.",
      "Complete 12-month reporting years: " + years.join(", ") + ".",
    ].join("\n\n"),
    withheldNote,
    // The title states the years actually delivered, not the years requested.
    title: offense.label + " and clearances, " + place + ", " +
      (years.length === 1 ? String(years[0]) : years[0] + "-" + years[years.length - 1]),
  };
}

/** One sentence per withheld year, naming the year and the reason it is not reported. */
export function annualClearanceWithheldNote(partition: AnnualClearancePartition): string {
  return partition.withheld
    .map((year) => "No figure is given for " + year.year + ": " + year.reason + ".")
    .join("\n\n");
}
