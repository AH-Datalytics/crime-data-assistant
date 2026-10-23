/**
 * Round 1 presentation fixes (audit/presentation-2026-10-20/ROUND1-PLAN.md + ROUND1-PLAN-r2.md; Codex r2 ACCEPT): the
 * pure rules behind the display-meaning batch. Rendering itself is checked by the saved-payload render replay.
 *   D3  partial-period fallback at delivery (lib/partial-periods.ts)
 *   D4  pivot only true grids; presentation metadata never a series (lib/chart-layout.ts)
 *   D5  chart box minimum height keeps a 150 px plot (lib/chart-layout.ts)
 *   D7  distinct labels for colliding category labels (lib/chart-layout.ts)
 *   D8  result chips confirmed against the delivered answer (lib/query-plan.ts)
 */
import assert from "node:assert/strict";
import { withPartialPeriodFallback, statedMonthSpan } from "../lib/partial-periods";
import { chartBoxMinHeight, detectAndPivotChartData, uniqueCategoryLabels } from "../lib/chart-layout";
import { confirmResultChips, type QueryPlanChip } from "../lib/query-plan";
import type { ChartConfig } from "../lib/types";

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${(e as Error).message}`); failed++; process.exitCode = 1; }
}
const NOW = new Date("2026-10-22T14:00:00Z");
const years = (from: number, to: number, f: (y: number) => Record<string, unknown>) => Array.from({ length: to - from + 1 }, (_, i) => f(from + i));

console.log("\nD3 partial-period fallback");
check("an SHR annual series through the current year: the stated months label the partial point (baseline W01 shape)", () => {
  const p = { chartConfig: { type: "line", xAxis: "year", yAxis: ["victims"], title: "Murder Victims Under 18 By Year, United States, 2000-2026" } as ChartConfig,
    rows: years(2000, 2026, (y) => ({ place: "United States", year: y, victims: 1000 })), explanation: "… 2025, January-October 2026 (2000 through 2026) …" };
  withPartialPeriodFallback(p, NOW);
  assert.deepEqual(p.chartConfig.partialPeriods, [{ x: 2026, label: "Jan–Oct" }]);
  assert.deepEqual(p.chartConfig.partialBasis, { asOf: "2026-10-22", rule: "current-calendar-year" });
});
check("months not stated: the label says partial year, nothing inferred (baseline P032 shape)", () => {
  const p = { chartConfig: { type: "line", xAxis: "year", yAxis: ["new_york_city_ny_murders", "chicago_il_murders"], title: "NIBRS offense trends" } as ChartConfig,
    rows: years(2015, 2026, (y) => ({ year: y, new_york_city_ny_murders: y > 2018 ? 300 : null, chicago_il_murders: 300 })), explanation: "current-year partial counts remain visible" };
  withPartialPeriodFallback(p, NOW);
  assert.deepEqual(p.chartConfig.partialPeriods, [{ x: 2026, label: "partial year" }]);
});
check("a producer's own partial periods win", () => {
  const p = { chartConfig: { type: "line", xAxis: "period", yAxis: ["value"], title: "t", partialPeriods: [{ x: 2026, label: "Jan–Jun" }] } as ChartConfig, rows: years(2017, 2026, (y) => ({ period: y, value: 1 })) };
  withPartialPeriodFallback(p, NOW);
  assert.deepEqual(p.chartConfig.partialPeriods, [{ x: 2026, label: "Jan–Jun" }]);
});
check("monthly, category and past-only axes are left alone", () => {
  for (const p of [
    { chartConfig: { type: "line", xAxis: "month", yAxis: ["v"], title: "t" } as ChartConfig, rows: [{ month: "2026-01", v: 1 }, { month: "2026-02", v: 2 }] },
    { chartConfig: { type: "bar", xAxis: "city", yAxis: ["v"], title: "t" } as ChartConfig, rows: [{ city: "A", v: 1 }, { city: "B", v: 2 }] },
    { chartConfig: { type: "line", xAxis: "year", yAxis: ["v"], title: "t" } as ChartConfig, rows: years(2010, 2024, (y) => ({ year: y, v: 1 })) },
  ]) { withPartialPeriodFallback(p, NOW); assert.equal(p.chartConfig.partialPeriods, undefined, JSON.stringify(p.chartConfig)); }
});
check("stated month spans: dash, 'through', 'to'", () => {
  assert.equal(statedMonthSpan("January-October 2026", 2026), "Jan–Oct");
  assert.equal(statedMonthSpan("January through June 2026", 2026), "Jan–Jun");
  assert.equal(statedMonthSpan("January to March 2025", 2026), null);
  assert.equal(statedMonthSpan("Murder Victims, United States, 2000-2026 (2026 through October)", 2026), "Jan–Oct");
});

console.log("\nD4 pivot rules");
check("a true grid pivots (year × bias category)", () => {
  const rows = years(2010, 2014, (y) => ({ year: y, bias: "A", n: 1 })).concat(years(2010, 2014, (y) => ({ year: y, bias: "B", n: 2 })));
  const r = detectAndPivotChartData(rows, "year", ["n"]);
  assert.deepEqual(r.effectiveYKeys, ["A", "B"]);
  assert.equal(r.data.length, 5);
});
check("a ranking with colliding labels is NOT split by state (baseline P327)", () => {
  const rows = [{ city: "Claflin", state: "KS", rate: 185 }, { city: "St. Louis", state: "MO", rate: 100 }, { city: "Kenton", state: "TN", rate: 90 }, { city: "St. Louis", state: "MO", rate: 30 }];
  const r = detectAndPivotChartData(rows, "city", ["rate"]);
  assert.equal(r.seriesOverflow, false);
  assert.deepEqual(r.effectiveYKeys, ["rate"]);
  assert.equal(r.data, rows);
});
check("D4 r2 (on the live rule): places with uneven coverage still become series; a year axis by state still pivots", () => {
  const uneven = [
    ...["2025-01", "2025-02", "2025-03", "2025-04", "2025-05", "2025-06"].map((p, i) => ({ period: p, place: "Memphis, TN", value: 10 + i })),
    ...["2025-05", "2025-06"].map((p, i) => ({ period: p, place: "Knoxville, TN", value: 3 + i })),
  ];
  assert.deepEqual(detectAndPivotChartData(uneven, "period", ["value"]).effectiveYKeys, ["Memphis, TN", "Knoxville, TN"], "the hotfix's reason for dropping the 1.5x rule");
  const byState = [2023, 2024].flatMap((year) => [{ year, state: "TX", rate: 5 }, { year, state: "LA", rate: 9 }]);
  assert.deepEqual(detectAndPivotChartData(byState, "year", ["rate"]).effectiveYKeys, ["TX", "LA"]);
  // Codex r3 finding 3: a legitimate non-period category-by-state chart pivots (every label repeats: a true grid).
  const offenseByState = ["Murder", "Robbery"].flatMap((offense) => [{ offense, state: "TX", n: 5 }, { offense, state: "LA", n: 9 }]);
  assert.deepEqual(detectAndPivotChartData(offenseByState, "offense", ["n"]).effectiveYKeys, ["TX", "LA"]);
  const placesByState = ["Springfield", "Columbus"].flatMap((city) => [{ city, state: "IL", n: 5 }, { city, state: "OH", n: 9 }]);
  assert.deepEqual(detectAndPivotChartData(placesByState, "city", ["n"]).effectiveYKeys, ["IL", "OH"], "a full place-by-state grid still pivots");
});
check("a varying row note never becomes a series (partial-year note, r2 finding 5)", () => {
  const rows = years(2017, 2026, (y) => ({ period: y, place: "Memphis, TN", measure: "murder", statistic: "count", value: 100, note: y === 2026 ? "January–June only" : null }));
  const r = detectAndPivotChartData(rows, "period", ["value"]);
  assert.deepEqual(r.effectiveYKeys, ["value"]);
  assert.equal(r.data.length, 10);
});
check("multi-place long rows still pivot by place", () => {
  const rows = years(2022, 2024, (y) => ({ period: y, place: "Chicago, IL", value: 1, note: null })).concat(years(2022, 2024, (y) => ({ period: y, place: "Houston, TX", value: 2, note: null })));
  assert.deepEqual(detectAndPivotChartData(rows, "period", ["value"]).effectiveYKeys, ["Chicago, IL", "Houston, TX"]);
});

console.log("\nD5 chart box height");
check("a 20-bar ranking with a 2-line title reserves the angled axis and a 150 px plot", () => {
  const h = chartBoxMinHeight({ type: "bar", xAxis: "city", yAxis: ["rate"], title: "Cities by Sexual assault Rate per 100,000, 2026 through June" }, Array.from({ length: 20 }, (_, i) => ({ city: `C${i}`, rate: i })));
  assert.ok(h >= 3 * 22 + 120 + 150, String(h));
});
check("a short time series keeps the old 280 px floor", () => {
  assert.equal(chartBoxMinHeight({ type: "line", xAxis: "year", yAxis: ["v"], title: "Murders: Dallas" }, years(2010, 2025, (y) => ({ year: y, v: 1 }))), 280);
});

console.log("\nD7 distinct labels");
check("colliding labels get the state, then a running number", () => {
  assert.deepEqual(uniqueCategoryLabels([{ place: "Los Angeles, CA" }, { place: "Oakland, CA" }, { place: "Los Angeles, CA" }], "place"), ["Los Angeles, CA (1)", "Oakland, CA", "Los Angeles, CA (2)"]);
  assert.deepEqual(uniqueCategoryLabels([{ city: "St. Louis", state: "MO" }, { city: "St. Louis", state: "MI" }], "city"), ["St. Louis, MO", "St. Louis, MI"]);
  assert.equal(uniqueCategoryLabels([{ city: "A" }, { city: "B" }], "city"), null);
});

console.log("\nD8 result chips");
const chip = (key: QueryPlanChip["key"], value: string): QueryPlanChip => ({ key, label: key, value, status: "ok" });
check("a metric chip the answer contradicts is hidden (baseline W05)", () => {
  const out = confirmResultChips([chip("metric", "Aggravated Assault Rate"), chip("unit", "Per 100k")], { title: "Cities by Sexual assault Rate per 100,000, 2026 through June", explanation: "uses the FBI's UCR category \"Rape\"", columns: ["city", "rate_per_100k"], rows: [{ city: "A", rate_per_100k: 1 }] });
  assert.deepEqual(out.map((c) => c.key), ["unit"]);
});
check("the place chip lists every delivered place (baseline W06, P050)", () => {
  const out = confirmResultChips([chip("place", "Chicago")], { title: "Murders: Chicago, IL, Houston, TX, Phoenix, AZ", rows: [{ place: "Chicago, IL" }, { place: "Houston, TX" }, { place: "Phoenix, AZ" }] });
  assert.equal(out[0].value, "3 places");
  assert.equal(out[0].detail, "Chicago, IL; Houston, TX; Phoenix, AZ");
});
check("a single-place chip on a wide answer naming more places is hidden (baseline P032)", () => {
  const out = confirmResultChips([chip("place", "New York")], { title: "NIBRS offense trends for New York City, NY and Chicago, IL", rows: [{ year: 2025, new_york_city_ny_murders: 1 }] });
  assert.deepEqual(out, []);
});
check("an open-ended time chip on a single-year answer is hidden (baseline P402, P329)", () => {
  assert.deepEqual(confirmResultChips([chip("time", "2024-present")], { title: "Top 10 States by Robbery rate per 100,000 residents, 2024", rows: [{ place: "DC", year: 2024 }] }).filter((c) => c.key === "time"), []);
  assert.equal(confirmResultChips([chip("time", "2015-present")], { title: "t", rows: years(2015, 2026, (y) => ({ year: y })) })[0]?.value, "2015-present");
});
check("confirmed chips stay (controls)", () => {
  const out = confirmResultChips([chip("place", "Texas"), chip("metric", "Murder Count"), chip("unit", "Count")], { title: "murder — Texas", rows: [{ period: 2024, place: "Texas", measure: "murder", statistic: "count", value: 1610 }] });
  assert.deepEqual(out.map((c) => c.value), ["Texas", "Murder Count", "Count"]);
});

console.log(`\nround 1 presentation: ${passed} passed, ${failed} failed`);
