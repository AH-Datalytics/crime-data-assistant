/**
 * Rolling windows over monthly counts, for any source (shared helper; coordinator 2026-11-15). Pure: no source, no SQL,
 * no wording. A source gives its months (a count, or null where the month is not known) and takes back the window's
 * total for each month shown.
 *
 *   A window ending in a month is the `n` months up to and including it (n = 12 is the rolling 12 months). Its total is
 *   known only when every one of the n months is known; a month the source has no figure for (not reported, no filing,
 *   outside the data) is never counted as 0, so the window is blank and says which months it lacked (the same rule as
 *   transforms.rolling for NIBRS, which this follows for its count and blanks).
 *
 *   A source needs the months `n - 1` before the first month shown: `firstNeeded(from, n)` is where to start reading.
 *
 * Several crimes or the categories of a breakdown are several series: `rollingBySeries` rolls each on its own.
 */
export type RollCell = { ym: string; value: number | null };
export type RollRow = { ym: string; value: number | null; missing: string[] };

const toIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const fromIndex = (k: number) => `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`;

/** Every month from `from` to `to` inclusive ("2024-11", "2025-02" gives four months). */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let k = toIndex(from); k <= toIndex(to); k++) out.push(fromIndex(k));
  return out;
}

/** The first month a source must read so the window ending in `from` is complete. */
export function firstNeeded(from: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new Error(`rolling window length ${n}`);
  return fromIndex(toIndex(from) - (n - 1));
}

/** The `n` months ending in `ym`, oldest first. */
export function windowOf(ym: string, n: number): string[] {
  return monthRange(firstNeeded(ym, n), ym);
}

/**
 * The window totals for each month from `from` to `to`. `cells` holds the months read (from `firstNeeded(from, n)` on);
 * a month absent from `cells` is unknown, never 0. With `average`, the total over n months (known windows only).
 */
export function rollingSums(cells: RollCell[], n: number, from: string, to: string, opts: { average?: boolean } = {}): RollRow[] {
  const at = new Map(cells.map((c) => [c.ym, c.value]));
  return monthRange(from, to).map((ym) => {
    const months = windowOf(ym, n);
    const missing = months.filter((m) => at.get(m) === null || at.get(m) === undefined);
    if (missing.length) return { ym, value: null, missing };
    const total = months.reduce((s, m) => s + (at.get(m) as number), 0);
    return { ym, value: opts.average ? Math.round((total * 10) / n) / 10 : total, missing: [] };
  });
}

/** Each series rolled on its own (several crimes, or the categories of a breakdown), in the series' order. */
export function rollingBySeries<K>(series: Map<K, RollCell[]>, n: number, from: string, to: string, opts: { average?: boolean } = {}): Map<K, RollRow[]> {
  return new Map([...series].map(([k, cells]) => [k, rollingSums(cells, n, from, to, opts)]));
}

/** Months of a series that are not known, as runs ("2019-03 to 2019-05"), for a plain note. */
export function unknownRuns(rows: RollRow[]): string[][] {
  const bad = rows.filter((r) => r.value === null).map((r) => r.ym);
  const runs: string[][] = [];
  for (const ym of bad) {
    const last = runs[runs.length - 1];
    if (last && toIndex(last[last.length - 1]) + 1 === toIndex(ym)) last.push(ym); else runs.push([ym]);
  }
  return runs;
}
