// X-axis tick logic for monthly time series in components/ChartPanel.tsx.
// Regression: hate-crime rolling charts emit hyphenated "2013-09" x values
// (lib/hc-claude.ts rolling template), which fell through isYearMonth's
// 6-digit check to Recharts' default ticks — overlapping labels every ~33 months.
// Run: npx tsx scripts/test-chart-panel-ticks.ts
import assert from "node:assert/strict";
import { isYearMonth, yearTicksForYM, formatMonthOnly, formatYearMonth } from "../components/ChartPanel";

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

console.log("chart panel tick tests passed");
