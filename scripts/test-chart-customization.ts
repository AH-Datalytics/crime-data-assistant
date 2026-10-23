#!/usr/bin/env npx tsx

import { applyChartCustomizations, applyChartOnlyCustomization, extractChartType, extractYAxisMax, extractYAxisMin, isChartTypeOnlyRequest, isYAxisDomainOnlyRequest, isYAxisMinOnlyRequest } from "../lib/chart-customization.js";
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
assert("extracts y-axis floor", extractYAxisMin("Set the floor to 60") === 60);
assert("extracts y-axis ceiling", extractYAxisMax("Set the ceiling to 80") === 80);
assert("extracts y-axis max", extractYAxisMax("Set y-axis max to 85%") === 85);
assert("extracts min from range phrasing", extractYAxisMin("set the Y-axis from 60 to 80") === 60);
assert("extracts max from range phrasing", extractYAxisMax("set the Y-axis from 60 to 80") === 80);
// Round 1 D1 (audit/presentation-2026-10-20/ROUND1-PLAN.md + r2 finding 3): a number sets an axis bound only when the
// wording ties it to the axis. Ranking counts and request filters never do (baseline P056, P118, P327, P395).
for (const q of [
  "Top 10 cities of 250,000 people or more by shoplifting rate in 2025",
  "Which 10 cities (min 30 murders) had the highest share via firearm in 2025?",
  "Murder rate for the top 100 cities in 2026",
  "Murders for top 10 police agencies from 2010 to present",
  "chart the top 10 cities",
  "chart cities with minimum population 100000",
  "cities with a population floor of 100000 by murder rate",
  "show the max 5 states",
]) {
  assert(`no axis bound from a ranking count or filter: ${q}`, extractYAxisMin(q) === null && extractYAxisMax(q) === null, `${extractYAxisMin(q)} / ${extractYAxisMax(q)}`);
  assert(`no chart customization from: ${q}`, !isYAxisDomainOnlyRequest(q));
}
assert("explicit y-axis max with 'to'", extractYAxisMax("set the y-axis max to 100") === 100);
assert("explicit y axis start at 0", extractYAxisMin("start the y axis at 0") === 0);
assert("axis-tied minimum", extractYAxisMin("set the minimum of the y-axis to 20") === 20);
assert("axis-tied top", extractYAxisMax("top of the axis at 500") === 500);
assert("bound-only follow-up still recognized", isYAxisDomainOnlyRequest("set the y-axis max to 100"));
assert("extracts line chart type", extractChartType("show this as a line chart") === "line");
assert("extracts bar chart type", extractChartType("make it a bar graph") === "bar");
assert("extracts scatter chart type", extractChartType("show this as a scatter plot") === "scatter");
assert("recognizes chart-only y-axis follow-up", isYAxisMinOnlyRequest("Start Y-axis at 60% on the chart"));
assert("recognizes chart-only y-axis domain follow-up", isYAxisDomainOnlyRequest("Set the floor to 60 and ceiling to 80"));
assert("recognizes chart-only type follow-up", isChartTypeOnlyRequest("show this as a line chart"));
assert("does not treat full data question as chart-only", !isYAxisMinOnlyRequest("Share of murder committed via firearm, 2000 - 2026, start Y-axis at 60%"));
assert("does not treat data request with chart words as chart-only", !isChartTypeOnlyRequest("show homicide rates by year as a line chart"));

const chartConfig = applyChartCustomizations({
  type: "line",
  xAxis: "year",
  yAxis: ["firearm_pct"],
  title: "Firearm Share",
}, "start Y-axis at 60%");
assert("applies yAxisMin to chart config", chartConfig?.yAxisMin === 60, JSON.stringify(chartConfig));

const domainConfig = applyChartCustomizations({
  type: "line",
  xAxis: "year",
  yAxis: ["firearm_pct"],
  title: "Firearm Share",
}, "set the floor to 60 and ceiling to 80");
assert("applies yAxisMin from floor", domainConfig?.yAxisMin === 60, JSON.stringify(domainConfig));
assert("applies yAxisMax from ceiling", domainConfig?.yAxisMax === 80, JSON.stringify(domainConfig));

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
const updatedDomain = applyChartOnlyCustomization("Set the floor to 60 and ceiling to 80", response);
assert("chart-only floor/ceiling sets min", updatedDomain?.chartConfig?.yAxisMin === 60, JSON.stringify(updatedDomain?.chartConfig));
assert("chart-only floor/ceiling sets max", updatedDomain?.chartConfig?.yAxisMax === 80, JSON.stringify(updatedDomain?.chartConfig));
const updatedType = applyChartOnlyCustomization("show this as a bar chart", response);
assert("chart-only type follow-up changes chart type", updatedType?.chartConfig?.type === "bar", JSON.stringify(updatedType?.chartConfig));
assert("chart-only type follow-up preserves SQL", updatedType?.sql === response.sql);
assert("non-chart follow-up does not update locally", applyChartOnlyCustomization("show this as a table", response) === null);

console.log(`chart customization tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
