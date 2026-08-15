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
 * Whether a column's NAME suggests it carries a year.
 *
 * A hint about naming, never a gate on what may be authored. It decides only whether an unmarked
 * choice must be justified -- a year column this pattern fails to recognise stays selectable, and
 * costs a sentence rather than being unreachable.
 */
export function isYearBearingColumn(column: string): boolean {
  return /(^|_)(year|yr)($|_)/i.test(column);
}

/**
 * EXACT key sets, at every level.
 *
 * Refusing unknown keys was first applied to coverage alone, because that is where the leak had
 * been found: the generator put `yearBearing` -- an OBSERVATION about a column name -- into the
 * hand-authored record, where it sat beside the decision looking equally authoritative and went
 * stale the moment the taxonomy was regenerated. The same hole was still open one level up and one
 * level down: `{kind:"always", observedAvailable:true}` produced no shape error and became
 * eligible. A rule that guards the place a defect was found, rather than the shape of the defect,
 * is a rule that catches it once.
 */
export const DECISION_KEYS: readonly string[] = ["coverage", "integrity", "availability", "receiptOwner", "evidence", "origin"];

/**
 * Policy that predates the workbook, migrated once into the authored record.
 *
 * It has no human answer and no confirmation behind it, so it can never be read as a decision
 * somebody made through the questions -- and it authorizes nothing, whatever its fields contain.
 * Structural rather than incidental: an entry with this origin is refused authority by
 * `capabilityAuthorizes` itself, so no consumer has to remember the rule.
 */
export const LEGACY_ORIGIN = "legacy";
const COVERAGE_KEYS: Record<string, readonly string[]> = {
  column: ["kind", "table", "yearColumn", "justification"],
  none: ["kind", "reason"],
};
const AVAILABILITY_KEYS: Record<string, readonly string[]> = {
  always: ["kind"],
  conditional: ["kind", "condition"],
};
const INTEGRITY_RULE_KEYS: readonly string[] = ["rule", "boundTo"];

function unknownKeys(value: object, allowed: readonly string[], what: string): string[] {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  return extra.length ? [`${what} carries ${extra.map((k) => JSON.stringify(k)).join(", ")}, which it does not have`] : [];
}

/**
 * An integrity rule is DRAFT PROSE or it is BOUND, and only a bound one authorizes.
 *
 *   "national_monthly must not outrun agency_monthly"          <- a sentence a person wrote
 *   { rule: "...", boundTo: "checks/rtci-alignment.sql" }      <- something that can be run
 *
 * Prose is worth authoring and worth keeping: it is the record of what "broken" means here, and it
 * is what a binding will later be written FROM. What it must not do is contribute to authorization.
 * Documenting that "eligibility asserts nothing about integrity" does not make an eligible
 * capability safe -- the field is mandatory precisely because integrity matters, so an eligibility
 * that ignores it grants exactly the assurance nobody checked.
 *
 * NEITHER FORM AUTHORIZES TODAY. `boundTo` resolves against nothing: see `integrityIsExecutable`,
 * which is the one predicate, and the only place that changes when the machinery exists.
 */
export function integrityRuleIsWellFormed(rule: unknown): boolean {
  if (nonEmptyString(rule)) return true;                        // draft prose
  if (typeof rule !== "object" || rule === null || Array.isArray(rule)) return false;
  const r = rule as { rule?: unknown; boundTo?: unknown };
  return nonEmptyString(r.rule) && nonEmptyString(r.boundTo)
    && unknownKeys(r, INTEGRITY_RULE_KEYS, "an integrity rule").length === 0;
}

/**
 * Whether an integrity rule can actually be CHECKED by something. Today nothing can.
 *
 * `{ rule, boundTo }` was introduced so a rule could name an executable check or a receipt
 * attestation. What it named was a string. There is no catalog to resolve that string against, no
 * resolver, and no runtime consumer of it -- so `boundTo: "banana"` bound exactly as much as
 * anything else, and prose plus an arbitrary second string authorized precisely what prose alone
 * had. That is the original defect wearing a narrower disguise.
 *
 * The shape is kept, because it is the form a real binding will be written in and drafts written
 * now will not have to be rewritten. The authorization it confers is none. This returns false for
 * every input by construction, and it will keep returning false until there is machinery that runs
 * a bound rule for this function to ask -- at which point this is the ONE place that changes, and
 * every consumer of `capabilityAuthorizes` inherits it. `scripts/test-stage2b-workbook.ts` asserts
 * that no shape whatsoever gets past it.
 */
export function integrityIsExecutable(integrity: unknown): boolean {
  void integrity;
  return false;
}

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

  bad.push(...unknownKeys(policy, DECISION_KEYS, "the decision"));

  if (coverage !== null && coverage !== undefined) {
    /**
     * DISCRIMINATED, so "this capability has no year dimension" is a DECISION rather than an
     * absence. It was previously written as the string "none" and normalised to null on import,
     * which made a considered answer indistinguishable from never having been asked -- the
     * capability read as undecided forever and the reasoning was discarded at the boundary.
     */
    const c = coverage as { kind?: unknown; table?: unknown; yearColumn?: unknown; reason?: unknown };
    if (typeof c !== "object" || Array.isArray(c)) {
      bad.push('coverage must be { kind: "column", table, yearColumn } or { kind: "none", reason }');
    } else if (c.kind === "column") {
      if (!nonEmptyString(c.table) || !nonEmptyString(c.yearColumn)) {
        bad.push("a column coverage basis must name a non-empty table and yearColumn");
      }
      bad.push(...unknownKeys(c, COVERAGE_KEYS.column, "a column coverage basis"));
    } else if (c.kind === "none") {
      if (!nonEmptyString(c.reason)) bad.push("a coverage of no-year-dimension must state its reason");
      bad.push(...unknownKeys(c, COVERAGE_KEYS.none, "a no-year-dimension coverage"));
    } else {
      bad.push(`coverage.kind must be "column" or "none", not ${JSON.stringify(c.kind)}`);
    }
  }
  if (integrity !== null && integrity !== undefined) {
    if (!Array.isArray(integrity) || integrity.length === 0) {
      bad.push("integrity must be a non-empty array of rules; an empty array states no rule");
    } else {
      for (const rule of integrity) {
        if (nonEmptyString(rule)) continue;                       // draft prose: well formed, non-authorizing
        if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
          bad.push("an integrity rule must be prose or { rule, boundTo }");
          continue;
        }
        const r = rule as { rule?: unknown; boundTo?: unknown };
        if (!nonEmptyString(r.rule) || !nonEmptyString(r.boundTo)) {
          bad.push("a bound integrity rule must carry a non-empty rule and the check it is boundTo");
        }
        bad.push(...unknownKeys(r, INTEGRITY_RULE_KEYS, "an integrity rule"));
      }
      if (!integrity.every(integrityRuleIsWellFormed)) {
        // Reported once more in aggregate so a caller checking only the count cannot miss it.
        if (bad.length === 0) bad.push("an integrity rule is neither prose nor a well-formed binding");
      }
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
      bad.push(...unknownKeys(a, AVAILABILITY_KEYS.conditional, "a conditional availability"));
    } else if (a.kind === "always") {
      bad.push(...unknownKeys(a, AVAILABILITY_KEYS.always, "an unconditional availability"));
    } else {
      bad.push(`availability.kind must be "always" or "conditional", not ${JSON.stringify(a.kind)}`);
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
  if (policy.origin !== undefined && policy.origin !== LEGACY_ORIGIN) {
    bad.push(`origin, when present, must be ${JSON.stringify(LEGACY_ORIGIN)}`);
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
  const coverage = policy?.coverage as
    { kind?: unknown; table?: unknown; yearColumn?: unknown; justification?: unknown } | null | undefined;
  if (!coverage || typeof coverage !== "object") return [];   // unauthored is not an error
  if (coverage.kind === "none") return [];                    // no year dimension names no basis
  const table = declared.find((entry) => entry.name === coverage.table);
  if (!table) {
    return [`coverage basis table ${JSON.stringify(coverage.table)} is not one the capability reads`];
  }
  if (!table.requiredColumns.includes(String(coverage.yearColumn))) {
    return [`coverage basis ${String(coverage.table)}.${String(coverage.yearColumn)} is not a required column of that table`];
  }
  /**
   * Enforced HERE, not only in the workbook, because the page is a convenience and this is the
   * boundary. A column whose name gives no sign of carrying a year may still be the right basis --
   * the heuristic must not block the honest answer -- but it must not become one through a single
   * click either, so the unmarked choice has to say why.
   */
  if (!isYearBearingColumn(String(coverage.yearColumn)) && !nonEmptyString(coverage.justification)) {
    return [`coverage basis ${String(coverage.table)}.${String(coverage.yearColumn)} does not look year-bearing, `
      + "so it must carry a justification saying why it is the coverage basis"];
  }
  return [];
}

/**
 * Fail closed: a null policy, one with any field still unauthored, or one whose authored fields are
 * the wrong shape authorizes nothing.
 *
 * Well-formedness, NOT authorization. A policy can be complete and correctly shaped while its
 * integrity rules are still unbound prose; that is a finished draft, and `capabilityAuthorizes` is
 * the predicate that decides whether it may do anything.
 */
export function policyIsComplete(policy: UnvalidatedPolicy | null): boolean {
  if (!policy) return false;
  if (POLICY_FIELDS.some((f) => policy[f] === null || policy[f] === undefined)) return false;
  return policyShapeErrors(policy).length === 0;
}

/**
 * Whether a capability may authorize: shape-complete, valid against its own contract, AND carrying
 * integrity rules that something can actually run.
 *
 * `policyIsComplete` cannot answer this alone, because shape is all it can see -- it does not know
 * which tables the capability reads. A well-shaped policy naming a stray coverage basis was
 * therefore GENERATED as eligible while `coverageBasisErrors` rejected it, so the authorization pin
 * itself was wrong and only a downstream regression noticed. Eligibility is one predicate, and it is
 * the one thing every consumer must agree on -- including the runtime gate, which must not use a
 * weaker test than the one the registry was pinned with.
 */
/**
 * Everything authorization requires EXCEPT an executable integrity rule.
 *
 * Split out so each condition is observable on its own. Nothing can authorize today -- no integrity
 * rule is executable -- which means every other guard sits behind a condition that is always false,
 * and a regression on `capabilityAuthorizes` cannot tell a working guard from a missing one. This is
 * where the migrated-legacy refusal is testable, and where it stays true on the day integrity
 * bindings arrive.
 */
export function authorizesApartFromIntegrity(
  policy: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): boolean {
  if (policy && policy.origin === LEGACY_ORIGIN) return false;
  return policyIsComplete(policy) && coverageBasisErrors(policy, declared).length === 0;
}

export function capabilityAuthorizes(
  policy: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): boolean {
  return authorizesApartFromIntegrity(policy, declared) && integrityIsExecutable(policy?.integrity);
}

/** Why a complete-looking policy still authorizes nothing. For reporting, never for gating. */
export function authorizationBlockers(
  policy: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): string[] {
  if (!policy) return ["no policy is authored"];
  const blockers = [...policyShapeErrors(policy), ...coverageBasisErrors(policy, declared)];
  if (policy.origin === LEGACY_ORIGIN) {
    blockers.push("this policy was migrated from before the workbook existed; nobody answered the "
      + "questions behind it, so it authorizes nothing until it is decided through the workbook");
  }
  for (const field of POLICY_FIELDS) {
    if (policy[field] === null || policy[field] === undefined) blockers.push(`${field} is not authored`);
  }
  if (!integrityIsExecutable(policy.integrity)) {
    blockers.push("no integrity rule can be executed yet: there is no check catalog, resolver or runtime "
      + "consumer for a rule's binding, so nothing authorizes until that machinery exists");
  }
  return blockers;
}
