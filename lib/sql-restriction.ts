/**
 * Proving that a condition RESTRICTS the rows a statement returns -- not merely that its text
 * appears somewhere in the SQL.
 *
 * This distinction has now been got wrong twice in this repository, in two different places, in
 * the same way: a regular expression searched the whole statement for `column = 'value'` and
 * treated a hit as proof. It is not proof. The text can sit in a comment, in an unused CTE, in an
 * unrelated subquery, or next to an `OR` that gives back everything the equality took away. So
 * the check lives here once, and both callers use it.
 *
 * What counts as a restriction:
 *   - it survives comment stripping;
 *   - it sits in a top-level `WHERE` or join `ON` of a scope the statement actually uses;
 *   - that scope is either the outer query or a CTE the outer query really references
 *     (transitively) -- a condition parked in an unused CTE restricts nothing;
 *   - no `OR` shares the region, because a disjunction can widen what the equality narrowed;
 *   - no comparison anywhere in that scope admits a different literal, so a multi-value
 *     `IN ('Murder', 'Manslaughter')` is broader than the licence rather than equal to it;
 *   - every table the caller says must be in scope really is, so the condition and the rows it
 *     is supposed to filter are in the same place.
 */

import { analyzeSql } from "./sql-lineage";

export type CommonTableExpression = { name: string; body: string };

export type RestrictionOptions = {
  /** The table whose rows are being counted -- the rows the restriction has to reach. */
  countedTable: string;
  /** The table the filter column lives on. */
  filterTable: string;
  /**
   * The relationship that carries the restriction from the filter table to the counted rows.
   *
   * Without this the check proved only that both tables appeared in the statement, which
   * `CROSS JOIN incidents` and `JOIN incidents ON 1=1` both satisfy while counting every victim,
   * multiplied by the incident rows.
   */
  join: { countedColumn: string; filterColumn: string };
};

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** The text outside every parenthesised group, which is where a top-level filter lives. */
export function flattenParens(text: string): string {
  let depth = 0;
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "'") {
      const end = text.indexOf("'", i + 1);
      const literal = text.slice(i, end === -1 ? text.length : end + 1);
      if (depth === 0) out += literal;
      i = (end === -1 ? text.length : end);
      continue;
    }
    if (char === "(") { depth += 1; out += " "; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); out += " "; continue; }
    if (depth === 0) out += char;
  }
  return out;
}

/**
 * The stretches of a statement that actually filter rows: each `WHERE` and each join `ON`,
 * taken at the top level only.
 *
 * Top level matters. A `WHERE` inside a subquery restricts that subquery, not the rows the
 * statement returns, and a comparison in `SELECT`, `CASE`, `GROUP BY` or `ORDER BY` restricts
 * nothing at all -- `SELECT ha.ori = 'MD0030100' AS is_selected` is a boolean column, and it
 * was passing as though it were a filter.
 */
export function topLevelFilterRegions(sql: string): string[] {
  return topLevelFilterRegionsDetailed(sql).map((region) => region.text);
}

/**
 * The same regions, each tagged with whether it is the `ON` of an OUTER join.
 *
 * An outer join's `ON` does not restrict the preserved side. `FROM victims v LEFT JOIN incidents i
 * ON v.incident_id = i.id AND i.homicide_type = 'Murder'` keeps every victim row and merely blanks
 * the incident columns for the rest, so reading that `ON` as a filter over-counts by exactly the
 * rows it was supposed to exclude.
 */
export function topLevelFilterRegionsDetailed(sql: string): { text: string; outerJoinOn: boolean }[] {
  const terminator = /^(?:group\s+by|order\s+by|having|limit|window|union|intersect|except|join|inner|left|right|full|cross|on|where)\b/i;
  const regions: { text: string; outerJoinOn: boolean }[] = [];
  let depth = 0;
  let i = 0;
  let outerPending = false;
  let currentJoinOuter = false;
  while (i < sql.length) {
    const char = sql[i];
    if (char === "'") {
      const end = sql.indexOf("'", i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (char === "(") { depth += 1; i += 1; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth === 0) {
      const rest = sql.slice(i);
      const outerWord = /^(left|right|full)\b/i.exec(rest);
      if (outerWord) { outerPending = true; i += outerWord[0].length; continue; }
      const joinWord = /^join\b/i.exec(rest);
      if (joinWord) {
        currentJoinOuter = outerPending;
        outerPending = false;
        i += joinWord[0].length;
        continue;
      }
      const opener = /^(where|on)\b/i.exec(rest);
      if (opener) {
        const outerJoinOn = opener[1].toLowerCase() === "on" && currentJoinOuter;
        let j = i + opener[0].length;
        let innerDepth = 0;
        const start = j;
        while (j < sql.length) {
          const c = sql[j];
          if (c === "'") {
            const end = sql.indexOf("'", j + 1);
            j = end === -1 ? sql.length : end + 1;
            continue;
          }
          if (c === "(") { innerDepth += 1; j += 1; continue; }
          if (c === ")") {
            if (innerDepth === 0) break;
            innerDepth -= 1; j += 1; continue;
          }
          if (innerDepth === 0 && terminator.test(sql.slice(j))) break;
          j += 1;
        }
        regions.push({ text: sql.slice(start, j), outerJoinOn });
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return regions;
}

/**
 * The CTEs a statement defines, and the query that follows them.
 *
 * Returns nothing when the statement does not open with `WITH`, so ordinary queries take the
 * direct path and pay nothing for this.
 */
export function splitCtes(sql: string): { ctes: CommonTableExpression[]; outer: string } | null {
  const head = /^\s*WITH\s+(RECURSIVE\s+)?/i.exec(sql);
  if (!head) return null;
  const ctes: CommonTableExpression[] = [];
  let i = head[0].length;
  while (i < sql.length) {
    const entry = /^\s*("?)([A-Za-z_]\w*)\1\s*(?:\([^)]*\))?\s*AS\s*(?:MATERIALIZED\s+|NOT\s+MATERIALIZED\s+)?\(/i
      .exec(sql.slice(i));
    if (!entry) break;
    let depth = 1;
    let j = i + entry[0].length;
    const bodyStart = j;
    while (j < sql.length && depth > 0) {
      const char = sql[j];
      if (char === "'") {
        const end = sql.indexOf("'", j + 1);
        j = end === -1 ? sql.length : end + 1;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      j += 1;
    }
    ctes.push({ name: entry[2], body: sql.slice(bodyStart, j - 1) });
    i = j;
    const comma = /^\s*,/.exec(sql.slice(i));
    if (!comma) break;
    i += comma[0].length;
  }
  return ctes.length > 0 ? { ctes, outer: sql.slice(i) } : null;
}

/** Every name a query refers to this CTE by -- its own name, and any alias. */
export function cteReferences(outer: string, name: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(`\\b(?:FROM|JOIN)\\s+${escapeRegExp(name)}\\b(?:\\s+AS)?(?:\\s+([A-Za-z_]\\w*))?`, "gi");
  const RESERVED = /^(on|where|group|order|limit|left|right|inner|full|cross|join|union|having|window|using)$/i;
  for (const match of outer.matchAll(pattern)) {
    found.add(name);
    if (match[1] && !RESERVED.test(match[1])) found.add(match[1]);
  }
  return [...found];
}

/**
 * The scopes whose filters can restrict what a statement returns: the outer query, plus every
 * CTE the outer query actually uses, followed transitively.
 *
 * The transitive step matters as much as the first one. The SHR deterministic plan pins its
 * predicate two levels down, and a check that only looked at the outer query would refuse the
 * product's own query; a check that looked at every CTE regardless of use would accept a
 * condition parked in dead code.
 */
export function restrictingScopes(sql: string): string[] {
  const split = splitCtes(sql);
  if (!split) return [sql];
  const scopes = [split.outer];
  const used = new Set<string>();
  const queue = [split.outer];
  while (queue.length > 0) {
    const text = queue.pop() as string;
    for (const cte of split.ctes) {
      if (used.has(cte.name)) continue;
      if (cteReferences(text, cte.name).length === 0) continue;
      used.add(cte.name);
      scopes.push(cte.body);
      queue.push(cte.body);
    }
  }
  return scopes;
}

/** Is this table named in a top-level FROM or JOIN of this scope? */
function tableInScope(scope: string, table: string): boolean {
  const name = escapeRegExp(table);
  // Any of SQLite's identifier quotings, optionally schema-qualified.
  const pattern = new RegExp(
    `\\b(?:FROM|JOIN)\\s+(?:[A-Za-z_]\\w*\\s*\\.\\s*)?(?:"${name}"|\\[${name}\\]|\`${name}\`|${name})\\b`, "i");
  return pattern.test(flattenParens(scope));
}

const ALIAS_RESERVED = /^(on|where|group|order|limit|left|right|inner|full|cross|join|union|having|window|using|as|natural|intersect|except)$/i;

/**
 * Every name this scope's rows can be referred to by, mapped to the table it stands for.
 *
 * `FROM incidents i JOIN victims v` yields i->incidents, v->victims, incidents->incidents,
 * victims->victims. Without this, `v.homicide_type = 'Murder'` was read as a restriction on
 * `incidents` purely because `incidents` appeared elsewhere in the statement.
 */
function aliasMap(scope: string): Map<string, string> {
  const map = new Map<string, string>();
  const pattern = /\b(?:FROM|JOIN)\s+(?:[A-Za-z_]\w*\s*\.\s*)?(?:"([^"]+)"|\[([^\]]+)\]|`([^`]+)`|([A-Za-z_]\w*))\s*(?:\bAS\b\s*)?([A-Za-z_]\w*)?/gi;
  for (const match of flattenParens(scope).matchAll(pattern)) {
    const table = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (!table || ALIAS_RESERVED.test(table)) continue;
    map.set(table.toLowerCase(), table.toLowerCase());
    const alias = match[5];
    if (alias && !ALIAS_RESERVED.test(alias)) map.set(alias.toLowerCase(), table.toLowerCase());
  }
  return map;
}

/** Strip redundant wrapping parentheses: `((x))` -> `x`, but never `(a) AND (b)`. */
function unwrapParens(text: string): string {
  let out = text.trim();
  while (out.startsWith("(") && out.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < out.length; i += 1) {
      const char = out[i];
      if (char === "'") {
        const end = out.indexOf("'", i + 1);
        i = end === -1 ? out.length : end;
        continue;
      }
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0 && i < out.length - 1) { wraps = false; break; }
      }
    }
    if (!wraps) break;
    out = out.slice(1, -1).trim();
  }
  return out;
}

/** The top-level `AND` conjuncts of a filter region, in source order. */
function splitConjuncts(region: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < region.length) {
    const char = region[i];
    if (char === "'") {
      const end = region.indexOf("'", i + 1);
      i = end === -1 ? region.length : end + 1;
      continue;
    }
    if (char === "(") { depth += 1; i += 1; continue; }
    if (char === ")") { depth = Math.max(0, depth - 1); i += 1; continue; }
    if (depth === 0 && /^and\b/i.test(region.slice(i)) && (i === 0 || /\W/.test(region[i - 1]))) {
      parts.push(region.slice(start, i));
      i += 3;
      start = i;
      continue;
    }
    i += 1;
  }
  parts.push(region.slice(start));

  const out: string[] = [];
  for (const part of parts) {
    const bare = unwrapParens(part);
    if (bare.length === 0) continue;
    // Unwrapping can expose a further AND chain: `(a AND b) AND c` has to yield a, b and c, or a
    // correct query whose predicate sits inside a bracketed group -- `WHERE (i.homicide_type =
    // 'Murder' AND v.state = 'CA')` -- would be refused for the shape of its brackets.
    if (bare !== part.trim() && bare.length < part.trim().length) out.push(...splitConjuncts(bare));
    else out.push(bare);
  }
  return out;
}

/**
 * Every conjunct that genuinely restricts this scope: the top-level `AND` terms of each `WHERE`
 * and inner-join `ON`.
 *
 * Conjuncts, not regions. A required equality counts only when it IS one of these terms -- text
 * matching inside a region accepted `CASE WHEN v.incident_id = i.id THEN 1 ELSE 1 END = 1`, which
 * is always true and relates nothing. Matching whole conjuncts also removes the need for a growing
 * list of exclusions for `CASE`, string contexts and the like, and it subsumes two earlier rules:
 *   - a disjunction cannot slip through, because `a OR b` is a single conjunct that no exact
 *     pattern matches -- while logged #157/#159 still pass, their murder predicate being its own
 *     conjunct and the place aliases a separate parenthesised one;
 *   - a filter inside a subquery cannot either, since `year IN (SELECT ...)` is one conjunct.
 *
 * An OUTER join's `ON` is excluded outright: it keeps the preserved side, so it restricts nothing.
 */
function restrictingConjuncts(scope: string): string[] {
  const kept: string[] = [];
  for (const region of topLevelFilterRegionsDetailed(scope)) {
    if (region.outerJoinOn) continue;
    kept.push(...splitConjuncts(region.text));
  }
  return kept;
}

/**
 * Is `left.leftColumn = right.rightColumn` established in this scope, with aliases resolved?
 *
 * `left` and `right` are table names; either side of the written equality may be either one.
 */
function equalityProved(
  scope: string, aliases: Map<string, string>,
  left: string, leftColumn: string, right: string, rightColumn: string,
): boolean {
  const ref = "([A-Za-z_]\\w*)\\s*\\.\\s*([A-Za-z_]\\w*)";
  // Anchored, for the same reason as the restriction: the conjunct must BE the equality. An
  // equality buried in `CASE WHEN v.incident_id = i.id THEN 1 ELSE 1 END = 1` is always true and
  // relates nothing, so every victim row survives, multiplied by the incidents.
  const exact = new RegExp(`^${ref}\\s*=\\s*${ref}$`, "i");
  for (const conjunct of restrictingConjuncts(scope)) {
    const m = exact.exec(conjunct);
    if (!m) continue;
    const a = { table: aliases.get(m[1].toLowerCase()), column: m[2].toLowerCase() };
    const b = { table: aliases.get(m[3].toLowerCase()), column: m[4].toLowerCase() };
    const matches = (x: typeof a, table: string, column: string) =>
      x.table === table.toLowerCase() && x.column === column.toLowerCase();
    if (matches(a, left, leftColumn) && matches(b, right, rightColumn)) return true;
    if (matches(b, left, leftColumn) && matches(a, right, rightColumn)) return true;
  }
  return false;
}

/**
 * Does this scope restrict `filterTable.column` to exactly this value?
 *
 * The qualifier has to resolve to the filter table. `v.homicide_type = 'Murder'` restricts the
 * victims table -- a column that does not exist there -- and reading it as a restriction on
 * `incidents` merely because `incidents` was in the statement let the join be skipped entirely.
 */
function scopeRestrictsOn(
  scope: string, aliases: Map<string, string>, filterTable: string, column: string, value: string,
): boolean {
  const owners = [...aliases.entries()]
    .filter(([, table]) => table === filterTable.toLowerCase())
    .map(([name]) => name);
  // A precondition, not a guarantee: with no owner the qualifier below would be a degenerate empty
  // alternation. Removing it changes no outcome -- `projectionsOf` and the shape-1 table check
  // already refuse a scope without the filter table -- so it is documented as what it is.
  if (owners.length === 0) return false;
  const qualified = `(?:${owners.map(escapeRegExp).join("|")})\\s*\\.\\s*`;
  // An unqualified column is only unambiguous when the filter table is the sole table in scope.
  const soleTable = new Set([...aliases.values()]).size === 1;
  const prefix = soleTable ? `(?:${qualified})?` : qualified;
  return scopeRestricts(scope, column, value, prefix);
}

/** Does this one scope restrict the column to exactly this value? */
function scopeRestricts(scope: string, column: string, value: string, qualifier?: string): boolean {
  // The column may carry a table alias -- `i.homicide_type` -- on either side of the comparison.
  // Callers that know which table must own it pass a qualifier restricting which aliases count.
  const col = `${qualifier ?? "(?:[A-Za-z_]\\w*\\s*\\.\\s*)?"}${escapeRegExp(column)}`;

  // NOTE on multi-value `IN`: there is deliberately no "defeating literal" scan here, unlike
  // `sqlTargetsOri`. It is refused by construction -- `IN ('Murder', 'Manslaughter')` is a
  // conjunct that no pattern below matches -- while such a scan COULD cause false refusals by
  // reading `CASE WHEN homicide_type = 'Manslaughter'` in a SELECT list as a widened filter.
  const literal = escapeRegExp(value);
  // Anchored: the conjunct must BE the comparison, not contain it. A single-value `IN` is an
  // equality written differently, so it is spelled out here rather than rewritten in the text.
  const exact = new RegExp(
    `^(?:${col}\\s*=\\s*'${literal}'`
    + `|'${literal}'\\s*=\\s*${col}`
    + `|${col}\\s+IN\\s*\\(\\s*'${literal}'\\s*\\))$`, "i");
  return restrictingConjuncts(scope).some((conjunct) => exact.test(conjunct));
}


/**
 * Does this statement restrict `column` to exactly `value`, for the rows it returns?
 *
 * Fails closed: anything this cannot prove structurally is reported as unproved.
 */
export function sqlRestrictsColumnToValue(
  sql: string, column: string, value: string, opts: RestrictionOptions,
): boolean {
  const stripped = stripSqlComments(sql || "");
  const split = splitCtes(stripped);
  const ctes = split ? split.ctes : [];

  for (const scope of restrictingScopes(stripped)) {
    // No `tableInScope(scope, countedTable)` precondition: the key equality below resolves through
    // this scope's own alias map, so a scope that does not hold the counted rows cannot prove
    // anything anyway. Mutation testing showed the extra gate changed no outcome.
    const aliases = aliasMap(scope);

    // Shape 1: the predicate is applied where the rows are counted, AND the two tables are
    // actually related. Co-presence is not a relationship: `CROSS JOIN incidents` and
    // `JOIN incidents ON 1=1` put the filter table in scope while counting every victim.
    if (tableInScope(scope, opts.filterTable)
      && equalityProved(scope, aliases,
        opts.countedTable, opts.join.countedColumn, opts.filterTable, opts.join.filterColumn)
      && scopeRestrictsOn(scope, aliases, opts.filterTable, column, value)) {
      return true;
    }

    // Shape 2: the house idiom -- a CTE restricts the filter table and PROJECTS ITS KEY, and the
    // counting scope joins that projected key to the counted rows. `cteTargetsOri` accepts the
    // same shape for the agency pin, and refusing it here would refuse the shipped query. The key
    // equality is what makes this a restriction rather than a multiplication.
    for (const cte of ctes) {
      const refs = cteReferences(scope, cte.name);
      if (refs.length === 0) continue;
      // No explicit outer-join check on the CTE reference: `restrictingRegions` already refuses an
      // outer join's ON, so the key equality below cannot be proved through one. Mutation testing
      // showed a separate guard here changed no outcome, and a guard that cannot fail is worse
      // than none -- it invites belief in a protection that is not doing the work.
      const cteAliases = aliasMap(cte.body);
      // `scopeRestrictsOn` needs an alias resolving to the filter table, so a CTE that never
      // touches it cannot get past this line.
      if (!scopeRestrictsOn(cte.body, cteAliases, opts.filterTable, column, value)) continue;
      const withCte = new Map(aliases);
      for (const name of refs) withCte.set(name.toLowerCase(), cte.name.toLowerCase());
      for (const projected of projectionsOf(cte.body, opts.filterTable, opts.join.filterColumn)) {
        if (equalityProved(scope, withCte,
          opts.countedTable, opts.join.countedColumn, cte.name, projected)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * The output columns of a CTE that carry `table.column` -- the names the outer query can join on.
 *
 * Resolved through the lineage analyzer rather than by matching names, so `SELECT id AS k` is
 * found and a same-named column belonging to some other table is not. Fails closed: an
 * unparseable body projects nothing, so nothing can be proved through it.
 */
export function projectionsOf(cteBody: string, table: string, column: string): string[] {
  const lineage = analyzeSql(cteBody);
  // Fail closed. Today this cannot change an outcome -- `analyzeSql` returns zero items whenever
  // `parsed` is false, which was measured, not assumed -- so it is defence against a future
  // analyzer that reports partial items alongside a failed parse, not a guarantee under test.
  if (!lineage.parsed) return [];
  const names: string[] = [];
  for (const item of lineage.items) {
    const carries = item.refs.some((ref) =>
      ref.column.toLowerCase() === column.toLowerCase()
      && (ref.table ?? "").toLowerCase() === table.toLowerCase());
    if (!carries) continue;
    const name = item.alias ?? item.refs[0]?.column;
    if (name) names.push(name);
  }
  return names;
}
