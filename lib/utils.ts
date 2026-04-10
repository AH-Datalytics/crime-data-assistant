export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "";
  return n.toLocaleString("en-US");
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

export function formatDate(yyyymmdd: string): string {
  if (!yyyymmdd || yyyymmdd.length !== 8) return yyyymmdd;
  const y = yyyymmdd.slice(0, 4);
  const m = yyyymmdd.slice(4, 6);
  const d = yyyymmdd.slice(6, 8);
  return `${m}/${d}/${y}`;
}
