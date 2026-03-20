"use client";

import {
  ResponsiveContainer,
  AreaChart,
  Area,
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

// Source: FBI CDE API — Percent of Population Coverage for 23F (Theft From Motor Vehicle)
// January of each year, 1991–2025
// https://cde.ucr.cjis.gov/LATEST/nibrs/agency/0/23F?from=01-1991&to=12-2026&type=counts
const COVERAGE_DATA = [
  { year: 1991, coverage: 10.5 },
  { year: 1992, coverage: 8.9 },
  { year: 1993, coverage: 10.3 },
  { year: 1994, coverage: 10.9 },
  { year: 1995, coverage: 10.0 },
  { year: 1996, coverage: 11.5 },
  { year: 1997, coverage: 13.9 },
  { year: 1998, coverage: 16.6 },
  { year: 1999, coverage: 18.0 },
  { year: 2000, coverage: 21.4 },
  { year: 2001, coverage: 23.2 },
  { year: 2002, coverage: 23.7 },
  { year: 2003, coverage: 25.2 },
  { year: 2004, coverage: 27.4 },
  { year: 2005, coverage: 28.3 },
  { year: 2006, coverage: 29.2 },
  { year: 2007, coverage: 29.6 },
  { year: 2008, coverage: 30.4 },
  { year: 2009, coverage: 32.3 },
  { year: 2010, coverage: 33.8 },
  { year: 2011, coverage: 34.1 },
  { year: 2012, coverage: 37.1 },
  { year: 2013, coverage: 36.5 },
  { year: 2014, coverage: 36.9 },
  { year: 2015, coverage: 38.7 },
  { year: 2016, coverage: 41.7 },
  { year: 2017, coverage: 42.1 },
  { year: 2018, coverage: 43.7 },
  { year: 2019, coverage: 51.1 },
  { year: 2020, coverage: 59.9 },
  { year: 2021, coverage: 72.8 },
  { year: 2022, coverage: 79.2 },
  { year: 2023, coverage: 83.9 },
  { year: 2024, coverage: 85.4 },
  { year: 2025, coverage: 86.9 },
];

export default function NibrsHeroChart() {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] p-5">
      <h2
        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] mb-1"
        style={{ letterSpacing: "0.6px" }}
      >
        NIBRS Population Coverage — U.S. Total
      </h2>
      <p className="text-[11px] text-[var(--muted-light)] mb-4">
        Percent of U.S. population covered by NIBRS-reporting agencies, January of each year, 1991–2025
      </p>
      <div className="h-[280px] sm:h-[380px]">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={COVERAGE_DATA}
            margin={{ top: 10, right: 20, bottom: 20, left: 10 }}
          >
            <defs>
              <linearGradient id="coverageGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#1b2a4a" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#1b2a4a" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid horizontal vertical={false} stroke="#eaeaea" strokeWidth={1} />
            <XAxis
              dataKey="year"
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              ticks={[1991, 1995, 2000, 2005, 2010, 2015, 2020, 2025]}
            />
            <YAxis
              tickFormatter={(v) => `${formatAxisValue(v)}%`}
              tick={TICK_STYLE}
              tickLine={false}
              axisLine={false}
              width={50}
              domain={[0, 100]}
            />
            <Tooltip
              formatter={(v) => [`${Number(v).toFixed(1)}%`, "Coverage"]}
              contentStyle={{
                borderRadius: 4,
                border: "1px solid #ddd",
                fontSize: 12,
                fontFamily: "Georgia, 'Times New Roman', serif",
                boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              }}
            />
            <Area
              type="monotone"
              dataKey="coverage"
              name="Coverage"
              stroke="#1b2a4a"
              strokeWidth={2.5}
              fill="url(#coverageGrad)"
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0, fill: "#1b2a4a" }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div
        className="text-[10px] mt-1"
        style={{ color: "#aaa", fontFamily: "Georgia, 'Times New Roman', serif" }}
      >
        Source: FBI Crime Data Explorer
      </div>
    </div>
  );
}
