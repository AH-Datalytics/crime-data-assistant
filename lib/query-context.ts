/**
 * Query Context Extractor
 *
 * Parses Claude's SQL response into a structured context object so that
 * downstream stages (guardrails, explain, disclaimers) all share one
 * source of truth instead of each re-deriving context independently.
 */

import { resolveGeoPlaces } from "./geo-place-resolver";

export type Tab = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
export type Scope = "national" | "state" | "city" | "county" | "agency";

export interface QueryContext {
  tab: Tab;
  question: string;
  /** Cities/agencies mentioned in SQL WHERE clauses */
  geos: string[];
  /**
   * Canonical place names resolved from the question when `geos` is empty
   * (e.g. ORI-filtered SQL plus a lowercase question). Used ONLY to validate
   * narrative entity mentions — never by guardrails, which read `geos`.
   */
  resolvedPlaces?: string[];
  /** State abbreviations from SQL */
  states: string[];
  /** Inferred geographic scope */
  scope: Scope;
  /** Year range from SQL filters */
  timeRange: { start: number | null; end: number | null };
  /** Offense types found in SQL (human-readable names) */
  offenses: string[];
  /** Whether the query involves per-capita / rate calculations */
  isPerCapita: boolean;
  /** Tables referenced in the SQL */
  tables: string[];
  /**
   * An ORI the server resolved and requires this query to target.
   *
   * Set when the user picked one of a county's two law enforcement agencies. Guardrails that
   * treat a hardcoded ORI as a guess must not fire on it: the application chose it, from the
   * FIPS crosswalk, and the contract validator checks the SQL actually filters on it.
   */
  requiredOri?: string | null;
  /** Raw SQL for guardrails that need pattern matching */
  sql: string;
}

/* ------------------------------------------------------------------ */
/*  Agency name map (shared across all callers)                        */
/* ------------------------------------------------------------------ */

/** Maps common abbreviations/nicknames to canonical display names */
export const AGENCY_ALIASES: [RegExp, string][] = [
  [/\bNYPD\b/i, "New York City"],
  [/\bLAPD\b/i, "Los Angeles"],
  [/\bCPD\b|Chicago\s+police/i, "Chicago"],
  [/\bCMPD\b/i, "Charlotte"],
  [/\bMNPD\b|Metro\s+Nashville/i, "Nashville"],
  [/\bLVMPD\b/i, "Las Vegas"],
  [/\bHPD\b|Houston\s+police/i, "Houston"],
  [/\bDPD\b|Dallas\s+police/i, "Dallas"],
  [/\bMPD\b|Memphis\s+police/i, "Memphis"],
  [/\bBPD\b|Baltimore\s+police/i, "Baltimore"],
];

/* ------------------------------------------------------------------ */
/*  Offense name map                                                   */
/* ------------------------------------------------------------------ */

const OFFENSE_MAP: [RegExp, string][] = [
  [/\b(?:murder|murders|homicide|homicides|09[abc])\b/i, "murder"],
  [/\b(?:rape|rapes|11[abcd])\b/i, "rape"],
  [/\b(?:robbery|robberies|120)\b/i, "robbery"],
  [/\b(?:aggravated assault|aggravated assaults|13[abc])\b/i, "aggravated assault"],
  [/\b(?:burglary|burglaries|220)\b/i, "burglary"],
  [/\b(?:motor vehicle theft|motor vehicle thefts|auto theft|auto thefts|240)\b/i, "motor vehicle theft"],
  [/(?<!motor vehicle )(?<!auto )\b(?:theft|thefts|larceny|larcenies|23[a-z])\b/i, "theft"],
  [/\b(?:carjacking|carjackings|64[ab])\b/i, "carjacking"],
  [/\b(?:arson|arsons|200)\b/i, "arson"],
];

/* ------------------------------------------------------------------ */
/*  Core extraction                                                    */
/* ------------------------------------------------------------------ */

export function extractQueryContext(
  sql: string,
  question: string,
  tab: Tab
): QueryContext {
  const sqlLower = sql.toLowerCase();
  const sqlHasExplicitAggregateGeo =
    /\bhistorical_state_national\b/i.test(sql) ||
    /\bnational_monthly\b/i.test(sql) ||
    /\bstate\s*=\s*'United States'/i.test(sql);

  // --- Tables ---
  const tables: string[] = [];
  const tableRe = /\b(FROM|JOIN)\s+(\w+)/gi;
  let tm;
  while ((tm = tableRe.exec(sql)) !== null) {
    const t = tm[2].toLowerCase();
    if (!tables.includes(t)) tables.push(t);
  }

  // --- Cities/Agencies from SQL WHERE clauses ---
  const geos: string[] = [];
  // agency = 'X' (Current/Historical)
  const agencyRe = /agency\s*=\s*'([^']+)'/gi;
  let am;
  while ((am = agencyRe.exec(sql)) !== null) {
    if (!geos.includes(am[1])) geos.push(am[1]);
  }
  // city = 'X' (NIBRS)
  const cityRe = /city\s*=\s*'([^']+)'/gi;
  let cm;
  while ((cm = cityRe.exec(sql)) !== null) {
    if (!geos.includes(cm[1])) geos.push(cm[1]);
  }

  // If no geos from SQL, try to extract from the user's question
  if (geos.length === 0 && !sqlHasExplicitAggregateGeo) {
    // "in Charlotte", "in New York City"
    const inMatch = question.match(/\bin\s+([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)/);
    if (inMatch) {
      geos.push(inMatch[1]);
    } else {
      // Agency abbreviations
      for (const [pattern, city] of AGENCY_ALIASES) {
        if (pattern.test(question)) {
          geos.push(city);
          break;
        }
      }
      // Leading city name: "Charlotte aggravated assaults", "Charlotte murder rate"
      // Don't use /i flag — we need [A-Z] to truly match only uppercase for city names
      // Allow optional modifier words (aggravated, motor vehicle, etc.) between city and crime word
      if (geos.length === 0) {
        const leadingCity = question.match(
          /^([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)\s+(?:[a-z]+\s+)*?(?:[Mm]urder|[Rr]obbery|[Aa]ssault|[Bb]urglary|[Tt]heft|[Cc]rime|[Ss]taffing|[Pp]olice|[Oo]fficers|[Hh]omicide|[Rr]ape|[Cc]arjacking|[Aa]rson)/
        );
        if (leadingCity) {
          // Reject common English words that aren't city names
          const NON_CITY_LEADING = /^(National|Historical|Current|NIBRS|SHR|Hate|FBI|What|How|Why|When|Where|Which|Who|Show|List|Get|Find|Total|Annual|Compare|Give|Tell|Are|Is|Has|The|All|Any|Do|Does|Did|Can|Could|Should|Would|Will|May|Might)$/i;
          if (!NON_CITY_LEADING.test(leadingCity[1])) {
            geos.push(leadingCity[1]);
          }
        }
      }
    }
  }

  // --- Canonical resolved places (narrative validation only) ---
  // When neither the SQL nor the capitalized-question heuristics above yielded a
  // place, fall back to the shared place resolver. This is the 7772/7773 case:
  // SQL filters by ORI ('MDBPD0000') and the question is lowercase
  // ("carjackings in baltimore city"), so a CORRECT model mention of Baltimore
  // was rewritten to "cities in the dataset" by validateExplanationEntities.
  //
  // Deliberately kept OUT of `geos`: that field is read by 9 guardrails and by
  // geoDisplay, and widening it would change guardrail behavior. Only the
  // explain-path entity validator consumes `resolvedPlaces`.
  //
  // Cost is bounded — the resolver runs only when no geo was found any other
  // way, and never when the SQL is an explicit national/aggregate query (a
  // place mention there is genuinely suspect and should still be corrected).
  const resolvedPlaces: string[] = [];
  if (geos.length === 0 && !sqlHasExplicitAggregateGeo) {
    for (const mention of resolveGeoPlaces(question).mentions) {
      if (mention.requiresClarification || mention.candidates.length !== 1) continue;
      const candidate = mention.candidates[0];
      for (const name of [candidate.name, candidate.canonicalQuery]) {
        if (name && !resolvedPlaces.includes(name)) resolvedPlaces.push(name);
      }
    }
  }

  // --- States ---
  const states: string[] = [];
  const stateRe = /state\s*=\s*'([A-Z]{2})'/gi;
  let sm;
  while ((sm = stateRe.exec(sql)) !== null) {
    const s = sm[1].toUpperCase();
    if (!states.includes(s)) states.push(s);
  }
  // Also extract from IN clauses: state IN ('CT', 'ME', 'MA', ...)
  const inMatch = sql.match(/state\s+IN\s*\(([^)]+)\)/i);
  if (inMatch) {
    const inStates = inMatch[1].match(/'([A-Z]{2})'/gi);
    if (inStates) {
      inStates.forEach(s => {
        const clean = s.replace(/'/g, '').toUpperCase();
        if (!states.includes(clean)) states.push(clean);
      });
    }
  }

  // --- Scope ---
  let scope: Scope;
  if (tab === "nibrs") {
    // NIBRS scope detection
    const hasCityTable = tables.some(t => t.includes("city"));
    const hasStateTable = tables.some(t => t.includes("state"));
    const hasOri = /\bori\b/i.test(sql);
    const hasCityFilter = /city\s*=/i.test(sql);

    if (hasCityFilter || hasOri || (hasCityTable && !hasStateTable)) {
      scope = "city";
    } else if (states.length > 0 || hasStateTable) {
      scope = "state";
    } else {
      scope = "national";
    }
  } else {
    // Current/Historical scope detection
    const isCountyQuery = /type\s*=\s*'county'/i.test(sql) ||
      /\b(county|parish|borough)\b/i.test(question);
    if (sqlLower.includes("national_monthly") || sqlLower.includes("'united states'")) {
      scope = "national";
    } else if (sqlLower.includes("historical_state_national")) {
      scope = "state"; // Always state scope — never "city" even if geos extracted
    } else if (sqlLower.includes("agency_monthly") || sqlLower.includes("historical_agency")) {
      scope = isCountyQuery ? "county" as Scope : geos.length > 0 ? "city" : states.length > 0 ? "state" : "agency";
    } else if (sqlLower.includes("state_monthly")) {
      scope = "state";
    } else {
      scope = geos.length > 0 ? "city" : states.length > 0 ? "state" : "national";
    }
  }

  // --- Time range ---
  const yearMatches = sql.match(/\b(19\d{2}|20\d{2})\b/g);
  let start: number | null = null;
  let end: number | null = null;
  if (yearMatches) {
    const years = yearMatches.map(Number).sort((a, b) => a - b);
    start = years[0];
    end = years[years.length - 1];
  }

  // --- Offenses ---
  const offenses: string[] = [];
  for (const [pattern, name] of OFFENSE_MAP) {
    if (pattern.test(sql)) {
      if (!offenses.includes(name)) offenses.push(name);
    }
  }

  // --- Per capita ---
  const isPerCapita = sqlLower.includes("population") ||
    /\brate\b|per\s+capita|per\s+100/i.test(question);

  return {
    tab,
    question,
    geos,
    resolvedPlaces,
    states,
    scope,
    timeRange: { start, end },
    offenses,
    isPerCapita,
    tables,
    sql,
  };
}
