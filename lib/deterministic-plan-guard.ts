import { buildQueryContract, type QueryContractSource } from "./query-contract";
import { evaluateStructuralSemantics } from "./structural-semantics";

/**
 * Structural proof for SQL that the model never sees.
 *
 * Counting `runContractValidation` call sites proved nothing about reachability, and the review was
 * right: in `app/api/query/route.ts` that helper is defined at line 1332, while the indexed-state,
 * multi-city and Historical city-change plans execute at 936, 992 and 1116 and return. Three
 * factual branches could execute with no structural proof at all.
 *
 * A deterministic plan cannot be retried -- its SQL is built by the application, not generated -- so
 * any finding at all is a refusal rather than a rewrite request. That makes this stricter than the
 * model path on purpose: hand-written SQL that fails the same check as generated SQL is a bug in the
 * builder, and shipping a wrong answer from it is worse, not better, for being deterministic.
 *
 * Every one of the 21 deterministic plans replayed from the production log passes cleanly, so this
 * gate is expected to be silent. It exists so that a future edit to a builder cannot quietly
 * introduce the substitution this increment was written to stop.
 */
export function deterministicPlanRefusal(opts: {
  question: string;
  source: QueryContractSource;
  sql: string | null | undefined;
  /** An owned plan's validation contract, when it differs from the question's (lib/city-ranking.ts rankingValidationContract). */
  contract?: ReturnType<typeof buildQueryContract> | null;
}): { message: string; ruleIds: string[] } | null {
  const sql = (opts.sql ?? "").trim();
  if (!sql) return null;

  const contract = opts.contract && opts.contract.source === opts.source ? opts.contract : buildQueryContract(opts.question, opts.source);
  if (!contract) return null;

  const findings = evaluateStructuralSemantics({
    question: opts.question, source: opts.source, contract, sql,
  });
  if (findings.length === 0) return null;

  return {
    message: findings[0].message,
    ruleIds: [...new Set(findings.map((finding) => finding.ruleId))],
  };
}
