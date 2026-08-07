import { buildChartConfig } from "../lib/chart-config";
import { buildNibrsChartConfig } from "../lib/nibrs-chart-config";
import { detectYearSeriesChart } from "../lib/chart-auto-detect";
import { selectShrPivotMetric } from "../lib/shr-category-pivot";

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? `\n  ${detail}` : ""}`);
  }
}

const timeSeriesRows = [
  { year: 2023, firearm_homicides: 2 },
  { year: 2024, firearm_homicides: 4 },
  { year: 2025, firearm_homicides: 3 },
];

const multiMetricRows = [
  { year: 2023, a: 1, b: 2, c: 3, d: 4 },
  { year: 2024, a: 2, b: 3, c: 4, d: 5 },
];

const categoricalRows = [
  { year: 2024, state: "CT", firearm_homicides: 2 },
  { year: 2024, state: "MA", firearm_homicides: 5 },
];

const scatterRows = [
  { city: "A, AA", violent_crime_rate_per_100k: 320.5, officers_per_100k: 210.2 },
  { city: "B, BB", violent_crime_rate_per_100k: 450.1, officers_per_100k: 188.7 },
];

const query8107Rows = [
  { year: 2024, sex: "Female", total_victims: 3573, unknown_relationship: 946, pct_unknown: 26.5 },
  { year: 2024, sex: "Male", total_victims: 12888, unknown_relationship: 6688, pct_unknown: 51.9 },
  { year: 2024, sex: "Unknown", total_victims: 108, unknown_relationship: 87, pct_unknown: 80.6 },
];

{
  const config = buildChartConfig(
    { sql: "SELECT year, firearm_homicides FROM x", chartHint: "none" } as any,
    ["year", "firearm_homicides"],
    timeSeriesRows
  );
  assert("current: chartHint none auto-detects line chart", config?.type === "line");
  assert("current: auto x-axis is year", config?.xAxis === "year");
  assert("current: auto y-axis uses numeric metric", config?.yAxis.join(",") === "firearm_homicides");
}

{
  const config = buildChartConfig(
    { sql: "SELECT year, firearm_homicides FROM x" } as any,
    ["year", "firearm_homicides"],
    timeSeriesRows
  );
  assert("current: omitted chartHint auto-detects line chart", config?.type === "line");
}

{
  const config = buildNibrsChartConfig(
    { sql: "SELECT year, firearm_homicides FROM x", chartHint: "none" } as any,
    ["year", "firearm_homicides"],
    timeSeriesRows
  );
  assert("nibrs: chartHint none auto-detects line chart", config?.type === "line");
}

{
  const config = buildNibrsChartConfig(
    { sql: "SELECT year, a, b, c, d FROM x", chartHint: "none" } as any,
    ["year", "a", "b", "c", "d"],
    multiMetricRows
  );
  assert("nibrs: 4+ metrics auto-detects bar chart", config?.type === "bar");
}

{
  const config = buildChartConfig(
    { sql: "SELECT year, state, firearm_homicides FROM x", chartHint: "none" } as any,
    ["year", "state", "firearm_homicides"],
    categoricalRows
  );
  assert("current: long-format categorical data with chartHint none stays uncharted", config === null);
}

{
  const autoChart = detectYearSeriesChart(["year", "state", "firearm_homicides"], categoricalRows);
  assert("shared detector rejects extra categorical columns", autoChart === null);
}

{
  const config = buildChartConfig(
    { sql: "SELECT city, violent_crime_rate_per_100k, officers_per_100k FROM x", chartHint: "none", xAxis: "", yAxis: "" } as any,
    ["city", "violent_crime_rate_per_100k", "officers_per_100k"],
    scatterRows,
    "give me a scatter plot of violent crime rate per 100k vs officers per 100k"
  );
  assert("current: explicit scatter request renders scatter even when chartHint none", config?.type === "scatter");
  assert("current: scatter picks first numeric x-axis", config?.xAxis === "violent_crime_rate_per_100k");
  assert("current: scatter picks second numeric y-axis", config?.yAxis.join(",") === "officers_per_100k");
}

{
  const columns = ["year", "sex", "total_victims", "unknown_relationship", "pct_unknown"];
  const common = {
    columns,
    rows: query8107Rows,
    categoryColumns: ["sex"],
  };
  const selected = selectShrPivotMetric({
    ...common,
    question: "share of murders with unknown relationship by year and sex",
  });
  assert("SHR 8107: share intent selects pct_unknown, never the first count column",
    selected === "pct_unknown", `selected ${selected}`);

  const selectedDespiteBadMetadata = selectShrPivotMetric({
    ...common,
    question: "share of murders with unknown relationship by year and sex",
    requestedYAxis: ["total_victims"],
  });
  assert("SHR 8107: explicit share intent overrides wrong model chart metadata",
    selectedDespiteBadMetadata === "pct_unknown", `selected ${selectedDespiteBadMetadata}`);

  const requested = selectShrPivotMetric({
    ...common,
    question: "murders by year and sex",
    requestedYAxis: ["unknown_relationship"],
  });
  assert("SHR pivot honors one explicit model y-axis", requested === "unknown_relationship");

  const ambiguous = selectShrPivotMetric({
    ...common,
    question: "murders by year and sex",
  });
  assert("SHR pivot fails open when several measures are ambiguous", ambiguous === null);

  const oneMetric = selectShrPivotMetric({
    question: "murder victims by year and sex",
    columns: ["year", "sex", "victims"],
    rows: query8107Rows.map((row) => ({ year: row.year, sex: row.sex, victims: row.total_victims })),
    categoryColumns: ["sex"],
  });
  assert("SHR pivot retains ordinary one-measure category results", oneMetric === "victims");
}

console.log(`chart-config tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
