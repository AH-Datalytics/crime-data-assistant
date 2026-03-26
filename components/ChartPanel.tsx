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
} from "recharts";
import type { ChartConfig, ChartMeta } from "@/lib/types";
import { formatAxisValue } from "@/lib/utils";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const NYT_COLORS = [
  "#d03c24",
  "#1a6b54",
  "#4a7fb5",
  "#e6a019",
  "#7b5ea7",
  "#888888",
  "#c45a3c",
  "#2d8f83",
];

const TICK_STYLE = {
  fontSize: 12,
  fill: "#999",
  fontFamily: "Georgia, 'Times New Roman', serif",
};

const GRID_COLOR = "#eaeaea";

function properCase(s: string): string {
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
  return titled.replace(/\bDc\b/g, "DC").replace(/\bNy\b/g, "NY").replace(/\bNyc\b/g, "NYC").replace(/\bLa\b/g, "LA").replace(/\bUs\b/g, "US");
}

function isYearMonth(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.every((d) => /^\d{6}$/.test(String(d[xKey] ?? "")));
}

function isDate(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return (
    sample.length > 0 &&
    sample.every((d) => /^(19|20)\d{6}$/.test(String(d[xKey] ?? "")))
  );
}

function formatYearMonth(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4)} ${s.slice(0, 4)}`;
}

function formatYearMonthTick(val: string | number, index: number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const mm = s.slice(4, 6);
  if (mm === "01" || index === 0) return s.slice(0, 4);
  return "";
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

/** Build evenly-spaced ticks for multi-year YYYYMM data.
 *  ≤2 years → every month, otherwise January of each year (thinned if >10). */
function yearTicksForYM(data: Record<string, unknown>[], xKey: string): string[] {
  const vals = data.map((d) => String(d[xKey] ?? "")).filter((v) => /^\d{6}$/.test(v));
  if (vals.length === 0) return [];
  const years = [...new Set(vals.map((v) => v.slice(0, 4)))].sort();

  // ≤2 years of data → show every month
  if (years.length <= 2) {
    return vals;
  }

  // pick January of each year that exists in the data
  const ticks: string[] = [];
  for (const y of years) {
    const jan = `${y}01`;
    if (vals.includes(jan)) ticks.push(jan);
  }
  // if too many ticks (>10), thin them out evenly
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

/** Build evenly-spaced ticks for plain-year x-axis data.
 *  ≤20 years → every year, ≤50 → every 5, otherwise every 10 (decade). */
function decadeTicksForYears(data: Record<string, unknown>[], xKey: string): number[] {
  const years = data
    .map((d) => Number(d[xKey]))
    .filter((y) => !isNaN(y) && y >= 1900 && y <= 2100);
  if (years.length === 0) return [];
  const min = Math.min(...years);
  const max = Math.max(...years);
  const span = max - min;
  const step = span <= 20 ? 1 : span <= 50 ? 5 : 10;
  const first = step === 1 ? min : Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let y = first; y <= max; y += step) {
    ticks.push(y);
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
}

function ChartPanel({ config, rows, meta }: ChartPanelProps) {
    if (!config || config.type === "none" || rows.length === 0) return null;

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

    const dataYears = new Set(
      data.map((d) => String(d[daily ? config.xAxis : xKey] ?? "").slice(0, 4))
    );
    const singleYear = dataYears.size === 1;
    const singleYearMonthly = ym && data.length > 0 && singleYear;

    const multiSeries = config.yAxis.length > 1;
    const dataLen = data.length;

    const xAxisDataKey = daily ? config.xAxis : ym ? xKey : config.xAxis;

    // Detect plain-year x-axis (historical queries)
    const plainYears = !ym && !daily && isPlainYears(data, xAxisDataKey);
    const yearTicks = plainYears ? decadeTicksForYears(data, xAxisDataKey) : [];

    // Compute explicit tick positions for even spacing
    const fewYearsMonthly = ym && !singleYearMonthly && dataYears.size <= 2;
    const ymTicks = ym && !singleYearMonthly ? yearTicksForYM(data, xKey) : [];
    const dailyTicks = daily ? monthTicksForDaily(data, config.xAxis) : [];
    const dailySingleYear = daily && new Set(dailyTicks.map(t => t.slice(0, 4))).size <= 1;

    // Detect clearance/percentage y-axis columns (NOT per-100K rates)
    // Only column names with clearance/_clr/_pct/percent trigger % formatting.
    // _rate columns are NOT treated as percentages — they are per-100K rates.
    const isPercent = config.yAxis.some((y) =>
      /clearance|_clr|_pct|percent/i.test(y)
    ) && config.yAxis.every((y) =>
      !/count|total|population|pop/i.test(y)
    );
    const yTickFormatter = isPercent
      ? (v: number) => `${v}%`
      : formatAxisValue;

    // Use custom colors from Claude if provided, otherwise default palette
    const colors = config.colors && config.colors.length > 0 ? config.colors : NYT_COLORS;

    const tooltipContentStyle = {
      borderRadius: 4,
      border: "1px solid #ddd",
      fontSize: 12,
      fontFamily: "Georgia, 'Times New Roman', serif",
      boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
    };
    const tooltipLabelFormatter = (label: unknown) =>
      daily
        ? formatDateFull(String(label ?? ""))
        : ym
          ? formatYearMonth(String(label ?? ""))
          : String(label ?? "");

    return (
      <div className="bg-white h-full flex flex-col">
        <ResponsiveContainer width="100%" height="100%">
          {config.type === "line" ? (
            <LineChart
              data={data}
              margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
            >
              <CartesianGrid horizontal vertical={false} stroke={GRID_COLOR} strokeWidth={1} />
              <XAxis
                dataKey={xAxisDataKey}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                {...(plainYears ? { type: "number" as const, domain: ["dataMin", "dataMax"] as const } : {})}
                tickFormatter={
                  daily ? (v) => formatDateTickLabel(v, dailySingleYear)
                  : singleYearMonthly ? (v) => formatYearMonth(v)
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
                height={fewYearsMonthly ? 60 : undefined}
              />
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={isPercent ? 55 : 50}
                {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "#999", fontFamily: "Georgia, 'Times New Roman', serif" } } } : {})}
              />
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v) => { const n = Number(v); if (isPercent) return `${Number.isInteger(n) ? n : n.toFixed(1)}%`; return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1); }}
                contentStyle={tooltipContentStyle}
              />
              {multiSeries && (
                <Legend
                  verticalAlign="top"
                  align="left"
                  iconType="line"
                  iconSize={16}
                  wrapperStyle={{
                    fontSize: 12,
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    paddingBottom: 8,
                  }}
                />
              )}
              {config.yAxis.map((y, i) => {
                const color = colors[i % colors.length];
                return (
                  <Line
                    key={y}
                    type="monotone"
                    dataKey={y}
                    name={properCase(y)}
                    stroke={color}
                    strokeWidth={3}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 0, fill: color }}
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
                  label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "Georgia, 'Times New Roman', serif" } : undefined}
                />
              ))}
            </LineChart>
          ) : config.type === "bar" || config.type === "stacked_bar" ? (
            <BarChart
              data={data}
              margin={{ top: 10, right: 20, bottom: ym || daily ? 20 : 80, left: 10 }}
            >
              <CartesianGrid horizontal vertical={false} stroke={GRID_COLOR} strokeWidth={1} />
              <XAxis
                dataKey={xAxisDataKey}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={
                  daily ? (v: string) => formatDateTickLabel(v, dailySingleYear)
                  : singleYearMonthly ? (v: string) => formatYearMonth(v)
                  : fewYearsMonthly ? (v: string) => formatYearMonth(v)
                  : ym ? (v: string) => String(v).slice(0, 4)
                  : plainYears ? (v: number) => String(v)
                  : (v: string) => String(v).length > 20 ? String(v).slice(0, 18) + "…" : String(v)
                }
                angle={fewYearsMonthly ? -40 : (ym || daily || plainYears) ? 0 : -40}
                textAnchor={fewYearsMonthly ? "end" : (ym || daily || plainYears) ? "middle" : "end"}
                {...(yearTicks.length > 0 ? { ticks: yearTicks } : {})}
                {...(ymTicks.length > 0 ? { ticks: ymTicks } : {})}
                {...(dailyTicks.length > 0 ? { ticks: dailyTicks } : {})}
                interval={
                  yearTicks.length > 0 || ymTicks.length > 0 || dailyTicks.length > 0 ? 0
                  : daily ? dailyTickInterval(dataLen)
                  : 0
                }
                height={fewYearsMonthly ? 60 : (ym || daily || plainYears) ? 30 : 100}
              />
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={isPercent ? 55 : 50}
                {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", style: { fontSize: 11, fill: "#999", fontFamily: "Georgia, 'Times New Roman', serif" } } } : {})}
              />
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v) => { const n = Number(v); if (isPercent) return `${Number.isInteger(n) ? n : n.toFixed(1)}%`; return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1); }}
                contentStyle={tooltipContentStyle}
              />
              {multiSeries && (
                <Legend
                  verticalAlign="top"
                  align="left"
                  iconType="rect"
                  iconSize={12}
                  wrapperStyle={{
                    fontSize: 12,
                    fontFamily: "Georgia, 'Times New Roman', serif",
                    paddingBottom: 8,
                  }}
                />
              )}
              {config.yAxis.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={y}
                  name={properCase(y)}
                  fill={colors[i % colors.length]}
                  radius={[2, 2, 0, 0]}
                  stackId={config.type === "stacked_bar" ? "a" : undefined}
                />
              ))}
              {config.annotations?.map((a, i) => (
                <ReferenceLine
                  key={`ann-${i}`}
                  {...(a.axis === "x" ? { x: a.value } : { y: a.value })}
                  stroke={a.color || "#999"}
                  strokeDasharray="4 4"
                  strokeWidth={1.5}
                  label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "Georgia, 'Times New Roman', serif" } : undefined}
                />
              ))}
            </BarChart>
          ) : config.type === "pie" ? (
            <PieChart>
              <Pie
                data={data}
                dataKey={config.yAxis[0]}
                nameKey={config.xAxis}
                cx="50%"
                cy="50%"
                outerRadius="70%"
                strokeWidth={1}
                stroke="#fff"
                label={({ name, percent }) =>
                  `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v) => { const n = Number(v); if (isPercent) return `${Number.isInteger(n) ? n : n.toFixed(1)}%`; return Number.isInteger(n) ? n.toLocaleString() : n.toFixed(1); }}
                contentStyle={tooltipContentStyle}
              />
            </PieChart>
          ) : null}
        </ResponsiveContainer>
        <div
          className="text-[10px] -mt-2 shrink-0 pb-1"
          style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Source: {meta?.source || "Real-Time Crime Index"}
          {meta && meta.agencyCount > 0 && (
            <>
              {" · "}
              {meta.agencyCount.toLocaleString()} {meta.agencyCount === 1 ? "agency" : "agencies"}
              {meta.population && ` · Pop. ${formatPopulation(meta.population)}`}
            </>
          )}
        </div>
      </div>
    );
}

export default ChartPanel;
