/**
 * P3.1a — request-decision OBSERVER, observation only.
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT.
 * It measures what the existing SQL-independent capability predicates WOULD decide if they were
 * evaluated before SQL exists. It does NOT claim that production currently decides there: today
 * every one of these rules is reachable only through `validateQueryContractSql`, which requires
 * `sql`. That gap is the measured justification for the request-decision stage, and conflating the
 * two claims is the specific error this file must not enable. Every report derived from it must say
 * which claim it is making.
 *
 * IT CHANGES NO BEHAVIOR. Nothing in the request path imports this module. It is disabled by
 * default and returns no records unless explicitly enabled by its caller, so "flags off preserves
 * behavior" is true by construction as well as by test.
 *
 * ── HOW IT REUSES PRODUCTION ────────────────────────────────────────────────────────────────
 *
 * It selects rule objects from the exported `SOURCE_CAPABILITY_RULES` and calls each rule's own
 * `when`. It does not reimplement, copy, or re-derive any predicate. A duplicate implementation
 * would measure the test rather than the system, which is the failure class that took seven review
 * rounds to remove from the P2.5 guard.
 *
 * ── WHY IT CANNOT SEE SQL ───────────────────────────────────────────────────────────────────
 *
 * Two independent guarantees, because one would be an assumption:
 *
 *   1. STRUCTURAL EXCLUSION — any rule declaring `requiresAnyTables`, `forbidsTables` or
 *      `forbiddenSql` is rejected before evaluation. Those rules are SQL/table dependent by
 *      declaration and are not pre-answer eligible.
 *   2. THROWING CONTEXT — the evaluation context exposes `sql` and `tables` as getters that THROW.
 *      If a selected predicate reads either, the observer records `analysis-incomplete` for that
 *      rule rather than returning a result. Absence of a declaration is not proof of independence;
 *      this makes any hidden read loud instead of silent.
 *
 * The full validator is never invoked, so no dummy SQL is ever fabricated.
 */
import { SOURCE_CAPABILITY_RULES } from "./source-capabilities";
import type { QueryContract, QueryContractSource } from "./query-contract";

/** Declarations that make a rule SQL/table dependent and therefore not pre-answer eligible. */
const SQL_DEPENDENT_DECLARATIONS = ["requiresAnyTables", "forbidsTables", "forbiddenSql"] as const;

export type ObservationState =
  | "fired"
  | "did_not_fire"
  | "analysis_incomplete";

export type ObservationRecord = {
  ruleId: string;
  source: QueryContractSource;
  state: ObservationState;
  /** The severity the production rule declares; carried so a report never re-derives it. */
  severity: string;
  /** Set only when `state` is `analysis_incomplete`. */
  incompleteReason?: string;
};

export type ObservationResult = {
  enabled: boolean;
  source: QueryContractSource;
  /** Rule ids excluded structurally, with the declaration that excluded each one. */
  excluded: { ruleId: string; declaration: string }[];
  /** Rule ids in the observation denominator for this source, in production order. */
  denominator: string[];
  records: ObservationRecord[];
};

/** True when the rule declares any SQL/table dependency. */
export function isSqlDependent(rule: unknown): string | null {
  const r = rule as Record<string, unknown>;
  for (const d of SQL_DEPENDENT_DECLARATIONS) {
    if (r[d] !== undefined) return d;
  }
  return null;
}

/**
 * The pre-answer evaluation context. `sql` and `tables` throw on read, so a predicate that depends
 * on them cannot silently return a value derived from a fabricated default.
 */
function preAnswerContext(question: string, source: QueryContractSource, contract: QueryContract) {
  const ctx = { question, source, contract };
  for (const forbidden of ["sql", "tables"]) {
    Object.defineProperty(ctx, forbidden, {
      enumerable: false,
      get() {
        throw new Error(
          "PRE_ANSWER_CONTEXT_HAS_NO_" + forbidden.toUpperCase() +
          ": a rule selected as SQL-independent read ctx." + forbidden +
          ". It is not pre-answer eligible.",
        );
      },
    });
  }
  return ctx as unknown as Parameters<(typeof SOURCE_CAPABILITY_RULES)[number]["when"]>[0];
}

/**
 * Observe which SQL-independent capability rules would decide this request before SQL exists.
 *
 * Source filtering happens FIRST, in the same order production uses
 * (`if (rule.source !== opts.source) continue;` precedes evaluating `when`). Evaluating a rule for
 * a source it does not apply to would count predicate text-matches that production would never
 * perform.
 */
export function observeRequestDecision(opts: {
  question: string;
  source: QueryContractSource;
  contract: QueryContract;
  /** Observation is OFF unless the caller opts in. Nothing in the request path does. */
  enabled?: boolean;
}): ObservationResult {
  const { question, source, contract } = opts;
  const enabled = opts.enabled === true;

  if (!enabled) {
    return { enabled: false, source, excluded: [], denominator: [], records: [] };
  }

  const excluded: { ruleId: string; declaration: string }[] = [];
  const denominator: string[] = [];
  const records: ObservationRecord[] = [];
  const ctx = preAnswerContext(question, source, contract);

  for (const rule of SOURCE_CAPABILITY_RULES) {
    // Production order: source first, then eligibility, then evaluation.
    if (rule.source !== source) continue;

    const declaration = isSqlDependent(rule);
    if (declaration) {
      excluded.push({ ruleId: rule.id, declaration });
      continue;
    }

    denominator.push(rule.id);
    try {
      const fired = rule.when(ctx);
      records.push({
        ruleId: rule.id,
        source: rule.source,
        state: fired ? "fired" : "did_not_fire",
        severity: rule.severity,
      });
    } catch (err) {
      records.push({
        ruleId: rule.id,
        source: rule.source,
        state: "analysis_incomplete",
        severity: rule.severity,
        incompleteReason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { enabled: true, source, excluded, denominator, records };
}
