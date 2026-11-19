/**
 * SQL for a set of ORIs, for a statement that names a state's or the nation's agencies.
 *
 * A national list (about 17,000 ORIs) costs DuckDB about 90 ms to parse each time it appears as a list literal; the same ORIs as
 * one string split inside DuckDB cost about 13 ms and the statement is 25% smaller. A short list (a state's: under BIG_LIST)
 * stays a plain list: `ori IN ('..', ..)` lets DuckDB skip the row groups of a raw table outside the set, while
 * `ori IN (SELECT ..)` does not (Texas, raw: 1 s and 380 MB with the list, 4 s and 2.4 GB through a subquery), and a short list parses in no time.
 * Anything but plain letters and digits (a comma or a quote would break the split) keeps the list literal.
 */
export const BIG_LIST = 2000;
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** An expression that yields one row per ORI: `SELECT <oriRows(oris)> AS ori`. */
export function oriRows(oris: string[]): string {
  if (oris.length > BIG_LIST && oris.every((o) => /^[A-Za-z0-9]+$/.test(o))) return `unnest(string_split('${oris.join(",")}', ','))`;
  return `unnest([${oris.map(q).join(", ")}])`;
}

/** `col IN (...)` over a set of ORIs: the plain list for a short set, the split string (through a subquery) for a national one. */
export function oriIn(col: string, oris: string[]): string {
  return oris.length > BIG_LIST ? `${col} IN (SELECT ${oriRows(oris)})` : `${col} IN (${oris.map(q).join(", ")})`;
}
