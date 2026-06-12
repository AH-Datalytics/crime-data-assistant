import type { PromptHistoryMessage } from "./chat-history";

export type FollowupBreakdown = "state" | "city" | "agency";

export interface FollowupTransform {
  name: "add_breakdown" | "add_continuous_reporting_filter";
  dimension?: FollowupBreakdown;
  instruction: string;
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

function requestedContinuousReportingFilter(question: string): boolean {
  return /\b(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question) ||
    /\b(?:agenc(?:y|ies)|reporters?)\s+that\s+reported\s+every\s+year\b/i.test(question) ||
    /\breported\s+(?:all\s+)?(?:12\s+)?months\s+every\s+year\b/i.test(question) ||
    /\ball\s+12\s+months\s+(?:in|for)\s+every\s+year\b/i.test(question) ||
    /\badjust(?:ed)?\s+for\s+incomplete\s+coverage\b/i.test(question) ||
    /\binclude\s+(?:only\s+)?(?:continuous(?:ly)?|consistent(?:ly)?)\s+(?:reporting\s+)?(?:agenc(?:y|ies)|reporters?)\b/i.test(question);
}

export function detectFollowupTransform(question: string, history: PromptHistoryMessage[]): FollowupTransform | null {
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
