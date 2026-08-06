"use client";

import type { AgencyScorecardRow } from "@/lib/agency-scorecard";
import CrimeIndexLogo from "./CrimeIndexLogo";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel, SCORECARD_DISPLAY_COLUMNS,
} from "@/lib/scorecard-format";

const CREAM = "#F5F1E8";
const SLATE = "#3A4450";
const RULE = "#3A4450";
const HAIRLINE = "#E2DCCC";
// Muted, print-appropriate against cream -- not saturated UI red/green.
const IMPROVED = "#2F6B4F";
const WORSENED = "#A83A32";

// The card sizes to its own content instead of filling the pane. A scorecard is a
// fixed 9-row, 5-column object -- stretching it to an arbitrary pane width just
// spreads the same numbers further apart and reads as a layout bug. `w-fit` lets
// the table set the width; `max-w-full` keeps it scrollable on a narrow pane.
const SHELL = "h-full w-full overflow-auto flex items-start justify-center p-3 sm:p-4";
const CARD = "w-fit max-w-full border p-5 sm:p-6 text-center";

/**
 * Source line sits bottom-left, logo bottom-right and lifted off the border so the
 * mark does not read as touching the frame. This row opts out of the card's
 * `text-center` deliberately -- it is a footer rule, not body content.
 */
function CardFooter() {
  return (
    <div className="mt-4 flex items-end justify-between gap-6">
      <div className="text-left text-[10px] uppercase tracking-wider" style={{ color: "#8A8778" }}>
        Source CrimeIndex.org
      </div>
      <div className="mb-1.5 shrink-0">
        <CrimeIndexLogo size={22} />
      </div>
    </div>
  );
}

interface ScorecardPanelProps {
  agencyLabel: string;
  year: number | null;
  rows: AgencyScorecardRow[];
  explanation: string;
}

export default function ScorecardPanel({
  agencyLabel, year, rows, explanation,
}: ScorecardPanelProps) {
  const heading = agencyLabel
    ? `${agencyLabel} Crime Scorecard${year != null ? ` (${year})` : ""}`
    : "Crime Scorecard";

  // Unavailable state: render the builder's explanation inside the card so an
  // unavailable scorecard looks deliberate rather than like an empty frame.
  if (rows.length === 0) {
    return (
      <div className={SHELL}>
        <div className={CARD} style={{ background: CREAM, color: SLATE, borderColor: RULE }}>
          <h2 className="text-base sm:text-lg font-bold tracking-tight">{heading}</h2>
          <p className="mx-auto mt-3 max-w-[46ch] text-[13px] leading-relaxed" style={{ color: SLATE }}>{explanation}</p>
          <CardFooter />
        </div>
      </div>
    );
  }

  const hasOver100 = rows.some((row) => row.clearance_rate != null && row.clearance_rate > 100);
  const numeric = "text-center tabular-nums whitespace-nowrap";

  return (
    <div className={SHELL}>
    <div className={CARD} style={{ background: CREAM, color: SLATE, borderColor: RULE }}>
      <h2 className="text-base sm:text-lg font-bold tracking-tight">{heading}</h2>

      <div className="mt-4 overflow-x-auto">
        <table className="w-auto border-collapse text-sm">
          <thead>
            <tr>
              {/* Header text is derived from SCORECARD_DISPLAY_COLUMNS (the reference-mock
                  order) rather than hardcoded, so a column reorder there is caught by the
                  test instead of silently diverging from the rendered table. The third
                  column is dynamic -- the constant holds its base label "Change" and this
                  swaps in changeHeaderLabel(year) instead. */}
              {SCORECARD_DISPLAY_COLUMNS.map((label, index) => (
                <th
                  key={label}
                  // Headers wrap (data cells still don't): letting "Offense Rate Per 100k"
                  // break over two lines is what allows the column -- and the card -- to be
                  // narrow instead of being held open by the longest label.
                  className={index === 0
                    ? "px-4 pb-2 align-bottom text-center font-bold whitespace-nowrap"
                    : "px-4 pb-2 align-bottom text-center font-bold whitespace-nowrap"}
                >
                  {index === 2 ? changeHeaderLabel(year) : label}
                </th>
              ))}
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
                  <td className={`px-4 py-2 ${row.section ? "font-semibold" : ""}`}>{row.offense}</td>
                  <td className={`px-4 py-2 ${numeric} ${row.section ? "font-semibold" : ""}`}>
                    {formatCount(row.offenses)}
                  </td>
                  {/* Colour is redundant encoding -- the minus sign carries direction, so this
                      stays correct in greyscale and for a red-green colourblind reader. */}
                  <td className={`px-4 py-2 ${numeric}`} style={{ color: changeColor }}>
                    {formatChange(row.offense_change_pct)}
                  </td>
                  <td className={`px-4 py-2 ${numeric}`}>{formatRate(row.rate_per_100k)}</td>
                  <td className={`relative px-4 py-2 ${numeric}`}>
                    {formatClearance(row.clearance_rate)}
                    {row.clearance_rate != null && row.clearance_rate > 100 && (
                      <span className="absolute ml-0.5 text-[10px] leading-none" aria-hidden="true">*</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasOver100 && (
        <p className="mx-auto mt-3 max-w-[46ch] text-[11px] leading-snug" style={{ color: "#8A8778" }}>
          * Clearance rates can exceed 100% because agencies may clear cases in the current year
          that originated in prior reporting years.
        </p>
      )}

      <CardFooter />
    </div>
    </div>
  );
}
