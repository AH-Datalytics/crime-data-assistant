/**
 * P4.1 final-statement binding for the NIBRS MODEL paths (initial and database-error retry).
 *
 * The rule: the SQL that receives the final applicable checks is the SQL actually prepared for
 * execution. On these two paths the model's statement is checked, then the optimizer and the schema
 * corrector may legitimately rewrite it. Those rewrites stay; what changes is that the FINAL checks
 * now run on the rewritten text, and only a statement that passes them receives an execution
 * authority. The worker verifies that authority's SQL identity immediately before it prepares.
 *
 * The final applicable checks, in order: SQL safety (single read-only SELECT, bounded LIMIT), schema
 * validity (the corrector re-runs its own check), and the request contract. A check that itself
 * rewrites the statement (the sanitizer's LIMIT, a schema correction, a contract rewrite) makes its
 * output the candidate, and that output must pass every check UNCHANGED in the next round. Two rounds,
 * never a loop: a statement the checks keep rewriting is refused.
 *
 * The authority is issued only here, registered in a module-private WeakMap and frozen. A copy, a
 * caller-made object with a correct hash, or a frozen but unchecked object is not authority.
 *
 * NOT covered (they keep the legacy executeWithTimeout): owned and deterministic builders, the
 * application-generated fallback, other tabs, helpers and embeds. No source-version identity: that
 * invariant stays deferred and is not represented here by any path, size or timestamp.
 */
import { createHash } from "node:crypto";
import { validateAndSanitize } from "./sql-safety";
import { queryContractFailureMessage, type QueryContractSqlValidation } from "./query-contract-validator";

export type NibrsExecutionPath = "model-initial" | "model-retry";

export type NibrsExecutionAuthority = Readonly<{
  sql: string;
  sha256: string;
  path: NibrsExecutionPath;
  /** How many check rounds it took for the statement to pass unchanged (1 or 2). */
  rounds: number;
}>;

export type FinalNibrsStatementCheck =
  | { ok: true; authority: NibrsExecutionAuthority; contract: QueryContractSqlValidation }
  | { ok: false; stage: "safety" | "schema" | "contract" | "unsettled"; reason: string; sql: string; contract: QueryContractSqlValidation | null };

type SchemaCheck = { ok: boolean; sql?: string; corrected?: boolean; error?: string };

const ISSUED = new WeakMap<object, string>();

export function nibrsSqlSha256(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

/**
 * Run the final applicable checks on the statement that will execute, and issue its authority.
 * `schema` and `contract` are the route's own checks, passed in so the route keeps recording its
 * guardrails and so no check is re-implemented here.
 */
export function finalizeNibrsStatement(opts: {
  sql: string;
  path: NibrsExecutionPath;
  schema: (sql: string) => SchemaCheck;
  contract: (sql: string) => QueryContractSqlValidation;
}): FinalNibrsStatementCheck {
  let candidate = opts.sql;
  for (let round = 1; round <= 2; round += 1) {
    const safety = validateAndSanitize(candidate);
    if (!safety.valid || !safety.sanitized) {
      return { ok: false, stage: "safety", reason: safety.error || "the statement failed the SQL safety check", sql: candidate, contract: null };
    }
    let checked = safety.sanitized;
    const schema = opts.schema(checked);
    if (!schema.ok) {
      return { ok: false, stage: "schema", reason: schema.error || "the statement failed schema validation", sql: checked, contract: null };
    }
    if (schema.corrected && schema.sql) checked = schema.sql;
    const contract = opts.contract(checked);
    const failure = queryContractFailureMessage(contract);
    if (failure) return { ok: false, stage: "contract", reason: failure, sql: contract.sql, contract };
    checked = contract.sql;
    if (checked === candidate) {
      const authority: NibrsExecutionAuthority = Object.freeze({ sql: checked, sha256: nibrsSqlSha256(checked), path: opts.path, rounds: round });
      ISSUED.set(authority, authority.sha256);
      return { ok: true, authority, contract };
    }
    // A check rewrote the statement: the rewritten form is what would run, so it must pass unchanged.
    candidate = checked;
  }
  return { ok: false, stage: "unsettled", reason: "the final checks kept rewriting the statement", sql: candidate, contract: null };
}

/** Null when this authority was issued by the final check and still names the statement it approved. */
export function nibrsExecutionAuthorityIssue(authority: NibrsExecutionAuthority): string | null {
  if (!authority || typeof authority !== "object" || !ISSUED.has(authority)) {
    return "the statement was not issued by the final NIBRS statement check";
  }
  if (!Object.isFrozen(authority)) return "the execution authority was unfrozen";
  const approved = ISSUED.get(authority);
  if (authority.sha256 !== approved || nibrsSqlSha256(authority.sql) !== approved) {
    return "the statement differs from the one that passed the final checks";
  }
  return null;
}
