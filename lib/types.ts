export interface QueryRequest {
  question: string;
}

export interface ChartAnnotation {
  axis: "x" | "y";
  value: string | number;
  label?: string;
  color?: string;
}

export interface ChartConfig {
  type: "bar" | "line" | "pie" | "stacked_bar" | "scatter" | "none";
  xAxis: string;
  yAxis: string[];
  title: string;
  colors?: string[];
  yAxisLabel?: string;
  xAxisLabel?: string;
  yAxisMin?: number;
  yAxisMax?: number;
  annotations?: ChartAnnotation[];
}

export interface QueryResponse {
  success: true;
  requestId?: string;
  question: string;
  sql: string;
  explanation: string;
  title: string;
  columns: string[];
  /** Optional plain table headers for technical column names (display only; the CSV keeps the names). */
  columnLabels?: Record<string, string>;
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  chartConfig: ChartConfig | null;
  chartMeta: ChartMeta | null;
  executionTimeMs: number;
  sourceSwitch?: { source: string; question: string };
  scorecard?: boolean;
  agencyLabel?: string;
  year?: number | null;
  scope?: "agency" | "state" | "national";
  yearStatus?: "latest" | "fallback";
  statusText?: string;
  newerExcludedYear?: number | null;
  showClearance?: boolean;
}

export interface QueryError {
  success: false;
  error: string;
  sql?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  response?: QueryResponse;
  error?: string;
  loading?: boolean;
}

export interface ChartMeta {
  agencyCount: number;
  population: number | null;
  source?: string;
}

/**
 * Copy all chart/presentation metadata from a retry response onto the
 * working Claude response object.  Centralised here so every retry path
 * stays in sync — adding a new field to ClaudeResponse only needs one edit.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyRetryMeta(target: any, source: any): void {
  const KEYS = [
    "explanation", "chartHint", "xAxis", "yAxis", "title",
    "colors", "yAxisLabel", "xAxisLabel", "annotations",
  ];
  for (const k of KEYS) {
    target[k] = source[k];
  }
}

// SSE stream event types
export type StreamEvent =
  | { type: "status"; text: string }
  | { type: "explanation"; text: string; title: string }
  | {
      type: "result";
      requestId?: string;
      /** Server-only hint removed by sseEvent before the payload is sent. */
      chartAuditSource?: "current" | "historical";
      sql: string;
      explanation: string;
      title: string;
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
      truncated: boolean;
      chartConfig: ChartConfig | null;
      chartMeta: ChartMeta | null;
      executionTimeMs: number;
      sourceSwitch?: { source: string; question: string };
      scorecard?: boolean;
      agencyLabel?: string;
      year?: number | null;
      scope?: "agency" | "state" | "national";
      yearStatus?: "latest" | "fallback";
      statusText?: string;
      newerExcludedYear?: number | null;
      showClearance?: boolean;
    }
  | { type: "error"; text: string; sql?: string };
