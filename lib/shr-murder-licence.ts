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
  analyzeSqlFacts, keyMultiplicity, resolveReferences, restrictingPredicates, scopeAliases,
  type ExprFact, type QueryFacts, type RelationFact, type RowsetRef,
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
 * Every row count a returned expression traces to, with the rowset each one counted.
 *
 * There is deliberately NO "first counting relation". A statement can return several factual series
 * -- one per column, one per compound arm, one per subquery -- and each is a separate claim that
 * must stand on its own evidence. Picking one relation and stopping is what let
 * `SELECT c.n FROM c CROSS JOIN victims v` pass: the outer relation contained `victims` but returned
 * no count, so the unsafe count that `c.n` actually is was never examined.
 */
function returnedRowCounts(fact: ExprFact, out: { rowset: RowsetRef }[] = [], unresolved: string[] = []): {
  counts: { rowset: RowsetRef }[]; unresolved: string[];
} {
  switch (fact.kind) {
    case "rowcount":
      // A windowed count is a value computed per row, not the count the answer reports.
      if (!fact.windowed) out.push({ rowset: fact.rowset });
      returnedRowCounts(fact.target, out, unresolved);
      break;
    case "aggregate":
    case "derived":
      for (const input of fact.inputs) returnedRowCounts(input, out, unresolved);
      break;
    case "unknown":
      // Unresolved provenance could be hiding a victim count. It never falls back to a name search.
      unresolved.push(fact.reason);
      break;
    default:
      break;
  }
  return { counts: out, unresolved };
}

/** The arm scope a rowset refers to, or null when it cannot be identified. */
function rowsetScope(rowset: RowsetRef, facts: Extract<QueryFacts, { parsed: true }>): RelationFact | null {
  const relation = facts.relations.get(rowset.relation);
  if (!relation) return null;
  if (relation.armScopes.length === 0) return relation;
  return relation.armScopes[rowset.arm] ?? null;
}

/**
 * Decide the licence for model-authored SQL.
 *
 * Returns `proved: false` with a reason for anything it cannot establish, including unparseable
 * input. The caller must treat that as a refusal, never as a reason to consult another authority.
 */
export function proveShrMurderLicence(sql: string): LicenceVerdict {
  const facts = analyzeSqlFacts(sql);
  if (!facts.parsed) return { proved: false, reason: facts.reason };

  // Only what the statement RETURNS is authorized, which is also what keeps a dead CTE out of it:
  // a relation nothing returns from contributes no returned expression to enumerate.
  const outerScopes = facts.outer.armScopes.length > 0 ? facts.outer.armScopes : [facts.outer];
  for (const [armIndex, scope] of outerScopes.entries()) {
    for (const [column, raw] of scope.outputs) {
      // One returned column can denote several facts -- one per compound arm of the relation it
      // references, or every column a `*` expands to. Each is its own claim.
      const counts: { rowset: RowsetRef }[] = [];
      const unresolved: string[] = [];
      for (const resolved of resolveReferences(raw, scope, facts.relations)) {
        returnedRowCounts(resolved, counts, unresolved);
      }

      if (unresolved.length > 0 && counts.length === 0) {
        // Something is returned whose provenance could not be traced. It may or may not be a victim
        // count; unknown fails closed rather than being assumed harmless.
        const victimsAnywhere = [...facts.relations.values()]
          .some((rel) => rel.sources.some((s) => s.table?.toLowerCase() === COUNTED_TABLE));
        if (victimsAnywhere) {
          return { proved: false, reason: `unresolved provenance for "${column}": ${unresolved[0]}` };
        }
      }

      for (const { rowset } of counts) {
        const counted = rowsetScope(rowset, facts);
        if (!counted) {
          return { proved: false, reason: `the rowset behind "${column}" could not be identified` };
        }
        // A count over something other than victims is not this licence's question.
        if (!counted.sources.some((s) => s.table?.toLowerCase() === COUNTED_TABLE)) continue;
        if (!armProves(counted, facts)) {
          return {
            proved: false,
            reason: outerScopes.length > 1
              ? `arm ${armIndex + 1} of ${outerScopes.length} returns "${column}", a count of victims `
                + "that was not proved to be restricted to murders through incidents"
              : `"${column}" counts victims that were not proved to be restricted to murders `
                + "through incidents",
          };
        }
      }
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
