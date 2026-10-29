/**
 * The result envelope and provenance every NIBRS answer carries (restructure plan, design point 9). The COMPILER
 * fills it, never the model. Caches are keyed by `cacheKey`, which includes every version that can change an answer.
 *
 * THE RESULT-COLUMN RULE (owner, 2026-10-28: "We should never need status and notes"; "the tables and exports should
 * only give the appropriate columns"). A user-facing table, and every export of it, has two kinds of column only:
 * the plan's groupings (place, period, category) and the plan's numbers. No status, note, caveat, label or flag
 * column. An unknown number is a blank (null): never zero, never a label. A category value is data, including an
 * unknown category ("Unknown" race) and substantive categories such as a clearance type. Everything the engine knows
 * about a cell beyond its number (its D6 status, why it is blank, a share's parts, a rate's cohort) is server-side
 * `evidence`, never a column and never answer text.
 *
 * Enforcement is by purpose, not by words: every column is bound to one grouping or one statistic of the plan, and
 * its header is the compiler's template for that binding (`columnHeader`), so no column, header or value can carry
 * anything else. `checkEnvelope` checks the table, the evidence and the answer statements together.
 * The current app is being given the same contract (plan: docs/superpowers/specs/2026-10-28-answer-columns-and-chart-
 * labels.md, branch fix/answer-columns-only-data; implementation pending). Its guard tests will cover this engine's
 * tables once it produces them.
 */
import type { AbsolutePeriod, NibrsPlan, Source } from "./plan";

/** A user-facing column, bound to exactly one grouping or one statistic of the plan. */
export type ResultColumn =
  | { binding: { kind: "grouping"; dimension: string }; header: string }
  | { binding: { kind: "statistic"; as: string }; header: string };

/** What users see and export: grouping values and numbers. A null number is unknown and shows blank. */
export type ResultTable = {
  columns: ResultColumn[];
  rows: (string | number | null)[][];
};

/** Server-side only: why a number is what it is, or why it is blank. */
export type CellStatus =
  | "VALUE"                     // a number from known evidence (it may be 0, e.g. in a month evidenced complete)
  | "REPORTED_ZERO"             // 0 from an evidenced zero report
  | "UNKNOWN"                   // no evidence for the agency-month
  | "NOT_REPORTED"              // evidence the agency did not submit
  | "UNKNOWN_UNEVIDENCED_ZERO"  // no rows for this filtered measure in a month not evidenced complete (D6)
  | "UNAVAILABLE";              // a rate, share or ratio that cannot be computed; `reason` says why
const BLANK: CellStatus[] = ["UNKNOWN", "NOT_REPORTED", "UNKNOWN_UNEVIDENCED_ZERO", "UNAVAILABLE"];

export type CellEvidence = {
  row: number;                  // index into ResultTable.rows
  statistic: string;            // the statistic's `as`: unique per table, so a cell's identity is (row, statistic)
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

/**
 * The only answer text the engine adds, each with fixed wording (owner: minimize editorializing). Never a column.
 * - property_not_attributed: a plan with an incident-scoped property existence filter (case N2);
 * - reported_nibrs_counts: a plan whose geography is the nation;
 * - property_counted_by_offense: a question that asked for victims of a property crime, answered with offenses (P11).
 *   It depends on the question's words, not the plan, so checkEnvelope authorizes it but cannot require it.
 * - categories_overlap: a plan with a multi-valued grouping (the weapons of an offense, the relationships of a victim);
 * - arrests_counted_once: a plan that counts arrests (P46).
 */
export const ANSWER_STATEMENTS = {
  property_not_attributed: "NIBRS records property for the incident, not for one offense, so the property is not attributed to a single offense.",
  reported_nibrs_counts: "These are reported NIBRS counts.",
  property_counted_by_offense: "Property crimes are counted by offense, not by victim.",
  categories_overlap: "A crime with several of these categories counts once under each, so the categories can add up to more than the total.",
  arrests_counted_once: "Each arrest counts once; NIBRS cannot tell when one person was arrested more than once.",
} as const;
export type AnswerStatement = keyof typeof ANSWER_STATEMENTS;
/** Each statement belongs to one source (G8): it is authorized, and required, only for that source's plans. */
export const STATEMENT_SOURCE: Record<AnswerStatement, Source> = { property_not_attributed: "nibrs", reported_nibrs_counts: "nibrs", property_counted_by_offense: "nibrs", categories_overlap: "nibrs", arrests_counted_once: "nibrs" };

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
  /** Rows dropped by a rank limit, with the count (server-side, like all provenance). */
  truncation: { what: string; count: number }[];
  /** The user-facing table. */
  table: ResultTable;
  /** Server-side evidence, one per number cell. Never rendered as columns or exported to users. */
  evidence: CellEvidence[];
  /** Answer text: only these, with their fixed wording. */
  answerStatements: AnswerStatement[];
  cacheKey: string;
};

/**
 * A column's header, from the compiler's templates only: the semantic layer's label for a grouping's dimension, and
 * the statistic's own description (built by the compiler from the measure label, unit, period and, for rates, the
 * population wording). `labels` are those strings, keyed by binding.
 */
export function columnHeader(binding: ResultColumn["binding"], labels: Record<string, string>): string | undefined {
  return labels[binding.kind === "grouping" ? `grouping:${binding.dimension}` : `statistic:${binding.as}`];
}

/**
 * The plan's number outputs after its transforms: a statistic in a period comparison becomes one output per requested
 * comparison output ("victims.earlier", "victims.later", "victims.change", "victims.pct_change"); rolling windows and
 * ranks keep the statistic's name.
 */
export function finalStatistics(plan: NibrsPlan): string[] {
  const compared = new Map<string, string[]>();
  for (const t of plan.transforms) if (t.kind === "period_comparison") for (const s of t.of) compared.set(s, t.outputs);
  return plan.statistics.flatMap((s) => (compared.has(s.as) ? compared.get(s.as)!.map((o) => `${s.as}.${o}`) : [s.as]));
}

/** The result-column rule over a whole envelope. Returns problems; empty means compliant. */
export function checkEnvelope(env: Pick<ResultEnvelope, "plan" | "table" | "evidence" | "answerStatements">, labels: Record<string, string>): string[] {
  const out: string[] = [];
  const { plan, table } = env;
  const groupings = plan.groupings.map((g) => g.dimension);
  const stats = finalStatistics(plan);

  // Columns: exactly the plan's groupings and statistics, each once, each with its template header.
  const bound = table.columns.map((c) => (c.binding.kind === "grouping" ? `grouping:${c.binding.dimension}` : `statistic:${c.binding.as}`));
  const want = [...groupings.map((d) => `grouping:${d}`), ...stats.map((s) => `statistic:${s}`)];
  for (const b of bound) if (!want.includes(b)) out.push(`column ${b} is not one of the plan's groupings or statistics`);
  for (const w of want) if (bound.filter((b) => b === w).length !== 1) out.push(`${w} must have exactly one column`);
  table.columns.forEach((c) => {
    const h = columnHeader(c.binding, labels);
    if (h === undefined || c.header !== h) out.push(`column header "${c.header}" is not the template header ${h === undefined ? "(none)" : `"${h}"`}`);
  });
  const headers = table.columns.map((c) => c.header);
  if (new Set(headers).size !== headers.length) out.push("two columns share a header");

  // Values: groupings are non-blank names; numbers are finite or null.
  table.rows.forEach((r, i) => {
    if (r.length !== table.columns.length) out.push(`row ${i} has ${r.length} values for ${table.columns.length} columns`);
    r.forEach((v, j) => {
      const c = table.columns[j];
      if (!c) return;
      if (c.binding.kind === "statistic" && v !== null && (typeof v !== "number" || !Number.isFinite(v))) out.push(`row ${i}, "${c.header}": a number column holds ${JSON.stringify(v)}; unknown is null`);
      if (c.binding.kind === "grouping" && (v === null || v === "" || typeof v !== "string" && typeof v !== "number")) out.push(`row ${i}, "${c.header}": a grouping value is blank`);
    });
  });

  // Evidence: exactly one per number cell, consistent with its value.
  const ev = new Map<string, CellEvidence>();
  for (const e of env.evidence) {
    const k = `${e.row}:${e.statistic}`;
    if (ev.has(k)) out.push(`two evidence records for row ${e.row}, ${e.statistic}`);
    ev.set(k, e);
  }
  table.rows.forEach((r, i) => table.columns.forEach((c, j) => {
    if (c.binding.kind !== "statistic") return;
    const e = ev.get(`${i}:${c.binding.as}`);
    const v = r[j];
    if (!e) { out.push(`row ${i}, ${c.binding.as}: no evidence`); return; }
    if (v === null && !BLANK.includes(e.status)) out.push(`row ${i}, ${c.binding.as}: blank but status ${e.status}`);
    if (v !== null && BLANK.includes(e.status)) out.push(`row ${i}, ${c.binding.as}: ${v} but status ${e.status} (an unknown is blank, never a number)`);
    if (e.status === "REPORTED_ZERO" && v !== 0) out.push(`row ${i}, ${c.binding.as}: REPORTED_ZERO with ${v}`);
  }));
  if (env.evidence.length !== table.rows.length * stats.length) out.push("evidence does not cover exactly the number cells");

  // Answer statements: only the authorized ones, each only where it applies.
  for (const s of env.answerStatements) {
    if (!(s in ANSWER_STATEMENTS)) out.push(`answer statement "${s}" is not authorized`);
    else if (STATEMENT_SOURCE[s] !== plan.source) out.push(`answer statement "${s}" belongs to ${STATEMENT_SOURCE[s]}, not ${plan.source}`);
  }
  const hasPropertyExists = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "property");
  const national = plan.geography.places.some((p) => p.kind === "national");
  if (plan.source === "nibrs" && hasPropertyExists !== env.answerStatements.includes("property_not_attributed")) out.push("property_not_attributed is required exactly when the plan filters on incident property");
  if (plan.source === "nibrs" && national !== env.answerStatements.includes("reported_nibrs_counts")) out.push("reported_nibrs_counts is required exactly when the geography is the nation");
  const multi = plan.groupings.some((g) => g.multiValue);
  if (plan.source === "nibrs" && multi !== env.answerStatements.includes("categories_overlap")) out.push("categories_overlap is required exactly when a grouping is multi-valued");
  const arrests = plan.measures.some((m) => m.unit === "arrest" || m.unit === "arrestee");
  if (plan.source === "nibrs" && arrests !== env.answerStatements.includes("arrests_counted_once")) out.push("arrests_counted_once is required exactly when the plan counts arrests");
  return out;
}
