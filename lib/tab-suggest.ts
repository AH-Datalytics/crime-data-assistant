/**
 * Capability-based dataset router.
 *
 * Parses questions into structured intent, then matches against
 * each dataset's declared capabilities to route to the best source.
 * No AI calls — pure regex + scoring logic.
 *
 * Disabled sources (via lib/sources.ts feature flags) are excluded
 * from scoring, recommendations, and auto-routing.
 */

import { type SourceId, isSourceEnabled, enabledSourceIds } from "./sources";
import {
  asksToIncludeCurrentYear,
  pastCompleteCalendarYearsRange,
  pastYearsIncludingCurrentRange,
  relativeYearRangeForQuestion,
} from "./time-conventions";
import { asksCurrentYearClearance, asksUnavailableCurrentYearClearance, isDemographicHomicideRateQuestion } from "./capability-overrides";

export type TabId = SourceId;

export interface TabRecommendation {
  tab: TabId;
  /** Why this tab fits — conversational, shown to user */
  why: string;
  /** Is this the primary recommendation? */
  primary: boolean;
  /** Strength score (0-10) */
  score: number;
}

export interface AutoRouteResult {
  source: TabId;
  reason: string;
  confidence: "high" | "medium" | "low";
  alternatives: TabRecommendation[];
}

export interface ManualSourceNudge {
  source: TabId;
  reason: string;
  confidence: "high";
  message: string;
}

export interface TabSuggestion {
  tab: TabId;
  reason: string;
}

/** Tab display names */
export const TAB_DISPLAY_NAMES: Record<TabId, string> = {
  current: "Current Trends",
  historical: "Historical Library",
  nibrs: "NIBRS",
  shr: "Homicide Reports",
  hate_crime: "Hate Crime",
};

/** Tab colors */
export const TAB_COLORS: Record<TabId, string> = {
  current: "#475EC7",
  historical: "#8B5E3C",
  nibrs: "#2d8659",
  shr: "#B8860B",
  hate_crime: "#4A4A4A",
};

// ══════════════════════════════════════════════════════════════════════
//  QueryIntent: structured representation of what the question asks
// ══════════════════════════════════════════════════════════════════════

export interface QueryIntent {
  offense: string | null;
  measure: string; // "count" | "rate" | "clearance_rate" | "share" | "ranking" | "trend" | "comparison"
  geography: {
    type: "city" | "county" | "state" | "national" | "ambiguous";
    name?: string;
    state?: string;
  };
  timeRange: { start: number | null; end: number | null };
  granularity: "monthly" | "annual" | "unspecified";
  requiredAttributes: string[];
  unsupportedConcepts: string[];
}

// ══════════════════════════════════════════════════════════════════════
//  Dataset capability registry
// ══════════════════════════════════════════════════════════════════════

interface DatasetCapabilities {
  id: TabId;
  displayName: string;
  description: string;
  /** Years of coverage */
  yearRange: { start: number; end: number };
  /** Supported temporal granularity */
  granularity: ("monthly" | "annual")[];
  /** Supported offenses — null = all Part I UCR, "all_nibrs" = all 52+ codes, "homicide_only" = murder/manslaughter */
  offenseScope: "part1_ucr" | "all_nibrs" | "homicide_only" | "hate_crime_only";
  /** Attributes this dataset provides */
  attributes: Set<string>;
  /** Approximate number of agencies */
  agencyCount: number;
  /** Whether county-level queries are supported */
  hasCounty: boolean;
  /** Whether state-level rate data is available */
  hasStateRates: boolean;
}

export type SourceYearRanges = Partial<Record<TabId, { start: number; end: number }>>;

const DATASET_REGISTRY: Record<TabId, DatasetCapabilities> = {
  current: {
    id: "current",
    displayName: "Current Trends",
    description: "Monthly data from ~700 agencies, 2017–present",
    yearRange: { start: 2017, end: 2026 },
    granularity: ["monthly"],
    offenseScope: "part1_ucr",
    attributes: new Set([]),
    agencyCount: 700,
    hasCounty: false,
    hasStateRates: false,
  },
  historical: {
    id: "historical",
    displayName: "Historical Library",
    description: "Annual agency, state, and nationwide data going back decades",
    yearRange: { start: 1930, end: 2025 },
    granularity: ["annual"],
    offenseScope: "part1_ucr",
    attributes: new Set(["clearance_rate", "staffing"]),
    agencyCount: 10000,
    hasCounty: true,
    hasStateRates: true,
  },
  nibrs: {
    id: "nibrs",
    displayName: "NIBRS",
    description: "Incident-level detail, 1991 - present",
    yearRange: { start: 1991, end: 2026 },
    granularity: ["monthly", "annual"],
    offenseScope: "all_nibrs",
    attributes: new Set([
      "weapon", "firearm", "victim_race", "victim_sex", "victim_age",
      "offender_demographics", "offender_race", "offender_sex", "offender_age",
      "arrest_demographics", "arrestee_race", "arrestee_sex", "arrestee_age",
      "relationship", "location_type", "bias", "hate_crime",
      "drug_type", "clearance_type", "clearance_rate",
      "carjacking", "time_of_day", "domestic_violence",
      "group_b_offenses", "incident_level",
    ]),
    agencyCount: 10000,
    hasCounty: false,
    hasStateRates: false,
  },
  shr: {
    id: "shr",
    displayName: "Homicide Reports",
    description: "Homicide victim-offender detail, 1976–present",
    yearRange: { start: 1976, end: 2025 },
    granularity: ["monthly", "annual"],
    offenseScope: "homicide_only",
    attributes: new Set([
      "weapon", "firearm", "victim_race", "victim_sex", "victim_age",
      "offender_demographics", "offender_race", "offender_sex", "offender_age",
      "relationship", "circumstance", "domestic_violence",
    ]),
    agencyCount: 10000,
    hasCounty: false,
    hasStateRates: false,
  },
  hate_crime: {
    id: "hate_crime",
    displayName: "Hate Crime",
    description: "FBI hate crime statistics with bias motivation detail, 1991–present",
    yearRange: { start: 1991, end: 2025 },
    granularity: ["annual"],
    offenseScope: "hate_crime_only",
    attributes: new Set([
      "bias", "hate_crime", "location_type",
      "offender_race", "offender_demographics",
    ]),
    agencyCount: 15000,
    hasCounty: false,
    hasStateRates: false,
  },
};

function datasetsWithYearRanges(yearRanges?: SourceYearRanges): DatasetCapabilities[] {
  return (Object.values(DATASET_REGISTRY) as DatasetCapabilities[]).map((ds) => {
    const override = yearRanges?.[ds.id];
    return override ? { ...ds, yearRange: override } : ds;
  });
}

// ══════════════════════════════════════════════════════════════════════
//  Offense detection
// ══════════════════════════════════════════════════════════════════════

/** Offenses that NIBRS handles but Historical/Current do not */
const NIBRS_ONLY_OFFENSES = new Set([
  "carjacking", "vehicle_burglary", "theft_from_vehicle",
  "dui", "dwi", "trespass", "disorderly_conduct", "curfew",
  "liquor_law", "bad_checks", "peeping_tom", "runaway",
  "family_offense", "all_other_offenses",
  "drug_offense", "fraud", "embezzlement", "vandalism",
  "intimidation", "simple_assault", "kidnapping",
  "human_trafficking", "animal_cruelty", "extortion",
  "gambling", "prostitution", "pornography",
  "stolen_property", "weapon_law_violation",
  "identity_theft", "hacking",
]);

/** Offenses that are homicide-specific */
const HOMICIDE_OFFENSES = new Set(["murder", "homicide", "manslaughter", "killing", "nonnegligent_manslaughter"]);

/** Part I UCR offenses — supported by Current, Historical, NIBRS */
const PART1_OFFENSES = new Set([
  "murder", "homicide", "rape", "robbery", "aggravated_assault",
  "burglary", "theft", "larceny", "motor_vehicle_theft", "auto_theft", "arson",
  "violent_crime", "property_crime",
]);

function normalizeOffense(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z_\s]/g, "")
    .replace(/\s+/g, "_")
    .trim();
}

function detectOffense(q: string): string | null {
  // Specific offense patterns (most specific first)
  const offensePatterns: [RegExp, string][] = [
    [/\bcarjack/i, "carjacking"],
    [/\bvehicle\s*burglar/i, "vehicle_burglary"],
    [/\btheft\s*from\s*(motor\s*)?vehicle|TFMV\b/i, "theft_from_vehicle"],
    [/\b(auto|motor\s*vehicle|car)\s*theft/i, "motor_vehicle_theft"],
    [/\baggravated\s*assault/i, "aggravated_assault"],
    [/\bsimple\s*assault/i, "simple_assault"],
    [/\bmurders?\b|homicides?\b|killings?\b/i, "murder"],
    [/\bmanslaughter/i, "manslaughter"],
    [/\brapes?\b/i, "rape"],
    [/\brobber(?:y|ies)\b/i, "robbery"],
    [/\bassaults?\b/i, "aggravated_assault"],
    [/\bburglar(?:y|ies)\b/i, "burglary"],
    [/\bthefts?\b|larcen(?:y|ies)\b/i, "theft"],
    [/\barson/i, "arson"],
    [/\bDUI\b|DWI\b|drunk\s*driv/i, "dui"],
    [/\btrespass/i, "trespass"],
    [/\bdisorderly\s*conduct/i, "disorderly_conduct"],
    [/\bcurfew/i, "curfew"],
    [/\bliquor\s*law/i, "liquor_law"],
    [/\bdrug\s*(offense|violation|crime)/i, "drug_offense"],
    [/\bhate\s*crime/i, "hate_crime"],
    [/\banti-(jewish|semit|black|white|asian|hispanic|latino|muslim|islamic|arab|sikh|hindu|gay|lesbian|lgbtq|transgender|bisexual)\b/i, "hate_crime"],
    [/\b(antisemit|islamophob|xenophob)\w*/i, "hate_crime"],
    [/\bbias[- ]motivated/i, "hate_crime"],
    [/\bviolent\s*crime/i, "violent_crime"],
    [/\bproperty\s*crime/i, "property_crime"],
    [/\bidentity\s*theft/i, "identity_theft"],
    [/\bfraud/i, "fraud"],
    [/\bembezzlement/i, "embezzlement"],
    [/\bvandalism/i, "vandalism"],
    [/\bintimidation/i, "intimidation"],
    [/\bkidnapping/i, "kidnapping"],
    [/\bhuman\s*trafficking/i, "human_trafficking"],
    [/\banimal\s*cruelty/i, "animal_cruelty"],
    [/\bextortion/i, "extortion"],
    [/\bgambling/i, "gambling"],
    [/\bprostitution/i, "prostitution"],
    [/\bpornography/i, "pornography"],
    [/\bstolen\s*property/i, "stolen_property"],
    [/\bweapon\s*law/i, "weapon_law_violation"],
  ];

  for (const [pattern, offense] of offensePatterns) {
    if (pattern.test(q)) return offense;
  }

  // Generic crime
  if (/\bcrime\b/i.test(q) && !/hate\s*crime/i.test(q)) return null; // generic, no specific offense
  return null;
}

// ══════════════════════════════════════════════════════════════════════
//  Intent parsing
// ══════════════════════════════════════════════════════════════════════

function detectMeasure(q: string): string {
  if (/\bclearance\s*(rate|percent|pct)/i.test(q)) return "clearance_rate";
  if (/\bcleared?\s*by\s*(arrest|exceptional)/i.test(q) || /\b(arrest|exceptional)\s*clearance/i.test(q)) return "clearance_rate";
  if (/\b(rates?|per\s*capita|per\s*100\s*k|per\s*100,?000)\b/i.test(q)) return "rate";
  if (/\b(share|percent|proportion|breakdown)\b/i.test(q)) return "share";
  if (/\b(ranking|rank|top\s*\d+|highest|lowest|most|least|which\s+(cities|states|agencies))\b/i.test(q)) return "ranking";
  if (/\b(compare|comparison|vs\.?|versus)\b/i.test(q)) return "comparison";
  if (/\b(trend|change|over\s*time|year.over.year|month.over.month|trajectory)\b/i.test(q)) return "trend";
  return "count";
}

function detectGeography(q: string): QueryIntent["geography"] {
  // County detection
  const countyMatch = q.match(/\b(\w+(?:\s+\w+)?)\s+county\b/i);
  if (countyMatch) {
    return { type: "county", name: countyMatch[1] };
  }

  // National patterns
  if (/\b(national|nationwide|united\s*states|country\s*wide|U\.?S\.?\s*total)\b/i.test(q)) {
    return { type: "national" };
  }

  // State detection
  const statePattern = /\b(in\s+)?(Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New\s+Hampshire|New\s+Jersey|New\s+Mexico|New\s+York(?:\s+state)?|North\s+Carolina|North\s+Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode\s+Island|South\s+Carolina|South\s+Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington\s+state|West\s+Virginia|Wisconsin|Wyoming|District\s+of\s+Columbia|DC)\b/i;
  const stateMatch = q.match(statePattern);
  if (stateMatch) {
    const name = (stateMatch[2] || stateMatch[1] || "").trim();
    // Check if it's also a city name being mentioned (e.g., "in Houston, Texas")
    const cityBeforeState = q.match(/\bin\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*),?\s+(?:Alabama|Texas|California|etc)/i);
    if (cityBeforeState) {
      return { type: "city", name: cityBeforeState[1], state: name };
    }
    return { type: "state", name };
  }

  // City detection (known cities + "in City" pattern)
  const knownCities = /\b(Houston|Chicago|Dallas|Phoenix|New\s+York(?:\s+City)?|Los\s+Angeles|Philadelphia|Baltimore|Memphis|Nashville|Charlotte|Denver|Seattle|Portland|Miami|Atlanta|Boston|Detroit|Minneapolis|Cleveland|Pittsburgh|Cincinnati|Orlando|Tampa|Milwaukee|New\s+Orleans|Oakland|Sacramento|San\s+Francisco|San\s+Diego|San\s+Antonio|Austin|Jacksonville|Columbus|Indianapolis|Louisville|Richmond|Norfolk|Omaha|Raleigh|Tucson|Fresno|Albuquerque|El\s+Paso|Oklahoma\s+City|Las\s+Vegas|Kansas\s+City|St\.?\s*Louis|Baton\s+Rouge|Washington\s+DC)\b/i;
  const cityMatch = q.match(knownCities);
  if (cityMatch) return { type: "city", name: cityMatch[1] };

  // "in City" pattern
  const inCityMatch = q.match(/\bin\s+([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)/);
  if (inCityMatch) {
    const candidate = inCityMatch[1];
    if (!/\b(United|National|Annual|Federal|Home|Residential|Commercial)\b/i.test(candidate)) {
      return { type: "city", name: candidate };
    }
  }

  // Agency abbreviations
  const abbrevs: [RegExp, string][] = [
    [/\bNYPD\b/i, "New York City"],
    [/\bLAPD\b/i, "Los Angeles"],
    [/\bCPD\b|Chicago\s+police/i, "Chicago"],
    [/\bHPD\b|Houston\s+police/i, "Houston"],
    [/\bDPD\b|Dallas\s+police/i, "Dallas"],
    [/\bBPD\b|Baltimore\s+police/i, "Baltimore"],
    [/\bMPD\b|Memphis\s+police/i, "Memphis"],
    [/\bCMPD\b/i, "Charlotte"],
    [/\bMNPD\b|Metro\s+Nashville/i, "Nashville"],
    [/\bLVMPD\b/i, "Las Vegas"],
  ];
  for (const [pat, city] of abbrevs) {
    if (pat.test(q)) return { type: "city", name: city };
  }

  return { type: "ambiguous" };
}

function detectTimeRange(q: string): QueryIntent["timeRange"] {
  const currentYear = new Date().getFullYear();
  const relativeRange = relativeYearRangeForQuestion(q);
  if (relativeRange) return relativeRange;

  // "from YYYY to YYYY" or "YYYY-YYYY" or "YYYY to YYYY"
  const rangeMatch = q.match(/\b(19\d{2}|20\d{2})\s*(?:to|through|-|–)\s*(19\d{2}|20\d{2})\b/i);
  if (rangeMatch) return { start: parseInt(rangeMatch[1]), end: parseInt(rangeMatch[2]) };

  // "from 1960 to present" is an open-ended historical range, not a current-year-only ask.
  const openEndedRangeMatch = q.match(/\b(?:since|from|starting|beginning)\s+(19\d{2}|20\d{2})\s*(?:(?:to|through|-|–)\s*)?(?:present|current|now|today)\b/i);
  if (openEndedRangeMatch) return { start: parseInt(openEndedRangeMatch[1]), end: null };

  const bareOpenEndedRangeMatch = q.match(/\b(19\d{2}|20\d{2})\s*(?:to|through|-|–)\s*(?:present|current|now|today)\b/i);
  if (bareOpenEndedRangeMatch) return { start: parseInt(bareOpenEndedRangeMatch[1]), end: null };

  // "past/last N years"
  const relativeYears = q.match(/\b(?:past|last)\s+(\d{1,2})\s+years?\b/i);
  if (relativeYears) {
    const years = Number(relativeYears[1]);
    return asksToIncludeCurrentYear(q)
      ? pastYearsIncludingCurrentRange(years)
      : pastCompleteCalendarYearsRange(years);
  }
  const relativeYearWords = q.match(/\b(?:past|last)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+years?\b/i);
  if (relativeYearWords) {
    const wordToNumber: Record<string, number> = {
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    const years = wordToNumber[relativeYearWords[1].toLowerCase()];
    return asksToIncludeCurrentYear(q)
      ? pastYearsIncludingCurrentRange(years)
      : pastCompleteCalendarYearsRange(years);
  }

  // Recent/current/latest language should prefer current data when otherwise ambiguous.
  if (/\b(current|currently|recent|latest|present|right\s+now)\b/i.test(q)) {
    return { start: currentYear, end: currentYear };
  }

  // "since YYYY" or "from YYYY"
  const sinceMatch = q.match(/\b(?:since|from|starting|beginning|after)\s+(19\d{2}|20\d{2})\b/i);
  if (sinceMatch) return { start: parseInt(sinceMatch[1]), end: null };

  // "in YYYY"
  const inMatch = q.match(/\bin\s+(19\d{2}|20\d{2})\b/i);
  if (inMatch) return { start: parseInt(inMatch[1]), end: parseInt(inMatch[1]) };

  // Bare year mentions
  const years = (q.match(/\b(19\d{2}|20\d{2})\b/g) || []).map(Number).sort((a, b) => a - b);
  if (years.length >= 2) return { start: years[0], end: years[years.length - 1] };
  if (years.length === 1) return { start: years[0], end: null };

  return { start: null, end: null };
}

function detectGranularity(q: string): "monthly" | "annual" | "unspecified" {
  if (/\b(monthly|per\s*month|by\s*month|month.over.month|rolling|each\s*month)\b/i.test(q)) return "monthly";
  if (/\b(annual|yearly|per\s*year|by\s*year|each\s*year)\b/i.test(q)) return "annual";
  return "unspecified";
}

function detectRequiredAttributes(q: string): string[] {
  const attrs: string[] = [];
  const homicideContext = /\b(homicides?|murders?|killings?)\b/i.test(q);

  // Weapon / firearm
  if (/\b(weapon|firearm|gun|gunshot|knife|handgun|rifle|shotgun|blunt|strangulation)\b/i.test(q) ||
      /\bby\s*weapon\b/i.test(q) || /\bweapon\s*(type|used|breakdown)/i.test(q) ||
      /\bweapons?\s*used\s*(in|for|during)/i.test(q)) {
    attrs.push("weapon");
    if (/\b(firearm|gun|handgun|rifle|shotgun)\b/i.test(q)) attrs.push("firearm");
  }

  // Victim demographics — explicit "victim race/sex/age" OR demographic terms in crime context
  if (/\bvictim\s*(race|sex|age|demographic|gender)/i.test(q) ||
      /\b(murder|homicide)\s*victim\s*(race|sex|age|by\s*race|by\s*age|by\s*sex)/i.test(q)) {
    attrs.push("victim_race");
  }
  if (homicideContext && /\b(race|racial|ethnicity|ethnic|black|white|hispanic|latino|asian|native|american\s+indian)\b/i.test(q)) {
    if (!attrs.includes("victim_race")) attrs.push("victim_race");
  }
  if (homicideContext && /\b(gender|sex|female|male|women|men)\b/i.test(q)) {
    if (!attrs.includes("victim_sex")) attrs.push("victim_sex");
  }
  // Implicit demographic requirement: "female/male victims", "Black/White victims", "victim age", "by age group"
  if (/\b(female|male|women|men)\s*(murder|homicide|victim|crime)/i.test(q) ||
      /\b(murder|homicide|victim)s?\s*(female|male|women|men)/i.test(q) ||
      /\b(murder|homicide|victim)s?\s.{0,20}\b(female|male)\b/i.test(q) ||
      /\b(female|male)\b.{0,20}\b(murder|homicide|victim)/i.test(q) ||
      /\b(Black|White|Asian|Hispanic|American Indian)\s*(murder|homicide|victim)/i.test(q) ||
      /\b(murder|homicide|victim)s?\s*(by|by\s*)(race|sex|age|gender|age\s*group)/i.test(q) ||
      /\bby\s*age\s*group/i.test(q) ||
      /\bvictim\s*(age|sex|race|gender)\s*(breakdown|group|distribution)/i.test(q) ||
      /\b(homicide|murder)\s.{0,30}\b(relative|family\s*member|spouse|wife|husband)\b/i.test(q)) {
    if (!attrs.includes("victim_race")) attrs.push("victim_race");
    if (!attrs.includes("victim_sex")) attrs.push("victim_sex");
  }

  // Offender demographics
  if (/\b(offender|suspect|perpetrator)\s*(race|sex|age|demographic|gender)/i.test(q) ||
      /\b(offender|suspect)\s*(by\s*)(race|sex|age)/i.test(q) ||
      /\b(murder|homicide)\s*offender\s*(demographic|race|age|sex)/i.test(q)) {
    attrs.push("offender_demographics");
  }

  // Arrestee demographics — explicit or implicit via "juvenile arrests", "by race" with arrests
  if (/\b(arrest|arrested|arrestee)\s*(race|sex|age|demographic|gender|by\s*race|by\s*age)/i.test(q) ||
      /\b(arrest|arrests)\s*(by|per)\s*(race|age|sex|gender|ethnicity)/i.test(q) ||
      /\b(juvenile|minor|underage|adult)\s*(arrest|crime|offender|rate)/i.test(q) ||
      /\b(arrest|crime)\s*(rate|trend|comparison).*\b(juvenile|minor|adult)\b/i.test(q)) {
    attrs.push("arrest_demographics");
  }

  // Relationship — explicit or via common relationship terms
  if (/\b(victim.offender|offender.victim)\s*(relationship)/i.test(q) ||
      /\b(intimate\s*partner|domestic)\s*(homicide|murder|killing|violence)/i.test(q) ||
      /\b(stranger|acquaintance|family|relative|spouse|wife|husband)\s*(homicide|murder|killing)/i.test(q) ||
      /\b(homicide|murder|killing)\s.{0,20}\b(stranger|acquaintance|family|relative|spouse|intimate)/i.test(q) ||
      /\b(intra\s*racial|inter\s*racial)\s*(homicide|murder)/i.test(q) ||
      /\brelationship\b/i.test(q)) {
    attrs.push("relationship");
  }

  // Circumstance
  if (/\b(circumstance|justifiable)\s*(homicide|murder|killing)?/i.test(q) ||
      /\b(gang|gangland|felony\s*type|felony\s*murder|argument)\s*(homicide|murder|killing)/i.test(q) ||
      /\b(justifiable\s*homicide|killed\s*by\s*police|killed\s*by\s*civilian)/i.test(q)) {
    attrs.push("circumstance");
  }

  // Drug type
  if (/\b(drug\s*type|marijuana|cocaine|heroin|fentanyl|methamphetamine|meth)\b/i.test(q) ||
      /\bdrug\s*(offense|violation|possession|sale)/i.test(q)) {
    attrs.push("drug_type");
  }

  // Bias / hate crime
  if (/\b(bias|hate)\s*(motivation|crime|incident|motivated)/i.test(q) ||
      /\bhate\s*crime/i.test(q) || /\banti-\w+\s*(hate|crime|bias|incident|offense)/i.test(q) ||
      /\bbias.motivated/i.test(q) ||
      /\banti-(jewish|semit|black|white|asian|hispanic|latino|muslim|islamic|arab|sikh|hindu|gay|lesbian|lgbtq|transgender|bisexual)/i.test(q) ||
      /\b(antisemit|islamophob|xenophob)/i.test(q)) {
    attrs.push("bias");
  }

  // Location type
  if (/\blocation\s*type/i.test(q) || /\bby\s*location/i.test(q) ||
      /\b(where\s*(did|do)\s*crimes?\s*(occur|happen))/i.test(q)) {
    attrs.push("location_type");
  }

  // Clearance type breakdown (arrest vs exceptional)
  if (/\bcleared?\s*by\s*(arrest|exception(?:al)?)/i.test(q) ||
      /\b(arrest|exception(?:al)?)\s*(clearance|means)/i.test(q) ||
      /\bexception(?:al)?\s*(clearance|clear)/i.test(q) ||
      /\bprosecution\s*(declined|refused)/i.test(q)) {
    attrs.push("clearance_type");
  }

  // Multiple victims / incident-level detail
  if (/\bmultiple\s*(victim|offender)/i.test(q) || /\bincident.level/i.test(q)) {
    attrs.push("incident_level");
  }

  // General clearance rate (not the type breakdown)
  if (/\bclearance\s*(rate|percent|pct)/i.test(q) && !attrs.includes("clearance_type")) {
    attrs.push("clearance_rate");
  }

  // Staffing
  if (/\b(staffing|officers?\s*per\s*(?:capita|100\s*k|100,?000|1\s*k|1,?000)|sworn\s*officers?|police\s*officers?|law\s*enforcement\s*employees?)\b/i.test(q)) {
    attrs.push("staffing");
  }

  // Time of day
  if (/\btime\s*of\s*day/i.test(q) || /\bhour\s*of\s*(the\s*)?day/i.test(q)) {
    attrs.push("time_of_day");
  }

  // Domestic violence
  if (/\bdomestic\s*(violence|abuse|assault|homicide|murder)/i.test(q)) {
    attrs.push("domestic_violence");
    // domestic homicides also need relationship for SHR
    if (/\bdomestic\s*(homicide|murder|killing)/i.test(q)) {
      if (!attrs.includes("relationship")) attrs.push("relationship");
    }
  }

  // Carjacking
  if (/\bcarjack/i.test(q)) {
    attrs.push("carjacking");
  }

  // Intraracial/interracial
  if (/\b(intra\s*racial|inter\s*racial)\b/i.test(q)) {
    attrs.push("victim_race");
    attrs.push("offender_demographics");
  }

  return [...new Set(attrs)];
}

function detectUnsupportedConcepts(q: string): string[] {
  const concepts: string[] = [];

  // "Shootings" as a crime category — not a NIBRS/UCR offense
  if (/\bshootings?\b/i.test(q)) {
    // Flag unless it's clearly about a weapon context
    if (!/\b(shooting|shot)\s*(weapon|with|by|involving)/i.test(q) &&
        !/\bfirearm\s*shooting/i.test(q)) {
      concepts.push("shootings_category");
    }
  }

  // Evidence types — any mention of evidence in a crime/clearance context
  if (/\b(evidence|video\s*evidence|dna\s*evidence|dna|forensic|surveillance\s*(footage|camera)?|bodycam|body\s*cam|cctv|fingerprint)\b/i.test(q)) {
    concepts.push("evidence_type");
  }

  // Convictions / sentencing
  if (/\b(conviction|convicted|sentence[ds]?|incarcerat|prison|jail\s*time|plea\s*deal|probation)\b/i.test(q)) {
    concepts.push("convictions");
  }

  // Legal charge severity/classification. NIBRS has arrest offense codes, but not
  // whether a charge was filed/prosecuted as a misdemeanor or felony.
  if (/\b(misdemeanou?r|felon(?:y|ies))\b/i.test(q) &&
      /\b(arrests?|arrested|arrestees?|charges?|charged|offenses?)\b/i.test(q) &&
      !/\b(felony\s+murder|felony\s+type)\b/i.test(q)) {
    concepts.push("charge_severity");
  }

  // Neighborhood-level
  if (/\b(neighborhood|block|census\s*tract|zip\s*code|precinct\s*level)\b/i.test(q)) {
    concepts.push("neighborhood");
  }

  // Specific drug arrests (arrest table doesn't break down by drug type)
  if (/\b(marijuana|cannabis|weed|cocaine|heroin|fentanyl|meth)\s*(possession\s*)?(arrest|arrested|arrests)\b/i.test(q)) {
    concepts.push("specific_drug_arrests");
  }

  if (isDemographicHomicideRateQuestion(q)) {
    concepts.push("demographic_homicide_rate_denominator");
  }

  return concepts;
}

/**
 * Parse a question into a structured QueryIntent.
 */
export function parseIntent(question: string): QueryIntent {
  const q = question.trim();
  return {
    offense: detectOffense(q),
    measure: detectMeasure(q),
    geography: detectGeography(q),
    timeRange: detectTimeRange(q),
    granularity: detectGranularity(q),
    requiredAttributes: detectRequiredAttributes(q),
    unsupportedConcepts: detectUnsupportedConcepts(q),
  };
}

// ══════════════════════════════════════════════════════════════════════
//  Follow-up detection
// ══════════════════════════════════════════════════════════════════════

const FOLLOWUP_PATTERNS: RegExp[] = [
  // Formatting / display instructions
  /^(make|change|switch|turn)\s+(it|the|that|this)\b/i,
  /^(ok|okay)\s+(but|fine|now)\b/i,
  /^(now|also|and|then)\s+(make|add|remove|show|change|compare|take|do|plot|give|can|break)/i,
  /\b(the chart|the graph|the table|the line|the data|the map|your chart|your graph)\b/i,
  /^(remove|get rid of|drop|hide|trim|cut)\s/i,
  /\b(normalize|index|reformat|re-?format)\s+(that|it|the|this|to)\b/i,
  /\b(looks?\s+weird|looks?\s+wrong|looks?\s+off|looks?\s+bad)\b/i,
  /\broll(ing)?\s+(that|it)\s+over\b/i,
  /^(in a|as a)\s+(table|chart|bar|line|pie|csv|graph)/i,
  // Explicit references to prior context
  /^(that|those|this|these)\s/i,
  /\b(the same|do the same|same thing|same for|same but)\b/i,
  // Short confirmations / rejections
  /^(yes|no|yeah|nah|nope|correct|right|exactly|perfect)\s*[.!?]*$/i,
  /^(never mind|go back|undo|revert)\b/i,
  /^(why|what|how)\s+(is|are|did|do|does|about)\s+(it|that|this|there)\b/i,
  /^(is|are)\s+(it|that|this|they|those)\s+(getting\s+)?(?:better|worse|higher|lower|rising|falling|improving|declining)\b/i,
  /^can you (just|also|make|add|change|compare)\b/i,
  // Color/style modifications
  /\b(make|change).{0,20}\b(yellow|red|blue|green|darker|lighter|dashed|dotted|thicker|color)\b/i,
  /\b(vertical|horizontal)\s+line\b/i,
  /\badd\s+(a|some|the)\s+(line|marker|label|annotation|vertical|bar)\b/i,
  // Per-capita / unit changes
  /^(now|can you)\s+(make|show|do)\s+(it|that|this)\s+(per|as|in)\b/i,
  /\bper\s*capita\b.*\b(that|it|please)\b/i,
  // Narrowing / widening previous results
  /^(what if|how about|what about)\b/i,
  /^now\s+(what|how)\s+about\b/i,
  /^(could you|can you|can we)\s+(do|show|give|make|look\s+at)\s+(the same|that|it|this|the)\b/i,
  /\bcan\s+we\s+(look\s+at|see)\s+.{0,15}\b(in\s+terms|percentage|percent|as\s+a)\b/i,
  // Comparison additions / measure changes
  /^compare\s+to\b/i,
  /^(show|give|do|use)\s+(rates?|counts?|per capita|percentages?)\s+(instead|rather)\b/i,
  /\b(instead\s+of\s+(counts?|rates?|totals?))\b/i,
  /^break\s+it\s+down\s+by\b/i,
  /^show\s+participation\b/i,
];

function isAnaphoricFollowUp(q: string): boolean {
  const hasReference = /\b(this|that|these|those|it|same)\b/i.test(q);
  const startsWithContinuation =
    /^(show|give|display|plot|chart|graph|add|include|remove|break|compare|switch|change|make|do|use|can you|could you|can we|could we)\b/i.test(q);
  if (hasReference && startsWithContinuation) return true;

  const shortDefiniteMetric =
    q.length <= 80 &&
    /^(can you|could you|can we|could we|show|give|display|plot|chart|graph)\b/i.test(q) &&
    /\bthe\s+(rate|rates|count|counts|total|totals|trend|chart|table|breakdown|same)\b/i.test(q);
  if (shortDefiniteMetric) {
    const intent = parseIntent(q);
    return intent.geography.type === "ambiguous" && !intent.offense;
  }

  return false;
}

/**
 * Detect whether a query is a session follow-up with no standalone routing intent.
 * Follow-ups are things like "normalize that", "make it yellow", "what about 2024?"
 * These should keep the user on their current tab rather than re-routing.
 */
export function isFollowUp(question: string): boolean {
  const q = question.trim();

  // Very short + no offense/geography/attributes = likely follow-up
  if (q.length < 20) {
    const intent = parseIntent(q);
    if (!intent.offense && intent.geography.type === "ambiguous" && intent.requiredAttributes.length === 0) {
      return true;
    }
  }

  for (const pat of FOLLOWUP_PATTERNS) {
    if (pat.test(q)) return true;
  }

  if (isAnaphoricFollowUp(q)) return true;

  // Pasted data (mostly numbers, tabs, commas) — a follow-up providing context
  const alphaRatio = (q.replace(/[^a-zA-Z]/g, "").length) / q.length;
  if (q.length > 30 && alphaRatio < 0.4) return true;

  return false;
}

// ══════════════════════════════════════════════════════════════════════
//  Routing logic
// ══════════════════════════════════════════════════════════════════════

interface RouteScore {
  tab: TabId;
  score: number;
  why: string;
  excluded: boolean;
  excludeReason?: string;
}

function canDatasetHandleOffense(ds: DatasetCapabilities, offense: string | null): boolean {
  if (ds.offenseScope === "hate_crime_only") return offense === "hate_crime"; // hate_crime only for hate crime queries
  if (!offense) return true; // generic crime — all other datasets can handle
  if (ds.offenseScope === "all_nibrs") return true; // NIBRS handles everything
  if (ds.offenseScope === "homicide_only") return HOMICIDE_OFFENSES.has(offense);
  if (ds.offenseScope === "part1_ucr") return PART1_OFFENSES.has(offense);
  return false;
}

function canDatasetHandleAttributes(ds: DatasetCapabilities, attrs: string[]): { can: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const attr of attrs) {
    if (!ds.attributes.has(attr)) {
      missing.push(attr);
    }
  }
  return { can: missing.length === 0, missing };
}

function scoreDataset(ds: DatasetCapabilities, intent: QueryIntent): RouteScore {
  let score = 5; // base
  let why = ds.description;
  let excluded = false;
  let excludeReason: string | undefined;
  const currentYear = new Date().getFullYear();
  // "past N years" resolves to complete calendar years (lib/time-conventions),
  // so a range ending at last year is still a recency signal for routing.
  const recentCurrentRange = intent.timeRange.start !== null &&
    intent.timeRange.end !== null &&
    intent.timeRange.end >= currentYear - 1 &&
    intent.timeRange.start >= currentYear - 5;

  // ── Hard exclusions ──

  // 1. Offense not supported
  // Special case: hate_crime dataset is included when bias/hate_crime attributes are present,
  // even if the detected offense is null or not "hate_crime"
  const hasBiasAttr = intent.requiredAttributes.includes("bias") || intent.requiredAttributes.includes("hate_crime");
  const hcOverride = ds.id === "hate_crime" && hasBiasAttr;
  if (!hcOverride && !canDatasetHandleOffense(ds, intent.offense)) {
    excluded = true;
    if (ds.offenseScope === "homicide_only") {
      excludeReason = "Only has homicide data — cannot answer questions about other offenses";
    } else if (ds.offenseScope === "hate_crime_only") {
      excludeReason = "Only has hate crime / bias motivation data";
    } else {
      excludeReason = `Does not track ${(intent.offense || "").replace(/_/g, " ")}`;
    }
    return { tab: ds.id, score: 0, why, excluded, excludeReason };
  }

  // 2. Required attributes not supported
  const attrCheck = canDatasetHandleAttributes(ds, intent.requiredAttributes);
  if (!attrCheck.can) {
    excluded = true;
    excludeReason = `Missing required data: ${attrCheck.missing.join(", ").replace(/_/g, " ")}`;
    return { tab: ds.id, score: 0, why, excluded, excludeReason };
  }

  // 3. Time range not covered
  if (intent.timeRange.start !== null && intent.timeRange.start < ds.yearRange.start) {
    // If the requested start is before this dataset begins, penalize heavily
    // but don't exclude unless it's way before
    const gap = ds.yearRange.start - intent.timeRange.start;
    if (gap > 10) {
      // Current (2017+) can't meaningfully answer "since 2000"
      if (ds.id === "current") {
        excluded = true;
        excludeReason = `Data only starts in ${ds.yearRange.start}, too late for your time range`;
        return { tab: ds.id, score: 0, why, excluded, excludeReason };
      }
    }
    score -= Math.min(3, gap / 5); // small penalty for minor gaps
  }
  if (intent.timeRange.start !== null && intent.timeRange.start > ds.yearRange.end) {
    excluded = true;
    excludeReason = `Data currently ends in ${ds.yearRange.end}, before the requested year`;
    return { tab: ds.id, score: 0, why, excluded, excludeReason };
  }
  if (intent.timeRange.end !== null && intent.timeRange.end > ds.yearRange.end) {
    const gap = intent.timeRange.end - ds.yearRange.end;
    score -= Math.min(3, gap);
  }
  if (recentCurrentRange && ds.id === "historical") {
    score -= 2;
  }

  // 4. Granularity mismatch — Current only has monthly, Historical only has annual
  if (intent.granularity === "monthly" && !ds.granularity.includes("monthly")) {
    score -= 3;
  }
  if (intent.granularity === "annual" && !ds.granularity.includes("annual") && ds.granularity.length === 1) {
    score -= 1; // Monthly can be aggregated to annual, minor penalty
  }

  // 5. County-level query — only Historical has county
  if (intent.geography.type === "county" && !ds.hasCounty) {
    if (ds.id !== "historical") {
      const recentQuery = intent.timeRange.start !== null && intent.timeRange.start >= 2017;
      score -= recentQuery ? 1 : 4; // Current may have county-named agencies in recent monthly data.
    }
  }

  // ── Positive scoring ──

  // Time range coverage quality
  if (intent.timeRange.start !== null) {
    if (intent.timeRange.start >= ds.yearRange.start) {
      score += 1; // Full coverage
    }
    // Prefer datasets that cover the entire requested range
    const yearsCovered = Math.min(ds.yearRange.end, intent.timeRange.end || 2026) -
      Math.max(ds.yearRange.start, intent.timeRange.start);
    if (yearsCovered > 20) score += 1;
  }

  // Granularity match bonus
  if (intent.granularity === "monthly" && ds.granularity.includes("monthly")) {
    score += 2;
  }

  // Agency coverage bonus (more agencies = more complete)
  if (ds.agencyCount >= 10000) score += 1;

  // Offense-specific bonuses
  if (intent.offense) {
    // SHR bonus for homicide questions with demographic/relationship/circumstance needs
    if (ds.id === "shr" && HOMICIDE_OFFENSES.has(intent.offense)) {
      if (intent.requiredAttributes.some(a => ["relationship", "circumstance"].includes(a))) {
        score += 3; // SHR is best for homicide relationship/circumstance
        why = "Has detailed victim-offender relationships and circumstances for every homicide since 1976";
      } else if (intent.requiredAttributes.some(a => a.includes("offender") || a === "weapon" || a === "firearm")) {
        score += 2;
        why = "Has victim/offender demographics and weapon detail for homicides since 1976";
      }
    }

    // NIBRS bonus for Group B / specialty offenses
    if (ds.id === "nibrs" && NIBRS_ONLY_OFFENSES.has(intent.offense)) {
      score += 3;
      why = `Only NIBRS tracks ${intent.offense.replace(/_/g, " ")} — other sources don't have this offense`;
    }

    // Carjacking is NIBRS-specific
    if (ds.id === "nibrs" && intent.offense === "carjacking") {
      score += 3;
      why = "Carjacking is a NIBRS-derived offense with no UCR equivalent";
    }
  }

  // Attribute-specific bonuses
  if (intent.requiredAttributes.includes("clearance_type")) {
    if (ds.id === "nibrs") {
      score += 3;
      why = "Only NIBRS distinguishes clearance by arrest vs. exceptional means";
    }
  }
  if (intent.requiredAttributes.includes("staffing")) {
    if (ds.id === "historical") {
      score += 3;
      why = "Tracks sworn officer counts and staffing levels by agency since the 1970s";
    }
  }
  if (intent.requiredAttributes.includes("bias") || intent.requiredAttributes.includes("hate_crime")) {
    if (ds.id === "hate_crime") {
      score += 5;
      why = "Dedicated reported hate crime database with bias motivation, offender, and participation data (1991–present)";
    } else if (ds.id === "nibrs") {
      score -= 2; // Penalize NIBRS when hate_crime tab is available
    }
  }
  if (intent.requiredAttributes.includes("drug_type")) {
    if (ds.id === "nibrs") {
      score += 2;
      why = "Breaks down drug offenses by suspected drug type";
    }
  }

  // SHR for homicide-specific historical analysis with demographics
  if (ds.id === "shr" && intent.offense && HOMICIDE_OFFENSES.has(intent.offense)) {
    // Weapon + homicide → SHR has this back to 1976
    if (intent.requiredAttributes.includes("weapon") || intent.requiredAttributes.includes("firearm")) {
      score += 2;
      why = "Has weapon detail for every homicide report since 1976";
    }
    // Demographic lookups on homicide
    if (intent.requiredAttributes.includes("victim_race") || intent.requiredAttributes.includes("offender_demographics")) {
      score += 2;
      why = "Has both victim and offender demographics for homicides since 1976";
    }
  }

  // Historical for long-range general queries
  if (ds.id === "historical" && !intent.offense) {
    // Generic crime question → Historical has the broadest coverage
    score += 1;
  }
  if (ds.id === "historical" && intent.measure === "clearance_rate" && !intent.requiredAttributes.includes("clearance_type")) {
    score += 2;
    why = "Has annual clearance rates by agency going back decades";
  }
  if (ds.id === "historical" && intent.geography.type === "state" && ds.hasStateRates) {
    score += 1;
    why = "Has FBI-estimated state-level crime rates for all 50 states";
  }
  if (ds.id === "historical" && intent.geography.type === "county") {
    score += 2;
    why = "Has county-level crime data through the UCR program";
  }

  // Current for recent monthly trends
  if (ds.id === "current" && intent.granularity === "monthly") {
    score += 2;
    why = "Has monthly granularity for tracking recent trends";
  }
  if (ds.id === "current" && intent.timeRange.start !== null && intent.timeRange.start >= 2017) {
    score += recentCurrentRange ? 4 : 2;
    if (!why.includes("monthly")) why = "Recent monthly data from the Current Trends sample";
  }
  // Current as default for simple recent queries — no time range, no special attributes, Part I offense
  if (ds.id === "current" && intent.timeRange.start === null && intent.requiredAttributes.length === 0 &&
      intent.granularity !== "annual" && (!intent.offense || ["murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft", "violent_crime", "property_crime"].includes(intent.offense))) {
    score += 1;
    if (!why.includes("monthly")) why = "Monthly data from ~700 agencies for recent trends (2017\u2013present)";
  }

  // Measure-specific adjustments
  if (intent.measure === "ranking" && ds.id === "historical") {
    score += 1;
    why = "Has the most agencies for comprehensive rankings";
  }
  if (intent.measure === "rate" && ds.id === "historical" && ds.hasStateRates) {
    score += 1;
  }

  // Prefer Historical for general Part I crime queries without special attributes
  if (ds.id === "historical" && intent.requiredAttributes.length === 0 &&
      (!intent.offense || PART1_OFFENSES.has(intent.offense)) &&
      intent.granularity !== "monthly") {
    score += 1;
    why = ds.agencyCount >= 10000
      ? "Annual FBI data from 10,000+ agencies with the longest time range available"
      : why;
  }

  // NIBRS can technically aggregate Part I offenses, but it is a poor default
  // suggestion for plain annual UCR-style counts/trends because participation
  // changes over time. Keep it preferred for NIBRS-only offenses and detail
  // questions; demote it for broad aggregate asks that Historical/Current/SHR
  // can answer more directly.
  if (ds.id === "nibrs" && intent.requiredAttributes.length === 0 &&
      intent.offense && PART1_OFFENSES.has(intent.offense) &&
      intent.measure !== "ranking") {
    score -= 2;
  }

  return { tab: ds.id, score, why, excluded, excludeReason };
}

/**
 * Route a question to the best dataset(s).
 * Returns scored recommendations for all applicable datasets.
 */
export function recommendTabs(question: string, yearRanges?: SourceYearRanges): TabRecommendation[] {
  const q = question.trim();
  if (!q || q.length < 5) return [];

  const intent = parseIntent(q);

  // Score only enabled datasets
  const enabled = enabledSourceIds();
  const scores = datasetsWithYearRanges(yearRanges)
    .filter(ds => enabled.has(ds.id))
    .map(ds => scoreDataset(ds, intent));

  // Separate included from excluded
  const included = scores.filter(s => !s.excluded).sort((a, b) => b.score - a.score);

  if (included.length === 0) return [];

  const topScore = included[0].score;

  // Return datasets that scored within 50% of the top
  const viable = included.filter(s => s.score >= topScore * 0.5);

  return viable.slice(0, 3).map((s, i) => ({
    tab: s.tab,
    why: s.why,
    primary: i === 0,
    score: s.score,
  }));
}

/**
 * Single-tab suggestion for the in-tab banner.
 * Only suggests if the top recommendation is different from the current tab.
 */
export function suggestTab(question: string, currentTab: TabId, yearRanges?: SourceYearRanges): TabSuggestion | null {
  const recs = recommendTabs(question, yearRanges);
  if (recs.length === 0) return null;
  const top = recs.find(r => r.primary);
  if (!top || top.tab === currentTab) return null;
  return { tab: top.tab, reason: top.why.charAt(0).toLowerCase() + top.why.slice(1) };
}

/**
 * Auto-route a question to the best data source.
 *
 * Returns null when:
 *   - No routing signals detected (too short / empty)
 *   - Query is a session follow-up (use isFollowUp() to distinguish)
 *
 * Callers should check isFollowUp(question) FIRST. When true, keep the
 * user on their current tab — the query modifies the previous result,
 * not a new standalone question.
 */
export function autoRoute(question: string, yearRanges?: SourceYearRanges): AutoRouteResult | null {
  if (asksCurrentYearClearance(question)) {
    if (asksUnavailableCurrentYearClearance(question)) {
      return {
        source: "current",
        reason: "Current-year clearance rates are not available yet",
        confidence: "high",
        alternatives: [],
      };
    }
    return {
      source: "nibrs",
      reason: "Only NIBRS distinguishes clearance by arrest vs. exceptional means",
      confidence: "high",
      alternatives: [],
    };
  }

  // Follow-ups should not produce a routing decision at all.
  // The UI keeps the user on their current tab.
  if (isFollowUp(question)) return null;

  // ── Deterministic shooting handling ──
  // Shooting queries are intercepted before general scoring.
  const q = question.toLowerCase();
  const asksShooting = /\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i.test(q);
  if (asksShooting) {
    // Explicit proxy request → let NIBRS handle
    const wantsProxy = /\b(closest proxy|approximate|aggravated assault.{0,15}firearm)\b/i.test(q);
    if (wantsProxy) {
      return { source: "nibrs", reason: "Aggravated assault with firearm as requested proxy for shootings", confidence: "high", alternatives: [] };
    }
    // Nonfatal / broad incident request → deterministic refusal (route to SHR with null response)
    const wantsNonfatal = /\b(nonfatal|non-fatal|non fatal|shooting incidents?|shooting victims?|people\s+shot|gunshot (wound|victim)|shot and (survived|wounded|injured))\b/i.test(q);
    if (wantsNonfatal) {
      return { source: "shr", reason: "Shooting query — nonfatal data not available, routing to SHR for fatal shootings caveat", confidence: "high", alternatives: [] };
    }
    // Fatal context → SHR
    const fatalContext = /\b(fatal|deadly|killed|murder|homicide|death|died)\b/i.test(q);
    if (fatalContext) {
      return { source: "shr", reason: "Fatal shootings via SHR firearm homicide data", confidence: "high", alternatives: [] };
    }
    // Ambiguous bare "shootings" → default to SHR fatal shootings
    return { source: "shr", reason: "Interpreting as fatal shootings (firearm homicides) — nonfatal shooting data not available", confidence: "high", alternatives: [] };
  }

  const recs = recommendTabs(question, yearRanges);
  if (recs.length === 0) return null;

  const primary = recs[0];
  const intent = parseIntent(question);
  const secondScore = recs.length > 1 ? recs[1].score : 0;
  const gap = primary.score - secondScore;

  // How many viable alternatives exist? More viable tabs → less confident.
  const viableCount = recs.length;

  // Does the query have strong routing signals? (specific attribute/offense requirements)
  const hasStrongSignal = intent.requiredAttributes.length > 0 ||
    (intent.offense !== null && (NIBRS_ONLY_OFFENSES.has(intent.offense) || HOMICIDE_OFFENSES.has(intent.offense)));

  // Confidence: "high" means the router is very sure this is the right tab.
  // Reserve high confidence for queries with strong differentiating signals
  // (specific attributes, specialty offenses) AND a clear gap from alternatives.
  let confidence: "high" | "medium" | "low";
  if (primary.score >= 8 && gap >= 3 && hasStrongSignal) {
    confidence = "high";
  } else if (primary.score >= 8 && gap >= 3 && viableCount <= 2) {
    // Even without strong signal, high confidence if few alternatives
    confidence = "high";
  } else if (primary.score >= 6) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  // Staffing is only available in Historical. Treat it as a deterministic
  // source requirement even when broad crime-rate wording leaves other tabs
  // superficially viable.
  if (primary.tab === "historical" && intent.requiredAttributes.includes("staffing")) {
    confidence = "high";
  }

  return {
    source: primary.tab,
    reason: primary.why,
    confidence,
    alternatives: recs.slice(1),
  };
}

/**
 * Deterministic hint for questions manually run in a weaker source.
 * This is intentionally conservative: only high-confidence routes to a
 * different enabled source produce a nudge.
 */
export function manualSourceNudge(question: string, activeSource: TabId, yearRanges?: SourceYearRanges): ManualSourceNudge | null {
  const route = autoRoute(question, yearRanges);
  if (!route || route.source === activeSource || route.confidence !== "high") return null;

  return {
    source: route.source,
    reason: route.reason,
    confidence: "high",
    message: `This question may be better answered in ${TAB_DISPLAY_NAMES[route.source]} - ${route.reason.charAt(0).toLowerCase()}${route.reason.slice(1)}.`,
  };
}
