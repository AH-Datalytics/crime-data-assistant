/**
 * Titles of the ranking answers (Jeff 2026-11-17): a Title Case title that reads back the question's own datapoints in plain English, such as
 * "2024 Murder Rate by State". Never a source name and never "Ranked:"; the source is the "Source: ..." line, the rest are plain notes.
 */
/** A ranking with no number shows the top 10 (Jeff 2026-11-24, ranked table card; replaces D05's 20). */
export const RANK_DEFAULT_ROWS = 10;

const SMALL =new Set(["a", "an", "and", "as", "at", "by", "for", "in", "of", "on", "or", "the", "to", "per"]);

/** Title Case: every word starts with a capital but the small words (by, of, or, per ...); numbers and a word with a digit are left as they are. */
export function titleCase(text: string): string {
  return text.split(" ").map((w, i) => {
    if (!w || /\d/.test(w)) return w;
    if (i > 0 && SMALL.has(w.toLowerCase())) return w.toLowerCase();
    // Each part after a slash starts with a capital too: "Drug/Narcotic Violation Offenses".
    return w.split("/").map((p) => (p ? `${p[0].toUpperCase()}${p.slice(1)}` : p)).join("/");
  }).join(" ");
}

/** The period of a ranking in a title: a whole year is its year; this year's months so far (January on) is "2026 Year to Date"; other months in words. */
export function periodTitle(period: { from: string; to: string }, words: (from: string, to: string) => string): string {
  if (period.from.endsWith("-01") && period.to.endsWith("-12")) return words(period.from, period.to);
  if (period.from.endsWith("-01") && period.from.slice(0, 4) === period.to.slice(0, 4)) return `${period.from.slice(0, 4)} Year to Date`;
  return titleCase(words(period.from, period.to));
}
