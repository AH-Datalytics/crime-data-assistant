/**
 * Query Context Extractor
 *
 * Parses Claude's SQL response into a structured context object so that
 * downstream stages (guardrails, explain, disclaimers) all share one
 * source of truth instead of each re-deriving context independently.
 */

export type Tab = "current" | "historical" | "nibrs" | "shr";
export type Scope = "national" | "state" | "city" | "agency";

export interface QueryContext {
  tab: Tab;
  question: string;
  /** Cities/agencies mentioned in SQL WHERE clauses */
  geos: string[];
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
  [/\b(?:'murder'|'09[abc]'|homicide)\b/i, "murder"],
  [/\b(?:'rape'|'11[abcd]')\b/i, "rape"],
  [/\b(?:'robbery'|'robberies'|'120')\b/i, "robbery"],
  [/\b(?:'aggravated assault'|'13[abc]')\b/i, "aggravated assault"],
  [/\b(?:'burglary'|'burglaries'|'220')\b/i, "burglary"],
  [/\b(?:'theft'|'larceny'|'larcenies'|'23[a-z]')\b/i, "theft"],
  [/\b(?:'motor vehicle theft'|'240')\b/i, "motor vehicle theft"],
  [/\b(?:'carjacking'|'64[ab]')\b/i, "carjacking"],
  [/\b(?:'arson'|'200')\b/i, "arson"],
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
  if (geos.length === 0) {
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
          const NON_CITY_LEADING = /^(National|What|How|Why|When|Where|Which|Who|Show|List|Get|Find|Total|Annual|Compare|Give|Tell|Are|Is|Has|The|All|Any|Do|Does|Did|Can|Could|Should|Would|Will|May|Might)$/i;
          if (!NON_CITY_LEADING.test(leadingCity[1])) {
            geos.push(leadingCity[1]);
          }
        }
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
    if (sqlLower.includes("national_monthly") || sqlLower.includes("'united states'")) {
      scope = "national";
    } else if (sqlLower.includes("state_monthly") || sqlLower.includes("historical_state_national")) {
      scope = geos.length > 0 ? "city" : "state";
    } else if (sqlLower.includes("agency_monthly") || sqlLower.includes("historical_agency")) {
      scope = geos.length > 0 ? "city" : states.length > 0 ? "state" : "agency";
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
    states,
    scope,
    timeRange: { start, end },
    offenses,
    isPerCapita,
    tables,
    sql,
  };
}
