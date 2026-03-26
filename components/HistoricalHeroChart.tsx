"use client";

import {
  ResponsiveContainer,
  LineChart,
  Line,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
} from "recharts";
import { formatAxisValue } from "@/lib/utils";

const TICK_STYLE = {
  fontSize: 12,
  fill: "#999",
  fontFamily: "Georgia, 'Times New Roman', serif",
};

interface HistoricalHeroChartProps {
  data: { year: number; murder_rate: number }[];
}

export default function HistoricalHeroChart({ data }: HistoricalHeroChartProps) {
  if (!data || data.length === 0) return null;

  const minYear = data[0].year;
  const maxYear = data[data.length - 1].year;
  const firstDecade = Math.ceil(minYear / 10) * 10;
  const ticks: number[] = [];
  for (let y = firstDecade; y <= maxYear; y += 10) {
    ticks.push(y);
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] p-5">
      <h2
        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] mb-1"
        style={{ letterSpacing: "0.6px" }}
      >
        New York City Murder Rate — Per 100,000 Population
      </h2>
      <p className="text-[11px] text-[var(--muted-light)] mb-4">
        {minYear}–{maxYear}
      </p>
      <div className="h-[280px] sm:h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
          >
            <CartesianGrid horizontal vertical={false} stroke="#eaeaea" strokeWidth={1} />
            <XAxis
              dataKey="year"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              ticks={ticks}
              tickFormatter={(v: number) => String(v)}
            />
            <YAxis
              tickFormatter={formatAxisValue}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <Tooltip
              formatter={(v) => [Number(v).toFixed(1), "Rate per 100K"]}
              contentStyle={{
                borderRadius: 4,
                border: "1px solid #ddd",
                fontSize: 12,
                fontFamily: "Georgia, 'Times New Roman', serif",
                boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              }}
            />
            <Line
              type="monotone"
              dataKey="murder_rate"
              name="Murder Rate"
              stroke="#8B5E3C"
              strokeWidth={3}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: "#8B5E3C" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div
        className="text-[10px] mt-1"
        style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        Source: FBI UCR · New York City Police Department
      </div>
    </div>
  );
}
