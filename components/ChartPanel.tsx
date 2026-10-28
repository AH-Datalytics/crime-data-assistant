"use client";

import React from "react";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
  ScatterChart,
  Scatter,
  ZAxis,
  LabelList,
} from "recharts";
import type { ChartConfig, ChartMeta } from "@/lib/types";
import { formatAxisValue, fmtVal, decadeTicksForYears, scatterEntityLabel } from "@/lib/utils";
import { plainYearXAxisProps } from "@/lib/chart-axis";
import {
  DEFAULT_CHART_COLORS,
  detectAndPivotChartData,
  niceYTicks,
  shouldUsePieLegend,
  uniqueCategoryLabels,
} from "@/lib/chart-layout";
import { useChartRenderReceipt } from "./useChartRenderReceipt";
import { chartNotes } from "@/lib/embed-notes";
import { resetTickTextCache, MAX_SLANTED_AXIS, slantedAxisHeight, slantedLeftMargin, sideLabelWidth as measuredSideLabelWidth, valueAxisWidth, wrapLabel, wrappedAxisHeight } from "@/lib/chart-text";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const TICK_STYLE = {
  fontSize: 13,
  fill: "#1e2a35",
  fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
};

/**
 * Owner 2026-10-25 ("the labels don't fit"): category labels on a bar chart with few bars are written flat and wrapped
 * onto up to three lines under their bar, instead of slanted and cut off. Exported for tests.
 */
export function wrapCategoryLabel(label: string, maxWidth: number): string[] {
  return wrapLabel(label, maxWidth);
}

export function WrappedCategoryTick(props: { x?: number; y?: number; payload?: { value: unknown }; width?: number; visibleTicksCount?: number }) {
  const { x = 0, y = 0, payload, width = 600, visibleTicksCount = 1 } = props;
  const perBar = width / Math.max(1, visibleTicksCount);
  const lines = wrapCategoryLabel(String(payload?.value ?? ""), perBar - 6);
  return (
    <g transform={`translate(${x},${y})`}>
      <text textAnchor="middle" fontSize={TICK_STYLE.fontSize} fill={TICK_STYLE.fill} fontFamily={TICK_STYLE.fontFamily}>
        {lines.map((line, i) => <tspan key={i} x={0} dy={i === 0 ? 14 : 15}>{line}</tspan>)}
      </text>
    </g>
  );
}

/**
 * Owner 2026-10-25 ("that second chart looks bad"): on a narrow screen, few category bars are drawn sideways, each
 * label written in full to the left of its bar, wrapped onto up to four lines.
 */
export const SIDEWAYS_MIN_BAR = 90;
export function SideCategoryTick(props: { x?: number; y?: number; payload?: { value: unknown }; labelWidth: number }) {
  const { x = 0, y = 0, payload, labelWidth } = props;
  const lines = wrapCategoryLabel(String(payload?.value ?? ""), labelWidth - 8);
  const top = -((lines.length - 1) * 14) / 2;
  return (
    <g transform={`translate(${x},${y})`}>
      <text textAnchor="end" fontSize={TICK_STYLE.fontSize} fill={TICK_STYLE.fill} fontFamily={TICK_STYLE.fontFamily}>
        {lines.map((line, i) => <tspan key={i} x={-6} dy={i === 0 ? top + 4 : 14}>{line}</tspan>)}
      </text>
    </g>
  );
}

const GRID_COLOR = "#ddd8ce";
const X_AXIS_LINE_STYLE = { stroke: "#b8b0a5", strokeWidth: 1 };
const X_AXIS_TICK_LINE_STYLE = { stroke: "#b8b0a5", strokeWidth: 1 };

function properCase(s: string): string {
  // Handle rolling_12m, rolling_12, rolling_12_month etc. → "Rolling 12-Month"
  if (/^rolling_\d+m?$/i.test(s) || /^rolling_\d+_month$/i.test(s)) {
    const n = s.match(/\d+/)?.[0] || "12";
    return `Rolling ${n}-Month`;
  }
  const cleaned = s
    .replace(/^rolling_\d+_?/i, "")
    .replace(/_rate_per_\d+k?/i, "")
    .replace(/_rate$/i, "")
    .replace(/_per_\d+k?$/i, "")
    .replace(/_count$/i, "")
    .replace(/_total$/i, "")
    .replace(/_/g, " ")
    .trim();
  const label = cleaned || s.replace(/_/g, " ").trim();
  const titled = label.replace(/\b\w/g, (c) => c.toUpperCase());
  // Fix known abbreviations that should stay uppercase
  const fixed = titled.replace(/\bDc\b/g, "DC").replace(/\bNy\b/g, "NY").replace(/\bNyc\b/g, "NYC").replace(/\bLa\b/g, "LA").replace(/\bUsa\b/g, "USA").replace(/\bUs\b/g, "US");
  // Fix common singular labels that should be plural
  return fixed
    .replace(/\bOfficer\b$/g, "Officers")
    .replace(/\bIncident\b$/g, "Incidents")
    .replace(/\bArrest\b$/g, "Arrests")
    .replace(/\bVictim\b$/g, "Victims")
    .replace(/\bOffense\b$/g, "Offenses")
    .replace(/\bMurder\b$/g, "Murders")
    .replace(/\bRobbery\b$/g, "Robberies")
    .replace(/\bAssault\b$/g, "Assaults")
    .replace(/\bBurglary\b$/g, "Burglaries");
}

// Monthly x values arrive as "201309" (year+month columns, current/historical)
// or "2013-09" (strftime('%Y-%m') from the NIBRS/SHR/hate-crime rolling templates).
const YM_SIX_RE = /^\d{6}$/;
const YM_HYPHEN_RE = /^\d{4}-\d{2}$/;

function isYearMonthValue(v: string): boolean {
  return YM_SIX_RE.test(v) || YM_HYPHEN_RE.test(v);
}

export function isYearMonth(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.length > 0 && sample.every((d) => isYearMonthValue(String(d[xKey] ?? "")));
}

function isDate(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return (
    sample.length > 0 &&
    sample.every((d) => /^(19|20)\d{6}$/.test(String(d[xKey] ?? "")))
  );
}

export function formatYearMonth(val: string | number): string {
  const s = String(val);
  const m = YM_SIX_RE.test(s) ? parseInt(s.slice(4, 6), 10)
    : YM_HYPHEN_RE.test(s) ? parseInt(s.slice(5, 7), 10)
    : NaN;
  if (isNaN(m)) return s;
  return `${MONTH_NAMES[m - 1] || s} ${s.slice(0, 4)}`;
}

export function formatMonthOnly(val: string | number): string {
  const s = String(val);
  const m = YM_SIX_RE.test(s) ? parseInt(s.slice(4, 6), 10)
    : YM_HYPHEN_RE.test(s) ? parseInt(s.slice(5, 7), 10)
    : NaN;
  if (isNaN(m)) return s;
  return MONTH_NAMES[m - 1] || s;
}

function formatDateFull(val: string | number): string {
  const s = String(val);
  if (!/^(19|20)\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  const d = parseInt(s.slice(6, 8), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4, 6)} ${d}, ${s.slice(0, 4)}`;
}

function formatDateTickLabel(val: string | number, singleYear: boolean): string {
  const s = String(val);
  if (!/^(19|20)\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  const mon = MONTH_NAMES[m - 1] || s.slice(4, 6);
  return singleYear ? mon : `${mon} ${s.slice(0, 4)}`;
}

function dailyTickInterval(dataLength: number): number {
  if (dataLength <= 14) return 0;
  return Math.max(1, Math.floor(dataLength / 12));
}

/** Build evenly-spaced ticks for multi-year monthly ("YYYYMM" or "YYYY-MM") data:
 *  January of each year (or the year's first available month), thinned if >10. */
export function yearTicksForYM(data: Record<string, unknown>[], xKey: string): string[] {
  const vals = data.map((d) => String(d[xKey] ?? "")).filter(isYearMonthValue);
  if (vals.length === 0) return [];
  const years = [...new Set(vals.map((v) => v.slice(0, 4)))].sort();

  // Multi-year monthly charts use one tick per year.
  const ticks: string[] = [];
  for (const y of years) {
    const jan = vals.find((v) => v === `${y}01` || v === `${y}-01`);
    ticks.push(jan ?? vals.find((v) => v.startsWith(y))!);
  }
  // If too many ticks (>10), thin them out evenly
  if (ticks.length > 10) {
    const step = Math.ceil(ticks.length / 8);
    const thinned = ticks.filter((_, i) => i % step === 0);
    if (thinned[thinned.length - 1] !== ticks[ticks.length - 1]) thinned.push(ticks[ticks.length - 1]);
    return thinned;
  }
  return ticks;
}

/** Build evenly-spaced month ticks for daily (YYYYMMDD) data */
function monthTicksForDaily(data: Record<string, unknown>[], xKey: string): string[] {
  const vals = data.map((d) => String(d[xKey] ?? "")).filter((v) => /^(19|20)\d{6}$/.test(v));
  if (vals.length === 0) return [];
  // find first-of-month entries, or closest entry to each month boundary
  const months = new Map<string, string>(); // YYYYMM -> first YYYYMMDD in that month
  for (const v of vals) {
    const ym = v.slice(0, 6);
    if (!months.has(ym)) months.set(ym, v);
  }
  let ticks = [...months.values()];
  // if many months, show only January of each year
  if (ticks.length > 14) {
    const yearTicks: string[] = [];
    const seen = new Set<string>();
    for (const [ym, val] of months) {
      const y = ym.slice(0, 4);
      if (ym.slice(4) === "01" && !seen.has(y)) { seen.add(y); yearTicks.push(val); }
    }
    ticks = yearTicks;
  }
  // thin if still too many
  if (ticks.length > 10) {
    const step = Math.ceil(ticks.length / 8);
    const thinned = ticks.filter((_, i) => i % step === 0);
    if (thinned[thinned.length - 1] !== ticks[ticks.length - 1]) thinned.push(ticks[ticks.length - 1]);
    return thinned;
  }
  return ticks;
}

function isPlainYears(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 5);
  return sample.length > 0 && sample.every((d) => /^\d{4}$/.test(String(d[xKey] ?? "")));
}

function formatPopulation(pop: number): string {
  if (pop >= 1_000_000) return `${(pop / 1_000_000).toFixed(1)}M`;
  if (pop >= 1_000) return `${(pop / 1_000).toFixed(0)}K`;
  return String(pop);
}

interface ChartPanelProps {
  config: ChartConfig;
  rows: Record<string, unknown>[];
  meta?: ChartMeta | null;
  requestId?: string;
}

function RenderedChartPanel({ config, rows, meta, requestId }: ChartPanelProps) {
    const hasYearMonth =
      rows.length > 0 && "year" in rows[0] && "month" in rows[0];

    const data = rows.map((r) => {
      const entry: Record<string, unknown> = {};
      for (const key of Object.keys(r)) {
        entry[key] = r[key];
      }
      if (hasYearMonth) {
        const y = String(r.year ?? "");
        const m = String(r.month ?? "").padStart(2, "0");
        entry._ym = `${y}${m}`;
      }
      return entry;
    });

    const xKey = hasYearMonth ? "_ym" : config.xAxis;
    const ym = hasYearMonth || isYearMonth(data, config.xAxis);
    const daily = !ym && isDate(data, config.xAxis);

    // Auto-pivot long-format data (e.g. year × category → grouped series)
    const pivoted = config.type === "scatter"
      ? { data, effectiveYKeys: config.yAxis, seriesOverflow: false }
      : detectAndPivotChartData(data, xKey, config.yAxis);
    const { effectiveYKeys, seriesOverflow } = pivoted;
    // Round 1 D7: a category axis whose labels collide (two agencies both "St. Louis") gets distinct display labels.
    const collidingLabels = !ym && !daily && pivoted.data === data && config.type !== "scatter" && config.type !== "pie"
      ? uniqueCategoryLabels(data, config.xAxis)
      : null;
    const chartData: Record<string, unknown>[] = collidingLabels ? data.map((d, i) => ({ ...d, _xlabel: collidingLabels[i] })) : pivoted.data;

    const dataYears = new Set(
      chartData.map((d) => String(d[daily ? config.xAxis : xKey] ?? "").slice(0, 4))
    );
    const singleYear = dataYears.size === 1;
    const singleYearMonthly = ym && chartData.length > 0 && singleYear;

    const multiSeries = effectiveYKeys.length > 1;
    const dataLen = chartData.length;

    // Detect employees-only years (staffing data where officer breakdown unavailable)
    const employeesYears = data
      .filter((d) => d.data_type === "Employees*")
      .map((d) => String(d.year ?? d[config.xAxis] ?? ""))
      .filter(Boolean);
    const hasEmployeesDisclaimer = employeesYears.length > 0;

    const xAxisDataKey = daily ? config.xAxis : ym ? xKey : collidingLabels ? "_xlabel" : config.xAxis;
    const receiptRef = useChartRenderReceipt({ requestId, component: "ChartPanel", chartType: config.type, effectiveXKey: xAxisDataKey, effectiveYKeys });
    const [boxWidth, setBoxWidth] = React.useState(0);
    // Labels are measured in the tick font; measure again once the page's fonts have loaded.
    const [, setFontsReady] = React.useState(0);
    React.useEffect(() => {
      if (typeof document === "undefined" || !document.fonts) return;
      let live = true;
      void document.fonts.ready.then(() => { if (live) { resetTickTextCache(); setFontsReady((n) => n + 1); } });
      return () => { live = false; };
    }, []);
    // Round 1 D4: never a blank chart area. Too many series to draw is said plainly; every row stays in the table.
    if (seriesOverflow) {
      return (
        <div ref={receiptRef} className="h-full flex items-center justify-center p-6" style={{ background: "#F5F0E8" }} data-chart-disposition="series-overflow">
          <p style={{ color: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", fontSize: 14, textAlign: "center" }}>
            Too many series to chart; every row is in the table.
          </p>
        </div>
      );
    }
    // Round 1 D3 marked partial periods (e.g. 2026 with January-October only) with a hollow point and a "Jan–Oct" label.
    // Owner 2026-10-23: "remove it completely" -- the title already states the partial period ("2026 Through October"),
    // so the chart draws no partial mark, label or tooltip suffix. The payload's partialPeriods field is unchanged.
    const partialLabel = new Map<string, string>();
    const isPartialX = (x: unknown) => partialLabel.has(String(x));

    // Detect plain-year x-axis (historical queries)
    const plainYears = !ym && !daily && isPlainYears(chartData, xAxisDataKey);
    const yearTicks = plainYears ? decadeTicksForYears(chartData, xAxisDataKey) : [];
    // Owner 2026-10-25: category bars (not time) with 8 bars or fewer get flat labels wrapped under each bar.
    const wrapCategories = !ym && !daily && !plainYears && dataLen <= 8;
    // Slanted labels are no longer cut off: the axis is tall enough for the longest one (about 5.5px per character at 45°).
    // Labels are measured, never cut (owner item 3.1; lib/chart-text.ts): axes take the room the labels need.
    const categoryLabels = chartData.map((d) => String(d[xAxisDataKey] ?? ""));
    const slantedLabelHeight = slantedAxisHeight(categoryLabels);
    const perBar = boxWidth > 0 ? (boxWidth - 80) / Math.max(1, dataLen) : 120;
    const wrappedLabelHeight = wrappedAxisHeight(categoryLabels, perBar);
    // Too narrow for wrapped labels under each bar (a phone), or slanted labels that would take most of the chart:
    // the bars are drawn sideways instead, each label in full beside its bar.
    // Decided from the measured labels alone, so the first paint already has the final layout (no slanted-then-sideways flip).
    const slantedTooTall = !wrapCategories && !ym && !daily && !plainYears && slantedLabelHeight > MAX_SLANTED_AXIS;
    const sideways = (wrapCategories && boxWidth > 0 && perBar < SIDEWAYS_MIN_BAR) || slantedTooTall;
    const sideLabelWidth = measuredSideLabelWidth(categoryLabels, boxWidth);
    // Sideways bars need room for each wrapped label: the chart grows rather than letting labels overlap.
    const sidewaysMinHeight = sideways
      ? 70 + categoryLabels.reduce((sum, l) => sum + Math.max(28, wrapLabel(l, sideLabelWidth - 8).length * 14 + 10), 0)
      : 0;

    // Compute explicit tick positions for even spacing
    const fewYearsMonthly = false;
    const ymTicks = ym && !singleYearMonthly ? yearTicksForYM(chartData, xKey) : [];
    const dailyTicks = daily ? monthTicksForDaily(chartData, config.xAxis) : [];
    const dailySingleYear = daily && new Set(dailyTicks.map(t => t.slice(0, 4))).size <= 1;

    // Detect clearance/percentage y-axis columns (NOT per-100K rates)
    // Column names with clearance/_clr/_pct/percent/share trigger % formatting.
    // Also check the chart title for "percent", "share", or "%" hints.
    // _rate columns are NOT treated as percentages — they are per-100K rates.
    const titleHintPercent = /percent|share|%/i.test(config.title || "");
    const isPercent = (effectiveYKeys.some((y) =>
      /clearance|_clr|_pct|percent|share/i.test(y)
    ) || titleHintPercent) && effectiveYKeys.every((y) =>
      !/count|total|population|pop/i.test(y)
    );
    const yTickFormatter = isPercent
      ? (v: number) => `${v}%`
      : formatAxisValue;

    // Compute clean Y-axis ticks (round intervals starting at 0)
    const yTickInfo = niceYTicks(chartData, effectiveYKeys, config.type === "stacked_bar");
    // The value axis is as wide as its widest formatted tick, never narrower than before.
    const valueAxisLabelWidth = Math.max(isPercent ? 55 : 50, yTickInfo ? valueAxisWidth(yTickInfo.ticks.map((v) => String(yTickFormatter(v)))) : 0);
    // Slanted category labels: room at the left for the first one (it reaches left of its tick).
    const slanted = !sideways && !wrapCategories && !ym && !daily && !plainYears && !fewYearsMonthly;
    const leftMargin = slanted && categoryLabels.length ? slantedLeftMargin(categoryLabels[0], valueAxisLabelWidth, boxWidth, dataLen) : 8;
    // Round 1 D6: bars of non-negative values start at zero unless the user explicitly set a minimum; a max-only request
    // keeps the zero baseline (it no longer falls back to the data minimum). Signed values keep their own range.
    const isBarType = config.type === "bar" || config.type === "stacked_bar";
    const nonNegative = chartData.every((d) => effectiveYKeys.every((y) => d[y] == null || Number(d[y]) >= 0));
    const yAxisScaleProps = config.yAxisMin !== undefined || config.yAxisMax !== undefined
      ? { domain: [config.yAxisMin ?? (isBarType && nonNegative ? 0 : "dataMin"), config.yAxisMax ?? "dataMax"] as [number | string, number | string] }
      : yTickInfo
        ? { ticks: yTickInfo.ticks, domain: yTickInfo.domain }
        : {};
    const requestedBarFloor = isBarType && config.yAxisMin !== undefined && config.yAxisMin > 0 ? config.yAxisMin : null;

    // Use custom colors from Claude if provided, otherwise default palette
    const colors = config.colors && config.colors.length > 0 ? config.colors : DEFAULT_CHART_COLORS;
    const usePieLegend = config.type === "pie" && shouldUsePieLegend(chartData, config.xAxis);

    const tooltipContentStyle = {
      borderRadius: 4,
      border: "none",
      fontSize: 12,
      fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
      boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
      background: "#1e3a5f",
      color: "#ffffff",
      padding: "8px 12px",
      lineHeight: "1.5",
    };
    const tooltipLabelFormatter = (label: unknown) => {
      const base = daily
        ? formatDateFull(String(label ?? ""))
        : ym
          ? formatYearMonth(String(label ?? ""))
          : String(label ?? "");
      return isPartialX(label) ? `${base} (${partialLabel.get(String(label))})` : base;
    };

    return (
      <div ref={receiptRef} className="h-full flex flex-col" style={{ background: "#F5F0E8" }}>
        {config.title && (
          <div
            className="text-[16px] sm:text-[20px]"
            style={{
              textAlign: "center",
              fontFamily: "'Bricolage Grotesque', 'DM Sans', sans-serif",
              fontWeight: 800,
              color: "#1e2a35",
              padding: "8px 12px 0",
              overflowWrap: "break-word",
              wordBreak: "break-word",
            }}
          >
            {config.title}
          </div>
        )}
        <ResponsiveContainer width="100%" height="100%" minHeight={sidewaysMinHeight || undefined} onResize={(w) => setBoxWidth(w)}>
          {config.type === "scatter" ? (
            <ScatterChart
              data={chartData}
              margin={{ top: 20, right: 24, bottom: 24, left: 8 }}
            >
              <CartesianGrid horizontal vertical stroke={GRID_COLOR} strokeWidth={1} />
              <XAxis
                type="number"
                dataKey={config.xAxis}
                name={properCase(config.xAxis)}
                domain={["auto", "auto"]}
                padding={{ left: 12, right: 12 }}
                tickFormatter={formatAxisValue}
                tick={TICK_STYLE}
                tickLine={X_AXIS_TICK_LINE_STYLE}
                axisLine={X_AXIS_LINE_STYLE}
                {...(config.xAxisLabel ? { label: { value: config.xAxisLabel, position: "insideBottom", offset: -12, style: { fontSize: 11, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif" } } } : {})}
              />
              <YAxis
                type="number"
                dataKey={effectiveYKeys[0]}
                name={properCase(effectiveYKeys[0])}
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={valueAxisLabelWidth}
                padding={{ top: 12, bottom: 12 }}
                {...yAxisScaleProps}
                {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 0, dy: -10, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})}
              />
              <ZAxis range={[48, 48]} />
              <Tooltip
                cursor={{ strokeDasharray: "3 3" }}
                content={({ active, payload }) => {
                  // Recharts scatter tooltips have no label row, so labelFormatter
                  // never renders — custom content is required to show the
                  // entity (city/agency) name for each point.
                  if (!active || !payload?.length) return null;
                  const row = payload[0]?.payload as Record<string, unknown> | undefined;
                  const entity = scatterEntityLabel(row);
                  return (
                    <div style={tooltipContentStyle}>
                      {entity && <div style={{ fontWeight: 600, marginBottom: 4 }}>{entity}</div>}
                      {payload.map((p) => (
                        <div key={String(p.name)}>{String(p.name)}: {fmtVal(p.value as number, isPercent)}</div>
                      ))}
                    </div>
                  );
                }}
              />
              <Scatter
                name={properCase(effectiveYKeys[0])}
                data={chartData}
                fill={colors[0]}
              />
            </ScatterChart>
          ) : config.type === "line" ? (
            <LineChart
              data={chartData}
              margin={{ top: 20, right: 24, bottom: 8, left: leftMargin }}
            >
              <CartesianGrid horizontal vertical={false} stroke={GRID_COLOR} strokeWidth={1} />
              <XAxis
                dataKey={xAxisDataKey}
                tick={TICK_STYLE}
                tickLine={X_AXIS_TICK_LINE_STYLE}
                axisLine={X_AXIS_LINE_STYLE}
                {...plainYearXAxisProps(plainYears, "line")}
                tickFormatter={
                  daily ? (v) => formatDateTickLabel(v, dailySingleYear)
                  : singleYearMonthly ? (v) => formatMonthOnly(v)
                  : fewYearsMonthly ? (v) => formatYearMonth(v)
                  : ym ? (v: string | number) => String(v).slice(0, 4)
                  : plainYears ? (v: number) => String(v)
                  : undefined
                }
                {...(yearTicks.length > 0 ? { ticks: yearTicks } : {})}
                {...(ymTicks.length > 0 ? { ticks: ymTicks } : {})}
                {...(dailyTicks.length > 0 ? { ticks: dailyTicks } : {})}
                interval={
                  yearTicks.length > 0 || ymTicks.length > 0 || dailyTicks.length > 0 ? 0
                  : daily ? dailyTickInterval(dataLen)
                  : ym ? 0
                  : "preserveStartEnd"
                }
                angle={fewYearsMonthly ? -40 : 0}
                textAnchor={fewYearsMonthly ? "end" : "middle"}
                height={fewYearsMonthly ? 60 : (plainYears || ym || daily) ? 34 : undefined}
              />
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={valueAxisLabelWidth}
                {...yAxisScaleProps}
                {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 0, dy: -10, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})}
              />
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v, name, props) => {
                  const label = props?.payload?.data_type
                    ? String(props.payload.data_type).replace(/\*$/, "")
                    : name;
                  return [fmtVal(v as number, isPercent), label];
                }}
                contentStyle={tooltipContentStyle}
                labelStyle={{ color: "#ffffff" }}
                itemStyle={{ color: "#ffffff" }}
              />
              {multiSeries && (
                <Legend
                  verticalAlign="top"
                  align="left"
                  iconType="plainline"
                  iconSize={16}
                  wrapperStyle={{
                    fontSize: 12,
                    fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
                    color: "#1e2a35",
                    paddingBottom: 8,
                  }}
                />
              )}
              {effectiveYKeys.map((y, i) => {
                const color = colors[i % colors.length];
                const present = (k: number) => k >= 0 && k < chartData.length && chartData[k][y] != null && chartData[k][y] !== "";
                const renderDot = (props: { cx?: number; cy?: number; index?: number; payload?: Record<string, unknown> }) => {
                  const { cx, cy, index = -1, payload } = props;
                  const key = `dot-${y}-${index}`;
                  if (cx == null || cy == null || !present(index)) return <g key={key} />;
                  const x = payload?.[xAxisDataKey];
                  if (isPartialX(x)) {
                    return (
                      <g key={key} data-partial-period={String(x)}>
                        <circle cx={cx} cy={cy} r={5} fill="#F5F0E8" stroke={color} strokeWidth={2} />
                        {i === 0 && (
                          <text x={cx} y={cy - 10} textAnchor="end" fontSize={11} fill="#1e2a35" fontFamily="'DM Sans', 'Segoe UI', Arial, sans-serif">
                            {partialLabel.get(String(x))}
                          </text>
                        )}
                      </g>
                    );
                  }
                  const isolated = !present(index - 1) && !present(index + 1);
                  return isolated ? <circle key={key} cx={cx} cy={cy} r={3.5} fill={color} data-isolated-observation="1" /> : <g key={key} />;
                };
                return (
                  <Line
                    key={y}
                    type="linear"
                    dataKey={y}
                    name={properCase(y)}
                    stroke={color}
                    strokeWidth={2.5}
                    connectNulls={false}
                    dot={renderDot}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: color }}
                  />
                );
              })}
              {config.annotations?.map((a, i) => (
                <ReferenceLine
                  key={`ann-${i}`}
                  {...(a.axis === "x" ? { x: a.value } : { y: a.value })}
                  stroke={a.color || "#999"}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif" } : undefined}
                />
              ))}
            </LineChart>
          ) : config.type === "bar" || config.type === "stacked_bar" ? (
            <BarChart
              data={chartData}
              layout={sideways ? "vertical" : "horizontal"}
              margin={{ top: 20, right: 24, bottom: (ym || daily || plainYears) ? 8 : 4, left: leftMargin }}
            >
              <CartesianGrid horizontal={!sideways} vertical={sideways} stroke={GRID_COLOR} strokeWidth={1} />
              {sideways ? (
                <XAxis type="number" tickFormatter={yTickFormatter} tick={TICK_STYLE} tickLine={false} axisLine={false} {...yAxisScaleProps}
                {...(config.yAxisLabel ? { height: 42, label: { value: config.yAxisLabel, position: "insideBottom", offset: 0, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})} />
              ) : (
              <XAxis
                dataKey={xAxisDataKey}
                {...plainYearXAxisProps(plainYears, "bar")}
                tick={wrapCategories ? (p: object) => <WrappedCategoryTick {...p} /> : TICK_STYLE}
                tickLine={X_AXIS_TICK_LINE_STYLE}
                axisLine={X_AXIS_LINE_STYLE}
                tickFormatter={
                  daily ? (v: string) => formatDateTickLabel(v, dailySingleYear)
                  : singleYearMonthly ? (v: string) => formatMonthOnly(v)
                  : fewYearsMonthly ? (v: string) => formatYearMonth(v)
                  : ym ? (v: string) => String(v).slice(0, 4)
                  : plainYears ? (v: number) => String(v)
                  : (v: string) => String(v)
                }
                angle={fewYearsMonthly ? -40 : (ym || daily || plainYears || wrapCategories) ? 0 : -45}
                textAnchor={fewYearsMonthly ? "end" : (ym || daily || plainYears || wrapCategories) ? "middle" : "end"}
                {...(yearTicks.length > 0 ? { ticks: yearTicks } : {})}
                {...(ymTicks.length > 0 ? { ticks: ymTicks } : {})}
                {...(dailyTicks.length > 0 ? { ticks: dailyTicks } : {})}
                interval={
                  yearTicks.length > 0 || ymTicks.length > 0 || dailyTicks.length > 0 ? 0
                  : daily ? dailyTickInterval(dataLen)
                  : 0
                }
                height={fewYearsMonthly ? 60 : (ym || daily || plainYears) ? 30 : wrapCategories ? wrappedLabelHeight : slantedLabelHeight}
              />
              )}
              {sideways ? (
                <YAxis type="category" dataKey={xAxisDataKey} width={sideLabelWidth} interval={0} tickLine={false} axisLine={X_AXIS_LINE_STYLE}
                  tick={(p: object) => <SideCategoryTick {...p} labelWidth={sideLabelWidth} />} />
              ) : (
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={valueAxisLabelWidth}
                {...yAxisScaleProps}
                {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 0, dy: -10, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})}
              />
              )}
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v, name, props) => {
                  const label = props?.payload?.data_type
                    ? String(props.payload.data_type).replace(/\*$/, "")
                    : name;
                  return [fmtVal(v as number, isPercent), label];
                }}
                contentStyle={tooltipContentStyle}
                labelStyle={{ color: "#ffffff" }}
                itemStyle={{ color: "#ffffff" }}
              />
              {multiSeries && (
                <Legend
                  verticalAlign="top"
                  align="left"
                  iconType="rect"
                  iconSize={12}
                  wrapperStyle={{
                    fontSize: 12,
                    fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
                    color: "#1e2a35",
                    paddingBottom: 8,
                  }}
                />
              )}
              {effectiveYKeys.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={y}
                  name={properCase(y)}
                  fill={colors[i % colors.length]}
                  radius={sideways ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                  stackId={config.type === "stacked_bar" ? "a" : undefined}
                >
                  {chartData.map((d, k) => (
                    <Cell key={`bar-${y}-${k}`} fillOpacity={isPartialX(d[xAxisDataKey]) ? 0.4 : 1} />
                  ))}
                  {i === effectiveYKeys.length - 1 && partialLabel.size > 0 && (
                    <LabelList
                      dataKey={xAxisDataKey}
                      position="top"
                      formatter={(v: unknown) => (isPartialX(v) ? partialLabel.get(String(v)) : "")}
                      style={{ fontSize: 11, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif" }}
                    />
                  )}
                </Bar>
              ))}
              {config.annotations?.map((a, i) => (
                <ReferenceLine
                  key={`ann-${i}`}
                  {...((a.axis === "x") !== sideways ? { x: a.value } : { y: a.value })}
                  stroke={a.color || "#999"}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={a.label ? { value: a.label, position: (a.axis === "x") !== sideways ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif" } : undefined}
                />
              ))}
            </BarChart>
          ) : config.type === "pie" ? (
            <PieChart>
              <Pie
                data={chartData}
                dataKey={effectiveYKeys[0]}
                nameKey={config.xAxis}
                cx="50%"
                cy="50%"
                outerRadius={usePieLegend ? "60%" : "70%"}
                innerRadius="20%"
                strokeWidth={2}
                stroke="#fff"
                label={usePieLegend ? false : ({ name, percent }) =>
                  `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
                labelLine={{ stroke: "#b0a99f", strokeWidth: 1 }}
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              {usePieLegend && (
                <Legend
                  verticalAlign="bottom"
                  align="center"
                  iconType="circle"
                  iconSize={10}
                  wrapperStyle={{ fontSize: 11, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", color: "#1e2a35" }}
                />
              )}
              <Tooltip
                formatter={(v) => fmtVal(v as number, isPercent)}
                contentStyle={tooltipContentStyle}
                labelStyle={{ color: "#ffffff" }}
                itemStyle={{ color: "#ffffff" }}
              />
            </PieChart>
          ) : null}
        </ResponsiveContainer>
        {requestedBarFloor !== null && (
          <div style={{ color: "#5a6a7a", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", fontSize: "11px", padding: "2px 0 0" }} data-requested-axis-floor={requestedBarFloor}>
            Y-axis starts at {requestedBarFloor}, as requested; bar heights are not proportional to the values.
          </div>
        )}
        {hasEmployeesDisclaimer && (
          <div
            style={{
              color: "#5a6a7a",
              fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
              fontSize: "9.5px",
              fontStyle: "italic",
              padding: "2px 0 0",
            }}
          >
            * Employees shown for {employeesYears.join(", ")} — FBI did not report officer/civilian breakdown those years
          </div>
        )}
        <div
          className="shrink-0 pb-1 pt-1"
          style={{ marginTop: "2px" }}
        >
          <div
            style={{
              color: "#5a6a7a",
              fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
              fontSize: "11px",
              fontVariant: "small-caps",
              letterSpacing: "0.2px",
            }}
          >
            Source: {meta?.source || "Crime Index"}
            {meta && meta.agencyCount > 0 && (
              <>
                <span style={{ color: "#c5bfb8", margin: "0 5px" }}>|</span>
                {meta.agencyCount.toLocaleString()} {meta.agencyCount === 1 ? "agency" : "agencies"}
                {meta.population && (
                  <>
                    <span style={{ color: "#c5bfb8", margin: "0 5px" }}>|</span>
                    Pop. {formatPopulation(meta.population)}
                  </>
                )}
              </>
            )}
          </div>
          {/* Owner 2026-10-26: the sample and a partial last year are stated in the chart itself, so they stay with a
              copied or saved image (and an embedded chart), which carry no answer text. */}
          {chartNotes(meta).map((n) => (
            <div key={n} data-chart-note="1" style={{ color: "#5a6a7a", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", fontSize: "11px", letterSpacing: "0.2px" }}>
              {n}
            </div>
          ))}
        </div>
      </div>
    );
}

function ChartPanel(props: ChartPanelProps) {
  if (!props.config || props.config.type === "none" || props.rows.length === 0) return null;
  return <RenderedChartPanel {...props} />;
}

export default ChartPanel;
