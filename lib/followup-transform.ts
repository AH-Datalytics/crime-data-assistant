import type { PromptHistoryMessage } from "./chat-history";

export type FollowupBreakdown = "state" | "city" | "agency";

export interface FollowupTransform {
  name: "add_breakdown" | "add_continuous_reporting_filter" | "replace_with_dv_victim_demographics" | "resolve_county_scope";
  dimension?: FollowupBreakdown;
  instruction: string;
  /** When set, routes should use this instead of the raw question for guardrail
   *  context extraction — bare answers like "Countywide total" carry no county
   *  name, so guardrails like countywide-crosswalk-required can't fire on them. */
  contextQuestion?: string;
}

/** Signature phrase of the county-scope clarifier (lib/county-clarifier.ts). */
const COUNTY_CLARIFIER_SIGNATURE = "countywide total (all law enforcement agencies";

function countyScopeAnswer(question: string): "countywide" | "sheriff" | null {
  const q = question.trim();
  if (q.length > 80) return null; // bare scope answers, not new full questions
  const countywide = /\b(county\s*-?\s*wide|countywide|all (?:law enforcement )?agencies|whole county|entire county|total across)\b/i.test(q);
  const sheriff = /\bsheriff\b|\bcounty (?:agency|police|record)\b/i.test(q);
  if (countywide && !sheriff) return "countywide";
  if (sheriff && !countywide) return "sheriff";
  return null;
}

/**
 * The user answered the county-scope clarifier ("Countywide total" / "Sheriff's
 * office only"). Recover the original county question from history and return
 * the transform. Without this, the model answered "Countywide total" with
 * STATE-level data — the county context lived only in history (MS02-S2, July 5).
 */
function detectCountyScopeResolution(question: string, history: PromptHistoryMessage[]): FollowupTransform | null {
  const scope = countyScopeAnswer(question);
  if (!scope) return null;

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "assistant" || !msg.content.toLowerCase().includes(COUNTY_CLARIFIER_SIGNATURE)) continue;
    for (let j = i - 1; j >= 0; j--) {
      if (history[j].role !== "user") continue;
      const original = history[j].content.trim();
      if (scope === "countywide") {
        return {
          name: "resolve_county_scope",
          contextQuestion: `${original} (countywide total across all agencies)`,
          instruction:
            `[SYSTEM: The user answered the county-scope clarifier: they want the COUNTYWIDE TOTAL for their original question "${original}". Sum across ALL law enforcement agencies mapped to the county via agency_county_crosswalk (county_key is the bare uppercase county/parish name without the County/Parish suffix). Do NOT use state-level tables (historical_state_national, summary_state_monthly, summary_victim_state_monthly) — this is a county question, not a state question. In the explanation, disclose that the countywide total sums all mapped reporting agencies and depends on each agency's reporting participation.]`,
        };
      }
      return {
        name: "resolve_county_scope",
        contextQuestion: `${original} (sheriff's office only)`,
        instruction:
          `[SYSTEM: The user answered the county-scope clarifier: they want ONLY the county law-enforcement agency (sheriff's office) for their original question "${original}". Query the single county agency record — for Historical use historical_agency with type = 'county' and the county agency name; on other tabs resolve the county agency's ORI. Do NOT sum multiple agencies via the crosswalk and do NOT use state-level tables.]`,
      };
    }
    return null;
  }
  return null;
}

function requestedBreakdown(question: string): FollowupBreakdown | null {
  if (!/\b(?:split|break|breakdown|break down|show|group)\b/i.test(question)) return null;
  if (!/\b(?:it|this|that|same|result|results|chart|data)\b/i.test(question)) return null;

  if (/\bby\s+state\b|\bout\s+by\s+state\b|\bstate[-\s]?level\b/i.test(question)) return "state";
  if (/\bby\s+cit(?:y|ies)\b|\bout\s+by\s+cit(?:y|ies)\b|\bcity[-\s]?level\b/i.test(question)) return "city";
  if (/\bby\s+agenc(?:y|ies)\b|\bout\s+by\s+agenc(?:y|ies)\b|\bagency[-\s]?level\b/i.test(question)) return "agency";

  return null;
}

function hasPriorSql(history: PromptHistoryMessage[]): boolean {
  return history.some((msg) => msg.role === "assistant" && /\bSELECT\b[\s\S]+\bFROM\b/i.test(msg.content));
}

function hasPriorDomesticViolenceContext(history: PromptHistoryMessage[]): boolean {
  return history.some((msg) =>
    /\bsummary_domestic_violence\b|\bdomestic\s+violence\b|\b(?<![a-z])dv(?![a-z])\b/i.test(msg.content)
  );
}

function requestedContinuousReportingFilter(question: string): boolean {
  return /\b(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question) ||
    /\b(?:agenc(?:y|ies)|reporters?)\s+that\s+reported\s+every\s+year\b/i.test(question) ||
    /\breported\s+(?:all\s+)?(?:12\s+)?months\s+every\s+year\b/i.test(question) ||
    /\ball\s+12\s+months\s+(?:in|for)\s+every\s+year\b/i.test(question) ||
    /\badjust(?:ed)?\s+for\s+incomplete\s+coverage\b/i.test(question) ||
    /\binclude\s+(?:only\s+)?(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question);
}

function requestedDomesticViolenceVictimDemographics(question: string): boolean {
  return /\bvictim\s+demographics\b/i.test(question) &&
    /\b(?:just|only|instead|rather|show|use|break(?:\s+it)?\s+down|demographics?)\b/i.test(question);
}

export function detectFollowupTransform(question: string, history: PromptHistoryMessage[]): FollowupTransform | null {
  const countyScope = detectCountyScopeResolution(question, history);
  if (countyScope) return countyScope;

  if (requestedDomesticViolenceVictimDemographics(question) && hasPriorDomesticViolenceContext(history)) {
    return {
      name: "replace_with_dv_victim_demographics",
      instruction:
        "[SYSTEM: This follow-up replaces the prior domestic-violence metric with victim demographics. Do NOT preserve any prior per-capita/rate/population/denominator calculation, ranking metric, or summary_city_monthly join. Use summary_domestic_violence as the fact table. Preserve the prior year and geography when available. For a prior state-comparison question, group by dv.state plus victim demographics. Count distinct victims with COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num || ':' || dv.victim_sequence), not victim_count. Group by victim_sex, victim_race, and an age bucket derived from victim_age; treat non-numeric victim_age values as Unknown before casting. Do not ask for clarification unless the prior context has no year or geography at all.]",
    };
  }

  if (requestedContinuousReportingFilter(question) && hasPriorSql(history)) {
    return {
      name: "add_continuous_reporting_filter",
      instruction:
        "[SYSTEM: This is a follow-up transformation. Preserve the prior query's dataset, offenses/topic, demographic breakdowns, metric, chart intent, and requested year range unless the user explicitly changes them. Modify the prior data query to restrict results to continuously reporting NIBRS agencies. Do NOT answer with an agency list or coverage metadata. Use ORI-level summary/detail tables, not state-level summary tables, because the completeness filter is agency-level. Prefer the precomputed range table: fact_alias.ori IN (SELECT ori FROM nibrs_consistent_reporters WHERE start_year = [start_year] AND end_year = [end_year]). An agency qualifies only if it reported all 12 months in every chosen year. If nibrs_consistent_reporters is unavailable, fall back to nibrs_agency_completeness with months_reported = 12 for every year: SELECT ori FROM nibrs_agency_completeness WHERE year BETWEEN [start_year] AND [end_year] AND months_reported = 12 GROUP BY ori HAVING COUNT(*) = [number_of_years]. If the previous query used summary_victim_state_monthly or summary_state_monthly, switch to summary_victim_city_monthly or summary_city_monthly as appropriate so ORI filtering is possible. In the explanation, say the result is restricted to agencies that reported all 12 months in every requested year; do not describe the returned rows as incomplete coverage or as cities.]",
    };
  }

  const dimension = requestedBreakdown(question);
  if (!dimension || !hasPriorSql(history)) return null;

  return {
    name: "add_breakdown",
    dimension,
    instruction:
      `[SYSTEM: This is a follow-up transformation. Preserve the prior query's dataset, offense/topic, filters, metric, time range, and chart intent unless the user explicitly changes them. Modify the prior query only to add a ${dimension} breakdown. Return rows grouped by ${dimension} plus the existing time dimension when present. For rolling/window calculations, keep the complete lead-in data in the inner CTE and add PARTITION BY ${dimension} to the window. Do not ask for clarification and do not switch datasets.]`,
  };
}
