/**
 * Pure formatting helpers for the agency scorecard panel.
 *
 * Framework-free and separated from the component on purpose: the repository has
 * no React component test infrastructure, so extracting this logic is what makes
 * it testable at all.
 */

/** Column headers in reference-mock order. `Change` is relabelled per-year by changeHeaderLabel. */
export const SCORECARD_DISPLAY_COLUMNS = [
  "Type", "Offenses", "Change", "Rate per 100k", "Clearance Rate",
] as const;

const blankIfNull = (value: number | null | undefined): boolean => value == null;

export function formatCount(value: number | null): string {
  if (blankIfNull(value)) return "";
  return (value as number).toLocaleString("en-US");
}

export function formatRate(value: number | null): string {
  if (blankIfNull(value)) return "";
  return (value as number).toLocaleString("en-US", {
    minimumFractionDigits: 1, maximumFractionDigits: 1,
  });
}

export function formatClearance(value: number | null): string {
  // Never clamped. UCR clearances can exceed 100% because the FBI clears cases
  // in the current year that originated in prior years.
  if (blankIfNull(value)) return "";
  return (value as number).toFixed(1);
}

export function formatChange(value: number | null): string {
  // Blank, never "0.0", when unknown: a blank says "not known", a zero says
  // "no change", and those are different claims.
  if (blankIfNull(value)) return "";
  const magnitude = Math.abs(value as number).toFixed(1);
  return (value as number) < 0 ? `−${magnitude}` : magnitude;
}

export function changeDirection(value: number | null): "improved" | "worsened" | "none" {
  // Polarity is INVERTED from a financial table: crime going down is good.
  if (blankIfNull(value) || value === 0) return "none";
  return (value as number) < 0 ? "improved" : "worsened";
}

export function changeHeaderLabel(year: number | null): string {
  return year == null ? "Change" : `Change from ${year - 1}`;
}
