import type { ChartConfig, QueryResponse } from "./types";

type ChartType = ChartConfig["type"];

function parseNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function chartTypeLabel(type: ChartType): string {
  return type === "stacked_bar" ? "stacked bar" : type;
}

export function extractChartType(question: string): ChartType | null {
  const patterns: [ChartType, RegExp][] = [
    ["stacked_bar", /\b(?:stacked\s+bar|stacked\s+column)\s+(?:chart|graph|plot)?\b/i],
    ["scatter", /\b(?:scatter(?:\s+plot)?|scatter\s+chart)\b/i],
    ["line", /\b(?:line|trend\s+line)\s+(?:chart|graph|plot)?\b/i],
    ["bar", /\b(?:bar|column)\s+(?:chart|graph|plot)?\b/i],
    ["pie", /\bpie\s+(?:chart|graph)?\b/i],
  ];
  for (const [type, pattern] of patterns) {
    if (pattern.test(question)) return type;
  }
  return null;
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

export function isChartTypeOnlyRequest(question: string): boolean {
  const chartType = extractChartType(question);
  if (!chartType) return false;
  const stripped = question
    .replace(/\b(?:show|display|make|change|switch|turn|convert|render|plot|graph|chart|this|that|it|the|as|into|to|a|an|please)\b/ig, " ")
    .replace(/\b(?:stacked\s+bar|stacked\s+column|scatter(?:\s+plot)?|scatter\s+chart|trend\s+line|line|bar|column|pie)\s*(?:chart|graph|plot)?\b/ig, " ")
    .replace(/[^\w]+/g, " ")
    .trim();
  return stripped.length === 0;
}

export function applyChartCustomizations(config: ChartConfig | null, question: string): ChartConfig | null {
  if (!config) return config;
  const yAxisMin = extractYAxisMin(question);
  const yAxisMax = extractYAxisMax(question);
  const chartType = extractChartType(question);
  if (yAxisMin === null && yAxisMax === null && chartType === null) return config;
  return {
    ...config,
    ...(chartType !== null ? { type: chartType } : {}),
    ...(yAxisMin !== null ? { yAxisMin } : {}),
    ...(yAxisMax !== null ? { yAxisMax } : {}),
  };
}

export function applyChartOnlyCustomization(question: string, response: QueryResponse | null): QueryResponse | null {
  if (!response?.chartConfig || (!isYAxisDomainOnlyRequest(question) && !isChartTypeOnlyRequest(question))) return null;
  const chartConfig = applyChartCustomizations(response.chartConfig, question);
  if (!chartConfig) return null;
  const min = chartConfig.yAxisMin;
  const max = chartConfig.yAxisMax;
  const chartType = extractChartType(question);
  if (min === undefined && max === undefined && chartType === null) return null;
  const changes: string[] = [];
  if (chartType !== null) changes.push(`to a ${chartTypeLabel(chartType)} chart`);
  if (min !== undefined && max !== undefined) changes.push(`with the Y-axis running from ${min} to ${max}`);
  else if (min !== undefined) changes.push(`with the Y-axis starting at ${min}`);
  else if (max !== undefined) changes.push(`with the Y-axis ending at ${max}`);
  const changeText = changes.join(" ");
  return {
    ...response,
    question,
    explanation: `Updated the chart ${changeText}.\n\n${response.explanation}`,
    chartConfig,
  };
}
