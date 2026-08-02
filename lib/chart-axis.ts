export type PlainYearChartType = "line" | "bar";

/**
 * Plain-year lines use a continuous timeline. Bars must use a categorical
 * band axis so the first and last bar groups receive a full-width band inside
 * the plot instead of being centered on (and clipped by) numeric endpoints.
 */
export function plainYearXAxisProps(plainYears: boolean, chartType: PlainYearChartType) {
  if (!plainYears) return {};
  if (chartType === "bar") {
    return {
      type: "category" as const,
      allowDuplicatedCategory: false,
    };
  }
  return {
    type: "number" as const,
    domain: ["dataMin", "dataMax"] as [string, string],
    padding: { left: 8, right: 8 },
  };
}
