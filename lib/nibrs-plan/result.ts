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
  /**
   * `exclusive` (category groupings only, Jeff 2026-11-01: stacked and 100% charts only when honest): true when each
   * unit of the primary count (the charted measure) falls in exactly one category, so the categories sum to its total;
   * false for a multi-valued grouping (a crime with several weapons or locations, an incident's several offenders),
   * whose categories can add up to more. Taken from the layer: a one-to-many dimension must be grouped with
   * `multiValue: "each_value"` (P3). Absent for time and place groupings.
   */
  | { binding: { kind: "grouping"; dimension: string }; header: string; exclusive?: boolean }
  /**
   * `exclusive` on a supporting statistic whose categories can differ from the primary count's: the incidents beside a
   * count (P66). False when one incident can fall in several categories (a grouping below the incident: one incident
   * with a female and a male victim); true for a grouping of the incident itself (clearance). Absent with no category
   * grouping, and on the primary count and its share (the grouping's own flag holds for them).
   */
  | { binding: { kind: "statistic"; as: string }; header: string; exclusive?: boolean };

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
 * - arrests_counted_once: a plan that counts arrests (P46);
 * - arrests_through_incident: a plan that counts every arrest on an incident with a condition (increment 6);
 * - clearance_as_of_file: a plan grouped or filtered by clearance (P64);
 * - clearance_arrest_first: a plan that tells arrests from exceptional clearances (clearance type or method, P67);
 * - arrests_include_group_b: a plan that counts every arrest with no incident condition (increment 7, P46, P50);
 * - pair_linked: a plan grouped by the offenders a victim's relationship segments link to it (P65);
 * - pair_condition: a plan with a condition on the offenders a victim's relationship segments link to it (P65; Codex
 *   04.3: a condition excludes victims with no relationship, where a grouping shows them);
 * - offender_records: a plan that counts offenders (P44: offender records, the segment convention);
 * - unknown_not_counted: a plan with a condition on a person's sex, race, ethnicity or age (increment 7).
 */
export const ANSWER_STATEMENTS = {
  property_not_attributed: "NIBRS lists property for the whole incident, not for each offense in it, so the property can't be tied to a single offense.",
  reported_nibrs_counts: "These are counts reported to NIBRS by the agencies that report to it.",
  property_counted_by_offense: "Property crimes are counted by offense, not by victim.",
  categories_overlap: "A crime that falls in several of these categories is counted once in each, so the categories can add up to more than the total.",
  arrests_counted_once: "Each arrest counts once; NIBRS can't tell when the same person was arrested more than once.",
  arrests_through_incident: "Arrests with no crime report of their own (for minor offenses the FBI calls Group B) are not included; an arrest made for one of these incidents counts whatever the person was arrested for.",
  clearance_as_of_file: "A crime counts as cleared if it was cleared by the date of the data file, whenever that happened; the FBI's yearly tables instead count the clearances reported during the year, for crimes from any year.",
  clearance_arrest_first: "An incident cleared both by an arrest and by other means (exceptional clearance) counts as cleared by arrest.",
  arrests_include_group_b: "Arrests with no crime report of their own (for minor offenses the FBI calls Group B) are included; each arrest is counted under what the person was arrested for.",
  pair_linked: "Each victim is counted under the offenders the report links to that victim, not every offender in the incident; victims whose relationship to the offender wasn't reported are shown as their own group.",
  pair_condition: "The condition on the offender is checked only for the offenders the report links to each victim; a victim whose relationship to the offender wasn't reported can't meet it and is not counted.",
  offender_records: "Offenders are counted as listed in each incident report, not as distinct people; an incident with no information about its offender counts one unknown offender.",
  unknown_not_counted: "A person whose detail is unknown or not reported doesn't meet a condition on that detail, so that person is not counted.",
} as const;
export type AnswerStatement = keyof typeof ANSWER_STATEMENTS;
/** Each statement belongs to one source (G8): it is authorized, and required, only for that source's plans. */
export const STATEMENT_SOURCE: Record<AnswerStatement, Source> = { property_not_attributed: "nibrs", reported_nibrs_counts: "nibrs", property_counted_by_offense: "nibrs", categories_overlap: "nibrs", arrests_counted_once: "nibrs", clearance_as_of_file: "nibrs", clearance_arrest_first: "nibrs", arrests_through_incident: "nibrs",
  arrests_include_group_b: "nibrs", pair_linked: "nibrs", pair_condition: "nibrs", offender_records: "nibrs", unknown_not_counted: "nibrs" };
const PERSON = /^(?:victim|offender|arrestee)\.(?:sex|race|ethnicity|age)$|^victim_offender\.offender_(?:sex|race|ethnicity|age)$/;
/** Increment 7: the plan's people conditions, groupings and units, for the statements above. */
export function peopleFacts(plan: NibrsPlan): { pair: boolean; pairCondition: boolean; personFilter: boolean; allArrests: boolean; throughIncident: boolean; offenders: boolean } {
  const filters = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])];
  const conds = filters.flatMap((f) => (f.kind === "attribute" ? [f.dimension] : f.where.map((w) => w.dimension)));
  const allCrime = plan.measures.some((m) => m.id === "arrests.all_crime");
  const incidentCondition = filters.some((f) => f.kind === "exists" && f.scope === "incident");
  return {
    pair: plan.groupings.some((g) => g.dimension.startsWith("victim_offender.offender_")),
    pairCondition: conds.some((d) => d.startsWith("victim_offender.offender_")),
    personFilter: conds.some((d) => PERSON.test(d)),
    allArrests: allCrime && !incidentCondition, throughIncident: allCrime && incidentCondition,
    offenders: plan.measures.some((m) => m.unit === "offender"),
  };
}
const CLEARANCE_DIMS = ["offense.clearance_status", "offense.clearance_type", "offense.clearance_method"];
/** The clearance dimensions a plan groups or filters by (P64), in its groupings and attribute filters. */
export function clearanceDims(plan: NibrsPlan): string[] {
  const filters = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])];
  return [...plan.groupings.map((g) => g.dimension), ...filters.map((f) => (f.kind === "attribute" ? f.dimension : ""))].filter((d) => CLEARANCE_DIMS.includes(d));
}

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
      // The population covered (P72, Jeff 2026-11-01) is a percent, "≥" marking a lower bound: that form only.
      const as = c.binding.kind === "statistic" ? c.binding.as : null;
      const coverage = as !== null && plan.statistics.some((s) => s.kind === "coverage" && s.as === as);
      if (coverage && v !== null && !(typeof v === "string" && /^≥?\d+\.\d%$/.test(v))) out.push(`row ${i}, "${c.header}": a population-covered cell holds ${JSON.stringify(v)}; it is a percent, "≥" for a lower bound`);
      if (!coverage && c.binding.kind === "statistic" && v !== null && (typeof v !== "number" || !Number.isFinite(v))) out.push(`row ${i}, "${c.header}": a number column holds ${JSON.stringify(v)}; unknown is null`);
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
  const people = peopleFacts(plan);
  if (plan.source === "nibrs" && people.throughIncident !== env.answerStatements.includes("arrests_through_incident")) out.push("arrests_through_incident is required exactly when the plan counts every arrest on an incident");
  if (plan.source === "nibrs" && people.allArrests !== env.answerStatements.includes("arrests_include_group_b")) out.push("arrests_include_group_b is required exactly when the plan counts every arrest with no incident condition");
  if (plan.source === "nibrs" && people.pair !== env.answerStatements.includes("pair_linked")) out.push("pair_linked is required exactly when the plan groups by the offenders linked to each victim");
  if (plan.source === "nibrs" && people.pairCondition !== env.answerStatements.includes("pair_condition")) out.push("pair_condition is required exactly when the plan has a condition on the offenders linked to each victim");
  if (plan.source === "nibrs" && people.offenders !== env.answerStatements.includes("offender_records")) out.push("offender_records is required exactly when the plan counts offenders");
  if (plan.source === "nibrs" && people.personFilter !== env.answerStatements.includes("unknown_not_counted")) out.push("unknown_not_counted is required exactly when the plan has a condition on a person's attribute");
  const clr = clearanceDims(plan);
  if (plan.source === "nibrs" && (clr.length > 0) !== env.answerStatements.includes("clearance_as_of_file")) out.push("clearance_as_of_file is required exactly when the plan groups or filters by clearance");
  const byType = clr.some((d) => d !== "offense.clearance_status");
  if (plan.source === "nibrs" && byType !== env.answerStatements.includes("clearance_arrest_first")) out.push("clearance_arrest_first is required exactly when the plan tells arrests from exceptional clearances");
  return out;
}
