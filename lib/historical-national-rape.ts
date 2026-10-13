/**
 * The Historical national rape correction (plan docs/superpowers/plans/2026-10-13-historical-national-rape-fix.md r4,
 * Codex-accepted; preregistered in audit/historical-national-rape-fix-2026-10-13/).
 *
 * historical_state_national's 'United States' rape row is corrected for 2017-2024 to CIUS Table 1's revised-definition
 * estimate by scripts/correct-historical-national-rape.py (or the importer), which also creates the marker table
 * `historical_national_rape_correction`. Until that has happened, every delivered text here is exactly today's.
 *
 * CORRECTION STATE: true only when, in the SAME snapshot as the answer's rows (Codex clarification 1), the marker table
 * exists AND the stored 2018 national rape equals Table 1's 144,505. It is read per request, never cached.
 *
 * NOTES, applied only when the state is true, and stripped when it is false, so a text never disagrees with the rows it
 * was delivered with (a cached explanation from the other state included):
 *   N1  an accepted rape-count form on historical_state_national whose years cross 2016/2017;
 *   N2  the national violent composite whose years cross 2016/2017;
 *   N3  a national rape-count form or the national violent composite that returns 2021 (independent of GC-085's 2013 rule).
 */
import type Database from "better-sqlite3";
import { executeManyWithTimeoutSync, BOUNDED_EXECUTION_UNAVAILABLE } from "./query-timeout";
import { returnedRapeCountColumn } from "./historical-rape-series";
import { returnedViolentComposite, singleStateWhere } from "./historical-composite-measure";

export const N1_STATE_NATIONAL_DEFINITION = "In this table, state rape figures follow the FBI's legacy definition through 2016 and its revised definition from 2017, and national figures from 2017 are the FBI's revised estimates (CIUS Table 1).";
export const N2_COMPOSITE_DEFINITION = "From 2017, its rape component is the FBI's revised-definition estimate (CIUS Table 1).";
export const N3_2021_LIMITATION = "The FBI says its 2021 national estimates are not nationally representative and are not comparable with other years (CIUS Table 1, note 4).";
const NOTES = [N1_STATE_NATIONAL_DEFINITION, N2_COMPOSITE_DEFINITION, N3_2021_LIMITATION];

export const CORRECTION_TABLE = "historical_national_rape_correction";
const SENTINEL_YEAR = 2018;
const SENTINEL_RAPE = 144505;
/** The two state reads, in this order; they run in the answer's snapshot. Both are valid whether or not the marker exists. */
export const CORRECTION_STATE_SQL = [
  `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '${CORRECTION_TABLE}'`,
  `SELECT rape FROM historical_state_national WHERE state = 'United States' AND year = ${SENTINEL_YEAR}`,
];

type Rows = Record<string, unknown>[];

/** The state from the two state reads' results. */
export function correctionStateFrom(marker: Rows, sentinel: Rows): boolean {
  return Number(marker[0]?.n) === 1 && sentinel.length === 1 && Number(sentinel[0]?.rape) === SENTINEL_RAPE;
}

/** The state on its own (for the cache lookup key before execution), both reads in one read transaction. */
export function readCorrectionState(db: Database.Database): boolean {
  try {
    const read = db.transaction(() => CORRECTION_STATE_SQL.map((sql) => db.prepare(sql).all() as Rows));
    const [marker, sentinel] = read();
    return correctionStateFrom(marker, sentinel);
  } catch {
    return false; // no historical_state_national at all: nothing was corrected
  }
}

type ExecuteMany = (db: Database.Database, statements: string[], timeoutMs: number) => Rows[];

/**
 * The answer's rows and the correction state from ONE snapshot (Codex clarification 1): the bounded many-statement
 * worker runs the answer SQL and the two state reads in a single read transaction. Where the worker is unavailable,
 * the same three reads run in one synchronous read transaction -- the same unbounded fallback the single-statement
 * executor already uses.
 */
export function executeWithCorrectionState(
  db: Database.Database,
  sql: string,
  timeoutMs = 30000,
  seam?: { executeMany?: ExecuteMany },
): { rows: Rows; corrected: boolean } {
  const statements = [sql, ...CORRECTION_STATE_SQL];
  let results: Rows[];
  try {
    results = (seam?.executeMany ?? ((d, s, t) => executeManyWithTimeoutSync<Record<string, unknown>>(d, s, t)))(db, statements, timeoutMs);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== BOUNDED_EXECUTION_UNAVAILABLE) throw error;
    results = db.transaction(() => statements.map((s) => db.prepare(s).all() as Rows))();
  }
  const [rows, marker, sentinel] = results;
  return { rows, corrected: correctionStateFrom(marker, sentinel) };
}

/**
 * The Historical response-cache validity for a correction state (amendment 3). Uncorrected: `base` unchanged, so keys
 * are byte-identical to today in every proof mode. Corrected: a suffix that does not depend on the proof mode, so the
 * two states never share an entry and off/shadow still share one (invariant 14; lib/proof-cache-validity.ts).
 */
export function historicalCacheValidity(base: string | undefined, corrected: boolean): string | undefined {
  return corrected ? `${base ?? "nil"}|hnr=1` : base;
}

const structural = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\s+/g, " ").trim();

function readsStateNational(sql: string): boolean {
  return /\bfrom\s+historical_state_national\b/i.test(structural(sql));
}

function isNational(sql: string): boolean {
  const where = /\bwhere\s+(.+?)(?:\s+order\s+by\s|\s+limit\s|;|$)/i.exec(structural(sql));
  return Boolean(where) && singleStateWhere(where![1].trim()) === "United States";
}

function stripNotes(text: string): string {
  let out = text;
  for (const note of NOTES) out = out.split(note).join("");
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trimEnd();
}

function appendNote(text: string, note: string): string {
  const base = text.trimEnd();
  return base ? `${base} ${note}` : note;
}

/** The notes this result carries in the given state; idempotent, and a no-op for every other result. */
export function withHistoricalNationalRapeNotes(explanation: string, sql: string | null | undefined, rows: Rows, corrected: boolean): string {
  const hadNote = NOTES.some((n) => explanation.includes(n));
  if (!sql || !Array.isArray(rows) || rows.length === 0) return hadNote ? stripNotes(explanation) : explanation;
  const columns = Object.keys(rows[0]);
  const years = [...new Set(rows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y)))];
  const crosses = years.some((y) => y <= 2016) && years.some((y) => y >= 2017);
  const has2021 = years.includes(2021);
  const rapeForm = readsStateNational(sql) && returnedRapeCountColumn(sql, columns) !== null;
  const composite = returnedViolentComposite(sql, columns) !== null;

  const wanted: string[] = [];
  if (corrected) {
    if (rapeForm && crosses) wanted.push(N1_STATE_NATIONAL_DEFINITION);
    if (composite && crosses) wanted.push(N2_COMPOSITE_DEFINITION);
    if (has2021 && ((rapeForm && isNational(sql)) || composite)) wanted.push(N3_2021_LIMITATION);
  }
  if (!hadNote && wanted.length === 0) return explanation;
  let out = hadNote ? stripNotes(explanation) : explanation;
  for (const note of wanted) out = appendNote(out, note);
  return out;
}
