"use client";

import { useEffect, useState } from "react";
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
} from "recharts";
import type { ChartConfig } from "@/lib/types";
import { formatAxisValue, fmtVal, decadeTicksForYears, scatterEntityLabel } from "@/lib/utils";
import { plainYearXAxisProps } from "@/lib/chart-axis";
import {
  DEFAULT_CHART_COLORS,
  detectAndPivotChartData,
  niceYTicks,
  shouldUsePieLegend,
} from "@/lib/chart-layout";
import { useChartRenderReceipt } from "./useChartRenderReceipt";
import { SIDEWAYS_MIN_BAR, SideCategoryTick, WrappedCategoryTick } from "./ChartPanel";
import { resetTickTextCache, MAX_SLANTED_AXIS, slantedAxisHeight, slantedLeftMargin, sideLabelWidth as measuredSideLabelWidth, valueAxisWidth, wrapLabel, wrappedAxisHeight } from "@/lib/chart-text";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const TICK_STYLE = {
  fontSize: 13,
  fill: "#1e2a35",
  fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
};

const GRID_COLOR = "#ddd8ce";
const X_AXIS_LINE_STYLE = { stroke: "#b8b0a5", strokeWidth: 1 };
const X_AXIS_TICK_LINE_STYLE = { stroke: "#b8b0a5", strokeWidth: 1 };

function properCase(s: string): string {
  if (/^rolling_\d+m?$/i.test(s) || /^rolling_\d+_month$/i.test(s)) {
    const n = s.match(/\d+/)?.[0] || "12";
    return `Rolling ${n}-Month`;
  }
  const titled = s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return titled.replace(/\bDc\b/g, "DC").replace(/\bNy\b/g, "NY").replace(/\bNyc\b/g, "NYC").replace(/\bLa\b/g, "LA").replace(/\bUsa\b/g, "USA").replace(/\bUs\b/g, "US");
}

export function isNibrsYearMonth(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.length > 0 && sample.every((d) => /^\d{6}$|^\d{4}-\d{2}$/.test(String(d[xKey] ?? "")));
}

function isDate(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.length > 0 && sample.every((d) => /^(19|20)\d{6}$/.test(String(d[xKey] ?? "")));
}

function formatYearMonth(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$|^\d{4}-\d{2}$/.test(s)) return s;
  const m = parseInt(s.includes("-") ? s.slice(5, 7) : s.slice(4, 6), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4)} ${s.slice(0, 4)}`;
}

export function formatNibrsMonthOnly(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$|^\d{4}-\d{2}$/.test(s)) return s;
  const m = parseInt(s.includes("-") ? s.slice(5, 7) : s.slice(4, 6), 10);
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

/** Build one representative tick per year for multi-year YYYYMM data. */
export function nibrsYearTicksForYM(data: Record<string, unknown>[], xKey: string): string[] {
  const vals = data.map((d) => String(d[xKey] ?? "")).filter((v) => /^\d{6}$|^\d{4}-\d{2}$/.test(v));
  if (vals.length === 0) return [];
  const years = [...new Set(vals.map((v) => v.slice(0, 4)))].sort();

  // One representative tick per year prevents 13-24 month charts from
  // rendering every monthly label on top of its neighbors.

  const ticks: string[] = [];
  for (const y of years) {
    const jan = vals.find((value) => value === `${y}01` || value === `${y}-01`);
    const first = vals.find((value) => value.startsWith(y));
    if (jan || first) ticks.push(jan ?? first!);
  }
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
  const months = new Map<string, string>();
  for (const v of vals) {
    const ym = v.slice(0, 6);
    if (!months.has(ym)) months.set(ym, v);
  }
  let ticks = [...months.values()];
  if (ticks.length > 14) {
    const yearTicks: string[] = [];
    const seen = new Set<string>();
    for (const [ym, val] of months) {
      const y = ym.slice(0, 4);
      if (ym.slice(4) === "01" && !seen.has(y)) { seen.add(y); yearTicks.push(val); }
    }
    ticks = yearTicks;
  }
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

interface NibrsChartPanelProps {
  config: ChartConfig;
  rows: Record<string, unknown>[];
  requestId?: string;
}

function RenderedNibrsChartPanel({ config, rows, requestId }: NibrsChartPanelProps) {
  const hasYearMonth = rows.length > 0 && "year" in rows[0] && "month" in rows[0];

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
  const ym = hasYearMonth || isNibrsYearMonth(data, config.xAxis);
  const daily = !ym && isDate(data, config.xAxis);

  // Auto-pivot long-format data (e.g. year × category → grouped series)
  const { data: chartData, effectiveYKeys, seriesOverflow } = config.type === "scatter"
    ? { data, effectiveYKeys: config.yAxis, seriesOverflow: false }
    : detectAndPivotChartData(data, xKey, config.yAxis);

  const dataYears = new Set(
    chartData.map((d) => String(d[daily ? config.xAxis : xKey] ?? "").slice(0, 4))
  );
  const singleYear = dataYears.size === 1;
  const singleYearMonthly = ym && chartData.length > 0 && singleYear;
  const fewYearsMonthly = false;

  const multiSeries = effectiveYKeys.length > 1;
  const dataLen = chartData.length;
  const xAxisDataKey = daily ? config.xAxis : ym ? xKey : config.xAxis;
  const receiptRef = useChartRenderReceipt({ requestId, component: "NibrsChartPanel", chartType: config.type, effectiveXKey: xAxisDataKey, effectiveYKeys });
  const [boxWidth, setBoxWidth] = useState(0);
  // Labels are measured in the tick font; measure again once the page's fonts have loaded.
  const [, setFontsReady] = useState(0);
  useEffect(() => {
    if (typeof document === "undefined" || !document.fonts) return;
    let live = true;
    void document.fonts.ready.then(() => { if (live) { resetTickTextCache(); setFontsReady((n) => n + 1); } });
    return () => { live = false; };
  }, []);
  if (seriesOverflow) return null;

  // Detect plain-year x-axis (multi-year queries)
  const plainYears = !ym && !daily && isPlainYears(data, xAxisDataKey);
  const yearTicks = plainYears ? decadeTicksForYears(data, xAxisDataKey) : [];
  // Owner 2026-10-25 ("the labels don't fit"): as in ChartPanel, few category bars get flat wrapped labels, and slanted
  // labels are never cut off.
  const wrapCategories = !ym && !daily && !plainYears && dataLen <= 8;
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
  const ymTicks = ym && !singleYearMonthly ? nibrsYearTicksForYM(data, xKey) : [];
  const dailyTicks = daily ? monthTicksForDaily(data, config.xAxis) : [];
  const dailySingleYear = daily && new Set(dailyTicks.map(t => t.slice(0, 4))).size <= 1;

  // Detect clearance/percentage y-axis columns (NOT per-100K rates)
  // Only column names with clearance/_clr/_pct/percent trigger % formatting.
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
  const yTickInfo = niceYTicks(chartData, effectiveYKeys, config.type === "stacked_bar");
  // The value axis is as wide as its widest formatted tick, never narrower than before.
  const valueAxisLabelWidth = Math.max(isPercent ? 55 : 50, yTickInfo ? valueAxisWidth(yTickInfo.ticks.map((v) => String(yTickFormatter(v)))) : 0);
  // Slanted category labels: room at the left for the first one (it reaches left of its tick).
  const slanted = !sideways && !wrapCategories && !ym && !daily && !plainYears && !fewYearsMonthly;
  const leftMargin = slanted && categoryLabels.length ? slantedLeftMargin(categoryLabels[0], valueAxisLabelWidth, boxWidth, dataLen) : 8;
  const yAxisScaleProps = config.yAxisMin !== undefined || config.yAxisMax !== undefined
    ? { domain: [config.yAxisMin ?? "dataMin", config.yAxisMax ?? "dataMax"] as [number | string, number | string] }
    : yTickInfo
      ? { ticks: yTickInfo.ticks, domain: yTickInfo.domain }
      : {};

  // Use custom colors from Claude if provided, otherwise default palette
  const chartColors = config.colors && config.colors.length > 0 ? config.colors : DEFAULT_CHART_COLORS;
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
  const tooltipLabelFormatter = (label: unknown) =>
    daily
      ? formatDateFull(String(label ?? ""))
      : ym
        ? formatYearMonth(String(label ?? ""))
        : String(label ?? "");

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
          <ScatterChart data={chartData} margin={{ top: 20, right: 24, bottom: 24, left: 8 }}>
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
              fill={chartColors[0]}
            />
          </ScatterChart>
        ) : config.type === "line" ? (
          <LineChart data={chartData} margin={{ top: 20, right: 24, bottom: 8, left: leftMargin }}>
            <CartesianGrid horizontal vertical={false} stroke={GRID_COLOR} strokeWidth={1} />
            <XAxis
              dataKey={xAxisDataKey}
              tick={TICK_STYLE}
              tickLine={X_AXIS_TICK_LINE_STYLE}
              axisLine={X_AXIS_LINE_STYLE}
              {...plainYearXAxisProps(plainYears, "line")}
              tickFormatter={
                daily ? (v) => formatDateTickLabel(v, dailySingleYear)
                : singleYearMonthly ? (v) => formatNibrsMonthOnly(v)
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
            <YAxis tickFormatter={yTickFormatter} tick={TICK_STYLE} tickLine={false} axisLine={false} width={valueAxisLabelWidth}
              {...yAxisScaleProps}
              {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 0, dy: -10, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})}
            />
            <Tooltip
              labelFormatter={tooltipLabelFormatter}
              formatter={(v) => fmtVal(v as number, isPercent)}
              contentStyle={tooltipContentStyle}
              labelStyle={{ color: "#ffffff" }}
              itemStyle={{ color: "#ffffff" }}
            />
            {multiSeries && (
              <Legend verticalAlign="top" align="left" iconType="plainline" iconSize={16}
                wrapperStyle={{ fontSize: 12, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", color: "#1e2a35", paddingBottom: 8 }}
              />
            )}
            {effectiveYKeys.map((y, i) => {
              const color = chartColors[i % chartColors.length];
              return (
                <Line key={y} type="monotone" dataKey={y} name={properCase(y)}
                  stroke={color} strokeWidth={2.5}
                  dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: "#fff", fill: color }}
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
          <BarChart data={chartData} layout={sideways ? "vertical" : "horizontal"} margin={{ top: 20, right: 24, bottom: ym || daily ? 8 : 4, left: leftMargin }}>
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
                : singleYearMonthly ? (v: string) => formatNibrsMonthOnly(v)
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
            <YAxis tickFormatter={yTickFormatter} tick={TICK_STYLE} tickLine={false} axisLine={false} width={valueAxisLabelWidth}
              {...yAxisScaleProps}
              {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 0, dy: -10, style: { fontSize: 10, fill: "#1e2a35", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", textAnchor: "middle" } } } : {})}
            />
            )}
            <Tooltip
              labelFormatter={tooltipLabelFormatter}
              formatter={(v) => fmtVal(v as number, isPercent)}
              contentStyle={tooltipContentStyle}
              labelStyle={{ color: "#ffffff" }}
              itemStyle={{ color: "#ffffff" }}
            />
            {multiSeries && (
              <Legend verticalAlign="top" align="left" iconType="rect" iconSize={12}
                wrapperStyle={{ fontSize: 12, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", color: "#1e2a35", paddingBottom: 8 }}
              />
            )}
            {effectiveYKeys.map((y, i) => (
              <Bar key={y} dataKey={y} name={properCase(y)}
                fill={chartColors[i % chartColors.length]}
                radius={sideways ? [0, 3, 3, 0] : [3, 3, 0, 0]}
                stackId={config.type === "stacked_bar" ? "a" : undefined}
              />
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
            <Pie data={chartData} dataKey={effectiveYKeys[0]} nameKey={config.xAxis}
              cx="50%" cy="50%" outerRadius={usePieLegend ? "60%" : "70%"} innerRadius="20%" strokeWidth={2} stroke="#fff"
              label={usePieLegend ? false : ({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
              labelLine={{ stroke: "#b0a99f", strokeWidth: 1 }}
            >
              {chartData.map((_, i) => (
                <Cell key={i} fill={chartColors[i % chartColors.length]} />
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
            <Tooltip formatter={(v) => fmtVal(v as number, isPercent)} contentStyle={tooltipContentStyle} labelStyle={{ color: "#ffffff" }} itemStyle={{ color: "#ffffff" }} />
          </PieChart>
        ) : null}
      </ResponsiveContainer>
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
          Source: FBI NIBRS
        </div>
      </div>
    </div>
  );
}

export default function NibrsChartPanel(props: NibrsChartPanelProps) {
  if (!props.config || props.config.type === "none" || props.rows.length === 0) return null;
  return <RenderedNibrsChartPanel {...props} />;
}
