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
 * Stage 2a's typed answers carry the same notes, decided per delivered series by the same rules (notesFor), not from SQL text.
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

/**
 * One delivered series, in the terms the notes are decided by. `rapeCount`: a rape count on historical_state_national (a
 * state or the nation). `violentComposite`: the national violent composite, count or rate. `years`: the years whose
 * delivered value is not null.
 */
export type RapeNoteSeries = { rapeCount: boolean; violentComposite: boolean; national: boolean; years: number[] };

/** The notes a set of delivered series carries: the union, each once, in the order N1, N2, N3. The one rule set. */
function notesFor(series: RapeNoteSeries[], corrected: boolean): string[] {
  if (!corrected) return [];
  const wanted = new Set<string>();
  for (const s of series) {
    const crosses = s.years.some((y) => y <= 2016) && s.years.some((y) => y >= 2017);
    if (s.rapeCount && crosses) wanted.add(N1_STATE_NATIONAL_DEFINITION);
    if (s.violentComposite && crosses) wanted.add(N2_COMPOSITE_DEFINITION);
    if (s.years.includes(2021) && ((s.rapeCount && s.national) || s.violentComposite)) wanted.add(N3_2021_LIMITATION);
  }
  return NOTES.filter((n) => wanted.has(n));
}

function applyNotes(explanation: string, wanted: string[]): string {
  const hadNote = NOTES.some((n) => explanation.includes(n));
  if (!hadNote && wanted.length === 0) return explanation;
  let out = hadNote ? stripNotes(explanation) : explanation;
  for (const note of wanted) out = appendNote(out, note);
  return out;
}

/** The notes this result carries in the given state; idempotent, and a no-op for every other result. */
export function withHistoricalNationalRapeNotes(explanation: string, sql: string | null | undefined, rows: Rows, corrected: boolean): string {
  if (!sql || !Array.isArray(rows) || rows.length === 0) return applyNotes(explanation, []);
  const columns = Object.keys(rows[0]);
  const years = [...new Set(rows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y)))];
  const rapeCount = readsStateNational(sql) && returnedRapeCountColumn(sql, columns) !== null;
  const violentComposite = returnedViolentComposite(sql, columns) !== null;
  return applyNotes(explanation, notesFor([{ rapeCount, violentComposite, national: isNational(sql), years }], corrected));
}

/** One series a stage 2a typed answer delivered (lib/historical-question-compiler.ts `deliveredSeries`). */
export type TypedDeliveredSeries = { source: string; placeKind: "national" | "state" | "agency"; measure: string; statistic: string; years: number[] };

/**
 * A typed answer's series in note terms (plan 2026-10-18-stack-typed-historical-rape-notes r2 §2). A rape count on the
 * state/national table, for a state or the nation; the national violent composite as a count or a rate per 100,000.
 * Standalone rape rates, `total` and every other source or measure carry no note (the accepted scope).
 */
export function typedRapeNoteSeries(delivered: TypedDeliveredSeries[]): RapeNoteSeries[] {
  return delivered.map((d) => ({
    rapeCount: d.source === "state_national" && d.measure === "rape" && d.statistic === "count",
    violentComposite: d.source === "state_national" && d.placeKind === "national" && d.measure === "violent" && (d.statistic === "count" || d.statistic === "rate_per_100k"),
    national: d.placeKind === "national",
    years: d.years,
  }));
}

/** A typed answer's notes from its delivered series; the same rules as the model path, idempotent, stripped when not corrected. */
export function withTypedHistoricalRapeNotes(explanation: string, delivered: TypedDeliveredSeries[], corrected: boolean): string {
  return applyNotes(explanation, notesFor(typedRapeNoteSeries(delivered), corrected));
}

export const TYPED_STATE_CHANGED = "The Historical data changed while this answer was being built, so I haven't answered with a number. Please ask again.";

/** One state for a typed answer from its statements' states: all agree, or "changed" (the data changed mid-answer). */
export function typedCorrectionState(states: boolean[]): boolean | "changed" {
  if (states.length === 0) return false;
  return states.every((s) => s === states[0]) ? states[0] : "changed";
}
