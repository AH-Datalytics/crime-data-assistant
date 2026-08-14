/**
 * The ONE validator for hand-authored capability policy.
 *
 * Every field a capability needs before it may authorize anything, and the shape each must take.
 * This lives in one module because it has now been got wrong twice by being written twice: a
 * "every field is non-null" check in the taxonomy harness, corrected there, and then reimplemented
 * in the inventory generator in its original shallow form. A type-valid policy carrying an empty
 * coverage table, an empty integrity array, or an empty receipt owner passed the shallow rule and
 * would have generated `authorizationEligible: true`.
 *
 * Observation cannot supply any of these values. An execution can see which tables and columns an
 * operation touched; it cannot see what a coverage basis MEANS, which integrity rule applies,
 * whether unavailability is expected, or who owns the receipt. So the values are authored by hand in
 * `scripts/fixtures/operation-taxonomy/capability-policy.json`, and this module decides whether
 * what was authored is complete and well formed.
 */
export const POLICY_FIELDS = ["coverage", "integrity", "availability", "receiptOwner"] as const;

/** Untrusted input: hand-edited JSON, so nothing about its shape may be assumed. */
export type UnvalidatedPolicy = Record<string, unknown>;

const nonEmptyString = (value: unknown): boolean => typeof value === "string" && value.trim() !== "";

/**
 * Shape problems in the fields that ARE authored.
 *
 * `null` means "not yet authored" and is not a problem. A wrong SHAPE is, whether or not the rest
 * of the entry is finished -- otherwise a malformed value sits in the file until the day it
 * completes the entry and silently grants authority.
 */
export function policyShapeErrors(policy: UnvalidatedPolicy): string[] {
  const bad: string[] = [];
  const { coverage, integrity, availability, availabilityCondition, receiptOwner, evidence } = policy;

  if (coverage !== null && coverage !== undefined) {
    const c = coverage as { table?: unknown; yearColumn?: unknown };
    if (typeof c !== "object" || Array.isArray(c) || !nonEmptyString(c.table) || !nonEmptyString(c.yearColumn)) {
      bad.push("coverage must be { table, yearColumn } with both non-empty");
    }
  }
  if (integrity !== null && integrity !== undefined) {
    if (!Array.isArray(integrity) || integrity.length === 0 || !integrity.every(nonEmptyString)) {
      bad.push("integrity must be a non-empty array of non-empty rules; an empty array states no rule");
    }
  }
  if (availability !== null && availability !== undefined) {
    /**
     * DISCRIMINATED, not an enum beside a loose sibling field. A flat `availability: "conditional"`
     * next to an optional `availabilityCondition` can represent a conditional with no condition, so
     * the invariant would live only here instead of in the shape -- and the type that was supposed
     * to describe it omitted the sibling entirely. This shape cannot be built wrong.
     */
    const a = availability as { kind?: unknown; condition?: unknown };
    if (typeof a !== "object" || Array.isArray(a)) {
      bad.push(`availability must be { kind: "always" } or { kind: "conditional", condition }, not ${JSON.stringify(availability)}`);
    } else if (a.kind === "conditional") {
      if (!nonEmptyString(a.condition)) bad.push("a conditional availability must state its condition");
    } else if (a.kind !== "always") {
      bad.push(`availability.kind must be "always" or "conditional", not ${JSON.stringify(a.kind)}`);
    } else if ("condition" in a) {
      bad.push("an unconditional availability must not carry a condition");
    }
  }
  if (receiptOwner !== null && receiptOwner !== undefined && !nonEmptyString(receiptOwner)) {
    bad.push("receiptOwner must be a non-empty owner");
  }
  if (!nonEmptyString(evidence) || String(evidence).trim().length <= 20) {
    bad.push("evidence must cite what the authored values rest on");
  }
  if (availabilityCondition !== undefined) {
    bad.push("availabilityCondition is not a field; the condition belongs inside availability");
  }
  return bad;
}

/**
 * Whether an authored coverage basis names a table AND column the capability actually reads.
 *
 * The pair matters, not just the table. Guarding only the table let a policy name an existing but
 * unrequired column on a legitimate emitted table -- `incidents.foreign_year` where the contract
 * requires only `incidents.year` -- and MIN/MAX over it succeeds, yielding a confident `passed` or
 * `failed` computed from a column the capability never reads. Reproduced exactly that way in review.
 *
 * Shared so the runtime guard and registry/policy validation apply one rule rather than two.
 */
export function coverageBasisErrors(
  policy: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): string[] {
  const coverage = policy?.coverage as { table?: unknown; yearColumn?: unknown } | null | undefined;
  if (!coverage || typeof coverage !== "object") return [];   // unauthored is not an error
  const table = declared.find((entry) => entry.name === coverage.table);
  if (!table) {
    return [`coverage basis table ${JSON.stringify(coverage.table)} is not one the capability reads`];
  }
  if (!table.requiredColumns.includes(String(coverage.yearColumn))) {
    return [`coverage basis ${String(coverage.table)}.${String(coverage.yearColumn)} is not a required column of that table`];
  }
  return [];
}

/**
 * Fail closed: a null policy, one with any field still unauthored, or one whose authored fields are
 * the wrong shape authorizes nothing.
 */
export function policyIsComplete(policy: UnvalidatedPolicy | null): boolean {
  if (!policy) return false;
  if (POLICY_FIELDS.some((f) => policy[f] === null || policy[f] === undefined)) return false;
  return policyShapeErrors(policy).length === 0;
}

/**
 * Whether a capability may authorize: shape-complete AND valid against its own contract.
 *
 * `policyIsComplete` cannot answer this alone, because shape is all it can see -- it does not know
 * which tables the capability reads. A well-shaped policy naming a stray coverage basis was
 * therefore GENERATED as eligible while `coverageBasisErrors` rejected it, so the authorization pin
 * itself was wrong and only a downstream regression noticed. Eligibility is one predicate, and it is
 * the one thing every consumer must agree on.
 */
export function capabilityAuthorizes(
  policy: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): boolean {
  return policyIsComplete(policy) && coverageBasisErrors(policy, declared).length === 0;
}
