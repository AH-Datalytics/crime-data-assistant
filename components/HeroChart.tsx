"use client";

import { useState, useEffect } from "react";
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
  fontSize: 13,
  fill: "#1e2a35",
  fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
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

  // On narrow screens, show every other year to avoid label overlap
  const [isNarrow, setIsNarrow] = useState(false);
  useEffect(() => {
    const check = () => setIsNarrow(window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  return (
    <div className="rounded-xl border border-[var(--border)] p-5" style={{ background: "#F5F0E8" }}>
      <h2
        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] mb-1"
        style={{ letterSpacing: "0.6px" }}
      >
        National Murder Trend — Rolling 12-Month Total
      </h2>
      <p className="text-[11px] text-[var(--muted-light)] mb-4">
        National sample with complete reporting, 2018–present
      </p>
      <div className="h-[220px] sm:h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
          >
            <CartesianGrid horizontal vertical={false} stroke="#ddd8ce" strokeWidth={1} />
            <XAxis
              dataKey="_ym"
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: string) => {
                if (!/^\d{6}$/.test(v)) return v;
                const mm = v.slice(4, 6);
                if (mm !== "01") return "";
                const yr = parseInt(v.slice(0, 4), 10);
                if (isNarrow && yr % 2 !== 0) return "";
                return v.slice(0, 4);
              }}
              interval={0}
            />
            <YAxis
              tickFormatter={formatAxisValue}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={50}
              domain={[0, (max: number) => {
                const step = max <= 100 ? 10 : max <= 500 ? 50 : max <= 1000 ? 100 : max <= 5000 ? 500 : max <= 20000 ? 2500 : max <= 100000 ? 10000 : 50000;
                return Math.ceil(max / step) * step;
              }]}
              allowDecimals={false}
              tickCount={6}
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
                border: "none",
                fontSize: 12,
                fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif",
                boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
                background: "#1e3a5f",
                color: "#ffffff",
              }}
              labelStyle={{ color: "#ffffff" }}
              itemStyle={{ color: "#ffffff" }}
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
        style={{ color: "#5a6a7a", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", fontVariant: "small-caps" }}
      >
        Source: Crime Index · {agencyCount} agencies
        {population && ` · Pop. ${formatPop(population)}`}
      </div>
    </div>
  );
}
