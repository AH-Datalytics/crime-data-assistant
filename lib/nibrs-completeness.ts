export type NibrsCompletenessStatus = "complete" | "partial" | "absent" | "unknown";
export type NibrsCompletenessUnit = "count" | "rate";

export type NibrsCompletenessDecision = {
  status: NibrsCompletenessStatus;
  display: boolean;
  partial: boolean;
  reason: string;
};

export const NIBRS_COUNT_COMPLETENESS_DISCLOSURE =
  "Historical counts are left blank unless the agency reported all 12 months; current-year partial counts remain visible when summary data exists and are disclosed as partial.";

export const NIBRS_COMPLETENESS_PROXY_DISCLOSURE =
  "Months reported are inferred from months containing reported offenses, so this conservative rule can suppress a complete small-agency year with a genuinely offense-free month.";

export const NIBRS_RECENT_MATURATION_DISCLOSURE =
  "Recent annual totals may still change as agencies submit revisions.";

export function decideNibrsCompleteness(args: {
  year: number;
  currentYear: number;
  reportingMonths: number | null;
  summaryMonths?: number | null;
  unit: NibrsCompletenessUnit;
}): NibrsCompletenessDecision {
  const reportingMonths = args.reportingMonths ?? 0;
  const summaryMonths = args.summaryMonths ?? 0;
  if (reportingMonths === 12) {
    return { status: "complete", display: true, partial: false, reason: "All 12 reporting months are present." };
  }
  if (args.year === args.currentYear && (reportingMonths > 0 || summaryMonths > 0)) {
    if (args.unit === "count") {
      return { status: "partial", display: true, partial: true, reason: "Current-year summary activity is present." };
    }
    return { status: "partial", display: false, partial: true, reason: "Rates require a complete 12-month year." };
  }
  if (reportingMonths > 0 || summaryMonths > 0) {
    return { status: "partial", display: false, partial: true, reason: "Historical reporting is incomplete." };
  }
  return { status: "absent", display: false, partial: false, reason: "No reporting evidence is present." };
}

export function nibrsAnnualValueSql(args: {
  yearExpression: string;
  reportingMonthsExpression: string;
  summaryMonthsExpression?: string;
  valueExpression: string;
  unit: NibrsCompletenessUnit;
  currentYear?: number;
}): string {
  const currentYear = args.currentYear ?? new Date().getFullYear();
  if (args.unit === "rate") {
    return `CASE WHEN ${args.reportingMonthsExpression} = 12 THEN ${args.valueExpression} ELSE NULL END`;
  }
  const summary = args.summaryMonthsExpression ?? "0";
  return `CASE WHEN ${args.reportingMonthsExpression} = 12 OR (${args.yearExpression} = ${currentYear} AND (COALESCE(${args.reportingMonthsExpression}, 0) > 0 OR COALESCE(${summary}, 0) > 0)) THEN ${args.valueExpression} ELSE NULL END`;
}

export function nibrsDemographicCompletenessPredicate(
  oriExpression: string,
  yearExpression: string,
  currentYear = new Date().getFullYear()
): string {
  return `(${yearExpression} = ${currentYear} OR EXISTS (
      SELECT 1
      FROM nibrs_agency_completeness AS completeness INDEXED BY idx_nac_ori_year
      WHERE completeness.ori = ${oriExpression}
        AND completeness.year = ${yearExpression}
        AND completeness.months_reported = 12
    ))`;
}
