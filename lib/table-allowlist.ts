import type Database from "better-sqlite3";

export type QueryTab = "current" | "historical" | "nibrs" | "shr" | "hate_crime";

const BUILTIN_TABLE_LIKE = new Set([
  "select",
  "values",
  "json_each",
  "json_tree",
]);

function stripSqlStrings(sql: string): string {
  return sql.replace(/'(?:''|[^'])*'/g, "''").replace(/"(?:""|[^"])*"/g, '""');
}

// A FROM clause ends at the next clause, not at a JOIN: `FROM a JOIN b ON ..., c` still lists `c`.
const FROM_CLAUSE_END =
  /^(?:WHERE|GROUP|ORDER|HAVING|LIMIT|WINDOW|UNION|INTERSECT|EXCEPT|SELECT|FROM|VALUES)\b/i;
// Words that can follow an item's name without being its alias (`t2 JOIN t3 ON ...`).
const NOT_AN_ALIAS = String.raw`(?!(?:JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|NATURAL|ON|USING|WHERE|GROUP|ORDER|HAVING|LIMIT|WINDOW|UNION|INTERSECT|EXCEPT)\b)`;
const COMMA_TABLE_ITEM = new RegExp(String.raw`^(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)(?:\s+(?:AS\s+)?${NOT_AN_ALIAS}([A-Za-z_]\w*))?`, "i");
const COMMA_SUBQUERY_ALIAS = new RegExp(String.raw`^\s*(?:AS\s+)?${NOT_AN_ALIAS}([A-Za-z_]\w*)`, "i");

/**
 * The items after the first in each comma-separated FROM list (the FROM/JOIN patterns already see the
 * first). `FROM t1 a, main.t2 b, (SELECT ...) s` yields `{schema:"main", table:"t2", alias:"b"}` and
 * `{schema:null, table:null, alias:"s"}`.
 * Those patterns only read the name right after the keyword, so without this a comma-joined table
 * is invisible to the table checks and its declared alias looks undeclared. Pass SQL with string
 * literals already stripped. Each FROM is scanned at its own paren depth until its clause ends,
 * including commas that follow a JOIN (`FROM a JOIN b ON a.id = b.id, c`).
 */
export function commaFromItems(sql: string): { schema: string | null; table: string | null; alias: string | null }[] {
  const items: { schema: string | null; table: string | null; alias: string | null }[] = [];
  const fromRe = /\bFROM\b/gi;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(sql)) !== null) {
    // `a IS [NOT] DISTINCT FROM b` is a comparison, not a FROM clause.
    if (/\bDISTINCT\s*$/i.test(sql.slice(0, m.index))) continue;
    const parts: string[] = [];
    let depth = 0;
    let start = m.index + m[0].length;
    let i = start;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "(") { depth++; continue; }
      if (ch === ")") { if (depth === 0) break; depth--; continue; }
      if (depth > 0) continue;
      if (ch === ";") break;
      if (ch === ",") { parts.push(sql.slice(start, i)); start = i + 1; continue; }
      if (/[A-Za-z]/.test(ch) && !/\w/.test(sql[i - 1]) && FROM_CLAUSE_END.test(sql.slice(i, i + 12))) break;
    }
    parts.push(sql.slice(start, i));
    for (const part of parts.slice(1)) {
      const item = part.trim();
      if (item.startsWith("(")) {
        // The alias follows the paren that closes THIS item, not the last paren of a later JOIN's ON.
        let close = 0;
        for (let d = 0; close < item.length; close++) {
          if (item[close] === "(") d++;
          else if (item[close] === ")" && --d === 0) break;
        }
        const alias = item.slice(close + 1).match(COMMA_SUBQUERY_ALIAS)?.[1] ?? null;
        items.push({ schema: null, table: null, alias });
        continue;
      }
      const t = item.match(COMMA_TABLE_ITEM);
      if (t) items.push({ schema: t[1] ?? null, table: t[2], alias: t[3] ?? null });
    }
  }
  return items;
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  const cleaned = stripSqlStrings(sql);
  if (!/^\s*WITH\b/i.test(cleaned)) return names;

  let i = cleaned.search(/\bWITH\b/i);
  i += cleaned.slice(i).match(/\bWITH\s+(?:RECURSIVE\s+)?/i)?.[0].length ?? 4;
  let depth = 0;
  let expectingName = true;

  while (i < cleaned.length) {
    const ch = cleaned[i];
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);

    if (depth === 0 && /^\s*SELECT\b/i.test(cleaned.slice(i))) break;

    if (depth === 0 && expectingName) {
      const m = cleaned.slice(i).match(/^\s*([A-Za-z_][\w]*)(?:\s+|\s*\([^)]*\)\s*)AS\s*\(/i);
      if (!m) break;
      names.add(m[1].toLowerCase());
      i += m[0].length;
      depth = 1;
      expectingName = false;
      continue;
    }

    if (depth === 0 && ch === ",") expectingName = true;
    i++;
  }

  return names;
}

/**
 * Belt-and-suspenders CTE detection: any `name AS (` in a read-only SELECT is a
 * CTE header (column aliases never precede parens). The stateful walker in
 * extractCteNames can bail early on unusual-but-valid WITH clauses, which made
 * the allowlist flag CTE names as unknown tables (A13/July 5 scoreboard,
 * error "table_allowlist:agency_or,min_max,years").
 */
function extractCteNamesLoose(sql: string): Set<string> {
  const names = new Set<string>();
  const re = /\b([A-Za-z_][\w]*)(?:\s+|\s*\([^)]*\)\s*)AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (!/^(?:cast|select)$/i.test(m[1])) names.add(m[1].toLowerCase());
  }
  return names;
}

export function extractReferencedTables(sql: string): string[] {
  const cleaned = stripSqlStrings(sql);
  const ctes = extractCteNames(cleaned);
  for (const name of extractCteNamesLoose(cleaned)) ctes.add(name);
  const tables = new Set<string>();
  const tableRe = /\b(?:FROM|JOIN)\s+(?!\()(?:(?:main|temp)\.)?([A-Za-z_][\w]*)\b/gi;
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(cleaned)) !== null) {
    const table = m[1].toLowerCase();
    if (ctes.has(table) || BUILTIN_TABLE_LIKE.has(table)) continue;
    tables.add(table);
  }

  // Comma-joined items, reported as the FROM/JOIN pattern above would: a main/temp prefix is dropped,
  // any other schema prefix is what gets reported (e.g. "rollup").
  for (const item of commaFromItems(cleaned)) {
    if (!item.table) continue;
    const schema = item.schema?.toLowerCase();
    const table = schema && schema !== "main" && schema !== "temp" ? schema : item.table.toLowerCase();
    if (ctes.has(table) || BUILTIN_TABLE_LIKE.has(table)) continue;
    tables.add(table);
  }

  return [...tables];
}

export function getAvailableTables(db: Database.Database | null): string[] {
  if (!db) return [];
  try {
    const rows = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[];
    return rows.map((r) => r.name);
  } catch {
    return [];
  }
}

export function validateTablesForTab(sql: string, tab: QueryTab, db: Database.Database | null): {
  ok: boolean;
  unknown: string[];
  available: string[];
  message: string;
  fired: string[];
} {
  const available = getAvailableTables(db);
  const allowed = new Set(available.map((t) => t.toLowerCase()));
  const referenced = extractReferencedTables(sql);
  const unknown = referenced.filter((t) => !allowed.has(t.toLowerCase()));
  const fired = unknown.length > 0 ? [`${tab}-table-allowlist`] : [];
  const shownTables = available.slice(0, 80).join(", ");
  const message = unknown.length > 0
    ? `The SQL references table(s) that do not exist in the active ${tab} database: ${unknown.join(", ")}. Available tables/views include: ${shownTables}. Rewrite the query using only tables from this active database.`
    : "";

  return { ok: unknown.length === 0, unknown, available, message, fired };
}
