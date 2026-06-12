import { buildChartConfig } from "../lib/chart-config";
import { buildNibrsChartConfig } from "../lib/nibrs-chart-config";
import { detectYearSeriesChart } from "../lib/chart-auto-detect";

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

console.log(`chart-config tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
