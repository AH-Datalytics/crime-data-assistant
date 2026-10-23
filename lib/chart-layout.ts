export const MAX_AUTO_CHART_SERIES = 16;

export const DEFAULT_CHART_COLORS = [
  "#2d5f8a", "#c4652a", "#2a8a5a", "#8040a0",
  "#b8960a", "#c43838", "#1a8a8a", "#6050b0",
  "#8c564b", "#d45087", "#667085", "#6f8f2f",
  "#7b61a8", "#00876c", "#b55d00", "#3d7ea6",
];

export type PivotedChartData = {
  data: Record<string, unknown>[];
  effectiveYKeys: string[];
  seriesOverflow: boolean;
};

/**
 * Round 1 D5 (owner threshold 5): the chart box's minimum height, so the plot area keeps at least 150 px at 375 px wide
 * after everything else in the box takes its space: the title (estimated at the narrow width, about 24 characters per
 * 22 px line), the legend (about 3 series per row), the x-axis (120 px for angled category labels, 34 px for time),
 * the chart margins and the source footer. Never below the previous 280 px floor.
 */
export const MIN_PLOT_HEIGHT = 150;
export function chartBoxMinHeight(config: { type: string; xAxis: string; yAxis: string[]; title?: string }, rows: Record<string, unknown>[]): number {
  if (config.type === "none" || config.type === "pie") return 280;
  const titleLines = config.title ? Math.ceil(config.title.length / 24) : 0;
  const hasYearMonth = rows.length > 0 && "year" in rows[0] && "month" in rows[0];
  const xKey = hasYearMonth ? "_ym" : config.xAxis;
  const series = detectAndPivotChartData(rows, xKey, config.yAxis).effectiveYKeys.length;
  const legendRows = series > 1 ? Math.ceil(series / 3) : 0;
  const sample = rows.slice(0, 5).map((r) => String(r[config.xAxis] ?? ""));
  const timeAxis = hasYearMonth || (sample.length > 0 && sample.every((v) => /^\d{4}(?:-\d{2}|\d{2})?$/.test(v)));
  const xAxis = config.type === "scatter" ? 50 : timeAxis ? 34 : 120;
  return Math.max(280, titleLines * 22 + 8 + legendRows * 20 + 8 + xAxis + MIN_PLOT_HEIGHT + 28 + 24);
}

const CHART_METADATA_KEY = /^(?:note|notes|data_type|shr_status|shr_records|shr_coverage_caveat|coverage_status|coverage_caveat)$|_note$|_caveat$/i;

/**
 * Round 1 D7: distinct display labels for a category axis whose labels collide (two agencies both "St. Louis"): the
 * state is added where it tells them apart, then a running number. Returns null when the labels are already distinct.
 */
export function uniqueCategoryLabels(data: Record<string, unknown>[], xKey: string): string[] | null {
  const raw = data.map((row) => String(row[xKey] ?? "").trim() || "(no name)");
  if (new Set(raw).size === raw.length) return null;
  const withState = data.map((row, i) => {
    const st = String(row.state ?? "").trim();
    return raw.filter((r) => r === raw[i]).length > 1 && st && !raw[i].endsWith(`, ${st}`) ? `${raw[i]}, ${st}` : raw[i];
  });
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const l of withState) total.set(l, (total.get(l) ?? 0) + 1);
  return withState.map((l) => {
    if ((total.get(l) ?? 0) < 2) return l;
    const n = (seen.get(l) ?? 0) + 1;
    seen.set(l, n);
    return `${l} (${n})`;
  });
}

export function detectAndPivotChartData(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
): PivotedChartData {
  if (yKeys.length !== 1 || data.length === 0) {
    return { data, effectiveYKeys: yKeys, seriesOverflow: false };
  }
  const valueKey = yKeys[0];
  // Round 1 D3/D4: presentation metadata (row notes, coverage caveats and statuses) is never a series dimension, so a
  // partial-period note cannot split one series in two.
  const otherKeys = Object.keys(data[0]).filter(
    (key) => key !== "_ym" && key !== xKey && key !== valueKey && !CHART_METADATA_KEY.test(key),
  );
  let categoryKey: string | null = null;
  let categories: string[] = [];
  for (const key of otherKeys) {
    if (data.some((row) => typeof row[key] === "number")) continue;
    const values = [...new Set(data.map((row) => String(row[key] ?? "")))];
    if (values.length >= 2) {
      categoryKey = key;
      categories = values;
      break;
    }
  }
  if (!categoryKey || new Set(data.map((row) => row[xKey])).size === data.length) {
    return { data, effectiveYKeys: yKeys, seriesOverflow: false };
  }
  // Round 1 D4 (r4, Codex r3 finding 3): a state column is not a series ONLY when it accompanies a place-label collision
  // in a ranking: the x axis is a place label, SOME labels repeat (two "St. Louis" rows, P327) while others appear
  // once. The chart makes those labels distinct instead (uniqueCategoryLabels). A true grid, where every label repeats
  // (category-by-state on a non-period axis, places by year), and a period axis by state still pivot.
  if (/^(?:state|state_abbr|state_name)$/i.test(categoryKey) && /^(?:city|agency|agency_name|place|name|county)$/i.test(xKey)) {
    const perLabel = new Map<string, number>();
    for (const row of data) { const label = String(row[xKey] ?? ""); perLabel.set(label, (perLabel.get(label) ?? 0) + 1); }
    const counts = [...perLabel.values()];
    if (counts.some((n) => n > 1) && counts.some((n) => n === 1)) return { data, effectiveYKeys: yKeys, seriesOverflow: false };
  }
  if (categories.length > MAX_AUTO_CHART_SERIES) {
    return { data, effectiveYKeys: yKeys, seriesOverflow: true };
  }

  const pivot = new Map<unknown, Record<string, unknown>>();
  for (const row of data) {
    const x = row[xKey];
    if (!pivot.has(x)) pivot.set(x, { [xKey]: x });
    pivot.get(x)![String(row[categoryKey] ?? "")] = row[valueKey];
  }
  return { data: [...pivot.values()], effectiveYKeys: categories, seriesOverflow: false };
}

function niceStep(span: number): number {
  const rough = span / 5;
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

export function niceYTicks(
  data: Record<string, unknown>[],
  yKeys: string[],
  stacked = false,
): { ticks: number[]; domain: [number, number] } | null {
  const values = stacked
    ? data.flatMap((row) => {
        const rowValues = yKeys.map((key) => Number(row[key])).filter(Number.isFinite);
        return [
          rowValues.filter((value) => value > 0).reduce((sum, value) => sum + value, 0),
          rowValues.filter((value) => value < 0).reduce((sum, value) => sum + value, 0),
        ];
      })
    : data.flatMap((row) => yKeys
        .map((key) => Number(row[key]))
        .filter(Number.isFinite));
  if (values.length === 0) return null;

  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  if (rawMin === 0 && rawMax === 0) return null;
  const min = Math.min(0, rawMin);
  const max = Math.max(0, rawMax);
  const step = niceStep(max - min);
  const bottom = Math.floor(min / step) * step;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = bottom; value <= top + step / 100; value += step) {
    ticks.push(Math.round(value * 1e10) / 1e10);
  }
  return { ticks, domain: [bottom, top] };
}

export function shouldUsePieLegend(data: Record<string, unknown>[], nameKey: string): boolean {
  return data.length > 6 || data.some((row) => String(row[nameKey] ?? "").length > 18);
}
