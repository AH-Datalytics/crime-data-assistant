import type { ChartConfig, QueryResponse } from "./types";

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractYAxisMin(question: string): number | null {
  const patterns = [
    /\b(?:start|set|begin|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:at|to|from)\s+(-?\d+(?:\.\d+)?)\s*%?/i,
    /\b(?:set|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+(-?\d+(?:\.\d+)?)\s*%?\s+(?:to|and|-)\s+-?\d+(?:\.\d+)?\s*%?/i,
    /\by[-\s]?axis\s+(?:start|starts|starting|minimum|min)\s+(?:at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+(-?\d+(?:\.\d+)?)\s*%?\s+(?:to|and|-)\s+-?\d+(?:\.\d+)?\s*%?/i,
    /\by[-\s]?min(?:imum)?\s*(?:=|at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
    /\b(?:floor|bottom|lower\s+bound|minimum|min)\s*(?:of|for|on|at|to|=)?\s*(?:the\s+)?(?:y[-\s]?axis\s*)?(?:at|to|=)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const value = parseNumber(match[1]);
    if (value !== null) return value;
  }
  return null;
}

export function extractYAxisMax(question: string): number | null {
  const patterns = [
    /\b(?:set|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+-?\d+(?:\.\d+)?\s*%?\s+(?:to|and|-)\s+(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+-?\d+(?:\.\d+)?\s*%?\s+(?:to|and|-)\s+(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?axis\s+(?:end|ends|ending|maximum|max|ceiling|top)\s+(?:at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?max(?:imum)?\s*(?:=|at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
    /\b(?:ceiling|top|upper\s+bound|maximum|max)\s*(?:of|for|on|at|to|=)?\s*(?:the\s+)?(?:y[-\s]?axis\s*)?(?:at|to|=)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const value = parseNumber(match[1]);
    if (value !== null) return value;
  }
  return null;
}

export function isYAxisDomainOnlyRequest(question: string): boolean {
  if (extractYAxisMin(question) === null && extractYAxisMax(question) === null) return false;
  const stripped = question
    .replace(/\b(?:start|set|begin|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:at|to|from)\s+-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\b(?:set|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+-?\d+(?:\.\d+)?\s*%?\s+(?:to|and|-)\s+-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?axis\s+(?:start|starts|starting|minimum|min)\s+(?:at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?axis\s+(?:range\s+)?(?:from|between)\s+-?\d+(?:\.\d+)?\s*%?\s+(?:to|and|-)\s+-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?axis\s+(?:end|ends|ending|maximum|max|ceiling|top)\s+(?:at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?min(?:imum)?\s*(?:=|at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?max(?:imum)?\s*(?:=|at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\b(?:floor|bottom|lower\s+bound|minimum|min)\s*(?:of|for|on|at|to|=)?\s*(?:the\s+)?(?:y[-\s]?axis\s*)?(?:at|to|=)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\b(?:ceiling|top|upper\s+bound|maximum|max)\s*(?:of|for|on|at|to|=)?\s*(?:the\s+)?(?:y[-\s]?axis\s*)?(?:at|to|=)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\b(?:on|for|the|this|that|chart|graph|please|set|make|change|adjust|and|axis|range)\b/ig, " ")
    .replace(/[^\w]+/g, " ")
    .trim();
  return stripped.length === 0;
}

export const isYAxisMinOnlyRequest = isYAxisDomainOnlyRequest;

export function applyChartCustomizations(config: ChartConfig | null, question: string): ChartConfig | null {
  if (!config) return config;
  const yAxisMin = extractYAxisMin(question);
  const yAxisMax = extractYAxisMax(question);
  if (yAxisMin === null && yAxisMax === null) return config;
  return {
    ...config,
    ...(yAxisMin !== null ? { yAxisMin } : {}),
    ...(yAxisMax !== null ? { yAxisMax } : {}),
  };
}

export function applyChartOnlyCustomization(question: string, response: QueryResponse | null): QueryResponse | null {
  if (!response?.chartConfig || !isYAxisDomainOnlyRequest(question)) return null;
  const chartConfig = applyChartCustomizations(response.chartConfig, question);
  if (!chartConfig) return null;
  const min = chartConfig.yAxisMin;
  const max = chartConfig.yAxisMax;
  if (min === undefined && max === undefined) return null;
  const domainText =
    min !== undefined && max !== undefined
      ? `to run from ${min} to ${max}`
      : min !== undefined
        ? `to start at ${min}`
        : `to end at ${max}`;
  return {
    ...response,
    question,
    explanation: `Updated the chart Y-axis ${domainText}.\n\n${response.explanation}`,
    chartConfig,
  };
}
