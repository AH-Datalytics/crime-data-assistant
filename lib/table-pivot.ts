/**
 * Table PRESENTATION pivot (Engine 2.0, ruling 7 / owner card 423179ca6d): a long table with a Year column, exactly one category column and
 * numeric value columns is shown with the categories as rows and a column per year. The answer contract (rows, columns, checkEnvelope) stays
 * long; only what the reader sees and downloads is wide. It mirrors detectAndPivotChartData (lib/chart-layout.ts) for charts.
 *
 * One block per value column: with one value column the years are headed "2017", "2018", ...; with several, each is headed
 * "2017 (<label>)". A category's first-appearance order is kept (the answer's own ranking); "Unknown" stays its own row.
 */
export interface PivotedTable {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Header text for every pivoted column (the category column keeps its own). */
  labels: Record<string, string>;
}

const YEAR_COLUMN = /^(?:year|period)$/i;
const YEAR_VALUE = /^(?:19|20)\d{2}$/;
/** A column that carries presentation metadata, never a category. */
const METADATA = /(?:^|_)(?:status|note|notes|caveat|partial|coverage|reported|months)(?:_|$)/i;

export function pivotYearTable(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
  headerOf: (column: string) => string = (c) => c,
  partialYears: ReadonlySet<string> = new Set(),
): PivotedTable | null {
  if (rows.length < 2) return null;
  const yearCol = columns.find((c) => YEAR_COLUMN.test(c));
  if (!yearCol) return null;
  const yearOf = (r: Record<string, unknown>) => String(r[yearCol] ?? "");
  if (!rows.every((r) => YEAR_VALUE.test(yearOf(r)))) return null;
  const years = [...new Set(rows.map(yearOf))].sort();
  if (years.length < 2) return null;

  const others = columns.filter((c) => c !== yearCol);
  const isNumeric = (c: string) => rows.some((r) => typeof r[c] === "number") && rows.every((r) => r[c] == null || typeof r[c] === "number");
  const values = others.filter(isNumeric);
  const cats = others.filter((c) => !isNumeric(c) && !METADATA.test(c));
  // Any other text column (a status, a note) is not a category: the table is left as it is, never half-pivoted.
  if (cats.length !== 1 || values.length < 1 || others.length !== cats.length + values.length) return null;
  const cat = cats[0];

  const order: string[] = [];
  const byCat = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const k = String(r[cat] ?? "");
    if (!byCat.has(k)) { order.push(k); byCat.set(k, { [cat]: r[cat] ?? "" }); }
    const out = byCat.get(k)!;
    values.forEach((v, i) => {
      const key = i === 0 ? yearOf(r) : `${yearOf(r)}__${v}`;
      // Two rows for one category and year would lose one: not a grid, left long.
      if (key in out) out[key] = Symbol.for("dup");
      else out[key] = r[v] ?? null;
    });
  }
  const outRows = order.map((k) => byCat.get(k)!);
  if (outRows.some((r) => Object.values(r).includes(Symbol.for("dup") as unknown))) return null;
  if (outRows.length >= rows.length) return null;

  const outColumns: string[] = [cat];
  const labels: Record<string, string> = {};
  values.forEach((v, i) => {
    for (const y of years) {
      const key = i === 0 ? y : `${y}__${v}`;
      outColumns.push(key);
      const yl = partialYears.has(y) ? `${y} (Partial)` : y;
      labels[key] = i === 0 && values.length === 1 ? yl : `${yl} (${headerOf(v)})`;
      for (const r of outRows) if (!(key in r)) r[key] = null;
    }
  });
  return { columns: outColumns, rows: outRows, labels };
}
