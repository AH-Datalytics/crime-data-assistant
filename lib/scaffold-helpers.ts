/**
 * Shared helpers for detecting and stripping internal scaffold text
 * that leaks from system prompts into user-facing responses.
 *
 * Used by both app/api/query/route.ts and app/api/nibrs-query/route.ts.
 */

const INTERNAL_SCAFFOLD_RE = /\bEntities in results\b/i;
const INTERNAL_LEAK_RES: RegExp[] = [INTERNAL_SCAFFOLD_RE, /\[SYSTEM:/i, /\b(?:historical_agency_population|historical_state_national|historical_agency_crime|historical_agency|agency_monthly|national_monthly|sample_agencies|agency_county_crosswalk|shr_agency_alias|summary_[a-z0-9_]+)\b/i, /\bSELECT\b[\s\S]{0,160}\bFROM\s+[a-z0-9]+_[a-z0-9_]+\b/i, /\bJOIN\s+[a-z0-9]+_[a-z0-9_]+\b/i, /\bROUND\s*\(/i, /\byAxisLabel\b|\bchartConfig\b|\bxAxisKey\b|\bdataKey\b/i, /\bReady for your question\b/i, /\bWhen you ask me\b/i];
export const INTERNAL_LEAK_SAFE_MESSAGE = "I was not able to interpret that as a follow-up to the previous answer. Please restate the question in one sentence with the place, offense, and date range you want."

export function containsInternalScaffold(
  value: string | null | undefined
): boolean {
  return INTERNAL_SCAFFOLD_RE.test(value || "");
}

export function containsInternalLeak(value: string | null | undefined): boolean {
  return INTERNAL_LEAK_RES.some((pattern) => pattern.test(value || ""));
}

export function stripInternalScaffold(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => !INTERNAL_SCAFFOLD_RE.test(line))
    .join("\n")
    .trim();
}
