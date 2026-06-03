/**
 * Detect when a trend/time-series question returns only 1 row.
 * Returns a warning string if suspicious, null if OK.
 */
export function checkSingleRowTrend(
  question: string,
  rowCount: number
): string | null {
  if (rowCount !== 1) return null;

  // Only warn for time-series questions
  const isTrend = /\b(trends?|over time|since\s+\d{4}|from\s+\d{4}|last\s+\d+\s+years?|per year|yearly|year.over.year|monthly|by year|by month|time.?series|timeline)\b/i.test(question);
  if (!isTrend) return null;

  // Exempt intentional single-value queries
  const isSingleValue = /\b(total|how many|count|in\s+\d{4}\b|what is|what was|current)\b/i.test(question);
  if (isSingleValue) return null;

  return "Only one data point was returned for a time-series request. The query may be too narrowly filtered, or the agency/place may not have been found. Try specifying the exact city and state, or broaden the date range.";
}
