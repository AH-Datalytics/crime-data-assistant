/**
 * Shared all-null column detection.
 *
 * Detects when a query returns rows but every non-dimension column
 * is NULL — typically caused by division-by-zero or broken math
 * in LLM-generated SQL.
 */

/** Columns that carry row identity, not data values */
const DIMENSION_COLS = new Set([
  "year", "month", "data_year",
  "agency", "agency_name", "city", "state", "state_abbr", "state_name",
  "offense", "offense_name", "ucr_offense_code",
  "type", "tab", "ori",
  "crime_type", "category",
  // SHR-specific
  "agency_type", "weapon_group", "circumstance_group",
  "relationship", "homicide_type",
]);

export interface AllNullResult {
  /** True if every data column is null across all rows */
  allNull: boolean;
  /** Column names identified as data (non-dimension) */
  dataCols: string[];
}

/**
 * Check whether all non-dimension columns in a result set are NULL.
 *
 * @param columns - Column names from the query result
 * @param rows - Result rows (array of objects)
 * @returns AllNullResult with detection flag and identified data columns
 */
export function detectAllNullData(
  columns: string[],
  rows: Record<string, unknown>[]
): AllNullResult {
  if (rows.length === 0 || columns.length < 2) {
    return { allNull: false, dataCols: [] };
  }

  const dataCols = columns.filter((c) => !DIMENSION_COLS.has(c));

  if (dataCols.length === 0) {
    return { allNull: false, dataCols: [] };
  }

  const allNull = dataCols.every((col) =>
    rows.every((r) => r[col] === null || r[col] === undefined)
  );

  return { allNull, dataCols };
}
