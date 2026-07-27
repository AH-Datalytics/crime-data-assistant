/**
 * Source-neutral contracts for agency identity and reporting coverage.
 * Adapters own how these values are produced; routes own how they are enforced.
 */
export type SourceId = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

export type SourceResolutionStatus =
  | "resolved"
  | "ambiguous"
  | "covered"
  | "not_in_source"
  | "unsupported";

export type SourcePeriod =
  | { granularity: "year"; startYear: number; endYear: number }
  | { granularity: "month"; startMonth: string; endMonth: string };

export type SourceCompletenessStatus = "complete" | "partial" | "absent" | "unknown";

export type SourceCompletenessDecision = {
  status: SourceCompletenessStatus;
  display: boolean;
  partial: boolean;
  reason: string;
  period: SourcePeriod;
};
