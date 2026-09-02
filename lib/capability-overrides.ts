import { asksClearanceTypeBreakdown } from "./clearance-type-intent";

export interface CapabilityOverride {
  title: string;
  explanation: string;
  guardrail: string;
}

const CLEARANCE_QUESTION_RE = /\b(?:clearance|clearances|cleared|solve[ds]?|unsolved|closure\s+rate)\b/i;

export function asksCurrentYearClearance(question: string): boolean {
  if (!CLEARANCE_QUESTION_RE.test(question)) return false;
  const currentYear = new Date().getFullYear();
  return /\b(?:this\s+year|current\s+year|current-year|ytd|year[-\s]?to[-\s]?date|so\s+far\s+this\s+year)\b/i.test(question) ||
    new RegExp(`\\b(?:in|for|during)\\s+${currentYear}\\b`, "i").test(question);
}

export function asksUnavailableCurrentYearClearance(question: string): boolean {
  return asksCurrentYearClearance(question) && !asksClearanceTypeBreakdown(question);
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

/**
 * Sub-city geography detection. ONE predicate, both enforcement stages.
 *
 * `asksSubCityGeography` is the only entry point. The pre-SQL override
 * (`detectSubCityGeographyOverride`, called by the query/shr/hc routes and the NIBRS
 * wrapper), the post-SQL capability rule (`lib/source-capabilities.ts`) and the
 * guardrail predicate (`lib/guardrails.ts`) all call it, so a change cannot repair one
 * stage and leave the other. The raw regex is deliberately NOT exported.
 *
 * The alternatives fall into two classes, and keeping them apart is the point:
 *
 *  - UNAMBIGUOUS — multi-word phrases ("zip code", "census tract", "block group",
 *    "police district", "community area", "apartment complex") and bare nouns that are
 *    not United States place names ("neighborhood", "precinct"). The token alone
 *    decides, exactly as before; their coverage is unchanged.
 *
 *  - PLACE-COLLIDING — a bare token that is also a real place name, so the token alone
 *    cannot decide. "Ward, AR" is an incorporated city of ~7,300 (`city:AR:ward` in
 *    lib/generated/geo-cities.ts) and "Ward County" is a county in ND and TX
 *    (lib/generated/ambiguous-counties.ts), while "the 5th ward of New Orleans" is a
 *    sub-city geography. Matching the word refused both. These terms therefore require
 *    adjoining sub-city STRUCTURE — an ordinal or identifier, a plural, a distributive
 *    or determiner, a grain phrase, or an explicit "of" relation. A bare token in
 *    place-name position is a place, not a sub-city geography.
 *
 * The split is surveyed, not asserted: scripts/test-subcity-geography.ts scans both
 * generated place catalogs for every alternative below and fails if one that appears
 * there is classified unambiguous. "Ward" is the only term that appears in either —
 * independently the same conclusion scripts/generate-geo-city-catalog.ts reached when
 * it put WARD in EXCLUDED_BARE_NAMES. That survey covers this application's own place
 * inventory; it is not an exhaustive national gazetteer study.
 */
export const UNAMBIGUOUS_SUB_CITY_ALTERNATIVES = [
  String.raw`zip\s*code`,
  String.raw`zip\s*\d`,
  String.raw`neighborhoods?`,
  String.raw`precincts?`,
  String.raw`police districts?`,
  String.raw`census tracts?`,
  String.raw`block groups?`,
  String.raw`community areas?`,
  String.raw`apartment\s+complex(?:es)?`,
  String.raw`housing\s+complex(?:es)?`,
] as const;

/** Bare tokens that are also real place names. See the class note above. */
export const PLACE_COLLIDING_SUB_CITY_TERMS = ["ward"] as const;

const UNAMBIGUOUS_SUB_CITY_RE = new RegExp(
  `\\b(?:${UNAMBIGUOUS_SUB_CITY_ALTERNATIVES.join("|")})\\b`,
  "i"
);

/**
 * Sub-city structure adjoining a place-colliding term. Each alternative is a shape a
 * place name does not take: a place name is singular, is not numbered, is not
 * distributed over, and is not the left side of an "of" relation.
 */
function placeCollidingSubCityRe(term: string): RegExp {
  const t = `${term}s?`;
  return new RegExp(
    [
      // plural — "how many wards", "the wards of New Orleans"
      String.raw`\b${term}s\b`,
      // ordinal in front — "5th ward", "ninth ward"
      String.raw`\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\s+${term}\b`,
      // identifier behind — "ward 9", "ward #9", "ward no. 9". Bounded to three digits
      // so a bare year ("Ward 2022") stays a place name.
      String.raw`\b${term}\s*(?:#|nos?\.?\s*|numbers?\s*)?\d{1,3}\b`,
      // distributive or determiner — "by ward", "per-ward", "each ward", "the ward".
      // The lookahead keeps "the Ward, AR police department" and "the Ward County
      // sheriff" as places: a determiner in front does not make a place name a geography.
      String.raw`\b(?:by|per|across|within|among|amongst|between|each|every|the|this|that|these|those|its|their)[-\s]+${t}\b(?!\s*(?:,\s*[A-Za-z]{2}\b|(?:city|town|village|township|borough|county)\b))`,
      // grain phrasing — "ward level", "ward-level", "ward boundaries", "ward map"
      String.raw`\b${t}[-\s](?:levels?|boundar(?:y|ies)|maps?|lines?)\b`,
      // explicit partitive relation — "ward of New Orleans"
      String.raw`\b${t}\s+of\b`,
    ].join("|"),
    "i"
  );
}

const PLACE_COLLIDING_SUB_CITY_RES = PLACE_COLLIDING_SUB_CITY_TERMS.map(placeCollidingSubCityRe);

/**
 * The shared structural predicate both enforcement stages consult.
 */
export function asksSubCityGeography(question: string): boolean {
  if (UNAMBIGUOUS_SUB_CITY_RE.test(question)) return true;
  return PLACE_COLLIDING_SUB_CITY_RES.some((re) => re.test(question));
}

export const SUB_CITY_GEOGRAPHY_MESSAGE =
  "The FBI does not report crime data below the city/county/agency level. The available FBI datasets are organized by reporting agency, city, county, state, or national totals; they do not support ZIP code, neighborhood, precinct, ward, census tract, block group, apartment-complex, or other sub-city geography.";
export const DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE =
  "I can't calculate a reliable per-capita rate for a demographic group because the FBI data does not include matching population denominators by age, race, or sex for the requested place and year. I can show raw demographic counts, the group's share of reported victims, offenders, or arrestees, or an overall crime rate using the total population.";

export function detectSubCityGeographyOverride(question: string): CapabilityOverride | null {
  if (!asksSubCityGeography(question)) return null;

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

const DEMOGRAPHIC_RATE_DENOMINATOR_FOLLOWUP_RE =
  /\b(?:use|using|take|try|with|from|switch\s+to)\b[\s\S]{0,50}\b(?:census|acs|population)\b[\s\S]{0,50}\bdenominator\b|\b(?:use|using|try|with)\b[\s\S]{0,40}\b(?:different|another|alternate|other)\b[\s\S]{0,30}\b(?:denominator|population\s+(?:data|figures|estimates))\b/i;

export function detectDemographicRateDenominatorFollowup(
  question: string,
  history: Array<{ role: string; content: string }>,
): CapabilityOverride | null {
  if (!DEMOGRAPHIC_RATE_DENOMINATOR_FOLLOWUP_RE.test(question)) return null;
  for (let i = history.length - 1; i >= 0; i--) {
    const prior = history[i];
    if (prior.role !== "user") continue;
    const override = detectDemographicHomicideRateOverride(prior.content);
    if (override) return override;
  }
  return null;
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
