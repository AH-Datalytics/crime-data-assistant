import type { PromptHistoryMessage } from "./chat-history";

export type FollowupBreakdown = "state" | "city" | "agency";

export interface FollowupTransform {
  name: "add_breakdown";
  dimension: FollowupBreakdown;
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

export function detectFollowupTransform(question: string, history: PromptHistoryMessage[]): FollowupTransform | null {
  const dimension = requestedBreakdown(question);
  if (!dimension || !hasPriorSql(history)) return null;

  return {
    name: "add_breakdown",
    dimension,
    instruction:
      `[SYSTEM: This is a follow-up transformation. Preserve the prior query's dataset, offense/topic, filters, metric, time range, and chart intent unless the user explicitly changes them. Modify the prior query only to add a ${dimension} breakdown. Return rows grouped by ${dimension} plus the existing time dimension when present. For rolling/window calculations, keep the complete lead-in data in the inner CTE and add PARTITION BY ${dimension} to the window. Do not ask for clarification and do not switch datasets.]`,
  };
}
