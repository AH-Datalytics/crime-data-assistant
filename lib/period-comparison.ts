/**
 * Period comparison: what months the returned rows actually cover, and whether a year-over-year
 * change in those rows rests on comparable periods.
 *
 * WHY THIS IS A SEPARATE MODULE. GC-055 delivered `pct_change: -61.9` for partial 2026 against
 * complete 2025. That number is a RETURNED COLUMN, computed by the query's own `LAG()` — no wording
 * change removes it, and mutating caller-owned rows inside the string-returning disclosure helper
 * would hide a payload change inside a prose function. So the decision is pure and explicit here,
 * and the caller builds a separate presentation result from it.
 *
 * WHAT COUNTS AS EVIDENCE. Month identities come only from the two shapes the capture actually
 * contains: separate `year`/`month` columns, and a single `YYYY-MM` field. Nothing else is parsed —
 * no general date parser, no scanning every string for date-like text. A SQL predicate is not read
 * here at all: it can show what was requested, never that every selected month produced
 * observations, and equal predicates are not equal coverage.
 *
 * THE THREE STATES NEVER COLLAPSE. `matched` requires both sides established and equal; `unequal`
 * requires both established and different; anything else is `unestablished`. Unknown is never
 * relabelled as either of the others.
 *
 * THE CALENDAR IS NOT EVIDENCE. Every adjacent pair is evaluated on its own month evidence. An
 * earlier version looked only at pairs touching the current year, which meant the same unresolved
 * comparison silently became "supported" once the year rolled over. Scope is bounded instead by what
 * counts as a change column at all: a same-row share is excluded, and where the query is available a
 * recognized year-ordered derivation is required.
 */

/**
 * year -> the sorted, de-duplicated months present in the rows.
 *
 * `attributable` is false when the rows are partitioned by an entity, so the union of a year's
 * months belongs to no single series. Two cities can between them cover January and February in both
 * years while neither city's own months match — a union would call that "matched", which is why the
 * display inventory and the comparison evidence are kept apart.
 */
export class MonthCoverage extends Map<number, number[]> {
  attributable = true;
}

export type ComparisonState = "matched" | "unequal" | "unestablished";

export type PairDecision = {
  year: number;
  against: number;
  state: ComparisonState;
  reason: string;
  /** The shared basis, when and only when the pair is `matched`. */
  basis: string | null;
};

/** A change column proved to be a year-over-year change of another column in the same rows. */
export type VerifiedChangeColumn = {
  column: string;
  /**
   * The column it was reconciled against, or null when the evidence is structural rather than
   * arithmetic — a categorical carrier such as `decreased: "Yes"` has no numeric base to reconcile.
   */
  base: string | null;
};

export type WithholdingResult = {
  /** The presentation rows. A withheld change is `null` — never zero. */
  rows: Record<string, unknown>[];
  columns: string[];
  withheld: { column: string; year: number; state: ComparisonState }[];
  /** What was withheld and why, for the reader. Null when nothing was withheld. */
  note: string | null;
  /**
   * The narrative to deliver: offending claims removed, the withholding stated, and the period
   * sentences applied. The caller sends THIS, not the raw model text — one presentation decision
   * covering rows, prose, title and chart together.
   */
  explanation: string;
  /** The title to deliver, with any withheld change claim gone. */
  title: string;
  /** Remove withheld series, annotations and title claims from a chart built on these rows. */
  cleanChart: <T>(chartConfig: T) => T;
  /** Remove the withheld change claims from a narrative rebuilt later, without re-adding the note. */
  strip: (text: string) => string;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const YEAR_COLS = ["year", "data_year", "Year"];
const MONTH_COLS = ["month", "Month"];
/** The one string shape observed in the capture: GC-042's `period`, e.g. "2022-01". */
const YYYY_MM = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** The only column names the `YYYY-MM` shape is read from. Named by the build ruling. */
const PERIOD_COLS = ["period", "Period"];

function addPoint(cov: MonthCoverage, year: number, month: number): void {
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) return;
  const months = cov.get(year) ?? [];
  if (!months.includes(month)) months.push(month);
  cov.set(year, months);
}

/**
 * Month identities present in the returned rows.
 *
 * Establishes which months the RESULT carries. It does not establish that every agency reported
 * them, and month sets from different entities are never merged into a claim of complete coverage —
 * the map records what appeared, nothing more.
 */
export function monthCoverageFromRows(rows: Record<string, unknown>[]): MonthCoverage {
  const cov = new MonthCoverage();
  if (!Array.isArray(rows) || rows.length === 0) return cov;

  const first = rows[0] ?? {};
  const yearCol = YEAR_COLS.find((c) => first[c] !== undefined);
  const monthCol = MONTH_COLS.find((c) => first[c] !== undefined);
  if (yearCol && monthCol) {
    for (const row of rows) addPoint(cov, Number(row[yearCol]), Number(row[monthCol]));
  }

  /*
   * The single `YYYY-MM` field — and ONLY the column the build ruling named, `period`.
   * An earlier version scanned every string field, so an unrelated `imported_at: "2026-05"`
   * contributed a May that no observation supported.
   */
  const periodCol = PERIOD_COLS.find((c) => typeof first[c] === "string" && YYYY_MM.test(first[c] as string));
  if (periodCol) {
    for (const row of rows) {
      const m = typeof row[periodCol] === "string" ? YYYY_MM.exec(row[periodCol] as string) : null;
      if (m) addPoint(cov, Number(m[1]), Number(m[2]));
    }
  }

  for (const [year, months] of cov) cov.set(year, months.sort((a, b) => a - b));
  cov.attributable = !isEntityPartitioned(rows, periodCol);
  return cov;
}

/**
 * Are these rows split across several entities?
 *
 * Detected by a text column — other than the period label — carrying more than one distinct value.
 * When that holds, a year's month union is a union across entities and cannot speak for any one of
 * them. Pivoted numeric entity columns are not detected; that limitation is recorded in the handoff.
 */
function isEntityPartitioned(rows: Record<string, unknown>[], periodCol: string | undefined): boolean {
  const first = rows[0] ?? {};
  for (const key of Object.keys(first)) {
    if (key === periodCol) continue;
    if (typeof first[key] !== "string") continue;
    const distinct = new Set(rows.map((r) => String(r[key])));
    if (distinct.size > 1) return true;
  }
  return false;
}

/**
 * Does the query derive this alias from a recognized cross-row, year-ordered comparison?
 *
 * Narrow on purpose: a `LAG`/`LEAD` window ordered by year, in the expression aliased to this
 * column. Not a SQL parser, and not a licence to widen the accepted grammar — the absence of this
 * signal never authorizes anything, it only withholds one extra piece of support.
 */
function hasYearOverYearDerivation(sql: string, column: string): boolean {
  return projectionExpressionsFor(sql, column).some((expr) => containsYearOrderedWindow(expr));
}

/** A year-ordered `LAG`/`LEAD` window somewhere inside this expression. */
function containsYearOrderedWindow(expr: string): boolean {
  return /\b(?:LAG|LEAD)\s*\(/i.test(expr) && /\bOVER\s*\(/i.test(expr) &&
    /\bORDER\s+BY\b[^)]*\byear\b/i.test(expr);
}

/**
 * Is this expression NOTHING BUT a prior-period observation?
 *
 * The distinction the earlier version missed. `LAG(total) OVER (ORDER BY year)` is an observation
 * of last year's value, which Decision 17 permits beside this year's. But
 * `CASE WHEN total < LAG(total) OVER (ORDER BY year) THEN 'Yes' ELSE 'No' END` is an OPERATION on
 * that observation — the same claim as the one-hop shape, merely inlined — and the earlier code
 * exempted it, because it only asked whether a window appeared ANYWHERE in the expression.
 *
 * So the whole expression must be the window and nothing else: optional surrounding parentheses,
 * `LAG`/`LEAD`, its argument list, `OVER`, and its window spec. Any comparison, arithmetic, `CASE`
 * or wrapper around it makes this false, and the column is treated as a derived claim.
 */
function isBarePriorObservation(expr: string): boolean {
  let text = expr.trim();
  // Unwrap fully-parenthesised expressions: `(LAG(x) OVER (ORDER BY year))`.
  while (/^\(([\s\S]*)\)$/.test(text)) {
    const inner = text.slice(1, -1);
    let depth = 0;
    let balanced = true;
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      else if (ch === ")") { depth -= 1; if (depth < 0) { balanced = false; break; } }
    }
    if (!balanced || depth !== 0) break;
    text = inner.trim();
  }
  return /^(?:LAG|LEAD)\s*\([^()]*(?:\([^()]*\)[^()]*)*\)\s*OVER\s*\([\s\S]*\)$/i.test(text) &&
    containsYearOrderedWindow(text);
}

/**
 * How a column relates to a year-ordered window, by the query's own construction.
 *
 * - `observation` — the projection is a bare prior-period value. Retained, labelled, never a claim.
 * - `direct` — the projection performs an operation on a window it contains. A claim.
 * - `hop` — the projection references an alias that is, unambiguously, a bare prior observation
 *   defined once in this statement. A claim.
 * - `unresolved` — a REFERENCED name has several definitions, at least one a year-ordered window,
 *   so which one the expression sees cannot be established. Withheld as a claim, but never
 *   attributed to any particular definition.
 * - `ambiguous_claim` — THIS column's own name has conflicting definitions and at least one of them
 *   is a derived operation on a window. Some meaning the statement allows is an unsupported change,
 *   so it is treated as a claim without asserting which definition was selected.
 * - `ambiguous_observation` — the name has conflicting definitions, but every windowed one is a
 *   bare prior observation, so the worst meaning available is a permitted figure. Not a claim.
 * - `none` — no relationship found.
 */
type WindowRelation =
  | "observation" | "direct" | "hop" | "unresolved"
  | "ambiguous_claim" | "ambiguous_observation" | "none";

function windowRelation(sql: string, column: string, columns: string[]): WindowRelation {
  const own = projectionExpressionsFor(sql, column);
  if (own.length > 0) {
    const bare = own.filter((expr) => isBarePriorObservation(expr));
    const windowed = own.filter((expr) => containsYearOrderedWindow(expr));
    if (bare.length === own.length) return "observation";
    if (windowed.length === own.length) return "direct";
    /*
     * CONFLICTING DEFINITIONS ARE CLASSIFIED BY THE WORST MEANING THEY ALLOW.
     *
     * An earlier version called every such column not-a-claim, reasoning that a repeated alias is
     * ordinary SQL and that any operation built on the name would be caught elsewhere. That was
     * wrong wherever the column IS the answer: a `decreased` defined as a constant in an unused CTE
     * and as a real `CASE ... LAG(...)` predicate in the selected one was delivered intact, which
     * is the original GC-055 defect returning through the policy meant to avoid false positives.
     *
     * Resolving which definition is selected needs a parser. So the meaning is not resolved at all
     * — the candidates are ranked instead. If any candidate is a DERIVED operation on a window, an
     * unsupported change is one of the things this column could be, and it is withheld. If the only
     * windowed candidates are bare observations, the worst case is a prior-period figure that
     * Decision 17 permits, and an ordinary count keeps its value. That is what distinguishes the
     * counterexample from a `total` legitimately redefined across CTEs.
     */
    if (windowed.some((expr) => !isBarePriorObservation(expr))) return "ambiguous_claim";
    if (windowed.length > 0) return "ambiguous_observation";
  }

  /*
   * ONE HOP, AND ONLY WHEN THE BINDING IS UNAMBIGUOUS.
   *
   * `projectionExpressionsFor` searches every select list in the statement, including CTEs, and
   * this used to match alias NAMES across all of them. An unused CTE defining
   * `LAG(total) ... AS prior_year` therefore lent its meaning to a selected `5 AS prior_year`,
   * which the accepted rule expressly prohibited: an alias in another scope must not be matched.
   *
   * Resolving true SQL scope needs a parser, which is out of scope. So the binding is required to
   * be unambiguous instead: the name must have exactly ONE definition in the whole statement and
   * that definition must be a bare prior observation. Two definitions of a name means this code
   * cannot say which one is referenced, and it says so rather than guessing.
   */
  for (const alias of columns) {
    if (alias === column) continue;
    if (!own.some((expr) => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(expr))) continue;
    const definitions = projectionExpressionsFor(sql, alias);
    if (definitions.length === 0) continue;
    const bare = definitions.filter((expr) => isBarePriorObservation(expr));
    if (bare.length === 0) continue;
    // A single, unambiguous bare-lag definition is the one supported hop.
    if (definitions.length === 1) return "hop";
    // Several definitions of the same name, at least one a lag: not attributable to either.
    return "unresolved";
  }
  return "none";
}

/**
 * Every column that represents a derived year-over-year change, by the query's own construction.
 *
 * Type-blind on purpose — numeric, boolean or text alike — because the representation is the
 * model's choice and the operation is not. A same-row share is excluded by the caller's existing
 * within-row test, which is the stronger explanation when both could fit.
 *
 * `unresolved` and `ambiguous_claim` are included deliberately. Non-recognition must not become
 * safe delivery: a predicate over a name this statement defines twice — once as a year-ordered
 * window — is a recognised comparison whose basis cannot be established, and a column that could
 * itself BE such a predicate is no safer for the ambiguity. Withholding the derived value is the
 * safe direction; the underlying observations are still delivered, and nothing is asserted about
 * which definition was selected.
 */
export function findStructuralChangeColumns(
  rows: Record<string, unknown>[],
  columns: string[],
  sql?: string,
): string[] {
  if (!sql || !Array.isArray(rows) || rows.length === 0) return [];
  const yearCol = YEAR_COLS.find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol) return [];
  return columns.filter((column) => {
    if (column === yearCol) return false;
    const relation = windowRelation(sql, column, columns);
    // A prior-period observation is retained; only an operation ON one is a claim. Conflicting
    // definitions are retained only when every windowed candidate is itself a bare observation.
    if (relation === "observation" || relation === "ambiguous_observation" || relation === "none") return false;
    if (hasWithinRowExplanation(rows, column, columns)) return false;
    return true;
  });
}

/** Exposed for the correctness suite: how each column relates to a year-ordered window. */
export function describeWindowRelations(
  columns: string[],
  sql: string,
): Record<string, WindowRelation> {
  const out: Record<string, WindowRelation> = {};
  for (const column of columns) out[column] = windowRelation(sql, column, columns);
  return out;
}

/**
 * The expression(s) a query aliases to this column.
 *
 * A proximity scan is not a binding: `LAG(total) OVER (ORDER BY year) AS previous_total,
 * firearm_pct AS firearm_pct` put a window within 400 characters of `firearm_pct` and the share was
 * misread as a change. This walks back from each `AS <column>` to the start of ITS projection item —
 * the nearest comma at paren depth zero, or the `SELECT` that opens the list — so the expression
 * returned is the one that actually produces the column.
 *
 * Every select list in the statement is searched, including CTEs: GC-055's outer projection is a
 * bare `pct_change` and the derivation lives in the `with_yoy` CTE that defines it.
 *
 * Narrow by construction, and not a SQL parser: an unrecognised shape yields no expression, which
 * withholds support rather than granting it.
 */
function projectionExpressionsFor(sql: string, column: string): string[] {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliasRe = new RegExp(`\\bAS\\s+"?${escaped}"?\\s*(?=,|\\)|\\s|$)`, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = aliasRe.exec(sql)) !== null) {
    let depth = 0;
    let start = -1;
    for (let i = m.index - 1; i >= 0; i -= 1) {
      const ch = sql[i];
      if (ch === ")") depth += 1;
      else if (ch === "(") {
        if (depth === 0) { start = i + 1; break; }   // opening paren of this select list
        depth -= 1;
      } else if (ch === "," && depth === 0) { start = i + 1; break; }
    }
    if (start < 0) start = 0;
    let expr = sql.slice(start, m.index);
    const select = /\bSELECT\b(?![\s\S]*\bSELECT\b)/i.exec(expr);
    if (select) expr = expr.slice(select.index + select[0].length);
    out.push(expr.trim());
  }
  return out;
}

/**
 * Month identities as flat points, for callers that want a chronological list.
 *
 * Both recognized shapes, one definition — the `YYYY-MM` shape was invisible to the previous
 * year/month-only reader, which is why GC-042's rows appeared to carry no months.
 */
export function monthPointsFromRows(rows: Record<string, unknown>[]): { year: number; month: number }[] {
  const points: { year: number; month: number }[] = [];
  for (const [year, months] of monthCoverageFromRows(rows)) {
    for (const month of months) points.push({ year, month });
  }
  return points.sort((a, b) => a.year - b.year || a.month - b.month);
}

/** Does any row carry this year? */
function rowsCarryYear(rows: Record<string, unknown>[], year: number): boolean {
  return rows.some((row) => YEAR_COLS.some((col) => Number(row[col]) === year));
}

function appendPeriodSentence(text: string, sentence: string): string {
  const trimmed = (text || "").trim();
  if (!trimmed) return sentence;
  if (trimmed.includes(sentence)) return trimmed;
  return `${trimmed}\n\n${sentence}`;
}

/**
 * The period a result covers, named exactly.
 *
 * One year reads as its own months, so a gap is listed rather than hidden between endpoints.
 * Several years read as the overall envelope — which is useful, but never a substitute for the
 * partial year's own basis, stated separately by `partialYearMonthBasis`.
 */
export function returnedMonthRange(rows: Record<string, unknown>[]): string | null {
  const coverage = monthCoverageFromRows(rows);
  if (coverage.size === 0) return null;
  const years = [...coverage.keys()].sort((a, b) => a - b);
  if (years.length === 1) {
    const described = describeMonths(coverage.get(years[0]) ?? []);
    return described ? `${described} ${years[0]}` : null;
  }
  const first = coverage.get(years[0]) ?? [];
  const last = coverage.get(years[years.length - 1]) ?? [];
  if (first.length === 0 || last.length === 0) return null;
  return `${MONTH_NAMES[first[0] - 1]} ${years[0]}-${MONTH_NAMES[last[last.length - 1] - 1]} ${years[years.length - 1]}`;
}

/** The months a single year actually carries, named exactly. */
export function partialYearMonthBasis(rows: Record<string, unknown>[], year: number): string | null {
  const months = monthCoverageFromRows(rows).get(year);
  if (!months || months.length === 0) return null;
  const described = describeMonths(months);
  return described ? `${described} ${year}` : null;
}

/**
 * The period sentences a first answer must already carry.
 *
 * Lives here rather than in the disclosure builder so a route can apply it BEFORE its first
 * delivery: `applyResultDisclosures` runs only on the later explanation, and a correction cannot
 * un-send what has gone out. That is why GC-041's month basis reached the reader in a second event
 * and GC-042's never did. Idempotent, so the later path applying it again adds nothing.
 */
export function applyPeriodDisclosure(
  explanation: string,
  rows: Record<string, unknown>[],
  opts?: {
    /**
     * Does a partial period or a period comparison actually bear on this answer?
     *
     * Carried from the caller's own context — the query contract's partial-year finding, or a change
     * column being withheld. **Defaults to false**: an unrelated annual statistic such as a
     * population estimate must not acquire a month-coverage warning merely because its single row
     * carries the current year. Row presence is not relevance.
     */
    partialPeriodRelevant?: boolean;
  },
): string {
  let out = String(explanation ?? "");
  if (!Array.isArray(rows) || rows.length === 0) return out;

  /*
   * FACTS FIRST, and unconditionally. What months the result carries is a fact about the result, so
   * the returned period and the partial year's own basis are stated whenever the rows establish
   * them. Only the ABSENT-evidence warning below depends on relevance.
   */
  const returned = returnedMonthRange(rows);
  if (returned && !new RegExp(returned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(out)) {
    out = appendPeriodSentence(out, `Returned period: ${returned}.`);
  }

  const nowYear = new Date().getFullYear();
  const coverage = monthCoverageFromRows(rows);
  if (!rowsCarryYear(rows, nowYear) && !coverage.has(nowYear)) return out;

  const basis = partialYearMonthBasis(rows, nowYear);
  if (basis) {
    if (!new RegExp(basis.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(out)) {
      out = appendPeriodSentence(out, `The ${nowYear} figures cover ${basis}.`);
    }
    return out;
  }

  // No month identities. Say so only where a partial period or comparison is actually in play.
  if (opts?.partialPeriodRelevant && !/does not establish which months/i.test(out)) {
    out = appendPeriodSentence(out, "The returned result does not establish which months are included.");
  }
  return out;
}

/**
 * Does the question itself put a partial period or a period comparison in play?
 *
 * The one bounded relevance rule, shared by every caller so they cannot disagree. It asks whether
 * the REQUEST is about a period — year-to-date, "through May", by month, a trend, a comparison — not
 * what the rows happen to contain.
 *
 * **A bare year is deliberately not enough.** "What is the population estimate for 2026?" names the
 * current year and is still an ordinary annual statistic; warning it about month coverage would be
 * the exact noise this rule exists to prevent. The consequence is accepted and stated: a question
 * that names only a year, with no period wording, no longer receives the absent-months sentence.
 *
 * Not a question classifier — a fixed phrase list, and nothing is inferred from the answer.
 */
const PARTIAL_PERIOD_QUESTION =
  /\b(?:ytd|year[-\s]?to[-\s]?date|so far|this year|to date|partial|through\s+\w+|each year|by month|per month|monthly|month[-\s]?over[-\s]?month|trend|compared?|comparison|change|increase|decrease|since\s+\w+)\b/i;

export function questionSuggestsPartialPeriod(question: string | null | undefined): boolean {
  return PARTIAL_PERIOD_QUESTION.test(String(question ?? ""));
}

/**
 * Is absent month evidence worth stating for this answer?
 *
 * True when the request is about a period, or when the rows themselves make the gap meaningful —
 * months are established for some year but not for the current one, so their absence is a fact about
 * this result rather than a general property of annual data.
 */
export function partialPeriodIsRelevant(
  question: string | null | undefined,
  rows: Record<string, unknown>[],
): boolean {
  if (questionSuggestsPartialPeriod(question)) return true;
  const coverage = monthCoverageFromRows(rows);
  if (coverage.size === 0) return false;
  const nowYear = new Date().getFullYear();
  return !coverage.has(nowYear) && rowsCarryYear(rows, nowYear);
}

/** Are these months an unbroken run? A gap must never hide inside an endpoint range. */
export function monthsAreContiguous(months: number[]): boolean {
  return months.length > 0 && months[months.length - 1] - months[0] === months.length - 1;
}

/**
 * Describe a year's months exactly. Contiguous runs read as a range; a gapped set is listed, so
 * "January, February, March and May" can never be shortened to "January-May".
 */
export function describeMonths(months: number[]): string | null {
  if (months.length === 0) return null;
  if (months.length === 1) return MONTH_NAMES[months[0] - 1];
  if (monthsAreContiguous(months)) return `${MONTH_NAMES[months[0] - 1]}-${MONTH_NAMES[months[months.length - 1] - 1]}`;
  const names = months.map((m) => MONTH_NAMES[m - 1]);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * Is this column explained by two other columns in the SAME row — a share or ratio?
 *
 * A within-row explanation is stronger evidence of meaning than a cross-row coincidence, and it must
 * win. Rows where firearm murders and total murders both rise 50% make a constant 50% share
 * reconcile as a year-over-year change by accident; the same-row identity `100 * part / whole` is
 * what the column actually is.
 */
function hasWithinRowExplanation(rows: Record<string, unknown>[], candidate: string, columns: string[]): boolean {
  const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  for (const part of columns) {
    if (part === candidate) continue;
    for (const whole of columns) {
      if (whole === candidate || whole === part) continue;
      let comparable = 0;
      let agreeing = 0;
      for (const row of rows) {
        const p = numeric(row[part]);
        const w = numeric(row[whole]);
        const stated = numeric(row[candidate]);
        if (p === null || w === null || stated === null || w === 0) continue;
        comparable += 1;
        const asShare = Math.round((1000 * p) / w) / 10;
        const asRatio = Math.round((1000 * p) / w) / 1000;
        if (Math.abs(asShare - stated) <= 0.05 || Math.abs(asRatio - stated) <= 0.0005) agreeing += 1;
      }
      if (comparable > 0 && comparable === agreeing) return true;
    }
  }
  return false;
}

/**
 * Is this column a year-over-year change of another column in the same rows?
 *
 * Two pieces of evidence, both required, and neither is the column's name:
 *   1. the arithmetic reconciles across every comparable adjacent year, and
 *   2. no SAME-ROW explanation exists — because a share that happens to track a change is a share.
 *
 * When the executed `sql` is supplied, a recognized cross-row derivation (`LAG`/`LEAD` ordered by
 * year) producing this alias is required as well. That is the trusted meaning where it is available;
 * where it is not, the two row-level tests above are the basis, which is weaker and is why the
 * same-row exclusion carries the weight.
 */
export function findVerifiedChangeColumns(
  rows: Record<string, unknown>[],
  columns: string[],
  sql?: string,
): VerifiedChangeColumn[] {
  const found: VerifiedChangeColumn[] = [];
  if (!Array.isArray(rows) || rows.length < 2) return found;
  const yearCol = YEAR_COLS.find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol) return found;

  const ordered = [...rows].sort((a, b) => Number(a[yearCol]) - Number(b[yearCol]));
  const numeric = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

  for (const candidate of columns) {
    if (candidate === yearCol) continue;
    // A same-row share explains the column better than a cross-row coincidence.
    if (hasWithinRowExplanation(rows, candidate, columns)) continue;
    // When the query is available, require its recognized year-over-year derivation for this alias.
    if (sql && !hasYearOverYearDerivation(sql, candidate)) continue;
    for (const base of columns) {
      if (base === candidate || base === yearCol) continue;
      let comparable = 0;
      let agreeing = 0;
      for (let i = 1; i < ordered.length; i += 1) {
        if (Number(ordered[i][yearCol]) - Number(ordered[i - 1][yearCol]) !== 1) continue;
        const now = numeric(ordered[i][base]);
        const prev = numeric(ordered[i - 1][base]);
        const stated = numeric(ordered[i][candidate]);
        if (now === null || prev === null || stated === null || prev === 0) continue;
        comparable += 1;
        const expected = Math.round((1000 * (now - prev)) / prev) / 10;
        if (Math.abs(expected - stated) <= 0.05) agreeing += 1;
      }
      // Every comparable adjacent pair must agree, and there must be at least one.
      if (comparable > 0 && comparable === agreeing) { found.push({ column: candidate, base }); break; }
    }
  }
  return found;
}

/**
 * Decide whether a year-over-year pair rests on comparable periods.
 *
 * Returns `null` when the pair is outside this control's scope — neither side is the current
 * calendar year, so the partial-versus-complete risk this exists for is not present.
 */
export function decideYearPair(
  year: number,
  against: number,
  coverage: MonthCoverage | Map<number, number[]>,
  _currentYear?: number,
): PairDecision | null {
  /*
   * The calendar is not evidence. An earlier version evaluated a pair only when one side was the
   * current year, so the identical unresolved GC-055 comparison became "supported" on 1 January
   * merely because the clock advanced. Comparability is a property of the periods, not of today's
   * date; `_currentYear` is retained only so existing callers keep compiling and is unused.
   */
  void _currentYear;

  // A union across entities speaks for no single series and cannot certify a match.
  if (coverage instanceof MonthCoverage && !coverage.attributable) {
    return {
      year, against, state: "unestablished", basis: null,
      reason: "the returned rows cover several entities, so the months cannot be attributed to the compared series",
    };
  }

  const a = coverage.get(year);
  const b = coverage.get(against);
  if (!a || a.length === 0 || !b || b.length === 0) {
    return {
      year, against, state: "unestablished", basis: null,
      reason: `the returned result does not establish which months ${!a || a.length === 0 ? year : against} covers`,
    };
  }
  const same = a.length === b.length && a.every((m, i) => m === b[i]);
  if (!same) {
    return { year, against, state: "unequal", basis: null, reason: `${year} and ${against} cover different months` };
  }
  return { year, against, state: "matched", basis: describeMonths(a), reason: `both cover ${describeMonths(a)}` };
}

/**
 * Build the presentation result: the same rows, with any change value that does not rest on a
 * matched comparison replaced by `null`.
 *
 * The input rows are never mutated — the executed evidence stays exactly as the query returned it,
 * and what changed is only what is delivered. `null` is used because the table renderer prints an
 * empty cell for it; a numeric zero would assert no change and must never appear.
 */
export function withholdUnverifiedChange(opts: {
  rows: Record<string, unknown>[];
  columns: string[];
  /** Retained for existing callers; comparability no longer depends on the calendar. */
  currentYear?: number;
  /** The executed query, when the caller has it. Adds the trusted derivation signal. */
  sql?: string;
  /** The narrative the model produced, so the delivered text can be prepared here. */
  explanation?: string;
  /** The title the model produced. */
  title?: string;
  /** Period sentences to apply to the delivered narrative. Injected to avoid a module cycle. */
  periodDisclosure?: (text: string, rows: Record<string, unknown>[], o?: { partialPeriodRelevant?: boolean }) => string;
  /** Does the caller's own context establish that a partial period bears on this answer? */
  partialPeriodRelevant?: boolean;
  /** The caller's question. The one relevance rule is applied to it here, so callers cannot differ. */
  question?: string;
}): WithholdingResult {
  const { rows, columns, currentYear, sql } = opts;
  const baseText = String(opts.explanation ?? "");
  const baseTitle = String(opts.title ?? "");
  const withPeriod = (text: string, r: Record<string, unknown>[], relevant: boolean) =>
    (opts.periodDisclosure ?? applyPeriodDisclosure)(text, r, { partialPeriodRelevant: relevant });
  const identity = <T,>(chart: T) => chart;
  // One bounded relevance decision, from the caller's own context.
  const relevant = opts.partialPeriodRelevant ?? partialPeriodIsRelevant(opts.question, rows);
  const untouched: WithholdingResult = {
    rows, columns, withheld: [], note: null,
    explanation: withPeriod(baseText, rows, relevant), title: baseTitle, cleanChart: identity,
    strip: (text: string) => text,
  };
  if (!Array.isArray(rows) || rows.length === 0) return untouched;

  /*
   * Two kinds of evidence, both required to cover the two representations actually observed.
   *
   * The arithmetic detector reconciles a numeric change against its base. It cannot see
   * `decreased: "Yes"`, because a string never reconciles — which is exactly how GC-055 got
   * through. The structural detector reads what the query itself states: a column computed from a
   * lagged alias is a derived comparison whatever type it returns. A direct lag alias is NOT
   * included by either: a prior-period observation is permitted alongside the current one.
   */
  const verified = findVerifiedChangeColumns(rows, columns, sql);
  const structural = findStructuralChangeColumns(rows, columns, sql)
    .filter((column) => !verified.some((entry) => entry.column === column))
    .map((column) => ({ column, base: null }));
  const changeColumns: VerifiedChangeColumn[] = [...verified, ...structural];
  if (changeColumns.length === 0) return untouched;

  const yearCol = YEAR_COLS.find((c) => rows[0]?.[c] !== undefined);
  if (!yearCol) return untouched;

  const coverage = monthCoverageFromRows(rows);
  const ordered = [...rows].sort((a, b) => Number(a[yearCol]) - Number(b[yearCol]));
  const priorYear = new Map<number, number>();
  for (let i = 1; i < ordered.length; i += 1) {
    priorYear.set(Number(ordered[i][yearCol]), Number(ordered[i - 1][yearCol]));
  }

  const withheld: WithholdingResult["withheld"] = [];
  const next = rows.map((row) => {
    const year = Number(row[yearCol]);
    const against = priorYear.get(year);
    if (against === undefined) return row;
    const decision = decideYearPair(year, against, coverage, currentYear);
    if (!decision || decision.state === "matched") return row;
    const copy = { ...row };
    for (const { column } of changeColumns) {
      if (copy[column] === null || copy[column] === undefined) continue;
      copy[column] = null;
      withheld.push({ column, year, state: decision.state });
    }
    return copy;
  });

  if (withheld.length === 0) return untouched;

  const years = [...new Set(withheld.map((w) => w.year))].sort((a, b) => a - b);
  const yearList = years.length <= 1 ? String(years[0] ?? "") : `${years.slice(0, -1).join(", ")} and ${years[years.length - 1]}`;
  const unestablished = withheld.some((w) => w.state === "unestablished");
  const note = unestablished
    ? `The year-over-year change for ${yearList} is not shown: the returned result does not establish which months ${years.length === 1 ? "that year covers" : "those years cover"}, so it cannot be compared with a full year on the same basis. The underlying totals are unchanged.`
    : `The year-over-year change for ${yearList} is not shown: the compared years cover different months, so the change would not be a like-for-like comparison. The underlying totals are unchanged.`;

  const stripped = stripWithheldChangeClaims(baseText, withheld);
  // A withheld comparison is itself a period comparison in play, so the warning is relevant here.
  const delivered = withPeriod(appendWithheldChangeNote(stripped.text, note), next, true);
  return {
    rows: next, columns, withheld, note,
    explanation: delivered,
    title: safeTitleWithoutWithheldChange(baseTitle, withheld, "Results"),
    cleanChart: <T,>(chartConfig: T) => stripChangeFromChart(chartConfig, withheld),
    strip: (text: string) => stripWithheldChangeClaims(text, withheld).text,
  };
}

/*
 * A change assertion is a DIRECTION WORD naming a year, with or without a figure.
 *
 * An earlier version also required a percentage (`/\d+(?:\.\d+)?\s*(?:%|percent)/`). That constant
 * is gone rather than left unused: requiring it is what let "violent crime decreased in 2026" stand
 * beside a withheld categorical column. The title rules do their own percentage-shaped trimming
 * inline, so nothing else needed it.
 */
const CHANGE_VERB = /\b(?:decreas\w*|increas\w*|fell|fall\w*|rose|rise\w*|dropp?\w*|declin\w*|up|down|change[sd]?|growth|surge\w*|plunge\w*)\b/i;
/**
 * Does the sentence deny or qualify a change rather than assert one?
 *
 * The withholding note and the period disclosures both name a year next to the word "change", so a
 * predicate that looked only for verb-plus-year would delete the very sentences that explain the
 * withholding. Those are appended after stripping today, but the later-explanation and retry paths
 * re-strip text that already carries them.
 */
const CHANGE_DENIAL = /\b(?:not\s+shown|not\s+established|cannot|can\s?not|could\s+not|does\s+not|do\s+not|did\s+not|is\s+not|are\s+not|no\s+(?:change|comparison)|without|unless|withheld|unknown|unestablished)\b/i;

/**
 * Does this sentence assert a change for a year whose change value was withheld?
 *
 * A percentage figure is sufficient but NOT necessary. GC-055's second run carried the claim as a
 * categorical column and the prose said a year had decreased with no percentage anywhere, so a
 * percent-only test left the assertion standing. A directional verb naming a withheld year is the
 * claim, whatever numerals accompany it — unless the sentence is denying or qualifying it.
 */
function assertsWithheldChange(unit: string, years: number[]): boolean {
  if (!CHANGE_VERB.test(unit)) return false;
  if (CHANGE_DENIAL.test(unit)) return false;
  if (!years.some((y) => new RegExp(`\\b${y}\\b`).test(unit))) return false;
  return true;
}

/**
 * Remove sentences that assert a change whose figure has been withheld.
 *
 * Option B, not option A: a disputed percentage is not left standing with a warning beneath it. Only
 * units that assert the withheld change are removed; the rest of the narrative, the underlying counts
 * and unrelated supported sentences survive.
 */
export function stripWithheldChangeClaims(
  explanation: string,
  withheld: { year: number }[],
): { text: string; removed: boolean } {
  const years = [...new Set(withheld.map((w) => w.year))];
  if (years.length === 0) return { text: explanation, removed: false };
  let removed = false;
  const keptLines: string[] = [];
  for (const line of String(explanation ?? "").split("\n")) {
    if (!line.trim()) { keptLines.push(line); continue; }
    const kept = line
      .split(/(?<=[.!?])(?=\s+["'(]?[A-Z])/)
      .filter((unit) => {
        if (!assertsWithheldChange(unit, years)) return true;
        removed = true;
        return false;
      });
    if (kept.length === 0) continue;
    keptLines.push(kept.join("").replace(/[ \t]+/g, " ").trim());
  }
  return { text: keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), removed };
}

/**
 * A title must not carry a withheld change either.
 *
 * Narrow removal first; if a percentage still stands beside a withheld year, the title falls back to
 * the route's own neutral default rather than being rewritten into a new claim.
 */
export function safeTitleWithoutWithheldChange(
  title: string | null | undefined,
  withheld: { year: number }[],
  fallback = "Results",
): string {
  const years = [...new Set(withheld.map((w) => w.year))];
  const text = String(title ?? "").trim();
  if (!text || years.length === 0) return text || fallback;
  if (!assertsWithheldChange(text, years)) return text;
  const trimmed = text
    .replace(/\b(?:up|down|fell|rose|decreas\w*|increas\w*|dropp?\w*|declin\w*)\s+\d+(?:\.\d+)?\s*(?:%|percent)/gi, "")
    .replace(/\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:decrease|increase|change|drop|rise)?/gi, "")
    .replace(/\s{2,}/g, " ").replace(/[\s,;:—-]+$/, "").trim();
  return trimmed && !assertsWithheldChange(trimmed, years) ? trimmed : fallback;
}

/**
 * Remove a withheld change from a chart: its series, its annotations and its title.
 *
 * A blank table cell is not enough if the same figure is still plotted or captioned. When nothing
 * chartable remains, the chart is dropped rather than shown with a misleading axis.
 */
export function stripChangeFromChart<T>(
  chartConfig: T,
  withheld: { column: string; year: number }[],
): T {
  if (!chartConfig || typeof chartConfig !== "object" || withheld.length === 0) return chartConfig;
  const columns = new Set(withheld.map((w) => w.column));
  const years = [...new Set(withheld.map((w) => w.year))];
  const next = { ...(chartConfig as unknown as Record<string, unknown>) };

  const yAxis = next.yAxis;
  if (Array.isArray(yAxis)) {
    const keep = yAxis.filter((k) => !columns.has(String(k)));
    if (keep.length === 0) return null as T;
    next.yAxis = keep;
  } else if (typeof yAxis === "string" && columns.has(yAxis)) {
    return null as T;
  }

  if (Array.isArray(next.annotations)) {
    next.annotations = (next.annotations as Record<string, unknown>[])
      .filter((a) => !assertsWithheldChange(String(a?.text ?? ""), years));
  }
  if (typeof next.title === "string") next.title = safeTitleWithoutWithheldChange(next.title, withheld, "Results");
  return next as T;
}

/**
 * Attach the withholding note to a narrative, once, AFTER the offending claims are removed.
 *
 * Idempotent, because the later explanation and retry paths rebuild the narrative and must neither
 * lose the note nor stack copies of it.
 */
export function appendWithheldChangeNote(explanation: string, note: string | null): string {
  if (!note) return explanation;
  const body = String(explanation ?? "").trimEnd();
  if (body.includes(note)) return body;
  return body ? `${body}\n\n${note}` : note;
}

/** Remove the withheld claims and then state what was withheld. The single presentation decision. */
export function applyChangeWithholdingToText(
  explanation: string,
  result: Pick<WithholdingResult, "withheld" | "note">,
): string {
  if (result.withheld.length === 0) return explanation;
  const stripped = stripWithheldChangeClaims(explanation, result.withheld);
  return appendWithheldChangeNote(stripped.text, result.note);
}

/**
 * Remove a change claim from a title whose figure has been withheld.
 *
 * Titles are short and formulaic, so this is deliberately narrow: a trailing percentage-change
 * fragment naming a withheld year. Anything it does not recognise is left alone rather than
 * rewritten — a title is not prose to be edited.
 */
export function stripUnsupportedChangeClaim(
  title: string | null | undefined,
  withheld: { year: number }[],
): string | null {
  const text = String(title ?? "").trim();
  if (!text || withheld.length === 0) return title ?? null;
  const years = [...new Set(withheld.map((w) => w.year))];
  let out = text;
  for (const year of years) {
    out = out
      .replace(new RegExp(`[,;:—-]?\\s*(?:down|up|fell|rose|decreased|increased)\\s+[\\d.]+%\\s*(?:in\\s+)?${year}\\b`, "gi"), "")
      .replace(new RegExp(`[,;:—-]?\\s*[\\d.]+%\\s+(?:decrease|increase|change|drop|rise)\\s*(?:in\\s+)?${year}\\b`, "gi"), "");
  }
  out = out.replace(/\s{2,}/g, " ").replace(/[\s,;:—-]+$/, "").trim();
  return out || (title ?? null);
}
