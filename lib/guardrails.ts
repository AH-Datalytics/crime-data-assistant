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
        /agencies\s+WHERE.*'(USA|United States|UNITED STATES|National|NATIONAL)'/i.test(ctx.sql);
    },
    message: () =>
      "[SYSTEM: Do NOT look up 'USA' or 'United States' as a city or agency. For national totals, SUM across all states from the state-level summary table (summary_victim_state_monthly for person crimes, summary_state_monthly for property/society crimes). Do not filter by ori or city for national data.]",
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
