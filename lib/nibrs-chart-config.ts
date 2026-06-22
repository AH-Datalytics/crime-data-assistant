import type { ChartConfig } from "./types";
import type { ClaudeResponse } from "./nibrs-claude";
import { detectYearSeriesChart } from "./chart-auto-detect";
import { applyChartCustomizations } from "./chart-customization";

export const NIBRS_CHART_COLORS = [
  "#2d5f8a",   // steel blue
  "#c4652a",   // copper
  "#2a8a5a",   // forest green
  "#8040a0",   // purple
  "#b8960a",   // gold
  "#c43838",   // crimson
  "#1a8a8a",   // teal
  "#6050b0",   // indigo
];

function asksScatter(question: string): boolean {
  return /\bscatter(?:\s+plot)?\b|\bplot\b[\s\S]{0,80}\bvs\.?\b|\bvs\.?\b[\s\S]{0,80}\bplot\b/i.test(question);
}

function numericColumns(columns: string[], rows: Record<string, unknown>[]): string[] {
  return columns.filter((column) => typeof rows[0]?.[column] === "number");
}

function isDimensionLikeNumericColumn(column: string): boolean {
  return /^(?:year|data_year|month|quarter|day|week)$/i.test(column);
}

export function buildNibrsChartConfig(
  claude: ClaudeResponse,
  columns: string[],
  rows: Record<string, unknown>[],
  question = ""
): ChartConfig | null {
  if (!claude.sql || rows.length === 0) {
    return null;
  }

  if (asksScatter(question)) {
    const numeric = numericColumns(columns, rows);
    if (numeric.length >= 2) {
      const requestedX = columns.includes(claude.xAxis) && typeof rows[0]?.[claude.xAxis] === "number"
        ? claude.xAxis
        : numeric[0];
      const requestedY = (claude.yAxis || "")
        .split(",")
        .map((s) => s.trim())
        .find((s) => columns.includes(s) && s !== requestedX && typeof rows[0]?.[s] === "number") || numeric.find((s) => s !== requestedX);
      if (requestedY) {
        claude = {
          ...claude,
          chartHint: "scatter",
          xAxis: requestedX,
          yAxis: requestedY,
        };
      }
    }
  }

  // Auto-detect chart type if Claude omitted chart fields or said "none".
  if (!claude.chartHint || claude.chartHint === "none") {
    const autoChart = detectYearSeriesChart(columns, rows);
    if (!autoChart) return null;
    claude = {
      ...claude,
      chartHint: autoChart.type,
      xAxis: autoChart.xAxis,
      yAxis: autoChart.yAxis.join(","),
    };
  }

  const xAxis = columns.includes(claude.xAxis)
    ? claude.xAxis
    : columns[0];

  const yAxisCandidates = (claude.yAxis || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && columns.includes(s));

  const yAxis =
    yAxisCandidates.length > 0
      ? yAxisCandidates
      : columns.filter((column) => {
          if (column === xAxis) return false;
          if (isDimensionLikeNumericColumn(column)) return false;
          return typeof rows[0]?.[column] === "number";
        });

  if (yAxis.length === 0) return null;

  let type = claude.chartHint as ChartConfig["type"];

  if (type === "pie" && rows.length > 10) {
    type = "bar";
  }

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
  return applyChartCustomizations(config, question);
}
