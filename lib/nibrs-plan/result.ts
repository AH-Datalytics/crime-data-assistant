/**
 * The result envelope and provenance every NIBRS answer carries (restructure plan, design point 9). The COMPILER
 * fills it, never the model. Caches are keyed by `cacheKey`, which includes every version that can change an answer.
 *
 * THE RESULT-COLUMN RULE (owner, 2026-10-28: "We should never need status and notes"; "the tables and exports should
 * only give the appropriate columns"). A user-facing table, and every export of it, has two kinds of column only:
 * groupings (place, period, category) and numbers. No status, note, caveat, label or flag column. An unknown number is
 * a blank (null): never zero, never a label. Everything else the engine knows about a cell (its D6 status, why a rate
 * is unavailable, a share's parts, a rate's cohort) is server-side `evidence`, never a column. The current app enforces
 * the same contract at egress (`lib/answer-columns.ts`); `checkResultTable` is this engine's form of it.
 */
import type { AbsolutePeriod, NibrsPlan } from "./plan";

/** A user-facing column: a grouping (its values are place, period or category names) or a number. */
export type ResultColumn = { name: string; role: "grouping" | "number" };

/** What users see and export: grouping values and numbers. A null number is unknown and shows blank. */
export type ResultTable = {
  columns: ResultColumn[];
  rows: (string | number | null)[][];
};

/** Server-side only: why a number is what it is, or why it is blank. Never a column, never exported to users. */
export type CellStatus =
  | "VALUE"                     // a number, from known months
  | "REPORTED_ZERO"             // 0 from an evidenced zero report
  | "UNKNOWN"                   // no evidence for the agency-month
  | "NOT_REPORTED"              // evidence the agency did not submit
  | "UNKNOWN_UNEVIDENCED_ZERO"  // no rows for this filtered measure in a month not evidenced complete (D6)
  | "UNAVAILABLE";              // a rate, share or ratio that cannot be computed; `reason` says why

export type CellEvidence = {
  row: number;                  // index into ResultTable.rows
  column: string;               // a number column's name
  status: CellStatus;
  reason?: string;
  /** Shares and ratios: the parts (shown to users only as their own number columns when the plan asks for them). */
  numerator?: number | null;
  denominator?: number | null;
  /** Rates: observed count over all reporting agencies, the eligible cohort's count, and its covered population. */
  observedCount?: number | null;
  eligibleCount?: number | null;
  coveredPopulation?: number | null;
};

export type ResultEnvelope = {
  plan: NibrsPlan;
  planDigest: string;
  versions: {
    planLanguage: string;
    semantic: string;
    canonicalRelease: string;      // canonical release_id
    canonicalManifestSha256: string;
    servingArtifact: string;       // NIBRSAI artifact id (accelerators included)
    compiler: string;              // NIBRSAI commit
  };
  /** The interpretation as resolved against the release: what the answer actually covers. */
  resolved: {
    period: AbsolutePeriod | { kind: "years"; years: number[] };
    comparisons: { earlier: AbsolutePeriod; later: AbsolutePeriod }[];
    places: { place: NibrsPlan["geography"]["places"][number]; agencies: number }[];
    combinedAgencies?: { total: number; deduplicated: number };
    defaults: NibrsPlan["defaults"];
  };
  compiled: { sql: string; sha256: string; accelerator: string | null };
  /** For each statistic: its denominator and the cohort rule that selected agencies. */
  denominators: { statistic: string; rule: string; cohort: string; agencies: number }[];
  transformations: string[];
  /** Rows dropped by a rank limit, with the count. Nothing is truncated silently (server-side, like all provenance). */
  truncation: { what: string; count: number }[];
  /** The user-facing table: groupings and numbers only (checkResultTable). */
  table: ResultTable;
  /**
   * Answer text, never a table column: only the statements the plan language requires (property not attributed to one
   * offense, case N2; "reported NIBRS counts" for a national answer). No other notes (owner: minimize editorializing).
   */
  answerStatements: string[];
  /** Server-side evidence for the table's number cells. Never rendered as columns or exported to users. */
  evidence: CellEvidence[];
  cacheKey: string;
};

const FORBIDDEN_NAME = /\b(?:status|note|notes|caveat|caveats|label|labels|flag|flags|reason|warning)\b/i;

/** The result-column rule, checked before a table leaves the engine. Returns problems; empty means compliant. */
export function checkResultTable(table: ResultTable): string[] {
  const out: string[] = [];
  table.columns.forEach((c) => {
    if (c.role !== "grouping" && c.role !== "number") out.push(`column "${c.name}" is neither a grouping nor a number`);
    if (FORBIDDEN_NAME.test(c.name.replace(/_/g, " "))) out.push(`column "${c.name}" is a status, note, caveat, label or flag column`);
  });
  table.rows.forEach((r, i) => {
    if (r.length !== table.columns.length) out.push(`row ${i} has ${r.length} values for ${table.columns.length} columns`);
    r.forEach((v, j) => {
      const c = table.columns[j];
      if (!c) return;
      if (c.role === "number" && v !== null && (typeof v !== "number" || !Number.isFinite(v))) out.push(`row ${i}, "${c.name}": a number column holds ${JSON.stringify(v)}; unknown is null`);
      if (c.role === "grouping" && (v === null || v === "")) out.push(`row ${i}, "${c.name}": a grouping value is blank`);
    });
  });
  return out;
}
