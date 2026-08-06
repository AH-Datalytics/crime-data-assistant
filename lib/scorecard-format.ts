/**
 * Pure formatting helpers for the agency scorecard panel.
 *
 * Framework-free and separated from the component on purpose: the repository has
 * no React component test infrastructure, so extracting this logic is what makes
 * it testable at all.
 */

/** Column headers in reference-mock order. `Change` is relabelled per-year by changeHeaderLabel. */
export const SCORECARD_DISPLAY_COLUMNS = [
  "Type", "Offenses", "Change", "Offense Rate Per 100k", "Clearance Rate",
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
  //
  // The "%" belongs on the value, not only in the column header: an exported card
  // is read away from its heading, and a bare "162.5" invites being mistaken for
  // a count.
  if (blankIfNull(value)) return "";
  return `${(value as number).toFixed(1)}%`;
}

export function formatChange(value: number | null): string {
  // Blank, never "0.0%", when unknown: a blank says "not known", a zero says
  // "no change", and those are different claims. The blank carries NO percent
  // sign -- a bare "%" would read as a rendering fault.
  //
  // Plain ASCII hyphen, NOT U+2212 MINUS SIGN. The typographic minus is correct
  // typography and a liability everywhere else: it is invisible in fonts that lack
  // the glyph, it survives a copy-paste into a spreadsheet as text rather than a
  // negative number, and it is exactly the kind of non-ASCII character that turns
  // into mojibake when a file round-trips through a non-UTF-8 editor.
  if (blankIfNull(value)) return "";
  const magnitude = Math.abs(value as number).toFixed(1);
  return (value as number) < 0 ? `-${magnitude}%` : `${magnitude}%`;
}

export function changeDirection(value: number | null): "improved" | "worsened" | "none" {
  // Polarity is INVERTED from a financial table: crime going down is good.
  if (blankIfNull(value) || value === 0) return "none";
  return (value as number) < 0 ? "improved" : "worsened";
}

export function changeHeaderLabel(year: number | null): string {
  return year == null ? "Change" : `Change from ${year - 1}`;
}

/**
 * Whether a question is asking for a scorecard.
 *
 * Lives here rather than in lib/agency-scorecard.ts because the client needs it to
 * route scorecard questions, and agency-scorecard.ts pulls in the geo place catalog --
 * tens of thousands of generated city entries that have no business in a browser
 * bundle. This module has no dependencies at all.
 */
export function detectAgencyScorecardQuestion(question: string): boolean {
  return /\b(?:crime\s+)?scorecard\b/i.test(question);
}
