export interface QueryRequest {
  question: string;
}

export interface ChartConfig {
  type: "bar" | "line" | "pie" | "stacked_bar" | "none";
  xAxis: string;
  yAxis: string[];
  title: string;
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
