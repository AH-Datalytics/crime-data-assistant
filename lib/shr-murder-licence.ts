/**
 * The SHR conditional murder-victim licence, decided from typed facts.
 *
 * `shr.victims` is one row per HOMICIDE victim, and murder is a subset. Counting its rows is a
 * murder count ONLY when the count is restricted to murders through the incident relationship, per
 * `shr-claude.ts:123`. Everything below is about proving that, never about recognising SQL text.
 *
 * The four things that must hold, and the reason each exists:
 *   1. the returned value is a row count of the victims relation  -- a count hidden behind a CTE is
 *      still a count, and losing that fact at the CTE boundary is what let an unqualified count pass;
 *   2. the counted rows are related to incidents by the real key -- co-presence in a FROM clause is
 *      not a relationship: CROSS JOIN and ON 1=1 satisfy co-presence while multiplying every victim;
 *   3. `homicide_type = 'Murder'` restricts THOSE rows, as a top-level conjunct owned by a source
 *      resolving to `incidents` -- a predicate inside CASE, an OR, a subquery or an outer join's ON
 *      restricts nothing;
 *   4. where the relationship is carried by a CTE, that CTE emits the incident key at most once --
 *      projecting the right key is not emitting it once, and the difference multiplies the answer.
 *
 * Anything unproved is a refusal, including a parse failure. The verdict never throws.
 */
import {
  analyzeSqlFacts, keyMultiplicity, restrictingPredicates, scopeAliases,
  type ExprFact, type QueryFacts, type RelationFact,
} from "./sql-facts";
import { tableSemantics } from "./table-semantics";

export type LicenceVerdict =
  | { proved: true }
  | { proved: false; reason: string };

const COUNTED_TABLE = "victims";
const FILTER_TABLE = "incidents";
const JOIN_FROM = "incident_id";
const JOIN_TO = "id";
const FILTER_COLUMN = "homicide_type";
const FILTER_VALUE = "Murder";

function uniqueKeysOf(table: string): string[] {
  return tableSemantics("shr", table)?.uniqueKeys ?? [];
}

/** Does this fact denote exactly `table.column`, resolved through the relation's aliases? */
function isColumn(fact: ExprFact | null, aliases: Map<string, string>, table: string, column: string): boolean {
  if (!fact || fact.kind !== "column") return false;
  const ref = fact.refs[0];
  if (!ref || ref.column.toLowerCase() !== column.toLowerCase()) return false;
  if (!ref.source) {
    // Unqualified is unambiguous only when one table is in scope. With two, the prover will not
    // guess which owns the column; fail-closed and measured at zero occurrences in the replay.
    const tables = new Set([...aliases.values()]);
    return tables.size === 1 && tables.has(table.toLowerCase());
  }
  return aliases.get(ref.source.toLowerCase()) === table.toLowerCase();
}

/**
 * Is the murder predicate a restrictive top-level conjunct owned by `incidents` in this relation?
 *
 * The literal is read from the OTHER SIDE OF THE SAME PROVED PREDICATE. An earlier version searched
 * the statement text for `'Murder'`, which cannot tell `homicide_type = 'Murder'` from
 * `agency = 'Murder'` or from an unrelated `'Murder' AS label`, and authorized both.
 */
function murderRestricts(rel: RelationFact, aliases: Map<string, string>): boolean {
  return restrictingPredicates(rel).some((p) => {
    if (isColumn(p.left, aliases, FILTER_TABLE, FILTER_COLUMN)) return literalEquals(p.right, FILTER_VALUE);
    if (isColumn(p.right, aliases, FILTER_TABLE, FILTER_COLUMN)) return literalEquals(p.left, FILTER_VALUE);
    return false;
  });
}

/** Is this fact a literal whose bound value is exactly `value`? */
function literalEquals(fact: ExprFact | null, value: string): boolean {
  if (!fact || fact.kind !== "literal") return false;
  return typeof fact.value === "string" && fact.value.toLowerCase() === value.toLowerCase();
}

/** Is `victims.incident_id = incidents.id` established as a restrictive conjunct here? */
function keyJoinProved(rel: RelationFact, aliases: Map<string, string>): boolean {
  return restrictingPredicates(rel).some((p) => {
    if (p.op !== "=") return false;
    const a = p.left, b = p.right;
    const forward = isColumn(a, aliases, COUNTED_TABLE, JOIN_FROM) && isColumn(b, aliases, FILTER_TABLE, JOIN_TO);
    const backward = isColumn(b, aliases, COUNTED_TABLE, JOIN_FROM) && isColumn(a, aliases, FILTER_TABLE, JOIN_TO);
    return forward || backward;
  });
}

/**
 * The relations that actually contribute to the returned result, outermost first.
 *
 * Reachability matters in BOTH directions. A dead CTE that counts victims must not force a refusal
 * of a statement whose answer never uses it -- that is a false refusal, and the unused-CTE class is
 * an accepted one. Equally, the same CTE when reachable must engage. Following references
 * transitively is what separates the two, so a nested chain is not mistaken for dead code.
 */
function reachableRelations(facts: Extract<QueryFacts, { parsed: true }>): RelationFact[] {
  const ordered: RelationFact[] = [facts.outer];
  const seen = new Set<string>([""]);
  const queue: RelationFact[] = [facts.outer];
  while (queue.length > 0) {
    const rel = queue.shift()!;
    for (const source of rel.sources) {
      const name = source.table?.toLowerCase();
      if (!name || !source.isRelation || seen.has(name)) continue;
      const referenced = facts.relations.get(name);
      if (!referenced) continue;
      seen.add(name);
      ordered.push(referenced);
      queue.push(referenced);
    }
  }
  return ordered;
}

/** The relation whose rows the answer counts: the outermost REACHABLE one holding `victims`. */
function countingRelation(facts: Extract<QueryFacts, { parsed: true }>): RelationFact | null {
  for (const rel of reachableRelations(facts)) {
    if (rel.sources.some((s) => s.table?.toLowerCase() === COUNTED_TABLE)) return rel;
  }
  return null;
}

/** Does this relation return a row count of its own rows (not of some other rowset)? */
function returnsRowCount(rel: RelationFact): boolean {
  for (const fact of rel.outputs.values()) {
    if (containsRowCount(fact)) return true;
  }
  return false;
}

function containsRowCount(fact: ExprFact): boolean {
  if (fact.kind === "rowcount") return !fact.windowed;
  if (fact.kind === "aggregate" || fact.kind === "derived") return fact.inputs.some(containsRowCount);
  return false;
}

/**
 * Decide the licence for model-authored SHR SQL.
 *
 * Returns `proved: false` with a reason for anything it cannot establish, including unparseable
 * input. The caller must treat that as a refusal, never as a reason to consult another authority.
 */
export function proveShrMurderLicence(sql: string): LicenceVerdict {
  const facts = analyzeSqlFacts(sql);
  if (!facts.parsed) return { proved: false, reason: facts.reason };

  const counting = countingRelation(facts);
  if (!counting) return { proved: true };   // nothing reachable counts victims; not engaged

  // EVERY compound arm that returns a victim row count must prove itself. Evidence is never pooled:
  // one arm supplying a valid key join while another supplies the Murder predicate proves nothing
  // about either, and the union of two unlicensed series is not a licensed series.
  const scopes = counting.armScopes.length > 0 ? counting.armScopes : [counting];
  for (const [index, scope] of scopes.entries()) {
    if (!returnsRowCount(scope)) continue;   // this arm returns a stored measure, not a row count
    // An arm that counts something else entirely -- incidents, say -- is not this licence's
    // question, and refusing it here would refuse a legitimate mixed compound.
    if (!scope.sources.some((s) => s.table?.toLowerCase() === COUNTED_TABLE)) continue;
    if (!armProves(scope, facts)) {
      return {
        proved: false,
        reason: scopes.length > 1
          ? `arm ${index + 1} of ${scopes.length} counts victims that were not proved to be `
            + "restricted to murders through incidents"
          : "the victims counted were not proved to be restricted to murders through incidents",
      };
    }
  }
  return { proved: true };
}

/** Does this single scope prove the relationship and the murder restriction for its own rows? */
function armProves(scope: RelationFact, facts: Extract<QueryFacts, { parsed: true }>): boolean {
  const aliases = scopeAliases(scope);

  // Shape 1: the relationship and the predicate both hold where the rows are counted.
  if (keyJoinProved(scope, aliases) && murderRestricts(scope, aliases)) return true;

  // Shape 2: a CTE restricts incidents, projects the incident key AT MOST ONCE, and this scope
  // joins that projected key to victims.incident_id.
  for (const [name, cte] of facts.relations) {
    if (name === "") continue;
    const reference = scope.sources.find((s) => s.table?.toLowerCase() === name && s.isRelation);
    if (!reference) continue;
    if (/\b(LEFT|RIGHT|FULL)\b/i.test(reference.join)) continue;   // preserves unmatched victims

    // The CTE must prove itself on every one of its own arms, for the same reason.
    const cteScopes = cte.armScopes.length > 0 ? cte.armScopes : [cte];
    if (!cteScopes.every((s) => murderRestricts(s, scopeAliases(s)))) continue;

    const cteRef = (reference.alias ?? name).toLowerCase();
    for (const [outputName, output] of cte.outputs) {
      if (output.kind !== "column") continue;
      const ref = output.refs[0];
      if (!ref || ref.column.toLowerCase() !== JOIN_TO) continue;
      const cteAliases = scopeAliases(cte);
      if (cteAliases.get((ref.source ?? "").toLowerCase()) !== FILTER_TABLE
        && !(ref.source == null && new Set([...cteAliases.values()]).size === 1 && cteAliases.has(FILTER_TABLE))) {
        continue;
      }
      if (keyMultiplicity(cte, outputName, uniqueKeysOf) !== "at_most_one") continue;

      const joined = restrictingPredicates(scope).some((p) => {
        if (p.op !== "=") return false;
        const matchesCte = (f: ExprFact | null) =>
          f != null && f.kind === "column"
          && f.refs[0]?.source?.toLowerCase() === cteRef
          && f.refs[0]?.column.toLowerCase() === outputName.toLowerCase();
        const matchesVictims = (f: ExprFact | null) => isColumn(f, aliases, COUNTED_TABLE, JOIN_FROM);
        return (matchesCte(p.left) && matchesVictims(p.right)) || (matchesCte(p.right) && matchesVictims(p.left));
      });
      if (joined) return true;
    }
  }
  return false;
}
