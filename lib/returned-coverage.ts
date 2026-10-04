/**
 * Returned-value coverage (COVER batch; Codex scope, handoff :34982).
 *
 * An annual answer must say what years of VALUES it actually returned for each series, against the years the
 * request asked for, and which interior years have no value. October's failures: "since 1930" for NYC vs LA returned
 * calendar rows from 1930 whose values begin in 1935 and 1932 (NYC 1949-1951 and LA 1934 empty); "1930-present"
 * returned 1958-2024 with only the start mentioned; per-state rates "since 1960" hid DC from 1980 and Puerto Rico
 * 1971-1994 with 1975 and 1984 empty.
 *
 * Rules (from the scope):
 *  - a year counts only when the series has a numeric VALUE there; null does not, zero does;
 *  - wording is about the returned values ("values returned", "no value returned"), never a claim that the source
 *    holds no data or that an agency did not report;
 *  - series are identified from the delivered rows: a place key column (with its state qualifier) in long results, or
 *    one value column per series in wide results; population, identifiers and completeness metadata are not series;
 *  - no inference for monthly results, rows without a year, single-year results, or deliberately selected years
 *    (an IN list or OR'd year equalities): gaps there are the request, not missing values;
 *  - every affected series and year is named (no "and N others"); unaffected series are summarized together.
 * Read-only: it returns a sentence or null and never changes rows, SQL or values.
 */

type Row = Record<string, unknown>;

const YEAR_COLS = ["year", "data_year", "Year"];
const MONTH_COL = /^(month|month_num|month_number|period|date|year_month)$/i;
const PLACE_COLS = ["agency_name", "agency", "city", "place", "county", "state_name", "state", "ori"];
const NOT_A_SERIES = /^(year|data_year|month|population|pop|.*_population|ori|ori9|.*_ori|.*_id|id|rank|months?_reported|.*months.*|.*coverage.*|agency_count|.*agencies|n_.*|.*reporting.*|.*completeness.*|state|state_name|state_abbr|city|agency|agency_name|place|county|type)$/i;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function isNum(v: unknown): boolean {
  return typeof v === "number" ? Number.isFinite(v) : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v));
}

/** "1949, 1950, 1951, 1953" -> "1949–1951 and 1953". */
export function yearList(years: number[]): string {
  const ys = [...new Set(years)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < ys.length; i += 1) {
    let j = i;
    while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j += 1;
    parts.push(j > i ? `${ys[i]}–${ys[j]}` : String(ys[i]));
    i = j;
  }
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function strip(sql: string): string {
  return sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
}

/** Deliberately selected (non-range) years: gaps between them are the request, not missing values. */
function selectsListedYears(sql: string, question: string): boolean {
  const s = strip(sql);
  if (/\b(?:year|data_year)\s+IN\s*\(/i.test(s)) return true;
  if ((s.match(/\b(?:year|data_year)\s*=\s*(?:19|20)\d{2}\b/gi) || []).length > 1) return true;
  // "2015 and 2020", "2015, 2018 and 2021" without a range word. A numeric range ("2000-2010", "2000–2010",
  // "2000 — 2010") is read on the original question: separators are not word characters, so they cannot be tested
  // with word boundaries once the years are removed (COVER-R1b).
  const years = question.match(/\b(?:19|20)\d{2}\b/g) || [];
  if (years.length < 2) return false;
  if (/\b(?:19|20)\d{2}\s*[-–—]\s*(?:(?:19|20)\d{2}|present|now|today)\b/i.test(question)) return false;
  return !/\b(?:since|from|between|through|thru|to|until|present|now)\b/i.test(question.replace(/\b(?:19|20)\d{2}\b/g, " "));
}

function requestedStart(question: string, sql: string): number | null {
  const q = [
    /\b(?:since|from|starting(?:\s+in)?|beginning(?:\s+in)?)\s+(?:the\s+year\s+)?((?:19|20)\d{2})\b/i,
    /\b((?:19|20)\d{2})\s*(?:-|–|—|to|through|thru|until)\s*(?:(?:19|20)\d{2}|present|now|today|date)\b/i,
    /\bbetween\s+((?:19|20)\d{2})\s+and\s+(?:19|20)\d{2}\b/i,
  ];
  for (const p of q) { const m = question.match(p); if (m) return Number(m[1]); }
  const s = strip(sql);
  const between = s.match(/\b(?:year|data_year)\s+BETWEEN\s+((?:19|20)\d{2})\s+AND\s+(?:19|20)\d{2}/i);
  if (between) return Number(between[1]);
  const lower = s.match(/\b(?:year|data_year)\s*>=\s*((?:19|20)\d{2})\b/i);
  return lower ? Number(lower[1]) : null;
}

function requestedEnd(question: string, sql: string, currentYear: number): { year: number; present: boolean } | null {
  if (/\b(?:-|–|—|to|through|thru|until|till)\s*(?:the\s+)?(?:present|now|today|date)\b|\bto\s+date\b|\bpresent\b/i.test(question)) {
    return { year: currentYear, present: true };
  }
  const m = question.match(/\b(?:19|20)\d{2}\s*(?:-|–|—|to|through|thru|until)\s*((?:19|20)\d{2})\b/i) ||
    question.match(/\bbetween\s+(?:19|20)\d{2}\s+and\s+((?:19|20)\d{2})\b/i);
  if (m) return { year: Number(m[1]), present: false };
  const s = strip(sql);
  const between = s.match(/\b(?:year|data_year)\s+BETWEEN\s+(?:19|20)\d{2}\s+AND\s+((?:19|20)\d{2})/i);
  if (between) return { year: Number(between[1]), present: false };
  const upper = s.match(/\b(?:year|data_year)\s*<=\s*((?:19|20)\d{2})\b/i);
  return upper ? { year: Number(upper[1]), present: false } : null;
}

function humanize(column: string): string {
  return column.replace(/_/g, " ").replace(/\bper 100k\b/i, "per 100,000").trim();
}

type Series = { label: string; values: Map<number, boolean> };

/** Identify annual value series in delivered rows, or null when the result is not an annual series form. */
export function annualSeries(rows: Row[]): { series: Series[]; years: number[] } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const cols = Object.keys(rows[0]);
  const yearCol = YEAR_COLS.find((c) => cols.includes(c));
  if (!yearCol || cols.some((c) => MONTH_COL.test(c))) return null;
  const years = [...new Set(rows.map((r) => Number(r[yearCol])).filter((y) => Number.isInteger(y)))].sort((a, b) => a - b);
  if (years.length < 2) return null;
  const placeCols = PLACE_COLS.filter((c) => cols.includes(c));
  const placeKey = placeCols.find((c) => c !== "state" && c !== "state_name" && c !== "ori") ?? placeCols[0] ?? null;
  const stateQual = placeKey && placeKey !== "state" && placeKey !== "state_name" ? (cols.includes("state") ? "state" : cols.includes("state_name") ? "state_name" : null) : null;
  const valueCols = cols.filter((c) => c !== yearCol && !NOT_A_SERIES.test(c) && rows.some((r) => isNum(r[c]) || r[c] === null));
  const numericValueCols = valueCols.filter((c) => rows.some((r) => isNum(r[c])) || rows.every((r) => r[c] === null));
  if (numericValueCols.length === 0) return null;
  const series = new Map<string, Series>();
  const add = (label: string, year: number, v: unknown) => {
    const s = series.get(label) ?? { label, values: new Map<number, boolean>() };
    s.values.set(year, (s.values.get(year) ?? false) || isNum(v));
    series.set(label, s);
  };
  for (const r of rows) {
    const y = Number(r[yearCol]);
    if (!Number.isInteger(y)) continue;
    const place = placeKey ? [r[placeKey], stateQual ? r[stateQual] : null].filter((x) => x != null && x !== "").join(", ") : "";
    for (const c of numericValueCols) {
      const label = place && numericValueCols.length > 1 ? `${place} (${humanize(c)})` : place || (numericValueCols.length > 1 ? humanize(c) : "");
      add(label, y, r[c]);
    }
  }
  // A long result must have one row per series-year; repeated series-years mean it is not a plain annual series.
  if (placeKey) {
    const seen = new Set<string>();
    for (const r of rows) {
      const k = `${r[placeKey]}|${stateQual ? r[stateQual] : ""}|${r[yearCol]}`;
      if (seen.has(k)) return null;
      seen.add(k);
    }
  }
  return { series: [...series.values()], years };
}

/**
 * The coverage sentence for an annual answer, or null when every series has a value for every year in its requested
 * span (or the form is not one this applies to). Completeness and every affected series/year come from the rows
 * alone: existing narrative never removes a fact (COVER-R1a). A truthful model sentence may therefore be repeated.
 */
export function returnedCoverageNote(opts: { question: string; sql: string; rows: Row[]; currentYear?: number; lowerBoundOnlyStatedFor?: number | null }): string | null {
  const form = annualSeries(opts.rows);
  if (!form) return null;
  const listed = selectsListedYears(opts.sql || "", opts.question || "");
  if (listed) return null;
  const currentYear = opts.currentYear ?? new Date().getUTCFullYear();
  const start = requestedStart(opts.question || "", opts.sql || "");
  const end = requestedEnd(opts.question || "", opts.sql || "", currentYear);
  type Finding = { label: string; first: number | null; last: number | null; gaps: number[]; late: boolean; early: boolean };
  const findings: Finding[] = [];
  const clean: Finding[] = [];
  for (const s of form.series) {
    const have = [...s.values.entries()].filter(([, v]) => v).map(([y]) => y).sort((a, b) => a - b);
    if (have.length === 0) { findings.push({ label: s.label, first: null, last: null, gaps: [], late: false, early: false }); continue; }
    const first = have[0], last = have[have.length - 1];
    const gaps: number[] = [];
    for (let y = first; y <= last; y += 1) if (!have.includes(y)) gaps.push(y);
    const f = { label: s.label, first, last, gaps, late: start !== null && first > start, early: end !== null && last < end.year };
    (f.late || f.early || f.gaps.length ? findings : clean).push(f);
  }
  if (findings.length === 0) return null;
  const requested = start !== null || end !== null
    ? ` (requested ${start ?? "the earliest year"} to ${end ? (end.present ? `the present, ${end.year}` : end.year) : "the latest year"})`
    : "";
  const describe = (f: Finding) => f.first === null
    ? "no value returned for any year"
    : `values returned ${f.first === f.last ? f.first : `${f.first}–${f.last}`}${f.gaps.length ? `, with no value returned for ${yearList(f.gaps)}` : ""}`;
  const single = form.series.length === 1;
  if (single) {
    const f = findings[0];
    // The existing start-year sentence already says everything when the only finding is a late start it names.
    if (f.late && !f.early && f.gaps.length === 0 && opts.lowerBoundOnlyStatedFor === f.first) return null;
    return `Returned coverage${requested}: ${describe(f)}.`;
  }
  // Group series that share a description, naming every affected series.
  const groups = new Map<string, string[]>();
  for (const f of findings) groups.set(describe(f), [...(groups.get(describe(f)) ?? []), f.label]);
  const parts = [...groups.entries()].map(([d, labels]) => `${labels.join(", ")}: ${d}`);
  let note = `Returned coverage by series${requested}: ${parts.join("; ")}.`;
  if (clean.length > 0) {
    const spans = new Set(clean.map((f) => `${f.first}–${f.last}`));
    note += spans.size === 1
      ? ` ${clean.length === 1 ? "The other series has" : `The other ${clean.length} series have`} a value for every year ${[...spans][0]}.`
      : ` The other ${clean.length} series have a value for every year in their returned span.`;
  }
  return note;
}

/** Month names for a sorted list of month numbers (1-12); invalid entries are dropped. */
export function monthNames(months: number[]): string {
  const valid = [...new Set(months.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  return valid.map((m) => MONTHS[m - 1]).join(", ");
}
