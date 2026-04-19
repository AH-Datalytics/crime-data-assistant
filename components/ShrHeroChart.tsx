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

const TICK_STYLE = {
  fontSize: 12,
  fill: "#999",
  fontFamily: "Georgia, 'Times New Roman', serif",
};

interface ShrHeroChartProps {
  data: { year: number; pct_firearm: number }[];
}

export default function ShrHeroChart({ data }: ShrHeroChartProps) {
  if (!data || data.length === 0) return null;

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] p-5">
      <h2
        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] mb-1"
        style={{ letterSpacing: "0.6px" }}
      >
        Share of Murders Committed with a Firearm
      </h2>
      <p className="text-[11px] text-[var(--muted-light)] mb-4">
        Excludes justifiable homicides · FBI Supplementary Homicide Reports, 1976–present
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
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              type="number"
              domain={["dataMin", "dataMax"]}
              ticks={[1980, 1990, 2000, 2010, 2020]}
            />
            <YAxis
              tickFormatter={(v) => `${v}%`}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={50}
              domain={[50, 80]}
            />
            <Tooltip
              labelFormatter={(label) => String(label)}
              formatter={(v) => [`${v}%`, "Firearm %"]}
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
              dataKey="pct_firearm"
              name="Firearm %"
              stroke="#c23b22"
              strokeWidth={3}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: "#c23b22" }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div
        className="text-[10px] mt-1"
        style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        Source: FBI Supplementary Homicide Reports · Excludes justifiable homicides and manslaughter
      </div>
    </div>
  );
}
