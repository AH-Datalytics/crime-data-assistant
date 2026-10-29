/**
 * The delivered answer of the shadow slice: the compiled rows become the user-facing table (groupings and numbers only,
 * result.ts), its server-side evidence, a chart description, and the answer text. The text is built from fixed
 * templates and the authorized statements only: a headline that restates the table, the months with no data (D04), the
 * months covered when the period ends early (D06), the fixed statements, and the source statement last (D30). No
 * commentary, no causes, no comparisons the question did not ask for.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { ANSWER_STATEMENTS, checkEnvelope, type AnswerStatement, type CellEvidence, type CellStatus, type ResultColumn, type ResultTable } from "../nibrs-plan/result";
import { MEASURE_LABEL } from "../nibrs-question-types";
import { ETHNICITY_CODES, LOCATION_TYPES, RACE_CODES } from "../nibrs-codes";

export type Delivered = {
  table: ResultTable;
  evidence: CellEvidence[];
  /** A chart of a time series: the period column on x, the count on y. Null for a single number. */
  chart: { kind: "line" | "bar"; x: string; y: string[] } | null;
  /** Answer text, one sentence or block per line; the last line is always the source statement. */
  text: string[];
  answerStatements: AnswerStatement[];
  /** checkEnvelope's problems (empty when the table, evidence and statements meet the answer contract). */
  contractProblems: string[];
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
/** A month range in words: "2024", "2021 to 2025", "January to October 2026", "March 2021 to June 2025". */
export function periodWords(from: string, to: string): string {
  const fy = from.slice(0, 4), ty = to.slice(0, 4);
  if (from.endsWith("-01") && to.endsWith("-12")) return fy === ty ? fy : `${fy} to ${ty}`;
  if (fy === ty) return from === to ? monthName(from) : `${MONTHS[Number(from.slice(5)) - 1]} through ${monthName(to)}`;
  return `${monthName(from)} through ${monthName(to)}`;
}

const UNIT_PLURAL: Record<string, string> = { offense: "offenses", incident: "incidents", victim: "victims" };
/** "shoplifting offenses", "simple assault victims". */
export function measureWords(plan: NibrsPlan): string {
  const m = plan.measures[0];
  const name = m.id.replace(/^[a-z_]+\./, "");
  return `${MEASURE_LABEL[name] ?? name.replace(/_/g, " ")} ${UNIT_PLURAL[m.unit] ?? m.unit}`;
}
/** Consecutive periods as ranges: "January 2017 to June 2020, March 2021", "2017 to 2019". */
function runs(periods: string[]): string {
  const idx = (p: string) => (p.length === 7 ? Number(p.slice(0, 4)) * 12 + Number(p.slice(5)) - 1 : Number(p));
  const name = (p: string) => (p.length === 7 ? monthName(p) : p);
  const out: string[] = [];
  for (let i = 0; i < periods.length; ) {
    let j = i;
    while (j + 1 < periods.length && idx(periods[j + 1]) === idx(periods[j]) + 1) j++;
    out.push(i === j ? name(periods[i]) : `${name(periods[i])} to ${name(periods[j])}`);
    i = j + 1;
  }
  return out.join(", ");
}
const fmt = (n: number) => n.toLocaleString("en-US");
const GROUPING_HEADER: Record<string, string> = { "time.month": "Month", "time.year": "Year" };
const BLANK: CellStatus[] = ["UNKNOWN", "NOT_REPORTED", "UNKNOWN_UNEVIDENCED_ZERO", "UNAVAILABLE"];

export const SOURCE_STATEMENT = (release: string) =>
  `Source: FBI National Incident-Based Reporting System (NIBRS), as reported by the agency; canonical release ${release}.`;

/** Category groupings the slice delivers, with their header and their codes' names (lib/nibrs-codes.ts). */
const CATEGORY: Record<string, { header: string; plural: string; names: Record<string, string> }> = {
  "victim.race": { header: "Victim race", plural: "race", names: RACE_CODES },
  "victim.sex": { header: "Victim sex", plural: "sex", names: { F: "Female", M: "Male", U: "Unknown", X: "Non-binary" } },
  "victim.ethnicity": { header: "Victim ethnicity", plural: "ethnicity", names: ETHNICITY_CODES },
  "offense.location_type": { header: "Location type", plural: "location type", names: LOCATION_TYPES },
};
export const DELIVERED_CATEGORIES = new Set(Object.keys(CATEGORY));
/** A category's name: the code's name; a blank field is "Not recorded"; a code with no name keeps its code. */
export function categoryName(dimension: string, code: unknown): string {
  const c = code === null || code === undefined ? "" : String(code).trim();
  if (!c) return "Not recorded";
  return CATEGORY[dimension]?.names[c] ?? `Code ${c}`;
}

/**
 * rows: the compiled query's rows, in `columns` order: the period key when grouped by time, each category grouping, then
 * per statistic its value and status. Statistics: a count, and optionally its share within the time grouping (each
 * category's part of all units of its own period).
 */
export function deliver(plan: NibrsPlan, effective: { from: string; to: string }, requestedTo: string, columns: string[], rows: unknown[][],
  statements: AnswerStatement[], release: string, readings: string[] = []): Delivered {
  const place = plan.geography.places[0];
  const agency = place.kind === "agency" ? place.label : "the place";
  const [countStat, shareStat] = plan.statistics;
  const count = countStat.as, share = shareStat?.as;
  const what = measureWords(plan);
  const header = `${what[0].toUpperCase()}${what.slice(1)}`;
  const time = plan.groupings.find((g) => g.dimension.startsWith("time."))?.dimension;
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time.")).map((g) => g.dimension);
  const labels: Record<string, string> = { [`statistic:${count}`]: header };
  if (share) labels[`statistic:${share}`] = `Share of all ${what} (%)`;
  const tableCols: ResultColumn[] = [];
  for (const g of plan.groupings) {
    labels[`grouping:${g.dimension}`] = GROUPING_HEADER[g.dimension] ?? CATEGORY[g.dimension]?.header ?? g.dimension;
    tableCols.push({ binding: { kind: "grouping", dimension: g.dimension }, header: labels[`grouping:${g.dimension}`] });
  }
  tableCols.push({ binding: { kind: "statistic", as: count }, header });
  if (share) tableCols.push({ binding: { kind: "statistic", as: share }, header: labels[`statistic:${share}`] });
  const ip = columns.indexOf("period");
  const at = (name: string) => columns.indexOf(name);
  // Within each period, categories by count, largest first; blanks last; then by name.
  if (cats.length) {
    const n = (r: unknown[]) => (r[at(count)] === null || r[at(count)] === undefined ? -1 : Number(r[at(count)]));
    rows = [...rows].sort((x, y) => (ip >= 0 ? String(x[ip]).localeCompare(String(y[ip])) : 0) || n(y) - n(x)
      || categoryName(cats[0], x[at(cats[0])]).localeCompare(categoryName(cats[0], y[at(cats[0])])));
  }
  const evidence: CellEvidence[] = [];
  const tableRows = rows.map((r, i) => {
    const out: (string | number | null)[] = [];
    if (ip >= 0) out.push(String(r[ip]));
    for (const d of cats) out.push(categoryName(d, r[at(d)]));
    const cStatus = String(r[at(`${count}_status`)]) as CellStatus;
    const c = r[at(count)];
    out.push(c === null || c === undefined ? null : Number(c));
    evidence.push({ row: i, statistic: count, status: cStatus });
    if (share) {
      const sStatus = String(r[at(`${share}_status`)]) as CellStatus;
      const s = r[at(share)];
      out.push(s === null || s === undefined ? null : Math.round(Number(s) * 1000) / 10);
      evidence.push({ row: i, statistic: share, status: sStatus });
    }
    return out;
  });
  const table: ResultTable = { columns: tableCols, rows: tableRows };
  const text: string[] = [];
  const when = periodWords(effective.from, effective.to);
  const by = [time === "time.month" ? "month" : time === "time.year" ? "year" : null, ...cats.map((d) => CATEGORY[d]?.plural ?? d)].filter(Boolean).join(" and ");
  const statusOf = (r: unknown[]) => String(r[at(`${count}_status`)]);
  if (!time && !cats.length) {
    const v = tableRows[0]?.[0] as number | null | undefined;
    text.push(v === null || v === undefined
      ? `${agency}: the available evidence does not establish the number of ${what} in ${when}, so no number is given.`
      : `${agency}: ${fmt(v)} ${what} in ${when}.`);
  } else if (!cats.length) {
    text.push(`${agency}: ${what} by ${by}, ${when}.`);
    const missing = rows.filter((r) => statusOf(r) === "UNKNOWN" || statusOf(r) === "NOT_REPORTED").map((r) => String(r[ip]));
    const unevidenced = rows.filter((r) => statusOf(r) === "UNKNOWN_UNEVIDENCED_ZERO").map((r) => String(r[ip]));
    // Only what the status establishes: an unknown month has no known report; a year is known only when all its months are.
    if (missing.length) text.push(time === "time.year" ? `Not every month of ${runs(missing)} is known: shown blank, not zero.` : `No report is known for ${runs(missing)}: shown blank, not zero.`);
    if (unevidenced.length) text.push(`No ${what} were recorded for ${runs(unevidenced)}, and no zero report confirms a zero: shown blank.`);
  } else {
    text.push(`${agency}: ${what} by ${by}, ${when}.`);
    if (share) text.push(`Each share is that category's part of all ${what}${time ? ` in the same ${time === "time.month" ? "month" : "year"}` : ` in ${when}`}.`);
    // A category's total is known only when every month of it is: a month with none recorded and no zero report, or a
    // month not reported, leaves it unknown. The rolled status does not say which, so the sentence names both.
    const blank = tableRows.filter((_, i) => evidence.find((e) => e.row === i && e.statistic === count && BLANK.includes(e.status)))
      .map((r) => r.slice(ip >= 0 ? 1 : 0, (ip >= 0 ? 1 : 0) + cats.length).join(", ") + (ip >= 0 ? ` (${r[0]})` : ""));
    if (blank.length) text.push(`No total is established for ${blank.join("; ")}: reporting evidence is incomplete, or a month has none recorded without evidence establishing zero. Shown blank, not zero.`);
  }
  if (effective.to < requestedTo) text.push(`The data runs through ${monthName(effective.to)}: this covers ${periodWords(effective.from, effective.to)}.`);
  // How a misspelled word was read (reading.ts), then the fixed statements; the source stays last.
  text.push(...readings);
  for (const s of statements) text.push(ANSWER_STATEMENTS[s]);
  text.push(SOURCE_STATEMENT(release));
  // Charts bind one series per statistic: a time series of a single count only. Category charts wait until a series
  // can bind to each category (Codex plan review).
  const chart = time && !cats.length && tableRows.length > 1 ? { kind: time === "time.month" ? "line" as const : "bar" as const, x: labels[`grouping:${time}`], y: [header] } : null;
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  for (const e of evidence) {
    const col = tableCols.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === e.statistic);
    if (BLANK.includes(e.status) !== (table.rows[e.row][col] === null)) contractProblems.push(`row ${e.row}, ${e.statistic}: value and status disagree`);
  }
  return { table, evidence, chart, text, answerStatements: statements, contractProblems };
}
