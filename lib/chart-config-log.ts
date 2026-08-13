import { createHash } from "node:crypto";
import type { ChartConfig, ChartMeta } from "./types";

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
  /**
   * Digest of the annotation CONTENT -- label, value, and axis -- not just the count.
   *
   * Annotation bodies are still not stored (see the note at the call site): this is a
   * hash, so it leaks nothing while still binding what the chart asserts. Without it,
   * only `annotationCount` was recorded, and a shared chart could change an
   * annotation's position and its displayed claim while keeping the count identical --
   * and those labels render directly to the viewer in components/ChartPanel.tsx.
   */
  annotationsDigest?: string;
  /**
   * Digest of the chart METADATA -- source, agency count, population.
   *
   * These are rendered as factual claims beneath the chart, and on the embed path they
   * arrive entirely from the client and were never compared against anything. A valid
   * request id with matching SQL could therefore bless fabricated population or agency
   * figures. Hashed rather than stored for the same reason as annotations.
   */
  chartMetaDigest?: string;
  /** Set when a bound was hit, so a detector never mistakes truncation for the real shape. */
  truncated?: true;
}

/**
 * Stable digest over a canonical projection of a value.
 *
 * Field order is fixed by the projection rather than by object key order, so two
 * structurally identical inputs always hash the same.
 */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 16);
}

/** Fields of an annotation that a viewer actually sees. */
function annotationIdentity(annotation: unknown): unknown[] {
  const a = (annotation ?? {}) as Record<string, unknown>;
  return [
    typeof a.label === "string" ? a.label.slice(0, MAX_STRING) : null,
    typeof a.value === "number" || typeof a.value === "string" ? a.value : null,
    typeof a.axis === "string" ? a.axis : null,
    typeof a.type === "string" ? a.type : null,
  ];
}

/** Digest of an annotation list, or undefined when there are none. */
export function annotationsDigestOf(annotations: unknown): string | undefined {
  if (!Array.isArray(annotations) || annotations.length === 0) return undefined;
  return digest(annotations.slice(0, CHART_CONFIG_MAX_SERIES).map(annotationIdentity));
}

/** Digest of the chart metadata, or undefined when there is none. */
export function chartMetaDigestOf(chartMeta: ChartMeta | null | undefined): string | undefined {
  if (!chartMeta) return undefined;
  return digest([
    typeof chartMeta.source === "string" ? chartMeta.source : null,
    typeof chartMeta.agencyCount === "number" ? chartMeta.agencyCount : null,
    typeof chartMeta.population === "number" ? chartMeta.population : null,
  ]);
}

const str = (value: unknown): string => (typeof value === "string" ? value.slice(0, MAX_STRING) : "");
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * Returns a JSON string safe to store, or null when there is nothing to record
 * or anything at all goes wrong.
 */
export function serializeChartConfigForLog(
  chartConfig: ChartConfig | null | undefined,
  columns: string[] = [],
  /**
   * Chart metadata, when the caller has it.
   *
   * Optional so existing callers are unaffected; supplying it adds a digest that binds
   * the agency count and population a viewer is shown.
   */
  chartMeta?: ChartMeta | null
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
      // Annotation BODIES are still not stored -- they are narrative text and the most
      // likely place for stray content. The digest binds what they assert without
      // recording the text itself.
      payload.annotationCount = chartConfig.annotations.length;
      const annotations = annotationsDigestOf(chartConfig.annotations);
      if (annotations) payload.annotationsDigest = annotations;
    }
    const metaDigest = chartMetaDigestOf(chartMeta);
    if (metaDigest) payload.chartMetaDigest = metaDigest;
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
        // Digests survive the fallback: they are 16 characters each and they are the
        // binding. Dropping them here would mean a pathological chart config silently
        // becomes unbindable, which is the shape of every bypass in this stage.
        annotationCount: payload.annotationCount,
        annotationsDigest: payload.annotationsDigest,
        chartMetaDigest: payload.chartMetaDigest,
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
