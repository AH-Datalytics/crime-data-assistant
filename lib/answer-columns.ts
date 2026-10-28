/**
 * The answer contract (docs/superpowers/specs/2026-10-28-answer-columns-and-chart-labels.md).
 *
 * Owner 2026-10-28: "We should never need status and notes"; "the tables and exports should only give the appropriate
 * columns". An answer's columns are its groupings (place, period, requested categories such as clearance_status, and
 * geographic *_label identities) and its measures (requested numbers, including ones that are all blank). An answer
 * annotation is a column whose only role is to describe other cells: their coverage, status, a caveat or a note.
 *
 * ANSWER_ANNOTATIONS is an explicit list, never a pattern: a name not on it is never dropped, so a substantive
 * category can't be lost to a name match (Codex r1 #2). Producers keep these facts as internal evidence; projectAnswer
 * is the safety net for what still reaches egress (model SQL, an old embed's stored SQL).
 *
 * The one exception (owner 2026-10-28, "Go back to the older rule"): a Historical staffing answer's `reported` column
 * ("Officers" / "Employees") says which figure each row shows. It is a label column, never a chart series.
 */

export const ANSWER_ANNOTATIONS: ReadonlySet<string> = new Set([
  "note",
  "notes",
  "shr_records",
  "years_without_records",
  "periods_without_records",
  "population_status",
  "shr_status",
  "shr_coverage_caveat",
  "shr_recorded_months",
  "coverage_status",
  "coverage_caveat",
  "data_type",
  "years_with_reports",
]);

/** The only text column that is neither a grouping nor a measure. Allowed only on staffing answers. */
export const STAFFING_LABEL_COLUMN = "reported";

/** Label columns: shown in the table and CSV, never a chart series. */
export const LABEL_COLUMNS: ReadonlySet<string> = new Set([STAFFING_LABEL_COLUMN]);

export function isAnswerAnnotation(column: string): boolean {
  return ANSWER_ANNOTATIONS.has(column.toLowerCase());
}

export type ProjectedAnswer = {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Annotation columns removed, in their original order; each becomes an `answer-annotation-dropped:<name>` tag. */
  dropped: string[];
  /** A legacy staffing answer with at least one total-employees figure: its saved officer-only labels need the other count. */
  legacyEmployees?: boolean;
};

/**
 * The permitted columns and rows of an answer. Pure and deterministic: the same input always gives the same output,
 * so the finalization input and the emitted payload, projected separately from the same result, agree. Rows keep
 * every non-annotation key, including keys that are not in `columns` (internal row fields some surfaces read).
 * Returns the input arrays unchanged when there is nothing to drop.
 */
/** Legacy staffing marker values (model SQL taught before 2026-10-28): "Employees*" is today's "Employees". */
const LEGACY_STAFFING = new Map<string, string>([["Officers", "Officers"], ["Employees*", "Employees"], ["Employees", "Employees"]]);

/**
 * A legacy staffing answer (an old embed's stored SQL) marks each figure in `data_type`. That column is the staffing
 * classification, not an annotation: it becomes `reported` before projection, so the marker is not lost. Any other
 * `data_type` is an annotation and is dropped.
 */
function legacyStaffing(columns: readonly string[], rows: readonly Record<string, unknown>[]): { columns: string[]; rows: Record<string, unknown>[] } | null {
  if (!columns.includes("data_type") || columns.includes(STAFFING_LABEL_COLUMN)) return null;
  const values = rows.map((r) => r.data_type).filter((v) => v !== null && v !== undefined);
  if (values.length === 0 || !values.every((v) => LEGACY_STAFFING.has(String(v)))) return null;
  return {
    columns: columns.map((c) => (c === "data_type" ? STAFFING_LABEL_COLUMN : c)),
    rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => (k === "data_type"
      ? [STAFFING_LABEL_COLUMN, v === null || v === undefined ? null : LEGACY_STAFFING.get(String(v))]
      : [k, v])))),
  };
}

export function projectAnswer(givenColumns: readonly string[], givenRows: readonly Record<string, unknown>[]): ProjectedAnswer {
  const legacy = legacyStaffing(givenColumns, givenRows);
  const columns = legacy ? legacy.columns : givenColumns;
  const rows = legacy ? legacy.rows : givenRows;
  const dropped = new Set<string>();
  for (const c of columns) if (isAnswerAnnotation(c)) dropped.add(c);
  for (const row of rows) for (const k of Object.keys(row)) if (isAnswerAnnotation(k)) dropped.add(k);
  const legacyEmployees = legacy !== null && rows.some((r) => r[STAFFING_LABEL_COLUMN] === "Employees");
  if (dropped.size === 0) return { columns: columns as string[], rows: rows as Record<string, unknown>[], dropped: [], ...(legacyEmployees ? { legacyEmployees } : {}) };
  const keep = (k: string) => !dropped.has(k);
  return {
    columns: columns.filter(keep),
    rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => keep(k)))),
    dropped: [...dropped],
    ...(legacyEmployees ? { legacyEmployees } : {}),
  };
}

/** "Chicago Police Officers" -> "Chicago Police Officers or total employees"; unchanged if it already names employees. */
export function withEmployeeCount(label: string): string {
  if (/employees/i.test(label)) return label;
  return label.replace(/\b(sworn officers|police officers|officers)\b/i, (m) => `${m} or total employees`);
}

export function annotationDropTags(dropped: readonly string[]): string[] {
  return dropped.map((name) => `answer-annotation-dropped:${name}`);
}

type ChartBinding = { xAxis?: unknown; yAxis?: unknown };

/**
 * A chart config reconciled with the projected columns: series naming a dropped column are removed. An x axis on a
 * dropped column, or no series left, means the chart can't be drawn from the answer, so the config becomes null.
 */
export function reconcileChartConfig<T extends ChartBinding>(config: T | null | undefined, dropped: readonly string[]): T | null | undefined {
  if (!config || dropped.length === 0) return config;
  const gone = new Set(dropped);
  if (typeof config.xAxis === "string" && gone.has(config.xAxis)) return null;
  if (!Array.isArray(config.yAxis)) return config;
  const yAxis = (config.yAxis as unknown[]).filter((y) => !(typeof y === "string" && gone.has(y)));
  if (yAxis.length === (config.yAxis as unknown[]).length) return config;
  if (yAxis.length === 0) return null;
  return { ...config, yAxis };
}

/**
 * A delivered payload with its answer projected: `columns`, `rows` and the chart binding. Anything else in the
 * payload is untouched. A payload without columns and rows is returned as is.
 */
export function projectPayload<T>(payload: T): T {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as Record<string, unknown>;
  if (!Array.isArray(p.columns) || !Array.isArray(p.rows)) return payload;
  const projected = projectAnswer(p.columns as string[], p.rows as Record<string, unknown>[]);
  if (projected.columns === p.columns && projected.rows === p.rows) return payload;
  const out: Record<string, unknown> = { ...p, columns: projected.columns, rows: projected.rows };
  if ("chartConfig" in p) out.chartConfig = reconcileChartConfig(p.chartConfig as ChartBinding | null | undefined, projected.dropped);
  // A legacy staffing answer showing total employees in some years: its saved title and axis label named officers
  // only; they now name both counts, as a current staffing answer does.
  if (projected.legacyEmployees) {
    if (typeof out.title === "string") out.title = withEmployeeCount(out.title);
    const cfg = out.chartConfig as Record<string, unknown> | null | undefined;
    if (cfg) out.chartConfig = { ...cfg, ...(typeof cfg.title === "string" ? { title: withEmployeeCount(cfg.title) } : {}), ...(typeof cfg.yAxisLabel === "string" ? { yAxisLabel: withEmployeeCount(cfg.yAxisLabel) } : {}) };
  }
  return out as T;
}
