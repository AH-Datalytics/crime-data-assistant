import { requestWindowGrain, type QueryContract, type QueryContractSource } from "./query-contract";
import { detectRequestedGrain } from "./requested-grain";
import { analyzeSql, groupByColumns, LITERAL_SOURCE, type SelectItem } from "./sql-lineage";
import { restrictingScopes, splitCtes, stripSqlComments } from "./sql-restriction";
import { sqlRestrictsColumnToValue } from "./sql-restriction";
import {
  allTopicColumns,
  catalogedTables,
  producesLevel,
  requirementColumns,
  requirementSatisfied,
  resolveUnit,
  tableSemantics,
  topicColumns,
  topicIsKnown,
  topicUnitRequirement,
  type EntityLevel,
  type TableSemantics,
} from "./table-semantics";

/**
 * Prove that each returned factual series comes from a source that can actually represent the
 * requested geography, offense, grain and denominator.
 *
 * The first version of this module compared the SET OF TABLES MENTIONED against the request, which
 * is the "a literal appears somewhere, therefore safe" defect the county-ORI validator had to fix
 * twice. Four shapes passed it, all reproduced before this rewrite:
 *
 *   decorative denominator   COUNT(*) * 100000.0 / i.population  with state_population joined and
 *                            entirely unused -- the rate still divided by the per-agency column.
 *   cross-offense            SELECT hac.robbery AS murders  for a murder question.
 *   uncatalogued source      SELECT COUNT(*) AS murders FROM source_build_receipts.
 *   mixed series             one compatible table authorising an incompatible second series.
 *
 * So this works from `sql-lineage.ts`, which resolves each returned expression to the base tables
 * its columns actually come from, and evaluates every factual series independently. Anything that
 * cannot be resolved is a finding, not a pass: a shape we cannot prove is not a shape we execute.
 */

export type StructuralSeverity = "block" | "retry";

export type StructuralFinding = {
  ruleId: string;
  severity: StructuralSeverity;
  message: string;
  requestedLevel: EntityLevel;
  /** Which returned series produced this finding, for the retry directive. */
  series: string | null;
  /**
   * When true the message is the whole retry instruction and the caller must not append its own
   * advice. The generic wrapper tells the model to rewrite against a table of a different row
   * level, which is right for a wrong-table finding and wrong for a finding about one added filter
   * on the correct table -- it would ask for an unrelated source change.
   */
  selfContainedInstruction?: boolean;
};

export type RequestedScope = {
  rowLevel: EntityLevel;
  evidence: string;
  unit: QueryContract["metric"]["unit"];
  topic: string;
  grain: "monthly" | "annual" | null;
};

/**
 * A request can name a place to filter by and a different level to break out by. "Top 10 US cities"
 * filters nationally and returns cities. Ordered finest-first.
 */
const ROW_LEVEL_CUES: { level: EntityLevel; pattern: RegExp; label: string }[] = [
  {
    level: "agency", label: "asks for a list of agencies or departments",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:agenc(?:y|ies)|police\s+departments?|sheriff'?s?\s+offices?)\b|\bby\s+agenc(?:y|ies)\b|\bagenc(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "city", label: "asks for a list of cities",
    pattern: /\b(?:top|bottom|best|worst|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all|safest|deadliest)\b[^.?!]{0,40}\bcit(?:y|ies)\b|\bby\s+cit(?:y|ies)\b|\bcit(?:y|ies)\s+(?:with|that|ranked|had|have)\b/i,
  },
  {
    level: "county", label: "asks for a list of counties",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\b(?:count(?:y|ies)|parish(?:es)?)\b|\bby\s+count(?:y|ies)\b|\bcount(?:y|ies)\s+(?:with|that|ranked)\b/i,
  },
  {
    level: "state", label: "asks for a list of states",
    pattern: /\b(?:top|bottom|highest|lowest|most|fewest|rank(?:ed|ing)?|list|which|every|all)\b[^.?!]{0,40}\bstates?\b|\bby\s+state\b|\bstates?\s+(?:with|that|ranked)\b/i,
  },
];

const GEOGRAPHY_TO_LEVEL: Record<QueryContract["geography"]["kind"], EntityLevel> = {
  city: "city", county: "county", state: "state", agency: "agency", campus: "agency",
  national: "national", unknown: "unknown",
};

/** Columns that describe a row rather than measure it. */
export const DIMENSION_COLUMNS = new Set([
  "year", "month", "quarter", "data_year", "date", "incident_date", "state", "state_name", "ori",
  "agency", "agency_name", "city", "county", "county_key", "type", "agency_type", "pop_group",
  "ori9", "name", "division", "region", "start", "end", "id", "incident_number", "incident_num",
  // A population column is a denominator or a context column beside the measure, not the measure.
  // Selecting it is how several real queries show the rate's base.
  "population",
  // Coverage columns say how much of a period the figure beside them rests on. Same argument as
  // `population`: context for the measure, never the measure itself. A controlled path returns them
  // so its answer can state its own basis instead of asserting one, and reading them as a crime
  // figure would refuse a query for showing its working.
  "months_reported", "months_with_data",
]);

export function requestedScope(question: string, contract: QueryContract): RequestedScope {
  // Reuse the existing detector so the pre-execution check and `validateGrain()` cannot disagree.
  // An amended request carries its series form; its question text is only the reader's fragment.
  const grain = contract.request ? requestWindowGrain(contract.request.window) : detectRequestedGrain(question);

  for (const cue of ROW_LEVEL_CUES) {
    if (cue.pattern.test(question)) {
      return { rowLevel: cue.level, evidence: cue.label, unit: contract.metric.unit, topic: contract.metric.topic, grain };
    }
  }
  for (const breakdown of contract.breakdowns) {
    if (breakdown === "city" || breakdown === "state" || breakdown === "agency") {
      return {
        rowLevel: breakdown as EntityLevel, evidence: `contract breakdown "${breakdown}"`,
        unit: contract.metric.unit, topic: contract.metric.topic, grain,
      };
    }
  }
  return {
    rowLevel: GEOGRAPHY_TO_LEVEL[contract.geography.kind],
    evidence: `requested geography is ${contract.geography.kind}`,
    unit: contract.metric.unit, topic: contract.metric.topic, grain,
  };
}

/**
 * Levels the question explicitly names in addition to the one it is about.
 *
 * "Compare murders in Chicago to the national total" legitimately returns a city series AND a
 * national one. Licensing is deliberately narrow: a coarser series is allowed only when the
 * question names that level in words AND another series in the same query actually serves the
 * requested level. Without both, "top 10 us cities" would license `national` from the word "us"
 * and a state-row answer would slip through again.
 */
function licensedLevels(question: string): EntityLevel[] {
  const levels: EntityLevel[] = [];
  if (/\b(?:national(?:ly|wide)?|united\s+states|countrywide)\b/i.test(question)) levels.push("national");
  if (/\bstate(?:wide)?\b/i.test(question)) levels.push("state");
  return levels;
}

/**
 * Is this value produced by COUNTING ROWS rather than by reading a measure column?
 *
 * `numericWithoutColumns` alone was too narrow: `COUNT(v.id)` names a column, so it escaped the
 * check entirely even though `id` is an identifier and the value is still a row count.
 */
function isRowCount(item: SelectItem): boolean {
  // A division is a RATE, and the denominator rule owns it. `COUNT(*) * 100000.0 / population` uses
  // a row count as its numerator but is not itself a row count, and claiming it here short-circuited
  // the denominator check that actually governs it.
  if (item.denominatorRefs !== null) return false;
  if (item.numericWithoutColumns) return true;
  if (!item.countsRows) return false;
  // COUNT(<identifier>) is a row count; COUNT over a real measure column is not.
  return item.refs.every((ref) => DIMENSION_COLUMNS.has(ref.column) || ref.table === LITERAL_SOURCE);
}

/** Is every filter this licence depends on actually present in the SQL? */
function requiredFiltersPresent(
  entry: TableSemantics, sql: string
): { ok: boolean; missing: string[] } {
  const required = entry.eventRow?.requiresFilters ?? [];
  const join = entry.eventRow?.requiresJoin;
  // A conditional licence with no declared relationship cannot be proved, so it is not granted.
  // Anything else would let co-presence in a FROM clause stand in for the join.
  if (required.length > 0 && !join) {
    return { ok: false, missing: required.map(({ column, value }) => `${column} = '${value}'`) };
  }
  const missing = required
    // Not "does the text appear" -- `sqlRestrictsColumnToValue` proves the predicate restricts the
    // rows being counted THROUGH the declared relationship. A hit in a comment, in an unused CTE,
    // beside an `OR`, inside a multi-value `IN`, on the wrong table, or across a CROSS JOIN is a
    // mention, not a filter, and this licence is only as good as the filter.
    .filter(({ column, value, onTable }) => !sqlRestrictsColumnToValue(sql, column, value, {
      countedTable: entry.table,
      filterTable: onTable,
      join: { countedColumn: join!.column, filterColumn: join!.toColumn },
    }))
    .map(({ column, value }) => `${column} = '${value}'`);
  return { ok: missing.length === 0, missing };
}

/** Does this returned expression carry a measurement, as opposed to labelling the row? */
/**
 * A MONTH REPORTED AS A YEAR -- CHECKED WHERE THE GROUPING ACTUALLY HAPPENS.
 *
 * GC-043: `SELECT s.year, s.offense_count AS total_offenses ... FROM summary_city_monthly s
 * GROUP BY s.year`, delivered as "by Year". No aggregate anywhere in that select list, and
 * `summary_city_monthly` holds one row per month, so each year returned one arbitrary month.
 *
 * SCOPE IS THE WHOLE DIFFICULTY, and looking only at the outer query got it wrong twice:
 *  - the same bad grouping moved inside a used CTE, with the outer query merely projecting it, has
 *    no outer GROUP BY at all -- so every scope the statement actually uses is checked, each
 *    against its own grouping;
 *  - a CTE that sums correctly and an outer query that regroups its ANNUAL results by year was
 *    refused for aggregating in the wrong place rather than not at all. `ColumnRef.aggregated`
 *    carries that fact out of the CTE, and `unaggregatedRefs` drops such references.
 *
 * Three exclusions keep real answers working: grouped columns (constant within their group),
 * dimension columns, and the column that SELECTS the offense -- GC-043's own corrected query
 * returns `s.ucr_offense_code` beside its sums. The test is per REFERENCE, so `SUM(a) - b` is
 * still reported on `b`: an aggregate over one operand proves nothing about the others.
 *
 * A CTE body that reads another CTE resolves no base table here and is therefore skipped. That is
 * a coverage limit, not a licence -- the scope that reads the monthly table itself is still checked.
 */
function monthlyRowsNotAggregated(
  sql: string, source: QueryContractSource
): { message: string; series: string }[] {
  const findings: { message: string; series: string }[] = [];
  const seen = new Set<string>();
  // `restrictingScopes` returns the outer query followed by every CTE the statement really uses,
  // transitively -- the same "actually contributes" walk the year proof relies on. It returns the
  // outer query WITHOUT its `WITH` clause, so the outer scope is read from the whole statement
  // instead: a column arriving through a CTE must resolve to the table behind it, and must carry
  // the CTE's aggregation with it. Reading the bare outer text resolved `annual.total_offenses` to
  // an unknown relation and quietly checked nothing at all.
  const scopes = restrictingScopes(stripSqlComments(sql));
  for (const [index, scope] of scopes.entries()) {
    const text = index === 0 ? sql : scope;
    const grouped = new Set(groupByColumns(text));
    if (!((grouped.has("year") || grouped.has("data_year")) && !grouped.has("month"))) continue;
    const lineage = analyzeSql(text);
    if (!lineage.parsed) continue;
    for (const item of lineage.items.filter(isFactualSeries)) {
      const label = item.alias ?? item.raw.slice(0, 40);
      const bare = item.unaggregatedRefs.filter((ref) => {
        if (!ref.table || ref.table === LITERAL_SOURCE) return false;
        if (DIMENSION_COLUMNS.has(ref.column) || grouped.has(ref.column)) return false;
        const entry = tableSemantics(source, ref.table);
        if (entry?.rowPeriod !== "month") return false;
        return ref.column !== selectorColumn(entry);
      });
      if (bare.length === 0) continue;
      const named = [...new Set(bare.map((ref) => `\`${ref.table}.${ref.column}\``))];
      const key = label + "|" + named.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        series: label,
        message: `"${label}" returns ${named.join(", ")} without combining it, while grouping by ` +
          "year. One row of that table is one month, so this reports a single month as the year's " +
          "figure. Wrap each monthly measure in SUM(), and derive any rate from the summed " +
          "operands rather than from one month's.",
      });
    }
  }
  return findings;
}

/** The column that picks which offense a row is about, where the binding names one. */
function selectorColumn(entry: TableSemantics): string | null {
  const binding = entry.measureBinding;
  if (binding.kind === "code_column" || binding.kind === "value_column") return binding.column;
  return null;
}

function isFactualSeries(item: SelectItem): boolean {
  const real = item.refs.filter((ref) => ref.table !== LITERAL_SOURCE);
  // A wildcard returns whatever the table holds. It carries measurements by definition, and none of
  // them can be checked, so it must be treated as factual and then fail closed below.
  if (item.hasWildcard) return true;
  // `COUNT(*)`, `SUM(1)` and bare constants all claim to be a measure while referencing nothing.
  // Only `COUNT(*)` used to reach this point; `SUM(1) AS murders` was classified as carrying no
  // measurement at all and skipped.
  if (item.numericWithoutColumns) return true;
  if (item.countsRows) return true;
  if (real.length === 0) return false;
  return real.some((ref) => !DIMENSION_COLUMNS.has(ref.column));
}

/**
 * Resolve each reference to a base table, narrowing a CTE shortlist by role.
 *
 * A deterministic multi-city plan builds a CTE that joins `historical_agency_crime` to
 * `historical_agency`, so a column drawn from it could come from either. Exactly one of them is a
 * metric table, and a measure can only have come from that one. Narrowing this way keeps real plans
 * working without weakening the check: if the shortlist holds two metric tables it stays unresolved.
 */
function tablesOf(
  refs: { table: string | null; candidates?: string[] }[],
  source: QueryContractSource
): (string | null)[] {
  const resolved: (string | null)[] = [];
  for (const ref of refs) {
    if (ref.table === LITERAL_SOURCE) continue;   // supplied by the query, not read from a table
    if (ref.table) { resolved.push(ref.table); continue; }
    const metric = (ref.candidates ?? [])
      .filter((table) => tableSemantics(source, table)?.role === "metric");
    resolved.push(metric.length === 1 ? metric[0] : null);
  }
  return [...new Set(resolved)];
}

function serves(entry: TableSemantics, scope: RequestedScope, source: QueryContractSource): boolean {
  if (entry.role !== "metric") return false;
  if (!producesLevel(entry, scope.rowLevel)) return false;
  switch (scope.unit) {
    case "clearance_rate":
      return entry.measures.includes("clearance_rate");
    case "rate_per_100k":
      if (entry.measures.includes("rate_per_100k")) return true;
      if (!entry.measures.includes("count")) return false;
      return catalogedTables(source).some(
        (other) => (other.denominatorLevels ?? []).includes(scope.rowLevel)
      );
    default:
      return entry.measures.includes("count") || entry.measures.includes("rate_per_100k");
  }
}

/** Could ANY table in this source answer the request? Decides retry versus decline. */
function repairable(scope: RequestedScope, source: QueryContractSource): boolean {
  return catalogedTables(source).some((entry) => serves(entry, scope, source));
}

/**
 * Is a share actually COMPUTED by one of the returned expressions?
 *
 * WHY THIS EXISTS. `resolveUnit` reports that no catalogued table models a `ratio` COLUMN, and that
 * stays true. But a share of recorded counts does not need a ratio column -- it needs a numerator
 * and a denominator, both of which the counts already supply. Rejecting on the unit label alone
 * refused questions the expert decision permits: Decision 3 prohibits unsupported demographic
 * PER-CAPITA rates, not arithmetic shares of recorded counts. That over-refusal is the measured
 * GC-032/033/034/035 failure.
 *
 * WHAT COUNTS AS PROOF, and why it is deliberately narrow. One returned expression must actually
 * DIVIDE -- `denominatorRefs` is non-null only for a division -- and the denominator must trace to a
 * catalogued METRIC table in this statement. Two counts sitting side by side are ingredients, not a
 * share, and they must keep failing: that is the distinction this guard exists to preserve, and it
 * is what separates the saved GC-033/035 statements from their completed variants.
 *
 * A denominator with no column references at all (`COUNT(*)`) falls back to the statement's base
 * tables, the same rule the completeness loop below uses -- otherwise `COUNT(*)` would contribute no
 * table and a legitimate share over a counted row set would be refused.
 *
 * This does NOT approve a per-capita rate. Population denominators are governed by
 * `denominatorApproved` and the rate-denominator check, both untouched.
 */
/** Does the first `(` in this string close at its very last character? */
function parenSpansWhole(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") {
      depth--;
      if (depth === 0) return i === s.length - 1;
    }
  }
  return false;
}

/** Split on a separator that is not inside parentheses or a quoted literal. */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0, quote: string | null = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === sep && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
  }
  out.push(s.slice(start));
  return out;
}

/**
 * Is this expression exactly ONE aggregate call, and nothing else?
 *
 * `COUNT(*)` yes. `NULLIF(SUM(x), 0)` yes -- the established zero-denominator form. `COUNT(*) * 2.0`
 * NO, and that is the point: a substring test for "COUNT(" accepted it while it silently halved the
 * percentage (review 2026-09-08 §3). Extra arithmetic means the divisor is no longer the total the
 * share is taken of, and we cannot establish what it is.
 */
function asSingleAggregate(text: string): { fn: string; inner: string } | null {
  let s = text.trim();
  while (s.startsWith("(") && s.endsWith(")") && parenSpansWhole(s)) s = s.slice(1, -1).trim();

  if (/^NULLIF\s*\(/i.test(s)) {
    const open = s.indexOf("(");
    if (!parenSpansWhole(s.slice(open))) return null;
    const parts = splitTopLevel(s.slice(open + 1, s.length - 1), ",");
    if (parts.length !== 2 || !/^\s*0(?:\.0*)?\s*$/.test(parts[1])) return null;
    return asSingleAggregate(parts[0]);
  }

  const m = s.match(/^(COUNT|SUM|TOTAL)\s*\(/i);
  if (!m) return null;
  const open = s.indexOf("(");
  if (!parenSpansWhole(s.slice(open))) return null;
  return { fn: m[1].toUpperCase(), inner: s.slice(open + 1, s.length - 1) };
}

/**
 * Does this column's NAME claim to be a share, rate or ratio?
 *
 * SUPPLEMENTARY ONLY. A series that calls itself a percentage while computing a bare count is
 * claiming something it did not calculate, and that claim is what the reader sees. But a label can
 * never be what distinguishes acceptance: renaming the column restored acceptance of identical
 * wrong arithmetic (review 2026-09-08 §3). `requestedOperandsEstablished` is the check that
 * actually decides; this only adds a second reason to refuse.
 */
const RATIO_ALIAS_RE = /\b(?:pct|percent(?:age)?|share|ratio|rate|proportion)\b|_pct$|^pct_/i;

/** Every single-quoted literal in an expression, unescaped. */
function quotedLiterals(expression: string): string[] {
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expression)) !== null) out.push(m[1].replace(/''/g, "'"));
  return out;
}

/** Index of the first `SELECT` at paren depth zero, skipping quoted text. */
function outerSelectList(sql: string): string | null {
  let depth = 0, quote: string | null = null, selectEnd = -1;
  const upper = sql.toUpperCase();
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") { depth += 1; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && selectEnd === -1 && upper.startsWith("SELECT", i) &&
        !/\w/.test(sql[i - 1] ?? " ") && !/\w/.test(sql[i + 6] ?? " ")) {
      selectEnd = i + 6;
    }
  }
  if (selectEnd === -1) return null;

  depth = 0; quote = null;
  for (let i = selectEnd; i < sql.length; i += 1) {
    const c = sql[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") { depth += 1; continue; }
    if (c === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth === 0 && upper.startsWith("FROM", i) &&
        !/\w/.test(sql[i - 1] ?? " ") && !/\w/.test(sql[i + 4] ?? " ")) {
      return sql.slice(selectEnd, i);
    }
  }
  return sql.slice(selectEnd);
}

/**
 * Words that end an expression but are not a column alias.
 *
 * `CASE WHEN … END` ends in a bare word, so stripping "the last identifier" unconditionally would
 * amputate the expression and hide its division. That is exactly the bug that let a female share
 * labelled `pct_male` through after the first attempt at this check.
 */
const NOT_AN_ALIAS = new Set([
  "end", "null", "asc", "desc", "distinct", "all", "and", "or", "not", "is", "then", "else",
  "when", "case", "like", "in", "between", "escape",
]);

/** An expression with any trailing column alias removed, so the operands can be read. */
function withoutTrailingAlias(item: string): string {
  const m = item.match(/\s+(?:AS\s+)?(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_]\w*))\s*$/i);
  if (!m) return item;
  const name = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").toLowerCase();
  if (!name || NOT_AN_ALIAS.has(name)) return item;
  return item.slice(0, item.length - m[0].length);
}

/** Both sides of the last top-level `/`, descending through one wrapping call. */
function divisionOperands(expression: string): { numerator: string; denominator: string } | null {
  let depth = 0, cut = -1, quote: string | null = null;
  for (let i = 0; i < expression.length; i += 1) {
    const c = expression[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "(") depth += 1;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (c === "/" && depth === 0) cut = i;
  }
  if (cut === -1) {
    const call = expression.match(/^\s*[A-Za-z_]\w*\s*\(([\s\S]*)\)\s*$/);
    if (call) {
      const inner = splitTopLevel(call[1], ",")[0];
      if (inner && inner !== expression) return divisionOperands(inner);
    }
    return null;
  }
  return { numerator: expression.slice(0, cut), denominator: expression.slice(cut + 1) };
}

/**
 * Does every returned division actually compute the comparison the QUESTION asked for?
 *
 * WHY THIS READS THE ORIGINAL SQL. `analyzeSql` calls `scrub()`, which blanks quoted literals, so a
 * male share and a female share reduce to identical text there. The literals are still in the input,
 * and this is the narrow companion extraction that keeps them -- lineage behaviour is untouched.
 *
 * THE CHECK. For each returned expression containing a division, if its numerator names literal
 * values then at least one must be evidenced in the question; likewise for a denominator that names
 * values, which is what binds "male to female" to a male numerator over a female denominator rather
 * than over a total. A numerator carrying no literals is not decided here -- its subject comes from
 * the measure column, which the topic and completeness checks already govern.
 *
 * WHAT IT DELIBERATELY IS NOT. Not natural-language-to-SQL equivalence, no question strings, no case
 * ids, no value allowlist. It asks one thing: do the values this calculation compares appear in the
 * request? An unresolved relationship keeps the existing refusal.
 */
/**
 * What does the request ask to divide by what?
 *
 * Two supported forms, and the difference decides the denominator's ROLE:
 *   ordered - "ratio of A to B": A over B, and B is a SUBSET, not the total.
 *   share   - "what share/percentage of X were Y": Y over the matching TOTAL.
 * Anything else is unresolved and proves nothing.
 */
type RequestedComparison =
  | { form: "ordered"; numeratorPhrase: string; denominatorPhrase: string }
  | { form: "percentage" }
  | { form: "share" }
  | { form: "unresolved" };

function describeRequestedComparison(question: string): RequestedComparison {
  const asked = question.toLowerCase();
  const ordered = asked.match(
    /\bratios?\s+of\s+(.+?)\s+to\s+(.+?)(?=\s+\b(?:in|by|since|for|from|during|between|over|per)\b|[,.?!;]|$)/
  );
  if (ordered) {
    return { form: "ordered", numeratorPhrase: ordered[1], denominatorPhrase: ordered[2] };
  }
  // "percentage" names the conversion; "share"/"proportion" leave it to the wording, so both a
  // percentage and a fraction are legitimate renderings of those.
  if (/\b(?:percentages?|percent|pct)\b/.test(asked)) return { form: "percentage" };
  if (/\b(?:share|proportion)\b/.test(asked)) return { form: "share" };
  return { form: "unresolved" };
}

/**
 * Is one of these values named in that phrase, as a WORD?
 *
 * Substring matching is wrong here and quietly so: `"female".includes("male")` is true, which would
 * accept a male numerator for a female-to-male request. Boundaries are what make the direction check
 * mean anything.
 */
function namedIn(literals: string[], phrase: string): boolean {
  const hay = phrase.toLowerCase();
  return literals.some((literal) => {
    const needle = literal.trim().toLowerCase();
    if (needle.length === 0) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`).test(hay);
  });
}

/**
 * What a single operand actually COUNTS.
 *
 * `total`      - every in-scope row, optionally weighted by a measure column.
 * `subset`     - only rows matching a RECOGNISED predicate, with a known contribution.
 * `unresolved` - anything this finite recogniser does not understand.
 *
 * WHY THE PREVIOUS VERSION WAS NOT ENOUGH. It recorded only whether a conditional KEYWORD appeared
 * and which values were quoted. So `SUM(CASE WHEN v.sex = 'Female' THEN 0 ELSE 1 END)` was read as a
 * female count when it counts every NON-female, and `COUNT(*)` next to a quoted value elsewhere
 * proved nothing at all (review 2026-09-08 §3). Naming a value is not counting it.
 *
 * DELIBERATELY FINITE. Only the shapes the approved positive families actually use are recognised.
 * Everything else is `unresolved` and refused rather than guessed — including an inverted
 * contribution, an unfamiliar predicate, or a missing `ELSE`. No general SQL equivalence.
 */
type OperandCount =
  | { kind: "total"; measure: MeasuredQuantity; scale: number }
  | { kind: "subset"; values: string[]; measure: MeasuredQuantity; scale: number }
  | { kind: "unresolved" };

/**
 * WHAT `measure` IS. The quantity being counted: `"rows"` for a row count, or the resolved measure
 * column for a weighted sum. Recording it is not enough — the previous version recorded a weight and
 * never compared it, so a sum of recorded offenders and a count of summary ROWS were interchangeable
 * totals. On the GC-032 fixture that turns 20% into 1000% or 1% (review 2026-09-08 §3).
 *
 * WHAT `scale` IS. The permitted numeric multiplier, retained rather than discarded. Stripping it to
 * find the inner aggregate is necessary; treating every multiplier as equivalent is not, and a 200
 * multiplier silently doubled the percentage while keeping a `pct_` label.
 */

/** A bare column reference, e.g. `d.offender_count`. */
const BARE_COLUMN_RE = /^[A-Za-z_][\w]*(?:\s*\.\s*[A-Za-z_][\w]*)?$/;

/**
 * Which values does this predicate SELECT?
 *
 * Recognised, because the approved families use exactly these:
 *   `col = 'v'`                          -> selects v
 *   `col = 'v' OR col IS NULL`           -> selects v (GC-034's equality-or-null)
 * A complement such as `col != 'v' AND col IS NOT NULL` is deliberately NOT recognised as selecting
 * `v`: it selects everything else, and letting it borrow `v`'s meaning is the defect above. It is
 * unresolved here, which does not affect GC-034's complementary supporting count — that column is
 * not a division operand and is never described.
 */
function selectedValues(predicate: string): string[] | null {
  const p = predicate.trim().replace(/\s+/g, " ");
  const eq = p.match(/^[\w.]+\s*=\s*'((?:[^']|'')*)'$/);
  if (eq) return [eq[1].replace(/''/g, "'")];
  const eqOrNull = p.match(/^([\w.]+)\s*=\s*'((?:[^']|'')*)'\s+OR\s+([\w.]+)\s+IS\s+NULL$/i);
  if (eqOrNull && eqOrNull[1].toLowerCase() === eqOrNull[3].toLowerCase()) {
    return [eqOrNull[2].replace(/''/g, "'")];
  }
  return null;
}

/**
 * Strip the established percentage/ratio scale factor.
 *
 * The approved shapes write `100.0 * SUM(...)` and `1.0 * SUM(...)`, and `divisionOperands` returns
 * everything left of the `/`, so the scale factor arrives attached to the numerator. Leaving it
 * there made every positive family unresolved on the first attempt at this recogniser. Only a plain
 * numeric multiplier is removed; anything else stays and will be judged as it is.
 */
function splitScaling(text: string): { expression: string; scale: number } {
  let s = text.trim();
  while (s.startsWith("(") && s.endsWith(")") && parenSpansWhole(s)) s = s.slice(1, -1).trim();
  const factors = splitTopLevel(s, "*");
  if (factors.length === 2) {
    const left = factors[0].trim();
    const right = factors[1].trim();
    const numeric = /^[-+]?[0-9][0-9_.]*$/;
    if (numeric.test(left)) return { expression: right, scale: Number(left) };
    if (numeric.test(right)) return { expression: left, scale: Number(right) };
  }
  return { expression: s, scale: 1 };
}

/**
 * A measured quantity, keeping the REFERENCE rather than only its final name.
 *
 * `measureName` used to reduce `d.offender_count` to `offender_count`, which is normalization and
 * not source resolution: two matching suffixes establish nothing about which table supplied them
 * (review 2026-09-08). The qualifier is retained so it can be resolved against the FROM clause.
 */
type MeasuredQuantity =
  | { kind: "rows"; qualifiers: string[] }
  | { kind: "column"; qualifier: string | null; column: string };

/** Alias-or-table references appearing as `x.y` in an expression. */
function qualifiersIn(expression: string): string[] {
  const out = new Set<string>();
  for (const m of expression.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*/g)) out.add(m[1].toLowerCase());
  return [...out];
}

/** `FROM`/`JOIN` sources of the outer statement, as alias -> table and table -> table. */
function outerSourceAliases(sql: string): Map<string, string> {
  const map = new Map<string, string>();
  const fromAt = sql.search(/\bFROM\b/i);
  if (fromAt === -1) return map;
  const clause = sql.slice(fromAt);
  // A schema prefix (`rollup.state_summary_...`, as the planner writes it) is not the table: reading
  // `rollup` as the table left the alias unresolved, so the routed approved share was refused.
  for (const m of clause.matchAll(/\b(?:FROM|JOIN)\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)(?:\s+(?:AS\s+)?([A-Za-z_]\w*))?/gi)) {
    const table = m[1].toLowerCase();
    const alias = (m[2] ?? "").toLowerCase();
    map.set(table, table);
    if (alias && !/^(on|where|group|order|inner|left|right|full|cross|join|using|limit)$/.test(alias)) {
      map.set(alias, table);
    }
  }
  return map;
}

/**
 * A measure resolved to its CANONICAL SOURCE IDENTITY, or `null` for unresolved.
 *
 * WHY IDENTITY AND NOT A BOOLEAN. The previous version returned only "does this resolve", and
 * equality was compared separately from the raw references. So `offender_count` and
 * `d.offender_count` — the same column, one source table — compared unequal because a qualifier was
 * matched against `null`, and an approved calculation was falsely refused (review 2026-09-08 §3).
 * Resolving first and comparing identities afterwards removes that whole class of mismatch.
 */
type ResolvedMeasure =
  | { kind: "rows" }
  | { kind: "column"; table: string; column: string };

/**
 * Resolve one operand to a supported measure identity, or `null`.
 *
 * `rows`      - some base table must declare `eventRow`, the catalog's own statement that one row is
 *               one occurrence. A stated limit, not a proof that a join's result rows are the
 *               requested entity.
 * qualified   - the alias must resolve through the FROM clause to a catalogued metric table that
 *               DECLARES the column. An UNKNOWN alias stays unresolved and deliberately does NOT
 *               fall back to the unqualified search, or a typo'd alias would silently acquire
 *               whatever meaning some other joined table happened to offer.
 * unqualified - exactly ONE base table may declare the column. Zero is undeclared, more than one is
 *               ambiguous; both are unresolved. `null` is never a wildcard.
 */
function resolveMeasure(
  quantity: MeasuredQuantity, aliases: Map<string, string>, baseTables: string[],
  source: QueryContractSource
): ResolvedMeasure | null {
  const declares = (table: string, column: string) => {
    const entry = tableSemantics(source, table);
    return Boolean(entry && entry.role === "metric" && (entry.recordedMeasures ?? []).includes(column));
  };

  if (quantity.kind === "rows") {
    const countable = baseTables.some((table) => {
      const entry = tableSemantics(source, table);
      return Boolean(entry && entry.role === "metric" && entry.eventRow);
    });
    return countable ? { kind: "rows" } : null;
  }

  if (quantity.qualifier !== null) {
    const table = aliases.get(quantity.qualifier);
    if (!table) return null;
    return declares(table, quantity.column) ? { kind: "column", table, column: quantity.column } : null;
  }

  const owners = baseTables.filter((table) => declares(table, quantity.column));
  if (owners.length !== 1) return null;
  return { kind: "column", table: owners[0], column: quantity.column };
}

/** Do two RESOLVED identities denote the same measure? */
function sameResolvedMeasure(a: ResolvedMeasure, b: ResolvedMeasure): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "rows") return true;
  const other = b as { table: string; column: string };
  return a.table === other.table && a.column === other.column;
}

/**
 * What a single operand actually COUNTS: a known total, a known subset with its real predicate and
 * row contribution, or unresolved.
 *
 * DELIBERATELY FINITE. Only the shapes the approved positive families use are recognised. An
 * inverted contribution (`THEN 0 ELSE 1`), a non-zero `ELSE`, an unfamiliar predicate or an
 * unrecognised expression is `unresolved` and refused rather than guessed — naming a value is not
 * counting it.
 */
function describeOperand(text: string): OperandCount {
  const scaled = splitScaling(text);
  const scale = scaled.scale;
  const aggregate = asSingleAggregate(scaled.expression);
  if (!aggregate) return { kind: "unresolved" };
  const inner = aggregate.inner.trim();

  if (aggregate.fn === "COUNT") {
    // `COUNT(*)` and `COUNT(col)` count ROWS. Neither can establish a named group, and neither is
    // interchangeable with a sum of a recorded measure.
    if (inner === "*" || BARE_COLUMN_RE.test(inner)) {
      return { kind: "total", measure: { kind: "rows", qualifiers: [] }, scale };
    }
    return { kind: "unresolved" };
  }

  // SUM / TOTAL over a plain column is the matching total OF THAT MEASURE.
  if (BARE_COLUMN_RE.test(inner)) {
    const parts = inner.split(".").map((x) => x.trim().toLowerCase());
    const column = parts[parts.length - 1];
    const qualifier = parts.length > 1 ? parts[0] : null;
    return { kind: "total", measure: { kind: "column", qualifier, column }, scale };
  }

  const conditional = inner.match(
    /^CASE\s+WHEN\s+([\s\S]+?)\s+THEN\s+([\s\S]+?)\s+ELSE\s+([\s\S]+?)\s+END$/i
  );
  if (!conditional) return { kind: "unresolved" };
  const [, predicate, matched, unmatched] = conditional;

  // Non-matching rows must contribute nothing. `THEN 0 ELSE 1` counts the opposite set, and that is
  // exactly the construction that borrowed a value's meaning while counting its complement.
  if (!/^0(?:\.0*)?$/.test(unmatched.trim())) return { kind: "unresolved" };

  // Matching rows contribute one row, or the recorded measure for the approved offender-share shape.
  const contribution = matched.trim();
  let measure: MeasuredQuantity;
  if (/^1(?:\.0*)?$/.test(contribution)) {
    // NOT the predicate's qualifier. The predicate says what is FILTERED, not what is COUNTED:
    // GC-034 filters on `incidents.relationship` while counting join rows that are victims, and
    // binding row meaning to the filter's table refused that approved positive. Row grain belongs
    // to the statement, so it resolves against the base tables in `resolveMeasure`.
    measure = { kind: "rows", qualifiers: [] };
  } else if (BARE_COLUMN_RE.test(contribution)) {
    const parts = contribution.split(".").map((x) => x.trim().toLowerCase());
    measure = { kind: "column", qualifier: parts.length > 1 ? parts[0] : null, column: parts[parts.length - 1] };
  } else return { kind: "unresolved" };

  const values = selectedValues(predicate);
  if (values === null) return { kind: "unresolved" };
  return { kind: "subset", values, measure, scale };
}

/** Is `numerator / denominator` evaluated as a real division in SQLite? (see G32-1 above) */
function divisionIsReal(numerator: string, denominator: string): boolean {
  let s = numerator.trim();
  while (s.startsWith("(") && s.endsWith(")") && parenSpansWhole(s)) s = s.slice(1, -1).trim();
  const REAL_LITERAL = /^[-+]?(?:\d+\.\d*|\.\d+|\d+(?:\.\d*)?[eE][-+]?\d+)$/;
  if (splitTopLevel(s, "*").some((factor) => REAL_LITERAL.test(factor.trim()))) return true;
  const total = (text: string) => asSingleAggregate(splitScaling(text).expression)?.fn === "TOTAL";
  return total(numerator) || total(denominator);
}

function requestedOperandsEstablished(
  sql: string, question: string, baseTables: string[], source: QueryContractSource
): boolean {
  const selectList = outerSelectList(sql);
  if (selectList === null) return false;
  const requested = describeRequestedComparison(question);
  const aliases = outerSourceAliases(sql);

  for (const rawItem of splitTopLevel(selectList, ",")) {
    const operands = divisionOperands(withoutTrailingAlias(rawItem));
    if (!operands) continue;

    const numerator = describeOperand(operands.numerator);
    const denominator = describeOperand(operands.denominator);

    // NO SKIP PATH. The previous version skipped role checking whenever the numerator named no
    // values and used no conditional, which is how `COUNT(*) / COUNT(*)` established neither
    // requested subset. I had claimed other checks governed that case; the full-validator result
    // showed they did not. Every division must now resolve on both sides.
    if (requested.form === "unresolved") return false;
    if (numerator.kind === "unresolved" || denominator.kind === "unresolved") return false;

    // MATCHING QUANTITIES. Both sides must count the SAME measure, or the division compares unlike
    // things: recorded offenders over summary ROWS is not a share of anything.
    // RESOLVE BOTH SIDES FIRST, then compare the identities. Order matters: comparing raw
    // references before resolution is what refused `offender_count / d.offender_count`.
    const resolvedNumerator = resolveMeasure(numerator.measure, aliases, baseTables, source);
    const resolvedDenominator = resolveMeasure(denominator.measure, aliases, baseTables, source);
    if (!resolvedNumerator || !resolvedDenominator) return false;

    // Agreement establishes that two quantities are alike, never that either is the requested one —
    // which is why resolution above is against the source, not against each other.
    if (!sameResolvedMeasure(resolvedNumerator, resolvedDenominator)) return false;

    // RESULT FORM. The retained scale must match what the request asks to produce. A percentage
    // conversion is 100; an ordered ratio is unscaled. A `pct_` label cannot authorise a different
    // multiplier, and 200 sits inside any plausible range so no range test would catch it.
    // Only the numerator carries a scale in the supported shapes; a scaled divisor is unresolved.
    if (denominator.scale !== 1) return false;

    // NON-TRUNCATING ARITHMETIC (Codex G32-1). SUM and COUNT of integer columns are integers, and
    // SQLite divides two integers as integers: `100 * 1260 / 15060` is 8, not 8.37. The scale above is
    // the same number for `100` and `100.0`, so it cannot tell them apart. The division must be proved
    // real: a decimal literal factor on the numerator side (applied before the division, since the
    // numerator is everything left of the last top-level `/`) or a TOTAL(), which is always real.
    if (!divisionIsReal(operands.numerator, operands.denominator)) return false;

    if (requested.form === "ordered") {
      // "A to B" needs a KNOWN SUBSET on each side, in the requested order. A total on either side
      // cannot establish a named group.
      if (numerator.scale !== 1) return false;
      if (numerator.kind !== "subset" || !namedIn(numerator.values, requested.numeratorPhrase)) return false;
      if (denominator.kind !== "subset" || !namedIn(denominator.values, requested.denominatorPhrase)) return false;
      continue;
    }

    // A share is a known subset over the matching total. "percentage" must convert by 100; "share"
    // and "proportion" may be delivered either as a percentage or as a fraction, and the delivered
    // text names which. Anything else is not the requested result form.
    const permittedScales = requested.form === "percentage" ? [100] : [1, 100];
    if (!permittedScales.includes(numerator.scale)) return false;
    if (numerator.kind !== "subset" || !namedIn(numerator.values, question)) return false;
    if (denominator.kind !== "total") return false;
  }
  return true;
}

function shareIsComputed(item: SelectItem, source: QueryContractSource): boolean {
  // No top-level division: whatever this expression is, it is not a computed share.
  if (item.denominatorRefs === null || item.denominatorRaw === null) return false;

  // The numerator must itself measure something. `resolved` false means part of the expression
  // could not be traced, and an untraceable share is not a proved one.
  if (!item.resolved) return false;

  // The numerator has to measure something. A share of nothing is not a share.
  if (item.refs.length === 0 && !item.countsRows) return false;

  // The DIVISOR must be exactly one aggregate, with no arithmetic wrapped around it. This is what
  // separates `COUNT(*)` from `COUNT(*) * 2.0`, which a substring test could not.
  const divisor = asSingleAggregate(item.denominatorRaw);
  if (!divisor) return false;

  // A row count over the set the numerator was selected from is the total a share is taken of.
  if (divisor.fn === "COUNT") return true;

  // SUM/TOTAL must add up a MEASURE, on a table that holds measures. This rules out, without
  // naming any table:
  //   - a population or identity column (`AVG(i.population)`, and `incidents` IS a metric table,
  //     so a table-role check alone accepted it);
  //   - `SUM(1)` and other ref-less sums, which are not the total either.
  if (item.denominatorRefs.length === 0) return false;
  return item.denominatorRefs.every((ref) => {
    if (DIMENSION_COLUMNS.has(ref.column)) return false;
    const entry = ref.table ? tableSemantics(source, ref.table) : null;
    return Boolean(entry && entry.role === "metric");
  });
}

/**
 * Is the RATIO the answer this statement returns, rather than something a helper column happens to
 * contain?
 *
 * WHY THE CALLER NEEDED THIS TOO. Binding the proof to one expression was necessary but not
 * sufficient: the caller still waived the requirement whenever ANY returned expression was a valid
 * share. So a raw count aliased `pct_male` shipped as the answer while a genuine female percentage
 * sat beside it in a helper column (review 2026-09-08 §3).
 *
 * WHY OPERAND MEMBERSHIP DOES NOT WORK, measured rather than assumed. `sql-lineage` strips quoted
 * literals before analysis, so `SUM(CASE WHEN v.sex = 'Male' …)` and the female equivalent reduce to
 * the SAME text. Comparing a supporting count against the share's expression therefore cannot tell a
 * genuine operand from an unrelated one. It also fails in the other direction: GC-034 legitimately
 * returns a complementary "known relationship" count that is not an operand of its percentage, so an
 * operand rule rejects a positive that must stay answerable.
 *
 * THE RULE, which uses only what is establishable. At least one returned series must be a proved
 * share, and no returned series may CLAIM to be a share while computing a bare count. Supporting
 * counts stay permitted -- GC-032 returns its numerator and denominator, GC-034 also returns the
 * complement -- because they do not claim to be the ratio. The alias is used solely to detect a
 * false label, never to authorise a calculation.
 */
function ratioIsTheAnswer(
  factual: SelectItem[], source: QueryContractSource, sql: string, question: string,
  baseTables: string[]
): boolean {
  const shares = factual.filter((item) => shareIsComputed(item, source));
  if (shares.length === 0) return false;

  // THE DECIDING CHECK: the values being compared must be the ones the question asked about. This
  // is what refuses a female share for a male question, and it is unaffected by any column name.
  if (!requestedOperandsEstablished(sql, question, baseTables, source)) return false;

  // Supplementary: a series that names itself a percentage must have computed one. Kept because a
  // false label is itself a defect, but it is no longer what distinguishes acceptance.
  const mislabelled = factual.some(
    (item) => !shares.includes(item) && item.alias !== null && RATIO_ALIAS_RE.test(item.alias)
  );
  return !mislabelled;
}

/**
 * GC-032's retained statement computes its share from two one-row CTEs:
 *
 *   WITH y AS (SELECT SUM(d.m) AS a FROM t d WHERE <scope> AND <subset>),
 *        z AS (SELECT SUM(d.m) AS b FROM t d WHERE <scope>)
 *   SELECT 100.0 * y.a / z.b ... FROM y, z
 *
 * That is the same number as the approved single-SELECT share
 *
 *   SELECT 100.0 * SUM(CASE WHEN <subset> THEN d.m ELSE 0 END) / SUM(d.m) FROM t d WHERE <scope>
 *
 * when, and only when: both CTEs read the same table and the same measure with the same aggregate;
 * each returns exactly one row (one aggregate, no GROUP BY/HAVING/JOIN/LIMIT/OR/subquery); their
 * filters are identical except for ONE extra conjunct on one side; and the outer query only
 * cross-joins the two and reads nothing but their two outputs. This returns that single-SELECT
 * statement so the EXISTING share proof judges it -- subset named in the question, matching total,
 * matching measure, permitted scale. Anything else returns null and gets no allowance.
 *
 * It proves an equivalence for the checker only; the statement that runs is unchanged. It is not the
 * CTE-decomposition change (2026-09-22): no `SelectItem` field becomes CTE-transitive, and a share
 * computed INSIDE a CTE and projected out is still not recognized.
 */
function twoCteShareEquivalent(sql: string): string | null {
  const text = stripSqlComments(sql).trim().replace(/;\s*$/, "");
  const split = splitCtes(text);
  if (!split || split.ctes.length !== 2) return null;

  const lowerOutsideLiterals = (s: string) =>
    s.replace(/'(?:''|[^'])*'|[^']+/g, (part) => (part.startsWith("'") ? part : part.toLowerCase()));
  const withoutLiterals = (s: string) => s.replace(/'(?:''|[^'])*'/g, "''");
  const BODY = /^\s*SELECT\s+(SUM|TOTAL)\s*\(\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\)\s+AS\s+([A-Za-z_]\w*)\s+FROM\s+((?:[A-Za-z_]\w*\s*\.\s*)?[A-Za-z_]\w*)\s+(?:AS\s+)?(?!WHERE\b)([A-Za-z_]\w*)\s+WHERE\s+([\s\S]+?)\s*$/i;

  const bodies = split.ctes.map((cte) => {
    const m = BODY.exec(cte.body);
    if (!m) return null;
    const [, fn, qualifier, measure, output, table, alias, where] = m;
    if (qualifier.toLowerCase() !== alias.toLowerCase()) return null;
    const bare = withoutLiterals(where);
    if (/\b(?:GROUP|HAVING|ORDER|LIMIT|UNION|INTERSECT|EXCEPT|JOIN|WINDOW|SELECT|OR)\b/i.test(bare)) return null;
    // Every qualified name in the filter must be this CTE's own alias.
    for (const ref of bare.matchAll(/\b([A-Za-z_]\w*)\s*\.\s*[A-Za-z_]\w*/g)) {
      if (ref[1].toLowerCase() !== alias.toLowerCase()) return null;
    }
    // Top-level AND, keeping `BETWEEN x AND y` whole.
    const parts: string[] = [];
    let depth = 0; let start = 0;
    for (const tok of where.matchAll(/'(?:''|[^'])*'|[()]|\bAND\b/gi)) {
      if (tok[0] === "(") depth++;
      else if (tok[0] === ")") depth--;
      else if (depth === 0 && /^AND$/i.test(tok[0])) {
        const piece = where.slice(start, tok.index);
        if (/\bBETWEEN\s+\S+\s*$/i.test(withoutLiterals(piece))) continue;
        parts.push(piece); start = (tok.index ?? 0) + tok[0].length;
      }
    }
    parts.push(where.slice(start));
    const aliasRe = new RegExp(`\\b${alias}\\s*\\.\\s*`, "gi");
    const conjuncts = parts.map((p) => p.trim()).filter(Boolean);
    const normal = conjuncts.map((c) => lowerOutsideLiterals(c.replace(aliasRe, "@.")).replace(/\s+/g, " "));
    if (new Set(normal).size !== normal.length) return null;
    return { name: cte.name.toLowerCase(), fn: fn.toUpperCase(), measure: measure.toLowerCase(), output: output.toLowerCase(),
      table: table.replace(/\s+/g, "").toLowerCase(), alias, where, conjuncts, normal };
  });
  const [a, b] = bodies;
  if (!a || !b || a.table !== b.table || a.fn !== b.fn || a.measure !== b.measure) return null;

  // Which one is the subset: exactly one extra conjunct, everything else identical.
  const extraIn = (x: typeof a, y: typeof a) =>
    x!.normal.length === y!.normal.length + 1 && y!.normal.every((c) => x!.normal.includes(c))
      ? x!.conjuncts[x!.normal.findIndex((c) => !y!.normal.includes(c))] : null;
  const subset = extraIn(a, b) !== null ? a : extraIn(b, a) !== null ? b : null;
  if (!subset) return null;
  const total = subset === a ? b : a;
  const predicate = (extraIn(subset, total) as string).replace(new RegExp(`\\b${subset.alias}\\s*\\.`, "gi"), `${total.alias}.`);

  // The outer query: a cross join of exactly these two CTEs, reading only their outputs.
  const OUTER = /^\s*SELECT\s+([\s\S]+?)\s+FROM\s+([A-Za-z_]\w*)(?:\s+(?:AS\s+)?(?!(?:CROSS|INNER|JOIN|ON)\b)([A-Za-z_]\w*))?\s*(?:,|\bCROSS\s+JOIN\b|\b(?:INNER\s+)?JOIN\b)\s*([A-Za-z_]\w*)(?:\s+(?:AS\s+)?(?!ON\b)([A-Za-z_]\w*))?(?:\s+ON\s+1\s*=\s*1)?(?:\s+LIMIT\s+([1-9]\d*))?\s*$/i;
  // The trailing LIMIT is the one the route appends (`LIMIT 1000`); on a one-row cross join any
  // positive limit returns the same row.
  const o = OUTER.exec(split.outer);
  if (!o) return null;
  const refs = new Map<string, typeof a>();
  for (const [name, alias] of [[o[2], o[3]], [o[4], o[5]]]) {
    const body = bodies.find((x) => x!.name === name.toLowerCase());
    if (!body) return null;
    refs.set((alias ?? name).toLowerCase(), body);
  }
  if (new Set([...refs.values()]).size !== 2) return null;

  let failed = false;
  const select = o[1].replace(/\b([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\b/g, (whole, q: string, col: string) => {
    const body = refs.get(q.toLowerCase());
    if (!body || body.output !== col.toLowerCase()) { failed = true; return whole; }
    return body === subset
      ? `${body.fn}(CASE WHEN ${predicate} THEN ${total.alias}.${body.measure} ELSE 0 END)`
      : `${body.fn}(${total.alias}.${body.measure})`;
  });
  if (failed) return null;
  // No bare reference to a CTE output or name may remain.
  const leftover = withoutLiterals(select).toLowerCase();
  for (const word of [a.output, b.output, a.name, b.name]) {
    if (new RegExp(`(?<![\\w.])${word}(?![\\w])`).test(leftover.replace(/\bas\s+[a-z_]\w*/g, ""))) return null;
  }
  return `SELECT ${select} FROM ${total.table} ${total.alias} WHERE ${total.where}`;
}

/** Is the two-CTE share (see `twoCteShareEquivalent`) the answer, judged by the existing share proof? */
function twoCteShareIsTheAnswer(sql: string, source: QueryContractSource, question: string): boolean {
  const equivalent = twoCteShareEquivalent(sql);
  if (!equivalent) return false;
  const lineage = analyzeSql(equivalent);
  if (!lineage.parsed || lineage.unsupportedShape) return false;
  return ratioIsTheAnswer(lineage.items.filter(isFactualSeries), source, equivalent, question, lineage.baseTables);
}

/** Does this expression's division bind a population valid at the requested level? */
function denominatorApproved(
  item: SelectItem, scope: RequestedScope, source: QueryContractSource
): boolean {
  if (item.denominatorRefs === null) return false;
  return item.denominatorRefs.some((ref) => {
    const entry = ref.table ? tableSemantics(source, ref.table) : null;
    return Boolean(entry && (entry.denominatorLevels ?? []).includes(scope.rowLevel));
  });
}

export function evaluateStructuralSemantics(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  sql: string;
}): StructuralFinding[] {
  const scope = requestedScope(opts.question, opts.contract);
  const lineage = analyzeSql(opts.sql);
  const findings: StructuralFinding[] = [];
  const canBeFixed = repairable(scope, opts.source);
  const add = (
    ruleId: string, severity: StructuralSeverity, message: string, series: string | null,
    selfContainedInstruction = false
  ) => {
    findings.push({ ruleId, severity, message, requestedLevel: scope.rowLevel, series, selfContainedInstruction });
  };

  /*
   * RETIRED: `structural-unrequested-eligibility-floor` no longer fires here.
   *
   * It tried to decide, from the request text and the model's SQL, whether an eligibility threshold
   * had been asked for. That premise failed on a quantity it could not see: "at least 100
   * shoplifting offenses" and a floor of `rate_per_100k >= 100` share the source column, the crime
   * noun and the numeral, so the checker authorized a rate floor the request never mentioned and a
   * city with 200 offenses vanished from its own ranking.
   *
   * City rankings are now CONSTRUCTED from a declared request instead (lib/city-ranking.ts), where
   * the eligibility quantity and the sort quantity are separate typed fields and an unrequested
   * floor has nothing to originate from. The matcher's module is retained for its helpers and its
   * record; what is withdrawn is its enforcement.
   *
   * BEHAVIOUR THIS REMOVES: model-written rankings outside the constructed family no longer receive
   * an eligibility retry. They did not have a sound one -- it accepted a rate floor for a count
   * request -- but they now have none at all, and that is stated rather than implied.
   * BEHAVIOUR THIS KEEPS: the truthful, family-gated limit sentence in lib/result-disclosure.ts.
   */

  if (lineage.unsupportedShape) {
    add("structural-unsupported-sql-shape", "retry",
      `This query is ${lineage.unsupportedShape}, and only its first branch can be traced. Each ` +
      "returned series has to be checked against the request, so write it as a single SELECT over " +
      "the supported tables.", null);
    return findings;
  }

  if (!lineage.parsed) {
    add("structural-returned-series-unresolved", "retry",
      "The returned columns could not be traced to their source tables, so nothing proves this " +
      "query answers the question asked. Rewrite it as a plain SELECT over the supported tables.",
      null);
    return findings;
  }

  const factual = lineage.items.filter(isFactualSeries);
  if (factual.length === 0) return findings;

  // Every offense the question asked for, not just the first.
  const requestedTopics = opts.contract.metric.offenses.length > 0
    ? opts.contract.metric.offenses.map((offense) => offense.topic)
    : [scope.topic];

  for (const finding of monthlyRowsNotAggregated(opts.sql, opts.source)) {
    add("structural-monthly-rows-not-aggregated", "retry", finding.message, finding.series);
  }

  const licensed = licensedLevels(opts.question);
  const someSeriesServesRequestedLevel = factual.some((item) => {
    const tables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
    return tables.some((table) => {
      const entry = table ? tableSemantics(opts.source, table) : null;
      return Boolean(entry && entry.role === "metric" && producesLevel(entry, scope.rowLevel));
    });
  });

  for (const item of factual) {
    const label = item.alias ?? item.raw.slice(0, 40);

    if (item.hasWildcard) {
      add("structural-wildcard-projection", "retry",
        `"${label}" selects every column, so nothing states which measure is being returned or ` +
        "whether it matches the request. Name the columns the answer needs.", label);
      continue;
    }

    const narrowed = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : [];
    if (!item.resolved || narrowed.includes(null)) {
      add("structural-returned-series-unresolved", "retry",
        `The returned value "${label}" could not be traced to a source table, so nothing proves it ` +
        "measures what was asked for. Qualify each column with its table.", label);
      continue;
    }

    // COUNT(*) with no column refs takes its meaning from the FROM clause.
    const refTables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
    const entries: TableSemantics[] = [];
    let sawUnknown = false;
    for (const table of refTables) {
      if (!table) { sawUnknown = true; continue; }
      const entry = tableSemantics(opts.source, table);
      if (!entry) {
        sawUnknown = true;
        add("structural-uncatalogued-factual-source", "retry",
          `"${label}" is read from \`${table}\`, whose meaning is not established for this source. ` +
          "An unverified table cannot authorise a factual answer. Use a supported table, or say " +
          "plainly that this cannot be answered.", label);
        continue;
      }
      entries.push(entry);
    }
    if (sawUnknown || entries.length === 0) continue;

    // The annual-aggregation rule is scope-aware and runs once per statement, below.

    // A directory referenced next to a metric table is a filter or a label -- deterministic plans
    // legitimately write SUM(CASE WHEN ha.agency = 'Baltimore' THEN hac.murder END). It is only a
    // defect when the measure has NO metric source at all.
    const hasMetricSource = entries.some((entry) => entry.role === "metric");
    // A number with no column lineage can only be checked against what one ROW means. Being a
    // metric table is not enough: `historical_agency_crime` is one agency-year per row, so
    // `COUNT(*) AS murders` counts agency-years. SHR `incidents` is one homicide per row, so there
    // it is a real murder count -- and the catalog is what distinguishes them.
    if (isRowCount(item)) {
      const metricEntries = entries.filter((entry) => entry.role === "metric");
      const topicLicensed = metricEntries.filter((entry) =>
        (entry.eventRow?.topics ?? []).some((topic) =>
          requestedTopics.includes(topic) || requestedTopics.includes("unknown")));

      if (metricEntries.length > 0 && topicLicensed.length === 0) {
        add("structural-row-count-not-a-measure", "retry",
          `"${label}" is a row count, and one row of ` +
          `${metricEntries.map((e) => `\`${e.table}\``).join(", ")} is not one ` +
          `${requestedTopics.join(" or ")}. Select the column that holds the measure.`, label);
        continue;
      }
      // A licence can be conditional. SHR victims are one row per HOMICIDE victim, so the count is
      // a MURDER count only with the product's own join and predicate.
      if (topicLicensed.length > 0 && !topicLicensed.some((entry) => requiredFiltersPresent(entry, opts.sql).ok)) {
        const missing = [...new Set(topicLicensed.flatMap((entry) => requiredFiltersPresent(entry, opts.sql).missing))];
        add("structural-row-count-unqualified", "retry",
          `"${label}" counts rows of ${topicLicensed.map((e) => `\`${e.table}\``).join(", ")}, which is ` +
          `one row per occurrence only when ${missing.join(" and ")} is applied. Without it the count ` +
          "includes occurrences the question did not ask for.", label);
        continue;
      }
    }

    for (const entry of entries) {
      if (!hasMetricSource &&
          (entry.role === "identity" || entry.role === "crosswalk" || entry.role === "support")) {
        add("structural-non-factual-source", "retry",
          `"${label}" is measured from \`${entry.table}\`, which is a ${entry.role} table and holds ` +
          "no offense counts. Counting its rows answers a different question.", label);
        continue;
      }
      if (entry.role !== "metric") continue;

      // --- geography ---------------------------------------------------------------------
      const licensedHere = someSeriesServesRequestedLevel &&
        licensed.some((level) => producesLevel(entry, level));
      if (scope.rowLevel !== "unknown" && !producesLevel(entry, scope.rowLevel) && !licensedHere) {
        add("structural-row-level-substitution", canBeFixed ? "retry" : "block",
          `"${label}" is ${scope.rowLevel}-level in the request (${scope.evidence}) but comes from ` +
          `\`${entry.table}\`, which produces ${entry.outputLevels.join("/") || "no"}-level rows. ` +
          (canBeFixed
            ? "Use a table that can represent the requested place."
            : `No table in this source carries this measure at ${scope.rowLevel} level, so this ` +
              "cannot be rewritten -- say so plainly instead."),
          label);
      }

      // --- aggregating a measure whose components are gone -------------------------------
      if (entry.components === "absent" && entry.aggregation === "not-aggregatable" &&
          scope.rowLevel !== "unknown" && !entry.outputLevels.includes(scope.rowLevel)) {
        add("structural-clearance-not-aggregatable", "block",
          `\`${entry.table}\` stores ${entry.rowKey}-level values without the components needed to ` +
          `re-derive them, so they cannot be combined into a ${scope.rowLevel}-level figure. ` +
          "Report it at a level the table supports, or decline.", label);
      }

      // --- offense ------------------------------------------------------------------------
      // Enforced only where the selected COLUMN is itself the claim. Code and value predicates
      // (NIBRS `ucr_offense_code`, Current Trends `offense`) are left to the existing offense-code
      // validation rather than duplicated into a second vocabulary here.
      // MEMBERSHIP: is any selected column a DIFFERENT offense from the ones requested?
      // The unit is part of the measure: `murder_rate` does not answer "how many murders", and
      // `murder` does not answer "what is the murder rate" unless a denominator is bound.
      const expected = [...new Set(
        requestedTopics.flatMap((topic) => topicColumns(entry, topic, scope.unit) ?? [])
      )];
      if (expected.length > 0) {
        const everyTopicColumn = allTopicColumns(entry);
        const foreign = item.refs
          .filter((ref) => ref.table === entry.table && everyTopicColumn.has(ref.column))
          .map((ref) => ref.column)
          .filter((column) => !expected.includes(column));
        if (foreign.length > 0) {
          add("structural-measure-substitution", "retry",
            `"${label}" selects ${foreign.map((c) => `\`${c}\``).join(", ")} from ` +
            `\`${entry.table}\`, but the question asks about ${requestedTopics.join(" and ")} ` +
            `measured as ${scope.unit}. Select the requested measure; do not relabel a different one.`, label);
        }
      }
      if (entry.measureBinding.kind === "fixed_topics" && scope.topic !== "unknown" &&
          !entry.measureBinding.topics.includes(scope.topic)) {
        add("structural-measure-unavailable", canBeFixed ? "retry" : "block",
          `\`${entry.table}\` only holds ${entry.measureBinding.topics.join(", ")}, but the question ` +
          `asks about ${scope.topic}.`, label);
      }

      // --- time grain ---------------------------------------------------------------------
      if (scope.grain && !entry.timeGrains.includes(scope.grain)) {
        add("structural-time-grain-unavailable", canBeFixed ? "retry" : "block",
          `${scope.grain} figures were requested, but \`${entry.table}\` carries ` +
          `${entry.timeGrains.join("/")} data.`, label);
      }
    }

    // --- rate denominator, traced rather than assumed --------------------------------------
    if (scope.unit === "rate_per_100k" && scope.rowLevel !== "unknown" && item.denominatorRefs !== null) {
      const denominatorTables = tablesOf(item.denominatorRefs, opts.source)
        .map((table) => (table ? tableSemantics(opts.source, table) : null));
      const approved = denominatorTables.some(
        (entry) => entry && (entry.denominatorLevels ?? []).includes(scope.rowLevel)
      );
      if (!approved) {
        const named = item.denominatorRefs.map((ref) => `${ref.table ?? "?"}.${ref.column}`).join(", ");
        add("structural-rate-denominator-unbound", "retry",
          `The rate "${label}" divides by ${named || "an expression that could not be traced"}, which ` +
          `is not a population valid at ${scope.rowLevel} level. Joining a population table is not ` +
          "enough -- the division itself has to use it.", label);
      }
    } else if (scope.unit === "rate_per_100k" && scope.rowLevel !== "unknown" &&
               item.countsRows && item.refs.length === 0) {
      add("structural-rate-denominator-unbound", "retry",
        `The rate "${label}" has no denominator expression at all.`, label);
    }
  }

  // ---- COMPLETENESS ---------------------------------------------------------------------------
  // Each requested topic is looked for across all returned expressions, but a composite must be
  // satisfied WITHIN ONE expression. Pooling columns across unrelated series meant
  // `SELECT murder, rape, robbery, assault` -- four separate offense series -- counted as a violent
  // crime total, which it is not. A multi-offense request may still use one expression per offense.
  // Derived with the SAME rule the item loop uses: column lineage where there is any, otherwise the
  // statement's base tables. Populating this from column references alone meant `COUNT(*)` -- which
  // has no refs -- contributed no table at all, so a bare row count escaped every check below.
  const tablesInPlay = new Set<string>();
  for (const item of factual) {
    const tables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
    for (const table of tables) if (table) tablesInPlay.add(table);
  }

  const resolvedUnit = resolveUnit(scope.unit);

  for (const table of tablesInPlay) {
    const entry = tableSemantics(opts.source, table);
    if (!entry || entry.role !== "metric") continue;

    // A unit the catalog does not model cannot be satisfied by another unit's columns, and that is
    // true of EVERY factual source -- not only the ones whose offenses happen to be expressed as
    // columns. Checking it after the `topic_columns` branch left Current Trends, SHR and NIBRS
    // answering "what share" with a raw count.
    if (resolvedUnit.kind === "unmodeled") {
      // A share the statement actually computes is answerable, even though no table models a
      // ratio COLUMN. Narrow on purpose: a division whose denominator traces to a metric table
      // here. Counts side by side still fall through and are still refused below.
      // Bound to a RETURNED EXPRESSION, and the proof is the DENOMINATOR'S MEANING rather than
      // "a division exists somewhere". That is what rejects a decorative `COUNT(*) / 1.0` helper
      // trying to authorise a raw count aliased `pct_male` (review 2026-09-08, R1).
      //
      // NOT bound to the table this loop is on. A share over a join computes once -- GC-033's
      // `SUM(CASE WHEN v.sex...) / COUNT(*)` references `victims` only -- while `tablesInPlay`
      // also holds `incidents`. Requiring each table to carry its own share rejected valid joined
      // shares, which is how an over-strict first attempt at this fix broke GC-033 and GC-034.
      if (resolvedUnit.unit === "ratio" &&
          (ratioIsTheAnswer(factual, opts.source, opts.sql, opts.question, lineage.baseTables)
            || twoCteShareIsTheAnswer(opts.sql, opts.source, opts.question))) {
        continue;
      }
      add("structural-measure-unit-unmodeled", "retry",
        `The question asks for a ${resolvedUnit.unit}, and \`${table}\` does not model one -- a ` +
        "share needs a numerator and a denominator, and neither is established here. Return the " +
        "underlying counts, or say plainly that this cannot be computed.", null);
      continue;
    }
    if (resolvedUnit.kind === "unspecified") continue;

    // Topic/unit completeness is specific to tables that express offenses as columns.
    if (entry.measureBinding.kind !== "topic_columns") continue;

    // Run whenever a factual series is attributed to this table -- not only when it happens to
    // select a topic column. Gating on "a topic column was selected" meant `COUNT(*) AS murders`
    // and `SELECT 5 AS murders` exited before completeness could object to them.
    const attributed = factual.some((item) => {
      const tables = item.refs.length > 0 ? tablesOf(item.refs, opts.source) : lineage.baseTables;
      return tables.includes(table);
    });
    if (!attributed) continue;

    for (const topic of requestedTopics) {
      if (!topicIsKnown(entry, topic)) continue;
      const requirement = topicUnitRequirement(entry, topic, scope.unit);
      if (!requirement) {
        add("structural-measure-unavailable", canBeFixed ? "retry" : "block",
          `\`${table}\` does not express ${topic} as ${scope.unit}.`, null);
        continue;
      }

      const satisfiedBySome = factual.some((item) => {
        // A row count satisfies the topic only where one row IS one occurrence of it.
        if (isRowCount(item)) {
          return (entry.eventRow?.topics ?? []).includes(topic)
            && requiredFiltersPresent(entry, opts.sql).ok;
        }
        const columns = new Set(
          item.refs.filter((ref) => ref.table === table).map((ref) => ref.column));
        if (requirement.direct && requirementSatisfied(requirement.direct, columns)) return true;
        // Counts can produce a rate only when the division binds an approved denominator.
        return Boolean(requirement.derivedFrom
          && requirementSatisfied(requirement.derivedFrom, columns)
          && denominatorApproved(item, scope, opts.source));
      });
      if (satisfiedBySome) continue;

      const describe = (req: typeof requirement.direct) =>
        req ? requirementColumns(req).map((c) => `\`${c}\``).join(" and ") : null;
      const wanted = [describe(requirement.direct), describe(requirement.derivedFrom)]
        .filter(Boolean).join(", or derived from ");
      add("structural-measure-incomplete", "retry",
        `The question asks for ${topic} as ${scope.unit}, which \`${table}\` expresses as ` +
        `${wanted || "no supported column"}. No single returned expression provides it. A component ` +
        "is not the total, and separate offense series are not a combined measure.", null);
    }
  }

  return findings;
}

export function catalogCoverage(source: QueryContractSource): {
  tables: number; metric: number; withAbsentComponents: number;
} {
  const entries = catalogedTables(source);
  return {
    tables: entries.length,
    metric: entries.filter((entry) => entry.role === "metric").length,
    withAbsentComponents: entries.filter((entry) => entry.components === "absent").length,
  };
}
