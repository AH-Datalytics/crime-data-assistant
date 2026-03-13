"use client";

import { forwardRef } from "react";
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
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
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

const ChartPanel = forwardRef<HTMLDivElement, ChartPanelProps>(
  ({ config, rows, meta }, ref) => {
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
      <div ref={ref} className="bg-white h-full flex flex-col">
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
                tickFormatter={
                  daily ? (v) => formatDateTickLabel(v, singleYear)
                  : singleYearMonthly ? (v) => formatYearMonth(v)
                  : ym ? formatYearMonthTick
                  : undefined
                }
                interval={daily ? dailyTickInterval(dataLen) : ym ? 0 : "preserveStartEnd"}
              />
              <YAxis
                tickFormatter={formatAxisValue}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v) => Number(v).toLocaleString()}
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
                const color = NYT_COLORS[i % NYT_COLORS.length];
                return (
                  <Line
                    key={y}
                    type="monotone"
                    dataKey={y}
                    name={properCase(y)}
                    stroke={color}
                    strokeWidth={multiSeries ? 2.5 : 3}
                    dot={false}
                    activeDot={{ r: 3, strokeWidth: 0, fill: color }}
                  />
                );
              })}
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
                  daily ? (v: string) => formatDateTickLabel(v, singleYear)
                  : singleYearMonthly ? (v: string) => formatYearMonth(v)
                  : ym ? formatYearMonthTick
                  : (v: string) => String(v).length > 20 ? String(v).slice(0, 18) + "…" : String(v)
                }
                angle={ym || daily ? 0 : -40}
                textAnchor={ym || daily ? "middle" : "end"}
                interval={daily ? dailyTickInterval(dataLen) : 0}
                height={ym || daily ? 30 : 100}
              />
              <YAxis
                tickFormatter={formatAxisValue}
                tick={TICK_STYLE}
                tickLine={false}
                axisLine={false}
                width={50}
              />
              <Tooltip
                labelFormatter={tooltipLabelFormatter}
                formatter={(v) => Number(v).toLocaleString()}
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
                  fill={NYT_COLORS[i % NYT_COLORS.length]}
                  radius={[2, 2, 0, 0]}
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
                strokeWidth={1}
                stroke="#fff"
                label={({ name, percent }) =>
                  `${name} (${((percent ?? 0) * 100).toFixed(0)}%)`
                }
              >
                {data.map((_, i) => (
                  <Cell key={i} fill={NYT_COLORS[i % NYT_COLORS.length]} />
                ))}
              </Pie>
              <Tooltip
                formatter={(v) => Number(v).toLocaleString()}
                contentStyle={tooltipContentStyle}
              />
            </PieChart>
          ) : null}
        </ResponsiveContainer>
        <div
          className="text-[10px] mt-1 shrink-0"
          style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
        >
          Source: Real-Time Crime Index
          {meta && (
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
);

ChartPanel.displayName = "ChartPanel";
export default ChartPanel;
