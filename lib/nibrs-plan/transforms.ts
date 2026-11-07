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

/* ------------------------------------------------------------------ several agencies (increment 4) -------------- */

/**
 * Several agencies' months as one: a month is known only when every agency's month is (P58: no agency stands in for
 * another); a conflict in any is a conflict; REPORTED_ZERO only when every agency reported zero; else the sum.
 */
export function combineMonths(perAgency: MonthCell[][]): MonthCell[] {
  const months = [...new Set(perAgency.flatMap((cells) => cells.map((c) => c.ym)))].sort();
  return months.map((ym) => {
    const cells = perAgency.map((xs) => xs.find((c) => c.ym === ym) ?? { ym, value: null, status: "UNKNOWN" });
    if (cells.some((c) => c.status === "EVIDENCE_CONFLICT")) return { ym, value: null, status: "EVIDENCE_CONFLICT" };
    if (!cells.every((c) => known(c.status))) return { ym, value: null, status: "UNKNOWN" };
    return { ym, value: cells.reduce((a, c) => a + (c.value ?? 0), 0), status: cells.every((c) => c.status === "REPORTED_ZERO") ? "REPORTED_ZERO" : "VALUE" };
  });
}

/** One decimal, half up (a rate is never negative). */
export const round1 = (x: number) => Math.floor(x * 10 + 0.5 + 1e-9) / 10;

/**
 * A rate per `per` residents (P15, P58): known only when the count is; UNAVAILABLE when the population is missing or not
 * positive (never zero or infinite); one decimal, half up. A known zero count over a population is a rate of 0.
 */
export function rate(count: Cell, population: number | null | undefined, per = 100_000): Cell {
  if (count.status === "EVIDENCE_CONFLICT") return { value: null, status: "EVIDENCE_CONFLICT" };
  if (!known(count.status) || count.value === null) return { value: null, status: "UNKNOWN" };
  if (!population || population <= 0) return { value: null, status: "UNAVAILABLE" };
  return { value: round1((per * count.value) / population), status: "VALUE" };
}

/**
 * A ranking (P17, P60): only agencies whose value is known are ranked; ordered by value (descending for "top",
 * ascending for "bottom"), ties by name alphabetically; cut at `limit`. The others are left out, never ranked or listed
 * among the ranked.
 */
export function rankAgencies<T extends { name: string; value: number | null; known: boolean; ori?: string }>(xs: T[], direction: "top" | "bottom", limit: number | null): { ranked: T[]; leftOut: T[]; tie: { position: number; names: string[]; shown: number } | null } {
  const ok = xs.filter((x) => x.known && x.value !== null);
  const sign = direction === "top" ? -1 : 1;
  // P17: ties by name, case-insensitive, then ORI (as nibrs-model orders them).
  const lower = (x: T) => x.name.toLowerCase();
  ok.sort((a, b) => sign * (a.value! - b.value!) || (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : 0) || (a.ori ?? "").localeCompare(b.ori ?? ""));
  // Every place tied at the cut is shown, never one dropped by its name (coordinator 2026-11-06): the cut runs on through
  // the last place with the cut value; `tie` names them and the position they share, for the answer to say so.
  let cut = limit === null ? ok.length : Math.min(limit, ok.length);
  while (limit !== null && cut > 0 && cut < ok.length && ok[cut].value === ok[cut - 1].value) cut++;
  const cutValue = limit !== null && cut > limit ? ok[limit - 1].value : null;
  const tied = cutValue === null ? [] : ok.filter((x) => x.value === cutValue);
  const tie = tied.length ? { position: ok.findIndex((x) => x.value === cutValue) + 1, names: tied.map((x) => x.name), shown: cut } : null;
  return { ranked: ok.slice(0, cut), leftOut: xs.filter((x) => !(x.known && x.value !== null)), tie };
}
