/**
 * Time transforms over a compiled count's monthly cells (compiler increment 3). Pure functions: the compiler gives each
 * month's count and status (D6, P51); these roll months into period totals, compare two periods, and build rolling
 * windows. Nothing is approximated: a total is known only when every month in it is known.
 *
 *   rollup      a period's total: EVIDENCE_CONFLICT if any month conflicts; UNKNOWN (blank) if any month is not known;
 *               REPORTED_ZERO (0) when every month is a reported zero; otherwise VALUE, the sum.
 *   compare     a later period against an earlier (period_comparison): both totals, the change and the percent change.
 *               No change when either total is unknown (D17). No percent change from a known 0 base (P55): UNAVAILABLE.
 *               Percent change is 100 * change / earlier, rounded to one decimal, half away from zero.
 *   rolling     for each displayed month, the sum of it and the months before it in the window; known only when every
 *               month of the window is known, never a shorter sum. The window may reach before the displayed period.
 */
export type Status = "VALUE" | "REPORTED_ZERO" | "UNKNOWN" | "EVIDENCE_CONFLICT" | "UNAVAILABLE";
export type MonthCell = { ym: string; value: number | null; status: string };
export type Cell = { value: number | null; status: Status };

const known = (s: string) => s === "VALUE" || s === "REPORTED_ZERO";

export function rollup(months: MonthCell[]): Cell & { missing: string[] } {
  const missing = months.filter((m) => !known(m.status)).map((m) => m.ym);
  if (!months.length) return { value: null, status: "UNKNOWN", missing };
  if (months.some((m) => m.status === "EVIDENCE_CONFLICT")) return { value: null, status: "EVIDENCE_CONFLICT", missing };
  if (missing.length) return { value: null, status: "UNKNOWN", missing };
  const value = months.reduce((a, m) => a + (m.value ?? 0), 0);
  return { value, status: months.every((m) => m.status === "REPORTED_ZERO") ? "REPORTED_ZERO" : "VALUE", missing };
}

/** One decimal, half away from zero, without floating-point drift (2.25 -> 2.3, -2.25 -> -2.3). */
export function pct1(numerator: number, denominator: number): number {
  const x = (1000 * Math.abs(numerator)) / Math.abs(denominator);
  const r = Math.floor(x + 0.5 + 1e-9) / 10;
  return (numerator < 0) !== (denominator < 0) && r !== 0 ? -r : r;
}

export type Comparison = { earlier: Cell & { missing: string[] }; later: Cell & { missing: string[] }; change: Cell; pctChange: Cell; zeroBase: boolean };
export function compare(earlier: MonthCell[], later: MonthCell[]): Comparison {
  const e = rollup(earlier), l = rollup(later);
  const both = known(e.status) && known(l.status);
  const conflict = e.status === "EVIDENCE_CONFLICT" || l.status === "EVIDENCE_CONFLICT";
  const blank: Cell = { value: null, status: conflict ? "EVIDENCE_CONFLICT" : "UNKNOWN" };
  if (!both) return { earlier: e, later: l, change: blank, pctChange: blank, zeroBase: false };
  const change = l.value! - e.value!;
  const zeroBase = e.value === 0;
  return {
    earlier: e, later: l,
    change: { value: change, status: "VALUE" },
    pctChange: zeroBase ? { value: null, status: "UNAVAILABLE" } : { value: pct1(change, e.value!), status: "VALUE" },
    zeroBase,
  };
}

/** Months from `ym` back `n - 1` months, oldest first ("2023-01", 12 -> "2022-02" .. "2023-01"). */
export function windowMonths(ym: string, n: number): string[] {
  const k = Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  return Array.from({ length: n }, (_, i) => { const j = k - n + 1 + i; return `${Math.floor(j / 12)}-${String((j % 12) + 1).padStart(2, "0")}`; });
}

/**
 * Rolling windows for the displayed months. `cells` must hold every month any window reaches (absent months count as
 * unknown, never zero).
 */
export function rolling(cells: MonthCell[], months: number, displayed: string[]): (Cell & { ym: string; missing: string[] })[] {
  const at = new Map(cells.map((c) => [c.ym, c]));
  return displayed.map((ym) => ({ ym, ...rollup(windowMonths(ym, months).map((m) => at.get(m) ?? { ym: m, value: null, status: "UNKNOWN" })) }));
}
