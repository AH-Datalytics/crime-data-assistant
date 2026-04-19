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

export function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${m}/${d}/${y}`;
}
