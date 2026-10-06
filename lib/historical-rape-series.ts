/**
 * GC-085 (Codex scope, handoff :33584): the Historical Library's annual UCR RAPE-COUNT series that crosses the FBI's
 * 2013 rape-definition change gets an APPLICATION-OWNED, neutral description and caveat in every explanation the
 * user can read (the first result, the refined explanation, its retry, the both-failed fallback and a cached answer).
 *
 * Why owned prose rather than a contradiction detector: the saved answer said counts "increased substantially that
 * year due to this definitional change" while its own rows fell (84,608 in 2012, 80,180 in 2013), and the later
 * explanation dropped the definition note entirely. The user asked for a series, not commentary, so a neutral
 * description of what was returned is the supported answer; no direction or cause is asserted.
 *
 * Applies by RESOLVED source, measure and period -- never by the literal question or its numbers -- and only when the
 * RETURNED measure is positively established as the stored annual rape count (Codex correction ruling, :33700: a
 * `rape` mention in a CTE, expression, alias or literal must not relabel an outer rate or murder result):
 *   - shape: one plain SELECT (no CTE, subquery, UNION, grouping, window, DISTINCT or `*`) reading
 *     historical_state_national, or historical_agency_crime optionally joined to historical_agency on ori;
 *   - measure: exactly one select item is the bare stored `rape` column (an optional table prefix, an optional
 *     count-like alias), and every other item is a bare key column (year, state, agency...) -- no expression of any kind;
 *   - returned: the result's columns are exactly those select items' output names;
 *   - period: the returned years include one at or before 2012 AND one at or after 2013.
 * Anything it cannot establish returns null and the route's existing narrative path is untouched. This is a
 * recognizer of the simple supported count forms, not a SQL parser.
 */

import { singleStateWhere } from "./historical-composite-measure";

const KEY_COLUMNS = new Set(["year", "state", "state_name", "state_abbr", "agency", "agency_name", "ori"]);
// The only output names the stored count may carry. A positive list, so a rate- or change-like alias is never a count.
const COUNT_ALIASES = new Set(["rape", "rapes", "rape_count", "rape_counts", "rape_offenses", "rape_total", "total_rapes", "count", "offenses"]);
const ID = String.raw`"?[A-Za-z_][A-Za-z0-9_]*"?`;
const TABLE_REF = (table: string) => String.raw`${table}(?:\s+(?:as\s+)?(?!(?:join|inner|left|on|where|order|limit)\b)[A-Za-z_][A-Za-z0-9_]*)?`;
const FROM_FORMS = [
  new RegExp(String.raw`^${TABLE_REF("historical_state_national")}$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency_crime")}$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency_crime")}\s+(?:inner\s+|left\s+)?join\s+${TABLE_REF("historical_agency")}\s+on\s+\w+\.ori\s*=\s*\w+\.ori$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency")}\s+(?:inner\s+|left\s+)?join\s+${TABLE_REF("historical_agency_crime")}\s+on\s+\w+\.ori\s*=\s*\w+\.ori$`, "i"),
];

export const RAPE_DEFINITION_CAVEAT = "The FBI revised its rape definition in 2013; figures across that change may not be directly comparable.";

export type RapeSeries = { narrative: string; firstYear: number; lastYear: number; missingYears: number[] };

const unquote = (id: string) => id.replace(/"/g, "").toLowerCase();

/** The returned rape-count column's name when the SQL is one of the simple supported count forms; otherwise null. */
export function returnedRapeCountColumn(sql: string, returnedColumns: string[]): string | null {
  const structural = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "")
    .trim();
  if ((structural.match(/\bselect\b/gi) || []).length !== 1) return null;
  if (/\b(with|union|intersect|except|group\s+by|having|over|window|distinct)\b/i.test(structural)) return null;
  const m = /^select\s+(.+?)\s+from\s+(.+?)(?:\s+where\s.*?)?(?:\s+order\s+by\s.*?)?(?:\s+limit\s+\d+(?:\s+offset\s+\d+)?)?$/i.exec(structural);
  if (!m) return null;
  const [, selectList, fromClause] = m;
  if (!FROM_FORMS.some((f) => f.test(fromClause.trim()))) return null;
  if (/[()*]/.test(selectList)) return null;

  const item = new RegExp(String.raw`^(?:[A-Za-z_][A-Za-z0-9_]*\.)?(${ID})(?:\s+(?:as\s+)?(${ID}))?$`, "i");
  const outputs: string[] = [];
  let measure: string | null = null;
  let hasYear = false;
  for (const raw of selectList.split(",")) {
    const im = item.exec(raw.trim());
    if (!im) return null;
    const column = unquote(im[1]);
    const output = im[2] ? unquote(im[2]) : column;
    if (column === "rape") {
      if (measure !== null || !COUNT_ALIASES.has(output)) return null;
      measure = output;
    } else if (KEY_COLUMNS.has(column) && output === column) {
      if (column === "year") hasYear = true;
    } else {
      return null;
    }
    outputs.push(output);
  }
  if (!measure || !hasYear) return null;
  // The rows must be exactly what that select list returns.
  const returned = returnedColumns.map((c) => c.toLowerCase());
  if (returned.length !== outputs.length || !outputs.every((o) => returned.includes(o))) return null;
  return returnedColumns.find((c) => c.toLowerCase() === measure) ?? null;
}

const listYears = (ys: number[]) => (ys.length <= 1 ? ys.join("") : `${ys.slice(0, -1).join(", ")} and ${ys[ys.length - 1]}`);

export function historicalRapeSeries(tab: string, sql: string | null | undefined, rows: Record<string, unknown>[]): RapeSeries | null {
  if (tab !== "historical" || !sql || !Array.isArray(rows) || rows.length === 0) return null;
  const columns = Object.keys(rows[0]);
  const measure = returnedRapeCountColumn(sql, columns);
  if (!measure) return null;
  const years = [...new Set(rows.map((r) => Number(r.year)).filter((y) => Number.isInteger(y)))].sort((a, b) => a - b);
  if (years.length === 0 || years[0] > 2012 || years[years.length - 1] < 2013) return null;

  // Place, from what was queried and returned (no new source read).
  const distinct = (col: string) => [...new Set(rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== ""))];
  const stateCol = columns.find((c) => /^state(_name)?$/i.test(c));
  const agencyCol = columns.find((c) => /^(agency|agency_name)$/i.test(c));
  // AGENCY+RANK batch (the deferred GC-085 residual, :36036): a place is named from the SQL only when it is PROVEN by the
  // accepted national-only binding (CM-R1 nationalOnlyWhere, generalized as singleStateWhere); a `state = '...'` substring inside NOT(...)
  // or an OR used to be read as the geography. Otherwise the place comes from the returned rows, or stays neutral.
  const where = /\bwhere\s+(.+?)(?:\s+order\s+by\s|\s+limit\s|;|$)/i.exec(sql.replace(/\s+/g, " "));
  const provenState = where && /\bfrom\s+historical_state_national\b/i.test(sql) ? singleStateWhere(where[1].trim()) : null;
  const onlyState = stateCol && distinct(stateCol).length === 1 ? String(distinct(stateCol)[0]) : null;
  const named = (state: string) => (state === "United States" ? "nationally" : `in ${state}`);
  let place = "for the requested places";
  if (provenState && !(stateCol && distinct(stateCol).length > 1)) place = named(provenState);
  else if (agencyCol && distinct(agencyCol).length === 1) place = `for ${String(distinct(agencyCol)[0])}`;
  else if (onlyState) place = named(onlyState);

  // Missing values are stated, never treated as zero. For one place, name the years. The wording describes the RETURNED
  // RESULTS only: governFactualNarrative removes a "no figures/data" claim about the place unless a missing report is
  // established, and this note asserts nothing about why a value is absent.
  const multiPlace = (stateCol && distinct(stateCol).length > 1) || (agencyCol && distinct(agencyCol).length > 1);
  const firstYear = years[0], lastYear = years[years.length - 1];
  const missingYears: number[] = [];
  if (!multiPlace) {
    const valueByYear = new Map(rows.map((r) => [Number(r.year), r[measure]]));
    for (let y = firstYear; y <= lastYear; y++) {
      const v = valueByYear.get(y);
      if (v === undefined || v === null || v === "") missingYears.push(y);
    }
  }
  const anyNull = rows.some((r) => r[measure] === null || r[measure] === undefined || r[measure] === "");
  const missingSentence = missingYears.length > 0
    ? ` The returned results include no value for ${listYears(missingYears)}.`
    : multiPlace && anyNull ? " The returned results include no value for some years and places." : "";

  const narrative = `FBI UCR rape offenses ${place} by year, ${firstYear}–${lastYear}. These are the FBI's Uniform Crime Reporting rape category, not all sexual assaults.${missingSentence} ${RAPE_DEFINITION_CAVEAT}`;
  return { narrative, firstYear, lastYear, missingYears };
}
