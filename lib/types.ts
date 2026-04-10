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
  type: "bar" | "line" | "pie" | "stacked_bar" | "none";
  xAxis: string;
  yAxis: string[];
  title: string;
  colors?: string[];
  yAxisLabel?: string;
  xAxisLabel?: string;
  annotations?: ChartAnnotation[];
}

export interface QueryResponse {
  success: true;
  question: string;
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
    }
  | { type: "error"; text: string; sql?: string };
