/**
 * Where does each returned value actually come from?
 *
 * The first version of increment C asked "is a compatible table mentioned anywhere in this SQL?".
 * That is the same defect the county-ORI validator had to fix twice: a literal appearing somewhere
 * is not proof that the returned rows are restricted by it. Reproduced against `89c331b`:
 *
 *     SELECT i.year, COUNT(*) * 100000.0 / i.population AS rate
 *     FROM incidents i
 *     JOIN state_population sp ON sp.state = i.state AND sp.year = i.year
 *     WHERE i.state = 'CA'
 *
 * `state_population` is joined and entirely decorative. The rate still divides by the per-agency
 * `incidents.population`. The old check saw an approved denominator table and passed it.
 *
 * So this resolves each returned expression to the base tables its columns actually come from, and
 * for a division it does the same for the denominator side specifically.
 *
 * It is deliberately conservative. This is not a SQL parser and does not try to be: anything it
 * cannot resolve is reported as unresolved, and the caller must fail closed rather than assume the
 * query is safe. A shape we cannot prove is not a shape we may execute.
 */

/**
 * A CTE built from `VALUES (...)` or a `SELECT` with no `FROM` reads no table at all. The SHR
 * deterministic murder plan uses several -- `targets(city, ori, ...) AS (VALUES ('Oakland, CA', ...))`.
 * Columns drawn from one are literals the query supplied itself, so they are neither a factual
 * source nor an unresolved reference. Treating them as unresolved failed four real plans closed.
 */
export const LITERAL_SOURCE = "(values)";

export type ColumnRef = {
  /** The base table this column resolves to, or null when it could not be resolved. */
  table: string | null;
  column: string;
  /**
   * When a column comes through a CTE that reads several base tables, we know the shortlist even
   * though we cannot pick one. The caller narrows it by role -- a CTE joining a metric table to a
   * directory has exactly one table the measure can have come from. Without this, every real
   * multi-table CTE was reported unresolved and would have failed closed.
   */
  candidates?: string[];
};

export type SelectItem = {
  alias: string | null;
  raw: string;
  /** Every column reference in the expression, resolved to base tables where possible. */
  refs: ColumnRef[];
  /** Refs on the right-hand side of a top-level division, or null when there is no division. */
  denominatorRefs: ColumnRef[] | null;
  /** COUNT(*) and friends contribute a row count rather than a named column. */
  countsRows: boolean;
  /**
   * An answer-bearing number with no column lineage at all: `COUNT(*)`, `SUM(1)`, a bare constant.
   * It claims to be a measure while referencing nothing, so it can only be checked against what the
   * catalog says one ROW of the table means. Previously a non-COUNT case here was classified as
   * carrying no measurement and skipped entirely.
   */
  numericWithoutColumns: boolean;
  /**
   * `SELECT *` or `SELECT alias.*`. The columns are whatever the table happens to hold, so nothing
   * here can be checked against the request -- and an unchecked projection previously produced no
   * column references at all, was classified as carrying no measurement, and passed.
   */
  hasWildcard: boolean;
  /** False when any part of the expression could not be traced. */
  resolved: boolean;
};

export type SqlLineage = {
  /** False when the statement shape defeated the analyzer. Callers must fail closed. */
  parsed: boolean;
  /**
   * A shape this analyzer does not support well enough to authorise an answer. Naming it lets the
   * caller say which shape rather than emitting a generic refusal -- and makes the limitation
   * visible instead of silently permissive.
   */
  unsupportedShape: string | null;
  items: SelectItem[];
  /** Every base table reachable from the outer query, including through CTEs. */
  baseTables: string[];
};

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "group", "by", "order", "having", "limit", "offset", "as", "on",
  "join", "left", "right", "inner", "outer", "full", "cross", "union", "all", "distinct", "and",
  "or", "not", "in", "is", "null", "case", "when", "then", "else", "end", "asc", "desc", "with",
  "recursive", "between", "like", "exists", "cast", "over", "partition", "using", "nulls", "first",
  "last", "filter", "within", "collate", "escape", "glob", "regexp", "match",
]);

/** Replace comments and string literals with blanks so they cannot be mistaken for identifiers. */
function scrub(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === "--") {
      const end = sql.indexOf("\n", i);
      const stop = end === -1 ? sql.length : end;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      out += " ".repeat(stop - i);
      i = stop;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) { j += 2; continue; }
        if (sql[j] === ch) { j += 1; break; }
        j += 1;
      }
      // Keep double-quoted identifiers readable; blank out string literals.
      out += ch === '"' ? sql.slice(i, j) : " ".repeat(j - i);
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Index of the first match of `re` at paren depth 0, or -1. */
function findTopLevel(text: string, re: RegExp): number {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(text);
      if (m && m.index === i) return i;
    }
  }
  return -1;
}

function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * `name AS ( ... )` pairs, with their bodies and any declared column list.
 *
 * The declared list is load-bearing and was previously discarded:
 *
 *     WITH x(murders) AS (SELECT robbery FROM historical_agency_crime) SELECT x.murders FROM x
 *
 * Looking up `murders` in the body finds nothing, so the old code fell back to the CTE's single
 * base table and invented `historical_agency_crime.murders` -- a column that does not exist, and
 * one that no offense check could match. Mapping the declared names positionally onto the body's
 * select list resolves it to `robbery`, which is the truth.
 */
/**
 * Split a query at its top-level compound operators.
 *
 * Refusing every compound was correct for safety and wrong in practice: it flagged 150 of 1,605
 * sampled production queries, 140 of them legitimate -- mostly the documented NIBRS pattern of
 * combining victim summaries (person crimes) with offense summaries (everything else). Each arm
 * returns its own series, so the honest fix is to READ every arm rather than refuse the shape.
 * That is what closes the original hole too: a first arm returning murder cannot authorise a
 * second arm returning robbery, because the second arm is now checked.
 */
export function compoundArms(query: string): string[] {
  const arms: string[] = [];
  let depth = 0;
  let start = 0;
  const re = /\b(?:UNION\s+ALL|UNION|INTERSECT|EXCEPT)\b/gi;
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      re.lastIndex = i;
      const m = re.exec(query);
      if (m && m.index === i) {
        arms.push(query.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  arms.push(query.slice(start));
  return arms.map((arm) => arm.trim()).filter((arm) => arm.length > 0);
}

function extractCtes(sql: string): {
  names: Map<string, string>;
  columnLists: Map<string, string[]>;
  rest: string;
} {
  const names = new Map<string, string>();
  const columnLists = new Map<string, string[]>();
  if (!/^\s*WITH\b/i.test(sql)) return { names, columnLists, rest: sql };
  let i = sql.search(/\bWITH\b/i);
  i += sql.slice(i).match(/\bWITH\s+(?:RECURSIVE\s+)?/i)?.[0].length ?? 4;

  while (i < sql.length) {
    const header = sql.slice(i).match(/^\s*([A-Za-z_][\w]*)\s*(?:\(([^)]*)\)\s*)?AS\s*\(/i);
    if (!header) break;
    if (header[2]) {
      columnLists.set(
        header[1].toLowerCase(),
        header[2].split(",").map((part) => part.trim().toLowerCase()).filter(Boolean)
      );
    }
    const bodyStart = i + header[0].length;
    let depth = 1;
    let j = bodyStart;
    while (j < sql.length && depth > 0) {
      if (sql[j] === "(") depth += 1;
      else if (sql[j] === ")") depth -= 1;
      j += 1;
    }
    names.set(header[1].toLowerCase(), sql.slice(bodyStart, j - 1));
    i = j;
    const comma = sql.slice(i).match(/^\s*,\s*/);
    if (comma) { i += comma[0].length; continue; }
    break;
  }
  return { names, columnLists, rest: sql.slice(i) };
}

/** All `FROM`/`JOIN` sources in one query level: alias (or name) -> table name. */
function sourceAliases(query: string): Map<string, string> {
  const aliases = new Map<string, string>();
  // `rollup.national_summary_...` is one table in an ATTACHed database. Reading only the part
  // before the dot made the schema name look like the table, so a real deterministic NIBRS plan
  // resolved to nothing and would have been refused.
  const re = /\b(?:FROM|JOIN)\s+(?:([A-Za-z_][\w]*)\s*\.\s*)?([A-Za-z_][\w]*)\s*(?:(?:AS\s+)?([A-Za-z_][\w]*))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const table = m[2].toLowerCase();
    const maybeAlias = (m[3] ?? "").toLowerCase();
    const alias = maybeAlias && !SQL_KEYWORDS.has(maybeAlias) ? maybeAlias : table;
    aliases.set(alias, table);
    if (!aliases.has(table)) aliases.set(table, table);
  }
  return aliases;
}

function baseTablesOf(query: string, ctes: Map<string, string>, seen = new Set<string>()): string[] {
  const found = new Set<string>();
  for (const table of sourceAliases(query).values()) {
    if (ctes.has(table)) {
      if (seen.has(table)) continue;
      seen.add(table);
      for (const inner of baseTablesOf(ctes.get(table)!, ctes, seen)) found.add(inner);
    } else {
      found.add(table);
    }
  }
  return [...found];
}

/**
 * What each output column of a CTE is actually made of.
 *
 * Role-narrowing is not enough when a CTE reads two metric tables. The SHR deterministic murder
 * plan has `counts AS (SELECT t.city, i.month, COUNT(v.id) AS murder_victims FROM targets t JOIN
 * incidents i ... JOIN victims v ...)`, so `c.murder_victims` could come from `incidents` or
 * `victims` by table alone. Reading the CTE's own select list resolves it to `victims`, which is
 * the truth and is what "lineage" has to mean.
 */
function cteOutputs(
  name: string,
  ctes: Map<string, string>,
  memo: Map<string, Map<string, ColumnRef[]>>,
  seen: Set<string>,
  columnLists: Map<string, string[]> = new Map()
): Map<string, ColumnRef[]> {
  const cached = memo.get(name);
  if (cached) return cached;
  const outputs = new Map<string, ColumnRef[]>();
  memo.set(name, outputs);              // set first: a recursive CTE must not loop
  if (seen.has(name)) return outputs;
  seen.add(name);

  const body = ctes.get(name);
  if (!body) return outputs;

  const declared = columnLists.get(name) ?? null;

  // A CTE can itself be compound. Every arm contributes to the same output columns, so each arm's
  // refs are merged into the entry for that position -- which is how a second arm returning a
  // different offense becomes visible to the measure check.
  // SQL aligns compound arms by POSITION, not by name. An earlier version merged each arm under its
  // own alias, so `SELECT murder AS murders ... UNION ALL SELECT robbery AS anything ...` filed the
  // second arm under `anything` and `x.murders` never saw the robbery at position 2.
  const refsByIndex: ColumnRef[][] = [];
  const nameByIndex: (string | null)[] = [];

  for (const arm of compoundArms(body)) {
  const selectAt = findTopLevel(arm, /\bSELECT\b/gi);
  if (selectAt === -1) continue;
  const afterSelect = arm.slice(selectAt + "SELECT".length);
  const fromAt = findTopLevel(afterSelect, /\bFROM\b/gi);
  const selectList = fromAt === -1 ? afterSelect : afterSelect.slice(0, fromAt);
  const fromClause = fromAt === -1 ? "" : afterSelect.slice(fromAt);
  const innerAliases = sourceAliases(fromClause);

  const items = splitTopLevel(selectList, ",");
  items.forEach((raw, index) => {
    const aliasMatch = raw.match(/\s+(?:AS\s+)?([A-Za-z_][\w]*)\s*$/i);
    const alias = aliasMatch && !SQL_KEYWORDS.has(aliasMatch[1].toLowerCase()) ? aliasMatch[1] : null;
    const bodyExpr = alias ? raw.slice(0, raw.length - aliasMatch![0].length) : raw;
    // `columnLists` must be forwarded here. Without it a nested CTE lost its positional mapping,
    // so `WITH x(m) AS (SELECT robbery ...), y(murders) AS (SELECT x.m FROM x)` laundered robbery
    // into `y.murders` with nothing to object to.
    const { refs } = refsIn(bodyExpr, innerAliases, ctes, memo, seen, columnLists);
    const bare = bodyExpr.trim().match(/^(?:[A-Za-z_][\w]*\.)?([A-Za-z_][\w]*)$/);
    const key = (alias ?? bare?.[1] ?? "").toLowerCase();
    refsByIndex[index] = [...(refsByIndex[index] ?? []), ...refs];
    if (key && !nameByIndex[index]) nameByIndex[index] = key;   // the first arm names the column
  });
  }

  refsByIndex.forEach((refs, index) => {
    const name = nameByIndex[index];
    if (name) outputs.set(name, refs);
    // A declared column list renames by POSITION, so `x(murders)` over `SELECT robbery` means
    // `x.murders` IS `robbery`. Without this the declared name resolves to nothing real.
    if (declared && index < declared.length) outputs.set(declared[index], refs);
  });
  return outputs;
}

function refsIn(
  expression: string,
  aliases: Map<string, string>,
  ctes: Map<string, string>,
  memo: Map<string, Map<string, ColumnRef[]>> = new Map(),
  seen: Set<string> = new Set(),
  columnLists: Map<string, string[]> = new Map()
): {
  refs: ColumnRef[];
  countsRows: boolean;
  resolved: boolean;
} {
  const refs: ColumnRef[] = [];
  let resolved = true;
  const countsRows = /\bCOUNT\s*\(\s*(?:\*|DISTINCT\s+[\w.]+|[\w.]+)\s*\)/i.test(expression);

  const singleBase = (() => {
    const tables = [...new Set(aliases.values())].filter((t) => !ctes.has(t));
    return tables.length === 1 ? tables[0] : null;
  })();

  const qualified = /\b([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)\b/g;
  const consumed: [number, number][] = [];
  let m: RegExpExecArray | null;
  while ((m = qualified.exec(expression)) !== null) {
    consumed.push([m.index, m.index + m[0].length]);
    const aliasKey = m[1].toLowerCase();
    const table = aliases.get(aliasKey) ?? null;
    if (table && ctes.has(table)) {
      // Resolve through the CTE to the column's own origin before falling back to table-level guesses.
      const column = m[2].toLowerCase();
      const origin = cteOutputs(table, ctes, memo, new Set(seen), columnLists).get(column);
      if (origin && origin.length > 0) {
        for (const ref of origin) refs.push({ ...ref });
        continue;
      }
      const inner = baseTablesOf(ctes.get(table)!, ctes);
      if (inner.length === 1) refs.push({ table: inner[0], column });
      else if (inner.length > 1) refs.push({ table: null, column, candidates: inner });
      else refs.push({ table: LITERAL_SOURCE, column });
    } else if (table) {
      refs.push({ table, column: m[2].toLowerCase() });
    } else {
      refs.push({ table: null, column: m[2].toLowerCase() });
      resolved = false;
    }
  }

  const bare = /\b([A-Za-z_][\w]*)\b(\s*\()?/g;
  while ((m = bare.exec(expression)) !== null) {
    if (consumed.some(([s, e]) => m!.index >= s && m!.index < e)) continue;
    const word = m[1].toLowerCase();
    if (m[2]) continue;                        // a function call, not a column
    // Only skip a function NAME when a paren follows it. `count` is a real column in
    // agency_monthly, state_monthly and national_monthly, and skipping it by name meant
    // `SUM(count)` resolved to nothing and the series escaped evaluation entirely.
    if (SQL_KEYWORDS.has(word)) continue;
    if (/^\d/.test(word)) continue;
    if (aliases.has(word)) continue;           // a table/alias name used bare

    // An UNQUALIFIED column drawn from a CTE must still resolve through that CTE. Falling straight
    // through to the single base table invented `historical_agency_crime.murders` for
    // `SELECT year, murders FROM x`, which no offense check could match -- so a compound arm hidden
    // in `x` stayed invisible even once the arms were being read.
    const cteSources = [...new Set([...aliases.values()])].filter((table) => ctes.has(table));
    if (cteSources.length === 1) {
      const origin = cteOutputs(cteSources[0], ctes, memo, new Set(seen), columnLists).get(word);
      if (origin && origin.length > 0) {
        for (const ref of origin) refs.push({ ...ref });
        continue;
      }
    }

    if (singleBase) refs.push({ table: singleBase, column: word });
    else {
      const candidates = [...new Set([...aliases.values()].flatMap(
        (table) => (ctes.has(table) ? baseTablesOf(ctes.get(table)!, ctes) : [table])
      ))];
      if (candidates.length > 1) refs.push({ table: null, column: word, candidates });
      else if (candidates.length === 1) refs.push({ table: candidates[0], column: word });
      else refs.push({ table: LITERAL_SOURCE, column: word });
    }
  }

  return { refs, countsRows, resolved };
}

/** Right-hand side of the last top-level `/`, or null when the expression has no division. */
function denominatorExpression(expression: string): string | null {
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < expression.length; i += 1) {
    const ch = expression[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    else if (ch === "/" && depth === 0) cut = i;
  }
  if (cut === -1) {
    // A rate is often written as ROUND(x / y, 1); look one level in when the whole item is a call.
    const call = expression.match(/^\s*[A-Za-z_]\w*\s*\(([\s\S]*)\)\s*$/);
    if (call) {
      const inner = splitTopLevel(call[1], ",")[0];
      if (inner && inner !== expression) return denominatorExpression(inner);
    }
    return null;
  }
  return expression.slice(cut + 1);
}

export function analyzeSql(sql: string): SqlLineage {
  const scrubbed = scrub(sql);
  const { names: ctes, columnLists, rest } = extractCtes(scrubbed);

  const selectAt = findTopLevel(rest, /\bSELECT\b/gi);
  if (selectAt === -1) return { parsed: false, unsupportedShape: null, items: [], baseTables: [] };

  const memo = new Map<string, Map<string, ColumnRef[]>>();
  const items: SelectItem[] = [];
  const baseTables: string[] = [];

  // EVERY arm of a compound is read, not just the first.
  const arms = compoundArms(rest.slice(selectAt));
  for (const arm of arms) {
  const armSelectAt = findTopLevel(arm, /\bSELECT\b/gi);
  if (armSelectAt === -1) continue;
  const afterSelect = arm.slice(armSelectAt + "SELECT".length);
  const fromAt = findTopLevel(afterSelect, /\bFROM\b/gi);
  const selectList = fromAt === -1 ? afterSelect : afterSelect.slice(0, fromAt);
  const fromClause = fromAt === -1 ? "" : afterSelect.slice(fromAt);

  const aliases = sourceAliases(fromClause);
  for (const table of baseTablesOf(fromClause, ctes)) {
    if (!baseTables.includes(table)) baseTables.push(table);
  }

  for (const raw of splitTopLevel(selectList, ",")) {
    const aliasMatch = raw.match(/\s+(?:AS\s+)?([A-Za-z_][\w]*)\s*$/i);
    const alias = aliasMatch && !SQL_KEYWORDS.has(aliasMatch[1].toLowerCase()) ? aliasMatch[1] : null;
    const body = alias ? raw.slice(0, raw.length - aliasMatch![0].length) : raw;

    // A scalar subquery carries its own FROM; merge those aliases so the expression can resolve.
    const itemAliases = new Map(aliases);
    if (/\bSELECT\b[\s\S]*\bFROM\b/i.test(body)) {
      for (const [alias, table] of sourceAliases(body)) itemAliases.set(alias, table);
    }

    const { refs, countsRows, resolved } = refsIn(body, itemAliases, ctes, memo, new Set(), columnLists);
    const denomExpr = denominatorExpression(body);
    const denominatorRefs = denomExpr === null
      ? null
      : refsIn(denomExpr, itemAliases, ctes, memo, new Set(), columnLists).refs;

    // A projection wildcard is the WHOLE item (`*`) or a qualified one (`alias.*`). Anything else
    // is the multiplication operator: `COUNT(*) * 100000.0 / population` is a rate, and an earlier
    // draft read that second `*` as a projection and flagged every rate.
    //
    // `SELECT DISTINCT *` puts a keyword in front of the item, and `"hac".*` quotes the alias.
    // Both are ordinary SQL and both previously escaped this check entirely.
    // SQLite accepts four identifier quotings: bare, "double", [bracket] and `backtick`. Recognising
    // only bare and double-quoted let `[hac].*` and \`hac\`.* through untouched.
    const withoutLeadingQuantifier = body.trim().replace(/^(?:DISTINCT|ALL)\s+/i, "").trim();
    const hasWildcard = withoutLeadingQuantifier === "*" ||
      /(?:"[^"]+"|\[[^\]]+\]|`[^`]+`|\b[A-Za-z_]\w*)\s*\.\s*\*/.test(body);

    const aggregateOrConstant = countsRows
      || /\b(?:SUM|AVG|MIN|MAX|TOTAL|COUNT)\s*\(/i.test(body)
      || /^\s*[-+]?[0-9][0-9_.]*\s*$/.test(body);
    const numericWithoutColumns = refs.length === 0 && aggregateOrConstant;

    items.push({
      alias, raw: raw.trim(), refs, denominatorRefs, countsRows, hasWildcard,
      numericWithoutColumns, resolved,
    });
  }
  }

  if (items.length === 0) return { parsed: false, unsupportedShape: null, items: [], baseTables: [] };
  if (baseTables.length === 0 && ctes.size === 0) {
    return { parsed: false, unsupportedShape: null, items: [], baseTables: [] };
  }
  return { parsed: true, unsupportedShape: null, items, baseTables };
}
