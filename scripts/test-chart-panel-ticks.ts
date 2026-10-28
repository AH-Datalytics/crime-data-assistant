// X-axis tick logic for monthly time series in components/ChartPanel.tsx.
// Regression: hate-crime rolling charts emit hyphenated "2013-09" x values
// (lib/hc-claude.ts rolling template), which fell through isYearMonth's
// 6-digit check to Recharts' default ticks — overlapping labels every ~33 months.
// Run: npx tsx scripts/test-chart-panel-ticks.ts
import assert from "node:assert/strict";
import { isYearMonth, yearTicksForYM, formatMonthOnly, formatYearMonth, wrapCategoryLabel } from "../components/ChartPanel";
import {
  formatNibrsMonthOnly,
  isNibrsYearMonth,
  nibrsYearTicksForYM,
} from "../components/NibrsChartPanel";
import { plainYearXAxisProps } from "../lib/chart-axis";
import {
  DEFAULT_CHART_COLORS,
  detectAndPivotChartData,
  niceYTicks,
  shouldUsePieLegend,
} from "../lib/chart-layout";

function monthsHyphen(startYear: number, startMonth: number, count: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let y = startYear, m = startMonth;
  for (let i = 0; i < count; i++) {
    out.push({ month: `${y}-${String(m).padStart(2, "0")}`, rolling_12m: i });
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function monthsSixDigit(startYear: number, startMonth: number, count: number): Record<string, unknown>[] {
  return monthsHyphen(startYear, startMonth, count).map((r) => ({
    ...r, month: String(r.month).replace("-", ""),
  }));
}

// Detection: hyphenated and 6-digit year-months both count; years/dates do not
assert.equal(isYearMonth(monthsHyphen(2000, 1, 24), "month"), true, "hyphenated YYYY-MM must be detected as year-month");
assert.equal(isYearMonth(monthsSixDigit(2000, 1, 24), "month"), true);
assert.equal(isYearMonth([{ month: "2013" }, { month: "2014" }], "month"), false);
assert.equal(isYearMonth([{ month: "20130912" }], "month"), false);
assert.equal(isYearMonth([], "month"), false);

// The reported chart: 2000-01 .. 2026-06 (318 months, hyphenated)
{
  const ticks = yearTicksForYM(monthsHyphen(2000, 1, 318), "month");
  assert.ok(ticks.length > 0, "hyphenated multi-year data must get explicit ticks");
  assert.ok(ticks.length <= 10, `ticks must be thinned to <=10, got ${ticks.length}`);
  assert.ok(ticks.every((t) => /^\d{4}-01$/.test(t)), `ticks must be Januaries, got ${ticks.join(",")}`);
  assert.equal(ticks[0], "2000-01");
}

// 6-digit path unchanged (the 65b60cd behavior)
{
  const ticks = yearTicksForYM(monthsSixDigit(2000, 1, 318), "month");
  assert.ok(ticks.length > 0 && ticks.length <= 10);
  assert.ok(ticks.every((t) => /^\d{6}$/.test(t)));
  assert.equal(ticks[0], "200001");
}

// Partial first year: fall back to the first available month of that year
{
  const ticks = yearTicksForYM(monthsHyphen(2019, 6, 60), "month");
  assert.equal(ticks[0], "2019-06");
  assert.ok(ticks.includes("2020-01"));
}

// Single-year monthly labels
assert.equal(formatMonthOnly("2013-09"), "Sep");
assert.equal(formatMonthOnly("201309"), "Sep");
assert.equal(formatMonthOnly("not-a-month"), "not-a-month");

// Tooltip labels
assert.equal(formatYearMonth("2013-09"), "Sep 2013");
assert.equal(formatYearMonth("201309"), "Sep 2013");
assert.equal(formatYearMonth("2013"), "2013");

// Annual line charts need a continuous timeline, but annual bar charts need
// categorical bands so their first/last groups remain inside the plot.
assert.deepEqual(plainYearXAxisProps(true, "line"), {
  type: "number",
  domain: ["dataMin", "dataMax"],
  padding: { left: 8, right: 8 },
});
assert.deepEqual(plainYearXAxisProps(true, "bar"), {
  type: "category",
  allowDuplicatedCategory: false,
});
assert.equal("domain" in plainYearXAxisProps(true, "bar"), false);

// NIBRS/SHR accept both monthly encodings and keep monthly labels sparse.
assert.equal(isNibrsYearMonth(monthsHyphen(2020, 1, 24), "month"), true);
assert.equal(isNibrsYearMonth(monthsSixDigit(2020, 1, 24), "month"), true);
assert.deepEqual(nibrsYearTicksForYM(monthsHyphen(2020, 1, 24), "month"), ["2020-01", "2021-01"]);
assert.equal(formatNibrsMonthOnly("2021-07"), "Jul");

// Nine-city long-format results must pivot instead of overlapping or dropping
// series, and the default palette must keep every supported series distinct.
const cityRows = [2024, 2025].flatMap((year) =>
  Array.from({ length: 9 }, (_, index) => ({ year, city: `City ${index + 1}`, murders: 100 - index })),
);
const pivoted = detectAndPivotChartData(cityRows, "year", ["murders"]);
assert.equal(pivoted.seriesOverflow, false);
assert.equal(pivoted.data.length, 2);
assert.equal(pivoted.effectiveYKeys.length, 9);
assert.ok(DEFAULT_CHART_COLORS.length >= 16);
assert.equal(new Set(DEFAULT_CHART_COLORS).size, DEFAULT_CHART_COLORS.length);

const overflowRows = Array.from({ length: 17 }, (_, index) => ({
  year: 2025, city: `City ${index + 1}`, murders: index,
}));
assert.equal(detectAndPivotChartData(overflowRows, "year", ["murders"]).seriesOverflow, true);

// Mixed and negative measures must remain inside the computed Y domain.
assert.deepEqual(niceYTicks([{ value: 12 }, { value: 87 }], ["value"])?.domain, [0, 100]);
assert.deepEqual(niceYTicks([{ value: -18 }, { value: 42 }], ["value"])?.domain, [-20, 60]);
assert.deepEqual(niceYTicks([{ value: -73 }, { value: -4 }], ["value"])?.domain, [-80, 0]);
assert.deepEqual(
  niceYTicks([{ first: 60, second: 60 }], ["first", "second"], true)?.domain,
  [0, 125],
);
assert.deepEqual(
  niceYTicks([{ first: -30, second: -45 }], ["first", "second"], true)?.domain,
  [-80, 0],
);
// Owner 2026-10-25 ("half numbers"): counts get whole-number ticks (12 and 9 used to give 0, 2.5, ... 12.5).
{
  const t = niceYTicks([{ count: 12 }, { count: 9 }, { count: 0 }], ["count"]);
  assert.ok(t && t.ticks.every((v) => Number.isInteger(v)), `whole-number ticks for counts (${t?.ticks.join(", ")})`);
  assert.ok(t && t.domain[1] >= 12 && t.domain[1] <= 14, `the top stays close to the data (${t?.domain.join("-")})`);
  const r = niceYTicks([{ rate: 1.2 }, { rate: 3.7 }], ["rate"]);
  assert.ok(r && r.ticks.some((v) => !Number.isInteger(v)) || (r && r.domain[1] <= 4), "rates may still use fractional steps");
}

// Owner 2026-10-25 ("the labels don't fit") and item 3.1 ("cut at narrow widths"): category labels wrap by measured
// width onto as many whole-word lines as they need, and are never cut. Outside a browser the width is estimated.
{
  const c = "In custody of another jurisdiction (includes extradition denied)";
  const lines = wrapCategoryLabel(c, 22 * 7.2);
  assert.ok(lines.every((l) => l.length * 7.2 <= 22 * 7.2), lines.join(" | "));
  assert.equal(lines.join(" "), c, "every word is kept");
  assert.deepEqual(wrapCategoryLabel("Death of offender", 22 * 7.2), ["Death of offender"]);
  const long = wrapCategoryLabel("one two three four five six seven eight nine ten", 8 * 7.2);
  assert.equal(long.join(" "), "one two three four five six seven eight nine ten", "more than three lines: still not cut");
  assert.ok(long.every((l) => !l.endsWith("…")), "no ellipsis");
}

// Dense or long-label pies use an internal legend instead of clipped labels.
assert.equal(shouldUsePieLegend(Array.from({ length: 7 }, (_, i) => ({ name: `Item ${i}` })), "name"), true);
assert.equal(shouldUsePieLegend([{ name: "A very long category label" }], "name"), true);
assert.equal(shouldUsePieLegend([{ name: "One" }, { name: "Two" }], "name"), false);

console.log("chart panel tick tests passed");
