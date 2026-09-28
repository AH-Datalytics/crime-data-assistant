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
  return proveShrVictimLicence(sql, "murder");
}

/**
 * Which victim measure the REQUEST selected (GC-080; Jeff's ruling, Codex design ruling 2026-09-26).
 *
 * Read from the validated effective request, never from the SQL or an internally rewritten prompt:
 * "shootings" rewritten to "firearm homicides" for the model must not select a different licence.
 *   - "murder(s)"                 -> murder victims (the accepted Murder restriction)
 *   - "homicide(s)", no "murder"  -> ALL homicide victims (murder/nonnegligent + negligent manslaughter)
 *   - "homicide incident(s)"      -> homicide incidents, a distinct unit
 *   - both words, or neither      -> murder: a conflicting or unowned request never gets the wider licence
 */
export type ShrVictimMeasure = "murder" | "homicide" | "homicide_incident" | "conflict";

/**
 * GC-080 correction G80-3: the AFFIRMATIVE measure decides. An inclusion clause ("all homicides
 * including murders and negligent manslaughter") names a subset of what was asked for, and a negated
 * phrase ("homicides, not incidents") names what was NOT asked for; neither may replace the request.
 * An exclusion of a homicide type ("homicides excluding murders") and a request naming both
 * measures affirmatively are genuinely competing: "conflict", answered with an owned question, never
 * a guess.
 */
export function shrRequestedMeasure(question: string): ShrVictimMeasure {
  const q = question.toLowerCase();
  if (/\b(?:excluding|except|other than|not counting|without)\s+(?:the\s+)?(?:murders?|homicides?|manslaughters?)\b/.test(q)) return "conflict";
  const affirmative = q
    .replace(/\b(?:including|includes|include|incl\.?|such as|as well as|along with|plus)\b[^.;:?!]*/g, " ")
    .replace(/\b(?:not|rather than|instead of)\s+(?:the\s+|just\s+|only\s+|all\s+)?(?:\w+\s+)?(?:incidents?|victims?|murders?|homicides?)\b/g, " ");
  const murder = /\bmurders?\b/.test(affirmative);
  const homicide = /\bhomicides?\b/.test(affirmative);
  if (murder && homicide) return "conflict";
  if (!homicide) return "murder";
  return /\bincidents?\b/.test(affirmative) ? "homicide_incident" : "homicide";
}

/** The owned reply for competing measures. */
export const SHR_MEASURE_CONFLICT_MESSAGE =
  "That asks for both murders and all homicides, which are different counts here: all homicides also " +
  "include negligent manslaughter. Say which one you want and I'll count it.";

/** The sentence an all-homicide answer must carry. Application-owned. */
export const SHR_ALL_HOMICIDE_DISCLOSURE =
  "These are all homicide victims: murder and nonnegligent manslaughter, plus negligent manslaughter.";

/**
 * The victim licence for the selected measure.
 *
 * "murder" is the accepted licence, unchanged. "homicide" keeps every structural condition -- the
 * real victims-to-incidents key, CTE multiplicity, no untraced provenance -- and inverts only the
 * measure: a homicide-type restriction is refused, because a Murder-only count is the wrong answer
 * to an all-homicide question even though it would pass the murder licence. It also requires that a
 * victim count is actually returned (an incident count must not pass as victims), and bounds fan-out
 * without a general analyzer: the counted scope may read only incidents and victims.
 * "homicide_incident" refuses a homicide-type restriction and nothing else.
 */
export function proveShrVictimLicence(sql: string, measure: ShrVictimMeasure): LicenceVerdict {
  const facts = analyzeSqlFacts(sql);
  if (!facts.parsed) return { proved: false, reason: facts.reason };
  if (measure === "conflict") return { proved: false, reason: "the request names competing measures (murders and all homicides)" };
  if (measure !== "murder") {
    const typed = homicideTypePredicate(facts);
    if (typed) return { proved: false, reason: `the request is for all homicides, but ${typed} restricts the homicide type` };
    return proveAllHomicideShape(facts, measure);
  }

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
        if (!armProves(counted, facts, measure)) {
          const what = measure === "murder" ? "restricted to murders through incidents" : "joined to their incidents by the incident key";
          return {
            proved: false,
            reason: outerScopes.length > 1
              ? `arm ${armIndex + 1} of ${outerScopes.length} returns "${column}", a count of victims `
                + `that was not proved to be ${what}`
              : `"${column}" counts victims that were not proved to be ${what}`,
          };
        }
      }
    }
  }
  return { proved: true };
}

/**
 * G80-1: the supported all-homicide count shapes, proved at the RETURNED EXPRESSION and the counted
 * relation INSTANCES. Anything else is refused -- a narrow proof, not a general analyzer.
 *
 *   victims ("homicide")            COUNT(*) or COUNT([DISTINCT] v.id), over a scope of exactly ONE
 *                                   incidents instance and ONE victims instance joined by the incident
 *                                   key, with no CTE/subquery reference and no other table.
 *   incidents ("homicide_incident") COUNT(*) or COUNT([DISTINCT] i.id) over ONE incidents instance
 *                                   alone; or COUNT(DISTINCT i.id | v.incident_id) over the keyed pair.
 *
 * Refused: a second victims or incidents instance (repeats victims), a cross-joined CTE (multiplies),
 * a conditional count such as COUNT(CASE WHEN homicide_type = 'Murder' ...) (a murder subset under a
 * victims label), a distinct incident count offered as victims, a victim count offered as incidents,
 * windowed counts, other aggregates over victims, and untraced provenance near victims.
 */
function proveAllHomicideShape(facts: Extract<QueryFacts, { parsed: true }>, measure: "homicide" | "homicide_incident"): LicenceVerdict {
  const unit = measure === "homicide" ? "victims" : "incidents";
  const outerScopes = facts.outer.armScopes.length > 0 ? facts.outer.armScopes : [facts.outer];
  let returned = 0;
  for (const scope of outerScopes) {
    for (const [column, raw] of scope.outputs) {
      const found: { counts: Extract<ExprFact, { kind: "rowcount" }>[]; aggregates: Extract<ExprFact, { kind: "aggregate" }>[]; unresolved: string[] } = { counts: [], aggregates: [], unresolved: [] };
      for (const resolved of resolveReferences(raw, scope, facts.relations)) collectCountFacts(resolved, found);
      const victimsAnywhere = [...facts.relations.values()].some((rel) => rel.sources.some((s) => s.table?.toLowerCase() === COUNTED_TABLE));
      if (found.unresolved.length > 0 && found.counts.length === 0 && victimsAnywhere) {
        return { proved: false, reason: `unresolved provenance for "${column}": ${found.unresolved[0]}` };
      }
      for (const aggregate of found.aggregates) {
        const over = rowsetScope(aggregate.rowset, facts);
        if (!over || over.sources.some((s) => s.isRelation || s.table?.toLowerCase() === COUNTED_TABLE)) {
          return { proved: false, reason: `"${column}" is a ${aggregate.fn} over homicide rows, not a supported count of ${unit}` };
        }
      }
      for (const count of found.counts) {
        if (count.windowed) return { proved: false, reason: `"${column}" is a windowed count, not a count of ${unit}` };
        const counted = rowsetScope(count.rowset, facts);
        if (!counted) return { proved: false, reason: `the rowset behind "${column}" could not be identified` };
        const verdict = measure === "homicide" ? victimCountShape(counted, count) : incidentCountShape(counted, count);
        if (verdict) return { proved: false, reason: `"${column}" ${verdict}` };
        returned += 1;
      }
    }
  }
  if (returned === 0) return { proved: false, reason: `the request is for homicide ${unit}, but the statement returns no count of ${unit}` };
  return { proved: true };
}

/** Row counts and other aggregates a returned expression traces to, with the facts themselves. */
function collectCountFacts(fact: ExprFact, out: { counts: Extract<ExprFact, { kind: "rowcount" }>[]; aggregates: Extract<ExprFact, { kind: "aggregate" }>[]; unresolved: string[] }): void {
  switch (fact.kind) {
    case "rowcount": out.counts.push(fact); break;
    case "aggregate": out.aggregates.push(fact); for (const input of fact.inputs) collectCountFacts(input, out); break;
    case "derived": for (const input of fact.inputs) collectCountFacts(input, out); break;
    case "unknown": out.unresolved.push(fact.reason); break;
    default: break;
  }
}

/** The base tables a scope reads, one entry per instance; null if it reads any CTE or subquery. */
function baseInstances(scope: RelationFact): string[] | null {
  if (scope.sources.some((s) => s.isRelation || !s.table)) return null;
  return scope.sources.map((s) => (s.table as string).toLowerCase()).sort();
}

/** Which table.column a counted column denotes in this scope, or null when it cannot be told. */
function countedColumn(fact: ExprFact, scope: RelationFact): string | null {
  if (fact.kind !== "column" || fact.refs.length !== 1) return null;
  const ref = fact.refs[0];
  const aliases = scopeAliases(scope);
  const table = ref.source ? aliases.get(ref.source.toLowerCase()) : (ref.column.toLowerCase() === JOIN_FROM ? COUNTED_TABLE : null);
  return table ? `${table}.${ref.column.toLowerCase()}` : null;
}

/** Null when the count is a proved count of victims; otherwise what it is instead. */
function victimCountShape(scope: RelationFact, count: Extract<ExprFact, { kind: "rowcount" }>): string | null {
  const instances = baseInstances(scope);
  if (!instances || instances.join() !== [FILTER_TABLE, COUNTED_TABLE].sort().join()) {
    return "counts rows of a scope other than one incidents row joined to one victims row, which can repeat or omit victims";
  }
  if (!keyJoinProved(scope, scopeAliases(scope))) return "counts victims that are not joined to their incidents by the incident key";
  if (count.target.kind === "star" && !count.distinct) return null;
  if (countedColumn(count.target, scope) === `${COUNTED_TABLE}.id`) return null;
  if (countedColumn(count.target, scope) === `${COUNTED_TABLE}.${JOIN_FROM}` || countedColumn(count.target, scope) === `${FILTER_TABLE}.${JOIN_TO}`) {
    return "counts incidents, not victims";
  }
  return "is a conditional or unrecognised count, not a count of victims";
}

/** Null when the count is a proved count of incidents; otherwise what it is instead. */
function incidentCountShape(scope: RelationFact, count: Extract<ExprFact, { kind: "rowcount" }>): string | null {
  const instances = baseInstances(scope);
  const target = count.target.kind === "star" ? "*" : countedColumn(count.target, scope);
  if (instances && instances.join() === FILTER_TABLE) {
    if ((target === "*" && !count.distinct) || target === `${FILTER_TABLE}.${JOIN_TO}`) return null;
    return "is a conditional or unrecognised count, not a count of incidents";
  }
  if (instances && instances.join() === [FILTER_TABLE, COUNTED_TABLE].sort().join() && keyJoinProved(scope, scopeAliases(scope))) {
    if (count.distinct && (target === `${FILTER_TABLE}.${JOIN_TO}` || target === `${COUNTED_TABLE}.${JOIN_FROM}`)) return null;
    return "counts victims, not incidents";
  }
  return "counts rows of a scope other than one incidents row (optionally keyed to its victims), which can repeat incidents";
}

/** The first predicate anywhere that restricts `incidents.homicide_type`, described; null if none. */
function homicideTypePredicate(facts: Extract<QueryFacts, { parsed: true }>): string | null {
  for (const relation of facts.relations.values()) {
    for (const scope of relation.armScopes.length > 0 ? relation.armScopes : [relation]) {
      const aliases = scopeAliases(scope);
      for (const p of scope.predicates) {
        if (isColumn(p.left, aliases, FILTER_TABLE, FILTER_COLUMN) || isColumn(p.right, aliases, FILTER_TABLE, FILTER_COLUMN)) {
          return `a ${p.op} condition on homicide_type`;
        }
      }
    }
  }
  return null;
}

/** Does this single scope prove the relationship and the measure's restriction for its own rows? */
function armProves(scope: RelationFact, facts: Extract<QueryFacts, { parsed: true }>, measure: ShrVictimMeasure = "murder"): boolean {
  const aliases = scopeAliases(scope);
  // Murder requires the Murder restriction; all-homicide requires none (a type predicate was already refused).
  const restricts = (s: RelationFact, a: Map<string, string>) => measure === "murder" ? murderRestricts(s, a) : true;

  // Shape 1: the relationship and the predicate both hold where the rows are counted.
  if (keyJoinProved(scope, aliases) && restricts(scope, aliases)) return true;

  // Shape 2: a CTE restricts incidents, projects the incident key AT MOST ONCE, and this scope
  // joins that projected key to victims.incident_id.
  for (const [name, cte] of facts.relations) {
    if (name === "") continue;
    const reference = scope.sources.find((s) => s.table?.toLowerCase() === name && s.isRelation);
    if (!reference) continue;
    if (/\b(LEFT|RIGHT|FULL)\b/i.test(reference.join)) continue;   // preserves unmatched victims

    // The CTE must prove itself on every one of its own arms, for the same reason.
    const cteScopes = cte.armScopes.length > 0 ? cte.armScopes : [cte];
    if (!cteScopes.every((s) => restricts(s, scopeAliases(s)))) continue;

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
