"use client";

import type { AgencyScorecardRow } from "@/lib/agency-scorecard";
import CrimeIndexLogo from "./CrimeIndexLogo";
import {
  formatCount, formatRate, formatClearance, formatChange,
  changeDirection, changeHeaderLabel, scorecardDisplayColumns,
} from "@/lib/scorecard-format";

const CREAM = "#F5F1E8";
const SLATE = "#3A4450";
const RULE = "#3A4450";
const HAIRLINE = "#E2DCCC";
// Muted, print-appropriate against cream -- not saturated UI red/green.
const IMPROVED = "#2F6B4F";
const WORSENED = "#A83A32";

// The card sizes to its own content instead of filling the pane. A scorecard is a
// fixed 9-row object -- stretching it to an arbitrary pane width just spreads the same
// numbers further apart and reads as a layout bug. `w-fit` lets the table set the
// width; `max-w-full` keeps it scrollable on a narrow pane.
const SHELL = "h-full w-full overflow-auto flex items-start justify-center p-3 sm:p-4";
const CARD = "w-fit max-w-full border p-4 sm:p-6 text-center";

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
  /** Compact year/status line from the builder, e.g. "2024 · Latest FBI reporting year". */
  statusText?: string;
  /** Agency cards carry clearance; state/national cards omit the column entirely. */
  showClearance?: boolean;
}

export default function ScorecardPanel({
  agencyLabel, year, rows, explanation, statusText, showClearance = true,
}: ScorecardPanelProps) {
  const heading = agencyLabel
    ? `${agencyLabel}${explanation.includes("lead county agency's FBI-reported data") ? " County" : " Crime"} Scorecard${year != null ? ` (${year})` : ""}`
    : "Crime Scorecard";

  // Unavailable state: render the builder's explanation inside the card so an
  // unavailable scorecard looks deliberate rather than like an empty frame.
  if (rows.length === 0) {
    return (
      <div className={SHELL}>
        <div data-scorecard-export className={CARD} style={{ background: CREAM, color: SLATE, borderColor: RULE }}>
          <h2 className="text-base sm:text-lg font-bold tracking-tight">{heading}</h2>
          <p className="mx-auto mt-3 max-w-[46ch] text-[13px] leading-relaxed" style={{ color: SLATE }}>{explanation}</p>
          <CardFooter />
        </div>
      </div>
    );
  }

  const headers = scorecardDisplayColumns(showClearance);
  const hasOver100 = showClearance && rows.some((row) => row.clearance_rate != null && row.clearance_rate > 100);
  const isCountyAgency = explanation.includes("lead county agency's FBI-reported data");
  // Numeric cells keep tabular figures aligned; horizontal padding steps down at narrow
  // widths so more of the table fits before the scroll kicks in.
  const numeric = "px-2 py-2 text-center tabular-nums whitespace-nowrap sm:px-4";
  // The label column is sticky inside the horizontal scroll container, so on a phone the
  // offense names stay put while the numbers scroll under them. It needs its own opaque
  // background for exactly that reason. Left-aligned -- indentation is the group cue,
  // and indentation is invisible in centred text.
  const labelBase = "sticky left-0 z-10 py-2 text-left whitespace-nowrap";

  return (
    <div className={SHELL}>
    <div data-scorecard-export className={CARD} style={{ background: CREAM, color: SLATE, borderColor: RULE }}>
      <h2 className="text-base sm:text-lg font-bold tracking-tight">{heading}</h2>
      {statusText && (
        // The structured status line -- which year this is and why -- lives directly
        // under the title so the reporting year is unmistakable without reading prose.
        <p className="mt-1 text-[11px] tracking-wide" style={{ color: "#8A8778" }}>{statusText}</p>
      )}

      {/* data-scorecard-scroll: the image exporter finds this container to expand the
          card to the table's full intrinsic width during capture, so a phone export
          includes the columns that were scrolled out of view. */}
      <div data-scorecard-scroll className="mt-4 overflow-x-auto">
        <table className="w-auto border-collapse text-sm">
          <thead>
            <tr>
              {/* Header text is derived from scorecardDisplayColumns (reference-mock
                  order, clearance dropped for aggregate cards) rather than hardcoded, so
                  a column change there is caught by the test instead of silently
                  diverging from the rendered table. The third column is dynamic -- the
                  constant holds its base label "Change" and this swaps in
                  changeHeaderLabel(year) instead. */}
              {headers.map((label, index) => (
                <th
                  key={label}
                  className={index === 0
                    ? `${labelBase} px-2 pb-2 align-bottom font-bold sm:px-4`
                    : "px-2 pb-2 align-bottom text-center font-bold whitespace-nowrap sm:px-4"}
                  style={index === 0 ? { background: CREAM } : undefined}
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
              const changeText = formatChange(row.offense_change_pct);
              return (
                <tr
                  key={row.offense}
                  style={{
                    // Each section total (Violent Crime, Property Crime) opens its group
                    // with the strong rule; component rows get the hairline.
                    borderTop: row.section || index === 0 ? `2px solid ${RULE}` : `1px solid ${HAIRLINE}`,
                  }}
                >
                  <td
                    className={`${labelBase} ${row.section ? "px-2 font-semibold sm:px-4" : "pr-2 pl-6 sm:pr-4 sm:pl-8"}`}
                    style={{ background: CREAM }}
                  >
                    {row.offense}
                  </td>
                  <td className={`${numeric} ${row.section ? "font-semibold" : ""}`}>
                    {formatCount(row.offenses)}
                  </td>
                  {/* Three redundant direction encodings -- arrow, sign, colour -- so the
                      cell stays readable in greyscale and for a red-green colourblind
                      reader. The arrow carries an aria-label; the signed percentage is
                      already meaningful to a screen reader on its own. Lower crime is
                      styled as improvement: the semantic inversion is deliberate. */}
                  <td className={`${numeric}`} style={{ color: changeColor }}>
                    {direction === "improved" && (
                      <span className="mr-0.5 text-[10px]" role="img" aria-label="decreased from prior year">▼</span>
                    )}
                    {direction === "worsened" && (
                      <span className="mr-0.5 text-[10px]" role="img" aria-label="increased from prior year">▲</span>
                    )}
                    {/* Unknown change renders a quiet dash, never 0.0% -- "no change" and
                        "cannot know" are different claims. Display-only: the underlying
                        row value stays null and exports stay ASCII-clean. */}
                    {changeText || <span aria-label="change versus prior year unknown">–</span>}
                  </td>
                  <td className={numeric}>{formatRate(row.rate_per_100k)}</td>
                  {showClearance && (
                    <td className={`relative ${numeric}`}>
                      {formatClearance(row.clearance_rate)}
                      {row.clearance_rate != null && row.clearance_rate > 100 && (
                        <span className="absolute ml-0.5 text-[10px] leading-none" aria-hidden="true">*</span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {hasOver100 && (
        // Left-aligned and allowed the full card width. Centring a footnote inside the
        // 46ch measure wrapped it onto three ragged lines and read as body copy competing
        // with the table; at the card's own width it settles into one or two lines and
        // reads as an annotation, which is what it is.
        <p className="mt-3 text-left text-[11px] leading-snug" style={{ color: "#8A8778" }}>
          * Clearance rates can exceed 100% because agencies may clear cases in the current year
          that originated in prior reporting years.
        </p>
      )}

      {isCountyAgency && (
        <p className="mt-3 text-left text-[11px] leading-snug" style={{ color: "#8A8778" }}>
          This scorecard reflects the lead county agency&apos;s FBI-reported data, not a countywide
          total of all law enforcement agencies.
        </p>
      )}

      <CardFooter />
    </div>
    </div>
  );
}
