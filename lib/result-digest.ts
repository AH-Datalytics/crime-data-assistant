/**
 * Bounded, versioned evidence about one result set.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §6.2.
 *
 * WHAT THIS IS FOR. Result rows exist in server memory at the log site but are
 * never persisted, so a reviewer adjudicating a suspected wrong answer weeks
 * later has the question, the SQL, and the prose -- and no way to see what the
 * query actually returned. The digest is that missing evidence, bounded so it can
 * sit on every row of a hot log table.
 *
 * WHAT THIS IS NOT. "The digest is evidence, not the answer and not by itself
 * proof" (§6.2). Nothing here decides whether an answer may ship; that is
 * lib/proof-finalize.ts consuming lib/proof-checks.ts. A digest can be perfectly
 * well-formed and describe a completely wrong result.
 *
 * TWO RULES THAT LOOK LIKE DETAILS AND ARE NOT:
 *
 *   1. No sum is computed unless the typed plan declared the measure additive.
 *      Handoff §6.2: "never infer additivity from a name alone." A column called
 *      `rate`, `clearance_pct`, `population`, or `avg_response_time` sums to a
 *      meaningless number, and a meaningless number in the evidence record is
 *      worse than an absent one -- a reviewer will read it as a total.
 *
 *   2. Representative rows are selected deterministically. A random sample makes
 *      a digest unreproducible, so a reviewer cannot tell whether a digest that
 *      disagrees with a re-run reflects changed data or a different draw.
 */

import type { Omission, OmissionReason } from "./proof-contract";

/** Bump when the persisted digest shape changes incompatibly. */
export const DIGEST_VERSION = 1;

/** Hard ceiling from §6.2. Enforced, not aspirational -- see reduceToLimit(). */
export const DIGEST_MAX_BYTES = 8192;

/** Caps from §6.2. */
export const MAX_DIGEST_COLUMNS = 24;
export const MAX_DISTINCT_VALUES = 20;
export const MAX_REPRESENTATIVE_ROWS = 3;

/**
 * Longest string kept for any single cell or distinct value.
 *
 * Chosen so that the caps above cannot combine into an oversized digest through
 * long values alone: 24 columns x 20 distinct values x 120 bytes is already past
 * the ceiling, which is exactly why reduceToLimit() exists rather than trusting
 * the caps to be sufficient.
 */
export const MAX_VALUE_CHARS = 120;

export type DigestValueType = "number" | "string" | "boolean" | "null" | "mixed";

export interface DigestNumericStats {
  min: number;
  max: number;
  /** Count of null/undefined cells. Distinct from zeroes -- see §3.10. */
  nulls: number;
  /** Count of cells that are exactly 0. */
  zeroes: number;
  /**
   * Present only when the typed plan declared this measure additive.
   *
   * Absent is meaningful: it says "nobody claimed these values can be added",
   * not "the sum was zero" and not "we forgot".
   */
  sum?: number;
}

export interface DigestColumn {
  name: string;
  type: DigestValueType;
  /** True when the plan declared this column a measure that may be summed. */
  additive: boolean;
  /** Present for numeric columns. */
  numeric?: DigestNumericStats;
  /**
   * Distinct values, for columns the plan declared as geography or category.
   *
   * Never populated by inference. A free-text column could hold thousands of
   * distinct values, and a capped sample of them is not evidence of anything.
   */
  distinct?: {
    values: (string | number | boolean | null)[];
    /** True when more distinct values exist than were kept. */
    capped: boolean;
    /** Total distinct count when known, else null. */
    total: number | null;
  };
}

/**
 * What the digest had to drop to fit DIGEST_MAX_BYTES.
 *
 * Always present, so that "nothing was dropped" is an explicit recorded fact
 * rather than an absence a reader has to interpret. This is the same lesson as
 * CheckState's `unknown`: silence and success must not look alike.
 */
export interface DigestTruncation {
  /** Columns beyond MAX_DIGEST_COLUMNS, or dropped to fit the byte ceiling. */
  columnsDropped: number;
  /** Representative rows dropped to fit the byte ceiling. */
  representativeRowsDropped: number;
  /** Distinct-value lists cleared to fit the byte ceiling. */
  distinctListsDropped: number;
  /**
   * Omissions dropped to fit the byte ceiling.
   *
   * This should be zero in every ordinary case, because omissions are reduced
   * LAST -- they are the one part of the digest that asserts something a user was
   * told. A nonzero value here means the evidence for a user-facing omission
   * claim was lost, and the reviewer queue must treat it as a defect, not a cap.
   */
  omissionsDropped: number;
}

export interface ResultDigest {
  v: number;
  /** Rows returned by the query, before any display capping. */
  rowCount: number;
  /** True when the result hit the route's row limit and more rows existed. */
  truncated: boolean;
  columns: DigestColumn[];
  /** Total columns the result had, which may exceed columns.length. */
  columnCount: number;
  representativeRows: Record<string, unknown>[];
  /** Canonical entity identifiers the request asked for, when resolvable. */
  requestedEntities: string[];
  /** Canonical entity identifiers present in the result. */
  returnedEntities: string[];
  omissions: Omission[];
  planFamily: string | null;
  /** Identifier of the resolver/query-contract that produced the SQL, when known. */
  resolverContractId: string | null;
  /** Transitional retries before this terminal result. */
  retries: number;
  /** Guardrail tags that fired, as already recorded in query_log.guardrails. */
  guardrails: string[];
  truncation: DigestTruncation;
}

/**
 * What the typed plan declares about the result's columns.
 *
 * Every field is opt-in. A caller with no plan (the model-authored legacy path
 * during migration) supplies nothing, and the digest correctly records no sums
 * and no distinct-value lists rather than guessing.
 */
export interface DigestPlanDeclaration {
  /** Columns whose values may legitimately be summed. */
  additiveMeasures?: string[];
  /** Columns holding geography or category labels, eligible for distinct sampling. */
  categoricalColumns?: string[];
  planFamily?: string | null;
  resolverContractId?: string | null;
}

export interface BuildDigestInput {
  rows: Record<string, unknown>[];
  columns: string[];
  truncated: boolean;
  plan?: DigestPlanDeclaration;
  requestedEntities?: string[];
  returnedEntities?: string[];
  omissions?: Omission[];
  retries?: number;
  guardrails?: string[];
}

function truncateValue(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_VALUE_CHARS ? `${text.slice(0, MAX_VALUE_CHARS)}…` : text;
}

function inferType(values: unknown[]): DigestValueType {
  let sawNumber = false;
  let sawString = false;
  let sawBoolean = false;
  let sawNonNull = false;
  for (const value of values) {
    if (value === null || value === undefined) continue;
    sawNonNull = true;
    if (typeof value === "number") sawNumber = true;
    else if (typeof value === "boolean") sawBoolean = true;
    else sawString = true;
  }
  if (!sawNonNull) return "null";
  const kinds = Number(sawNumber) + Number(sawString) + Number(sawBoolean);
  if (kinds > 1) return "mixed";
  if (sawNumber) return "number";
  if (sawBoolean) return "boolean";
  return "string";
}

/**
 * Deterministic representative rows: first, middle, last.
 *
 * Deliberately not a random sample (see the header note). First and last surface
 * the boundary rows a reviewer most often needs -- the earliest and latest period
 * of a trend, the top and bottom of a ranking -- and the middle catches a
 * discontinuity that both ends would hide.
 */
function representativeRows(rows: Record<string, unknown>[], keepColumns: string[]): Record<string, unknown>[] {
  if (rows.length === 0) return [];
  const indices = rows.length <= MAX_REPRESENTATIVE_ROWS
    ? rows.map((_, index) => index)
    : [0, Math.floor((rows.length - 1) / 2), rows.length - 1];
  const unique = [...new Set(indices)];
  return unique.map((index) => {
    const source = rows[index];
    const kept: Record<string, unknown> = {};
    for (const column of keepColumns) kept[column] = truncateValue(source[column]);
    return kept;
  });
}

function buildColumn(
  name: string,
  rows: Record<string, unknown>[],
  plan: DigestPlanDeclaration,
): DigestColumn {
  const values = rows.map((row) => row[name]);
  const type = inferType(values);
  const additive = (plan.additiveMeasures ?? []).includes(name);
  const column: DigestColumn = { name, type, additive };

  if (type === "number") {
    const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const nulls = values.filter((value) => value === null || value === undefined).length;
    const zeroes = numbers.filter((value) => value === 0).length;
    const stats: DigestNumericStats = {
      min: numbers.length > 0 ? Math.min(...numbers) : 0,
      max: numbers.length > 0 ? Math.max(...numbers) : 0,
      nulls,
      zeroes,
    };
    // The one rule that matters most in this file. See the header.
    if (additive) stats.sum = numbers.reduce((total, value) => total + value, 0);
    column.numeric = stats;
  }

  if ((plan.categoricalColumns ?? []).includes(name)) {
    const seen = new Set<string>();
    const kept: (string | number | boolean | null)[] = [];
    for (const value of values) {
      const key = value === null || value === undefined ? "\u0000null" : String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      if (kept.length < MAX_DISTINCT_VALUES) kept.push(truncateValue(value));
    }
    column.distinct = {
      values: kept,
      capped: seen.size > kept.length,
      total: seen.size,
    };
  }

  return column;
}

function byteLength(digest: ResultDigest): number {
  return Buffer.byteLength(JSON.stringify(digest), "utf8");
}

/**
 * Shrink a digest until it fits DIGEST_MAX_BYTES.
 *
 * THE ORDER OF THE LADDER IS THE POINT. Each rung sheds the least
 * evidentially-important thing still present:
 *
 *   1. distinct-value lists -- a capped sample, already acknowledged as partial
 *   2. representative rows   -- illustrative, and re-derivable by re-running SQL
 *   3. columns               -- statistics, degrading breadth but not truth
 *   4. omissions             -- LAST, and recorded as a defect when it happens
 *
 * Omissions come last because every other field describes what the result was,
 * while an omission is the evidence behind something a user was actually told
 * ("Jacksonville cannot currently be included"). Handoff §2.4 forbids silently
 * dropping a requested entity; dropping the *record* of why it was dropped is
 * the same failure one layer down.
 */
function reduceToLimit(digest: ResultDigest): ResultDigest {
  if (byteLength(digest) <= DIGEST_MAX_BYTES) return digest;

  for (const column of digest.columns) {
    if (column.distinct) {
      digest.truncation.distinctListsDropped += 1;
      delete column.distinct;
      if (byteLength(digest) <= DIGEST_MAX_BYTES) return digest;
    }
  }

  while (digest.representativeRows.length > 0) {
    digest.representativeRows.pop();
    digest.truncation.representativeRowsDropped += 1;
    if (byteLength(digest) <= DIGEST_MAX_BYTES) return digest;
  }

  while (digest.columns.length > 0) {
    digest.columns.pop();
    digest.truncation.columnsDropped += 1;
    if (byteLength(digest) <= DIGEST_MAX_BYTES) return digest;
  }

  while (digest.omissions.length > 0) {
    digest.omissions.pop();
    digest.truncation.omissionsDropped += 1;
    if (byteLength(digest) <= DIGEST_MAX_BYTES) return digest;
  }

  // Unreachable with the caps above unless a single scalar field is itself
  // enormous. Returned rather than thrown: a too-large digest is a degraded
  // evidence record, never a reason to fail a user's request.
  return digest;
}

export function buildResultDigest(input: BuildDigestInput): ResultDigest {
  const plan = input.plan ?? {};
  const rows = input.rows ?? [];

  // Column identity comes from the caller's declared column list, falling back to
  // the first row's keys. The caller's list is authoritative because a result
  // whose first row happens to omit a key still has that column.
  const allColumns = input.columns.length > 0
    ? input.columns
    : rows.length > 0
      ? Object.keys(rows[0])
      : [];
  const keptColumns = allColumns.slice(0, MAX_DIGEST_COLUMNS);

  const digest: ResultDigest = {
    v: DIGEST_VERSION,
    rowCount: rows.length,
    truncated: Boolean(input.truncated),
    columns: keptColumns.map((name) => buildColumn(name, rows, plan)),
    columnCount: allColumns.length,
    representativeRows: representativeRows(rows, keptColumns),
    requestedEntities: [...new Set(input.requestedEntities ?? [])].sort(),
    returnedEntities: [...new Set(input.returnedEntities ?? [])].sort(),
    omissions: [...(input.omissions ?? [])],
    planFamily: plan.planFamily ?? null,
    resolverContractId: plan.resolverContractId ?? null,
    retries: input.retries ?? 0,
    guardrails: [...(input.guardrails ?? [])],
    truncation: {
      columnsDropped: Math.max(0, allColumns.length - keptColumns.length),
      representativeRowsDropped: 0,
      distinctListsDropped: 0,
      omissionsDropped: 0,
    },
  };

  return reduceToLimit(digest);
}

/**
 * Serialize for persistence, or null if it cannot be serialized.
 *
 * Returns null rather than throwing for the same reason every other failure in
 * this pipeline degrades quietly: the digest is diagnostic, and a circular
 * reference in a result row must not cost a user their answer.
 */
export function serializeResultDigest(digest: ResultDigest): string | null {
  try {
    const json = JSON.stringify(digest);
    return json.length > 0 ? json : null;
  } catch {
    return null;
  }
}

/**
 * Reason codes present in a digest's omissions, for reviewer filtering.
 *
 * Exported so the digest email can group by reason without re-parsing the whole
 * omission array at every call site.
 */
export function omissionReasons(digest: ResultDigest): OmissionReason[] {
  return [...new Set(digest.omissions.map((omission) => omission.reason))];
}
