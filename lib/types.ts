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
