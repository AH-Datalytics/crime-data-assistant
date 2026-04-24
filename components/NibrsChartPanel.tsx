"use client";

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
import type { ChartConfig } from "@/lib/types";
import { NIBRS_CHART_COLORS } from "@/lib/nibrs-chart-config";
import { formatAxisValue, fmtVal, decadeTicksForYears } from "@/lib/utils";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const TICK_STYLE = {
  fontSize: 11,
  fill: "#8c8c8c",
  fontFamily: "Georgia, 'Times New Roman', serif",
};

const GRID_COLOR = "#e8e4df";

function properCase(s: string): string {
  const titled = s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return titled.replace(/\bDc\b/g, "DC").replace(/\bNy\b/g, "NY").replace(/\bNyc\b/g, "NYC").replace(/\bLa\b/g, "LA").replace(/\bUsa\b/g, "USA").replace(/\bUs\b/g, "US");
}

function isYearMonth(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.every((d) => /^\d{6}$/.test(String(d[xKey] ?? "")));
}

function isDate(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.length > 0 && sample.every((d) => /^(19|20)\d{6}$/.test(String(d[xKey] ?? "")));
}

function formatYearMonth(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4)} ${s.slice(0, 4)}`;
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

  const ticks: string[] = [];
  for (const y of years) {
    const jan = `${y}01`;
    if (vals.includes(jan)) ticks.push(jan);
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
}

export default function NibrsChartPanel({ config, rows }: NibrsChartPanelProps) {
  if (!config || config.type === "none" || rows.length === 0) return null;

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
  const ym = hasYearMonth || isYearMonth(data, config.xAxis);
  const daily = !ym && isDate(data, config.xAxis);

  const dataYears = new Set(
    data.map((d) => String(d[daily ? config.xAxis : xKey] ?? "").slice(0, 4))
  );
  const singleYear = dataYears.size === 1;
  const singleYearMonthly = ym && data.length > 0 && singleYear;
  const fewYearsMonthly = ym && !singleYearMonthly && dataYears.size <= 2;

  const multiSeries = config.yAxis.length > 1;
  const dataLen = data.length;
  const xAxisDataKey = daily ? config.xAxis : ym ? xKey : config.xAxis;

  // Detect plain-year x-axis (multi-year queries)
  const plainYears = !ym && !daily && isPlainYears(data, xAxisDataKey);
  const yearTicks = plainYears ? decadeTicksForYears(data, xAxisDataKey) : [];

  // Compute explicit tick positions for even spacing
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
  const chartColors = config.colors && config.colors.length > 0 ? config.colors : NIBRS_CHART_COLORS;

  const tooltipContentStyle = {
    borderRadius: 4,
    border: "1px solid #eee",
    borderLeft: `3px solid ${chartColors[0]}`,
    fontSize: 12,
    fontFamily: "'Hanken Grotesk', Helvetica, sans-serif",
    boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
    background: "rgba(255,255,255,0.98)",
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
    <div className="bg-white h-full flex flex-col">
      <ResponsiveContainer width="100%" height="100%">
        {config.type === "line" ? (
          <LineChart data={data} margin={{ top: 20, right: 24, bottom: 8, left: 8 }}>
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
            <YAxis tickFormatter={yTickFormatter} tick={TICK_STYLE} tickLine={false} axisLine={false} width={isPercent ? 55 : 50}
              {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 15, style: { fontSize: 10, fill: "#8c8c8c", fontFamily: "Georgia, 'Times New Roman', serif", textAnchor: "middle" } } } : {})}
            />
            <Tooltip
              labelFormatter={tooltipLabelFormatter}
              formatter={(v) => fmtVal(v as number, isPercent)}
              contentStyle={tooltipContentStyle}
            />
            {multiSeries && (
              <Legend verticalAlign="top" align="left" iconType="line" iconSize={16}
                wrapperStyle={{ fontSize: 12, fontFamily: "Georgia, 'Times New Roman', serif", paddingBottom: 8 }}
              />
            )}
            {config.yAxis.map((y, i) => {
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
                label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "Georgia, 'Times New Roman', serif" } : undefined}
              />
            ))}
          </LineChart>
        ) : config.type === "bar" || config.type === "stacked_bar" ? (
          <BarChart data={data} margin={{ top: 20, right: 24, bottom: ym || daily ? 8 : 4, left: 8 }}>
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
                : (v: string) => String(v).length > 30 ? String(v).slice(0, 28) + "\u2026" : String(v)
              }
              angle={fewYearsMonthly ? -40 : (ym || daily || plainYears) ? 0 : -45}
              textAnchor={fewYearsMonthly ? "end" : (ym || daily || plainYears) ? "middle" : "end"}
              {...(yearTicks.length > 0 ? { ticks: yearTicks } : {})}
              {...(ymTicks.length > 0 ? { ticks: ymTicks } : {})}
              {...(dailyTicks.length > 0 ? { ticks: dailyTicks } : {})}
              interval={
                yearTicks.length > 0 || ymTicks.length > 0 || dailyTicks.length > 0 ? 0
                : daily ? dailyTickInterval(dataLen)
                : 0
              }
              height={fewYearsMonthly ? 60 : (ym || daily || plainYears) ? 30 : 120}
            />
            <YAxis tickFormatter={yTickFormatter} tick={TICK_STYLE} tickLine={false} axisLine={false} width={isPercent ? 55 : 50}
              {...(config.yAxisLabel ? { label: { value: config.yAxisLabel, angle: -90, position: "insideLeft", offset: 15, style: { fontSize: 10, fill: "#8c8c8c", fontFamily: "Georgia, 'Times New Roman', serif", textAnchor: "middle" } } } : {})}
            />
            <Tooltip
              labelFormatter={tooltipLabelFormatter}
              formatter={(v) => fmtVal(v as number, isPercent)}
              contentStyle={tooltipContentStyle}
            />
            {multiSeries && (
              <Legend verticalAlign="top" align="left" iconType="rect" iconSize={12}
                wrapperStyle={{ fontSize: 12, fontFamily: "Georgia, 'Times New Roman', serif", paddingBottom: 8 }}
              />
            )}
            {config.yAxis.map((y, i) => (
              <Bar key={y} dataKey={y} name={properCase(y)}
                fill={chartColors[i % chartColors.length]}
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
                label={a.label ? { value: a.label, position: a.axis === "x" ? "insideTopRight" : "insideRight", fill: a.color || "#999", fontSize: 11, fontFamily: "Georgia, 'Times New Roman', serif" } : undefined}
              />
            ))}
          </BarChart>
        ) : config.type === "pie" ? (
          <PieChart>
            <Pie data={data} dataKey={config.yAxis[0]} nameKey={config.xAxis}
              cx="50%" cy="50%" outerRadius="70%" innerRadius="20%" strokeWidth={2} stroke="#fff"
              label={({ name, percent }) => `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`}
              labelLine={{ stroke: "#b0a99f", strokeWidth: 1 }}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={NIBRS_CHART_COLORS[i % NIBRS_CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(v) => fmtVal(v as number, isPercent)} contentStyle={tooltipContentStyle} />
          </PieChart>
        ) : null}
      </ResponsiveContainer>
      <div
        className="shrink-0 pb-1 pt-1"
        style={{
          color: "#9a9590",
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontSize: "10px",
          letterSpacing: "0.2px",
          marginTop: "2px",
        }}
      >
        Source: FBI NIBRS
      </div>
    </div>
  );
}
