import type { QueryContract, QueryContractSource } from "./query-contract";
import { extractReferencedTables } from "./table-allowlist";
import { SUB_CITY_GEOGRAPHY_MESSAGE, asksSubCityGeography, scopedToNamedAgency } from "./capability-overrides";
import { asksClearanceTypeBreakdown } from "./clearance-type-intent";
import { requestedScope } from "./structural-semantics";
import { mayRefuseAsCourtProcess } from "./clearance-referent";
import { BARE_MEASURE_ZERO_FILL, zeroFillsFinishedRate } from "./historical-rate-zero-fill";
import { shrCountyRequest } from "./shr-county-request";

export type SourceCapabilitySeverity = "warning" | "unsupported";

export type SourceCapabilityFinding = {
  ruleId: string;
  source: QueryContractSource;
  severity: SourceCapabilitySeverity;
  message: string;
  expectedTables?: string[];
  forbiddenTables?: string[];
  actualTables: string[];
};

type RuleContext = {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
  tables: Set<string>;
};

type SourceCapabilityRule = {
  id: string;
  source: QueryContractSource;
  severity: SourceCapabilitySeverity;
  message: string;
  when: (ctx: RuleContext) => boolean;
  requiresAnyTables?: string[];
  forbidsTables?: string[];
  forbiddenSql?: RegExp[];
  /**
   * A forbidden SQL shape a regular expression cannot express.
   *
   * Added for the zero-filled finished rate, whose first argument is four levels of nested
   * parentheses; a pattern loose enough to span it is loose enough to catch things it should not.
   * The predicate is consulted exactly where `forbiddenSql` is, so a rule can use either or both.
   */
  forbiddenSqlShape?: (sql: string) => boolean;
};

const ALL_QUERY_SOURCES: QueryContractSource[] = ["current", "historical", "nibrs", "shr", "hate_crime"];

function hasAnyTable(tables: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((table) => tables.has(table.toLowerCase()));
}

function hasForbiddenTable(tables: Set<string>, candidates: readonly string[]): boolean {
  return candidates.some((table) => tables.has(table.toLowerCase()));
}

function usesForbiddenSql(sql: string, patterns: readonly RegExp[] | undefined): boolean {
  return Boolean(patterns?.some((pattern) => pattern.test(sql)));
}

function asksWeaponQualifiedPersonCrime(question: string, contract: QueryContract): boolean {
  if (!/\b(?:weapons?|firearms?|guns?|handguns?|rifles?|shotguns?|knives?|stabb(?:ing|ings)?|blunt\s+objects?)\b/i.test(question)) return false;
  return (
    ["murder", "rape", "aggravated_assault", "carjacking"].includes(contract.metric.topic) ||
    /\b(?:murders?|homicides?|rapes?|assaults?|aggravated\s+assaults?|victims?)\b/i.test(question)
  );
}

function asksCampusAgency(question: string, contract: QueryContract): boolean {
  return contract.geography.kind === "campus" ||
    /\b(?:universit(?:y|ies)|college|campus|ucla|uc\s+berkeley|berkeley\s+campus)\b/i.test(question);
}

function hasDemographicBreakdown(contract: QueryContract, question: string): boolean {
  return contract.breakdowns.some((breakdown) => ["age_group", "race", "sex"].includes(breakdown)) ||
    /\b(?:demographics?|age|race|racial|ethnicit\w+|hispanic|latino\w*|sex|gender|male|female|men|women|juvenile\w*|teen\w*)\b/i.test(question);
}

function hasCircumstanceBreakdown(question: string, contract: QueryContract): boolean {
  return contract.metric.topic === "domestic_violence" ||
    /\b(?:domestic\s+violence|intimate\s+partner|gang(?:land)?|juvenile\s+gang|argument|circumstance|justifiable|police\s+shooting)\b/i.test(question);
}

/*
 * A NAMED AGENCY IS NOT A COUNTYWIDE REQUEST, even when its own name contains "County".
 *
 * The exclusion below already lived in `asksCountywideGeography`. `asksCountywide` did not apply
 * it, so every rule reading the broader predicate treated "Worcester County Sheriff's Office" as a
 * whole county — including the demographics rule, which refused a question about one agency that
 * the contract had already resolved to one ORI.
 *
 * Applied here rather than at one call site, because "is this a countywide request" is what this
 * predicate answers, and leaving one caller with a different answer is exactly how the divergence
 * arose. Its effect on each caller is covered by test: `asksCountywideGeography` already excluded
 * named agencies and is unchanged; the demographics rule stops refusing them; and the
 * demographic-table steering rule, which applies when NOT countywide, now correctly reaches them.
 */
function asksCountywide(question: string, contract: QueryContract): boolean {
  // The CONTRACT decides first. A high-confidence county geography is a county request however
  // many agencies it names, and letting a mention override it removed the demographics refusal
  // from 'countywide … including the sheriff's office'. Only when the resolved scope is NOT a
  // county does a named agency exclude the request, and `scopedToNamedAgency` additionally
  // withdraws that exclusion for whole-county wording.
  if (contract.geography.kind !== "county" && scopedToNamedAgency(question)) return false;
  return contract.geography.kind === "county" ||
    /\b[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}\s+(?:county|parish|borough)\b/i.test(question);
}

function asksCountywideGeography(question: string, contract: QueryContract): boolean {
  if (!asksCountywide(question, contract)) return false;
  return /\b(?:countywide|county-wide|all\s+(?:agencies|cities)|cities\s+(?:in|within)|agencies\s+(?:in|within)|crime\s+(?:in|within|for)|murders?\s+(?:in|within|for)|homicides?\s+(?:in|within|for)|shootings?\s+(?:in|within|for)|rates?\s+(?:in|within|for))\b/i.test(question) ||
    contract.geography.kind === "county";
}

function asksClearanceType(question: string): boolean {
  return asksClearanceTypeBreakdown(question);
}

function asksClearanceMetric(question: string, contract: QueryContract): boolean {
  return contract.metric.unit === "clearance_rate" ||
    /\b(?:clearance|clearances?|cleared|solve[ds]?|unsolved|exceptional(?:ly)?|cleared\s+by\s+arrest)\b/i.test(question);
}

function hasOriFilter(sql: string): boolean {
  return /\bori\s*(?:=|IN\s*\()/i.test(sql);
}

function asksHistoricalRate(contract: QueryContract, question: string): boolean {
  return contract.metric.unit === "rate_per_100k" ||
    /\brates?\b|\bper\s*(?:100\s*k|100,?000|capita)\b/i.test(question);
}

/**
 * THE LEVEL OF THE REQUESTED ANSWER, NOT THE AREA IT IS DRAWN FROM.
 *
 * Both predicates below read `requestedScope().rowLevel`, which the structural checker already
 * computes from the question, and fall back to the geography only when the question says nothing
 * about the level.
 *
 * WHY. They used to test `contract.geography.kind` alone, which is the area a request FILTERS BY.
 * "Which cities in Louisiana had the highest violent crime rate" resolves geography `state`, and
 * "top 10 us cities by homicide rate" resolves `national` -- yet both ask for a list of CITIES.
 * The state/national rate rule therefore fired on two city-rate requests (GC-058, GC-059) and
 * demanded `historical_state_national`, a table that cannot answer either one; the model's SQL
 * aggregated the agency tables correctly and was rejected twice, and the user saw a generic
 * "I couldn't build a reliable query" message. A genuine state-rate request has row level `state`
 * and still requires the state table, which the fixtures in
 * `audit/historical-city-rate-2026-09-19/` check in both directions.
 *
 * The local-rate rule is corrected with it, in the same direction. A city-row rate under a state
 * filter is a local rate and needs `historical_agency_population` for its denominator; reading the
 * geography alone exempted exactly those requests from the denominator requirement.
 */
function isHistoricalStateOrNational(contract: QueryContract, question: string): boolean {
  const level = requestedScope(question, contract).rowLevel;
  if (level === "state" || level === "national") return true;
  if (level !== "unknown") return false;
  return contract.geography.kind === "state" || contract.geography.kind === "national";
}

function isHistoricalLocalRate(contract: QueryContract, question: string): boolean {
  const level = requestedScope(question, contract).rowLevel;
  if (level === "city" || level === "agency" || level === "county") return true;
  if (level !== "unknown") return false;
  return contract.geography.kind === "city" || contract.geography.kind === "agency" || contract.geography.kind === "county";
}

function isLocalGeography(contract: QueryContract): boolean {
  return ["city", "county", "agency", "campus"].includes(contract.geography.kind);
}

function asksGeographyComparison(question: string): boolean {
  return /\b(?:compare|compared\s+to|versus|vs\.?|against)\b/i.test(question);
}

function asksShrNonHomicideTopic(question: string): boolean {
  const nonHomicide = /\b(robber(?:y|ies)|thefts?|larcen(?:y|ies)|burglar(?:y|ies)|assaults?|rapes?|sexual assault|auto theft|motor vehicle theft|drugs?|arrests?|staffing|officers?|sworn|personnel|property crimes?|violent crimes?)\b/i.test(question);
  if (!nonHomicide) return false;
  return !/\b(homicides?|murders?|kill|circumstance|felony murder|robbery-homicide|homicide during|victims of.*homicide)\b/i.test(question);
}

function asksSpecificDrugType(question: string): boolean {
  return /\b(marijuana|cannabis|weed|cocaine|crack|heroin|meth|methamphetamine|fentanyl|opioids?|opiates?)\b/i.test(question);
}

function asksArrestMetric(question: string): boolean {
  return /\b(arrests?|arrested|arrestees?)\b/i.test(question);
}

function asksShootingCategory(question: string): boolean {
  if (!/\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(question)) return false;
  return !/\b(firearm (?:murder|homicide)|gun (?:murder|homicide)|(?:murder|homicide).{0,15}firearm|closest proxy|approximate|aggravated assault.{0,20}firearm)\b/i.test(question);
}

function asksDomesticViolenceAggravatedAssaultShare(question: string, contract: QueryContract): boolean {
  const asksShare = contract.metric.unit === "ratio" || /\b(?:share|percent(?:age)?|pct|proportion|what\s+portion)\b/i.test(question);
  const asksAggAssault = contract.metric.topic === "aggravated_assault" || /\baggravated\s+assaults?\b/i.test(question);
  const asksDv = /\bdomestic\s+violence\b|\bintimate\s+partner\b|\b(?<![a-z])dv(?![a-z])\b/i.test(question);
  return asksShare && asksAggAssault && asksDv;
}

/**
 * Topics no dataset here carries, other than the court-process family.
 *
 * "prosecution", "convicted", "sentenced", "defendants" and the rest of the court
 * vocabulary deliberately do NOT appear in this list any more. They are decided by
 * referent in lib/clearance-referent.ts, because "prosecution declined" is a police
 * exceptional-clearance reason recorded in NIBRS — refusing on the word alone made every
 * Decision 1 case fail. See that module's header.
 */
function asksNonCourtOutOfScopeTopic(question: string): boolean {
  return /\b(immigration status|illegal immigrant|undocumented|GARS|GVRS|gun violence restraining|red flag law)\b/i.test(question);
}

function asksOutOfScopeTopic(question: string): boolean {
  if (asksNonCourtOutOfScopeTopic(question)) return true;
  // Decision 1: decide by referent, never by keyword.
  return mayRefuseAsCourtProcess(question);
}

function asksAgencyMetadata(question: string): boolean {
  return /\b(?:which|what|list|show)\b[\s\S]{0,50}\b(?:agencies|agency|cities|city|jurisdictions|departments|included|represented)\b/i.test(question);
}

function asksCrimeData(question: string, contract: QueryContract): boolean {
  if (asksAgencyMetadata(question)) return false;
  return contract.metric.topic !== "unknown" ||
    /\b(crimes?|offenses?|incidents?|victims?|murders?|homicides?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|clearance|rates?)\b/i.test(question);
}

function onlyReferencesTables(tables: Set<string>, candidates: readonly string[]): boolean {
  if (tables.size === 0) return false;
  return Array.from(tables).every((table) => candidates.includes(table));
}

function hasHistoricalLocalMetricTable(tables: Set<string>): boolean {
  return hasAnyTable(tables, ["historical_agency_crime", "historical_agency_clearance", "historical_staffing"]);
}

function hasNibrsLocalMetricTable(tables: Set<string>): boolean {
  return hasAnyTable(tables, [
    "summary_city_monthly",
    "summary_victim_city_monthly",
    "summary_victim_weapon",
    "summary_victim_demographics",
    "summary_arrestee_demographics",
    "summary_offender_demographics",
    "summary_clearance_city_annual",
    "summary_clearance_type",
    "summary_clearance_detail",
    "summary_carjacking_clearance",
    "summary_domestic_violence",
    "summary_dv_arrests",
  ]);
}

export const SOURCE_CAPABILITY_RULES: SourceCapabilityRule[] = [
  ...ALL_QUERY_SOURCES.map((source): SourceCapabilityRule => ({
    id: "unsupported-sub-city-geography",
    source,
    severity: "unsupported",
    when: ({ question }) => asksSubCityGeography(question),
    message: SUB_CITY_GEOGRAPHY_MESSAGE,
  })),
  ...ALL_QUERY_SOURCES.map((source): SourceCapabilityRule => ({
    id: "unsupported-court-policy-topic",
    source,
    severity: "unsupported",
    when: ({ question }) => asksOutOfScopeTopic(question),
    message: "The available FBI datasets track reported crime and law-enforcement reporting, not court outcomes, incarceration, fines, immigration status, or policy registries.",
  })),
  ...ALL_QUERY_SOURCES.map((source): SourceCapabilityRule => ({
    id: "demographic-rate-unsupported",
    source,
    severity: "unsupported",
    when: ({ contract }) => contract.metric.unsupportedReason === "demographic_rate_denominator_unavailable",
    message: "The FBI data does not include matching population denominators for demographic groups. Ask for counts or shares by demographic group, or for an overall rate using total population.",
  })),
  {
    id: "current-countywide-crosswalk",
    source: "current",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract),
    message: "Current countywide geography should use agency_county_crosswalk; a county agency row is not a countywide rollup.",
  },
  {
    id: "nibrs-annual-only-arrestee-grain",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_arrestee_demographics", "summary_offender_demographics", "summary_dv_arrests"],
    when: ({ question }) =>
      /\b(?:monthly|per\s+month|by\s+month)\b/i.test(question) &&
      /\b(?:arrest(?:s|ed)?|arrestee(?:s)?|dwi|dui|disorderly\s+conduct|trespass)\b/i.test(question),
    message: "These NIBRS arrest summary tables report annual data, not monthly data. Use an annual request or a source with monthly arrest records.",
  },
  {
    id: "nibrs-weapon-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      !hasDemographicBreakdown(contract, question) &&
      !hasCircumstanceBreakdown(question, contract),
    message: "Weapon-only NIBRS person-crime victim counts and trends must use summary_victim_weapon; demographics summaries are only for race/sex/age/ethnicity breakdowns.",
  },
  {
    id: "nibrs-weapon-demographic-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_demographics"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_weapon"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasDemographicBreakdown(contract, question) &&
      !hasCircumstanceBreakdown(question, contract),
    message: "NIBRS weapon-qualified victim demographic breakdowns should use summary_victim_demographics.",
  },
  {
    id: "nibrs-weapon-circumstance-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon_circumstance", "summary_victim_weapon_circumstance_demo"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics", "summary_victim_weapon"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasCircumstanceBreakdown(question, contract) &&
      !hasDemographicBreakdown(contract, question),
    message: "NIBRS queries combining weapon and circumstance should use summary_victim_weapon_circumstance.",
  },
  {
    id: "nibrs-weapon-circumstance-demographic-person-crime-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_weapon_circumstance_demo"],
    forbidsTables: ["summary_victim_city_monthly", "summary_victim_state_monthly", "summary_victim_demographics", "summary_victim_weapon", "summary_victim_weapon_circumstance"],
    when: ({ question, contract }) =>
      asksWeaponQualifiedPersonCrime(question, contract) &&
      hasCircumstanceBreakdown(question, contract) &&
      hasDemographicBreakdown(contract, question),
    message: "NIBRS queries combining weapon, circumstance, and demographic breakdowns should use summary_victim_weapon_circumstance_demo.",
  },
  {
    id: "nibrs-clearance-weapon-unsupported",
    source: "nibrs",
    severity: "unsupported",
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && asksWeaponQualifiedPersonCrime(question, contract),
    message: "NIBRS cannot calculate clearance rates broken down by weapon type from the available summaries. Offer overall clearance rates or weapon-specific counts instead.",
  },
  {
    id: "nibrs-specific-drug-offense-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_drug_monthly"],
    when: ({ question }) => asksSpecificDrugType(question) && !asksArrestMetric(question),
    message: "NIBRS drug-specific offense queries should use summary_drug_monthly, which contains suspected_drug_type.",
  },
  {
    id: "nibrs-specific-drug-arrest-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_drug_arrests"],
    when: ({ question }) => asksSpecificDrugType(question) && asksArrestMetric(question),
    message: "NIBRS drug-specific arrest queries should use summary_drug_arrests, not the all-drug arrestee demographics summary.",
  },
  {
    id: "nibrs-shooting-category-unsupported",
    source: "nibrs",
    severity: "unsupported",
    when: ({ question }) => asksShootingCategory(question),
    message: "The FBI does not systemically track all shootings. Fatal shootings can be queried in SHR, and aggravated assaults with a firearm can be used as a broader NIBRS measure.",
  },
  {
    id: "nibrs-dv-assault-share-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_victim_circumstance"],
    forbidsTables: ["summary_domestic_violence"],
    when: ({ question, contract }) => asksDomesticViolenceAggravatedAssaultShare(question, contract),
    message: "NIBRS domestic-violence share of aggravated assault should use victim_count from summary_victim_circumstance where ucr_offense_code = '13A' and circumstance_code = '06', divided by aggravated-assault victim_count from the same year/geography. Do not mix distinct DV incidents from summary_domestic_violence with victim totals.",
  },
  {
    id: "nibrs-carjacking-clearance-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_carjacking_clearance"],
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && contract.metric.topic === "carjacking",
    message: "NIBRS carjacking clearance queries should use summary_carjacking_clearance.",
  },
  {
    id: "nibrs-clearance-type-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["summary_clearance_type", "summary_clearance_detail", "summary_victim_clearance_demographics", "summary_victim_circumstance_clearance_demo"],
    forbidsTables: ["summary_city_monthly", "summary_state_monthly", "summary_victim_city_monthly", "summary_victim_state_monthly"],
    when: ({ question, contract }) => asksClearanceMetric(question, contract) && asksClearanceType(question),
    message: "NIBRS arrest-vs-exceptional or exceptional-clearance questions should use a clearance-detail summary table, not ordinary offense-count summaries.",
  },
  {
    id: "nibrs-campus-agency-resolution",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["agencies"],
    when: ({ question, contract, sql }) => asksCampusAgency(question, contract) && !hasOriFilter(sql),
    message: "NIBRS campus/university questions should resolve campus agency ORIs through agencies rather than using the surrounding citywide agency.",
  },
  {
    id: "nibrs-countywide-crosswalk",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    forbidsTables: ["county_lookup"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract) && !hasDemographicBreakdown(contract, question),
    message: "NIBRS countywide geography should use agency_county_crosswalk, not county_lookup or a single county agency.",
  },
  {
    id: "nibrs-countywide-demographics-unsupported",
    source: "nibrs",
    severity: "unsupported",
    when: ({ question, contract }) => asksCountywide(question, contract) && hasDemographicBreakdown(contract, question),
    message: "Countywide NIBRS demographic breakdowns are unsupported because county totals combine agencies with varying participation and completeness.",
  },
  {
    id: "nibrs-continuous-reporters-range-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: ["nibrs_consistent_reporters"],
    when: ({ contract }) => contract.comparability.continuousReporters,
    message: "Continuous-reporter NIBRS queries should use nibrs_consistent_reporters for the requested year range.",
  },
  {
    id: "nibrs-demographic-breakdown-table",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: [
      "summary_victim_demographics",
      "summary_offender_demographics",
      "summary_arrestee_demographics",
      "summary_carjacking_victim_demographics",
      "summary_carjacking_offender_demographics",
      "summary_carjacking_arrestee_demographics",
      "summary_domestic_violence",
      "summary_dv_arrests",
    ],
    when: ({ question, contract }) => !asksCountywide(question, contract) && hasDemographicBreakdown(contract, question),
    message: "NIBRS demographic breakdowns should use a demographic-capable summary table.",
  },
  {
    id: "nibrs-local-geography-state-table",
    source: "nibrs",
    severity: "warning",
    forbidsTables: ["summary_state_monthly", "summary_victim_state_monthly"],
    when: ({ question, contract, tables }) =>
      isLocalGeography(contract) &&
      !(asksGeographyComparison(question) && hasNibrsLocalMetricTable(tables)),
    message: "NIBRS local geography questions should not be answered from state summary tables; filter to the requested city, agency, campus agency, or county crosswalk.",
  },
  {
    id: "nibrs-agency-lookup-not-crime-data",
    source: "nibrs",
    severity: "warning",
    requiresAnyTables: [
      "summary_city_monthly",
      "summary_state_monthly",
      "summary_victim_city_monthly",
      "summary_victim_state_monthly",
      "summary_victim_weapon",
      "summary_victim_demographics",
      "summary_arrestee_demographics",
      "summary_offender_demographics",
      "summary_clearance_city_annual",
      "summary_clearance_type",
      "summary_clearance_detail",
      "summary_carjacking_clearance",
      "summary_domestic_violence",
      "summary_dv_arrests",
    ],
    when: ({ question, contract, tables }) => asksCrimeData(question, contract) && onlyReferencesTables(tables, ["agencies"]),
    message: "The user asked for crime data, but the SQL only queries agency metadata. Join to an offense, victim, clearance, or demographic summary table.",
  },
  {
    id: "historical-countywide-crosswalk",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    when: ({ question, contract }) => asksCountywideGeography(question, contract),
    message: "Historical countywide geography should use agency_county_crosswalk; a county agency row is not a countywide rollup.",
  },
  {
    id: "historical-clearance-table",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["national_clearance_rate", "historical_agency_clearance"],
    when: ({ contract }) => contract.metric.unit === "clearance_rate",
    message: "Historical clearance-rate questions should use national_clearance_rate or historical_agency_clearance.",
  },
  {
    id: "historical-state-national-rate-table",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["historical_state_national"],
    when: ({ contract, question }) => contract.metric.unit !== "clearance_rate" && asksHistoricalRate(contract, question) && isHistoricalStateOrNational(contract, question),
    message: "Historical state or national rate questions should use historical_state_national, not agency aggregation.",
  },
  {
    id: "historical-local-rate-population",
    source: "historical",
    severity: "warning",
    requiresAnyTables: ["historical_agency_population"],
    when: ({ contract, question, tables }) =>
      asksHistoricalRate(contract, question) &&
      isHistoricalLocalRate(contract, question) &&
      hasAnyTable(tables, ["historical_agency_crime", "historical_staffing"]),
    message: "Historical local rate questions need historical_agency_population for the denominator.",
  },
  {
    id: "historical-rate-null-gaps",
    source: "historical",
    severity: "warning",
    // The bare measure column, and the finished rate. Both come from the one shared detector in
    // lib/historical-rate-zero-fill.ts, so this rule and the `historical-rate-zero-fill` guardrail
    // cannot disagree about the same statement — which is what would let a retry return a query
    // the first pass had already refused.
    forbiddenSql: [BARE_MEASURE_ZERO_FILL],
    forbiddenSqlShape: zeroFillsFinishedRate,
    when: ({ contract, question }) => asksHistoricalRate(contract, question),
    message: "Historical rate time series should preserve missing values as NULL rather than zero-filling numerator or denominator fields, or the finished rate itself. A year nobody reported must stay blank; a rate of zero says the place recorded none.",
  },
  {
    id: "historical-local-geography-state-table",
    source: "historical",
    severity: "warning",
    forbidsTables: ["historical_state_national"],
    when: ({ question, contract, tables }) =>
      isLocalGeography(contract) &&
      !(asksGeographyComparison(question) && hasHistoricalLocalMetricTable(tables)),
    message: "Historical local geography questions should not be answered from historical_state_national; use agency-level historical tables for the requested city, agency, or county geography.",
  },
  {
    id: "historical-parish-type-city",
    source: "historical",
    severity: "warning",
    forbiddenSql: [
      /\bagency\s*=\s*'[^']*\bparish'\s+AND\s+(?:\w+\.)?type\s*=\s*'city'/i,
      /\b(?:\w+\.)?type\s*=\s*'city'\s+AND\s+(?:\w+\.)?agency\s*=\s*'[^']*\bparish'/i,
    ],
    when: ({ question }) => /\bparish\b/i.test(question),
    message: "Louisiana parishes are county-equivalent agencies in Historical data; parish filters should use type = 'county', not type = 'city'.",
  },
  {
    id: "historical-agency-lookup-not-crime-data",
    source: "historical",
    severity: "warning",
    requiresAnyTables: [
      "historical_agency_crime",
      "historical_agency_clearance",
      "historical_agency_population",
      "historical_staffing",
      "historical_state_national",
      "national_clearance_rate",
    ],
    when: ({ question, contract, tables }) => asksCrimeData(question, contract) && onlyReferencesTables(tables, ["historical_agency"]),
    message: "The user asked for crime data, but the SQL only queries Historical agency metadata. Join to historical crime, clearance, population, or staffing tables as appropriate.",
  },
  {
    id: "shr-campus-agency-resolution",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["shr_agency_alias"],
    when: ({ question, contract }) => asksCampusAgency(question, contract),
    message: "SHR campus/university questions should resolve the campus agency through shr_agency_alias rather than using the surrounding citywide agency.",
  },
  {
    id: "shr-countywide-crosswalk",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["agency_county_crosswalk"],
    // GC-080: when the route binds a named county itself (the sheriff by default, or the county's
    // agencies as an explicit ORI list), the crosswalk join is not required -- the bound ORIs are
    // enforced on the executed statement instead. Shapes it does not bind ("by county") keep the rule.
    when: ({ question, contract }) => asksCountywideGeography(question, contract) && !shrCountyRequest(question),
    message: "SHR countywide geography should use agency_county_crosswalk; a county sheriff agency is not a countywide rollup.",
  },
  {
    id: "shr-homicide-only",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["incidents", "victims"],
    when: ({ contract }) => contract.metric.topic === "murder" || contract.metric.topic === "unknown",
    message: "SHR answers should be homicide-specific and count victims through incidents joined to victims.",
  },
  /*
   * ONLY NIBRS SEPARATES A THEFT FROM A VEHICLE FROM A BURGLARY.
   *
   * The contract now reads "vehicle burglaries" as NIBRS `23F`, Theft From Motor Vehicle, which is
   * the crime the phrase names. Current Trends and Historical carry a `Burglary` value and a
   * `burglary` column and nothing corresponding to `23F` at all -- so on those tabs the honest
   * answer is that this measure is not available here, not a burglary figure wearing the question's
   * label. Without this the corrected wording would simply move the wrong answer to another tab.
   */
  ...(["current", "historical"] as const).map((source) => ({
    id: "vehicle-burglary-unsupported",
    source,
    severity: "unsupported" as const,
    when: ({ contract }: RuleContext) => contract.metric.topic === "vehicle_burglary",
    message:
      "Thefts from vehicles are a separate NIBRS offense and this source does not carry them; it " +
      "holds only the broader burglary category.",
  })),
  {
    id: "shr-non-homicide-unsupported",
    source: "shr",
    severity: "unsupported",
    when: ({ question }) => asksShrNonHomicideTopic(question),
    message: "The Homicide Reports dataset contains only homicide data and cannot answer non-homicide offense, arrest, staffing, or broad crime-category questions.",
  },
  {
    id: "shr-clearance-unsupported",
    source: "shr",
    severity: "unsupported",
    when: ({ question, contract }) => asksClearanceMetric(question, contract),
    message: "The Homicide Reports dataset does not track whether cases were solved or cleared. Clearance-rate questions should use Historical or NIBRS data.",
  },
  {
    id: "shr-demographic-rate-unsupported",
    source: "shr",
    severity: "unsupported",
    when: ({ contract }) => contract.metric.unsupportedReason === "demographic_rate_denominator_unavailable",
    message: "SHR demographic rates are unsupported because matching demographic population denominators are not available.",
  },
  {
    id: "shr-state-rate-population",
    source: "shr",
    severity: "warning",
    requiresAnyTables: ["state_population"],
    when: ({ contract }) => contract.metric.unit === "rate_per_100k" && (contract.geography.kind === "state" || contract.geography.kind === "national"),
    message: "SHR state or national rates should use state_population for the denominator.",
  },
  {
    id: "current-rate-population",
    source: "current",
    severity: "warning",
    requiresAnyTables: ["agency_population"],
    when: ({ contract }) => contract.metric.unit === "rate_per_100k",
    message: "Current Trends rate questions should use agency_population for the denominator.",
  },
];

export function validateSourceCapabilities(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
}): SourceCapabilityFinding[] {
  const actualTables = extractReferencedTables(opts.sql).map((table) => table.toLowerCase());
  const tables = new Set(actualTables);
  const findings: SourceCapabilityFinding[] = [];

  for (const rule of SOURCE_CAPABILITY_RULES) {
    if (rule.source !== opts.source) continue;
    const ctx: RuleContext = {
      question: opts.question,
      source: opts.source,
      contract: opts.contract,
      sql: opts.sql,
      tables,
    };
    if (!rule.when(ctx)) continue;

    const missingRequired = rule.requiresAnyTables && !hasAnyTable(tables, rule.requiresAnyTables);
    const hasForbidden = rule.forbidsTables && hasForbiddenTable(tables, rule.forbidsTables);
    const forbiddenSql = usesForbiddenSql(opts.sql, rule.forbiddenSql)
      || Boolean(rule.forbiddenSqlShape && rule.forbiddenSqlShape(opts.sql));
    const unsupported = rule.severity === "unsupported";

    if (unsupported || missingRequired || hasForbidden || forbiddenSql) {
      findings.push({
        ruleId: rule.id,
        source: rule.source,
        severity: rule.severity,
        message: rule.message,
        expectedTables: rule.requiresAnyTables,
        forbiddenTables: rule.forbidsTables,
        actualTables,
      });
    }
  }

  return findings;
}
