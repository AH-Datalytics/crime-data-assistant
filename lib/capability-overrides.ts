export interface CapabilityOverride {
  title: string;
  explanation: string;
  guardrail: string;
}

const CLEARANCE_QUESTION_RE = /\b(?:clearance|clearances|cleared|solve[ds]?|unsolved|closure\s+rate)\b/i;
const CLEARANCE_METHOD_RE = /\b(?:cleared?\s+by\s+arrest|exceptional(?:ly)?|arrest\s+(?:vs\.?|versus|and)\s+exceptional|by\s+clearance\s+type|clearance\s+type)\b/i;

export function asksCurrentYearClearance(question: string): boolean {
  if (!CLEARANCE_QUESTION_RE.test(question)) return false;
  const currentYear = new Date().getFullYear();
  return /\b(?:this\s+year|current\s+year|current-year|ytd|year[-\s]?to[-\s]?date|so\s+far\s+this\s+year)\b/i.test(question) ||
    new RegExp(`\\b(?:in|for|during)\\s+${currentYear}\\b`, "i").test(question);
}

export function asksUnavailableCurrentYearClearance(question: string): boolean {
  return asksCurrentYearClearance(question) && !CLEARANCE_METHOD_RE.test(question);
}

export function detectCurrentYearClearanceOverride(question: string): CapabilityOverride | null {
  if (!asksUnavailableCurrentYearClearance(question)) return null;
  return {
    title: "Current-Year Clearance Data Unavailable",
    guardrail: "current-year-clearance-unavailable",
    explanation:
      "Current-year clearance rates are not available in Current Trends yet. Historical provides annual clearance rates through the latest complete reporting year, while NIBRS can break clearances down by arrest versus exceptional means. Ask for the latest complete-year clearance rate, or omit the current-year/YTD requirement.",
  };
}

export const SUB_CITY_GEOGRAPHY_RE =
  /\b(zip\s*code|zip\s*\d|neighborhoods?|precincts?|police districts?|census tracts?|block groups?|wards?|community areas?|apartment\s+complex(?:es)?|housing\s+complex(?:es)?)\b/i;

export const SUB_CITY_GEOGRAPHY_MESSAGE =
  "The FBI does not report crime data below the city/county/agency level. The available FBI datasets are organized by reporting agency, city, county, state, or national totals; they do not support ZIP code, neighborhood, precinct, ward, census tract, block group, apartment-complex, or other sub-city geography.";
export const DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE =
  "I can't calculate a reliable per-capita rate for a demographic group because the FBI data does not include matching population denominators by age, race, or sex for the requested place and year. I can show raw demographic counts, the group's share of reported victims, offenders, or arrestees, or an overall crime rate using the total population.";

export function detectSubCityGeographyOverride(question: string): CapabilityOverride | null {
  if (!SUB_CITY_GEOGRAPHY_RE.test(question)) return null;

  return {
    title: "Geography Not Available",
    guardrail: "sub-city-geography-unsupported",
    explanation: SUB_CITY_GEOGRAPHY_MESSAGE,
  };
}

const HOMICIDE_RE = /\b(homicides?|murders?|killings?)\b/i;
const RATE_RE = /\b(rates?|per\s*capita|per\s*100\s*k|per\s*100,?000)\b/i;
const DEMOGRAPHIC_RE = /\b(gender|sex|race|racial|ethnicity|ethnic|female|male|women|men|black|white|hispanic|latino|asian|native|american\s+indian)\b/i;

const AGE_GROUP_RE = /\b(age\s+groups?|by\s+age|juveniles?|teens?|teenagers?|elderly|minors)\b/i;

/**
 * Per-capita/rate intent, shared by the SHR front door and the
 * group-rate-denominator-unavailable guardrail so the two nets can't drift
 * apart (CODEX_REVIEW_9577edc finding 1). Covers denominator variants
 * (per 1,000 / 10,000 / million), likelihood phrasings ("murder risk by
 * race", "how likely"), and population-relative phrasings.
 */
export const GROUP_RATE_INTENT_RE = new RegExp(
  [
    String.raw`per\s*capita`,
    String.raw`per\s*cap\b`,
    String.raw`per\s*1[0,.\s]*0{2,}\s*(?:k\b|people|persons|residents|population|men|women|males|females)?`,
    String.raw`per\s*(?:hundred|thousand|million)(?:\s+(?:thousand|people|persons|residents))?`,
    String.raw`\brates?\b`,
    String.raw`\brisk\b`,
    String.raw`\blikelihood\b`,
    String.raw`how\s+likely`,
    String.raw`\bodds\b`,
    String.raw`relative\s+to\s+(?:the\s+)?population`,
    String.raw`adjusted\s+for\s+population`,
    String.raw`population[-\s]adjusted`,
  ].join("|"),
  "i"
);

export function hasGroupRateIntent(question: string): boolean {
  return GROUP_RATE_INTENT_RE.test(question);
}

export function mentionsDemographicGroup(question: string): boolean {
  return DEMOGRAPHIC_RE.test(question) || AGE_GROUP_RE.test(question);
}

export function isDemographicHomicideRateQuestion(question: string): boolean {
  return HOMICIDE_RE.test(question) && RATE_RE.test(question) && DEMOGRAPHIC_RE.test(question);
}

/**
 * SHR-tab variant: every SHR question is about homicide, so requiring a
 * homicide word makes the check blind to follow-ups that drop it
 * ("i want ir in per capita seperated by race and sex", #4704-#4705,
 * query-audit-2026-07-03 F27). Rate + demographic-group language is enough.
 */
export function detectShrGroupRateOverride(question: string): CapabilityOverride | null {
  // Clearance-rate questions are about case outcomes, not population denominators —
  // let the shr-clearance-override give its redirect to Historical/NIBRS instead.
  if (/\b(clearance|cleared|solve[ds]?|unsolved|closure|close rate|cold case)\b/i.test(question)) return null;
  // Clearly non-SHR concepts (arrests, non-homicide offenses, staffing) should get
  // the accurate scope refusal from the existing SHR overrides, not a misleading
  // denominator explanation (CODEX_REVIEW_9577edc finding 2).
  if (/\b(arrests?|arrested|arrestees?|robber(?:y|ies)|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|assaults?|rapes?|carjackings?|drugs?|narcotics?|dui|staffing|officers?\s+employed)\b/i.test(question)) return null;
  if (!hasGroupRateIntent(question)) return null;
  if (!mentionsDemographicGroup(question)) return null;

  return {
    title: "Demographic Homicide Rates",
    guardrail: "demographic-homicide-rate-denominator-unavailable",
    explanation:
      "I can't calculate per-capita homicide rates by race, sex/gender, or age from these datasets because they do not include matching population denominators for those groups. I can show homicide counts, shares, or breakdowns by victim or offender race, sex/gender, and age, or an overall per-capita rate using total population.",
  };
}

export function detectDemographicHomicideRateOverride(question: string): CapabilityOverride | null {
  if (!isDemographicHomicideRateQuestion(question)) return null;

  return {
    title: "Demographic Homicide Rates",
    guardrail: "demographic-homicide-rate-denominator-unavailable",
    explanation:
      "I can't calculate per-capita homicide rates by race or sex/gender from these datasets because they do not include matching population denominators by race and sex/gender for each requested geography and year. I can show homicide counts, shares, or breakdowns by victim race and sex/gender in the Homicide Reports data, and NIBRS can show victim or offender demographic counts where available.",
  };
}

const COUNTY_SCOPE_RE = /\b[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,4}\s+(?:county|parish|borough)\b/i;
const COUNTY_METADATA_RE = /\b(?:which|what|list|show)\b[\s\S]{0,40}\b(?:agencies|agency|cities|city|jurisdictions|departments)\b/i;
const NIBRS_DEMOGRAPHIC_BREAKDOWN_RE = /\b(?:offenders?|victims?|arrestees?|suspects?|demographics?|demographic|age|ages|age\s+group|race|racial|ethnicity|ethnic|sex|gender|male|female|men|women|juvenile|juveniles?|adult|adults?)\b/i;

export function detectNibrsCountywideDemographicsOverride(question: string): CapabilityOverride | null {
  if (!COUNTY_SCOPE_RE.test(question)) return null;
  // Explicit countywide requests have a deterministic agency-crosswalk route
  // with a participation disclosure. Keep refusing ambiguous county wording.
  if (/\bcountywide\b/i.test(question)) return null;
  if (COUNTY_METADATA_RE.test(question)) return null;
  if (!NIBRS_DEMOGRAPHIC_BREAKDOWN_RE.test(question)) return null;

  return {
    title: "Countywide Demographic Breakdowns",
    guardrail: "nibrs-countywide-demographics-unsupported",
    explanation:
      "I can't reliably produce countywide demographic breakdowns from NIBRS because county totals require combining many agencies with varying participation and reporting completeness. Better choices: ask for a specific city or agency, ask for a statewide demographic breakdown, or ask for a countywide offense count without demographic breakdowns.",
  };
}
