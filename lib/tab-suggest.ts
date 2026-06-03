/**
 * Deterministic tab suggestion engine.
 *
 * Uses regex rules (no AI) to recommend data sources for a question.
 * Returns ranked suggestions with conversational descriptions.
 */

export type TabId = "current" | "historical" | "nibrs" | "shr";

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

/** Tab display names */
export const TAB_DISPLAY_NAMES: Record<TabId, string> = {
  current: "Current Trends",
  historical: "Historical Library",
  nibrs: "NIBRS Explorer",
  shr: "Homicide Reports",
};

/** Tab colors */
export const TAB_COLORS: Record<TabId, string> = {
  current: "#475EC7",
  historical: "#8B5E3C",
  nibrs: "#2d8659",
  shr: "#8B6914",
};

/** Tab short descriptions */
const TAB_DESCRIPTIONS: Record<TabId, string> = {
  current: "Monthly data from ~700 agencies, 2017\u2013present",
  historical: "Annual FBI data from 10,000+ agencies, 1930s\u2013present",
  nibrs: "Incident-level detail: demographics, weapons, drugs, 1991\u2013present",
  shr: "Homicide victim-offender detail, 1976\u2013present",
};

interface Signal {
  patterns: RegExp[];
  tab: TabId;
  /** Conversational reason shown to user */
  why: string;
  /** Higher = stronger match */
  strength: number;
}

const SIGNALS: Signal[] = [
  // ── SHR signals ──
  { patterns: [/\b(victim.offender|offender.victim)\s*(relationship|race|age|sex)/i], tab: "shr", why: "Has detailed victim-offender relationships for every homicide since 1976", strength: 10 },
  { patterns: [/\b(intimate partner|domestic)\s*(homicide|murder|killing)/i], tab: "shr", why: "Tracks intimate partner and family homicides with relationship detail", strength: 10 },
  { patterns: [/\b(circumstance|justifiable)\s*(homicide|murder)/i], tab: "shr", why: "Records the circumstance of every homicide (felony, argument, justifiable, etc.)", strength: 10 },
  { patterns: [/\bsupplementary homicide/i, /\bSHR\b/], tab: "shr", why: "This is the SHR dataset", strength: 10 },
  { patterns: [/\b(intraracial|interracial)\s*(homicide|murder)/i], tab: "shr", why: "Has both victim and offender race for cross-tabulation since 1976", strength: 10 },

  // ── NIBRS clearance-type signals (must come before Historical clearance) ──
  { patterns: [/\bexceptional\s*(clearance|clear)/i, /\bcleared?\s*by\s*(exceptional|arrest)/i, /\b(arrest|exceptional)\s*clearance/i], tab: "nibrs", why: "Only NIBRS distinguishes clearance by arrest vs. exceptional means", strength: 10 },

  // ── Historical signals ──
  { patterns: [/\b(clearance|cleared)\s*(rate|percent|pct)/i], tab: "historical", why: "Has annual clearance rates by agency going back decades", strength: 10 },
  { patterns: [/\b(staffing|officers?\s*per\s*capita|sworn\s*officers?|police\s*officers?)\b/i], tab: "historical", why: "Tracks sworn officer counts and staffing levels by agency", strength: 10 },
  { patterns: [/\bsince\s*(19[3-8]\d)\b/i, /\bfrom\s*(19[3-8]\d)\b/i, /\b(1930|1940|1950|1960|1970|1980)s?\b/i], tab: "historical", why: "Has annual data going back to the 1930s for this time period", strength: 10 },
  { patterns: [/\b(national|state)\s*(crime\s*)?(rate|rates)\b/i, /\bstate.level\s*(rate|comparison|ranking)/i], tab: "historical", why: "Has FBI-estimated state-level crime rates for all 50 states", strength: 9 },
  { patterns: [/\bwhich state.*(highest|lowest|most|least)/i, /\bcrime rate\s*(by|per|across)\s*state/i], tab: "historical", why: "Best source for comparing crime rates across states", strength: 9 },
  { patterns: [/\bUCR\b/i], tab: "historical", why: "This is the UCR dataset", strength: 10 },

  // ── NIBRS signals ──
  { patterns: [/\b(arrest|arrested|arrestee)\s*(demographic|race|age|sex|by\s*race|by\s*age)/i], tab: "nibrs", why: "Has arrestee demographics broken down by race, age, sex, and weapon", strength: 10 },
  { patterns: [/\bDUI\b|DWI\b|drunk\s*driv/i], tab: "nibrs", why: "Has DUI/DWI arrest data (Group B offenses) with demographics", strength: 10 },
  { patterns: [/\bdisorderly\s*conduct/i, /\btrespass/i, /\bcurfew/i, /\bliquor\s*law/i], tab: "nibrs", why: "Has arrest data for this Group B offense with demographics", strength: 10 },
  { patterns: [/\b(offender|suspect)\s*(race|age|sex|demographic)/i], tab: "nibrs", why: "Has offender demographics for crimes against persons", strength: 10 },
  { patterns: [/\b(weapon|firearm|gun|knife)\s*(type|used|involved|breakdown)/i], tab: "nibrs", why: "Records the specific weapon used in each incident", strength: 8 },
  { patterns: [/\blocation\s*type/i], tab: "nibrs", why: "Records where each crime occurred (residence, parking lot, etc.)", strength: 10 },
  { patterns: [/\b(bias|hate)\s*(motivation|crime)/i, /\bhate\s*crime/i], tab: "nibrs", why: "Has bias motivation data for hate crime analysis", strength: 10 },
  { patterns: [/\bdrug\s*(type|offense|violation|arrest)/i], tab: "nibrs", why: "Breaks down drug offenses by suspected drug type", strength: 10 },
  { patterns: [/\bcarjack/i, /\bvehicle\s*burglary/i, /\btheft\s*from\s*vehicle/i], tab: "nibrs", why: "Has specific offense subcategories like carjacking and vehicle burglary", strength: 9 },
  { patterns: [/\btime\s*of\s*day/i], tab: "nibrs", why: "Records the hour of day for each incident", strength: 10 },
  { patterns: [/\bNIBRS\b/i], tab: "nibrs", why: "This is the NIBRS dataset", strength: 10 },

  // ── Current Trends signals ──
  { patterns: [/\b(monthly|month.over.month|rolling\s*12|rolling\s*sum)\b/i], tab: "current", why: "Has monthly granularity for tracking recent trends", strength: 9 },
  { patterns: [/\bper\s*month\b/i, /\bby\s*month\b/i], tab: "current", why: "Has monthly granularity for tracking recent trends", strength: 9 },
  { patterns: [/\brecent\s*(trend|month|data)/i, /\b(this|last)\s*(month|quarter)/i], tab: "current", why: "Updated with the most recent monthly data available", strength: 8 },
];

// ── Feature detectors (independent of each other) ──
const HAS_CRIME_WORD = /\b(murders?|homicides?|robber(?:y|ies)|assaults?|burglar(?:y|ies)|thefts?|rapes?|arson|crimes?|violent\s*crime|property\s*crime|auto\s*theft|motor\s*vehicle\s*theft|larcen(?:y|ies)|killings?|shootings?|carjackings?)\b/i;
const HAS_CITY = /\b(in\s+[A-Z][a-z]+|Houston|Chicago|Dallas|Phoenix|New York|Los Angeles|Philadelphia|Baltimore|Memphis|Nashville|Charlotte|Denver|Seattle|Portland|Miami|Atlanta|Boston|Detroit|Minneapolis|Cleveland|Pittsburgh|Cincinnati|Orlando|Tampa|Milwaukee|New Orleans|Oakland|Sacramento|San Francisco|San Diego|San Antonio|Austin|Jacksonville|Columbus|Indianapolis|Louisville|Richmond|Norfolk|Omaha|Raleigh|Tucson|Fresno|Albuquerque|El Paso|Oklahoma City|Las Vegas|Kansas City|St\.?\s*Louis|Baton Rouge|Washington\s*DC|DC)\b/i;
const HAS_MONTHLY = /\b(monthly|per\s*month|by\s*month|month.over.month|rolling|each\s*month)\b/i;
const HAS_RECENT_ONLY = /\b(201[7-9]|202\d)\b/;
const HAS_PRE_2017 = /\b(19\d{2}|200\d|201[0-6])\b/;
const HAS_HOMICIDE_SPECIFIC = /\b(murders?|homicides?|killings?|manslaughter|shooting)\b/i;

/**
 * Analyze a question and return ranked tab recommendations.
 * Returns 1-3 tabs, with the best match marked as primary.
 */
export function recommendTabs(question: string): TabRecommendation[] {
  const q = question.trim();
  if (!q || q.length < 5) return [];

  // Score each tab from specific signals
  const scores: Record<TabId, { score: number; bestWhy: string }> = {
    current: { score: 0, bestWhy: "" },
    historical: { score: 0, bestWhy: "" },
    nibrs: { score: 0, bestWhy: "" },
    shr: { score: 0, bestWhy: "" },
  };

  for (const signal of SIGNALS) {
    for (const pattern of signal.patterns) {
      if (pattern.test(q)) {
        if (signal.strength > scores[signal.tab].score) {
          scores[signal.tab].score = signal.strength;
          scores[signal.tab].bestWhy = signal.why;
        }
        break;
      }
    }
  }

  // Feature-based scoring: add secondary recommendations for common crime questions
  if (HAS_CRIME_WORD.test(q)) {
    const isMonthly = HAS_MONTHLY.test(q);
    const hasPreData = HAS_PRE_2017.test(q);
    const recentOnly = HAS_RECENT_ONLY.test(q) && !hasPreData;
    const isHomicide = HAS_HOMICIDE_SPECIFIC.test(q);
    const hasCity = HAS_CITY.test(q);

    // Helper: only set score if tab doesn't already have a stronger signal
    const addIfEmpty = (tab: TabId, score: number, why: string) => {
      if (scores[tab].score === 0) {
        scores[tab] = { score, bestWhy: why };
      }
    };

    if (isMonthly || recentOnly) {
      addIfEmpty("current", 7, hasCity
        ? "Monthly crime data for this city (2017\u2013present)"
        : "Monthly crime data from ~700 agencies (2017\u2013present)");
      addIfEmpty("historical", 5, hasCity
        ? "Annual data for this city going back to the 1930s"
        : "Annual FBI data back to the 1930s for longer context");
    } else if (hasPreData) {
      addIfEmpty("historical", 7, hasCity
        ? "Annual data for this city covering your full time range"
        : "Annual FBI data covering your full time range");
      addIfEmpty("current", 4, "Monthly data available from 2017 onward");
    } else {
      addIfEmpty("historical", 6, hasCity
        ? "Annual data for this city with the longest time range available"
        : "Annual FBI data from 10,000+ agencies");
      addIfEmpty("current", 5, hasCity
        ? "Monthly data for this city for recent trends"
        : "Monthly data from ~700 agencies for recent trends");
    }

    if (isHomicide) {
      addIfEmpty("shr", 4, "Detailed homicide data with victim/offender demographics and weapon detail since 1976");
    }
  }

  // Build ranked list
  const ranked = (Object.entries(scores) as [TabId, { score: number; bestWhy: string }][])
    .filter(([, v]) => v.score > 0)
    .sort((a, b) => b[1].score - a[1].score);

  if (ranked.length === 0) return [];

  const topScore = ranked[0][1].score;
  return ranked
    .filter(([, v]) => v.score >= topScore * 0.5)
    .slice(0, 3)
    .map(([tab, v], i) => ({
      tab,
      why: v.bestWhy,
      primary: i === 0,
      score: v.score,
    }));
}

// Keep the single-tab suggestTab for the in-tab suggestion banner
export interface TabSuggestion {
  tab: TabId;
  reason: string;
}

export function suggestTab(question: string, currentTab: TabId): TabSuggestion | null {
  const recs = recommendTabs(question);
  if (recs.length === 0) return null;
  // Only suggest if the top recommendation is different from current tab
  const top = recs.find(r => r.primary);
  if (!top || top.tab === currentTab) return null;
  return { tab: top.tab, reason: top.why.charAt(0).toLowerCase() + top.why.slice(1) };
}

/**
 * Auto-route a question to the best data source.
 * Returns null if no signals detected.
 *
 * Confidence levels:
 * - high: strong signal (≥8) with clear lead (≥2 points ahead of #2)
 * - medium: moderate signal (≥6)
 * - low: weak signals or ambiguous (multiple close scores)
 */
export function autoRoute(question: string): AutoRouteResult | null {
  const recs = recommendTabs(question);
  if (recs.length === 0) return null;

  const primary = recs[0];
  const secondScore = recs.length > 1 ? recs[1].score : 0;
  const gap = primary.score - secondScore;

  let confidence: "high" | "medium" | "low";
  if (primary.score >= 8 && gap >= 2) {
    confidence = "high";
  } else if (primary.score >= 6) {
    confidence = "medium";
  } else {
    confidence = "low";
  }

  return {
    source: primary.tab,
    reason: primary.why,
    confidence,
    alternatives: recs.slice(1),
  };
}
