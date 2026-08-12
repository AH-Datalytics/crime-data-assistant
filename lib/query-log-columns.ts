/**
 * Building a query_log INSERT whose columns and values cannot desynchronize.
 *
 * WHY THIS EXISTS. Both loggers previously assembled an INSERT by string
 * concatenation with a parallel hand-counted placeholder arithmetic:
 *
 *   const columns = BASE + (withChartConfig ? ", chart_config" : "") + ...
 *   const placeholders = new Array(16 + (withChartConfig ? 1 : 0) + ...).fill("?")
 *   const values = [ ...sixteen positional values... ]
 *   if (withChartConfig) values.push(chartConfigJson)
 *
 * Three independent sequences had to agree by hand. When they disagree the
 * prepare() throws, the throw is swallowed by the surrounding catch, and EVERY
 * log write is lost silently -- which is how the repository ended up
 * investigating a production defect by replaying requests against the live API.
 * Stage 1 adds six more columns to both loggers; that arithmetic does not scale.
 *
 * Here the caller supplies one logical row as a name -> value map, and the column
 * list, placeholder list, and value list are all derived from that single object.
 * They cannot drift, because there is only one of them.
 *
 * The second job is deploy-order tolerance (handoff §12.6: migrations must be
 * "additive, nullable, deploy-order tolerant, and readable by the baseline
 * application"). Any column absent from the table is dropped from the insert
 * rather than failing it, so:
 *
 *   - a migrated release writing to an unmigrated database logs as it did before;
 *   - the baseline release c2b52ca writing to a migrated database logs as it did
 *     before, leaving the new columns NULL.
 */

/** Columns query_log is created with, and which therefore always exist. */
export const QUERY_LOG_BASE_COLUMNS: readonly string[] = [
  "ts",
  "tab",
  "question",
  "sql",
  "rows",
  "error",
  "ms",
  "response",
  "guardrails",
  "model",
  "session_id",
  "routing_confidence",
  "routing_mode",
  "routing_reason",
  "query_guidance",
  "query_contract",
] as const;

/**
 * Columns added by migration, which may or may not be present.
 *
 * Listed for documentation and for the migration tests to assert against; the
 * builder itself does not consult this list, because it checks every column
 * against the live table rather than trusting a hardcoded expectation.
 */
export const QUERY_LOG_MIGRATED_COLUMNS: readonly string[] = [
  "chart_config",
  "model_response",
  "request_id",
  "delivery_action",
  "proof_manifest",
  "result_digest",
  "proof_schema_version",
  "proof_mode",
  "plan_family",
] as const;

interface PragmaCapable {
  prepare: (sql: string) => { all: () => Array<{ name: string }> };
}

/**
 * The set of columns query_log actually has, cached per database handle.
 *
 * A WeakMap keyed on the handle rather than a module-level variable: the cache
 * then expires naturally whenever the handle is discarded, and two handles to
 * different files (production vs. the temp-directory fallback, or a test
 * fixture) cannot read each other's schema.
 *
 * CACHE LIFETIME AND MIGRATIONS. getWriteDb() holds one handle for the lifetime
 * of the process, so a migration applied while the app is running will not be
 * observed until the next PM2 reload. That is correct for the intended sequence
 * (back up -> migrate -> deploy, and a deploy reloads), and it is the safe
 * direction to fail: the app keeps writing the columns it knows exist. Do not
 * replace this with a TTL to "fix" it -- re-reading PRAGMA table_info on the hot
 * logging path buys nothing the deploy does not already provide.
 */
const columnSetCache = new WeakMap<object, Set<string>>();

export function queryLogColumnSet(db: object): Set<string> {
  const cached = columnSetCache.get(db);
  if (cached !== undefined) return cached;
  let columns: Set<string>;
  try {
    const rows = (db as PragmaCapable).prepare("PRAGMA table_info(query_log)").all();
    columns = new Set(rows.map((row) => row.name));
  } catch {
    // An unreadable schema means we cannot prove any column exists. Returning an
    // empty set makes buildQueryLogInsert() produce no statement at all, which
    // the callers already treat as "logging unavailable" -- the same outcome as
    // a failed prepare(), reached without throwing on the request path.
    columns = new Set();
  }
  columnSetCache.set(db, columns);
  return columns;
}

export function queryLogHasColumn(db: object, column: string): boolean {
  return queryLogColumnSet(db).has(column);
}

export interface QueryLogInsert {
  sql: string;
  values: unknown[];
  /** Columns dropped because the table does not have them. For diagnostics. */
  omitted: string[];
}

/**
 * Build the INSERT for one logical row.
 *
 * Returns null when no column of the row exists in the table, which means there
 * is nothing meaningful to write. Callers treat null as "skip logging" rather
 * than as an error, matching the pre-existing fail-quiet behavior of both
 * loggers: query logging is diagnostic, and losing a log row must never turn
 * into a failed user request.
 *
 * `undefined` values are dropped; `null` values are written. The distinction is
 * deliberate -- "this call site has no opinion about the column" and "this call
 * site asserts the column is empty" are different facts, and only the second
 * should overwrite anything.
 */
export function buildQueryLogInsert(
  db: object,
  row: Record<string, unknown>,
): QueryLogInsert | null {
  const present = queryLogColumnSet(db);
  const columns: string[] = [];
  const values: unknown[] = [];
  const omitted: string[] = [];

  for (const [column, value] of Object.entries(row)) {
    if (value === undefined) continue;
    if (!present.has(column)) {
      omitted.push(column);
      continue;
    }
    columns.push(column);
    values.push(value);
  }

  if (columns.length === 0) return null;

  const placeholders = columns.map(() => "?").join(", ");
  return {
    sql: `INSERT INTO query_log (${columns.join(", ")}) VALUES (${placeholders})`,
    values,
    omitted,
  };
}
