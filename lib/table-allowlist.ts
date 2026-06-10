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
      const m = cleaned.slice(i).match(/^\s*([A-Za-z_][\w]*)\s+(?:\([^)]*\)\s*)?AS\s*\(/i);
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

export function extractReferencedTables(sql: string): string[] {
  const cleaned = stripSqlStrings(sql);
  const ctes = extractCteNames(cleaned);
  const tables = new Set<string>();
  const tableRe = /\b(?:FROM|JOIN)\s+(?!\()(?:(?:main|temp)\.)?([A-Za-z_][\w]*)\b/gi;
  let m: RegExpExecArray | null;

  while ((m = tableRe.exec(cleaned)) !== null) {
    const table = m[1].toLowerCase();
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
