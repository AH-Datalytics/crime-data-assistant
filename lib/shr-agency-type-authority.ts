/**
 * SHR City/County membership authority for SQL the application runs (Codex combined ruling, 2026-10-02; corrected
 * under the SHR classification ruling, SCA-1/SCA-2).
 *
 * THE REQUEST DECIDES (SCA-1). Whether an answer depends on City/County membership, and WHICH category, comes from
 * the request (`requestedAgencyCategories`), never from the SQL's wording. When the request names a category, every
 * part of the statement that COUNTS `incidents` rows -- the scopes the returned values are computed over, reached
 * from the outer query through its FROM-clause relations (a used CTE, a derived table, each UNION arm) -- must carry
 * the classification:
 *   - `shr_agency_year_class` INNER-joined to that scope's `incidents` instance on all three keys
 *     (`c.ori = i.ori AND c.state = i.state AND c.year = i.year`: year-bound, one row per incident), and
 *   - a top-level `c.agency_type = '<the requested category>'` (for City, `c.membership = 'eligible'` is the same
 *     set). `membership = 'ineligible'` is NOT County, and a different category is not the one asked for.
 * A missing predicate, a classification in an UNUSED CTE or a filtering subquery, a separately classified instance,
 * or the wrong category cannot license the count. When the request names no category, a classification filter
 * would narrow the answer to agencies nobody asked about, so it is refused too; type-free totals are untouched.
 *
 * ALWAYS refused, whatever the request: `incidents.agency_type` (never source data) and the identity/alias tables'
 * legacy `agency_type`; an outer, OR'd, ORI-only or year-unbound classification.
 *
 * THE SCOPE IS WHAT WAS COUNTED (SCA-2). Each counting scope contributes its own year/state restriction; the
 * disclosure covers their UNION. A state or year restriction in a form this rule cannot read exactly (an OR, a
 * function, `<>`, NOT IN) is sent back rather than producing a precise but wrong exclusion count.
 */
import { analyzeSqlFacts, restrictingPredicates, scopeAliases, type ExprFact, type PredicateFact, type QueryFacts, type RelationFact } from "./sql-facts";
import { stripSqlComments } from "./sql-restriction";
import { SHR_YEAR_CLASS_TABLE, type ClassScope } from "./shr-agency-year-class";

export const SHR_AGENCY_TYPE_GUARDRAIL = "shr-agency-type-authority";

export type AgencyCategory = "City" | "County";

/**
 * The City/County categories a request depends on, from its words. Plural "cities" (or a city-agency phrase) asks
 * about City membership; a place NAME such as "Kansas City" or "New York City" is singular and does not. Sheriffs
 * and county agencies ask about County. Empty when the request does not depend on agency type.
 */
export function requestedAgencyCategories(question: string): AgencyCategory[] {
  const out: AgencyCategory[] = [];
  if (/\bcities\b|\bcity\s+(?:agencies|police(?:\s+departments?)?|departments?|governments?)\b|\b(?:big|large|major|small)\s+city\b/i.test(question)) out.push("City");
  if (/\bsheriffs\b|\bsheriff'?s'?\s+offices\b|\bsheriff'?s?\s+departments\b|\bcounty\s+(?:agencies|police\s+departments|law[-\s]enforcement(?:\s+agencies)?|sheriffs?)\b/i.test(question)) out.push("County");
  return out;
}

export type AgencyTypeVerdict =
  | { touches: false }
  | { touches: true; ok: true; scopes: ClassScope[] }
  | { touches: true; ok: false; problems: string[] };

/** The retry instruction for model SQL that broke the rule. */
export function agencyTypeRetryInstruction(categories: AgencyCategory[]): string {
  const asked = categories.length > 0
    ? `This question depends on ${categories.map((c) => (c === "City" ? "which agencies are cities" : "which agencies are county agencies")).join(" and ")}: ` +
      `in the part of the query that COUNTS incidents, join ${SHR_YEAR_CLASS_TABLE} c ON c.ori = i.ori AND c.state = i.state AND c.year = i.year ` +
      `(an INNER JOIN on all three) and filter ${categories.map((c) => `c.agency_type = '${c}'`).join(" or ")} as a plain AND condition on those counted rows ` +
      "(not in an unused CTE or a subquery). State places and years as plain AND conditions: i.state = 'XX' or i.state IN (...), i.year = N or i.year BETWEEN a AND b."
    : `This question does not ask for a city/county distinction: do not filter on agency type or join ${SHR_YEAR_CLASS_TABLE}.`;
  return "Do not use any agency_type column of incidents, shr_agency_identity or shr_agency_alias: those labels are not evidence. " + asked +
    " Agencies without a classification are excluded and the application discloses them.";
}

function columnRefs(e: ExprFact | null | undefined, out: { source: string | null; column: string }[] = []) {
  if (!e) return out;
  if (e.kind === "column") out.push(...e.refs);
  else if (e.kind === "rowcount") columnRefs(e.target, out);
  else if (e.kind === "aggregate" || e.kind === "derived") for (const x of e.inputs) columnRefs(x, out);
  return out;
}
const isCol = (e: ExprFact | null, alias: string, column: string) =>
  !!e && e.kind === "column" && e.refs.length === 1 && (e.refs[0].source ?? "").toLowerCase() === alias && e.refs[0].column.toLowerCase() === column;
const literalOf = (e: ExprFact | null) => (e && e.kind === "literal" ? e.value : undefined);
const armsOf = (rel: RelationFact): RelationFact[] => (rel.armScopes.length > 0 ? rel.armScopes : [rel]);

/** A counting scope's year/state restriction, exactly, or null when a restriction is in a form not read exactly. */
function scopeOf(preds: PredicateFact[], inc: string): ClassScope | null {
  let lo: number | null = null; let hi: number | null = null;
  let states: string[] | null = null;
  for (const p of preds) {
    // A column-to-column equality (the classification's own join keys, c.year = i.year) restricts no place or year.
    if (p.op === "=" && p.left?.kind === "column" && p.right?.kind === "column") continue;
    const refs = [...columnRefs(p.left), ...columnRefs(p.right)];
    const touches = (col: string) => refs.some((r) => (r.source ?? "").toLowerCase() === inc && r.column.toLowerCase() === col);
    const outer = p.position === "on" && p.joinKind && /\b(LEFT|RIGHT|FULL)\b/i.test(p.joinKind);
    if (touches("year")) {
      const v = literalOf(p.right);
      if (outer || !isCol(p.left, inc, "year")) return null;
      if (p.op === "=" && typeof v === "number") { lo = Math.max(lo ?? v, v); hi = Math.min(hi ?? v, v); continue; }
      if (p.op === ">=" && typeof v === "number") { lo = Math.max(lo ?? v, v); continue; }
      if (p.op === ">" && typeof v === "number") { lo = Math.max(lo ?? v + 1, v + 1); continue; }
      if (p.op === "<=" && typeof v === "number") { hi = Math.min(hi ?? v, v); continue; }
      if (p.op === "<" && typeof v === "number") { hi = Math.min(hi ?? v - 1, v - 1); continue; }
      if (p.op === "BETWEEN" && p.right?.kind === "derived" && p.right.op === "LIST") {
        const [a, b] = p.right.inputs.map(literalOf);
        if (typeof a === "number" && typeof b === "number") { lo = Math.max(lo ?? a, a); hi = Math.min(hi ?? b, b); continue; }
      }
      return null;
    }
    if (touches("state")) {
      if (outer || !isCol(p.left, inc, "state")) return null;
      const v = literalOf(p.right);
      if (p.op === "=" && typeof v === "string") { states = states ? states.filter((s) => s === v) : [v]; continue; }
      if (p.op === "IN" && p.inValues && p.inValues.every((x) => typeof x === "string")) {
        const vs = p.inValues as string[];
        states = states ? states.filter((s) => vs.includes(s)) : [...vs];
        continue;
      }
      return null;
    }
  }
  const years: [number, number] | null = lo === null && hi === null ? null : [lo ?? 1960, hi ?? 2100];
  return { years, states };
}

/**
 * The scopes whose rows the returned values are computed over: from each outer arm, a scope with an `incidents`
 * instance counts; FROM-clause relations (CTEs, derived tables, UNION arms) are followed into. Filtering subqueries
 * (`WHERE x IN (SELECT ...)`) are not followed: they restrict, they do not contribute counted rows.
 */
function countingScopes(facts: Extract<QueryFacts, { parsed: true }>): { scope: RelationFact; incAliases: string[] }[] {
  const out: { scope: RelationFact; incAliases: string[] }[] = [];
  const seen = new Set<string>();
  const visit = (rel: RelationFact, depth: number) => {
    if (depth > 8) return;
    for (const [i, arm] of armsOf(rel).entries()) {
      const key = `${rel.name}#${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const inc = arm.sources.filter((s) => !s.isRelation && (s.table ?? "").toLowerCase() === "incidents").map((s) => (s.alias ?? "incidents").toLowerCase());
      if (inc.length > 0) out.push({ scope: arm, incAliases: inc });
      for (const s of arm.sources.filter((x) => x.isRelation && x.table)) {
        const child = facts.relations.get(s.table!.toLowerCase());
        if (child) visit(child, depth + 1);
      }
    }
  };
  visit(facts.outer, 0);
  return out;
}

/** The categories a counting scope's classification restricts its counted rows to (empty when none does). */
function classifiedCategories(scope: RelationFact, incAliases: string[], problems: string[]): string[] {
  const cats: string[] = [];
  const preds = restrictingPredicates(scope).filter((p) => p.op === "=");
  for (const src of scope.sources.filter((x) => (x.table ?? "").toLowerCase() === SHR_YEAR_CLASS_TABLE)) {
    const ca = (src.alias ?? src.table ?? "").toLowerCase();
    if (/\b(LEFT|RIGHT|FULL)\b/i.test(src.join)) { problems.push(`${SHR_YEAR_CLASS_TABLE} is joined with an outer join, which restricts nothing`); continue; }
    const keyed = incAliases.some((ia) => ["ori", "state", "year"].every((k) =>
      preds.some((p) => (isCol(p.left, ca, k) && isCol(p.right, ia, k)) || (isCol(p.left, ia, k) && isCol(p.right, ca, k)))));
    if (!keyed) { problems.push(`${SHR_YEAR_CLASS_TABLE} is not joined to the counted incidents on ori, state and year`); continue; }
    for (const p of preds) {
      const v = literalOf(p.right);
      if (typeof v !== "string") continue;
      if (isCol(p.left, ca, "agency_type")) cats.push(v);
      if (isCol(p.left, ca, "membership")) cats.push(v === "eligible" ? "City" : `membership:${v}`);
    }
  }
  return cats;
}

export function agencyTypeVerdict(sql: string, requested: AgencyCategory[] = []): AgencyTypeVerdict {
  const text = stripSqlComments(sql);
  const classRe = new RegExp(`\\b${SHR_YEAR_CLASS_TABLE}\\b`, "i");
  const mentions = /\bagency_type\b/i.test(text) || classRe.test(text);
  if (!mentions && requested.length === 0) return { touches: false };
  const facts = analyzeSqlFacts(sql);
  if (!facts.parsed) return { touches: true, ok: false, problems: [`the statement could not be analyzed (${facts.reason})`] };

  const problems: string[] = [];
  // 1. Every agency_type reference, anywhere, must belong to a classification instance.
  for (const rel of facts.relations.values()) {
    for (const s of armsOf(rel)) {
      const aliases = scopeAliases(s);
      const refs = [...s.predicates.flatMap((p) => [...columnRefs(p.left), ...columnRefs(p.right)]), ...[...s.outputs.values()].flatMap((o) => columnRefs(o))];
      for (const r of refs.filter((x) => x.column.toLowerCase() === "agency_type")) {
        const owner = r.source ? aliases.get(r.source.toLowerCase()) : (s.sources.length === 1 ? (s.sources[0].table ?? "").toLowerCase() : null);
        if (owner !== SHR_YEAR_CLASS_TABLE) problems.push(`agency_type is read from ${owner ?? "an unattributed source"}, not from ${SHR_YEAR_CLASS_TABLE}`);
      }
      // A classification instance outside any counting scope (a filtering subquery, a lone class read) is year-unbound.
      const hasInc = s.sources.some((x) => !x.isRelation && (x.table ?? "").toLowerCase() === "incidents");
      if (!hasInc && s.sources.some((x) => (x.table ?? "").toLowerCase() === SHR_YEAR_CLASS_TABLE)) {
        problems.push(`${SHR_YEAR_CLASS_TABLE} is not joined to the counted incidents on ori, state and year`);
      }
    }
  }
  // 2. Every counting scope: the requested category on its counted rows, or no classification when none is asked.
  const counted = countingScopes(facts);
  if (requested.length > 0 && counted.length === 0) problems.push("the question depends on city/county membership but the statement counts no incidents rows");
  const scopes: ClassScope[] = [];
  for (const { scope, incAliases } of counted) {
    // Supported construction for a classified answer: ONE incidents instance per counting scope, so the
    // classification is joined to the very rows counted (a second instance could be classified while the first is counted).
    if (requested.length > 0 && incAliases.length !== 1) {
      problems.push("the counted rows read incidents more than once; count from a single incidents instance joined to the classification");
      continue;
    }
    const cats = classifiedCategories(scope, incAliases, problems);
    if (requested.length === 0) {
      if (cats.length > 0) problems.push("the question does not ask for a city/county distinction, but the counted rows are restricted by agency type");
      continue;
    }
    if (cats.length === 0) { problems.push(`the rows the answer counts are not restricted to ${requested.join(" or ")} agencies by ${SHR_YEAR_CLASS_TABLE}`); continue; }
    const wrong = cats.filter((c) => !requested.includes(c as AgencyCategory));
    if (wrong.length > 0) { problems.push(`the counted rows are restricted to ${wrong.join(", ")}, not the requested ${requested.join(" or ")}`); continue; }
    const sc = scopeOf(scope.predicates, incAliases[0]);
    if (!sc) { problems.push("a year or state restriction on the counted rows is not a plain AND condition (use =, IN or BETWEEN)"); continue; }
    scopes.push(sc);
  }
  if (problems.length > 0) return { touches: true, ok: false, problems: [...new Set(problems)] };
  // No category asked and no unsafe use found (for example a read of c.membership with no filter): nothing to disclose.
  return { touches: true, ok: true, scopes: requested.length === 0 ? [] : scopes };
}
