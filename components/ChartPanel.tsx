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
import { formatAxisValue, fmtVal, decadeTicksForYears } from "@/lib/utils";

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const NYT_COLORS = [
  "#2d5f8a",   // steel blue
  "#c4652a",   // copper
  "#2a8a5a",   // forest green
  "#8040a0",   // purple
  "#b8960a",   // gold
  "#c43838",   // crimson
  "#1a8a8a",   // teal
  "#6050b0",   // indigo
];

const TICK_STYLE = {
  fontSize: 13,
  fill: "#1e2a35",
  fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
};

const GRID_COLOR = "#ddd8ce";

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

function formatMonthOnly(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  return MONTH_NAMES[m - 1] || s.slice(4);
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

/** Compute clean Y-axis ticks (multiples of 1, 2, 5, 10, 25, 50, 100, etc.)
 *  Always starts at 0 for count/rate data. Targets 4-6 ticks. */
function niceYTicks(data: Record<string, unknown>[], yKeys: string[]): { ticks: number[]; domain: [number, number] } | null {
  if (data.length === 0 || yKeys.length === 0) return null;
  let maxVal = 0;
  for (const row of data) {
    for (const key of yKeys) {
      const v = Number(row[key]);
      if (!isNaN(v) && v > maxVal) maxVal = v;
    }
  }
  if (maxVal <= 0) return null;

  // Find a nice interval that gives 4-6 ticks
  const candidates = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000, 200000, 250000, 500000, 1000000];
  let interval = 1;
  for (const c of candidates) {
    if (Math.ceil(maxVal / c) >= 3 && Math.ceil(maxVal / c) <= 7) {
      interval = c;
      break;
    }
  }
  // If no candidate fit, compute one
  if (Math.ceil(maxVal / interval) < 3 || Math.ceil(maxVal / interval) > 7) {
    const rawInterval = maxVal / 5;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawInterval)));
    const normalized = rawInterval / magnitude;
    interval = magnitude * (normalized <= 1.5 ? 1 : normalized <= 3.5 ? 2.5 : normalized <= 7.5 ? 5 : 10);
  }

  const top = Math.ceil(maxVal / interval) * interval;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += interval) {
    ticks.push(Math.round(v * 100) / 100); // avoid floating point
  }
  return { ticks, domain: [0, top] };
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

function isPlainYears(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 5);
  return sample.length > 0 && sample.every((d) => /^\d{4}$/.test(String(d[xKey] ?? "")));
}

function detectAndPivot(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[]
): { data: Record<string, unknown>[]; effectiveYKeys: string[] } {
  if (yKeys.length !== 1 || data.length === 0) return { data, effectiveYKeys: yKeys };
  const allKeys = Object.keys(data[0]).filter((k) => k !== "_ym" && k !== xKey);
  const valueKey = yKeys[0];
  const otherKeys = allKeys.filter((k) => k !== valueKey);
  if (otherKeys.length < 1) return { data, effectiveYKeys: yKeys };
  // Find the best categorical (string) column among the others
  // Prefer columns with 2-8 distinct string values
  let categoryKey: string | null = null;
  for (const key of otherKeys) {
    if (data.some((d) => typeof d[key] === "number")) continue;
    const vals = [...new Set(data.map((d) => String(d[key] ?? "")))];
    if (vals.length >= 2 && vals.length <= 8) { categoryKey = key; break; }
  }
  if (!categoryKey) return { data, effectiveYKeys: yKeys };
  const xVals = data.map((d) => d[xKey]);
  if (new Set(xVals).size === xVals.length) return { data, effectiveYKeys: yKeys };
  const categories = [...new Set(data.map((d) => String(d[categoryKey!] ?? "")))];
  const pivotMap = new Map<unknown, Record<string, unknown>>();
  for (const row of data) {
    const x = row[xKey];
    if (!pivotMap.has(x)) pivotMap.set(x, { [xKey]: x });
    const cat = String(row[categoryKey!] ?? "");
    (pivotMap.get(x) as Record<string, unknown>)[cat] = row[valueKey];
  }
  return { data: [...pivotMap.values()], effectiveYKeys: categories };
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

    // Auto-pivot long-format data (e.g. year × category → grouped series)
    const { data: chartData, effectiveYKeys } = detectAndPivot(data, xKey, config.yAxis);

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

    const xAxisDataKey = daily ? config.xAxis : ym ? xKey : config.xAxis;

    // Detect plain-year x-axis (historical queries)
    const plainYears = !ym && !daily && isPlainYears(chartData, xAxisDataKey);
    const yearTicks = plainYears ? decadeTicksForYears(chartData, xAxisDataKey) : [];

    // Compute explicit tick positions for even spacing
    const fewYearsMonthly = ym && !singleYearMonthly && dataYears.size <= 2;
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
    const yTickInfo = niceYTicks(chartData, effectiveYKeys);
    const yAxisScaleProps = config.yAxisMin !== undefined
      ? { domain: [config.yAxisMin, "dataMax"] as [number, string] }
      : yTickInfo
        ? { ticks: yTickInfo.ticks, domain: yTickInfo.domain }
        : {};

    // Use custom colors from Claude if provided, otherwise default palette
    const colors = config.colors && config.colors.length > 0 ? config.colors : NYT_COLORS;

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
      <div className="h-full flex flex-col" style={{ background: "#F5F0E8" }}>
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
        <ResponsiveContainer width="100%" height="100%">
          {config.type === "line" ? (
            <LineChart
              data={chartData}
              margin={{ top: 20, right: 24, bottom: 8, left: 8 }}
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
                height={fewYearsMonthly ? 60 : undefined}
              />
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={isPercent ? 55 : 50}
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
                return (
                  <Line
                    key={y}
                    type="monotone"
                    dataKey={y}
                    name={properCase(y)}
                    stroke={color}
                    strokeWidth={2.5}
                    dot={false}
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
              margin={{ top: 20, right: 24, bottom: (ym || daily || plainYears) ? 8 : 4, left: 8 }}
            >
              <CartesianGrid horizontal vertical={false} stroke={GRID_COLOR} strokeWidth={1} />
              <XAxis
                dataKey={xAxisDataKey}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={
                  daily ? (v: string) => formatDateTickLabel(v, dailySingleYear)
                  : singleYearMonthly ? (v: string) => formatMonthOnly(v)
                  : fewYearsMonthly ? (v: string) => formatYearMonth(v)
                  : ym ? (v: string) => String(v).slice(0, 4)
                  : plainYears ? (v: number) => String(v)
                  : (v: string) => String(v).length > 30 ? String(v).slice(0, 28) + "…" : String(v)
                }
                angle={fewYearsMonthly ? -40 : (ym || daily || plainYears) ? 0 : -45}
                textAnchor={fewYearsMonthly ? "end" : (ym || daily || plainYears) ? "middle" : "end"}
                {...(yearTicks.length > 0 ? { ticks: yearTicks.map(String) } : {})}
                {...(ymTicks.length > 0 ? { ticks: ymTicks } : {})}
                {...(dailyTicks.length > 0 ? { ticks: dailyTicks } : {})}
                interval={
                  yearTicks.length > 0 || ymTicks.length > 0 || dailyTicks.length > 0 ? 0
                  : daily ? dailyTickInterval(dataLen)
                  : 0
                }
                height={fewYearsMonthly ? 60 : (ym || daily || plainYears) ? 30 : 120}
              />
              <YAxis
                tickFormatter={yTickFormatter}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={isPercent ? 55 : 50}
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
                  radius={[3, 3, 0, 0]}
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
                  label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif" } : undefined}
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
                outerRadius="70%"
                innerRadius="20%"
                strokeWidth={2}
                stroke="#fff"
                label={({ name, percent }) =>
                  `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
                labelLine={{ stroke: "#b0a99f", strokeWidth: 1 }}
              >
                {chartData.map((_, i) => (
                  <Cell key={i} fill={colors[i % colors.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v) => fmtVal(v as number, isPercent)}
                contentStyle={tooltipContentStyle}
                labelStyle={{ color: "#ffffff" }}
                itemStyle={{ color: "#ffffff" }}
              />
            </PieChart>
          ) : null}
        </ResponsiveContainer>
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
        </div>
      </div>
    );
}

export default ChartPanel;
