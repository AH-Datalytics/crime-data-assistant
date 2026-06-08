export type AutoChartType = "bar" | "line";

export interface AutoChartConfig {
  type: AutoChartType;
  xAxis: "year";
  yAxis: string[];
}

export function detectYearSeriesChart(
  columns: string[],
  rows: Record<string, unknown>[]
): AutoChartConfig | null {
  if (rows.length <= 1 || !columns.includes("year")) return null;

  const numericCols = columns.filter((column) =>
    column !== "year" &&
    column !== "month" &&
    typeof rows[0]?.[column] === "number"
  );
  if (numericCols.length === 0) return null;

  const nonTimeNonNumericCols = columns.filter((column) =>
    column !== "year" &&
    column !== "month" &&
    !numericCols.includes(column)
  );
  if (nonTimeNonNumericCols.length > 0) return null;

  return {
    type: numericCols.length <= 3 ? "line" : "bar",
    xAxis: "year",
    yAxis: numericCols,
  };
}
