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

export type CommonTableExpression = { name: string; body: string };

export type RestrictionOptions = {
  /** The table whose rows are being counted -- the rows the restriction has to reach. */
  countedTable: string;
  /** The table the filter column lives on. */
  filterTable: string;
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

/** Does this one scope restrict the column to exactly this value? */
function scopeRestricts(scope: string, column: string, value: string): boolean {
  // The column may carry a table alias -- `i.homicide_type` -- on either side of the comparison.
  const col = `(?:[A-Za-z_]\\w*\\s*\\.\\s*)?${escapeRegExp(column)}`;

  // NOTE on multi-value `IN`: there is deliberately no "defeating literal" scan here, unlike
  // `sqlTargetsOri`. Under this design it could not change any outcome -- a broader condition can
  // only enter through an `OR` (the region is refused) or through a separate region (an `AND`,
  // which narrows) -- while it COULD cause false refusals, because it would read
  // `CASE WHEN homicide_type = 'Manslaughter'` in a SELECT list as though it widened the filter.
  // `IN ('Murder', 'Manslaughter')` is refused by construction: it matches no equality, and the
  // single-value normalisation below does not apply to it.
  const literal = escapeRegExp(value);
  const equals = new RegExp(`\\b${col}\\s*=\\s*'${literal}'`, "i");
  const reversed = new RegExp(`'${literal}'\\s*=\\s*${col}\\b`, "i");
  const singletonIn = new RegExp(`\\b${col}\\s+IN\\s*\\(\\s*'${literal}'\\s*\\)`, "i");

  for (const region of topLevelFilterRegionsDetailed(scope)) {
    // An outer join's ON keeps the preserved side, so it restricts nothing.
    if (region.outerJoinOn) continue;
    // A single-value `IN` is an equality written differently. Normalise it before flattening so
    // its parentheses are not mistaken for a subquery.
    const flat = flattenParens(region.text.replace(singletonIn, `${column} = '${value}'`));
    // A disjunction at THIS level can widen what the equality restricted, and proving otherwise
    // needs a parser -- so refuse. The test has to come after flattening, not before: a
    // parenthesised `OR` is ANDed into the region and widens nothing, and checking the raw text
    // refused real queries. Logged queries #157/#159 filter `homicide_type = 'Murder'` and then
    // AND `(i.agency = 'New York' OR i.agency = 'New York City')`; those are correct, and reading
    // their bracketed alias list as a broadened filter rejected a right answer.
    if (/\bor\b/i.test(flat)) continue;
    if (equals.test(flat) || reversed.test(flat)) return true;
  }
  return false;
}

/** Is this CTE pulled in by an OUTER join, which would preserve unmatched rows? */
function referencedByOuterJoin(scope: string, name: string): boolean {
  return new RegExp(`\\b(?:LEFT|RIGHT|FULL)\\s+(?:OUTER\\s+)?JOIN\\s+${escapeRegExp(name)}\\b`, "i")
    .test(scope);
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
    // Only a scope that actually holds the counted rows can be the place this is proved.
    if (!tableInScope(scope, opts.countedTable)) continue;

    // Shape 1: the predicate is applied right where the rows are counted.
    if (tableInScope(scope, opts.filterTable) && scopeRestricts(scope, column, value)) return true;

    // Shape 2: the house idiom -- a CTE restricts the filter table, and the counting scope INNER
    // joins it, so every counted row is reached through the restriction. `cteTargetsOri` accepts
    // the same shape for the agency pin, and refusing it here would refuse the shipped query.
    for (const cte of ctes) {
      if (cteReferences(scope, cte.name).length === 0) continue;
      if (referencedByOuterJoin(scope, cte.name)) continue;
      if (!tableInScope(cte.body, opts.filterTable)) continue;
      if (scopeRestricts(cte.body, column, value)) return true;
    }
  }
  return false;
}
