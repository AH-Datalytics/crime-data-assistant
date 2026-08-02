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

export function detectAndPivotChartData(
  data: Record<string, unknown>[],
  xKey: string,
  yKeys: string[],
): PivotedChartData {
  if (yKeys.length !== 1 || data.length === 0) {
    return { data, effectiveYKeys: yKeys, seriesOverflow: false };
  }
  const valueKey = yKeys[0];
  const otherKeys = Object.keys(data[0]).filter(
    (key) => key !== "_ym" && key !== xKey && key !== valueKey,
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
