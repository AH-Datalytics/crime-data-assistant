export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "";
  // Cap at 1 decimal place everywhere (table, chart, export)
  const rounded = Number.isInteger(n) ? n : Math.round(n * 10) / 10;
  return rounded.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 1,
  });
}

export function formatAxisValue(n: number): string {
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return v === Math.floor(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    const v = n / 1_000;
    return v === Math.floor(v) ? `${v}K` : `${v.toFixed(1)}K`;
  }
  return String(n);
}

/** Format a chart tooltip / axis value: max 1 decimal, with commas */
export function fmtVal(v: number | string, isPercent = false): string {
  const n = Number(v);
  if (isNaN(n)) return String(v);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
  return isPercent ? `${s}%` : s;
}

/** Build evenly-spaced year ticks for chart x-axes.
 *  Caps at 6 ticks so labels don't overlap on narrow screens. */
export function decadeTicksForYears(data: Record<string, unknown>[], xKey: string): number[] {
  const years = data
    .map((d) => Number(d[xKey]))
    .filter((y) => !isNaN(y) && y >= 1900 && y <= 2100);
  if (years.length === 0) return [];
  const min = Math.min(...years);
  const max = Math.max(...years);
  const span = max - min;
  const step = span <= 6 ? 1 : span <= 15 ? 2 : span <= 30 ? 5 : span <= 80 ? 10 : 20;
  const first = step === 1 ? min : Math.ceil(min / step) * step;
  let ticks: number[] = [];
  for (let y = first; y <= max; y += step) {
    ticks.push(y);
  }
  if (ticks[ticks.length - 1] !== max) {
    if (max - ticks[ticks.length - 1] < step * 0.75) {
      ticks.pop();
    }
    ticks.push(max);
  }
  if (ticks.length > 6) {
    const thin = Math.ceil(ticks.length / 5);
    const thinned = ticks.filter((_, i) => i % thin === 0);
    if (thinned[thinned.length - 1] !== ticks[ticks.length - 1]) thinned.push(ticks[ticks.length - 1]);
    return thinned;
  }
  return ticks;
}

export function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${m}/${d}/${y}`;
}
