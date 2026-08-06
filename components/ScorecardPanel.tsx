"use client";

import type { AgencyScorecardRow } from "@/lib/agency-scorecard";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel,
} from "@/lib/scorecard-format";

const CREAM = "#F5F1E8";
const SLATE = "#3A4450";
const RULE = "#3A4450";
const HAIRLINE = "#E2DCCC";
// Muted, print-appropriate against cream -- not saturated UI red/green.
const IMPROVED = "#2F6B4F";
const WORSENED = "#A83A32";

interface ScorecardPanelProps {
  agencyLabel: string;
  year: number | null;
  population: number;
  rows: AgencyScorecardRow[];
  explanation: string;
}

export default function ScorecardPanel({
  agencyLabel, year, population, rows, explanation,
}: ScorecardPanelProps) {
  const heading = agencyLabel
    ? `${agencyLabel} Crime Scorecard${year != null ? ` (${year})` : ""}`
    : "Crime Scorecard";

  // Unavailable state: render the builder's explanation inside the card so an
  // unavailable scorecard looks deliberate rather than like an empty frame.
  if (rows.length === 0) {
    return (
      <div className="h-full w-full overflow-auto p-6 sm:p-8" style={{ background: CREAM, color: SLATE }}>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">{heading}</h2>
        <p className="mt-4 max-w-prose text-sm leading-relaxed" style={{ color: SLATE }}>{explanation}</p>
        <div className="mt-8 text-[10px] uppercase tracking-wider" style={{ color: "#8A8778" }}>
          Source CrimeIndex.org
        </div>
      </div>
    );
  }

  const hasOver100 = rows.some((row) => row.clearance_rate != null && row.clearance_rate > 100);
  const numeric = "text-right tabular-nums whitespace-nowrap";

  return (
    <div
      className="h-full w-full overflow-auto p-6 sm:p-8"
      style={{ background: CREAM, color: SLATE }}
    >
      <h2 className="text-xl sm:text-2xl font-bold tracking-tight">{heading}</h2>
      {population > 0 && (
        <p className="mt-1 text-xs" style={{ color: "#8A8778" }}>
          Population {formatCount(population)}
        </p>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="pb-2 pr-4 text-left font-bold">Type</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Offenses</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>{changeHeaderLabel(year)}</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Rate per 100k</th>
              <th className={`pb-2 pl-4 font-bold ${numeric}`}>Clearance Rate</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const direction = changeDirection(row.offense_change_pct);
              const changeColor =
                direction === "improved" ? IMPROVED : direction === "worsened" ? WORSENED : SLATE;
              return (
                <tr
                  key={row.offense}
                  style={{
                    borderTop: index === 0 ? `2px solid ${RULE}` : `1px solid ${HAIRLINE}`,
                  }}
                >
                  {/* Flat layout: totals are semibold but not indented, and get no extra rules. */}
                  <td className={`py-2.5 pr-4 ${row.section ? "font-semibold" : ""}`}>{row.offense}</td>
                  <td className={`py-2.5 pl-4 ${numeric} ${row.section ? "font-semibold" : ""}`}>
                    {formatCount(row.offenses)}
                  </td>
                  {/* Colour is redundant encoding -- the minus sign carries direction, so this
                      stays correct in greyscale and for a red-green colourblind reader. */}
                  <td className={`py-2.5 pl-4 ${numeric}`} style={{ color: changeColor }}>
                    {formatChange(row.offense_change_pct)}
                  </td>
                  <td className={`py-2.5 pl-4 ${numeric}`}>{formatRate(row.rate_per_100k)}</td>
                  <td className={`py-2.5 pl-4 ${numeric}`}>
                    {formatClearance(row.clearance_rate)}
                    {row.clearance_rate != null && row.clearance_rate > 100 ? "*" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasOver100 && (
        <p className="mt-4 max-w-prose text-[11px] leading-snug" style={{ color: "#8A8778" }}>
          * Clearance rates can exceed 100% because agencies may clear cases in the current year
          that originated in prior reporting years.
        </p>
      )}

      <div className="mt-6 flex items-end justify-between">
        <div className="text-[10px] uppercase tracking-wider" style={{ color: "#8A8778" }}>
          Source CrimeIndex.org
        </div>
      </div>
    </div>
  );
}
