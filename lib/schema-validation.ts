type SqliteStatement = { all?: () => unknown[] };
type ReadonlySqliteDb = { prepare: (sql: string) => SqliteStatement };

export type SchemaValidation = {
  ok: boolean;
  sql: string;
  corrected: boolean;
  error?: string;
};

const schemaCache = new WeakMap<object, Map<string, Set<string>>>();

export function clearSchemaValidationCache(db: object): void {
  schemaCache.delete(db);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function referencedTables(sql: string): string[] {
  const tables = new Set<string>();
  const pattern = /\b(?:from|join)\s+([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)?)/gi;
  for (const match of sql.matchAll(pattern)) tables.add(match[1].toLowerCase());
  return [...tables];
}

function loadColumns(db: ReadonlySqliteDb, tableRef: string): Set<string> {
  let dbCache = schemaCache.get(db as object);
  if (!dbCache) {
    dbCache = new Map();
    schemaCache.set(db as object, dbCache);
  }
  const cached = dbCache.get(tableRef);
  if (cached) return cached;

  const parts = tableRef.split(".");
  const table = parts.pop()!;
  const schema = parts.pop();
  const pragma = schema
    ? `PRAGMA ${quoteIdentifier(schema)}.table_info(${quoteIdentifier(table)})`
    : `PRAGMA table_info(${quoteIdentifier(table)})`;
  const columns = new Set<string>();
  try {
    for (const row of (db.prepare(pragma).all?.() ?? []) as Array<{ name?: string }>) {
      if (row.name) columns.add(row.name.toLowerCase());
    }
  } catch {
    // EXPLAIN below remains the authoritative check for views/CTEs and unusual schemas.
  }
  dbCache.set(tableRef, columns);
  return columns;
}

function hasArresteeColumn(db: ReadonlySqliteDb, sql: string): boolean {
  return referencedTables(sql).some((table) => {
    if (!/(?:^|_)(?:summary_)?arrestee_demographics$/.test(table)) return false;
    return loadColumns(db, table).has("arrestee_count");
  });
}

function explain(db: ReadonlySqliteDb, sql: string): string | null {
  try {
    db.prepare(`EXPLAIN ${sql}`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateSqlSchema(db: ReadonlySqliteDb, sql: string): SchemaValidation {
  const directError = explain(db, sql);
  if (!directError) return { ok: true, sql, corrected: false };

  // This is intentionally narrow: arrest_count and arrestee_count are not
  // interchangeable generally, but the NIBRS arrestee summary tables have one
  // canonical count column and this typo has appeared in production retries.
  if (/\barrest_count\b/i.test(sql) && !/\barrestee_count\b/i.test(sql) && hasArresteeColumn(db, sql)) {
    const correctedSql = sql.replace(/\barrest_count\b/gi, "arrestee_count");
    const correctedError = explain(db, correctedSql);
    if (!correctedError) return { ok: true, sql: correctedSql, corrected: true };
  }

  return { ok: false, sql, corrected: false, error: directError };
}
