import type { ChartConfig } from "./types";
import type { ClaudeResponse } from "./nibrs-claude";

export const NIBRS_CHART_COLORS = [
  "#2d5f8a",   // deep blue — authoritative lead
  "#c23b22",   // brick red
  "#3a7d44",   // forest
  "#d4882c",   // amber
  "#7b5ea7",   // muted purple
  "#5a8a8a",   // teal
  "#b85842",   // terracotta
  "#4a6fa5",   // slate blue
  "#8b6e4e",   // warm brown
  "#6b7b3a",   // olive
];

export function buildNibrsChartConfig(
  claude: ClaudeResponse,
  columns: string[],
  rows: Record<string, unknown>[]
): ChartConfig | null {
  if (
    claude.chartHint === "none" ||
    !claude.sql ||
    rows.length === 0
  ) {
    return null;
  }

  // Validate xAxis exists
  const xAxis = columns.includes(claude.xAxis)
    ? claude.xAxis
    : columns[0];

  // Parse and validate yAxis
  const yAxisCandidates = (claude.yAxis || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && columns.includes(s));

  // If no valid y columns, try to find numeric columns
  const yAxis =
    yAxisCandidates.length > 0
      ? yAxisCandidates
      : columns.filter((c) => {
          if (c === xAxis) return false;
          const val = rows[0]?.[c];
          return typeof val === "number";
        });

  if (yAxis.length === 0) return null;

  // Determine chart type
  let type = claude.chartHint as ChartConfig["type"];

  // If too many categories for pie, switch to bar
  if (type === "pie" && rows.length > 10) {
    type = "bar";
  }

  // Single row = no chart
  if (rows.length <= 1 && type !== "pie") {
    return null;
  }

  const config: ChartConfig = {
    type,
    xAxis,
    yAxis,
    title: claude.title || "Results",
  };
  if (claude.colors && claude.colors.length > 0) config.colors = claude.colors;
  if (claude.yAxisLabel) config.yAxisLabel = claude.yAxisLabel;
  if (claude.xAxisLabel) config.xAxisLabel = claude.xAxisLabel;
  if (claude.annotations && claude.annotations.length > 0) config.annotations = claude.annotations;
  return config;
}
