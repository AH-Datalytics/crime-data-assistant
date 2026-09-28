/**
 * Typed provenance facts for model-authored SQL, produced from a real SQL AST.
 *
 * WHY THIS EXISTS. The hand-rolled analyzer reduced a CTE output to `ColumnRef[]`, discarding
 * whether the value was a row count, an aggregate, a transformation or a literal. That loss let a
 * count hidden behind a CTE, `MIN(id) AS id`, `id + 1 AS id`, a comma join and a windowed
 * projection all pass the murder-victim licence: each of them still *referenced* the right column.
 *
 * The same class then recurred one level up. A reference to a CTE output -- `c.n` -- was still only
 * a column, so a returned row count could be laundered through a CTE while the verdict searched
 * relations by name and stopped at the first one containing `victims`. The fix is not a cleverer
 * search: **a reference to a relation's output resolves into that output's own fact**, recursively,
 * and every row count carries the ROWSET it counted. What a returned expression IS survives every
 * alias, CTE, subquery and compound boundary, or it becomes an explicit `unknown` that fails closed.
 *
 * SCOPE. This module owns parsing for the SHR conditional murder-victim licence and nothing else in
 * this increment. It never throws: a parse failure is a fact, not an exception, because an exception
 * on the request path is an outage and a refusal is an answer.
 */
import { Parser } from "node-sql-parser/build/postgresql";

/** SQL longer than this is refused before parsing. The longest real query measured is 4,000. */
export const MAX_SQL_LENGTH = 20_000;

export type Provenance = "proved" | "unknown";

export type ColumnRef = { source: string | null; column: string };

/** Which relation, and which compound arm of it, a counted or aggregated value came from. */
export type RowsetRef = { relation: string; arm: number };

/** What a returned value IS, recursively. `column` is the ONLY identity form. */
export type ExprFact =
  | { kind: "column"; refs: ColumnRef[]; provenance: Provenance }
  | { kind: "star"; provenance: Provenance }
  | { kind: "literal"; value: string | number | boolean | null; provenance: Provenance }
  | { kind: "rowcount"; target: ExprFact; distinct: boolean; windowed: boolean; rowset: RowsetRef; provenance: Provenance }
  | { kind: "aggregate"; fn: string; inputs: ExprFact[]; windowed: boolean; rowset: RowsetRef; provenance: Provenance }
  | { kind: "derived"; op: string; inputs: ExprFact[]; windowed: boolean; provenance: Provenance }
  | { kind: "unknown"; reason: string; provenance: "unknown" };

/**
 * A source is an INSTANCE, not a table name. `FROM incidents i, victims x` and a self-join both
 * produce two instances; collapsing them into a set of names is how a comma join passed as though
 * one table were present.
 */
export type SourceFact = {
  index: number;
  arm: number;
  table: string | null;
  alias: string | null;
  /** "BASE", "COMMA", or the join keyword ("INNER JOIN", "LEFT JOIN", ...). */
  join: string;
  /** True when this source is a CTE or subquery reference rather than a base table. */
  isRelation: boolean;
};

export type PredicateFact = {
  op: string;
  left: ExprFact | null;
  right: ExprFact | null;
  /** Where the predicate sits: a top-level conjunct of WHERE, or of a join's ON. */
  position: "where" | "on";
  /** The join this ON belongs to, if any. An OUTER join's ON restricts nothing. */
  joinKind: string | null;
  /** True only for a top-level AND conjunct that is itself a restrictive comparison. */
  restrictive: boolean;
  /**
   * For `x IN (...)`, the list's literal values when EVERY item is a literal; absent otherwise.
   * Evidence only: it does not change `restrictive`, which stays true only for a single-value list,
   * so every existing verdict built on `restrictive` is unchanged. Added for the SHR county-scope
   * check (GC-080), which needs to know which ORIs an IN list admits.
   */
  inValues?: (string | number | boolean | null)[];
};

export type Multiplicity = "at_most_one" | "may_repeat" | "unknown";

export type RelationFact = {
  name: string;
  arms: number;
  sources: SourceFact[];
  predicates: PredicateFact[];
  outputs: Map<string, ExprFact>;
  grouped: boolean;
  windowed: boolean;
  distinct: boolean;
  /**
   * One scope per compound arm, each holding ONLY its own sources, predicates and outputs.
   *
   * Merged fields describe the returned TYPE; they must never be used as authorization evidence.
   * Pooling arms let one arm supply a valid key join while another supplied the Murder predicate,
   * and the union of two unlicensed series is not a licensed series.
   */
  armScopes: RelationFact[];
  /**
   * Why nothing may be proved through this relation, when that is so -- a name defined more than
   * once, say. Explicit, because a sentinel output made an ambiguous relation report as a missing
   * column, which is a true refusal for a false reason.
   */
  unresolvable?: string;
};

export type QueryFacts =
  | { parsed: true; relations: Map<string, RelationFact>; outer: RelationFact }
  | { parsed: false; reason: string };

const parser = new Parser();

const UNKNOWN = (reason: string): ExprFact => ({ kind: "unknown", reason, provenance: "unknown" });

function columnName(c: unknown): string | null {
  if (typeof c === "string") return c;
  const obj = c as { expr?: { value?: unknown }; value?: unknown } | null;
  if (obj?.expr && obj.expr.value != null) return String(obj.expr.value);
  if (obj?.value != null) return String(obj.value);
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Shared state while building one statement's facts. */
type BuildContext = {
  cteNames: Set<string>;
  /** Every relation built so far, including inline subqueries under synthetic names. */
  relations: Map<string, RelationFact>;
  nextSubquery: { value: number };
};

function exprFact(e: any, ctx: BuildContext, rowset: RowsetRef): ExprFact {
  if (e == null) return UNKNOWN("null expression");
  switch (e.type) {
    case "column_ref": {
      const col = columnName(e.column);
      if (col === "*") return { kind: "star", provenance: "proved" };
      if (!col) return UNKNOWN("unreadable column reference");
      return { kind: "column", refs: [{ source: e.table ?? null, column: col }], provenance: "proved" };
    }
    case "aggr_func": {
      const fn = String(e.name ?? "").toUpperCase();
      const windowed = e.over != null;
      const inner = e.args?.expr;
      const target: ExprFact = !inner || inner.type === "star" || columnName(inner.column) === "*"
        ? { kind: "star", provenance: "proved" }
        : exprFact(inner, ctx, rowset);
      if (fn === "COUNT") {
        // The rowset is part of the fact. Without it a count that travels through a CTE cannot be
        // traced back to the rows it counted, and the verdict has to guess which relation it meant.
        return { kind: "rowcount", target, distinct: Boolean(e.args?.distinct), windowed, rowset, provenance: "proved" };
      }
      return { kind: "aggregate", fn, inputs: inner ? [exprFact(inner, ctx, rowset)] : [], windowed, rowset, provenance: "proved" };
    }
    // ROW_NUMBER()/RANK() are a DISTINCT node type from an aggregate carrying OVER. Missing this
    // made a windowed CTE resolve to `unknown`: still refused, but for the wrong reason.
    case "window_func":
      return { kind: "derived", op: String(e.name ?? "WINDOW").toUpperCase(), inputs: [], windowed: true, provenance: "proved" };
    case "function": {
      const name = e.name?.name?.[0]?.value ?? e.name;
      const args = e.args?.value ?? [];
      return {
        kind: "derived", op: String(name ?? "FN").toUpperCase(),
        inputs: args.map((a: any) => exprFact(a, ctx, rowset)), windowed: e.over != null, provenance: "proved",
      };
    }
    case "binary_expr":
      return {
        kind: "derived", op: String(e.operator),
        inputs: [exprFact(e.left, ctx, rowset), exprFact(e.right, ctx, rowset)],
        windowed: false, provenance: "proved",
      };
    // A CASE hides its inputs from a shallow reader; walking them is what keeps a predicate buried
    // in a CASE from being mistaken for a restriction, and keeps its columns in the lineage.
    case "case": {
      const inputs: ExprFact[] = [];
      for (const arm of e.args ?? []) {
        if (arm.cond) inputs.push(exprFact(arm.cond, ctx, rowset));
        if (arm.result) inputs.push(exprFact(arm.result, ctx, rowset));
      }
      return { kind: "derived", op: "CASE", inputs, windowed: false, provenance: "proved" };
    }
    case "cast":
      return { kind: "derived", op: "CAST", inputs: [exprFact(e.expr, ctx, rowset)], windowed: false, provenance: "proved" };
    case "unary_expr":
      return { kind: "derived", op: String(e.operator ?? "UNARY"), inputs: [exprFact(e.expr, ctx, rowset)], windowed: false, provenance: "proved" };
    case "expr_list":
      return { kind: "derived", op: "LIST", inputs: (e.value ?? []).map((v: any) => exprFact(v, ctx, rowset)), windowed: false, provenance: "proved" };
    case "number": case "single_quote_string": case "double_quote_string":
    case "bool": case "null": case "origin": case "param":
      // The VALUE is part of the fact. Recording only "this is a literal" forced the verdict to
      // search the statement text for the constant, which cannot tell `homicide_type = 'Murder'`
      // from `agency = 'Murder'` or from an unrelated `'Murder' AS label`.
      return { kind: "literal", value: (e.value ?? null) as string | number | boolean | null, provenance: "proved" };
    default: {
      // A scalar subquery is its own rowset. Registering it as a relation keeps its facts -- and any
      // row count inside it -- visible to the caller instead of collapsing to `unknown`.
      if (e.ast) {
        const name = `(subquery#${ctx.nextSubquery.value++})`;
        ctx.relations.set(name, relationFact(e.ast, name, ctx));
        const first = [...ctx.relations.get(name)!.outputs.values()][0];
        return first ?? UNKNOWN("subquery projects nothing");
      }
      return UNKNOWN(`unsupported expression node: ${String(e.type)}`);
    }
  }
}

/** The top-level AND conjuncts of a boolean tree. Anything nested is NOT a conjunct of it. */
function conjuncts(node: any, out: any[] = []): any[] {
  if (!node) return out;
  if (node.type === "binary_expr" && String(node.operator).toUpperCase() === "AND") {
    conjuncts(node.left, out);
    conjuncts(node.right, out);
    return out;
  }
  out.push(node);
  return out;
}

function predicateFact(
  node: any, position: "where" | "on", joinKind: string | null, ctx: BuildContext, rowset: RowsetRef,
): PredicateFact {
  const op = String(node.operator ?? node.type ?? "").toUpperCase();
  if (node.type !== "binary_expr") {
    return { op, left: null, right: null, position, joinKind, restrictive: false };
  }
  // NOTE: there is deliberately no special case for `OR`. A disjunction can widen what an equality
  // narrowed, but it is already non-restrictive by construction -- only `=` is restrictive below,
  // and `conjuncts` never descends into an OR, so its operands are not conjuncts of anything.
  if (op === "IN") {
    const list = node.right?.value ?? [];
    const single = Array.isArray(list) && list.length === 1;
    const items = Array.isArray(list) ? list.map((item: any) => exprFact(item, ctx, rowset)) : [];
    const allLiteral = items.length > 0 && items.every((item: ExprFact) => item.kind === "literal");
    return {
      op, position, joinKind, restrictive: single,
      left: exprFact(node.left, ctx, rowset),
      right: single ? exprFact(list[0], ctx, rowset) : UNKNOWN(`IN with ${Array.isArray(list) ? list.length : "?"} values`),
      ...(allLiteral ? { inValues: items.map((item: ExprFact) => (item as Extract<ExprFact, { kind: "literal" }>).value) } : {}),
    };
  }
  return {
    op, position, joinKind, restrictive: op === "=",
    left: exprFact(node.left, ctx, rowset), right: exprFact(node.right, ctx, rowset),
  };
}

/** Merge two facts for the same output position across compound arms. Conflict becomes unknown. */
function mergeArmFacts(a: ExprFact, b: ExprFact): ExprFact {
  if (a.kind !== b.kind) return UNKNOWN("compound arms disagree on kind");
  if (a.kind === "star") return a;
  // Deliberately value-INSENSITIVE: two arms labelling rows 'Chicago' and 'Houston' agree that the
  // column is a literal. Authorization never reads a merged fact -- it reads the arm's own.
  if (a.kind === "literal") return a;
  if (a.kind === "column" && b.kind === "column") {
    const key = (f: ColumnRef) => `${f.source ?? ""}.${f.column}`.toLowerCase();
    const same = a.refs.length === b.refs.length && a.refs.every((r, i) => key(r) === key(b.refs[i]));
    return same ? a : UNKNOWN("compound arms project different columns");
  }
  if (a.kind === "rowcount" && b.kind === "rowcount") {
    return a.distinct === b.distinct ? a : UNKNOWN("compound arms disagree on DISTINCT");
  }
  if (a.kind === "aggregate" && b.kind === "aggregate") {
    return a.fn === b.fn ? a : UNKNOWN("compound arms use different aggregates");
  }
  if (a.kind === "derived" && b.kind === "derived") {
    return a.op === b.op ? a : UNKNOWN("compound arms use different operations");
  }
  return UNKNOWN("compound arms disagree");
}

function relationFact(stmt: any, name: string, ctx: BuildContext): RelationFact {
  const arms: any[] = [];
  for (let s = stmt; s; s = s._next) arms.push(s);

  const armScopes: RelationFact[] = [];

  arms.forEach((arm, armIndex) => {
    // Each arm is built as its own complete scope. Authorization reads THESE, never the merge.
    const rowset: RowsetRef = { relation: name, arm: armIndex };
    const scope: RelationFact = {
      name: arms.length === 1 ? name : `${name}#${armIndex}`,
      arms: 1, sources: [], predicates: [],
      outputs: new Map(), grouped: false, windowed: false, distinct: false, armScopes: [],
    };
    if (arm.groupby) scope.grouped = true;
    if (arm.distinct?.type) scope.distinct = true;

    // node-sql-parser mis-parses `FROM a CROSS JOIN b` when `a` has no explicit alias: it consumes
    // the join keyword AS the alias and downgrades the join to "INNER JOIN". With an alias present
    // it is correct. Both halves matter here -- the bogus alias broke reference resolution, and
    // reading a CROSS JOIN as an inner join would misreport how the rows were combined -- so the
    // keyword is stripped and the following join is restored to what was written.
    let pendingJoin: string | null = null;
    (arm.from ?? []).forEach((f: any, i: number) => {
      let table: string | null = f.table ?? null;
      let isRelation = Boolean(table && ctx.cteNames.has(String(table).toLowerCase()));
      let alias: string | null = f.as ?? null;
      const swallowed = alias && /^(cross|natural|inner|left|right|full|outer)$/i.test(alias) ? alias : null;
      if (swallowed) {
        alias = null;
        pendingJoin = `${swallowed.toUpperCase()} JOIN`;
      }
      // A derived table in FROM is its own rowset too.
      if (!table && f.expr?.ast) {
        const sub = `(subquery#${ctx.nextSubquery.value++})`;
        ctx.relations.set(sub, relationFact(f.expr.ast, sub, ctx));
        table = sub;
        isRelation = true;
      }
      const declaredJoin = f.join ?? (i === 0 ? "BASE" : "COMMA");
      scope.sources.push({
        index: scope.sources.length,
        arm: armIndex,
        table,
        alias,
        // A second arm's first table is a BASE of that arm, not a comma join of the first.
        // `pendingJoin` restores a join keyword the parser swallowed as the previous alias.
        join: pendingJoin && i > 0 ? pendingJoin : declaredJoin,
        isRelation,
      });
      if (i > 0) pendingJoin = null;
      if (f.on) {
        for (const c of conjuncts(f.on)) scope.predicates.push(predicateFact(c, "on", f.join ?? "INNER JOIN", ctx, rowset));
      }
    });
    for (const c of conjuncts(arm.where)) scope.predicates.push(predicateFact(c, "where", null, ctx, rowset));

    (arm.columns ?? []).forEach((col: any, i: number) => {
      const fact = exprFact(col.expr, ctx, rowset);
      if ("windowed" in fact && fact.windowed) scope.windowed = true;
      const key = col.as ?? (fact.kind === "column" ? fact.refs[0]?.column : null) ?? `#${i}`;
      scope.outputs.set(String(key).toLowerCase(), fact);
    });
    armScopes.push(scope);
  });

  // The merged relation describes the RETURNED TYPE of the whole statement: what a caller selecting
  // from it receives. It carries no authorization weight.
  const merged: RelationFact = {
    name,
    arms: arms.length,
    sources: armScopes.flatMap((s) => s.sources),
    predicates: armScopes.flatMap((s) => s.predicates),
    outputs: new Map(),
    grouped: armScopes.some((s) => s.grouped),
    windowed: armScopes.some((s) => s.windowed),
    distinct: armScopes.some((s) => s.distinct),
    armScopes,
  };
  armScopes.forEach((scope, armIndex) => {
    [...scope.outputs.entries()].forEach(([key, fact], position) => {
      if (armIndex === 0) { merged.outputs.set(key, fact); return; }
      // SQL aligns compound arms by POSITION, not by each arm's own alias.
      const first = [...merged.outputs.keys()][position];
      if (first) merged.outputs.set(first, mergeArmFacts(merged.outputs.get(first)!, fact));
    });
  });
  return merged;
}

/**
 * Resolve a reference to a relation's output into the facts that output actually IS.
 *
 * Returns a LIST, because one reference can denote several facts and authorizing only the first is
 * the same lost-provenance mistake one level down:
 *   - a compound relation exports one fact PER ARM at each position, and
 *     `WITH c AS (safe UNION ALL unsafe) SELECT n FROM c` returns both;
 *   - `SELECT * FROM c` returns everything `c` exports, not nothing.
 *
 * Resolution is recursive, so a nested chain resolves through every link. Cycles, missing exports
 * and references that cannot be attributed to one relation become `unknown`, which callers must
 * treat as a refusal rather than falling back to searching relations by name.
 */
export function resolveReferences(
  fact: ExprFact, scope: RelationFact, relations: Map<string, RelationFact>, seen: Set<string> = new Set(),
): ExprFact[] {
  const relationSources = scope.sources.filter((s) => s.isRelation && s.table);

  if (fact.kind === "column") {
    const ref = fact.refs[0];
    if (!ref) return [fact];
    let source: SourceFact | undefined;
    if (ref.source) {
      const wanted = ref.source.toLowerCase();
      source = relationSources.find((s) => (s.alias ?? s.table ?? "").toLowerCase() === wanted);
      if (!source) return [fact];               // a base-table column is already its own fact
    } else {
      // Unqualified against more than one relation cannot be attributed to either.
      if (relationSources.length > 1) return [UNKNOWN("unqualified reference to more than one relation")];
      if (relationSources.length === 0) return [fact];
      source = relationSources[0];
    }
    const target = relations.get(String(source.table).toLowerCase());
    if (!target) return [UNKNOWN(`reference to an undefined relation: ${source.table}`)];
    if (target.unresolvable) return [UNKNOWN(target.unresolvable)];
    const key = `${String(source.table).toLowerCase()}.${ref.column.toLowerCase()}`;
    if (seen.has(key)) return [UNKNOWN("cyclic output provenance")];
    const next = new Set([...seen, key]);
    // EVERY arm exports a fact at this position, and each is a separate claim.
    const armScopes = target.armScopes.length > 0 ? target.armScopes : [target];
    const out: ExprFact[] = [];
    for (const arm of armScopes) {
      const inner = arm.outputs.get(ref.column.toLowerCase());
      if (!inner) { out.push(UNKNOWN(`relation ${source.table} does not export ${ref.column}`)); continue; }
      out.push(...resolveReferences(inner, arm, relations, next));
    }
    return out;
  }

  if (fact.kind === "star") {
    // A star over a relation returns everything that relation exports. Treating it as carrying no
    // facts would hide exactly what the caller receives.
    if (relationSources.length === 0) return [fact];
    const out: ExprFact[] = [];
    for (const s of relationSources) {
      const target = relations.get(String(s.table).toLowerCase());
      if (!target) { out.push(UNKNOWN(`reference to an undefined relation: ${s.table}`)); continue; }
      if (target.unresolvable) { out.push(UNKNOWN(target.unresolvable)); continue; }
      const armScopes = target.armScopes.length > 0 ? target.armScopes : [target];
      for (const arm of armScopes) {
        for (const [column, inner] of arm.outputs) {
          const key = `${String(s.table).toLowerCase()}.${column}`;
          if (seen.has(key)) { out.push(UNKNOWN("cyclic output provenance")); continue; }
          out.push(...resolveReferences(inner, arm, relations, new Set([...seen, key])));
        }
      }
    }
    return out.length > 0 ? out : [fact];
  }

  if (fact.kind === "aggregate" || fact.kind === "derived") {
    return [{ ...fact, inputs: fact.inputs.flatMap((i) => resolveReferences(i, scope, relations, seen)) }];
  }
  if (fact.kind === "rowcount") {
    return [{ ...fact, target: resolveReferences(fact.target, scope, relations, seen)[0] ?? fact.target }];
  }
  return [fact];
}

/**
 * Parse SQL into facts. Never throws.
 *
 * Over-length input is refused before parsing: parsing is synchronous and cannot be interrupted, so
 * the length bound is the only in-process guard against a pathological input holding the event loop.
 */
export function analyzeSqlFacts(sql: string): QueryFacts {
  if (typeof sql !== "string" || sql.trim().length === 0) return { parsed: false, reason: "empty sql" };
  if (sql.length > MAX_SQL_LENGTH) {
    return { parsed: false, reason: `sql exceeds ${MAX_SQL_LENGTH} characters` };
  }
  let ast: any;
  try {
    ast = parser.astify(sql, { database: "postgresql" });
  } catch (error) {
    return { parsed: false, reason: `parse failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` };
  }
  if (Array.isArray(ast)) ast = ast[0];
  if (!ast || ast.type !== "select") return { parsed: false, reason: "not a single SELECT statement" };

  const cteNames = new Set<string>();
  const duplicated = new Set<string>();
  for (const c of ast.with ?? []) {
    const n = String(c.name?.value ?? c.name ?? "").toLowerCase();
    if (!n) continue;
    if (cteNames.has(n)) duplicated.add(n);
    cteNames.add(n);
  }

  const ctx: BuildContext = { cteNames, relations: new Map(), nextSubquery: { value: 0 } };
  for (const c of ast.with ?? []) {
    const n = String(c.name?.value ?? c.name ?? "").toLowerCase();
    if (!n || !c.stmt) continue;
    if (duplicated.has(n)) {
      // A name defined twice cannot be resolved to one rowset, so nothing may be proved through it.
      ctx.relations.set(n, {
        name: n, arms: 1, sources: [], predicates: [], outputs: new Map(),
        grouped: false, windowed: false, distinct: false, armScopes: [],
        unresolvable: `relation ${n} is defined more than once`,
      });
      continue;
    }
    ctx.relations.set(n, relationFact(c.stmt, n, ctx));
  }
  const outer = relationFact(ast, "", ctx);
  ctx.relations.set("", outer);
  return { parsed: true, relations: ctx.relations, outer };
}

/**
 * Can this relation emit each value of `column` at most once?
 *
 * Only the plain single-source projection of a unique key is proved: one row of the table in, at
 * most one row out. Every compound, joined, grouped, windowed or distinct-dependent shape is
 * `unknown` and fails closed -- uniqueness is never inferred from selecting the right column.
 */
export function keyMultiplicity(
  rel: RelationFact, outputName: string, uniqueKeys: (table: string) => string[],
): Multiplicity {
  const fact = rel.outputs.get(outputName.toLowerCase());
  if (!fact) return "unknown";
  // An aggregate or a transformation of a key is not the key.
  if (fact.kind !== "column") return fact.kind === "unknown" ? "unknown" : "may_repeat";
  if (rel.arms !== 1) return "may_repeat";
  if (rel.sources.length !== 1) return "may_repeat";
  if (rel.grouped || rel.windowed) return "unknown";
  const source = rel.sources[0];
  if (!source.table || source.isRelation) return "unknown";
  const ref = fact.refs[0];
  if (!ref) return "unknown";
  const keys = uniqueKeys(source.table.toLowerCase()).map((k) => k.toLowerCase());
  return keys.includes(ref.column.toLowerCase()) ? "at_most_one" : "may_repeat";
}

/** Every alias and table name in scope, mapped to what it stands for. */
export function scopeAliases(rel: RelationFact): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of rel.sources) {
    if (!s.table) continue;
    const t = s.table.toLowerCase();
    map.set(t, t);
    if (s.alias) map.set(s.alias.toLowerCase(), t);
  }
  return map;
}

/** The restrictive top-level conjuncts of a relation, excluding an OUTER join's ON. */
export function restrictingPredicates(rel: RelationFact): PredicateFact[] {
  return rel.predicates.filter((p) => {
    if (!p.restrictive) return false;
    // An outer join's ON keeps the preserved side, so it restricts nothing.
    if (p.position === "on" && p.joinKind && /\b(LEFT|RIGHT|FULL)\b/i.test(p.joinKind)) return false;
    return true;
  });
}
