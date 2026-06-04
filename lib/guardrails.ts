/**
 * Shared guardrail pipeline.
 *
 * Each guardrail is a { name, tabs, match, message } object.
 * `match` receives the QueryContext and returns true if the guardrail fires.
 * `message` returns the fix instruction sent to Claude for retry.
 *
 * Some guardrails can auto-fix the SQL without a Claude retry (rewrite).
 * Those set `rewrite` instead of (or in addition to) `message`.
 */

import type { QueryContext, Tab } from "./query-context";

export interface Guardrail {
  name: string;
  /** Which tabs this guardrail applies to */
  tabs: Tab[];
  /** Return true if this guardrail should fire */
  match: (ctx: QueryContext) => boolean;
  /** Fix instruction for Claude retry (null = no retry needed, use rewrite instead) */
  message?: (ctx: QueryContext) => string;
  /** Direct SQL rewrite (applied before Claude retry). Return null for no change. */
  rewrite?: (sql: string, ctx: QueryContext) => string | null;
  /** Hard override — skip retry entirely, return this as user-facing explanation.
   *  Use for known-impossible requests where the model can't fix the SQL. */
  override?: (ctx: QueryContext) => string | null;
}

export interface GuardrailResult {
  /** Guardrails that fired */
  fired: string[];
  /** Combined fix instructions for Claude retry */
  issues: string[];
  /** SQL after auto-rewrites */
  sql: string;
  /** Whether any guardrail fired */
  needsFix: boolean;
  /** Hard override explanation — if set, skip retry and return this to user */
  overrideResponse: string | null;
  /** Name of the guardrail that produced the override */
  overrideGuardrail: string | null;
}

/* ------------------------------------------------------------------ */
/*  Guardrail definitions                                              */
/* ------------------------------------------------------------------ */

const GUARDRAILS: Guardrail[] = [
  // --- Current / Historical ---
  {
    name: "current-crime-count-column",
    tabs: ["current"],
    match: (ctx) => /\bcrime_count\b/i.test(ctx.sql),
    rewrite: (sql) => sql.replace(/\bcrime_count\b/gi, "count"),
  },
  {
    name: "rate-no-population",
    tabs: ["current", "historical"],
    match: (ctx) =>
      ctx.isPerCapita && !ctx.sql.toLowerCase().includes("population") && !/_rate\b/.test(ctx.sql) && !/_clr\b/.test(ctx.sql),
    message: () =>
      "The user asked for rates/per capita but the SQL does not join population data.",
  },
  {
    name: "unpivoted-comparison",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Catch GROUP BY agency or JOINed long-format with city/agency as a column value
      const isLongFormat = (
        /group by.*agency/i.test(sql) ||
        /as\s+city\b/i.test(sql) ||
        /\.agency\s*\|\|/i.test(sql)
      );
      // Exempt dynamic top-N queries — by SQL shape OR question intent
      const isDynamicTopN = /\bWHERE\b[\s\S]*?\bori\s+IN\s*\(\s*SELECT\b/i.test(sql) ||
        /\bWITH\b[\s\S]*?\bORDER\s+BY\s+(?:SUM|total|count)\b/i.test(sql) ||
        /\btop\s+\d+/i.test(q) ||
        /\btop\s+(cities|agencies|counties|states|departments)\b/i.test(q) ||
        /\b(which|what)\s+(cities|agencies|counties|states|departments)\s+(had|have|had the|with the)\s+(most|highest|lowest|greatest|least)\b/i.test(q) ||
        (/\b(highest|most|greatest|lowest|least)\b/i.test(q) && /\b(per month|by year|over time|trend|monthly|annual)\b/i.test(q));
      return (
        isLongFormat &&
        !isDynamicTopN &&
        !/case\s+when/i.test(sql) &&
        /\byear\b/i.test(sql) && /\bmonth\b/i.test(sql) &&
        /LIMIT\s+(\d+)/i.test(sql) && parseInt(sql.match(/LIMIT\s+(\d+)/i)?.[1] || "0") > 500
      );
    },
    message: () =>
      "Multi-agency monthly comparison returns too many rows in long format. For monthly time series, limit to 5 cities max and use CASE WHEN pivoting (one column per city). Long-format with 6+ cities produces unreadable charts.",
  },
  // --- Dynamic top-N: hardcoded city names the user didn't ask for ---
  {
    name: "dynamic-topn-guessed-names",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Fire if user asked for dynamic discovery: "top N", "highest", "most", "which cities had the most", etc.
      const isDynamicRequest = /\btop\s+\d+/i.test(q) ||
        /\btop\s+(cities|agencies|counties|states|departments)\b/i.test(q) ||
        /\b(which|what)\s+(cities|agencies|counties|states|departments)\s+(had|have|had the|with the)\s+(most|highest|lowest|greatest|least)\b/i.test(q) ||
        (/\b(highest|most|greatest|lowest|least)\b/i.test(q) && /\b(per month|by year|over time|trend|monthly|annual)\b/i.test(q));
      if (!isDynamicRequest) return false;
      // Check if SQL has CASE WHEN with hardcoded city/agency names
      const caseNames: string[] = [];
      const caseRe = /CASE\s+WHEN\s+[^)]*(?:agency|city)\s*=\s*'([^']+)'/gi;
      let m;
      while ((m = caseRe.exec(sql)) !== null) {
        caseNames.push(m[1].toLowerCase());
      }
      if (caseNames.length === 0) return false;
      // Normalize user text with common aliases before comparing
      const ALIASES: Record<string, string[]> = {
        "new york city": ["nyc", "new york", "nypd"],
        "new york": ["nyc", "new york city", "nypd"],
        "los angeles": ["la", "lapd"],
        "washington": ["dc", "washington dc", "washington d.c."],
        "chicago": ["chi", "cpd"],
        "houston": ["hpd"],
        "dallas": ["dpd"],
        "baltimore": ["bmore", "bpd"],
        "philadelphia": ["philly"],
        "new orleans": ["nola"],
        "st louis": ["stl", "saint louis", "st. louis"],
        "saint louis": ["stl", "st louis", "st. louis"],
        "st. louis": ["stl", "st louis", "saint louis"],
        "atlanta": ["atl"],
        "phoenix": ["phx"],
        "minneapolis": ["mpls"],
        "detroit": ["detroit pd"],
        "memphis": ["mpd"],
        "nashville": ["mnpd"],
        "indianapolis": ["indy"],
      };
      const qNorm = q.replace(/[^a-z\s]/g, " ");
      const guessed = caseNames.filter(name => {
        if (qNorm.includes(name)) return false;
        // Check if user used an alias for this canonical name
        const aliases = ALIASES[name] || [];
        return !aliases.some(alias => qNorm.includes(alias));
      });
      return guessed.length > 0;
    },
    message: (ctx) => {
      const caseNames: string[] = [];
      const caseRe = /CASE\s+WHEN\s+[^)]*(?:agency|city)\s*=\s*'([^']+)'/gi;
      let m;
      while ((m = caseRe.exec(ctx.sql)) !== null) {
        caseNames.push(m[1]);
      }
      return `[SYSTEM: You hardcoded city names (${caseNames.join(", ")}) in CASE WHEN branches, but the user asked for a dynamic discovery query — you cannot know which cities will qualify. Use long format instead: return the requested time columns, an entity label, and the metric value, with a CTE that discovers the top entities. Let the frontend auto-pivot. Do NOT guess city names.]`;
    },
  },
  // --- Dynamic top-N: user asked for "top N" but SQL doesn't limit to N entities ---
  {
    name: "topn-no-entity-limit",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      // Does the user ask for top N?
      const topNMatch = q.match(/\btop\s+(\d+)/i);
      if (!topNMatch) return false;
      const n = parseInt(topNMatch[1]);
      if (n < 2 || n > 50) return false;
      // Does the SQL have a subquery or CTE that limits to N entities?
      // Look for: LIMIT N in a subquery, or IN (SELECT ... LIMIT N), or WITH ... LIMIT N
      const hasEntityLimit =
        /\bIN\s*\(\s*SELECT\b[\s\S]*?\bLIMIT\s+\d+/i.test(sql) ||
        /\bWITH\b[\s\S]*?\bLIMIT\s+\d+/i.test(sql) ||
        /\bORDER\s+BY\b[\s\S]*?\bLIMIT\s+\d+\b[\s\S]*?\)\s/i.test(sql);
      if (hasEntityLimit) return false;
      // Check if the outer LIMIT alone is sufficient (single-row-per-entity)
      // If SQL has no GROUP BY with entity columns, outer LIMIT is fine
      const hasEntityGroup = /GROUP\s+BY\b[\s\S]*?\b(agency|city|ori|state)\b/i.test(sql);
      if (!hasEntityGroup) return false;
      // SQL groups by entity but has no inner limit — likely returns all entities
      return true;
    },
    message: (ctx) => {
      const topNMatch = ctx.question.toLowerCase().match(/\btop\s+(\d+)/i);
      const n = topNMatch ? topNMatch[1] : "N";
      return `The user asked for the top ${n} but your SQL returns all entities without limiting to ${n}. Use a CTE or subquery to first identify the top ${n} entities (e.g., by total count), then filter the main query to only those ${n} ORIs/agencies. Example: WITH top_agencies AS (SELECT ori FROM ... GROUP BY ori ORDER BY SUM(count) DESC LIMIT ${n}) SELECT ... WHERE ori IN (SELECT ori FROM top_agencies).`;
    },
  },
  {
    name: "yaxis-missing",
    tabs: ["current", "historical"],
    match: () => false, // Checked externally with yAxis from ClaudeResponse — see route.ts
  },
  {
    name: "offense-missing-filter",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const offenseTerms: [RegExp, string[], string[]][] = [
        // [question pattern, SQL WHERE terms, SQL column names that encode this offense]
        [/\bmurder|homicide\b/i, ["'murder'", "'09a'"], ["murder", ".murder", "hsn.murder", "hac.murder", "hc.murder"]],
        [/\brape\b/i, ["'rape'", "'11a'"], ["rape", ".rape", "hsn.rape", "hac.rape"]],
        [/\brobbery|robberies\b/i, ["'robbery'", "'120'"], ["robbery", ".robbery", "hsn.robbery", "hac.robbery"]],
        [/\bassault\b/i, ["'aggravated assault'", "'13a'"], ["assault", ".assault", "aggravated_assault", "hsn.aggravated_assault", "hac.assault"]],
        [/\bburglary|burglaries\b/i, ["'burglary'", "'220'"], ["burglary", ".burglary", "hsn.burglary", "hac.burglary"]],
        [/\btheft(?!.*auto|.*motor|.*vehicle)|larceny|larcenies\b/i, ["'theft'", "'23h'", "'larceny'"], ["theft", ".theft", "hsn.theft", "hac.theft"]],
        [/\bauto theft|motor vehicle theft|car theft|vehicle theft\b/i, ["'motor vehicle theft'", "'240'"], ["motor_vehicle_theft", ".motor_vehicle_theft", "hsn.motor_vehicle_theft", "hac.motor_vehicle_theft"]],
      ];
      // Skip if SQL uses clearance columns (offense is encoded in column name)
      if (/_clr\b/.test(sqlLower)) return false;
      for (const [pattern, sqlTerms, columnNames] of offenseTerms) {
        if (!pattern.test(ctx.question)) continue;
        // Check if offense is in a WHERE filter
        const hasWhereFilter = sqlTerms.some((t) => sqlLower.includes(t)) || sqlLower.includes("offense");
        if (hasWhereFilter) continue;
        // Check if offense is encoded as a selected column (Historical tables use column-per-offense)
        const hasColumnSelect = columnNames.some((c) => sqlLower.includes(c));
        if (hasColumnSelect) continue;
        return true;
      }
      return false;
    },
    message: (ctx) => {
      const match = ctx.question.match(
        /\b(murder|homicide|rape|robbery|robberies|assault|burglary|burglaries|theft|larceny|larcenies|auto theft|motor vehicle theft|car theft|vehicle theft)\b/i
      );
      return `The user asked about "${match?.[0] || "a specific offense"}" but the SQL has no offense filter. Add a WHERE clause filtering by the appropriate offense.`;
    },
  },
  {
    name: "ambiguous-city-type",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (!sqlLower.includes("agency_monthly") || !/case\s+when/i.test(ctx.sql) || sqlLower.includes("type")) return false;
      const ambiguous = ["los angeles", "baltimore", "el paso", "sacramento", "san diego", "san mateo", "santa cruz", "st louis", "alameda", "denton", "greenville", "hamilton", "kalamazoo", "st charles", "tulare"];
      return ambiguous.some((c) => sqlLower.includes(`'${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = ["los angeles", "baltimore", "el paso", "sacramento", "san diego", "san mateo", "santa cruz", "st louis", "alameda", "denton", "greenville", "hamilton", "kalamazoo", "st charles", "tulare"];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `Multi-agency query includes ${mentioned.join(", ")} which have both City and County agencies, but no type filter was found. Add AND type = 'City' (or 'County') in each CASE WHEN branch and WHERE condition to avoid mixing jurisdictions.`;
    },
  },
  {
    name: "yaxis-label-no-population",
    tabs: ["current", "historical"],
    match: () => false, // Checked externally with yAxisLabel from ClaudeResponse — see route.ts
  },
  {
    name: "national-as-agency",
    tabs: ["current", "historical"],
    match: (ctx) => {
      return /agency\s*=\s*'(USA|United States|US|National|Nationwide)'/i.test(ctx.sql) ||
        /agency\s*(?:LIKE|IN)\s*[^)]*'(USA|United States|National)'/i.test(ctx.sql);
    },
    message: (ctx) => {
      if (ctx.tab === "historical") {
        return "You looked up national data as an agency name. National data is in historical_state_national with state = 'United States'. Use that table for the national comparison instead of looking up 'USA' or 'United States' as an agency.";
      }
      return "You looked up national data as an agency name. National data is in the national_monthly table. Use national_monthly for the national comparison instead of looking up 'USA' or 'National' as an agency in agency_monthly.";
    },
  },
  {
    name: "city-to-national-fallback",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const commonNonCityWords = /\b(united states|national|nationwide|country|state|federal|annual|home|residential|commercial)\b/i;
      const looksLikeCity = ctx.question.match(/\bin\s+([A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]+)*)/);
      if (!looksLikeCity || commonNonCityWords.test(looksLikeCity[1])) return false;
      const sqlLower = ctx.sql.toLowerCase();
      const usesNational = sqlLower.includes("national_monthly") || sqlLower.includes("state_monthly");
      const usesAgency = sqlLower.includes("agency_monthly") || sqlLower.includes("agency =") || sqlLower.includes("agency like");
      return usesNational && !usesAgency;
    },
    message: (ctx) => {
      const cityMatch = ctx.question.match(/\bin\s+([A-Z][a-z]{2,}(?:[\s-][A-Z][a-z]+)*)/);
      const city = cityMatch?.[1] || "that city";
      return `The user asked about "${city}" which looks like a city name, but your SQL queries national/state-level data instead. If "${city}" is a misspelling or not in the dataset, set sql to null and say you couldn't find that city — suggest the closest match or ask the user to check the spelling. Do NOT silently fall back to national data when the user asked about a specific place.`;
    },
  },

  // --- Current: single-city query on ambiguous city without type filter ---
  {
    name: "single-city-no-type",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (!sqlLower.includes("agency_monthly")) return false;
      // Already has type filter
      if (/\btype\s*=/i.test(ctx.sql)) return false;
      // Only fire for single-city queries (no CASE WHEN = multi-city, already covered)
      if (/case\s+when/i.test(ctx.sql)) return false;
      const ambiguous = [
        "los angeles", "baltimore", "el paso", "sacramento", "san diego",
        "san mateo", "santa cruz", "st louis", "alameda", "denton",
        "greenville", "hamilton", "kalamazoo", "st charles", "tulare",
        "jacksonville", "richmond", "kansas city",
      ];
      return ambiguous.some((c) => sqlLower.includes(`agency = '${c}'`) || sqlLower.includes(`agency='${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = [
        "los angeles", "baltimore", "el paso", "sacramento", "san diego",
        "san mateo", "santa cruz", "st louis", "alameda", "denton",
        "greenville", "hamilton", "kalamazoo", "st charles", "tulare",
        "jacksonville", "richmond", "kansas city",
      ];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `The query filters by ${mentioned.join(", ")} without a type filter. This city has both City and County agencies with different data. Add AND type = 'City' to the WHERE clause (or set sql to null and ask the user which jurisdiction they mean).`;
    },
  },

  // --- Current: state_monthly used for state trend ---
  {
    name: "state-monthly-for-trend",
    tabs: ["current"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      // state_monthly used with time-series grouping (year, month) = trend query
      return sqlLower.includes("state_monthly") &&
        /group\s+by.*\byear\b/i.test(ctx.sql) &&
        !sqlLower.includes("agency_monthly");
    },
    message: () =>
      "You used state_monthly for a state trend query. state_monthly includes partial reporters and produces inconsistent counts. Use agency_monthly JOIN agencies WHERE national_sample = 1 AND state = '[XX]' instead, which only includes agencies with complete reporting histories.",
  },

  // --- Current: city-to-national fallback (widened) ---
  // Catches abbreviations (LA, NYC, STL) and leading city patterns
  // that the existing city-to-national-fallback misses
  {
    name: "city-abbreviation-to-national",
    tabs: ["current", "historical"],
    match: (ctx) => {
      // Only fire if question mentions a city via abbreviation or leading pattern
      // but SQL uses national/state tables with no agency filter
      const sqlLower = ctx.sql.toLowerCase();
      const usesNational = sqlLower.includes("national_monthly") || sqlLower.includes("state_monthly") ||
        sqlLower.includes("historical_state_national");
      const usesAgency = /agency\s*=/i.test(ctx.sql) || sqlLower.includes("agency_monthly");
      if (!usesNational || usesAgency) return false;

      // State names/abbreviations that should NOT trigger this guardrail
      const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia)\b/i;

      // Check for abbreviations the existing guardrail misses
      const abbrevs = /\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|DFW|DMV|CHI|BMORE|MPLS|MSP|OKC|SLC|NYPD|LAPD|CPD|HPD|DPD|BPD|MPD)\b/i;
      if (abbrevs.test(ctx.question)) return true;

      // Check for geos extracted from question — but exclude state names
      if (ctx.geos.length > 0 && !sqlLower.includes("agency")) {
        const nonStateGeos = ctx.geos.filter(g => !STATE_NAMES.test(g));
        if (nonStateGeos.length > 0) return true;
      }

      return false;
    },
    message: (ctx) => {
      const city = ctx.geos[0] || ctx.question.match(/\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|CHI|BMORE|NYPD|LAPD|CPD)\b/i)?.[1] || "that city";
      return `The user asked about "${city}" but your SQL queries national/state-level data instead of agency-level data. Look up the correct agency name in agency_monthly (or historical_agency_crime for Historical). If the city is not in the dataset, set sql to null and tell the user. Do NOT silently fall back to national data.`;
    },
  },

  // --- Current/Historical: population JOIN without year (rate queries) ---
  {
    name: "population-join-no-year",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Only relevant for rate queries that join population
      if (!ctx.isPerCapita) return false;
      const hasPopJoin = /JOIN\s+agency_population\b/i.test(sql) || /JOIN\s+historical_agency_population\b/i.test(sql);
      if (!hasPopJoin) return false;
      // Check if the JOIN condition includes year matching
      // Good: ON ap.ori = am.ori AND ap.year = am.year
      // Bad:  ON ap.ori = am.ori (missing year)
      const joinClause = sql.match(/JOIN\s+(?:agency_population|historical_agency_population)\s+\w+\s+ON\s+([^)]+?)(?:\s+WHERE|\s+GROUP|\s+ORDER|\s+LIMIT|$)/i);
      if (!joinClause) return false;
      const onClause = joinClause[1];
      return !/\byear\b/i.test(onClause);
    },
    message: () =>
      "Your population JOIN is missing a year condition (e.g., AND ap.year = am.year). Without it, each row gets multiplied by every year of population data, producing wildly inflated results. Add the year match to the JOIN ON clause.",
  },

  // --- Historical: state query using agency table instead of state_national ---
  {
    name: "historical-state-via-agency",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detects: aggregating historical_agency_crime grouped by year with a state filter
      // but NOT selecting individual agencies (no agency column in SELECT)
      const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
      const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
      const groupsByYear = /GROUP\s+BY\s+(?:hac\.)?year/i.test(sql);
      const selectsAgency = /SELECT\s+[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
      // Do NOT fire for county/parish/city/agency queries — those NEED the agency table
      const asksSubState = /\b(county|parish|borough|sheriff|agency)\b/i.test(q) ||
        /\bin\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*,/i.test(ctx.question); // "in Alameda, California"
      if (asksSubState) return false;
      return usesAgencyTable && hasStateFilter && groupsByYear && !selectsAgency;
    },
    message: () =>
      "You aggregated historical_agency_crime by state, which only includes agencies that reported — it dramatically undercounts. Use historical_state_national instead, which has FBI statewide estimates. Column names are compatible: assault, motor_vehicle_theft, murder, rape, robbery, burglary, theft all work in both tables. Use the full state name (e.g., 'North Carolina' not 'nc').",
  },

  // --- Historical: listing every agency in a state (un-chartable) ---
  {
    name: "historical-state-agency-listing",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects: SELECT agency, year, crime FROM historical_agency_crime
      // with state filter but ordered by agency (not ranked by metric)
      // This produces hundreds/thousands of rows that can't be charted
      const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
      const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
      const selectsAgency = /SELECT[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
      // Not a ranking — ordered by agency name, not by a metric DESC
      const isRanking = /ORDER\s+BY\s+(?:total|sum|count|murder|robbery|assault|burglary|theft|rape|violent|property)\b/i.test(sql) ||
        /ORDER\s+BY\s+\w+\s+DESC/i.test(sql);
      return usesAgencyTable && hasStateFilter && selectsAgency && !isRanking;
    },
    message: () =>
      "Your query lists every agency in a state, which produces hundreds or thousands of rows that cannot be charted. Use historical_state_national for the state aggregate instead (e.g., SELECT year, robbery FROM historical_state_national WHERE state = 'California'). Only use the agency table when the user explicitly asks for a ranking (top 10, highest, etc.) or names specific agencies.",
  },

  // --- Contract checks: question intent vs SQL structure ---
  {
    name: "contract-geography-missing",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User mentions a specific city but SQL has no agency filter and no CASE WHEN
      const cityPatterns = [
        /\b(houston|dallas|phoenix|philadelphia|san antonio|san diego|austin|jacksonville|columbus|charlotte|indianapolis|san francisco|seattle|denver|nashville|oklahoma city|el paso|boston|portland|memphis|louisville|baltimore|milwaukee|albuquerque|tucson|fresno|sacramento|atlanta|kansas city|omaha|raleigh|miami|oakland|minneapolis|tampa|detroit|new orleans|cleveland|pittsburgh|cincinnati|orlando|st\.?\s*louis|baton rouge|richmond|birmingham|spokane|norfolk|durham|stockton|anchorage|honolulu|arlington|lubbock|garland|madison|reno|glendale|hialeah|chesapeake)\b/i,
        /\bin\s+(los angeles|new york|chicago)\b/i,
        /\b(la|nyc|chi|philly|nola|stl|atl|bmore|indy|mpls)\b/i,
      ];
      const mentionsCity = cityPatterns.some(p => p.test(q));
      if (!mentionsCity) return false;
      // SQL should have an agency filter or city-level CASE WHEN
      const hasAgencyFilter = /agency\s*=|agency\s+like|agency\s+in\s*\(/i.test(sql);
      const hasCaseWhen = /case\s+when.*agency/i.test(sql);
      const usesNational = sql.includes("national_monthly") || sql.includes("historical_state_national");
      return !hasAgencyFilter && !hasCaseWhen && usesNational;
    },
    message: (ctx) => {
      const cityMatch = ctx.question.match(/\b(?:in\s+)?([A-Z][a-z]+(?:[\s-][A-Z][a-z]+)*)/);
      return `The user asked about "${cityMatch?.[1] || "a specific city"}" but the SQL queries national/state-level data with no agency filter. Query the agency-level table instead, filtering by the requested city.`;
    },
  },
  {
    name: "contract-year-range-missing",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User specifies a year range like "since 2020" or "from 1990 to 2024"
      const yearMatch = q.match(/\b(?:since|from|starting|after)\s+(19|20)\d{2}\b/i) ||
        q.match(/\b(19|20)\d{2}\s*(?:to|through|-)\s*(19|20)\d{2}\b/i);
      if (!yearMatch) return false;
      // SQL should have a year filter
      const hasYearFilter = /\byear\s*(?:>=|>|=|BETWEEN)/i.test(sql) || /\byear\s+IN\s*\(/i.test(sql);
      return !hasYearFilter;
    },
    message: (ctx) => {
      const yearMatch = ctx.question.match(/\b(?:since|from|starting|after)\s+((19|20)\d{2})\b/i) ||
        ctx.question.match(/\b((19|20)\d{2})\s*(?:to|through|-)/i);
      return `The user specified a year range starting at ${yearMatch?.[1] || "a specific year"} but the SQL has no year filter. Add a WHERE clause filtering by the requested year range.`;
    },
  },
  {
    // TODO: Rate-contract second-failure override — deferred.
    // Plan: after retry, run runGuardrails() again in the route. If this fires twice
    // on the same query, convert to hard override ("I couldn't calculate a rate").
    // Keep this as a retry guardrail for now; route-level second-failure logic is not yet implemented.
    name: "contract-rate-no-population",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      // User asks for rate/per capita but SQL doesn't join population
      // Skip if user explicitly rejected rates
      if (/\b(not rates?|raw numbers?|raw counts?|counts?\s*(?:,\s*)?not rates?)\b/i.test(q)) return false;
      const wantsRate = /\b(rates?|per\s*capita|per\s*100k|per\s*100,000|per\s*hundred\s*thousand)\b/i.test(q);
      if (!wantsRate) return false;
      // Skip if user is comparing demographic groups — "rates" is colloquial, not per-capita
      const isComparison = /\b(compare|comparison|vs|versus|breakdown|share|percent|proportion)\b/i.test(q);
      const groupsByDemographic = /GROUP\s+BY[\s\S]*?\b(age_group|race|sex|weapon|ethnicity)\b/i.test(ctx.sql);
      if (isComparison && groupsByDemographic) return false;
      const sqlLower = ctx.sql.toLowerCase();
      return !sqlLower.includes("population") && !sqlLower.includes("100000") && !/_rate\b/.test(sqlLower) && !/_clr\b/.test(sqlLower);
    },
    message: (ctx) => {
      if (ctx.tab === "shr") return "The user asked for rates but the SQL does not calculate a per-capita rate. Use ROUND(COUNT(*) * 100000.0 / NULLIF(AVG(i.population), 0), 1) for single-agency SHR rates. For state/national aggregate rates, set sql to null and redirect to the Historical Library tab.";
      if (ctx.tab === "nibrs") return "The user asked for rates but the SQL does not calculate a per-capita rate. JOIN the agencies table to get population, then use ROUND(SUM(count) * 100000.0 / population, 1). For state-level rates, redirect to the Historical Library tab.";
      return "The user asked for rates/per capita but the SQL does not reference population data. JOIN agency_population (Current Trends) or use the population column (Historical) and divide by population to calculate the rate.";
    },
  },

  // --- Historical: recursive CTE without ORI deduplication ---
  {
    name: "historical-multi-ori-cte",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect recursive CTE gap-fill pattern that selects ORI without LIMIT 1
      const hasRecursiveCTE = /WITH\s+\w+\s+AS\s*\([\s\S]*?UNION\s+ALL/i.test(sql);
      const hasAgencyOri = /SELECT\s+(?:ha\.)?ori\s+FROM\s+historical_agency\b/i.test(sql);
      const hasLimit1 = /FROM\s+historical_agency\b[^)]*LIMIT\s+1/i.test(sql);
      const joinsDataTable = /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_agency_crime/i.test(sql) ||
        /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_agency_clearance/i.test(sql) ||
        /FROM\s+historical_agency\s+\w+\s+JOIN\s+historical_staffing/i.test(sql);
      // Fire if: recursive CTE + selects ORI from historical_agency + no LIMIT 1 + doesn't join data table
      return hasRecursiveCTE && hasAgencyOri && !hasLimit1 && !joinsDataTable;
    },
    message: () =>
      "Your recursive CTE selects ORI from historical_agency without deduplication. Some agencies have multiple ORI codes — this will produce duplicate rows. Add GROUP BY ha.ori ORDER BY COUNT(*) DESC LIMIT 1 to the agency CTE, and JOIN the data table (historical_agency_crime, historical_staffing, etc.) to ensure you pick the ORI with actual data.",
  },

  // --- NIBRS ---
  {
    name: "nibrs-raw-victims",
    tabs: ["nibrs"],
    match: (ctx) => {
      const PERSON_CODES = ['09A','09B','09C','11A','11B','11C','11D','13A','13B','13C','100','36A','36B','64A','64B'];
      const hitsRawVictims = /\bFROM\s+VICTIMS\b/i.test(ctx.sql) && !(/\bSUMMARY_VICTIM/i.test(ctx.sql));
      const hasPersonCode = PERSON_CODES.some(code => ctx.sql.includes(`'${code}'`));
      const isCountQuery = /\bCOUNT\s*\(|\bSUM\s*\(/i.test(ctx.sql);
      const selectClause = ctx.sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || '';
      const needsDemographics = /\b(\.age|\.sex|\.race|\.ethnicity|\.injury_type|\.relationship)/i.test(selectClause);
      return hitsRawVictims && hasPersonCode && isCountQuery && !needsDemographics;
    },
    message: () =>
      "[SYSTEM: You MUST use summary_victim_state_monthly or summary_victim_city_monthly for this query. Do NOT use the raw victims table.]",
  },
  {
    name: "nibrs-raw-table-for-counts",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect raw tables used for aggregate counts/sums/trends
      const RAW_TABLES = ["offenses", "property", "arrestees", "offense_weapons"];
      const usesRawTable = RAW_TABLES.some(t =>
        new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql) ||
        new RegExp(`\\bJOIN\\s+${t}\\b`, "i").test(sql)
      );
      if (!usesRawTable) return false;
      // Only fire if it's an aggregate query (COUNT/SUM/GROUP BY) — detail queries on raw tables are OK
      return /\bCOUNT\s*\(|\bSUM\s*\(|\bGROUP\s+BY\b/i.test(sql);
    },
    message: (ctx) => {
      const sql = ctx.sql;
      // Suggest the specific summary table based on which raw table was used
      let suggestion = "";
      if (/\bFROM\s+offenses\b|\bJOIN\s+offenses\b/i.test(sql)) {
        suggestion = " Use summary_state_monthly (state-level) or summary_city_monthly (city-level) for offense counts. For person crimes (murder, rape, assault), use summary_victim_state_monthly or summary_victim_city_monthly instead.";
      } else if (/\bFROM\s+property\b|\bJOIN\s+property\b/i.test(sql)) {
        suggestion = " Use summary_property_offense for property loss data.";
      } else if (/\bFROM\s+arrestees\b|\bJOIN\s+arrestees\b/i.test(sql)) {
        suggestion = " Use summary_arrestee_demographics for arrestee data.";
      } else if (/\bFROM\s+offense_weapons\b|\bJOIN\s+offense_weapons\b/i.test(sql)) {
        suggestion = " Use summary_offense_weapon for weapon data.";
      }
      return `[SYSTEM: CRITICAL — Your query uses a raw table that has 100M+ rows and WILL time out. You must rewrite it completely using a summary table.${suggestion} Generate a NEW query from scratch using the correct summary table — do not just replace the table name, as the column names and structure are different.]`;
    },
  },
  {
    name: "nibrs-person-crime-offense-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      // Person crime codes that MUST use victim tables, not offense tables
      const PERSON_CODES = ["09A","09B","09C","11A","11B","11C","11D","13A","13B","13C","100","36A","36B","64A","64B"];
      const sql = ctx.sql;
      // Using offense summary tables (not victim summary tables) with person crime codes
      const usesOffenseSummary = /\bsummary_(?:city|state)_monthly\b/i.test(sql) && !/\bsummary_victim/i.test(sql);
      if (!usesOffenseSummary) return false;
      return PERSON_CODES.some(code => sql.includes(`'${code}'`));
    },
    message: () =>
      "[SYSTEM: Person crimes (murder, rape, assault, kidnapping, sex offenses, carjacking) must be counted from VICTIM summary tables, not offense summary tables. Use summary_victim_state_monthly or summary_victim_city_monthly instead of summary_state_monthly or summary_city_monthly. Offense tables undercount person crimes by ~20%.]",
  },
  {
    name: "nibrs-property-crime-victim-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      // Property crime codes that must NOT use victim tables
      const PROPERTY_CODES = [
        "23A","23B","23C","23D","23E","23F","23G","23H",  // theft subcodes
        "220",                                             // burglary
        "240",                                             // motor vehicle theft
        "250",                                             // counterfeiting/forgery
        "26A","26B","26C","26D","26E",                     // fraud
        "270",                                             // embezzlement
        "280",                                             // stolen property
        "290",                                             // destruction/vandalism
      ];
      const sql = ctx.sql;
      const usesVictimTable = /\bsummary_victim_(?:city|state)_monthly\b/i.test(sql);
      if (!usesVictimTable) return false;
      return PROPERTY_CODES.some(code => sql.includes(`'${code}'`));
    },
    message: () =>
      "[SYSTEM: Property crimes (theft, burglary, motor vehicle theft, fraud, vandalism, etc.) must use offense summary tables, NOT victim summary tables. Use summary_state_monthly or summary_city_monthly instead of summary_victim_state_monthly or summary_victim_city_monthly. Victim tables only contain person crimes and will return 0 rows for property offenses.]",
  },
  {
    name: "nibrs-sex-filter-missing-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User asks about male/female/sex/gender
      const wantsSex = /\b(male|female|men|women|sex|gender|by sex|by gender)\b/i.test(q);
      if (!wantsSex) return false;
      // SQL uses summary_victim_weapon_circumstance (no sex) instead of the _demo version (has sex)
      const usesOldTable = sql.includes("summary_victim_weapon_circumstance") && !sql.includes("summary_victim_weapon_circumstance_demo");
      if (usesOldTable) return true;
      // Also catch other no-sex tables
      const noSexTables = ["summary_victim_circumstance", "summary_offense_weapon", "summary_offense_location", "summary_offense_hour"];
      const usesNoSexTable = noSexTables.some(t => sql.includes(t));
      const hasSexFilter = /\bsex\b.*=|victim_sex/i.test(sql);
      return usesNoSexTable && !hasSexFilter;
    },
    message: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      if (sql.includes("summary_victim_weapon_circumstance") && !sql.includes("_demo")) {
        return "[SYSTEM: The user asked for a sex/gender breakdown but you used summary_victim_weapon_circumstance which has NO sex column. Use summary_victim_weapon_circumstance_demo instead — it has the same columns PLUS sex, race, and age_group. Add a WHERE sex = 'F' or sex = 'M' filter, or GROUP BY sex for a breakdown.]";
      }
      return "[SYSTEM: The user asked for a male/female breakdown, but the table you chose has NO sex column. The query will return identical numbers regardless of which sex was requested. For weapon+circumstance+sex queries, use summary_victim_weapon_circumstance_demo. For other demographic queries, use summary_victim_demographics. Do NOT silently drop the sex filter.]";
    },
  },
  {
    name: "nibrs-cross-level-join",
    tabs: ["nibrs"],
    match: (ctx) => {
      const usesCitySummary = /\bsummary_victim_city_monthly\b/i.test(ctx.sql) || /\bsummary_city_monthly\b/i.test(ctx.sql);
      const usesStateSummary = /\bsummary_victim_state_monthly\b/i.test(ctx.sql) || /\bsummary_state_monthly\b/i.test(ctx.sql);
      return usesCitySummary && usesStateSummary && /\bJOIN\b/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Your previous query JOINed city-level and state-level summary tables, which produces incorrect results due to row multiplication. For comparisons between a city and a state/national average, use separate subqueries or CTEs — one for the city data and one for the state/national data — then combine them. NEVER JOIN summary_victim_city_monthly with summary_victim_state_monthly directly.]",
  },
  {
    name: "nibrs-state-table-with-ori",
    tabs: ["nibrs"],
    match: (ctx) => {
      const usesStateSummary = /\bsummary_victim_state_monthly\b/i.test(ctx.sql);
      const usesStateProp = /\bsummary_state_monthly\b/i.test(ctx.sql) && !/\bsummary_victim/i.test(ctx.sql);
      const hasOri = /\bori\b/i.test(ctx.sql);
      return (usesStateSummary || usesStateProp) && hasOri;
    },
    rewrite: (sql) => {
      let fixed = sql.replace(/\bsummary_victim_state_monthly\b/gi, 'summary_victim_city_monthly');
      fixed = fixed.replace(/\bsummary_state_monthly\b/gi, 'summary_city_monthly');
      return fixed !== sql ? fixed : null;
    },
  },
  // --- NIBRS: city question answered with state-level data (no ORI) ---
  {
    name: "nibrs-city-got-state",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL uses state-level summary tables without any ORI or city filter
      const usesStateTable = /\bsummary_victim_state_monthly\b/i.test(sql) || /\bsummary_state_monthly\b/i.test(sql);
      if (!usesStateTable) return false;
      const hasOriOrCity = /\bori\b/i.test(sql) || /\bcity\b/i.test(sql);
      if (hasOriOrCity) return false; // Already has city-level filter — nibrs-state-table-with-ori handles this
      // State names that should NOT trigger this guardrail
      const STATE_NAMES_NIBRS = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;
      const cityGeos = ctx.geos.filter(g => !STATE_NAMES_NIBRS.test(g));
      // User asked about a specific city/agency/county (not a state)
      const q = ctx.question.toLowerCase();
      const mentionsCity = cityGeos.length > 0 ||
        /\b(police|department|pd|sheriff|agency|county|parish)\b/i.test(q);
      return mentionsCity;
    },
    message: (ctx) => {
      const city = ctx.geos[0] || "the requested city/county";
      return `[SYSTEM: The user asked about "${city}" but the SQL queries a state-level summary table with no ORI or city filter — this returns statewide data, not city data. Use the city-level table instead: summary_victim_city_monthly (for person crimes) or summary_city_monthly (for property crimes), filtered by ORI: WHERE ori IN (SELECT ori FROM agencies WHERE city = '${city.toUpperCase()}' AND state = '...' AND population > 0). Do NOT return state-level data when the user asked about a specific city or agency.]`;
    },
  },
  {
    name: "nibrs-national-as-agency",
    tabs: ["nibrs"],
    match: (ctx) => {
      return /\b(city|agency_name)\s*=\s*'(USA|United States|US|National)'/i.test(ctx.sql) ||
        /agencies\s+WHERE.*'(USA|United States|UNITED STATES|National|NATIONAL)'/i.test(ctx.sql) ||
        /\bstate\s*=\s*'(US|USA)'/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Do NOT look up 'USA', 'United States', or state='US' as a filter. There is no state code 'US'. For national totals, SUM across all states from the state-level summary table (summary_victim_state_monthly for person crimes, summary_state_monthly for property/society crimes) WITHOUT any state filter. Do not filter by ori, city, or state for national data.]",
  },
  {
    name: "nibrs-agencies-join-no-year",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects JOIN agencies without year condition
      const hasAgenciesJoin = /JOIN\s+agencies\s+(\w+)\s+ON\s+/i.test(sql);
      if (!hasAgenciesJoin) return false;
      // Extract the ON clause for the agencies JOIN
      const joinMatch = sql.match(/JOIN\s+agencies\s+\w+\s+ON\s+([^)]*?)(?:\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|JOIN)|\s*$)/i);
      if (!joinMatch) return false;
      return !/\byear\b/i.test(joinMatch[1]);
    },
    message: () =>
      "[SYSTEM: Your JOIN to the agencies table is missing a year condition. The agencies table has one row per (ori, year) — without matching on year, you will get row multiplication (each summary row repeated for every year the agency exists). Add AND a.year = s.year (or the appropriate year column) to the JOIN ON clause.]",
  },
  {
    name: "nibrs-ranking-by-population",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detect: user asks for "top N" or "highest/most" by a crime metric, but the query pre-filters by population
      const asksTopN = (/\btop\s+\d+\b/i.test(q) || /\b(highest|most|greatest|leading)\b/i.test(q)) && /\b(murder|crime|robbery|assault|theft|rape|burglary|offense|victim|homicide|shooting|carjack)\b/i.test(q);
      if (!asksTopN) return false;
      // Check for a subquery or CTE that pre-filters agencies by population instead of ranking by crime count
      // Handles: SELECT ori FROM agencies ... ORDER BY population, SELECT a.ori FROM agencies AS a ... ORDER BY a.population, etc.
      const preFiltersByPop = /SELECT\s+[\w.]*ori\s+FROM\s+agencies[\s\S]*?ORDER\s+BY\s+[\w.]*population\s+DESC\s+LIMIT/i.test(sql);
      return preFiltersByPop;
    },
    message: () =>
      "[SYSTEM: The user asked for the top agencies ranked by a crime metric, but your query pre-filters to the largest agencies by population. This gives 'crime in the N biggest cities', NOT 'cities with the most crime'. Instead, aggregate the crime count for ALL agencies, then ORDER BY the crime metric DESC LIMIT N. Use summary_clearance_city_annual (which has city name pre-joined) or summary_victim_city_monthly with JOIN agencies ON ori+year. Do NOT pre-select agencies by population.]",
  },
  {
    name: "nibrs-agencies-join-no-ori",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: JOIN agencies on state+year without ori — creates cartesian product
      const usesCityTable = /\bsummary_(?:victim_)?city_monthly\b/i.test(sql);
      // Match: JOIN agencies a, JOIN agencies AS a, LEFT JOIN agencies a, etc.
      const hasAgenciesJoin = /JOIN\s+agencies\b/i.test(sql);
      if (!usesCityTable || !hasAgenciesJoin) return false;
      // Extract ON clause — handle aliases with/without AS, multiline SQL
      // Matches: JOIN agencies a ON ..., JOIN agencies AS a ON ..., JOIN agencies ON ...
      const joinClause = sql.match(/JOIN\s+agencies(?:\s+AS)?\s+\w*\s*ON\s+([\s\S]*?)(?=\s+(?:WHERE|GROUP|ORDER|LIMIT|LEFT|RIGHT|INNER|CROSS|JOIN|HAVING)\b|\s*$)/i);
      if (!joinClause) return false;
      return !/\bori\b/i.test(joinClause[1]);
    },
    message: () =>
      "[SYSTEM: Your JOIN between a city-level summary table and the agencies table matches on state+year but NOT ori. This creates a cartesian product — every summary row gets multiplied by every agency in that state/year, producing wildly inflated and incorrect results. You MUST match on ori: JOIN agencies a ON a.ori = s.ori AND a.year = s.year. Alternatively, for ranking cities by crime counts, you don't need the agencies JOIN at all — use summary_clearance_city_annual which already has city name and population, or use an ORI subquery to get city names.]",
  },
  {
    name: "nibrs-city-case-sensitivity",
    tabs: ["nibrs"],
    match: (ctx) => {
      // NIBRS cities are ALL CAPS. Detect mixed-case city filters that would return 0 rows.
      // Match city = 'Houston' (mixed case) but NOT city = 'HOUSTON' (correct)
      const cityFilters = ctx.sql.match(/city\s*=\s*'([^']+)'/gi);
      if (!cityFilters) return false;
      return cityFilters.some(f => {
        const val = f.match(/city\s*=\s*'([^']+)'/i)?.[1];
        return val && val !== val.toUpperCase();
      });
    },
    rewrite: (sql) => {
      // Auto-fix: uppercase all city = 'xxx' values
      const fixed = sql.replace(/city\s*=\s*'([^']+)'/gi, (match, city) => {
        return match.replace(city, city.toUpperCase());
      });
      return fixed !== sql ? fixed : null;
    },
  },
  // --- NIBRS: specific drug arrest query using wrong table ---
  // Once summary_drug_arrests exists, the prompt directs Claude there and this won't fire.
  // This is the safety net: hard override blocks execution of the wrong data.
  {
    name: "nibrs-drug-arrest-wrong-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const specificDrug = /\b(marijuana|cannabis|weed|meth|methamphetamine|cocaine|crack|heroin|fentanyl|opioid|lsd|pcp|ecstasy|mdma|opium|hashish|amphetamine)\b/i.test(q);
      const wantsArrests = /\b(arrest|arrested|arrestee)\b/i.test(q);
      const usesArresteeDemographics = sql.includes("summary_arrestee_demographics");
      const hasDrugOffense = /\b3[5][AB]\b/.test(ctx.sql);
      const usesDrugArrests = sql.includes("summary_drug_arrests");
      return specificDrug && wantsArrests && usesArresteeDemographics && hasDrugOffense && !usesDrugArrests;
    },
    override: (ctx) => {
      const drug = ctx.question.match(/\b(marijuana|cannabis|weed|meth|methamphetamine|cocaine|crack|heroin|fentanyl|opioid|lsd|pcp|ecstasy|mdma|opium|hashish|amphetamine)\b/i)?.[1] || "that drug";
      const drugCap = drug.charAt(0).toUpperCase() + drug.slice(1);
      const offenseType = /35B/.test(ctx.sql) ? "sales" : "possession";
      return `I can't isolate ${drug} arrests specifically — the arrest data groups all drug arrests under a single code (35A for possession, 35B for sales) without distinguishing the drug type. I can show you:\n\n- **Total drug ${offenseType} arrests** (all drugs combined) — ask "drug ${offenseType} arrests"\n- **${drugCap} drug offense counts** broken down by drug type (these are offenses reported to NIBRS, not arrest counts) — ask "${drug} drug offenses"\n\nWould either of those work?`;
    },
  },
  // --- Multi-city ORI subquery with global LIMIT 1 ---
  {
    name: "multi-city-global-limit-ori",
    tabs: ["nibrs", "current", "historical", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: city IN ('A', 'B') inside a subquery with ORDER BY pop_group/population LIMIT 1
      // This picks one ORI total instead of one per city
      const hasMultiCityIn = /city\s+IN\s*\([^)]*,[^)]*\)/i.test(sql);
      if (!hasMultiCityIn) return false;
      // Check for LIMIT 1 in the same subquery as the multi-city IN clause
      const hasGlobalLimit = /city\s+IN\s*\([^)]*\)[\s\S]*?(?:ORDER\s+BY\s+(?:pop_group|population)[^)]*LIMIT\s+1)/i.test(sql);
      return hasGlobalLimit;
    },
    message: () =>
      "[SYSTEM: You used a single ORI subquery with city IN (...) ... LIMIT 1, which selects only one agency across all requested cities. For multi-city comparisons, select one ORI per city. Use separate ORI subqueries per city in CASE WHEN branches, or use a CTE: WITH city_oris AS (SELECT ori, city, state FROM (SELECT ori, city, state, ROW_NUMBER() OVER (PARTITION BY city, state ORDER BY pop_group) AS rn FROM agencies WHERE (city = 'X' AND state = 'XX') OR (city = 'Y' AND state = 'YY') AND year = 2025 AND population > 0) WHERE rn = 1) ... WHERE s.ori IN (SELECT ori FROM city_oris)]",
  },
  {
    name: "city-like-no-state",
    tabs: ["nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: city LIKE 'X%' or agency LIKE 'X%' without a state filter in the SAME clause
      const likeMatch = sql.match(/(?:city|agency)\s+LIKE\s+'([^']+)'/gi);
      if (!likeMatch) return false;
      // Only fire if the LIKE is a prefix match (ends with %)
      const hasPrefixLike = likeMatch.some(m => {
        const val = m.match(/LIKE\s+'([^']+)'/i)?.[1];
        return val && !val.startsWith('%') && val.endsWith('%');
      });
      if (!hasPrefixLike) return false;
      // Check for state filter in the SAME subquery as the LIKE, not globally
      // Extract the subquery or clause containing the LIKE
      for (const m of likeMatch) {
        const val = m.match(/LIKE\s+'([^']+)'/i)?.[1];
        if (!val || val.startsWith('%') || !val.endsWith('%')) continue;
        // Find the innermost parenthesized clause containing this LIKE
        const likeIdx = sql.indexOf(m);
        // Walk backward to find the opening paren of this subquery
        let depth = 0;
        let clauseStart = 0;
        for (let i = likeIdx; i >= 0; i--) {
          if (sql[i] === ')') depth++;
          if (sql[i] === '(') {
            if (depth === 0) { clauseStart = i; break; }
            depth--;
          }
        }
        // Walk forward to find the closing paren
        depth = 0;
        let clauseEnd = sql.length;
        for (let i = likeIdx; i < sql.length; i++) {
          if (sql[i] === '(') depth++;
          if (sql[i] === ')') {
            if (depth === 0) { clauseEnd = i; break; }
            depth--;
          }
        }
        const clause = sql.slice(clauseStart, clauseEnd);
        // Check if this clause has a state filter
        if (!/\bstate\s*=\s*'[A-Z]{2}'/i.test(clause)) return true;
      }
      return false;
    },
    message: (ctx) => {
      const likeVal = ctx.sql.match(/(?:city|agency)\s+LIKE\s+'([^'%]+)/i)?.[1] || "the search term";
      return `[SYSTEM: Your query uses a LIKE prefix search ('${likeVal}%') without a state filter. This can match the wrong city/agency entirely (e.g., 'KINGS%' matches Kingsport, TN instead of Kings County, NY). Either add AND state = '[XX]' to narrow the search, or set sql to null and ask the user which state they mean.]`;
    },
  },
  {
    name: "nibrs-offense-code-confusion",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;

      // "theft" should use 23A-23H range, not just one code
      if (/\b(?:theft|larceny|larcenies)\b/i.test(q) && !/auto|motor|vehicle|car\b/i.test(q)) {
        // Check if only one 23x code is used when the user asked for "theft" generally
        const theftCodes = sql.match(/'23[A-H]'/gi) || [];
        const uniqueCodes = [...new Set(theftCodes.map(c => c.toUpperCase()))];
        if (uniqueCodes.length === 1 && uniqueCodes[0] !== "'23H'") return true; // single subcode, not the catch-all
        if (uniqueCodes.length === 0 && !/23/i.test(sql)) return false; // no theft codes at all (different issue)
      }

      // "carjacking" should use a summary_carjacking_* table — raw offenses+property is wrong (except daily queries)
      if (/\bcarjack/i.test(q) && !/summary_carjacking_/i.test(sql)) return true;

      // "auto theft" / "motor vehicle theft" should be 240, NOT 23F
      if (/\b(auto|motor vehicle|car)\s*theft\b/i.test(q) && sql.includes("'23F'") && !sql.includes("'240'")) return true;

      // "vehicle burglary" / "theft from vehicle" should be 23F, NOT 240
      if (/\b(vehicle burglary|theft from (motor )?vehicle|TFMV)\b/i.test(q) && sql.includes("'240'") && !sql.includes("'23F'")) return true;

      return false;
    },
    message: (ctx) => {
      const q = ctx.question.toLowerCase();
      if (/\bcarjack/i.test(q)) {
        return "[SYSTEM: Carjacking is NOT offense code 240 (that's motor vehicle theft). Use summary_carjacking_monthly for carjacking counts/trends. For demographic breakdowns (race, sex, age, weapon), use summary_carjacking_victim_demographics, summary_carjacking_offender_demographics, or summary_carjacking_arrestee_demographics.]";
      }
      if (/\b(auto|motor vehicle|car)\s*theft\b/i.test(q)) {
        return "[SYSTEM: Auto/motor vehicle theft is offense code 240, NOT 23F. Code 23F is 'Theft From Motor Vehicle' (vehicle burglary), which is different from stealing the vehicle itself.]";
      }
      if (/\b(vehicle burglary|theft from (motor )?vehicle|TFMV)\b/i.test(q)) {
        return "[SYSTEM: Vehicle burglary / theft from motor vehicle is offense code 23F, NOT 240. Code 240 is motor vehicle theft (stealing the whole vehicle).]";
      }
      return "[SYSTEM: 'Theft' or 'larceny' in NIBRS spans codes 23A through 23H. Use the full range IN ('23A','23B','23C','23D','23E','23F','23G','23H') or use '23H' as the catch-all if only shoplifting. Do not use a single subcode when the user asked about theft generally.]";
    },
  },
  {
    name: "historical-ranking-no-type",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detects: ranking/listing queries on historical_agency that don't filter by type
      // Pattern: ORDER BY ... DESC/ASC with LIMIT, using historical_agency_crime, no type filter
      const usesAgencyTable = /\bhistorical_agency(?:_crime)?\b/i.test(sql);
      const hasRanking = /ORDER\s+BY\b/i.test(sql) && /\bLIMIT\b/i.test(sql);
      const hasTypeFilter = /\bha\.type\s*=/i.test(sql) || /\btype\s*=\s*'/i.test(sql);
      // Only fire for ranking queries (ORDER BY + LIMIT) without type filter
      // and where the SELECT returns agency names (it's a listing)
      const selectsAgency = /SELECT[\s\S]*?\bagency\b[\s\S]*?FROM/i.test(sql);
      return usesAgencyTable && hasRanking && selectsAgency && !hasTypeFilter;
    },
    message: () =>
      "Your ranking query on historical_agency doesn't include a type filter. Without AND ha.type = 'city', the results may include state police, university police, and county agencies mixed in with cities. Add AND ha.type = 'city' to the WHERE clause (or 'county' if the user asked about counties).",
  },
  {
    name: "nibrs-weapon-group-by-code",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: CASE on weapon_type with GROUP BY weapon_type (should group by alias)
      const hasCaseWeapon = /CASE[\s\S]+weapon_type[\s\S]+END\s+AS\s+(\w+)/i.test(sql);
      const groupsByRawCode = /GROUP\s+BY[\s\S]*?\bweapon_type\b/i.test(sql);
      return hasCaseWeapon && groupsByRawCode;
    },
    rewrite: (sql) => {
      // Extract the alias from CASE...END AS <alias>
      const aliasMatch = sql.match(/CASE[\s\S]+weapon_type[\s\S]+END\s+AS\s+(\w+)/i);
      if (!aliasMatch) return null;
      const alias = aliasMatch[1];
      // Replace GROUP BY ...weapon_type... with the alias
      const fixed = sql.replace(
        /(GROUP\s+BY\s+(?:[\s\S]*?,\s*)?)(?:\w+\.)?weapon_type\b/i,
        `$1${alias}`
      );
      return fixed !== sql ? fixed : null;
    },
  },
  // --- Historical: staffing query without zero filter or with future years ---
  {
    name: "historical-staffing-no-filter",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      const usesStaffing = /\bhistorical_staffing\b/i.test(sql);
      if (!usesStaffing) return false;
      return !/all_total\s*>\s*0/i.test(sql) && !/officer_total\s*>\s*0/i.test(sql);
    },
    message: () =>
      "Your staffing query does not filter out years with no data. In historical_staffing, a value of 0 means the agency did not report — NOT that they had zero officers. Add WHERE all_total > 0 (or AND all_total > 0) to exclude non-reporting years.",
  },
  // Detect single-agency historical time series without gap-fill CTE
  // --- Historical: hardcoded ORI code instead of name lookup ---
  {
    name: "historical-hardcoded-ori",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect ori = 'XX...' without joining historical_agency by name
      const hasHardcodedOri = /\bori\s*=\s*'[A-Z]{2}\d+'/i.test(sql);
      const joinsAgencyByName = /historical_agency\s+\w+[\s\S]*?\.agency\s*=/i.test(sql);
      return hasHardcodedOri && !joinsAgencyByName;
    },
    message: () =>
      "[SYSTEM: You hardcoded an ORI code in the SQL. NEVER guess ORI codes — they are often wrong. Always look up agencies by name: JOIN historical_agency ha ... WHERE ha.agency = '[name]' AND ha.state = '[st]'. Then use the ORI from the join.]",
  },
  {
    name: "historical-missing-gap-fill",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Only fire for single-agency queries over a year range
      const usesAgencyData = /\bhistorical_agency_crime\b|\bhistorical_staffing\b|\bhistorical_agency_clearance\b/i.test(sql);
      const hasYearRange = /year\s*(>=|BETWEEN)/i.test(sql) || /ORDER\s+BY.*year/i.test(sql);
      const hasGapFill = /WITH\s+(years|all_years|yr)/i.test(sql) || /UNION\s+ALL\s+SELECT\s+year\s*\+\s*1/i.test(sql);
      const isSingleAgency = /agency\s*=\s*'/i.test(sql) && !/GROUP\s+BY.*agency/i.test(sql);
      return usesAgencyData && hasYearRange && isSingleAgency && !hasGapFill;
    },
    message: () =>
      "Your query retrieves historical data for a single agency over a year range but does not use a recursive CTE to fill missing years. Many agencies have gaps in reporting — without gap-fill, the chart will misleadingly connect data across missing years. Use: WITH years AS (SELECT <start> AS year UNION ALL SELECT year + 1 FROM years WHERE year < <end>) SELECT y.year, ... FROM years y LEFT JOIN ... This ensures missing years appear as NULL/gaps in the chart.",
  },
  // NOTE: historical-staffing-left-join-nulls guardrail REMOVED.
  // LEFT JOIN with a years CTE is the CORRECT pattern for staffing queries —
  // it produces NULL values for missing years, which the chart renders as gaps.
  // The old guardrail was incorrectly telling the model to use INNER JOIN,
  // which silently skips missing years instead of showing gaps.
  {
    name: "nibrs-ne-gu-state-codes",
    tabs: ["nibrs"],
    match: (ctx) => /state\s*=\s*'(NE|GU)'/i.test(ctx.sql),
    rewrite: (sql) => {
      let fixed = sql.replace(/state\s*=\s*'NE'/gi, "state = 'NB'");
      fixed = fixed.replace(/state\s*=\s*'GU'/gi, "state = 'GM'");
      return fixed !== sql ? fixed : null;
    },
  },

  // --- Agency lookup instead of crime data ---
  {
    name: "agency-lookup-not-crime-data",
    tabs: ["current", "historical", "nibrs"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL only queries the agencies/lookup table, never actual crime data
      const onlyAgencyTable =
        (sql.includes("from agencies") || sql.includes("from historical_agency")) &&
        !sql.includes("agency_monthly") &&
        !sql.includes("agency_crime") &&
        !sql.includes("national_monthly") &&
        !sql.includes("state_national") &&
        !sql.includes("staffing") &&
        !sql.includes("clearance") &&
        // NIBRS summary/data tables
        !sql.includes("summary_") &&
        !sql.includes("incidents") &&
        !sql.includes("offenses") &&
        !sql.includes("victims") &&
        !sql.includes("offenders") &&
        !sql.includes("arrestees") &&
        !sql.includes("property");
      if (!onlyAgencyTable) return false;
      // Only fire if the user asked about crime data, not just "what agencies do you have"
      const asksCrimeData = /\b(crime|trend|murder|homicide|robbery|assault|burglary|theft|rate|stats|statistics|data|offenses?|violent|property|arrest|clearance|cleared)\b/i.test(ctx.question);
      return asksCrimeData;
    },
    message: (ctx) => {
      const geo = ctx.geos[0] || "the requested agency";
      if (ctx.tab === "nibrs") {
        return `[SYSTEM: You ran an agency lookup query but the user asked for actual crime data. Query a summary table instead — use summary_victim_city_monthly (person crimes) or summary_city_monthly (property crimes) filtered by ORI: WHERE ori IN (SELECT ori FROM agencies WHERE city = '${geo.toUpperCase()}' AND state = '...'). Do NOT return agency metadata when the user wants crime statistics.]`;
      }
      return `You ran an agency lookup query but the user asked for actual crime data. Query the crime data table directly — for Current Trends use agency_monthly WHERE agency = '${geo}'. For Historical use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${geo}' AND ha.type = 'city'. Do NOT return agency metadata when the user wants crime statistics.`;
    },
  },

  // --- Bare "Washington" ambiguity — must not silently assume DC or state ---
  {
    name: "washington-ambiguity",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question;
      // Bare "Washington" without DC/state/district qualifier
      const hasWashington = /\bWashington\b/i.test(q);
      if (!hasWashington) return false;
      // Explicit DC: "Washington, DC", "Washington DC", "DC", "District of Columbia"
      const isExplicitDC = /\bWashington\s*,?\s*D\.?C\.?|Washington\s+DC\b|\bD\.?C\.?\b|District\s+of\s+Columbia/i.test(q);
      // Explicit state: "Washington state", "Washington State"
      const isExplicitState = /\bWashington\s+[Ss]tate\b/i.test(q);
      // If neither explicit, it's ambiguous
      return !isExplicitDC && !isExplicitState;
    },
    override: (ctx) =>
      `"Washington" is ambiguous — did you mean **Washington, D.C.** (the city) or **Washington state**? Please clarify so I can query the right geography.`,
  },

  // --- Historical: city question answered with state-level data ---
  {
    name: "historical-city-got-state",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      // SQL uses the state_national table (not agency-level)
      const usesStateTable = sql.includes("historical_state_national");
      if (!usesStateTable) return false;
      // State names that should NOT trigger this guardrail
      const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;
      // Filter geos to exclude state names
      const cityGeos = ctx.geos.filter(g => !STATE_NAMES.test(g));
      // Explicit city name allowlist (not states)
      const q = ctx.question.toLowerCase();
      const CITY_NAMES = /\b(denver|houston|chicago|dallas|phoenix|seattle|portland|miami|atlanta|boston|detroit|memphis|nashville|austin|charlotte|columbus|cleveland|pittsburgh|cincinnati|orlando|tampa|minneapolis|milwaukee|new orleans|omaha|raleigh|oakland|sacramento|fresno|tucson|albuquerque|el paso|san antonio|san diego|san francisco|los angeles|philadelphia|baltimore|richmond|norfolk|durham|stockton|anchorage|honolulu|arlington|lubbock|garland|madison|reno|glendale|hialeah|chesapeake|south bend|springfield|jacksonville|kansas city|st\.?\s*louis|baton rouge)\b/i;
      const asksCityByName = cityGeos.length > 0 || CITY_NAMES.test(q);
      return asksCityByName;
    },
    message: (ctx) => {
      const STATE_NAMES = /\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington state|west virginia|wisconsin|wyoming|district of columbia|united states)\b/i;
      const cityGeos = ctx.geos.filter(g => !STATE_NAMES.test(g));
      const city = cityGeos[0] || "the requested city";
      return `The user asked about "${city}" but the SQL queries historical_state_national which has state-level data, not city-level. Use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${city}' AND ha.type = 'city' to get city-level data. Only fall back to state-level if the user explicitly asks for a state.`;
    },
  },

  // --- Historical: county/parish question answered with state-level data ---
  {
    name: "historical-county-got-state",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql.toLowerCase();
      const q = ctx.question;
      // SQL uses the state_national table
      if (!sql.includes("historical_state_national")) return false;
      // User asked about a specific county or parish
      const countyMatch = q.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish|Borough)\b/i);
      return !!countyMatch;
    },
    message: (ctx) => {
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish|Borough)\b/i);
      const countyName = countyMatch ? `${countyMatch[1]} ${countyMatch[2]}` : "the requested county";
      return `The user asked about "${countyName}" but the SQL queries historical_state_national which has state-level data, not county-level. Use historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ha.agency = '${countyName}' AND ha.type = 'county' to get county-level data. Only fall back to state-level if the user explicitly asks for a state.`;
    },
  },

  // ── SHR Guardrails ──────────────────────────────────────────────────

  {
    // --- Historical: county/parish name stripped from agency filter ---
    name: "historical-county-name-stripped",
    tabs: ["historical"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      // User said "X County" or "X Parish" but SQL has agency = 'X' without "County"/"Parish"
      // Match 1-3 capitalized words before County/Parish: "Alameda County", "Anne Arundel County", "East Baton Rouge Parish"
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      if (!countyMatch) return false;
      const placeName = countyMatch[1].trim();
      const suffix = countyMatch[2]; // "County" or "Parish"
      // Check if SQL has agency = 'PlaceName' without the suffix
      const hasStripped = new RegExp(`agency\\s*=\\s*'${placeName}'`, "i").test(sql) &&
        !new RegExp(`agency\\s*=\\s*'${placeName}\\s+${suffix}'`, "i").test(sql);
      return hasStripped;
    },
    rewrite: (sql, ctx) => {
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      if (!countyMatch) return null;
      const placeName = countyMatch[1].trim();
      const suffix = countyMatch[2];
      // Replace agency = 'PlaceName' with agency = 'PlaceName County/Parish'
      const pattern = new RegExp(`(agency\\s*=\\s*')${placeName}'`, "gi");
      const fixed = sql.replace(pattern, `$1${placeName} ${suffix.charAt(0).toUpperCase() + suffix.slice(1).toLowerCase()}'`);
      return fixed !== sql ? fixed : null;
    },
    message: (ctx) => {
      const countyMatch = ctx.question.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(County|Parish)\b/);
      const fullName = countyMatch ? `${countyMatch[1].trim()} ${countyMatch[2]}` : "the county/parish";
      return `[SYSTEM: The user asked about "${fullName}" but the SQL searches for the place name without "County"/"Parish". In the Historical database, county agencies are stored with the full name (e.g., 'Alameda County', 'Jefferson Parish'). Use agency = '${fullName}' AND type = 'county'.]`;
    },
  },
  {
    // --- Historical: Parish question but SQL uses type = 'city' ---
    name: "historical-parish-type-city",
    tabs: ["historical"],
    match: (ctx) => {
      return /\bparish\b/i.test(ctx.question) && /type\s*=\s*'city'/i.test(ctx.sql);
    },
    rewrite: (sql) => sql.replace(/type\s*=\s*'city'/gi, "type = 'county'"),
    message: () =>
      "[SYSTEM: The user asked about a Louisiana Parish, which is a county-type agency. Your SQL uses type = 'city' — change it to type = 'county'.]",
  },
  {
    name: "shr-victim-count-default",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Fires if counting from incidents without joining victims
      const countsIncidents = /COUNT\s*\(\s*\*\s*\)\s/i.test(sql) || /COUNT\s*\(\s*i\./i.test(sql);
      const joinsVictims = /JOIN\s+victims\b/i.test(sql);
      const asksForIncidents = /\bincident/i.test(ctx.question);
      return countsIncidents && !joinsVictims && !asksForIncidents;
    },
    message: () =>
      "[SYSTEM: SHR queries should count VICTIMS by default, not incidents. JOIN the victims table: FROM incidents i JOIN victims v ON v.incident_id = i.id, then COUNT(*) counts victims. Only count incidents if the user specifically asked for incidents.]",
  },
  {
    name: "shr-homicide-type-missing",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // If asking about murder but SQL doesn't filter homicide_type
      const asksMurder = /\b(murder|homicide|killing)\b/i.test(q) && !/\bmanslaughter\b/i.test(q);
      const hasTypeFilter = /homicide_type\s*=\s*'Murder'/i.test(sql);
      const hasCircFilter = /circumstance_group/i.test(sql);
      return asksMurder && !hasTypeFilter && !hasCircFilter;
    },
    message: () =>
      "[SYSTEM: When the user asks about murders/homicides, filter with WHERE homicide_type = 'Murder'. The SHR database also contains manslaughter records. Without this filter, results mix murder and manslaughter.]",
  },
  {
    name: "shr-offender-null-filter",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // If querying offender demographics without null filter
      const usesOffender = /\boff_race\b|\boff_sex\b|\boff_age/i.test(sql);
      const hasNullFilter = /off_\w+\s+IS\s+NOT\s+NULL/i.test(sql) || /off_race\s*!=\s*'Unknown'/i.test(sql);
      return usesOffender && !hasNullFilter;
    },
    message: () =>
      "[SYSTEM: You're querying offender demographics but haven't filtered out NULL/Unknown offenders. About 40% of SHR incidents have unknown offender data. Add WHERE off_race IS NOT NULL (or off_sex IS NOT NULL) to exclude cases where offender information was not recorded. IMPORTANT: Having offender demographics recorded does NOT mean the case was solved or cleared — this dataset does not measure clearances. Note that results reflect cases where offender information was recorded, not necessarily solved cases.]",
  },
  {
    name: "shr-group-column-required",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // If using detailed columns when group columns should be used
      // NOTE: relationship is EXCLUDED — relationship_group is broken (Girlfriend/Boyfriend = 'Known' not 'Family')
      // The prompt instructs the model to ALWAYS use CASE WHEN on detailed relationship column
      const usesDetailWeapon = /\bi\.weapon\b/i.test(sql) && !/weapon_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      const usesDetailCirc = /\bi\.circumstance\b/i.test(sql) && !/circumstance_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      return usesDetailWeapon || usesDetailCirc;
    },
    message: () =>
      "[SYSTEM: Use the _group columns (weapon_group, circumstance_group) instead of the detailed columns. The detailed columns have hundreds of values and produce messy results. Only use the detailed columns if the user explicitly asks for specific/detailed breakdowns. NOTE: For relationship, ALWAYS use CASE WHEN on the detailed relationship column to build custom groups (Intimate Partner, Other Family, etc.) — do NOT use relationship_group.]",
  },
  {
    name: "shr-relationship-group-used",
    tabs: ["shr"],
    match: (ctx) => {
      // Catch any use of relationship_group and redirect to CASE WHEN on detailed relationship
      return /relationship_group/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Do NOT use relationship_group — it misclassifies Girlfriend/Boyfriend as 'Known' instead of intimate partners. Use a CASE WHEN on the detailed relationship column instead: CASE WHEN i.relationship IN ('Wife','Husband','Common-Law Wife','Common-Law Husband','Girlfriend','Boyfriend','Ex-Wife','Ex-Husband','Homosexual Relationship') THEN 'Intimate Partner' WHEN i.relationship IN ('Mother','Father','Son','Daughter','Brother','Sister','In-Law','Stepfather','Stepmother','Stepson','Stepdaughter','Other Family') THEN 'Other Family' WHEN i.relationship IN ('Acquaintance','Friend','Neighbor','Other Known','Employer','Employee') THEN 'Other Known' WHEN i.relationship = 'Stranger' THEN 'Stranger' ELSE 'Unknown' END AS relationship_category. NOTE: The relationship column stores the VICTIM's role — include BOTH gendered forms (Wife AND Husband, Girlfriend AND Boyfriend, etc.) in the Intimate Partner group.]",
  },
  {
    name: "nibrs-county-in-city-query",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      const q = ctx.question.toLowerCase();
      // Detect city-level queries that join agencies but don't filter agency_type = 'City'
      const joinAgencies = /\bagencies\b/i.test(sql) && /\bcity\b/i.test(sql);
      const hasGroupBy = /GROUP\s+BY.*\bcity\b/i.test(sql);
      const filtersAgencyType = /agency_type\s*=\s*'City'/i.test(sql);
      const excludesCounty = filtersAgencyType ||
                              /pop_group\s+NOT\s+LIKE\s+'[89]%'/i.test(sql) ||
                              /pop_group\s+LIKE\s+'[1-7]%'/i.test(sql) ||
                              /pop_group\s+LIKE\s+'1%'/i.test(sql);
      const isCityQuery = /\bcit(y|ies)\b/i.test(q);
      return joinAgencies && hasGroupBy && !excludesCounty && isCityQuery;
    },
    message: () =>
      "[SYSTEM: County sheriff agencies share the same city name as city PDs in the agencies table (e.g., Harris County SO has city='HOUSTON'). Add: AND a.agency_type = 'City' to exclude county agencies from city rankings. Also add AND a.population > 0 to exclude sub-agencies.]",
  },
  // --- NIBRS: any city filter in agencies subquery without agency_type (auto-fix) ---
  {
    name: "nibrs-city-no-agency-type",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect: any reference to agencies table with a city = 'X' filter but no agency_type or pop_group
      const hasCityOnAgencies = /\bagencies\b/i.test(sql) && /\bcity\s*=\s*'[A-Z]/i.test(sql);
      if (!hasCityOnAgencies) return false;
      if (/agency_type\s*=/i.test(sql)) return false;
      if (/pop_group\s+LIKE\s+'[1-7]%'/i.test(sql)) return false;
      if (/ORDER\s+BY\s+pop(?:ulation|_group).*LIMIT\s+1/i.test(sql)) return false;
      if (/\bcounty\b|\bsheriff\b|\bparish\b/i.test(ctx.question)) return false;
      return true;
    },
    message: (ctx) => {
      const cityMatch = ctx.sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      const city = cityMatch ? cityMatch[1] : "the city";
      const stateMatch = ctx.sql.match(/state\s*=\s*'([A-Z]{2})'/i);
      const state = stateMatch ? stateMatch[1] : "??";
      const yearMatch = ctx.sql.match(/\byear\s*(?:=|>=|BETWEEN\s+)\s*(20\d{2})\b/);
      const year = yearMatch ? yearMatch[1] : String(new Date().getFullYear());
      return `[SYSTEM: Your query filters by city = '${city}' but does not isolate the primary city police department. Multiple agencies share the same city name (city PD, county sheriff, campus police, etc.). Unless the user asked for a specific non-city agency (university police, transit, airport, sheriff), select the primary city PD: ori = (SELECT ori FROM agencies WHERE city = '${city}' AND state = '${state}' AND agency_type = 'City' AND year = ${year} AND population > 0 ORDER BY population DESC LIMIT 1). If the user named a specific agency (e.g., "Portland Community College police"), look it up by name instead.]`;
    },
  },
  {
    name: "nibrs-ambiguous-city-no-state",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect city filter in agencies subquery without state filter
      const cityMatch = sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      if (!cityMatch) return false;
      const city = cityMatch[1].toUpperCase();
      const ambiguous = [
        "SPRINGFIELD", "PORTLAND", "COLUMBIA", "JACKSON", "COLUMBUS",
        "CLEVELAND", "RICHMOND", "MEMPHIS", "ARLINGTON", "ALBANY",
        "FAYETTEVILLE", "KANSAS CITY", "GREENVILLE", "HAMILTON",
        "JACKSONVILLE", "FRANKLIN", "CLINTON", "MARION", "CHESTER",
        "BURLINGTON", "BRISTOL",
      ];
      if (!ambiguous.includes(city)) return false;
      // Check if state is already filtered nearby
      const hasState = /state\s*=\s*'[A-Z]{2}'/i.test(sql);
      return !hasState;
    },
    message: (ctx) => {
      const cityMatch = ctx.sql.match(/city\s*=\s*'([A-Z][A-Z ]+)'/i);
      const city = cityMatch ? cityMatch[1] : "this city";
      return `[SYSTEM: "${city}" exists in multiple states. You MUST set sql to null and ask the user which state they mean. Do NOT assume a state — different Richmonds, Springfields, etc. have very different crime data. Return: {"sql": null, "explanation": "Which ${city} did you mean? Please specify the state (e.g., ${city}, VA).", "chartHint": "none", "xAxis": "", "yAxis": "", "title": ""}]`;
    },
  },
  {
    name: "shr-aggregate-in-where",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect COUNT/SUM in WHERE clause (should be in HAVING)
      const whereMatch = sql.match(/WHERE[\s\S]+?(?:GROUP\s+BY|ORDER\s+BY|LIMIT|$)/i);
      if (!whereMatch) return false;
      return /\b(COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(whereMatch[0]) && !/HAVING/i.test(whereMatch[0]);
    },
    message: () =>
      "[SYSTEM: You used an aggregate function (COUNT, SUM, etc.) in a WHERE clause. Aggregate functions cannot be used in WHERE — use HAVING instead. WHERE filters rows before grouping, HAVING filters after.]",
  },
  // --- SHR: OR-precedence bug in multi-agency queries ---
  {
    name: "shr-or-precedence",
    tabs: ["shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      // Detect pattern: (agency=X AND state=Y) OR (agency=X AND state=Y) AND homicide_type/year
      // without outer parentheses around the OR group
      const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:GROUP\s+BY|ORDER\s+BY|LIMIT|$)/i);
      if (!whereMatch) return false;
      const whereClause = whereMatch[1];
      // Has multiple OR branches AND a trailing AND that isn't inside the last OR branch
      const orCount = (whereClause.match(/\)\s*OR\s*\(/gi) || []).length;
      if (orCount < 1) return false;
      // Check if the last AND clause (homicide_type, year) is outside parentheses
      // Pattern: `) AND i.homicide_type` or `) AND i.year` without outer wrapping parens
      return /\)\s+AND\s+i\.(homicide_type|year)\b/i.test(whereClause) &&
        !/\(\s*\([\s\S]*\)\s*OR\s*\([\s\S]*\)\s*\)\s+AND/i.test(whereClause);
    },
    message: () =>
      "[SYSTEM: SQL has OR-precedence bug. When combining multiple agency conditions with OR, you MUST wrap ALL OR branches in outer parentheses before AND-ing with other filters. Wrong: `WHERE (a=1) OR (a=2) AND b=3` — the AND only applies to the last branch. Right: `WHERE ((a=1) OR (a=2)) AND b=3`.]",
  },
  // --- SHR: city query without agency_type filter for ambiguous names ---
  {
    name: "shr-city-no-type",
    tabs: ["shr"],
    match: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      if (sqlLower.includes("agency_type")) return false;
      const ambiguous = [
        "los angeles", "jacksonville", "nashville", "indianapolis",
        "baltimore", "houston", "san diego", "sacramento",
        "kansas city", "richmond", "el paso",
      ];
      return ambiguous.some((c) => sqlLower.includes(`'${c}'`));
    },
    message: (ctx) => {
      const sqlLower = ctx.sql.toLowerCase();
      const ambiguous = [
        "los angeles", "jacksonville", "nashville", "indianapolis",
        "baltimore", "houston", "san diego", "sacramento",
        "kansas city", "richmond", "el paso",
      ];
      const mentioned = ambiguous.filter((c) => sqlLower.includes(`'${c}'`));
      return `[SYSTEM: Query includes ${mentioned.join(", ")} which have both City police and County sheriff agencies with the same name. Add AND agency_type = 'City' to filter to the city police department only.]`;
    },
  },
  // ── Hard Override Guardrails (2026-06-02) ────────────────────────────
  // These return deterministic responses — no model retry.

  // #1: Gang → Felony Type mislabel (retry/rewrite, not override)
  {
    name: "shr-gang-felony-mislabel",
    tabs: ["shr"],
    match: (ctx) => /\bgang/i.test(ctx.question) && /circumstance_group\s*=\s*'Felony Type'/i.test(ctx.sql),
    message: () =>
      "[SYSTEM: You used circumstance_group = 'Felony Type' for a gang query. Felony Type means homicides during felonies (robbery, burglary, narcotics) — NOT gang activity. Use circumstance IN ('Gangland Killings', 'Juvenile Gang Killings') instead. Note in your explanation that these are narrowly defined FBI categories and likely undercount gang-related violence.]",
    rewrite: (sql) => {
      return sql.replace(
        /circumstance_group\s*=\s*'Felony Type'/gi,
        "i.circumstance IN ('Gangland Killings', 'Juvenile Gang Killings')"
      );
    },
  },

  // #2: SHR SUM(population) bad denominator
  {
    name: "shr-sum-population",
    tabs: ["shr"],
    match: (ctx) => /SUM\s*\(\s*(?:COALESCE\s*\(\s*)?(?:\w+\.)?population/i.test(ctx.sql),
    // Single-agency: auto-fix to AVG
    rewrite: (sql) => {
      // Single-agency = has agency = 'X' filter, GROUP BY may include year but not multiple agencies
      const hasAgencyFilter = /agency\s*=\s*'[^']+'/i.test(sql);
      const groupsByMultipleAgencies = /GROUP\s+BY\s+[^)]*\b(agency|state_name|i\.state)\b/i.test(sql) &&
        !/GROUP\s+BY\s+[^)]*\bagency\b[^,)]*$/i.test(sql); // GROUP BY agency alone is single-agency per-year
      const isSingleAgency = hasAgencyFilter && !groupsByMultipleAgencies;
      if (isSingleAgency) {
        return sql
          .replace(/SUM\s*\(\s*COALESCE\s*\(\s*((?:\w+\.)?population)\s*,\s*\d+\s*\)\s*\)/gi, "AVG($1)")
          .replace(/SUM\s*\(\s*((?:\w+\.)?population)\s*\)/gi, "AVG($1)");
      }
      return null;
    },
    // Multi-agency: hard override
    override: (ctx) => {
      const hasAgencyFilter = /agency\s*=\s*'[^']+'/i.test(ctx.sql);
      const groupsByMultipleAgencies = /GROUP\s+BY\s+[^)]*\b(agency|state_name|i\.state)\b/i.test(ctx.sql) &&
        !/GROUP\s+BY\s+[^)]*\bagency\b[^,)]*$/i.test(ctx.sql);
      const isSingleAgency = hasAgencyFilter && !groupsByMultipleAgencies;
      if (isSingleAgency) return null; // rewrite handles it
      return "SHR population data is per-agency and per-incident — summing it across multiple agencies produces unreliable rates. For aggregate murder rates, try the [Historical Library](/test?tab=historical) tab which has FBI statewide estimates. I can provide raw victim counts from SHR instead.";
    },
  },

  // #3: SHR non-homicide topic substitution
  {
    name: "shr-non-homicide-topic",
    tabs: ["shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const nonHomicide = /\b(robber(?:y|ies)|thefts?|larcen(?:y|ies)|burglar(?:y|ies)|assaults?|rapes?|sexual assault|auto theft|motor vehicle theft|drugs?|arrests?|staffing|officers?|sworn|personnel|shootings?|property crimes?|violent crimes?)\b/i.test(q);
      if (!nonHomicide) return false;
      const exempt = /\b(homicides?|murders?|kill|circumstance|felony murder|robbery-homicide|homicide during|victims of.*homicide)/i.test(q);
      if (exempt) return false;
      return sql.includes("incidents") || sql.includes("victims");
    },
    override: (ctx) => {
      const match = ctx.question.match(/\b(robber(?:y|ies)|thefts?|larcen(?:y|ies)|burglar(?:y|ies)|assaults?|rapes?|sexual assault|auto theft|motor vehicle theft|drugs?|arrests?|staffing|officers?|sworn|personnel|shootings?|property crimes?|violent crimes?)\b/i);
      const topic = match ? match[1] : "that topic";
      return `The Homicide Reports dataset contains only homicide data. For ${topic} data, try the [Current Trends](/test?tab=current) or [Historical Library](/test?tab=historical) tab.`;
    },
  },

  // #4: Drug type silent filter drop
  {
    name: "nibrs-drug-type-unavailable",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql.toLowerCase();
      const namesDrug = /\b(marijuana|cannabis|weed|cocaine|crack|heroin|meth|methamphetamine|fentanyl|opioids?|opiates?)\b/i.test(q);
      if (!namesDrug) return false;
      const usesSummary = sql.includes("summary_arrestee_demographics") || sql.includes("summary_drug_monthly");
      if (!usesSummary) return false;
      return !sql.includes("suspected_drug");
    },
    override: (ctx) => {
      const match = ctx.question.match(/\b(marijuana|cannabis|weed|cocaine|crack|heroin|meth|methamphetamine|fentanyl|opioids?|opiates?)\b/i);
      const drug = match ? match[1] : "that substance";
      return `NIBRS summary tables group all drug offenses under code 35A (Drug/Narcotic Violations) — they cannot isolate ${drug} specifically. I can provide total drug possession or drug violation counts, but not broken down by substance type.`;
    },
  },

  // #5: NIBRS shooting override
  {
    name: "nibrs-shooting-override",
    tabs: ["nibrs"],
    match: (ctx) => {
      if (!ctx.sql) return false;
      const q = ctx.question.toLowerCase();
      const asksShooting = /\b(shooting|shootings|nonfatal shooting|non-fatal shooting|shot\b)/i.test(q);
      if (!asksShooting) return false;
      // Exempt: user explicitly asks for firearm homicide/murder, proxy, or agg assault with firearm
      const exempt = /\b(firearm (murder|homicide)|gun (murder|homicide)|(murder|homicide).{0,15}firearm|closest proxy|approximate|aggravated assault.{0,10}firearm)\b/i.test(q);
      return !exempt;
    },
    override: () =>
      "NIBRS does not track 'shootings' as a category. The closest available data is aggravated assault victims involving a firearm, but this includes brandishing, pistol-whipping, and threats — not just victims who were shot. For dedicated shooting data, sources like the Gun Violence Archive may be more appropriate. If you'd like the firearm assault proxy, ask for 'aggravated assault victims involving a firearm.'",
  },

  // #7: SHR clearance hard override
  {
    name: "shr-clearance-override",
    tabs: ["shr"],
    match: (ctx) => /\b(clearance|cleared|solve[ds]?|unsolved|closure|close rate|cold case)\b/i.test(ctx.question),
    override: () =>
      "The Homicide Reports dataset does not track whether cases were solved or cleared. A **clearance** in FBI terminology means the case was resolved by arrest (suspect arrested, charged, and turned over for prosecution) or by exceptional means (offender identified but arrest prevented by circumstances outside law enforcement's control, such as the offender's death or victim's refusal to cooperate). A clearance does not necessarily mean a conviction. For clearance rate data, try the [Historical Library](/test?tab=historical) (agency-level clearance rates back to the 1960s) or the [NIBRS Explorer](/test?tab=nibrs) (incident-level clearance data from 1991).",
  },

  // User said "raw counts" / "no rolling" but SQL has rolling window
  {
    name: "rolling-window-user-said-raw",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const wantsRaw = /\b(raw counts?|raw numbers?|not rolling|no rolling|don'?t want rolling|not 12.?month|just monthly|just raw)\b/i.test(q);
      if (!wantsRaw) return false;
      return /ROWS\s+BETWEEN|PRECEDING\s+AND\s+CURRENT/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: The user explicitly asked for raw/non-rolling values, but your SQL contains a rolling window (ROWS BETWEEN ... PRECEDING). Remove the rolling window and return raw monthly or annual counts.]",
  },

  // Window LAG/LEAD filter-before-window bug
  {
    name: "window-lag-filter-before-window",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      if (!/\bLAG\s*\(|\bLEAD\s*\(/i.test(sql)) return false;
      // Check if a year filter and a LAG/LEAD appear in the same SELECT block
      // Bad: SELECT ... LAG(...) ... FROM ... WHERE year >= 2020
      // Good: WITH cte AS (SELECT ... LAG(...) FROM ...) SELECT * FROM cte WHERE year >= 2020
      // Heuristic: if the outermost query has both LAG and WHERE year, it's bad
      // Check for LAG/LEAD in the final SELECT (not inside a CTE)
      const ctePattern = /\bWITH\b[\s\S]*?\)\s*SELECT/i;
      if (ctePattern.test(sql)) {
        // Has CTEs — check if the final SELECT (after last `)` before `SELECT`) has LAG
        const lastSelect = sql.match(/\)\s*SELECT\s+([\s\S]*)$/i)?.[1] || "";
        if (/\bLAG\s*\(|\bLEAD\s*\(/i.test(lastSelect) && /\bWHERE\s+.*\byear\s*(?:>=|BETWEEN)\s*\d{4}/i.test(lastSelect)) {
          return true;
        }
        return false;
      }
      // No CTEs — simple query with LAG and WHERE year in same block
      return /\bWHERE\s+.*\byear\s*(?:>=|BETWEEN)\s*\d{4}/i.test(sql);
    },
    message: () =>
      "[SYSTEM: SQLite evaluates WHERE before window functions. Your LAG/LEAD window function is in the same SELECT block as a year filter — the prior-year rows are removed BEFORE LAG can look back, producing NULL. Use a 3-layer pattern: CTE 1 (raw data, no year filter) → CTE 2 (compute LAG/LEAD) → outer SELECT (WHERE year >= display start).]",
  },

  // #9: SQLite dialect guardrail
  {
    name: "sqlite-dialect-error",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(SUBSTRING_INDEX|DATEDIFF|DATE_TRUNC|ILIKE|DATE_FORMAT|NOW\(\)|CURDATE|INTERVAL\s+\d|CONVERT\s*\(|TOP\s+\d+\b(?!\s*\())/i.test(ctx.sql),
    message: () =>
      "[SYSTEM: Your SQL uses a function or syntax not supported by SQLite. SQLite does NOT support SUBSTRING_INDEX, DATEDIFF, DATE_TRUNC, ILIKE, DATE_FORMAT, NOW(), CURDATE, INTERVAL, CONVERT, or TOP N. Use SQLite equivalents: SUBSTR/INSTR for strings, strftime for dates, LIKE (case-insensitive by default) instead of ILIKE, LIMIT instead of TOP.]",
  },

  // #10: NIBRS ethnicity — guardrail REMOVED 2026-06-02, ethnicity column now live in all three
  // summary demographics tables (offender, arrestee, victim). Ethnicity values: H, N, U.

  // #11: Sub-city geography override
  {
    name: "sub-city-geography-override",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(zip\s*code|zip\s*\d|neighborhoods?|precincts?|police district|census tract|block group|ward\b|borough|communit(?:y|ies)|community area|apartment|complex)\b/i.test(ctx.question),
    override: (ctx) => {
      const match = ctx.question.match(/\b(zip\s*code|neighborhoods?|precincts?|police district|census tract|block group|ward|borough|communit(?:y|ies)|community area|apartment complex)\b/i);
      const geo = match ? match[1] : "that geographic level";
      return `This database is organized by law enforcement agency (city police departments and county sheriffs), not by ${geo}. Crime data is reported at the agency level, not broken down by sub-city geography. For neighborhood-level data, check the local police department's open data portal or CompStat reports.`;
    },
  },

  // #12: Juvenile/raw-table age query protection
  {
    name: "nibrs-age-raw-table",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      const asksAge = /\b(juveniles?|minors?|under\s*18|teens?|youth|by age|age group|elderly|seniors?|child|children)\b/i.test(q);
      if (!asksAge) return false;
      // Check if hitting raw tables
      const RAW = ["offenders", "victims", "arrestees", "offenses"];
      return RAW.some(t => new RegExp(`\\bFROM\\s+${t}\\b`, "i").test(sql) || new RegExp(`\\bJOIN\\s+${t}\\b`, "i").test(sql));
    },
    message: () =>
      "[SYSTEM: Your query uses raw tables (100M+ rows) for an age-based query. Use summary demographic tables instead: summary_victim_demographics, summary_offender_demographics, or summary_arrestee_demographics. These have an age_group column (0-12, 13-17, 18-24, 25-34, 35-44, 45-54, 55-64, 65+, Unknown). For juveniles, filter age_group IN ('0-12', '13-17'). Generate a NEW query using the appropriate summary table.]",
  },

  // #15: ORDER BY compound-query error
  {
    name: "order-by-column-mismatch",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: () => false, // Checked externally from DB error — see route.ts
    message: () =>
      "[SYSTEM: Your SQL has an ORDER BY column that doesn't exist in the result set. In SQLite compound queries (UNION, etc.), ORDER BY must reference output column names or positions, not table-qualified names. Use the column alias from the SELECT clause.]",
  },

  // #16: Court outcomes, immigration, policy covariates — out of scope
  {
    name: "out-of-scope-override",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b(prosecution|convicted|conviction|sentence[ds]?|incarcerat|prison population|jail population|fine[ds]?\b|fee[ds]?\b|bail|immigration status|illegal immigrant|undocumented|GARS|GVRS|gun violence restraining|red flag law|defendants?)\b/i.test(ctx.question),
    override: (ctx) => {
      const match = ctx.question.match(/\b(prosecution|conviction|sentence|incarceration|prison population|jail population|fines|fees|bail|immigration status|GARS|GVRS|gun violence restraining|red flag law|defendants?)\b/i);
      const topic = match ? match[1] : "that topic";
      return `This database tracks reported crime incidents, not court outcomes or policy data. It does not contain information about ${topic}. The data covers crime reports filed by law enforcement agencies — not what happens after arrest. I can provide clearance rates (whether a case was resolved by arrest or exceptional means), but not convictions, sentences, or other court outcomes.`;
    },
  },

  // --- Clearance evidence type queries (unsupported) ---
  {
    name: "nibrs-clearance-evidence-unavailable",
    tabs: ["nibrs"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const hasClearance = /\b(clearances?|cleared|solve[ds]?|unsolved)\b/i.test(q);
      const hasEvidence = /\b(evidence|video|camera|surveillance|dna|fingerprint|forensic|witness|footage|bodycam|body cam|cctv)\b/i.test(q);
      return hasClearance && hasEvidence;
    },
    override: () =>
      "NIBRS clearance data does not track what evidence was used to clear a case — video, surveillance footage, DNA, fingerprints, or witness testimony are not recorded. I can show clearance rates by offense type, or break clearances down by arrest vs. exceptional clearance, but not by evidence type.",
  },

  // --- Ranking query returned as time series ---
  {
    name: "ranking-as-time-series",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const q = ctx.question.toLowerCase();
      const sql = ctx.sql;
      // Question asks for a ranking
      const isRanking = /\b(top\s+\d+|highest|most|greatest|lowest|least|which\s+(cities|agencies|states|departments)\s+(have|had|has))\b/i.test(q);
      if (!isRanking) return false;
      // SQL groups by time columns (year, month) — producing a time series not a ranking
      const groupsByTime = /GROUP\s+BY[\s\S]*?\b(year|month)\b/i.test(sql);
      if (!groupsByTime) return false;
      // SQL does NOT have a ranking CTE/window or a reasonable LIMIT for a ranking
      // A ranking should have a small LIMIT (<=50) and NOT group by year+month
      const groupsByYearAndMonth = /GROUP\s+BY[\s\S]*?\byear\b[\s\S]*?\bmonth\b/i.test(sql);
      // If grouping by year AND month, it's a time series, not a ranking
      if (groupsByYearAndMonth) return true;
      // If grouping by year but also by city/agency/state, it's a per-entity time series — still wrong for a ranking
      const groupsByEntity = /GROUP\s+BY[\s\S]*?\b(city|agency|ori|state_name)\b/i.test(sql);
      if (groupsByEntity && /\byear\b/i.test(sql.match(/GROUP\s+BY([\s\S]*?)(?:ORDER|LIMIT|HAVING|$)/i)?.[1] || "")) return true;
      return false;
    },
    message: () =>
      "[SYSTEM: The user asked for a ranking (top N, highest, most, etc.) but your SQL returns a time series grouped by year/month. Rankings should return ONE ROW PER ENTITY with the aggregate metric. Remove year/month from GROUP BY, aggregate across the full time range, and ORDER BY the metric DESC with an appropriate LIMIT. Do NOT return monthly breakdowns for ranking queries.]",
  },

  // --- Raw race/sex codes without CASE mapping ---
  {
    name: "nibrs-unmapped-race-codes",
    tabs: ["nibrs"],
    match: (ctx) => {
      const sql = ctx.sql;
      // SELECT has a raw race or sex column (d.race, a.race, v.race, etc.) without CASE WHEN mapping
      const selectClause = sql.match(/SELECT\s+([\s\S]*?)\s+FROM/i)?.[1] || "";
      const hasRawRace = /\b\w+\.race\b/i.test(selectClause) && !/CASE/i.test(selectClause);
      const hasRawSex = /\b\w+\.sex\b/i.test(selectClause) && !/CASE/i.test(selectClause);
      return hasRawRace || hasRawSex;
    },
    message: () =>
      "[SYSTEM: Your SQL returns raw race codes (W, B, I, A, P, U) or sex codes (M, F, U) without mapping to readable names. ALWAYS use CASE WHEN: CASE race WHEN 'W' THEN 'White' WHEN 'B' THEN 'Black' WHEN 'I' THEN 'American Indian' WHEN 'A' THEN 'Asian' WHEN 'P' THEN 'Pacific Islander' ELSE 'Unknown' END AS race. For sex: CASE sex WHEN 'M' THEN 'Male' WHEN 'F' THEN 'Female' ELSE 'Unknown' END AS sex. Also GROUP BY the CASE expression or its alias, not the raw column.]",
  },

  // --- #1: Missing GROUP BY year on aggregate + year SELECT ---
  {
    name: "missing-group-by-year",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => {
      const sql = ctx.sql;
      const sqlLower = sql.toLowerCase();
      // SELECT includes year
      const selectsYear = /SELECT[\s\S]*?\byear\b[\s\S]*?FROM/i.test(sql);
      if (!selectsYear) return false;
      // Has aggregate function
      const hasAggregate = /\b(SUM|COUNT|AVG|MIN|MAX)\s*\(/i.test(sql);
      if (!hasAggregate) return false;
      // No GROUP BY at all, or GROUP BY without year
      const hasGroupByYear = /GROUP\s+BY[\s\S]*?\byear\b/i.test(sql);
      if (hasGroupByYear) return false;
      // Exclude window functions (SUM(...) OVER (...))
      if (/\bOVER\s*\(/i.test(sql)) return false;
      // Exclude subqueries that intentionally return scalar aggregates
      // Only fire on the outermost query — if the main FROM is a CTE/subquery, skip
      if (/\bFROM\s*\(/i.test(sqlLower)) return false;
      return true;
    },
    rewrite: (sql) => {
      // Insert GROUP BY year before ORDER BY or LIMIT or end of query
      const insertPoint = sql.match(/\b(ORDER\s+BY|LIMIT)\b/i);
      if (insertPoint && insertPoint.index) {
        return sql.slice(0, insertPoint.index) + "GROUP BY year " + sql.slice(insertPoint.index);
      }
      return sql + " GROUP BY year";
    },
  },

  // --- #2: Double table-alias dot (i.i.column → i.column) ---
  {
    name: "double-alias-dot",
    tabs: ["current", "historical", "nibrs", "shr"],
    match: (ctx) => /\b([a-zA-Z_]\w*)\.\1\./g.test(ctx.sql),
    rewrite: (sql) => {
      const fixed = sql.replace(/\b([a-zA-Z_]\w*)\.\1\./g, "$1.");
      return fixed !== sql ? fixed : null;
    },
  },
];

/* ------------------------------------------------------------------ */
/*  Runner                                                             */
/* ------------------------------------------------------------------ */

/**
 * Run all guardrails for the given tab and return results.
 * Auto-rewrites are applied first; then issues are collected for Claude retry.
 */
export function runGuardrails(ctx: QueryContext): GuardrailResult {
  let sql = ctx.sql;
  const fired: string[] = [];
  const issues: string[] = [];
  let overrideResponse: string | null = null;
  let overrideGuardrail: string | null = null;

  // Pass 1: rewrites — update sql, build effective context
  for (const g of GUARDRAILS) {
    if (!g.tabs.includes(ctx.tab)) continue;
    const effectiveCtx = { ...ctx, sql };
    if (!g.match(effectiveCtx)) continue;

    fired.push(g.name);

    if (g.rewrite) {
      const rewritten = g.rewrite(sql, effectiveCtx);
      if (rewritten) {
        sql = rewritten;
        console.log(`[guardrail][${g.name}] Auto-rewrote SQL`);
      }
    }

    if (g.message) {
      issues.push(g.message(effectiveCtx));
    }
  }

  // Pass 2: overrides — evaluated against post-rewrite SQL
  const postRewriteCtx = { ...ctx, sql };
  for (const g of GUARDRAILS) {
    if (!g.tabs.includes(ctx.tab)) continue;
    if (!g.override) continue;
    if (!g.match(postRewriteCtx)) continue;

    const resp = g.override(postRewriteCtx);
    if (resp) {
      overrideResponse = resp;
      overrideGuardrail = g.name;
      if (!fired.includes(g.name)) fired.push(g.name);
      console.log(`[guardrail][${g.name}] Hard override — skipping retry`);
      break; // first override wins
    }
  }

  return {
    fired,
    issues,
    sql,
    needsFix: issues.length > 0,
    overrideResponse,
    overrideGuardrail,
  };
}
