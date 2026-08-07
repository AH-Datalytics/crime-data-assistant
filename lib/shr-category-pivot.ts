const SHARE_INTENT_RE = /\b(?:share|percent(?:age)?|pct|proportion|ratio)\b|%/i;
const SHARE_COLUMN_RE = /(?:^|_)(?:pct|percent|percentage|share|proportion|ratio)(?:_|$)/i;

/**
 * Select the one measure a long-format SHR result should pivot.
 *
 * Query 8107 returned year, sex, total_victims, unknown_relationship and
 * pct_unknown. The old route blindly chose the first numeric column and turned a
 * requested share into total-victim counts. Explicit user share intent outranks
 * model chart metadata; otherwise honor one requested series. If several measures
 * remain ambiguous, do not pivot.
 */
export function selectShrPivotMetric(args: {
  question: string;
  columns: string[];
  rows: Record<string, unknown>[];
  categoryColumns: string[];
  requestedYAxis?: string[];
}): string | null {
  const { question, columns, rows, categoryColumns, requestedYAxis } = args;
  const candidates = columns.filter((column) =>
    column !== "year"
    && column !== "month"
    && !categoryColumns.includes(column)
    && rows.some((row) => typeof row[column] === "number")
  );
  if (candidates.length === 0) return null;

  if (SHARE_INTENT_RE.test(question)) {
    const shareColumns = candidates.filter((column) => SHARE_COLUMN_RE.test(column));
    if (shareColumns.length === 1) return shareColumns[0];
  }

  const requested = (requestedYAxis ?? []).filter((column) => candidates.includes(column));
  if (requested.length === 1) return requested[0];

  return candidates.length === 1 ? candidates[0] : null;
}
