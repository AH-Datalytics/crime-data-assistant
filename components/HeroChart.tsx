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

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const TICK_STYLE = {
  fontSize: 12,
  fill: "#999",
  fontFamily: "Georgia, 'Times New Roman', serif",
};

interface HeroChartProps {
  data: { year: number; month: number; rolling_12: number }[];
  agencyCount: number;
  population: number | null;
}

function formatPop(pop: number): string {
  if (pop >= 1_000_000) return `${(pop / 1_000_000).toFixed(1)}M`;
  if (pop >= 1_000) return `${(pop / 1_000).toFixed(0)}K`;
  return String(pop);
}

export default function HeroChart({ data, agencyCount, population }: HeroChartProps) {
  const chartData = data.map((d) => ({
    ...d,
    _ym: `${d.year}${String(d.month).padStart(2, "0")}`,
  }));

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] p-5">
      <h2
        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] mb-1"
        style={{ letterSpacing: "0.6px" }}
      >
        National Murder Trend — Rolling 12-Month Total
      </h2>
      <p className="text-[11px] text-[var(--muted-light)] mb-4">
        National sample with complete reporting, 2018–present
      </p>
      <div className="h-[280px] sm:h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
          >
            <CartesianGrid horizontal vertical={false} stroke="#eaeaea" strokeWidth={1} />
            <XAxis
              dataKey="_ym"
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) => {
                if (!/^\d{6}$/.test(v)) return v;
                const mm = v.slice(4, 6);
                if (mm === "01") return v.slice(0, 4);
                return "";
              }}
              interval={0}
            />
            <YAxis
              tickFormatter={formatAxisValue}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={50}
            />
            <Tooltip
              labelFormatter={(label) => {
                const s = String(label);
                if (!/^\d{6}$/.test(s)) return s;
                const m = parseInt(s.slice(4, 6), 10);
                return `${MONTH_NAMES[m - 1] || s.slice(4)} ${s.slice(0, 4)}`;
              }}
              formatter={(v) => [Number(v).toLocaleString(), "Murders"]}
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
              dataKey="rolling_12"
              name="Murders"
              stroke="#d03c24"
              strokeWidth={3}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: "#d03c24" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div
        className="text-[10px] mt-1"
        style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        Source: Crime Index · {agencyCount} agencies
        {population && ` · Pop. ${formatPop(population)}`}
      </div>
    </div>
  );
}
