"use client";

import { forwardRef } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
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
} from "recharts";
import type { ChartConfig } from "@/lib/types";
import { CHART_COLORS } from "@/lib/chart-config";
import { formatAxisValue } from "@/lib/utils";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** Convert column name like "chicago" or "motor_vehicle_theft" → "Chicago" or "Motor Vehicle Theft" */
function properCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Check if xAxis values look like YYYYMM (e.g., "202401") */
function isYearMonth(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.every((d) => {
    const v = String(d[xKey] ?? "");
    return /^\d{6}$/.test(v);
  });
}

/** Check if xAxis values look like YYYYMMDD (e.g., "20240115") */
function isDate(data: Record<string, unknown>[], xKey: string): boolean {
  const sample = data.slice(0, 3);
  return sample.length > 0 && sample.every((d) => {
    const v = String(d[xKey] ?? "");
    return /^(19|20)\d{6}$/.test(v);
  });
}

/** "202401" → "Jan 2024" */
function formatYearMonth(val: string | number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4)} ${s.slice(0, 4)}`;
}

/** "202401" → "2024" — only show year on tick when month is January or first data point */
function formatYearMonthTick(val: string | number, index: number): string {
  const s = String(val);
  if (!/^\d{6}$/.test(s)) return s;
  const mm = s.slice(4, 6);
  if (mm === "01" || index === 0) return s.slice(0, 4);
  return "";
}

/** "20240115" → "Jan 15, 2024" (tooltip) */
function formatDateFull(val: string | number): string {
  const s = String(val);
  if (!/^(19|20)\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  const d = parseInt(s.slice(6, 8), 10);
  return `${MONTH_NAMES[m - 1] || s.slice(4, 6)} ${d}, ${s.slice(0, 4)}`;
}

/** Format a daily tick — always returns a label (used with calculated interval) */
function formatDateTickLabel(val: string | number, singleYear: boolean): string {
  const s = String(val);
  if (!/^(19|20)\d{6}$/.test(s)) return s;
  const m = parseInt(s.slice(4, 6), 10);
  const mon = MONTH_NAMES[m - 1] || s.slice(4, 6);
  if (singleYear) {
    return mon;
  }
  return `${mon} ${s.slice(0, 4)}`;
}

/** Calculate tick interval for daily data to show ~10-14 labels */
function dailyTickInterval(dataLength: number): number {
  if (dataLength <= 14) return 0;
  return Math.max(1, Math.floor(dataLength / 12));
}

interface ChartPanelProps {
  config: ChartConfig;
  rows: Record<string, unknown>[];
}

const ChartPanel = forwardRef<HTMLDivElement, ChartPanelProps>(
  ({ config, rows }, ref) => {
    if (!config || config.type === "none" || rows.length === 0) return null;

    // Detect year+month columns and synthesize a _ym key for charting
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

    // Use synthesized _ym if we have year+month, otherwise check raw xAxis for YYYYMM
    const xKey = hasYearMonth ? "_ym" : config.xAxis;
    const ym = hasYearMonth || isYearMonth(data, config.xAxis);
    const daily = !ym && isDate(data, config.xAxis);

    // Count distinct years in data
    const dataYears = new Set(
      data.map((d) => {
        const v = String(d[daily ? config.xAxis : xKey] ?? "");
        return v.slice(0, 4);
      })
    );
    const singleYear = dataYears.size === 1;

    // Show monthly gridlines only when data spans a single year
    const singleYearMonthly = ym && data.length > 0 && singleYear;

    return (
      <div ref={ref} className="bg-white h-full flex flex-col">
        <h3 className="text-sm font-semibold text-[var(--foreground)] mb-1 shrink-0" style={{ fontFamily: "neue-haas-grotesk-display, sans-serif" }}>
          {config.title}
        </h3>
        <ResponsiveContainer width="100%" height="100%">
          {config.type === "line" ? (
            <AreaChart data={data} margin={{ top: 5, right: 20, bottom: 25, left: 10 }}>
              <defs>
                {config.yAxis.map((y, i) => (
                  <linearGradient key={y} id={`fill_${i}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={CHART_COLORS[i % CHART_COLORS.length]} stopOpacity={0.05} />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid horizontal={true} vertical={false} strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey={daily ? config.xAxis : ym ? xKey : config.xAxis}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                tickFormatter={
                  daily ? (v) => formatDateTickLabel(v, singleYear)
                  : singleYearMonthly ? (v) => formatYearMonth(v)
                  : ym ? formatYearMonthTick
                  : undefined
                }
                interval={daily ? dailyTickInterval(data.length) : ym ? 0 : "preserveStartEnd"}
              />
              <YAxis
                tickFormatter={formatAxisValue}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(label) =>
                  daily ? formatDateFull(String(label ?? ""))
                  : ym ? formatYearMonth(String(label ?? ""))
                  : String(label ?? "")
                }
                formatter={(v) => Number(v).toLocaleString()}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 13 }}
              />
              {config.yAxis.length > 1 && <Legend />}
              {config.yAxis.map((y, i) => (
                <Area
                  key={y}
                  type="monotone"
                  dataKey={y}
                  name={properCase(y)}
                  stroke={CHART_COLORS[i % CHART_COLORS.length]}
                  strokeWidth={2}
                  fill={`url(#fill_${i})`}
                  dot={false}
                />
              ))}
            </AreaChart>
          ) : config.type === "bar" || config.type === "stacked_bar" ? (
            <BarChart data={data} margin={{ top: 5, right: 20, bottom: (ym || daily) ? 25 : 80, left: 10 }}>
              <CartesianGrid horizontal={true} vertical={false} strokeDasharray="3 3" stroke="#e5e7eb" />
              <XAxis
                dataKey={daily ? config.xAxis : ym ? xKey : config.xAxis}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={{ stroke: "#e5e7eb" }}
                tickFormatter={
                  daily ? (v) => formatDateTickLabel(v, singleYear)
                  : singleYearMonthly ? (v) => formatYearMonth(v)
                  : ym ? formatYearMonthTick
                  : undefined
                }
                angle={(ym || daily) ? 0 : -45}
                textAnchor={(ym || daily) ? "middle" : "end"}
                interval={daily ? dailyTickInterval(data.length) : 0}
                height={(ym || daily) ? 30 : 90}
              />
              <YAxis
                tickFormatter={formatAxisValue}
                tick={{ fontSize: 11, fill: "#6b7280" }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                labelFormatter={(label) =>
                  daily ? formatDateFull(String(label ?? ""))
                  : ym ? formatYearMonth(String(label ?? ""))
                  : String(label ?? "")
                }
                formatter={(v) => Number(v).toLocaleString()}
                contentStyle={{ borderRadius: 8, border: "1px solid #e5e7eb", fontSize: 13 }}
              />
              {config.yAxis.length > 1 && <Legend />}
              {config.yAxis.map((y, i) => (
                <Bar
                  key={y}
                  dataKey={y}
                  name={properCase(y)}
                  fill={CHART_COLORS[i % CHART_COLORS.length]}
                  stackId={config.type === "stacked_bar" ? "a" : undefined}
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
                label={({ name, percent }) =>
                  `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
              >
                {data.map((_, i) => (
                  <Cell
                    key={i}
                    fill={CHART_COLORS[i % CHART_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip formatter={(v) => Number(v).toLocaleString()} />
            </PieChart>
          ) : null}
        </ResponsiveContainer>
        <div className="text-[10px] text-[var(--muted-light)] mt-1">Source: Real-Time Crime Index</div>
      </div>
    );
  }
);

ChartPanel.displayName = "ChartPanel";
export default ChartPanel;
