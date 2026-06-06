/**
 * Local SQL structure guardrails for NIBRS queries.
 *
 * These run BEFORE the SQL hits SQLite, catching syntax/structure issues
 * that would waste a round-trip or confuse the user with a DB error.
 *
 * Tested by: scripts/test-sql-guardrails.ts
 */

/** Strip string literals so regexes don't match inside quoted values. */
function stripSqlStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""');
}

// ─── Duplicate GROUP BY ─────────────────────────────────────────────
// Detects two GROUP BY clauses within a single SELECT scope.
// The regex stops at clause-boundary keywords that would indicate
// a new SELECT block (SELECT, FROM, UNION, etc.)
const DUPLICATE_GROUP_BY_RE =
  /\bGROUP\s+BY\b(?:(?!\b(?:SELECT|FROM|WHERE|HAVING|ORDER\s+BY|LIMIT|UNION(?:\s+ALL)?)\b)[\s\S])+\bGROUP\s+BY\b/i;

// ─── ORDER BY before UNION ALL (depth-aware) ────────────────────────
// Walks the SQL character by character, tracking parenthesis depth.
// Only fires when ORDER BY appears at depth 0 before a UNION ALL at depth 0.
// ORDER BY inside CTEs (WITH ... AS (...)) and subqueries is fine.
function hasTopLevelOrderBeforeUnionAll(sql: string): boolean {
  const upper = sql.toUpperCase();
  let depth = 0;
  let seenTopLevelOrderBy = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "(") {
      depth++;
      continue;
    }
    if (ch === ")") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;

    // Check for ORDER BY at depth 0
    if (
      upper[i] === "O" &&
      /^ORDER\s+BY\b/.test(upper.slice(i))
    ) {
      seenTopLevelOrderBy = true;
    }

    // Check for UNION ALL at depth 0
    if (
      upper[i] === "U" &&
      /^UNION\s+ALL\b/.test(upper.slice(i))
    ) {
      if (seenTopLevelOrderBy) return true;
    }
  }
  return false;
}

// ─── Undeclared alias detection ─────────────────────────────────────
// Extracts all declared table/CTE aliases, then checks every
// qualifier.column reference. Skips schema-qualified names (main.*).
const SQL_KEYWORDS = new Set([
  "where", "on", "using", "join", "left", "right", "inner", "outer",
  "cross", "full", "group", "order", "having", "limit", "union",
  "select", "from", "and", "or", "not", "as", "set", "into", "values",
  "case", "when", "then", "else", "end", "between", "like", "in",
  "is", "null", "distinct", "all", "exists", "with", "recursive",
]);

// SQLite schema prefixes that are valid qualifiers but not table aliases
const SCHEMA_NAMES = new Set(["main", "temp", "sqlite_temp"]);

function findUndeclaredAliases(sql: string): string[] {
  const declared = new Set<string>();

  // CTE names: word AS (
  let m: RegExpExecArray | null;
  const cteRe = /\b([A-Za-z_][\w]*)\s+AS\s*\(/gi;
  while ((m = cteRe.exec(sql)) !== null) {
    declared.add(m[1].toLowerCase());
  }

  // FROM/JOIN table_name [alias]
  // Handles: FROM table alias, FROM table AS alias, JOIN table alias
  const tableRe =
    /\b(?:FROM|JOIN)\s+(?:([A-Za-z_][\w]*)\.)?([A-Za-z_][\w]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?/gi;
  while ((m = tableRe.exec(sql)) !== null) {
    // m[1] = optional schema prefix (e.g. "main")
    // m[2] = table name
    // m[3] = optional alias
    declared.add(m[2].toLowerCase());
    const alias = m[3]?.toLowerCase();
    if (alias && !SQL_KEYWORDS.has(alias)) declared.add(alias);
  }

  // Subquery aliases: FROM (...) alias or JOIN (...) alias
  // Walk through and find closing parens followed by an alias
  const depth: number[] = [];
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth.push(i);
    if (sql[i] === ")" && depth.length > 0) {
      const openPos = depth.pop()!;
      // Check if this paren group is preceded by FROM/JOIN
      const before = sql.slice(Math.max(0, openPos - 30), openPos);
      if (/\b(?:FROM|JOIN)\s*$/i.test(before)) {
        // Check for alias after closing paren
        const after = sql.slice(i + 1, i + 50);
        const aliasMatch = after.match(/^\s+(?:AS\s+)?([A-Za-z_][\w]*)/i);
        if (aliasMatch && !SQL_KEYWORDS.has(aliasMatch[1].toLowerCase())) {
          declared.add(aliasMatch[1].toLowerCase());
        }
      }
    }
  }

  // Find all qualifier.column references and check against declared set
  const undeclared = new Set<string>();
  const refRe = /(?:^|[^A-Za-z0-9_.])([A-Za-z_][\w]*)\.([A-Za-z_][\w]*)/g;
  while ((m = refRe.exec(sql)) !== null) {
    const qualifier = m[1].toLowerCase();
    if (
      !declared.has(qualifier) &&
      !SCHEMA_NAMES.has(qualifier)
    ) {
      undeclared.add(m[1]);
    }
  }

  return Array.from(undeclared);
}

// ─── Public API ─────────────────────────────────────────────────────

export function findNibrsSqlIssues(sql: string): {
  issues: string[];
  fired: string[];
} {
  const cleaned = stripSqlStrings(sql);
  const issues: string[] = [];
  const fired: string[] = [];

  // 1. Duplicate GROUP BY
  if (DUPLICATE_GROUP_BY_RE.test(cleaned)) {
    fired.push("nibrs-duplicate-group-by");
    issues.push(
      "Your SQL has two GROUP BY clauses in the same SELECT statement. Use only one GROUP BY clause per SELECT."
    );
  }

  // 2. Top-level ORDER BY before UNION ALL (depth-aware)
  if (hasTopLevelOrderBeforeUnionAll(cleaned)) {
    fired.push("nibrs-order-before-union-all");
    issues.push(
      "Your SQL places ORDER BY before UNION ALL. In SQLite, ORDER BY must come after the final UNION ALL branch."
    );
  }

  // 3. Undeclared table aliases
  const undeclared = findUndeclaredAliases(cleaned);
  if (undeclared.length > 0) {
    const aliases = undeclared.join(", ");
    fired.push("nibrs-undeclared-table-alias");
    issues.push(
      `Your SQL references undeclared table alias(es): ${aliases}. Every qualified column reference like s.year must use an alias declared in FROM or JOIN, or the qualifier must be removed.`
    );
  }

  return { issues, fired };
}
