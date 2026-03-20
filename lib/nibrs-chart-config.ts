import type { ChartConfig } from "./types";
import type { ClaudeResponse } from "./nibrs-claude";

export const NIBRS_CHART_COLORS = [
  "#4682b4",
  "#dc143c",
  "#2d4a7a",
  "#228b22",
  "#ff8c00",
  "#8b008b",
  "#20b2aa",
  "#cd853f",
  "#6a5acd",
  "#b22222",
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
  const yAxisCandidates = claude.yAxis
    .split(",")
    .map((s) => s.trim())
    .filter((s) => columns.includes(s));

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
