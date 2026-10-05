/**
 * Historical offense binding (Codex scope, handoff :35871). A Historical Library request for SEXUAL ASSAULT is answered
 * with the FBI UCR RAPE measure -- the source's supported category for it -- and never with another offense column.
 *
 * Why: in the 10-05 window the question "national, sexual assault, 2010-2024" was answered with
 * `SELECT year, aggravated_assault ...` (fifteen aggravated-assault values), although the Historical prompt already says
 * "sexual assault" means the `rape` column. A prompt sentence is not enforcement, so the shared contract validator now
 * binds the measure on every validation pass (initial, post-retry, pre-validation, structural retry, execution):
 *   - in the simple supported form (one plain SELECT of bare key columns and exactly ONE bare offense column from
 *     historical_state_national or historical_agency_crime [joined to historical_agency on ori]) a different offense
 *     column is rebound to `rape` (or `rape_rate` for a rate column), keeping period, geography and count/rate;
 *   - any other statement that does not select only the rape measure gets a precise retry instruction, and the existing
 *     second-failure stop if the retry is still wrong. Aggravated-assault rows are never relabelled as rape.
 * Intent is deliberately narrow: "sexual assault(s)" with no other offense or measure family named, no negation and no
 * "aggravated". Explicit aggravated-assault requests, mixed requests and exclusions are left to the normal path.
 * Not a SQL parser: anything it cannot establish is untouched or retried, never guessed.
 */
import { RAPE_DEFINITION_CAVEAT } from "./historical-rape-series";
import { nationalOnlyWhere } from "./historical-composite-measure";

const SEXUAL_ASSAULT = /\bsexual(?:ly)?[\s-]+assault(?:s|ed)?\b/gi;
// Any other offense or measure family named alongside it makes the request mixed: leave it to the normal path.
const OTHER_OFFENSE = /\b(?:assaults?|aggravated|murders?|homicides?|manslaughter|robber(?:y|ies)|burglar(?:y|ies)|thefts?|larcen(?:y|ies)|arsons?|violent|property|motor\s+vehicle|auto\s+theft|carjack\w*|shootings?|clearances?|arrests?|staffing|officers?)\b/i;
const NEGATION = /\b(?:not|excluding|exclude[sd]?|except|without|other\s+than|besides|minus|aside\s+from|apart\s+from)\b/i;

/** True when the question asks for sexual assault alone (the measure the source carries as UCR rape). */
export function sexualAssaultIntent(question: string): boolean {
  const q = question || "";
  if (!new RegExp(SEXUAL_ASSAULT.source, "i").test(q)) return false;
  const rest = q.replace(SEXUAL_ASSAULT, " ");
  return !OTHER_OFFENSE.test(rest) && !NEGATION.test(q);
}

const OFFENSE_COLUMNS = ["murder", "rape", "robbery", "aggravated_assault", "burglary", "larceny", "motor_vehicle_theft", "arson", "violent_crime", "property_crime"];
const OFFENSE = new Set([...OFFENSE_COLUMNS, ...OFFENSE_COLUMNS.map((c) => `${c}_rate`)]);
const KEY_COLUMNS = new Set(["year", "state", "state_name", "state_abbr", "agency", "agency_name", "ori", "population"]);
const TABLE_REF = (t: string) => String.raw`${t}(?:\s+(?:as\s+)?(?!(?:join|inner|left|on|where|order|limit)\b)[A-Za-z_][A-Za-z0-9_]*)?`;
const FROM_FORMS = [
  new RegExp(String.raw`^${TABLE_REF("historical_state_national")}$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency_crime")}$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency_crime")}\s+(?:inner\s+|left\s+)?join\s+${TABLE_REF("historical_agency")}\s+on\s+\w+\.ori\s*=\s*\w+\.ori$`, "i"),
  new RegExp(String.raw`^${TABLE_REF("historical_agency")}\s+(?:inner\s+|left\s+)?join\s+${TABLE_REF("historical_agency_crime")}\s+on\s+\w+\.ori\s*=\s*\w+\.ori$`, "i"),
];

/** Offense columns a statement references (word-bounded, string literals and comments removed). */
export function offenseColumnsIn(sql: string): string[] {
  const s = (sql || "").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''");
  return [...OFFENSE].filter((c) => new RegExp(String.raw`(?:^|[^A-Za-z0-9_])${c}(?![A-Za-z0-9_])`, "i").test(s));
}

/**
 * OB-R1a (Codex :35951): the ONE returned offense measure of the simple supported form, established structurally --
 * one plain SELECT (no CTE, subquery, parentheses, aggregate, expression or `*`) FROM a supported Historical table, whose
 * select items are the bare `year`, other bare key columns (never aliased to another name) and exactly ONE bare offense
 * column. A name appearing elsewhere (an alias such as `population AS rape`, an inner reference, an expression) is not
 * a returned measure: null.
 */
function simpleOffenseItem(sql: string): { prefix: string | undefined; column: string; alias: string | undefined } | null {
  const structural = (sql || "").replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, " ").trim().replace(/;$/, "").trim();
  if ((structural.match(/\bselect\b/gi) || []).length !== 1) return null;
  if (/\b(with|union|intersect|except|group\s+by|having|over|window|distinct)\b/i.test(structural)) return null;
  const m = /^select\s+(.+?)\s+from\s+(.+?)(?:\s+where\s.*?)?(?:\s+order\s+by\s.*?)?(?:\s+limit\s+\d+(?:\s+offset\s+\d+)?)?$/i.exec(structural);
  if (!m || !FROM_FORMS.some((f) => f.test(m[2].trim())) || /[()*]/.test(m[1])) return null;
  const item = /^(?:([A-Za-z_][A-Za-z0-9_]*)\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+(?:as\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?)?$/i;
  let offense: { prefix: string | undefined; column: string; alias: string | undefined } | null = null;
  let hasYear = false;
  for (const raw of m[1].split(",")) {
    const im = item.exec(raw.trim());
    if (!im) return null;
    const column = im[2].toLowerCase();
    if (OFFENSE.has(column)) {
      if (offense) return null;
      offense = { prefix: im[1], column, alias: im[3] };
    } else if (KEY_COLUMNS.has(column) && (!im[3] || im[3].toLowerCase() === column)) {
      if (column === "year") hasYear = true;
    } else return null;
  }
  return offense && hasYear ? offense : null;
}

/** True only when the statement's returned measure IS the bare rape column (or rape rate), unaliased or aliased to itself. */
export function returnsRapeMeasure(sql: string): "rape" | "rape_rate" | null {
  const o = simpleOffenseItem(sql);
  if (!o || (o.column !== "rape" && o.column !== "rape_rate")) return null;
  return !o.alias || o.alias.toLowerCase() === o.column ? (o.column as "rape" | "rape_rate") : null;
}

/**
 * The simple supported form with exactly one offense column, rebound to the rape measure (same count/rate unit); or
 * null when the statement is not that form. The returned SQL changes only that select item.
 */
export function rebindToRape(sql: string): string | null {
  const offense = simpleOffenseItem(sql);
  if (!offense) return null;
  const target = offense.column.endsWith("_rate") ? "rape_rate" : "rape";
  if (offense.column === target && (!offense.alias || offense.alias.toLowerCase() === target)) return sql;
  // Replace exactly that select item in the original statement (first occurrence, inside the select list).
  const selectEnd = sql.search(/\bfrom\b/i);
  const head = sql.slice(0, selectEnd), tail = sql.slice(selectEnd);
  const itemPattern = new RegExp(String.raw`(${offense.prefix ? `${offense.prefix}\\.` : ""})"?${offense.column}"?(\s+(?:as\s+)?"?[A-Za-z_][A-Za-z0-9_]*"?)?(?=\s*(?:,|$))`, "i");
  if (!itemPattern.test(head)) return null;
  return head.replace(itemPattern, (_all, pre) => `${pre ?? ""}${target}`) + tail;
}

export type OffenseBinding = { kind: "none" } | { kind: "bound" } | { kind: "rebound"; sql: string } | { kind: "retry"; issue: string };

/** What the contract validator does for a Historical statement. */
export function bindSexualAssaultMeasure(question: string, sql: string): OffenseBinding {
  if (!sexualAssaultIntent(question)) return { kind: "none" };
  // OB-R1a: bound only when the RETURNED measure is proven to be the rape column -- never because a rape token appears.
  if (returnsRapeMeasure(sql)) return { kind: "bound" };
  const rebound = rebindToRape(sql);
  if (rebound && rebound !== sql && returnsRapeMeasure(rebound)) return { kind: "rebound", sql: rebound };
  return {
    kind: "retry",
    issue: "[SYSTEM: Query contract violation (contract-sexual-assault-rape-measure). The user asked about sexual assault. In the Historical Library that is the FBI UCR rape measure. Return it as a plain column: SELECT year[, place columns], rape (or rape_rate for a rate) FROM historical_state_national, or FROM historical_agency_crime joined to historical_agency, with no alias, expression, subquery or other offense column. Do not answer with aggravated assault, population or any other value. Keep the requested place, period and count/rate.]",
  };
}

/**
 * The application-owned description for a sexual-assault request answered with the rape measure, in every version:
 * the UCR category limitation always, and the 2013 definition caveat when the returned years cross it. Null when the
 * request is not sexual-assault intent or the statement is not the bound simple rape form.
 */
export function sexualAssaultRapeNarrative(tab: string, question: string, sql: string | null | undefined, rows: Record<string, unknown>[]): string | null {
  if (tab !== "historical" || !sql || !Array.isArray(rows) || rows.length === 0 || !sexualAssaultIntent(question)) return null;
  // OB-R1a: only for a statement whose returned measure is proven to be the rape column, and whose rows carry it.
  const measure = returnsRapeMeasure(sql);
  if (!measure || !Object.keys(rows[0]).some((c) => c.toLowerCase() === measure)) return null;
  const years = [...new Set(rows.map((r) => Number(r.year)).filter(Number.isInteger))].sort((a, b) => a - b);
  if (years.length === 0) return null;
  // OB-R1b: name a place only when it is PROVEN -- "nationally" for a national-only WHERE established by the accepted
  // positive binding (CM-R1 nationalOnlyWhere: one state = 'United States' plus year bounds in a plain AND chain, string
  // literals masked); otherwise no place is named. An equality inside NOT(...) or an OR is never taken as the geography.
  const where = /\bwhere\s+(.+?)(?:\s+order\s+by\s|\s+limit\s|;|$)/i.exec((sql || "").replace(/\s+/g, " "));
  const place = where && nationalOnlyWhere(where[1].trim()) && /\bfrom\s+historical_state_national\b/i.test(sql) ? " nationally" : "";
  const unit = measure === "rape_rate" ? "rape rate per 100,000" : "rape offenses";
  const span = years[0] === years[years.length - 1] ? `${years[0]}` : `${years[0]}–${years[years.length - 1]}`;
  const crosses = years[0] <= 2012 && years[years.length - 1] >= 2013;
  return `FBI UCR ${unit}${place} by year, ${span}, for the sexual assault request. These are the FBI's Uniform Crime Reporting rape category, not all sexual assaults.${crosses ? ` ${RAPE_DEFINITION_CAVEAT}` : ""}`;
}
