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
}

/* ------------------------------------------------------------------ */
/*  Guardrail definitions                                              */
/* ------------------------------------------------------------------ */

const GUARDRAILS: Guardrail[] = [
  // --- Current / Historical ---
  {
    name: "rate-no-population",
    tabs: ["current", "historical"],
    match: (ctx) =>
      ctx.isPerCapita && !ctx.sql.toLowerCase().includes("population"),
    message: () =>
      "The user asked for rates/per capita but the SQL does not join population data.",
  },
  {
    name: "unpivoted-comparison",
    tabs: ["current", "historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      return (
        /group by.*agency/i.test(sql) &&
        !/case\s+when/i.test(sql) &&
        (ctx.question.toLowerCase().includes(" and ") ||
          ctx.question.toLowerCase().includes(" vs ") ||
          ctx.question.includes(","))
      );
    },
    message: () =>
      "Multi-agency comparison appears unpivoted (no CASE WHEN). The frontend requires pivoted columns.",
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
      const offenseTerms: [RegExp, string[]][] = [
        [/\bmurder|homicide\b/i, ["'murder'", "'09a'"]],
        [/\brape\b/i, ["'rape'", "'11a'"]],
        [/\brobbery|robberies\b/i, ["'robbery'", "'120'"]],
        [/\bassault\b/i, ["'aggravated assault'", "'13a'"]],
        [/\bburglary|burglaries\b/i, ["'burglary'", "'220'"]],
        [/\btheft(?!.*auto|.*motor|.*vehicle)|larceny|larcenies\b/i, ["'theft'", "'23h'", "'larceny'"]],
        [/\bauto theft|motor vehicle theft|car theft|vehicle theft\b/i, ["'motor vehicle theft'", "'240'"]],
      ];
      for (const [pattern, sqlTerms] of offenseTerms) {
        if (
          pattern.test(ctx.question) &&
          !sqlTerms.some((t) => sqlLower.includes(t)) &&
          !sqlLower.includes("offense")
        ) {
          return true;
        }
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

      // Check for abbreviations the existing guardrail misses
      const abbrevs = /\b(LA|NYC|STL|ATL|NOLA|PHX|PHILLY|DFW|DMV|CHI|BMORE|MPLS|MSP|OKC|SLC|NYPD|LAPD|CPD|HPD|DPD|BPD|MPD)\b/i;
      if (abbrevs.test(ctx.question)) return true;

      // Check for geos extracted from question (leading city pattern)
      // but SQL has no agency filter
      if (ctx.geos.length > 0 && !sqlLower.includes("agency")) return true;

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
      // Detects: aggregating historical_agency_crime grouped by year with a state filter
      // but NOT selecting individual agencies (no agency column in SELECT)
      const usesAgencyTable = /\bhistorical_agency_crime\b/i.test(sql);
      const hasStateFilter = /\bha\.state\s*=\s*'[a-z]{2}'/i.test(sql);
      const groupsByYear = /GROUP\s+BY\s+(?:hac\.)?year/i.test(sql);
      const selectsAgency = /SELECT\s+[\s\S]*?\b(?:ha\.)?agency\b[\s\S]*?FROM/i.test(sql);
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
    message: () =>
      "[SYSTEM: Do NOT query raw tables (offenses, property, arrestees) for counts, sums, or trends — they have 100M+ rows and will time out. Use the appropriate summary table instead: summary_city_monthly or summary_state_monthly for offense counts, summary_victim_city_monthly or summary_victim_state_monthly for person crime victim counts, summary_drug_monthly for drug offenses, summary_carjacking_monthly for carjackings, summary_property_offense for property loss data, summary_arrestee_demographics for arrestee data, summary_offender_demographics for offender data, summary_offense_weapon for weapon data.]",
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
  {
    name: "historical-staffing-left-join-nulls",
    tabs: ["historical"],
    match: (ctx) => {
      const sql = ctx.sql;
      return /\bhistorical_staffing\b/i.test(sql) && /LEFT\s+JOIN\s+historical_staffing/i.test(sql);
    },
    message: () =>
      "Your staffing query uses LEFT JOIN which creates NULL rows for years with no data — these plot as zeroes on the chart. Either (1) use INNER JOIN instead of LEFT JOIN so only years with actual data appear, or (2) add WHERE officers IS NOT NULL (or WHERE hs.all_total > 0) after the JOIN to drop empty rows. Do NOT use a years CTE with LEFT JOIN — use INNER JOIN so only years the agency actually reported appear in the results.",
  },
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

  // ── SHR Guardrails ──────────────────────────────────────────────────

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
      const usesDetailWeapon = /\bi\.weapon\b/i.test(sql) && !/weapon_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      const usesDetailRelation = /\bi\.relationship\b/i.test(sql) && !/relationship_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      const usesDetailCirc = /\bi\.circumstance\b/i.test(sql) && !/circumstance_group/i.test(sql) && !/specific|detail|exact/i.test(q);
      return usesDetailWeapon || usesDetailRelation || usesDetailCirc;
    },
    message: () =>
      "[SYSTEM: Use the _group columns (weapon_group, relationship_group, circumstance_group) instead of the detailed columns. The detailed columns have hundreds of values and produce messy results. Only use the detailed columns if the user explicitly asks for specific/detailed breakdowns.]",
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

  for (const g of GUARDRAILS) {
    if (!g.tabs.includes(ctx.tab)) continue;
    if (!g.match(ctx)) continue;

    fired.push(g.name);

    // Apply auto-rewrite if available
    if (g.rewrite) {
      const rewritten = g.rewrite(sql, ctx);
      if (rewritten) {
        sql = rewritten;
        console.log(`[guardrail][${g.name}] Auto-rewrote SQL`);
      }
    }

    // Collect issue message for Claude retry
    if (g.message) {
      issues.push(g.message(ctx));
    }
  }

  return {
    fired,
    issues,
    sql,
    needsFix: issues.length > 0,
  };
}
