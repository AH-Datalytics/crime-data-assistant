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
