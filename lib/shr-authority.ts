/**
 * The two SHR execution surfaces, made mechanically distinct.
 *
 * There are exactly two ways SHR SQL reaches the database, and they are authorized differently:
 *
 *   MODEL-AUTHORED   SQL written by the model. The AST/fact prover in `shr-murder-licence.ts` is
 *                    authoritative for the conditional murder-victim licence. If it cannot prove the
 *                    licence -- including because the SQL did not parse -- the query is refused. It
 *                    must NEVER fall back to the legacy text prover, because falling back to a
 *                    weaker authority on failure is the same as not having the stronger one.
 *
 *   DETERMINISTIC    SQL this repository's own compilers assemble from templates. It keeps its
 *                    existing legacy validation unchanged in this increment, because neither
 *                    evaluated SQL parser accepts the column-listed `VALUES` CTE those plans use.
 *
 * The distinction is carried by SEPARATE FUNCTIONS RETURNING SEPARATE TYPES, not by a boolean, a
 * caller assertion or a plan-family string. A flag can be passed wrongly by any caller and reads
 * identically at every call site; two functions returning two unassignable types cannot be
 * interchanged by accident, and a new execution helper has to state which authority it is claiming.
 */
import { proveShrMurderLicence } from "./shr-murder-licence";
import { validateQueryContractSql, type QueryContractSqlValidation } from "./query-contract-validator";
import type { RoutingLogMeta } from "./routing-log-meta";

const MODEL_AUTHORED = Symbol("shr.model-authored");
const DETERMINISTIC = Symbol("shr.deterministic-plan");

/** Result of validating SQL the MODEL wrote. Carries the fact-proved licence verdict. */
export type ModelAuthoredShrValidation = QueryContractSqlValidation & {
  readonly [MODEL_AUTHORED]: true;
  /** Why the licence was refused, when it was. Null when it was proved or not engaged. */
  licenceRefusal: string | null;
};

/** Result of validating SQL a DETERMINISTIC compiler assembled. */
export type DeterministicShrPlanValidation = QueryContractSqlValidation & {
  readonly [DETERMINISTIC]: true;
};

const LICENCE_MESSAGE =
  "I couldn't verify that the victims counted were restricted to murders through their incidents, "
  + "so I did not run the query. Counting SHR victim rows without that restriction would include "
  + "other homicide types, or count the same victim more than once.";

export const SHR_LICENCE_GUARDRAIL = "shr-murder-licence-unproved";

/**
 * Validate SQL the model wrote. The fact prover is authoritative here.
 *
 * A refusal is added to `blockReasons`, not `retryIssues`: an unprovable licence is not a
 * transcription slip the model can be expected to correct by rewriting the same shape, and
 * retrying an unproved count risks answering with it.
 */
export function validateModelAuthoredShrSql(opts: {
  question: string;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
}): ModelAuthoredShrValidation {
  const raw = validateQueryContractSql({
    question: opts.question,
    source: "shr",
    sql: opts.sql,
    routingMeta: opts.routingMeta ?? null,
  });
  // ONE authority per surface. The legacy text prover still emits this licence for the
  // deterministic path, so its verdict is stripped here before the fact verdict is applied --
  // otherwise the same licence would be decided twice and the weaker prover could refuse something
  // the facts proved, which is the stronger authority being authoritative only when convenient.
  const base = withoutLegacyLicence(raw);
  const verdict = proveShrMurderLicence(base.sql);
  if (verdict.proved) {
    return { ...base, [MODEL_AUTHORED]: true, licenceRefusal: null };
  }
  return {
    ...base,
    [MODEL_AUTHORED]: true,
    licenceRefusal: verdict.reason,
    blockReasons: [...base.blockReasons, LICENCE_MESSAGE],
    enforced: [...new Set([...base.enforced, SHR_LICENCE_GUARDRAIL])],
  };
}

/** The legacy text-prover rules that decide this same licence, removed so facts alone decide it. */
export const LEGACY_LICENCE_RULES = ["structural-row-count-unqualified"];

/**
 * Strip the legacy verdict from EVERY field it is recorded in.
 *
 * `validateQueryContractSql` records a structural finding in three places -- `warnings` (the bare
 * rule id), `retryIssues` (a message quoting the rule id) and `enforced` (the tag) -- and a block
 * severity would add a fourth. There is deliberately no early return keyed on one of them: gating
 * the removal on `enforced` coupled this to an implementation detail of the validator, so a finding
 * that ever landed only in `warnings` and `retryIssues` would have been left in place while the
 * function still claimed to have removed it.
 *
 * Everything not belonging to this licence must survive untouched, which is what the behavioural
 * test asserts -- a source-level check could not tell removal from the appearance of it.
 */
export function withoutLegacyLicence(result: QueryContractSqlValidation): QueryContractSqlValidation {
  const isLegacyTag = (value: string) => LEGACY_LICENCE_RULES.includes(value);
  const quotesLegacy = (text: string) => LEGACY_LICENCE_RULES.some((rule) => text.includes(rule));
  return {
    ...result,
    warnings: result.warnings.filter((w) => !isLegacyTag(w)),
    enforced: result.enforced.filter((e) => !isLegacyTag(e)),
    retryIssues: result.retryIssues.filter((issue) => !quotesLegacy(issue)),
    blockReasons: result.blockReasons.filter((reason) => !quotesLegacy(reason)),
  };
}

/**
 * Validate SQL a deterministic compiler assembled. Legacy validation only, unchanged.
 *
 * These plans are not model output: their murder filter and victim join are literal in the
 * template. They stay on this path until compiler-owned evidence is designed and reviewed.
 */
export function validateDeterministicShrPlanSql(opts: {
  question: string;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
}): DeterministicShrPlanValidation {
  const base = validateQueryContractSql({
    question: opts.question,
    source: "shr",
    sql: opts.sql,
    routingMeta: opts.routingMeta ?? null,
  });
  return { ...base, [DETERMINISTIC]: true };
}
