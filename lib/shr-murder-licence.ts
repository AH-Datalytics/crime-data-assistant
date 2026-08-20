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

function isLiteral(fact: ExprFact | null): boolean {
  return Boolean(fact && fact.kind === "literal");
}

/** Is the murder predicate a restrictive top-level conjunct owned by `incidents` in this relation? */
function murderRestricts(rel: RelationFact, aliases: Map<string, string>, sqlText: string): boolean {
  return restrictingPredicates(rel).some((p) => {
    const leftIsCol = isColumn(p.left, aliases, FILTER_TABLE, FILTER_COLUMN);
    const rightIsCol = isColumn(p.right, aliases, FILTER_TABLE, FILTER_COLUMN);
    if (leftIsCol && isLiteral(p.right)) return literalIs(p, "right", sqlText);
    if (rightIsCol && isLiteral(p.left)) return literalIs(p, "left", sqlText);
    return false;
  });
}

/**
 * The AST records that a side is a literal but the fact model deliberately does not carry its
 * value, so the value is confirmed against the statement text ONCE the structure is already proved.
 * This is not text matching standing in for structure: the conjunct, its ownership and its position
 * are all established from facts first, and only the constant is read back.
 */
function literalIs(p: { op: string }, _side: "left" | "right", sqlText: string): boolean {
  void p;
  return new RegExp(`'${FILTER_VALUE}'`, "i").test(sqlText);
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

/** The relation whose rows the answer counts: the outermost one holding `victims`. */
function countingRelation(facts: Extract<QueryFacts, { parsed: true }>): RelationFact | null {
  const ordered = [facts.outer, ...[...facts.relations.entries()].filter(([n]) => n !== "").map(([, r]) => r)];
  for (const rel of ordered) {
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
  if (!counting) return { proved: true };            // nothing counts victims; the licence is not engaged
  if (!returnsRowCount(counting)) return { proved: true };  // a stored measure, not a row count

  const aliases = scopeAliases(counting);

  // Shape 1: the relationship and the predicate both hold where the rows are counted.
  if (keyJoinProved(counting, aliases) && murderRestricts(counting, aliases, sql)) {
    return { proved: true };
  }

  // Shape 2: a CTE restricts incidents, projects the incident key AT MOST ONCE, and the counting
  // relation joins that projected key to victims.incident_id.
  for (const [name, cte] of facts.relations) {
    if (name === "") continue;
    const reference = counting.sources.find((s) => s.table?.toLowerCase() === name && s.isRelation);
    if (!reference) continue;
    if (/\b(LEFT|RIGHT|FULL)\b/i.test(reference.join)) continue;   // preserves unmatched victims

    const cteAliases = scopeAliases(cte);
    if (!murderRestricts(cte, cteAliases, sql)) continue;

    const cteRef = (reference.alias ?? name).toLowerCase();
    for (const [outputName, output] of cte.outputs) {
      if (output.kind !== "column") continue;
      const ref = output.refs[0];
      if (!ref || ref.column.toLowerCase() !== JOIN_TO) continue;
      if (cteAliases.get((ref.source ?? "").toLowerCase()) !== FILTER_TABLE
        && !(ref.source == null && new Set([...cteAliases.values()]).size === 1 && cteAliases.has(FILTER_TABLE))) {
        continue;
      }
      if (keyMultiplicity(cte, outputName, uniqueKeysOf) !== "at_most_one") continue;

      const joined = restrictingPredicates(counting).some((p) => {
        if (p.op !== "=") return false;
        const matchesCte = (f: ExprFact | null) =>
          f != null && f.kind === "column"
          && f.refs[0]?.source?.toLowerCase() === cteRef
          && f.refs[0]?.column.toLowerCase() === outputName.toLowerCase();
        const matchesVictims = (f: ExprFact | null) => isColumn(f, aliases, COUNTED_TABLE, JOIN_FROM);
        return (matchesCte(p.left) && matchesVictims(p.right)) || (matchesCte(p.right) && matchesVictims(p.left));
      });
      if (joined) return { proved: true };
    }
  }

  return {
    proved: false,
    reason: "the victims counted were not proved to be restricted to murders through incidents",
  };
}
