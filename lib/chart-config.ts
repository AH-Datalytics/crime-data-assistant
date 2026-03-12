import type { ChartConfig } from "./types";
import type { ClaudeResponse } from "./claude";

export const CHART_COLORS = [
  "#475EC7",   // medium blue
  "#E05A33",   // warm red-orange (high contrast with blue)
  "#01114B",   // dark navy
  "#2EA858",   // green
  "#002BD6",   // bright blue
  "#9B5DE5",   // purple
  "#6b7280",   // gray
  "#C5CDEE",   // light periwinkle
  "#D4A017",   // gold
  "#3a4db0",   // indigo
];

export function buildChartConfig(
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

  // Auto-adjust: if x-axis looks like years/months, use line
  const xValues = rows.map((r) => String(r[xAxis] ?? ""));
  const allYears = xValues.every((v) => /^\d{4}$/.test(v));
  const allYearMonths = xValues.every((v) => /^\d{6}$/.test(v));
  if ((allYears || allYearMonths) && type === "bar") {
    type = "line";
  }

  // If too many categories for pie, switch to bar
  if (type === "pie" && rows.length > 10) {
    type = "bar";
  }

  // Single row = no chart
  if (rows.length <= 1 && type !== "pie") {
    return null;
  }

  return {
    type,
    xAxis,
    yAxis,
    title: claude.title || "Results",
  };
}
