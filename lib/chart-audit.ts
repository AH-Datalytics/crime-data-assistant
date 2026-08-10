import { createHash, randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { detectAndPivotChartData } from "./chart-layout";
import type { ChartConfig } from "./types";

export const CHART_AUDIT_MAX_ROWS = 200;
export const CHART_AUDIT_MAX_COLUMNS = 25;
export const CHART_AUDIT_MAX_BYTES = 64 * 1024;
export const CHART_AUDIT_MAX_STRING = 300;

export type ChartAuditSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
export type ChartAuditStatus = "verified-rendered" | "incorrect" | "needs-review" | "unverified";
export type ChartScalar = string | number | boolean | null;

export interface ChartAuditArtifact {
  requestId: string;
  source: ChartAuditSource;
  createdAt: number;
  chartConfig: ChartConfig;
  columns: string[];
  rows: Record<string, ChartScalar>[];
  rowCount: number;
  columnCount: number;
  capturedRowCount: number;
  capturedColumnCount: number;
  dataHash: string;
  truncated: boolean;
  truncationReason: string | null;
}

export interface ChartRenderReceipt {
  requestId: string;
  component: "ChartPanel" | "NibrsChartPanel";
  chartType: ChartConfig["type"];
  effectiveXKey: string;
  effectiveYKeys: string[];
  lineCount: number;
  barCount: number;
  pointCount: number;
  areaCount: number;
  legendLabels: string[];
  xTickLabels: string[];
  yTickLabels: string[];
  svgWidth: number;
  svgHeight: number;
  overflow: boolean;
  zeroSize: boolean;
  invalidText: boolean;
  renderError: boolean;
  viewportClass: "narrow" | "desktop";
  renderedAt: number;
}

export interface ChartAuditResult {
  status: ChartAuditStatus;
  summary: string;
  findings: string[];
}

function scalar(value: unknown, capString: boolean): ChartScalar {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return capString ? value.slice(0, CHART_AUDIT_MAX_STRING) : value;
  return String(value).slice(0, CHART_AUDIT_MAX_STRING);
}

function canonicalRows(rows: Record<string, unknown>[], columns: string[]): string {
  return JSON.stringify(rows.map((row) => {
    const normalized: Record<string, ChartScalar> = {};
    for (const key of columns) normalized[key] = scalar(row[key], false);
    return normalized;
  }));
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function createChartAuditRequestId(): string {
  return randomUUID();
}

export function buildChartAuditArtifact(input: {
  requestId?: string;
  source: ChartAuditSource;
  chartConfig: ChartConfig;
  columns: string[];
  rows: Record<string, unknown>[];
  createdAt?: number;
}): ChartAuditArtifact {
  const allColumns = [...new Set(input.columns.filter((column) => typeof column === "string" && column.length > 0))];
  const dataHash = createHash("sha256").update(canonicalRows(input.rows, allColumns)).digest("hex");
  const columns = allColumns.slice(0, CHART_AUDIT_MAX_COLUMNS);
  const captured: Record<string, ChartScalar>[] = [];
  const reasons = new Set<string>();
  if (allColumns.length > columns.length) reasons.add("column-limit");
  if (input.rows.length > CHART_AUDIT_MAX_ROWS) reasons.add("row-limit");

  for (const sourceRow of input.rows.slice(0, CHART_AUDIT_MAX_ROWS)) {
    const row: Record<string, ChartScalar> = {};
    for (const column of columns) row[column] = scalar(sourceRow[column], true);
    if (byteLength([...captured, row]) > CHART_AUDIT_MAX_BYTES) {
      reasons.add("byte-limit");
      break;
    }
    captured.push(row);
  }

  return {
    requestId: input.requestId ?? createChartAuditRequestId(),
    source: input.source,
    createdAt: input.createdAt ?? Date.now(),
    chartConfig: input.chartConfig,
    columns,
    rows: captured,
    rowCount: input.rows.length,
    columnCount: allColumns.length,
    capturedRowCount: captured.length,
    capturedColumnCount: columns.length,
    dataHash,
    truncated: reasons.size > 0 || captured.length !== input.rows.length,
    truncationReason: reasons.size > 0 ? [...reasons].join(",") : null,
  };
}

function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function clearanceMismatch(question: string, artifact: ChartAuditArtifact): string | null {
  if (!/clearance/i.test(question) || !/(?:by\s+type|arrest|exceptional|not\s+cleared)/i.test(question)) return null;
  const rows = artifact.rows;
  const keys = artifact.columns;
  const totalKey = keys.find((key) => /^(?:total_?)?(?:offenses?|murders?)$/i.test(key) || normalizedKey(key) === "total_offenses");
  const arrestKey = keys.find((key) => /cleared.*arrest|arrest.*clear/i.test(key));
  const notClearedKey = keys.find((key) => /not.*clear/i.test(key));
  if (!totalKey || !arrestKey) return null;

  const sourceRow = rows.find((row) => (numeric(row[totalKey]) ?? 0) > 0 && (numeric(row[arrestKey]) ?? 0) >= 0);
  if (!sourceRow) return null;
  const total = numeric(sourceRow[totalKey]);
  const arrest = numeric(sourceRow[arrestKey]);
  if (total === null || arrest === null) return null;
  const exceptionalKeys = keys.filter((key) => /death.*offender|prosecution.*declin|extradition.*deni|victim.*refus|juvenile.*court|exceptional/i.test(key));
  const exceptional = exceptionalKeys.reduce((sum, key) => sum + (numeric(sourceRow[key]) ?? 0), 0);
  const expected = total - arrest - exceptional;
  if (expected <= 0) return null;

  const direct = notClearedKey ? rows.map((row) => numeric(row[notClearedKey])).find((value) => value !== null) : null;
  const labelKey = keys.find((key) => rows.some((row) => /not\s+cleared/i.test(String(row[key] ?? ""))));
  const labelRow = labelKey ? rows.find((row) => /not\s+cleared/i.test(String(row[labelKey] ?? ""))) : null;
  const plottedKey = artifact.chartConfig.yAxis[0];
  const plotted = labelRow ? numeric(labelRow[plottedKey]) : null;
  if ((direct === null || direct === 0) && (plotted === null || plotted === 0)) {
    return `Expected Not cleared (${expected}), but the returned chart data omitted that numeric value or represented it as zero.`;
  }
  return null;
}

export function auditChartArtifact(question: string, artifact: ChartAuditArtifact, receipt?: ChartRenderReceipt | null): ChartAuditResult {
  const findings: string[] = [];
  const columnSet = new Set(artifact.columns);
  if (!columnSet.has(artifact.chartConfig.xAxis)) findings.push(`The configured X axis '${artifact.chartConfig.xAxis}' is absent from the returned columns.`);
  for (const key of artifact.chartConfig.yAxis) {
    if (!columnSet.has(key)) findings.push(`The configured series '${key}' is absent from the returned columns.`);
  }
  const mismatch = clearanceMismatch(question, artifact);
  if (mismatch) findings.push(mismatch);
  if (artifact.chartConfig.yAxis.length === 0) findings.push("The chart has no configured numeric series.");
  if (artifact.rows.length > 0 && artifact.chartConfig.yAxis.every((key) => artifact.rows.every((row) => numeric(row[key]) === null))) {
    findings.push("None of the configured chart series contains numeric values.");
  }
  if (findings.length > 0) return { status: "incorrect", summary: findings[0], findings };
  if (artifact.truncated) {
    return { status: "unverified", summary: "Chart data exceeded the audit capture limits, so the complete rendered values could not be verified.", findings: [] };
  }
  if (!receipt) {
    return { status: "unverified", summary: "Chart data and configuration were captured, but no browser render receipt was received.", findings: [] };
  }
  if (receipt.renderError || receipt.zeroSize || receipt.invalidText) {
    const renderFindings = [
      receipt.renderError ? "The browser reported a chart render error." : "",
      receipt.zeroSize ? "The rendered chart had zero width or height." : "",
      receipt.invalidText ? "The rendered chart contained NaN or undefined text." : "",
    ].filter(Boolean);
    return { status: "incorrect", summary: renderFindings[0], findings: renderFindings };
  }
  if (receipt.chartType !== artifact.chartConfig.type) {
    return { status: "incorrect", summary: `The browser rendered a ${receipt.chartType} chart instead of the configured ${artifact.chartConfig.type} chart.`, findings: [] };
  }
  if (receipt.effectiveXKey !== artifact.chartConfig.xAxis && receipt.effectiveXKey !== "_ym") {
    return { status: "needs-review", summary: "The browser rendered a different X field than the saved chart configuration.", findings: [] };
  }
  const pivoted = artifact.chartConfig.type === "scatter"
    ? { data: artifact.rows, effectiveYKeys: artifact.chartConfig.yAxis, seriesOverflow: false }
    : detectAndPivotChartData(artifact.rows, artifact.chartConfig.xAxis, artifact.chartConfig.yAxis);
  if (pivoted.seriesOverflow) {
    return { status: "incorrect", summary: "The chart exceeded the supported number of rendered series.", findings: [] };
  }
  if (JSON.stringify(receipt.effectiveYKeys) !== JSON.stringify(pivoted.effectiveYKeys)) {
    return { status: "incorrect", summary: "The series rendered in the browser do not match the series derived from the returned chart data.", findings: [] };
  }
  const expectedNonzero = pivoted.data.reduce((count, row) => count + pivoted.effectiveYKeys.filter((key) => {
    const value = numeric(row[key]);
    return value !== null && value !== 0;
  }).length, 0);
  const markProblem = artifact.chartConfig.type === "line" ? receipt.lineCount < pivoted.effectiveYKeys.length
    : artifact.chartConfig.type === "bar" || artifact.chartConfig.type === "stacked_bar" ? receipt.barCount < expectedNonzero
    : artifact.chartConfig.type === "pie" ? receipt.areaCount < expectedNonzero
    : artifact.chartConfig.type === "scatter" ? receipt.pointCount < expectedNonzero
    : false;
  if (markProblem) {
    return { status: "incorrect", summary: "The browser rendered fewer visible chart marks than the saved nonzero data requires.", findings: [] };
  }
  if (artifact.chartConfig.type !== "pie" && (receipt.xTickLabels.length === 0 || receipt.yTickLabels.length === 0)) {
    return { status: "needs-review", summary: "The chart rendered without visible labels on one or more axes.", findings: [] };
  }
  if (receipt.overflow) {
    return { status: "needs-review", summary: "The rendered plot or legend overflowed its visible chart container.", findings: [] };
  }
  return { status: "verified-rendered", summary: `${artifact.chartConfig.type === "bar" ? "Bar" : artifact.chartConfig.type.charAt(0).toUpperCase() + artifact.chartConfig.type.slice(1)} chart rendered with ${receipt.effectiveYKeys.length} series; no mismatch detected.`, findings: [] };
}

export function chartAuditSchemaAvailable(db: Database.Database): boolean {
  try {
    return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chart_audit_artifacts'").get());
  } catch {
    return false;
  }
}

export function persistChartAuditArtifact(db: Database.Database | null, artifact: ChartAuditArtifact, queryLogId?: number | bigint | null): boolean {
  if (!db || !chartAuditSchemaAvailable(db)) return false;
  try {
    db.prepare(`INSERT INTO chart_audit_artifacts (
      request_id, query_log_id, source, created_at, chart_config, columns_json, data_json,
      row_count, column_count, captured_row_count, captured_column_count, data_hash,
      truncated, truncation_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(request_id) DO UPDATE SET
      query_log_id=COALESCE(excluded.query_log_id, chart_audit_artifacts.query_log_id),
      source=excluded.source, created_at=excluded.created_at, chart_config=excluded.chart_config,
      columns_json=excluded.columns_json, data_json=excluded.data_json, row_count=excluded.row_count,
      column_count=excluded.column_count, captured_row_count=excluded.captured_row_count,
      captured_column_count=excluded.captured_column_count, data_hash=excluded.data_hash,
      truncated=excluded.truncated, truncation_reason=excluded.truncation_reason`)
      .run(
        artifact.requestId,
        queryLogId == null ? null : Number(queryLogId), artifact.source, artifact.createdAt,
        JSON.stringify(artifact.chartConfig), JSON.stringify(artifact.columns), JSON.stringify(artifact.rows),
        artifact.rowCount, artifact.columnCount, artifact.capturedRowCount, artifact.capturedColumnCount,
        artifact.dataHash, artifact.truncated ? 1 : 0, artifact.truncationReason,
      );
    return true;
  } catch (error) {
    console.warn("Chart audit artifact write failed:", error);
    return false;
  }
}

export function persistChartRenderReceipt(db: Database.Database | null, receipt: ChartRenderReceipt): boolean {
  if (!db || !chartAuditSchemaAvailable(db)) return false;
  try {
    const exists = db.prepare("SELECT 1 FROM chart_audit_artifacts WHERE request_id = ?").get(receipt.requestId);
    if (!exists) return false;
    db.prepare("INSERT OR REPLACE INTO chart_render_receipts (request_id, received_at, receipt_json) VALUES (?, ?, ?)")
      .run(receipt.requestId, Date.now(), JSON.stringify(receipt));
    return true;
  } catch (error) {
    console.warn("Chart render receipt write failed:", error);
    return false;
  }
}

export function attachChartAuditToPayload<T extends {
  chartConfig?: ChartConfig | null;
  columns?: string[];
  rows?: Record<string, unknown>[];
}>(payload: T, context: {
  source: ChartAuditSource;
  requestId: string;
  queryLogId?: number | null;
}): T & { requestId?: string } {
  if (!payload.chartConfig || !Array.isArray(payload.columns) || !Array.isArray(payload.rows) || payload.rows.length === 0) return payload;
  const artifact = buildChartAuditArtifact({
    requestId: context.requestId,
    source: context.source,
    chartConfig: payload.chartConfig,
    columns: payload.columns,
    rows: payload.rows,
  });
  try {
    // Dynamic import avoids making the shared database module depend on this audit module.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getWriteDb } = require("./rtci-db") as { getWriteDb: () => Database.Database | null };
    persistChartAuditArtifact(getWriteDb(), artifact, context.queryLogId);
  } catch (error) {
    console.warn("Chart audit capture failed:", error);
  }
  return { ...payload, requestId: context.requestId };
}
