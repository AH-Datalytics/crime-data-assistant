/**
 * Round 1 D3 (audit/presentation-2026-10-20/ROUND1-PLAN.md + r2 finding 5; owner threshold 8): the partial-period
 * fallback for annual charts whose producer did not name its partial periods (NIBRS city trends, Homicide Reports, Hate
 * Crime). Applied once at delivery, so the marker and its basis are stored in the answer itself: a 2026 answer saved
 * today keeps its marker in 2027.
 *
 * - Only an annual x axis (four-digit years) is considered; monthly, rolling and category axes are left alone.
 * - The current calendar year at delivery is partial by definition. Its months are named only when the answer itself
 *   states them ("January-October 2026"); otherwise the label is "partial year" and nothing is inferred from event dates.
 * - A producer's own `partialPeriods` always wins.
 */
import type { ChartConfig } from "./types";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SHORT = (m: string) => m.slice(0, 3);

export type PartialPeriodBasis = { asOf: string; rule: "current-calendar-year" };

/** The stated month span for `year` in the answer's own text ("January-October 2026", "January through June 2026"). */
export function statedMonthSpan(text: string, year: number): string | null {
  const months = MONTHS.join("|");
  const re = new RegExp(`\\b(${months})\\s*(?:-|–|to|through)\\s*(${months})\\s+${year}\\b`, "i");
  const cap = (s: string) => s[0].toUpperCase() + s.slice(1).toLowerCase();
  const m = text.match(re);
  if (m) return `${SHORT(cap(m[1]))}–${SHORT(cap(m[2]))}`;
  // The range wording of round 1 W1: "2000-2026 (2026 through October)".
  const through = text.match(new RegExp(`\\b${year}\\s+through\\s+(${months})\\b`, "i"));
  return through ? `Jan–${SHORT(cap(through[1]))}` : null;
}

export function withPartialPeriodFallback(
  payload: { chartConfig?: ChartConfig | null; rows?: unknown; title?: unknown; explanation?: unknown },
  now: Date = new Date(),
): void {
  const chart = payload.chartConfig;
  if (!chart || chart.type === "none" || (chart.partialPeriods && chart.partialPeriods.length) || !Array.isArray(payload.rows)) return;
  const rows = payload.rows as Record<string, unknown>[];
  const xs = rows.map((r) => r[chart.xAxis]).filter((v) => v !== null && v !== undefined && v !== "");
  if (!xs.length || !xs.every((v) => /^\d{4}$/.test(String(v)))) return;
  const year = now.getUTCFullYear();
  if (!xs.some((v) => Number(v) === year)) return;
  const text = [payload.title, payload.explanation, chart.title].filter((t) => typeof t === "string").join(" ");
  const span = statedMonthSpan(text, year);
  const x = xs.find((v) => Number(v) === year)!;
  chart.partialPeriods = [{ x: typeof x === "number" ? x : String(x), label: span ?? "partial year" }];
  chart.partialBasis = { asOf: now.toISOString().slice(0, 10), rule: "current-calendar-year" };
}
