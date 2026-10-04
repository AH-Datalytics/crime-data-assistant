/**
 * The three SHR execution surfaces, made mechanically distinct.
 *
 * There are exactly three ways SHR SQL reaches the database, and they are authorized differently:
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
 *   OWNED COUNT      (GC-080) SQL compiled from a typed count plan for every county-bound or
 *                    all-homicide request. The model writes no SQL for that family. Authority is the
 *                    compiler's registered, unaltered output (`shr-count-plan.ts`), checked here and
 *                    again at execution; the fact prover is not consulted on it.
 *
 * The distinction is carried by SEPARATE FUNCTIONS RETURNING SEPARATE TYPES, not by a boolean, a
 * caller assertion or a plan-family string. A flag can be passed wrongly by any caller and reads
 * identically at every call site; functions returning unassignable types cannot be
 * interchanged by accident, and a new execution helper has to state which authority it is claiming.
 */
import { proveShrVictimLicence, shrRequestedMeasure, SHR_MEASURE_CONFLICT_MESSAGE, type ShrVictimMeasure } from "./shr-murder-licence";
import { shrScopeViolation, SHR_SCOPE_GUARDRAIL, type ShrScopeBinding } from "./shr-county-scope";
import { validateQueryContractSql, type QueryContractSqlValidation } from "./query-contract-validator";
import type { QueryContract } from "./query-contract";
import { compiledShrCountIssue, type CompiledShrCount } from "./shr-count-plan";
import type { RoutingLogMeta } from "./routing-log-meta";
import { agencyTypeVerdict, agencyTypeRetryInstruction, requestedAgencyCategories, SHR_AGENCY_TYPE_GUARDRAIL } from "./shr-agency-type-authority";
import { YEAR_CLASS_UNAVAILABLE_TEXT, type ClassScope, type YearClassAvailability } from "./shr-agency-year-class";

const MODEL_AUTHORED = Symbol("shr.model-authored");
const DETERMINISTIC = Symbol("shr.deterministic-plan");

/** Result of validating SQL the MODEL wrote. Carries the fact-proved licence verdict. */
export type ModelAuthoredShrValidation = QueryContractSqlValidation & {
  readonly [MODEL_AUTHORED]: true;
  /** Why the licence was refused, when it was. Null when it was proved or not engaged. */
  licenceRefusal: string | null;
  /** Set when the statement counts only classified agencies (shr_agency_year_class): every counting scope, to disclose. */
  agencyTypeScopes?: ClassScope[] | null;
};

/** Result of validating SQL a DETERMINISTIC compiler assembled. */
export type DeterministicShrPlanValidation = QueryContractSqlValidation & {
  readonly [DETERMINISTIC]: true;
  agencyTypeScopes?: ClassScope[] | null;
};

/** GC-080: why an all-homicide request was refused. */
const HOMICIDE_LICENCE_MESSAGE =
  "I couldn't verify that the count covered all homicide victims -- every homicide type, each victim "
  + "counted once through its incident -- so I did not run the query.";

/** GC-080: why a statement outside the resolved county scope was refused. */
const SCOPE_MESSAGE =
  "I couldn't verify that the query was limited to the agency this county resolves to, so I did not "
  + "run it. I won't answer a county question with a countywide total or another agency's figures.";

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
  /** GC-080: the county scope the route bound before the model, enforced on this statement. */
  scope?: ShrScopeBinding | null;
  /** Whether the SHR agency/year classification is built and current (lib/shr-agency-year-class.ts). */
  yearClass?: YearClassAvailability | null;
  /** The conversation, for measure preservation on follow-ups (lib/measure-preservation.ts). */
  history?: { role: string; content: string }[] | null;
}): ModelAuthoredShrValidation {
  return withAgencyTypeVerdict(validateModelAuthoredShrSqlInner(opts), opts.yearClass ?? null, "model", opts.question);
}

function validateModelAuthoredShrSqlInner(opts: {
  question: string;
  sql: string;
  routingMeta?: RoutingLogMeta | null;
  scope?: ShrScopeBinding | null;
  history?: { role: string; content: string }[] | null;
}): ModelAuthoredShrValidation {
  const raw = validateQueryContractSql({
    question: opts.question,
    source: "shr",
    sql: opts.sql,
    routingMeta: opts.routingMeta ?? null,
    history: opts.history ?? null,
  });
  // ONE authority per surface. The legacy text prover still emits this licence for the
  // deterministic path, so its verdict is stripped here before the fact verdict is applied --
  // otherwise the same licence would be decided twice and the weaker prover could refuse something
  // the facts proved, which is the stronger authority being authoritative only when convenient.
  const base = withoutLegacyLicence(raw);
  // GC-080: the measure the REQUEST selected picks the licence; the SQL never does. The bound
  // county scope, when there is one, is enforced on the same statement.
  const measure: ShrVictimMeasure = shrRequestedMeasure(opts.question);
  const scope = opts.scope ?? null;
  const verdict = proveShrVictimLicence(base.sql, measure);
  if (verdict.proved) {
    return withScopeVerdict({ ...base, [MODEL_AUTHORED]: true as const, licenceRefusal: null }, scope);
  }
  if (measure === "murder") {
    return withScopeVerdict({
      ...base,
      [MODEL_AUTHORED]: true as const,
      licenceRefusal: verdict.reason,
      blockReasons: [...base.blockReasons, LICENCE_MESSAGE],
      enforced: [...new Set([...base.enforced, SHR_LICENCE_GUARDRAIL])],
    }, scope);
  }
  return withScopeVerdict({
    ...base,
    [MODEL_AUTHORED]: true as const,
    licenceRefusal: verdict.reason,
    blockReasons: [...base.blockReasons, measure === "conflict" ? SHR_MEASURE_CONFLICT_MESSAGE : HOMICIDE_LICENCE_MESSAGE],
    enforced: [...new Set([...base.enforced, SHR_LICENCE_GUARDRAIL])],
  }, scope);
}

/**
 * City/County membership authority (Codex combined ruling and SHR classification ruling SCA-1/SCA-2, 2026-10-02;
 * lib/shr-agency-type-authority.ts). The REQUEST decides whether the answer depends on City/County membership and
 * which category; when it does, the counted rows of every counting scope must carry that category from
 * shr_agency_year_class. Model SQL that breaks the rule gets one retry with the instruction; an unavailable or stale
 * classification is an owned limitation, never "blank means City"; a deterministic plan that breaks it is blocked.
 * A statement that neither depends on agency type nor touches it is returned unchanged.
 */
function withAgencyTypeVerdict<T extends QueryContractSqlValidation>(result: T, yearClass: YearClassAvailability | null, mode: "model" | "deterministic", question: string): T & { agencyTypeScopes?: ClassScope[] | null } {
  let requested = requestedAgencyCategories(question);
  // A deterministic compiler that classifies on its own account (the name-match fallback restricts a named place to
  // its City agency) carries its own category: the verdict still requires it on the counted rows, as City or County.
  // Model SQL gets no such allowance -- the request alone decides.
  // A deterministic plan that decides membership IN CODE (the accepted city ranking reads the evidence tables through
  // lib/shr-agency-classification.ts) does not classify in SQL at all, so the request's category is not a SQL
  // obligation for it: only the legacy-type ban applies. One that classifies in SQL must do it on its counted rows.
  if (mode === "deterministic") requested = /\bshr_agency_year_class\b/i.test(result.sql) ? (requested.length > 0 ? requested : ["City", "County"]) : [];
  const verdict = agencyTypeVerdict(result.sql, requested);
  if (!verdict.touches) return result;
  const enforced = [...new Set([...result.enforced, SHR_AGENCY_TYPE_GUARDRAIL])];
  const needsClass = requested.length > 0 || /\bshr_agency_year_class\b/i.test(result.sql);
  if (needsClass && (!yearClass || !yearClass.available)) {
    return { ...result, enforced, blockReasons: [...result.blockReasons, YEAR_CLASS_UNAVAILABLE_TEXT], agencyTypeScopes: null };
  }
  if (!verdict.ok) {
    console.log(`[shr][agency-type] ${verdict.problems.join("; ")}`);
    return mode === "model"
      ? { ...result, enforced, retryIssues: [...result.retryIssues, `${SHR_AGENCY_TYPE_GUARDRAIL}: ${verdict.problems.join("; ")}. ${agencyTypeRetryInstruction(requested)}`], agencyTypeScopes: null }
      : { ...result, enforced, blockReasons: [...result.blockReasons, YEAR_CLASS_UNAVAILABLE_TEXT], agencyTypeScopes: null };
  }
  return { ...result, enforced, agencyTypeScopes: verdict.scopes.length > 0 ? verdict.scopes : null };
}

/** Add the county-scope refusal (GC-080) when a bound scope is violated. Unchanged without one. */
function withScopeVerdict<T extends QueryContractSqlValidation>(result: T, scope: ShrScopeBinding | null): T {
  if (!scope) return result;
  const violation = shrScopeViolation(result.sql, scope);
  if (!violation) return result;
  console.log(`[shr][scope] ${violation}`);
  return {
    ...result,
    blockReasons: [...result.blockReasons, SCOPE_MESSAGE],
    enforced: [...new Set([...result.enforced, SHR_SCOPE_GUARDRAIL])],
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

const RATIO_UNMODELED_RULE = "structural-measure-unit-unmodeled";

/** The result without one structural rule's tag, warning, retry issue or block (same shape as withoutLegacyLicence). */
function withoutRule(result: QueryContractSqlValidation, rule: string): QueryContractSqlValidation {
  return {
    ...result,
    warnings: result.warnings.filter((w) => w !== rule),
    enforced: result.enforced.filter((e) => e !== rule),
    retryIssues: result.retryIssues.filter((issue) => !issue.includes(rule)),
    blockReasons: result.blockReasons.filter((reason) => !reason.includes(rule)),
  };
}

const COMPILED_COUNT = Symbol("shr.owned-count");

/** Result of validating an OWNED COUNT the application compiled (GC-080). Carries the compilation. */
export type CompiledShrCountValidation = QueryContractSqlValidation & {
  readonly [COMPILED_COUNT]: true;
  readonly compiled: CompiledShrCount;
};

export const SHR_OWNED_COUNT_GUARDRAIL = "shr-owned-count-not-compiler-output";

const OWNED_COUNT_MESSAGE =
  "I couldn't confirm that the query was exactly the count the application built for this question, "
  + "so I did not run it.";

/**
 * Validate an owned count (GC-080). The third surface: SQL the application compiled from a typed plan
 * for a county-bound or all-homicide request. It takes the COMPILED OBJECT, never loose SQL plus a flag:
 * the compiler registered it as issued, and it must still be exactly what its plan compiles to.
 *
 * The compiler owns the measure, the ORI/range scope and the counted expression, so for an
 * all-homicide plan the legacy murder-only row-count rule is withdrawn -- on the plan's own measure,
 * not a re-read of the question. Every other contract finding still applies, and a validator rewrite
 * of the statement is refused rather than executed: what runs is the compiler's text or nothing.
 */
export function validateCompiledShrCount(opts: {
  question: string;
  compiled: CompiledShrCount;
  routingMeta?: RoutingLogMeta | null;
}): CompiledShrCountValidation {
  const issue = compiledShrCountIssue(opts.compiled);
  const raw = validateQueryContractSql({
    question: opts.question,
    source: "shr",
    sql: opts.compiled.sql,
    routingMeta: opts.routingMeta ?? null,
  });
  const licensed = !issue && opts.compiled.plan.measure === "homicide" ? withoutLegacyLicence(raw) : raw;
  // Measure preservation (Codex :34106): an ISSUED, unaltered sex-ratio compilation computes its ratio from two
  // victim counts the compiler itself selects on the same rows (v.sex = 'Male' / 'Female'). The structural share
  // proof cannot trace a ratio projected out of the plan's CTE, so its one "unit unmodeled" retry is withdrawn here
  // -- for this compiler output only. Every other rule, and the full check on model-written SQL, is unchanged.
  const base = !issue && opts.compiled.plan.ratio ? withoutRule(licensed, RATIO_UNMODELED_RULE) : licensed;
  const problem = issue ?? (base.sql !== opts.compiled.sql ? "the validator rewrote the compiled statement" : null);
  if (problem) console.log(`[shr][owned-count] refused: ${problem}`);
  return {
    ...base,
    sql: opts.compiled.sql,
    ...(problem ? {
      blockReasons: [...base.blockReasons, OWNED_COUNT_MESSAGE],
      enforced: [...new Set([...base.enforced, SHR_OWNED_COUNT_GUARDRAIL])],
    } : {}),
    [COMPILED_COUNT]: true as const,
    compiled: opts.compiled,
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
  /** GC-080: the county scope bound for this plan, enforced on its statement. */
  scope?: ShrScopeBinding | null;
  /** An owned plan's validation contract, when it differs from the question's (lib/city-ranking.ts rankingValidationContract). */
  contract?: QueryContract | null;
  /** Whether the SHR agency/year classification is built and current (lib/shr-agency-year-class.ts). */
  yearClass?: YearClassAvailability | null;
}): DeterministicShrPlanValidation {
  const raw = validateQueryContractSql({
    question: opts.question,
    source: "shr",
    sql: opts.sql,
    routingMeta: opts.routingMeta ?? null,
    contract: opts.contract ?? null,
  });
  // Legacy validation is unchanged for murder plans. An explicit all-homicide request (GC-080)
  // cannot carry the legacy murder-only row-count rule, so for that measure only the rule is
  // replaced by the fact-proved homicide licence -- a replacement, never an exemption.
  const measure = shrRequestedMeasure(opts.question);
  let base: QueryContractSqlValidation = raw;
  if (measure !== "murder") {
    base = withoutLegacyLicence(raw);
    const verdict = proveShrVictimLicence(base.sql, measure);
    if (!verdict.proved) {
      console.log(`[shr][licence] homicide plan unproved: ${verdict.reason}`);
      base = { ...base, blockReasons: [...base.blockReasons, measure === "conflict" ? SHR_MEASURE_CONFLICT_MESSAGE : HOMICIDE_LICENCE_MESSAGE], enforced: [...new Set([...base.enforced, SHR_LICENCE_GUARDRAIL])] };
    }
  }
  return withAgencyTypeVerdict({ ...withScopeVerdict(base, opts.scope ?? null), [DETERMINISTIC]: true as const }, opts.yearClass ?? null, "deterministic", opts.question);
}
