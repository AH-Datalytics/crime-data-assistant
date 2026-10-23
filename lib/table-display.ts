/**
 * Table display hotfix (owner report 2026-10-22: a 106-row monthly NIBRS table repeated "Memphis, TN / carjacking /
 * offenses / count" on every row, with empty Filter and Note columns; Codex r3 corrections; owner: "in the memphis
 * example the table should only show month and carjackings"): which columns the on-screen table shows, and their names.
 *
 * - Only known optional metadata columns (filter, note) are hidden when empty on every row. A result column that is
 *   empty everywhere stays visible: its emptiness is information (e.g. a change that could not be calculated).
 * - A text column with the same value on every row (two rows or more) is not repeated in the grid.
 *   - Only for an explicitly supported combination is the value column named for its measure, unit and statistic
 *     ("Carjackings", "Murder victims", "Robbery rate per 100k"), and only then are those not restated: one measure;
 *     a unit of offenses or victims (or no unit column); a statistic of count or rate_per_100k (or no statistic column).
 *     A unit or statistic that varies, or any other unit (e.g. arrests), keeps the plain header and the labeled line.
 *   - Only the place may be left out because the title shows it: the whole place label must appear in the title, and the
 *     caller passes a title only where it is displayed with the table (the embed page shows none, so passes none).
 *   - Any other constant is stated once above the table WITH its column name ("Victim Race: White").
 * - A period column is named "Month" for monthly values and "Year" for yearly ones. Monthly values are shown as
 *   "MMM YY" ("Jan 19"; owner, 2026-10-23); sorting and the CSV keep the raw "2019-01".
 * - A note column is never shown in the grid (owner, 2026-10-23: "shouldn't be a Note column EVER"); the CSV keeps it.
 * - A record-status column (shr_records, population_status, coverage_status) that reads "recorded" on every row is
 *   not stated (owner, 2026-10-23: "Shr Records: recorded"); any other status value keeps the column.
 * - `columnLabels` from the answer name technical columns plainly ("Share (%)" for share_pct); they apply to shown
 *   columns only and never override the period name.
 * - The first column (the row's label) and every numeric column are always shown, even when constant.
 * - If fewer than two columns would remain, the table is shown unchanged.
 * - The CSV export is not affected: it keeps every column and its original names.
 */
export type TableDisplay = { shown: string[]; constants: { column: string; value: string }[]; labels: Record<string, string>; months: string[] };

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");
// Round 1 Q8: the SHR status column of a pooled answer is hidden only when every cell is empty (no period is missing records);
// a substantive status stays, and the CSV keeps the column either way.
const OPTIONAL_METADATA = /^(?:filter|note|notes|periods_without_records)$/i;
const NEVER_SHOWN = /^(?:note|notes)$/i;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2019-01" -> "Jan 19"; anything else unchanged. */
export function monthLabel(v: unknown): string {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(String(v ?? ""));
  return m ? `${MONTH_ABBR[Number(m[2]) - 1]} ${m[1].slice(2)}` : String(v ?? "");
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MEASURE_PLURAL: Record<string, string> = {
  carjacking: "carjackings", murder: "murders", robbery: "robberies", burglary: "burglaries", rape: "rapes",
  aggravated_assault: "aggravated assaults", motor_vehicle_theft: "motor vehicle thefts", theft: "thefts",
  larceny: "larcenies", arson: "arsons", shoplifting: "shoplifting offenses",
};

/**
 * The value column's name, only for a supported combination: unit "offenses" or "victims" (or no unit column), statistic
 * "count" or "rate_per_100k" (or no statistic column). `null` (keep the plain header and the labeled line) otherwise.
 */
function valueLabel(measure: string, unit: string | null, statistic: string | null): string | null {
  if (unit !== null && unit !== "offenses" && unit !== "victims") return null;
  if (statistic !== null && statistic !== "count" && statistic !== "rate_per_100k") return null;
  const m = measure.toLowerCase();
  const words = m.replace(/_/g, " ");
  if (statistic === "rate_per_100k") return cap(`${unit === "victims" ? `${words} victim` : words} rate per 100k`);
  return cap(unit === "victims" ? `${words} victims` : MEASURE_PLURAL[m] ?? `${words} offenses`);
}

const RECORD_STATUS = /^(?:shr_records|population_status|coverage_status)$/i;

export function tableDisplay(columns: string[], rows: Record<string, unknown>[], title = "", columnLabels: Record<string, string> = {}): TableDisplay {
  // A column whose supplied label is empty is not shown in the grid (round 1 Q3: an unrequested unknown count); the CSV
  // export keeps it.
  const visible = columns.filter((c) => !NEVER_SHOWN.test(c) && columnLabels[c] !== "");
  const monthsOf = (cols: string[]) => cols.filter((c) => /^(?:period|month)$/i.test(c)).filter((c) => {
    const vals = rows.map((r) => String(r[c] ?? "")).filter(Boolean);
    return vals.length > 0 && vals.every((v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(v));
  });
  const unchanged = { shown: visible, constants: [], labels: {}, months: monthsOf(visible) };
  if (rows.length === 0 || visible.length <= 2) return unchanged;
  columns = visible;
  // One row: only the known descriptive columns are folded (owner, 2026-10-22: a one-value answer showed all eight
  // columns); any other text column of a one-row table stays in the grid.
  const ONE_ROW_DESCRIPTIVE = /^(?:place|measure|unit|statistic)$/i;
  const shown: string[] = [];
  const constants: { column: string; value: string }[] = [];
  columns.forEach((col, i) => {
    const values = rows.map((r) => r[col]);
    // The first column labels the rows, except a place that is the same on every row and stated in the displayed title
    // while a year/month column labels the rows (owner 2026-10-23: "United States" repeated on 51 rows).
    const firstIsTitledPlace = col === "place" && rows.length > 1 && title !== "" && !isEmpty(values[0])
      && values.every((v) => String(v) === String(values[0])) && title.includes(String(values[0]))
      && columns.some((c) => /^(?:year|month|period)$/i.test(c));
    if (i === 0 && !firstIsTitledPlace) { shown.push(col); return; }
    if (i === 0) return;
    if (OPTIONAL_METADATA.test(col) && values.every(isEmpty)) return;
    const numeric = values.some((v) => typeof v === "number");
    const first = values[0];
    const constant = !numeric && !isEmpty(first) && values.every((v) => !isEmpty(v) && String(v) === String(first)) && (rows.length > 1 || ONE_ROW_DESCRIPTIVE.test(col));
    if (constant) { constants.push({ column: col, value: String(first) }); return; }
    shown.push(col);
  });
  if (shown.length < 2) return unchanged;

  const labels: Record<string, string> = {};
  const constantOf = (c: string) => constants.find((k) => k.column === c)?.value;
  // A period column named for its grain.
  const periodCol = shown.find((c) => /^(?:period|month)$/i.test(c));
  if (periodCol) {
    const vals = rows.map((r) => String(r[periodCol] ?? "")).filter(Boolean);
    if (vals.length && vals.every((v) => /^\d{4}-\d{2}$/.test(v))) labels[periodCol] = "Month";
    else if (vals.length && vals.every((v) => /^\d{4}$/.test(v))) labels[periodCol] = "Year";
  }
  // The value column named for its measure, unit and statistic, only for a supported combination; an absent column is
  // not the same as a varying one (a varying unit or statistic is in `shown`, so no name is given).
  const absorbed = new Set<string>();
  const measure = constantOf("measure");
  const fieldOf = (c: string): string | null | false => (!columns.includes(c) ? null : constantOf(c) ?? false);
  const unit = fieldOf("unit");
  const statistic = fieldOf("statistic");
  if (measure && shown.includes("value") && unit !== false && statistic !== false) {
    const name = valueLabel(measure, unit, statistic);
    if (name) { labels.value = name; for (const c of ["measure", "unit", "statistic"]) if (constantOf(c) !== undefined) absorbed.add(c); }
  }
  // Only the place is left out for a displayed title that contains its whole label.
  const placeShown = (c: { column: string; value: string }) => c.column === "place" && title !== "" && title.includes(c.value);
  const stated = constants.filter((c) => !absorbed.has(c.column) && !placeShown(c));
  // Codex r1: answer-supplied labels never rename a time column (year, month, period).
  for (const c of shown) if (columnLabels[c] && !labels[c] && !/^(?:year|month|period)$/i.test(c)) labels[c] = columnLabels[c];
  return { shown, constants: stated.filter((c) => !(RECORD_STATUS.test(c.column) && c.value === "recorded")), labels, months: monthsOf(shown) };
}
