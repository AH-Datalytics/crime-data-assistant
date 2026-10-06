/**
 * Composite-measure narrative (Codex scope, handoff :35465). The Historical Library's U.S. NATIONAL annual violent-crime
 * composite -- an explicit sum of the four FBI UCR violent components -- gets an APPLICATION-OWNED description in every
 * explanation the user can read (the first result, the refined explanation, its retry, the both-failed fallback and a
 * cached answer), the same delivery the GC-085 rape series uses.
 *
 * Why: in the 10-05 COVER window the delivered SQL summed murder, rape, robbery and aggravated assault, but the model's
 * refined explanation said "murder, rape, and robbery counts", contradicting the first answer and the measure itself.
 * The description is derived from the established SQL binding, never from the question, a suggestive alias or a second
 * model judgment, and it makes no source-availability or reporting claim (the per-series returned-value coverage is added
 * afterwards by the existing disclosures).
 *
 * Recognized (a bounded recognizer of the supported forms, not a SQL parser):
 *   - shape: one plain SELECT (no CTE, subquery, UNION, grouping, window or DISTINCT) FROM historical_state_national
 *     (optional alias), whose WHERE is PROVEN national-only by nationalOnlyWhere (CM-R1);
 *   - select list: the bare `year` column and exactly ONE composite item with an alias: a `+` sum of exactly four terms
 *     that are, once each, either all four counts (murder, rape, robbery, aggravated_assault) or all four rates
 *     (murder_rate, rape_rate, robbery_rate, aggravated_assault_rate); each term bare, table-prefixed, or wrapped in
 *     COALESCE(term, 0) / IFNULL(term, 0); the whole sum optionally wrapped in ROUND(sum, n);
 *   - returned: the result's columns are exactly year and that alias.
 * A three-component sum, any other column or expression, per-state rows, or anything not established returns null and the
 * route's existing narrative is untouched.
 */

const COUNTS = ["murder", "rape", "robbery", "aggravated_assault"];
const RATES = COUNTS.map((c) => `${c}_rate`);

export type CompositeMeasure = { column: string; kind: "count" | "rate"; zeroFilled: boolean };
export type CompositeSeries = { narrative: string; measure: CompositeMeasure };

const structuralOf = (sql: string) => sql
  .replace(/--[^\n]*/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .replace(/;$/, "")
  .trim();

/** Splits on commas outside parentheses. */
function topLevel(list: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of list) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/**
 * CM-R1 (Codex :35546): a POSITIVE proof that the WHERE clause restricts every returned row to the United States, or
 * false. A substring is not proof (`NOT (state = 'United States') AND state = 'Alabama'` and
 * `(state = 'United States' OR state = 'Alabama')` both contain it). With string literals masked, the clause must be a
 * plain AND chain -- no OR, NOT, parentheses or anything else -- whose conjuncts are exactly one
 * `[alias.]state = 'United States'` equality plus optional year bounds (`year <op> NNNN`, `year BETWEEN NNNN AND NNNN`).
 * Anything else (another column, another literal, a second state predicate, an unrecognized shape) is not established,
 * and the answer stays on the normal path.
 */
export function nationalOnlyWhere(where: string): boolean {
  return singleStateWhere(where) === "United States";
}

/**
 * AGENCY+RANK batch: the same proof, naming its one state. The WHERE is a plain AND chain of exactly one
 * `state = '<literal>'` plus year bounds; anything else returns null. `nationalOnlyWhere` is this with the
 * literal 'United States', so its accepted behavior is unchanged.
 */
export function singleStateWhere(where: string): string | null {
  const literals: string[] = [];
  const masked = where.replace(/'(?:[^']|'')*'/g, (lit) => { literals.push(lit); return ` __L${literals.length - 1}__ `; }).replace(/\s+/g, " ").trim();
  if (/[()]/.test(masked) || /\b(or|not|exists|select|in|like|is|case|between\s+symmetric)\b/i.test(masked.replace(/\byear\s+between\s+\d{4}\s+and\s+\d{4}\b/gi, ""))) return null;
  const conjuncts = masked
    .replace(/\b((?:[A-Za-z_][A-Za-z0-9_]*\.)?year)\s+between\s+(\d{4})\s+and\s+(\d{4})\b/gi, "$1 __BETWEEN__ $2 $3")
    .split(/\s+and\s+/i).map((c) => c.trim());
  const states: string[] = [];
  for (const c of conjuncts) {
    const st = /^(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?state"?\s*=\s*__L(\d+)__$/i.exec(c);
    if (st) {
      states.push(literals[Number(st[1])].slice(1, -1).replace(/''/g, "'"));
      continue;
    }
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?year"?\s*(?:=|>=|<=|>|<)\s*\d{4}$/i.test(c)) continue;
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?year"?\s+__BETWEEN__\s+\d{4}\s+\d{4}$/i.test(c)) continue;
    return null;
  }
  return states.length === 1 && states[0] !== "" ? states[0] : null;
}

const COLUMN = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?`;
const TERM = [new RegExp(String.raw`^${COLUMN}$`, "i"), new RegExp(String.raw`^(?:coalesce|ifnull)\s*\(\s*${COLUMN}\s*,\s*0(?:\.0+)?\s*\)$`, "i")];

/** The composite's description when the SQL and returned columns are one of the supported forms; otherwise null. */
export function returnedViolentComposite(sql: string, returnedColumns: string[]): CompositeMeasure | null {
  const s = structuralOf(sql);
  const literalFree = s.replace(/'(?:[^']|'')*'/g, "''");
  if ((literalFree.match(/\bselect\b/gi) || []).length !== 1) return null;
  if (/\b(with|union|intersect|except|group\s+by|having|over|window|distinct)\b/i.test(literalFree)) return null;
  const m = /^select\s+(.+?)\s+from\s+(.+?)\s+where\s+(.+?)(?:\s+order\s+by\s.*?)?(?:\s+limit\s+\d+(?:\s+offset\s+\d+)?)?$/i.exec(s);
  if (!m) return null;
  const [, selectList, fromClause, where] = m;
  if (!/^historical_state_national(?:\s+(?:as\s+)?[A-Za-z_][A-Za-z0-9_]*)?$/i.test(fromClause.trim())) return null;
  if (!nationalOnlyWhere(where)) return null;

  let composite: CompositeMeasure | null = null; let hasYear = false; const outputs: string[] = [];
  for (const raw of topLevel(selectList)) {
    const aliased = /^(.+?)\s+(?:as\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?$/i.exec(raw);
    if (/^(?:[A-Za-z_][A-Za-z0-9_]*\.)?"?year"?$/i.test(raw)) { hasYear = true; outputs.push("year"); continue; }
    if (!aliased) return null;
    let expr = aliased[1].trim(); const alias = aliased[2];
    const round = /^round\s*\(\s*(.+)\s*,\s*\d+\s*\)$/i.exec(expr);
    if (round) expr = round[1].trim();
    if (/^\(.*\)$/.test(expr)) expr = expr.slice(1, -1).trim();
    const terms = expr.split("+").map((t) => t.trim());
    if (terms.length !== 4) return null;
    const cols: string[] = []; let zeroFilled = false;
    for (const t of terms) {
      const bare = TERM[0].exec(t), filled = TERM[1].exec(t);
      if (bare) cols.push(bare[1].toLowerCase());
      else if (filled) { cols.push(filled[1].toLowerCase()); zeroFilled = true; }
      else return null;
    }
    const set = new Set(cols);
    const kind = COUNTS.every((c) => set.has(c)) && set.size === 4 ? "count" : RATES.every((c) => set.has(c)) && set.size === 4 ? "rate" : null;
    if (!kind || composite) return null;
    composite = { column: alias, kind, zeroFilled };
    outputs.push(alias.toLowerCase());
  }
  if (!composite || !hasYear) return null;
  const returned = returnedColumns.map((c) => c.toLowerCase());
  if (returned.length !== outputs.length || !outputs.every((o) => returned.includes(o))) return null;
  return { ...composite, column: returnedColumns.find((c) => c.toLowerCase() === composite!.column.toLowerCase()) ?? composite.column };
}

export function historicalViolentComposite(tab: string, sql: string | null | undefined, rows: Record<string, unknown>[]): CompositeSeries | null {
  if (tab !== "historical" || !sql || !Array.isArray(rows) || rows.length === 0) return null;
  const measure = returnedViolentComposite(sql, Object.keys(rows[0]));
  if (!measure) return null;
  const what = measure.kind === "count"
    ? "the sum of the FBI UCR murder, rape, robbery and aggravated assault counts"
    : "the sum of the FBI UCR murder, rape, robbery and aggravated assault rates per 100,000";
  return { measure, narrative: `U.S. national violent crime by year: ${what}.` };
}
