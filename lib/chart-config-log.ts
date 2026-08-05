import type { ChartConfig } from "./types";

/**
 * Serializes the FINALIZED chart configuration for the query log, so the
 * cross-artifact auditor can compare what the chart claimed against what the
 * query returned.
 *
 * Design constraints, in priority order:
 *
 * 1. NEVER LEAK INTERNAL CONTENT. This is an allowlist, not a filter. Only the
 *    named fields below are copied; anything else on the object -- and anything
 *    that might later be attached to it -- is dropped by construction. A
 *    blacklist would have to be updated every time an upstream type grows a
 *    field, and would fail silently when someone forgot.
 * 2. FAIL OPEN. Chart capture is diagnostic. If serialization throws or exceeds
 *    the size cap, this returns null and the query still logs and still answers.
 *    Logging must never be able to break a user's response.
 * 3. BOUNDED. A pathological config (hundreds of series, huge annotations) must
 *    not bloat query_log or push the row over SQLite limits.
 *
 * `columns` is included deliberately: the detectors need the actual result column
 * names to tell whether a chart's axes reference columns the query really
 * returned. Column names are result metadata, not prompt or schema text.
 */

/** Matches the existing sql/response caps in logQuery. */
export const CHART_CONFIG_LOG_MAX_CHARS = 4000;
/** A legitimate chart never has this many series; beyond it we record the count only. */
export const CHART_CONFIG_MAX_SERIES = 40;
const MAX_COLUMNS = 60;
const MAX_STRING = 300;

export interface ChartConfigLogPayload {
  type: string;
  title: string;
  xAxis: string;
  yAxis: string[];
  seriesCount: number;
  columns: string[];
  columnCount: number;
  xAxisLabel?: string;
  yAxisLabel?: string;
  yAxisMin?: number;
  yAxisMax?: number;
  annotationCount?: number;
  /** Set when a bound was hit, so a detector never mistakes truncation for the real shape. */
  truncated?: true;
}

const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_STRING) : "");
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Returns a JSON string safe to store, or null when there is nothing to record
 * or anything at all goes wrong.
 */
export function serializeChartConfigForLog(
  chartConfig: ChartConfig | null | undefined,
  columns: string[] = []
): string | null {
  try {
    if (!chartConfig) return null;

    const rawSeries = Array.isArray(chartConfig.yAxis) ? chartConfig.yAxis.filter((s) => typeof s === "string") : [];
    const rawColumns = Array.isArray(columns) ? columns.filter((c) => typeof c === "string") : [];
    let truncated = false;

    const series = rawSeries.slice(0, CHART_CONFIG_MAX_SERIES).map(str);
    if (rawSeries.length > series.length) truncated = true;
    const cols = rawColumns.slice(0, MAX_COLUMNS).map(str);
    if (rawColumns.length > cols.length) truncated = true;

    const payload: ChartConfigLogPayload = {
      type: str(chartConfig.type) || "none",
      title: str(chartConfig.title),
      xAxis: str(chartConfig.xAxis),
      yAxis: series,
      // Counts are of the ORIGINAL arrays, so a detector sees the true shape
      // even when the stored lists were capped.
      seriesCount: rawSeries.length,
      columns: cols,
      columnCount: rawColumns.length,
    };

    const xAxisLabel = str(chartConfig.xAxisLabel);
    if (xAxisLabel) payload.xAxisLabel = xAxisLabel;
    const yAxisLabel = str(chartConfig.yAxisLabel);
    if (yAxisLabel) payload.yAxisLabel = yAxisLabel;
    const yMin = num(chartConfig.yAxisMin);
    if (yMin !== undefined) payload.yAxisMin = yMin;
    const yMax = num(chartConfig.yAxisMax);
    if (yMax !== undefined) payload.yAxisMax = yMax;
    if (Array.isArray(chartConfig.annotations) && chartConfig.annotations.length > 0) {
      // Annotation BODIES are not stored -- they are narrative text with no
      // auditing value, and they are the most likely place for stray content.
      payload.annotationCount = chartConfig.annotations.length;
    }
    if (truncated) payload.truncated = true;

    const encoded = JSON.stringify(payload);
    if (encoded.length > CHART_CONFIG_LOG_MAX_CHARS) {
      // Drop the unbounded parts rather than store a clipped, unparseable string.
      const minimal: ChartConfigLogPayload = {
        type: payload.type,
        title: payload.title,
        xAxis: payload.xAxis,
        yAxis: [],
        seriesCount: payload.seriesCount,
        columns: [],
        columnCount: payload.columnCount,
        truncated: true,
      };
      const fallback = JSON.stringify(minimal);
      return fallback.length <= CHART_CONFIG_LOG_MAX_CHARS ? fallback : null;
    }
    return encoded;
  } catch {
    // Fail open: diagnostics must never break logging or the response.
    return null;
  }
}

export function parseChartConfigLog(raw: string | null | undefined): ChartConfigLogPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as ChartConfigLogPayload;
  } catch {
    return null;
  }
}
