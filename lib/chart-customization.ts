import type { ChartConfig, QueryResponse } from "./types";

export function extractYAxisMin(question: string): number | null {
  const patterns = [
    /\b(?:start|set|begin|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:at|to|from)\s+(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?axis\s+(?:start|starts|starting|minimum|min)\s+(?:at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
    /\by[-\s]?min(?:imum)?\s*(?:=|at|to|from)?\s*(-?\d+(?:\.\d+)?)\s*%?/i,
  ];
  for (const pattern of patterns) {
    const match = question.match(pattern);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

export function isYAxisMinOnlyRequest(question: string): boolean {
  if (extractYAxisMin(question) === null) return false;
  const stripped = question
    .replace(/\b(?:start|set|begin|make|change|adjust)\s+(?:the\s+)?y[-\s]?axis\s+(?:at|to|from)\s+-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?axis\s+(?:start|starts|starting|minimum|min)\s+(?:at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\by[-\s]?min(?:imum)?\s*(?:=|at|to|from)?\s*-?\d+(?:\.\d+)?\s*%?/ig, " ")
    .replace(/\b(?:on|for|the|this|that|chart|graph|please)\b/ig, " ")
    .replace(/[^\w]+/g, " ")
    .trim();
  return stripped.length === 0;
}

export function applyChartCustomizations(config: ChartConfig | null, question: string): ChartConfig | null {
  if (!config) return config;
  const yAxisMin = extractYAxisMin(question);
  if (yAxisMin === null) return config;
  return { ...config, yAxisMin };
}

export function applyChartOnlyCustomization(question: string, response: QueryResponse | null): QueryResponse | null {
  if (!response?.chartConfig || !isYAxisMinOnlyRequest(question)) return null;
  const chartConfig = applyChartCustomizations(response.chartConfig, question);
  if (!chartConfig) return null;
  const min = chartConfig.yAxisMin;
  if (min === undefined) return null;
  return {
    ...response,
    question,
    explanation: `Updated the chart Y-axis to start at ${min}.\n\n${response.explanation}`,
    chartConfig,
  };
}
