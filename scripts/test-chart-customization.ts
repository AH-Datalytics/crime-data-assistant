#!/usr/bin/env npx tsx

import { applyChartCustomizations, applyChartOnlyCustomization, extractYAxisMin, isYAxisMinOnlyRequest } from "../lib/chart-customization.js";
import type { QueryResponse } from "../lib/types.js";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

assert("extracts percent y-axis minimum", extractYAxisMin("Start Y-axis at 60%") === 60);
assert("extracts full-query y-axis minimum", extractYAxisMin("Share of murder committed via firearm, 2000 - 2026, start Y-axis at 60%") === 60);
assert("recognizes chart-only y-axis follow-up", isYAxisMinOnlyRequest("Start Y-axis at 60% on the chart"));
assert("does not treat full data question as chart-only", !isYAxisMinOnlyRequest("Share of murder committed via firearm, 2000 - 2026, start Y-axis at 60%"));

const chartConfig = applyChartCustomizations({
  type: "line",
  xAxis: "year",
  yAxis: ["firearm_pct"],
  title: "Firearm Share",
}, "start Y-axis at 60%");
assert("applies yAxisMin to chart config", chartConfig?.yAxisMin === 60, JSON.stringify(chartConfig));

const response: QueryResponse = {
  success: true,
  question: "Share of murder committed via firearm",
  sql: "SELECT year, firearm_pct FROM t",
  explanation: "Original explanation.",
  title: "Firearm Share",
  columns: ["year", "firearm_pct"],
  rows: [{ year: 2020, firearm_pct: 70 }],
  rowCount: 1,
  truncated: false,
  chartConfig: chartConfig!,
  chartMeta: null,
  executionTimeMs: 10,
};

const updated = applyChartOnlyCustomization("Start Y-axis at 60% on the chart", response);
assert("chart-only follow-up returns updated response", updated?.chartConfig?.yAxisMin === 60, JSON.stringify(updated?.chartConfig));
assert("chart-only follow-up preserves SQL", updated?.sql === response.sql);
assert("non-chart follow-up does not update locally", applyChartOnlyCustomization("show this as a table", response) === null);

console.log(`chart customization tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
