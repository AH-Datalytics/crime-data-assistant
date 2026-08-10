import type { PromptHistoryMessage } from "./chat-history";
import { asksForCountsInsteadOfRates } from "./rate-intent";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { OFFENSE_NOUN_RE } from "./query-bearing-followup";

export type FollowupBreakdown = "state" | "city" | "agency";

export interface FollowupTransform {
  name: "add_breakdown" | "add_continuous_reporting_filter" | "replace_with_dv_victim_demographics" | "replace_rate_with_count" | "resolve_county_scope" | "assess_trend" | "compare_geographies" | "replace_geography" | "change_time_range" | "change_granularity" | "change_offense" | "replace_count_with_rate" | "carry_cross_source_context" | "restrict_scope";
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
          `[SYSTEM: The user answered the county-scope clarifier: they want ONLY the county law-enforcement agency (sheriff's office) for their original question "${original}". Query the single county agency record, not a countywide rollup. For Historical, use historical_agency with type = 'county' and the canonical county agency name from the database (usually "Cook County" / "Maricopa County", NOT "Cook County Sheriff" unless that exact agency name exists). For Current, county agencies are stored without the suffix: agency = 'Maricopa' AND type = 'County'. For NIBRS/SHR, resolve a real county agency ORI/name first; do not search agencies.city = 'COOK COUNTY' or invent agency_type = 'Other'. If the source has no matching county agency record, say that directly and suggest countywide total or another source. Do NOT sum multiple agencies via the crosswalk and do NOT use state-level tables.]`,
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

export function hasPriorSql(history: PromptHistoryMessage[]): boolean {
  return history.some((msg) => msg.role === "assistant" && /\bSELECT\b[\s\S]+\bFROM\b/i.test(msg.content));
}

export function latestPriorUserQuestion(history: PromptHistoryMessage[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== "user") continue;
    const content = msg.content.trim();
    if (content && !content.startsWith("[SYSTEM:")) return content;
  }
  return null;
}

function requestedTrendAssessment(question: string): boolean {
  const q = question.trim();
  if (q.length > 140) return false;

  return /^(?:is|are|was|were)\s+(?:it|that|this|they|those)\s+(?:getting\s+)?(?:better|worse|higher|lower|rising|falling|improving|declining|up|down)\??$/i.test(q) ||
    /^(?:has|have)\s+(?:it|that|this|they|those)\s+(?:gotten|become|improved|declined|risen|fallen|increased|decreased)\b.*\??$/i.test(q) ||
    /^(?:which|what)\s+(?:is|was|were)\s+(?:higher|lower|worse|better)\??$/i.test(q);
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

/** Rebuild the prior question with its (single) place mention swapped for the
 *  new target. Falls back to an annotated form when splicing isn't safe. */
function replaceGeographyInQuestion(priorQuestion: string, target: string): string {
  const mentions = resolveGeoPlaces(priorQuestion).mentions;
  if (mentions.length === 1) {
    const m = mentions[0];
    return priorQuestion.slice(0, m.start) + target + priorQuestion.slice(m.end);
  }
  return `${priorQuestion.replace(/\?+\s*$/, "")} (for ${target} only — drop the previous geography)`;
}

/** "just clearances by type" / "only the counts" — a short fragment that
 *  restricts what the prior question returned. Deliberately does NOT require
 *  prior SQL: the prior turn may have failed to produce any (production 8375),
 *  yet the full user question is still in history and is what we rebuild from. */
function restrictiveFragment(question: string): string | null {
  const q = question.trim().replace(/\s+/g, " ");
  if (q.length > 80) return null;
  if (!/^(?:just|only|just\s+show(?:\s+me)?|show\s+only)\s+(?:the\s+)?.{3,}$/i.test(q)) return null;
  // Conversational asides, not data requests
  if (/\b(?:curious|kidding|joking|wondering|thanks|thank\s+you|checking|testing)\b/i.test(q)) return null;
  // A fragment that brings its own place AND its own offense is a complete
  // question that merely opens with "only" -- inheriting the prior question
  // would graft two unrelated asks together ("robberies in Chicago in 2024
  // (only murders in Dallas in 2025)"). One or the other is still a genuine
  // restriction: "only murders" narrows the prior geography's offense, and
  // "just clearances for Chicago" narrows the prior offense's geography.
  const namesPlace = resolveGeoPlaces(q).mentions.length > 0;
  if (namesPlace && OFFENSE_NOUN_RE.test(q)) return null;
  return q.replace(/\?+\s*$/, "");
}

export function detectFollowupTransform(question: string, history: PromptHistoryMessage[]): FollowupTransform | null {
  const countyScope = detectCountyScopeResolution(question, history);
  if (countyScope) return countyScope;

  // "what about <place>?" REPLACES the prior geography — same question, new
  // place (MS06). Users who want both say "compare to <place>", handled below.
  const replacementTarget = question.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i);
  if (replacementTarget && resolveGeoPlaces(replacementTarget[1]).mentions.length > 0 && hasPriorSql(history)) {
    const priorQuestion = latestPriorUserQuestion(history);
    if (priorQuestion) {
      const reconstructed = replaceGeographyInQuestion(priorQuestion, replacementTarget[1]);
      return {
        name: "replace_geography",
        contextQuestion: reconstructed,
        instruction: `[SYSTEM: This follow-up REPLACES the prior geography with "${replacementTarget[1]}". Reconstruct the complete question as "${reconstructed}". Preserve the prior source, offense/topic, filters, metric, granularity, and time range; do NOT include the previous geography in the SQL. Resolve the new geography through the source resolver. In the explanation, note that the previous location was replaced and that the user can say "compare them" to see both.]`,
      };
    }
  }

  const comparisonTarget = question.match(/^\s*compare\s+(?:(?:it|this|that|them)\s+)?(?:to|with|against)\s+(.+?)\s*\??\s*$/i);
  const targetResolvesAsPlace = comparisonTarget && resolveGeoPlaces(comparisonTarget[1]).mentions.length > 0;
  if (comparisonTarget && targetResolvesAsPlace && hasPriorSql(history)) {
    const priorQuestion = latestPriorUserQuestion(history);
    if (priorQuestion) {
      return {
        name: "compare_geographies",
        contextQuestion: `Compare ${priorQuestion} with ${comparisonTarget[1]}`,
        instruction: `[SYSTEM: This follow-up adds a comparison geography. Reconstruct the complete question as "Compare ${priorQuestion} with ${comparisonTarget[1]}". Preserve the prior source, offense/topic, filters, metric, and time range. Resolve every geography in the reconstructed question through the source resolver; do not use raw agency-name matching when a resolved ORI is available.]`,
      };
    }
  }

  if (asksForCountsInsteadOfRates(question) && hasPriorSql(history)) {
    return {
      name: "replace_rate_with_count",
      contextQuestion: `${question} (raw counts, not rates)`,
      instruction:
        "[SYSTEM: This follow-up replaces the prior rate/per-capita metric with raw counts or numbers. Preserve the prior dataset, geography, offense/topic, and time range unless the user explicitly changes them, but remove population joins, per-capita math, rate aliases, and rate-denominator requirements. Do not refuse because the prior query asked for a rate.]",
    };
  }

  if (requestedDomesticViolenceVictimDemographics(question) && hasPriorDomesticViolenceContext(history)) {
    return {
      name: "replace_with_dv_victim_demographics",
      instruction:
        "[SYSTEM: This follow-up replaces the prior domestic-violence metric with victim demographics. Do NOT preserve any prior per-capita/rate/population/denominator calculation, ranking metric, or summary_city_monthly join. Use summary_domestic_violence as the fact table. Preserve the prior year and geography when available. For a prior state-comparison question, group by dv.state plus victim demographics. Count distinct victims with COUNT(DISTINCT dv.ori || ':' || dv.data_year || ':' || dv.incident_num || ':' || dv.victim_sequence), not victim_count. Group by victim_sex, victim_race, and an age bucket derived from victim_age; treat non-numeric victim_age values as Unknown before casting. Do not ask for clarification unless the prior context has no year or geography at all.]",
    };
  }

  if (requestedTrendAssessment(question) && hasPriorSql(history)) {
    const priorQuestion = latestPriorUserQuestion(history);
    return {
      name: "assess_trend",
      contextQuestion: priorQuestion ? `${priorQuestion} (${question} trend assessment follow-up)` : `${question} (trend assessment follow-up)`,
      instruction:
        "[SYSTEM: This follow-up asks whether the prior result is improving, worsening, rising, falling, or which prior series is higher/lower. Do NOT answer with 'I cannot interpret trends' and do NOT ask the user to choose a metric. Preserve the prior dataset, geography, offense/topic, filters, metric, and requested range unless the user explicitly changes them. Generate a concrete SQL query that supports the trend assessment. If the prior result was monthly, aggregate it to annual totals by year; if it was already annual, keep annual totals. Prefer one row per year with the prior count/rate/share metric. The explanation MUST describe the returned data as annual totals/rates, not monthly data, when the SQL groups only by year. The explanation MUST include a direct directional sentence using the first and latest complete years, for example: 'Based on complete years, [metric] rose/fell from X in YYYY to Y in YYYY, a Z% increase/decrease.' Exclude incomplete current-year data from the main full-year better/worse comparison unless the user explicitly asked for YTD; if current partial-year data is returned, clearly label it as incomplete. If the prior context was fatal shootings or firearm homicides, preserve that as fatal shootings/firearm homicides with the firearm-homicide filter; do not refuse as if the user asked for broad or nonfatal shootings. State the direction modestly based only on the returned data.]",
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
  if (dimension && hasPriorSql(history)) {
    return {
      name: "add_breakdown",
      dimension,
      instruction:
        `[SYSTEM: This is a follow-up transformation. Preserve the prior query's dataset, offense/topic, filters, metric, time range, and chart intent unless the user explicitly changes them. Modify the prior query only to add a ${dimension} breakdown. Return rows grouped by ${dimension} plus the existing time dimension when present. For rolling/window calculations, keep the complete lead-in data in the inner CTE and add PARTITION BY ${dimension} to the window. Do not ask for clarification and do not switch datasets.]`,
    };
  }

  const fragment = restrictiveFragment(question);
  if (fragment) {
    const priorQuestion = latestPriorUserQuestion(history);
    if (priorQuestion) {
      const reconstructed = `${priorQuestion} (${fragment})`;
      return {
        name: "restrict_scope",
        contextQuestion: reconstructed,
        instruction: `[SYSTEM: This follow-up RESTRICTS the output of the prior question "${priorQuestion}" as requested by "${fragment}". Reconstruct the complete question as "${reconstructed}". Preserve the prior dataset, geography/places, filters, and time range exactly; change only which measures or columns are returned. Resolve every place through the source resolver and filter the fact table by the resolved agency identifiers; do not match agencies by city name when resolved identifiers are available. Do not ask for clarification.]`,
      };
    }
  }

  return null;
}
