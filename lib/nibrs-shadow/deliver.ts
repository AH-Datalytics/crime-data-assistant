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

/**
 * rows: the compiled query's rows, in `columns` order (period key first when grouped by time, then per statistic its
 * value and status). Only count statistics reach the slice.
 */
export function deliver(plan: NibrsPlan, effective: { from: string; to: string }, requestedTo: string, columns: string[], rows: unknown[][],
  statements: AnswerStatement[], release: string, readings: string[] = []): Delivered {
  const place = plan.geography.places[0];
  const agency = place.kind === "agency" ? place.label : "the place";
  const count = plan.statistics[0].as;
  const what = measureWords(plan);
  const header = `${what[0].toUpperCase()}${what.slice(1)}`;
  const labels: Record<string, string> = { [`statistic:${count}`]: header };
  const tableCols: ResultColumn[] = [];
  for (const g of plan.groupings) { labels[`grouping:${g.dimension}`] = GROUPING_HEADER[g.dimension] ?? g.dimension; tableCols.push({ binding: { kind: "grouping", dimension: g.dimension }, header: labels[`grouping:${g.dimension}`] }); }
  tableCols.push({ binding: { kind: "statistic", as: count }, header });
  const iv = columns.indexOf(count), is = columns.indexOf(`${count}_status`), ip = columns.indexOf("period");
  const evidence: CellEvidence[] = [];
  const tableRows = rows.map((r, i) => {
    const status = String(r[is]) as CellStatus;
    const value = r[iv] === null || r[iv] === undefined ? null : Number(r[iv]);
    evidence.push({ row: i, statistic: count, status });
    return [...(ip >= 0 ? [String(r[ip])] : []), value];
  });
  const table: ResultTable = { columns: tableCols, rows: tableRows };
  const text: string[] = [];
  const when = periodWords(effective.from, effective.to);
  const grain = plan.groupings[0]?.dimension;
  if (!grain) {
    const v = tableRows[0]?.[0] as number | null | undefined;
    text.push(v === null || v === undefined
      ? `${agency}: the available evidence does not establish the number of ${what} in ${when}, so no number is given.`
      : `${agency}: ${fmt(v)} ${what} in ${when}.`);
  } else {
    text.push(`${agency}: ${what} by ${grain === "time.month" ? "month" : "year"}, ${when}.`);
    const missing = rows.filter((r) => String(r[is]) === "UNKNOWN" || String(r[is]) === "NOT_REPORTED").map((r) => String(r[ip]));
    const unevidenced = rows.filter((r) => String(r[is]) === "UNKNOWN_UNEVIDENCED_ZERO").map((r) => String(r[ip]));
    // Only what the status establishes: an unknown month has no known report; a year is known only when all its months are.
    if (missing.length) text.push(grain === "time.year" ? `Not every month of ${runs(missing)} is known: shown blank, not zero.` : `No report is known for ${runs(missing)}: shown blank, not zero.`);
    if (unevidenced.length) text.push(`No ${what} were recorded for ${runs(unevidenced)}, and no zero report confirms a zero: shown blank.`);
  }
  if (effective.to < requestedTo) text.push(`The data runs through ${monthName(effective.to)}: this covers ${periodWords(effective.from, effective.to)}.`);
  // How a misspelled word was read (reading.ts), then the fixed statements; the source stays last.
  text.push(...readings);
  for (const s of statements) text.push(ANSWER_STATEMENTS[s]);
  text.push(SOURCE_STATEMENT(release));
  const chart = grain && tableRows.length > 1 ? { kind: grain === "time.month" ? "line" as const : "bar" as const, x: labels[`grouping:${grain}`], y: [header] } : null;
  const contractProblems = checkEnvelope({ plan, table, evidence, answerStatements: statements }, labels);
  for (const e of evidence) if (BLANK.includes(e.status) !== (table.rows[e.row][table.rows[e.row].length - 1] === null)) contractProblems.push(`row ${e.row}: value and status disagree`);
  return { table, evidence, chart, text, answerStatements: statements, contractProblems };
}
