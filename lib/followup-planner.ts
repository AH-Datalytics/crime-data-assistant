import type { PromptHistoryMessage } from "./chat-history";
import { normalizeHistoryForTab } from "./chat-history";
import { buildQueryContract, type QueryContract } from "./query-contract";
import { isChartTypeOnlyRequest, isYAxisDomainOnlyRequest } from "./chart-customization";
import { autoRoute, parseIntent } from "./tab-suggest";
import { detectQueryBearingFollowup, type FollowupChangeKind, OFFENSE_NOUN_RE } from "./query-bearing-followup";
import { detectFollowupTransform, hasPriorSql, latestPriorUserQuestion, type FollowupTransform } from "./followup-transform";
import type { SourceId } from "./source-contracts";

export interface FollowupPlan {
  kind: "not_followup" | "query_bearing";
  source: SourceId;
  sourceChanged: boolean;
  reconstructedQuestion: string;
  priorQuestion: string | null;
  changeKinds: FollowupChangeKind[];
  transform: FollowupTransform | null;
  contract: QueryContract | null;
  timeRange: { startYear: number | null; endYear: number | null };
  granularity: "monthly" | "annual" | "unspecified";
  chartOnly: boolean;
  deterministicEligible: boolean;
  standaloneEligible: boolean;
}

function passthrough(question: string, source: SourceId): FollowupPlan {
  return {
    kind: "not_followup", source, sourceChanged: false, reconstructedQuestion: question,
    priorQuestion: null, changeKinds: [], transform: null, contract: null,
    timeRange: { startYear: null, endYear: null }, granularity: "unspecified",
    chartOnly: false, deterministicEligible: true, standaloneEligible: true,
  };
}

function synthesizeTransform(
  kinds: FollowupChangeKind[], question: string, priorQuestion: string,
): FollowupTransform | null {
  const clean = question.trim().replace(/\s+/g, " ");
  const preserve = "Preserve the prior query's dataset, geography, offense/topic, filters, metric, and chart intent unless the user explicitly changes them. Do not ask for clarification and do not answer with coverage metadata.";
  const base = `${priorQuestion} (${clean})`;
  if (kinds.includes("time_range")) return {
    name: "change_time_range", contextQuestion: base,
    instruction: `[SYSTEM: This follow-up changes ONLY the time range of the prior question "${priorQuestion}". Apply the new range from "${question}". ${preserve}]`,
  };
  if (kinds.includes("granularity")) return {
    name: "change_granularity", contextQuestion: base,
    instruction: `[SYSTEM: This follow-up changes ONLY the time granularity/windowing of the prior question "${priorQuestion}" as requested by "${question}" (including monthly versus annual or rolling windows over monthly rows). ${preserve}]`,
  };
  if (kinds.includes("offense")) {
    const target = question.match(/^\s*(?:what|how)\s+about\s+(.+?)\s*\??\s*$/i)?.[1]?.trim();
    const reconstructed = target && OFFENSE_NOUN_RE.test(target) ? priorQuestion.replace(OFFENSE_NOUN_RE, target) : base;
    return {
      name: "change_offense", contextQuestion: reconstructed,
      instruction: `[SYSTEM: This follow-up changes ONLY the offense/topic of the prior question "${priorQuestion}" as requested by "${question}". Preserve the prior geography, time range, metric, and granularity.]`,
    };
  }
  if (kinds.includes("metric")) return {
    name: "replace_count_with_rate", contextQuestion: base,
    instruction: `[SYSTEM: This follow-up changes ONLY the metric of the prior question "${priorQuestion}" as requested by "${question}". Preserve the prior geography, offense/topic, and time range.]`,
  };
  return null;
}

export function planFollowup(
  question: string, rawHistory: unknown, currentSource: SourceId,
): FollowupPlan {
  const history = normalizeHistoryForTab(rawHistory, currentSource);
  const transform = detectFollowupTransform(question, history);
  const bearing = detectQueryBearingFollowup(question, rawHistory);
  const chartOnly = (isChartTypeOnlyRequest(question) || isYAxisDomainOnlyRequest(question)) &&
    hasPriorSql(history);
  if (!transform && !bearing && !chartOnly) return passthrough(question, currentSource);

  const priorQuestion = latestPriorUserQuestion(history);
  const changeKinds = bearing?.kinds ?? [];
  const effectiveTransform = transform ??
    (priorQuestion ? synthesizeTransform(changeKinds, question, priorQuestion) : null);
  const reconstructedQuestion = effectiveTransform?.contextQuestion ??
    (priorQuestion ? `${priorQuestion} (${question.trim()})` : question);

  let source = currentSource;
  let sourceChanged = false;
  if (changeKinds.includes("offense") || changeKinds.includes("breakdown")) {
    const route = autoRoute(reconstructedQuestion);
    if (route && route.confidence === "high" && route.source !== currentSource) {
      source = route.source as SourceId;
      sourceChanged = true;
    }
  }

  const contract = buildQueryContract(reconstructedQuestion, source);
  const intent = parseIntent(reconstructedQuestion);
  return {
    kind: "query_bearing", source, sourceChanged, reconstructedQuestion,
    priorQuestion, changeKinds, transform: effectiveTransform, contract,
    timeRange: {
      startYear: contract?.time.startYear ?? null,
      endYear: contract?.time.endYear ?? null,
    },
    granularity: intent.granularity, chartOnly,
    deterministicEligible: false, standaloneEligible: false,
  };
}
