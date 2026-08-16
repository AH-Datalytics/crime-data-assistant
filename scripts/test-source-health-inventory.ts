/**
 * Task 1 regression: the capability inventory is GENERATED from the derived catalogs.
 *
 * Three hand-authored inventories were wrong before this one (20, then 41, then 40 capabilities),
 * each because a human retyped what an observation had already established. So the assertions here
 * are not "does the inventory look right" -- they are "is the inventory exactly what the derived
 * registry says, and does the checked-in file still match what the generator produces".
 *
 * The generated file is checked in rather than read at runtime: `lib/` must not depend on a path
 * under `scripts/fixtures/`, and a build-time read would put a test fixture on the request path.
 */
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import {
  CAPABILITY_INVENTORY,
  specFor,
  SWEEP_ONLY,
  type CapabilitySpec,
} from "../lib/source-health-inventory";
import { renderInventory, INVENTORY_FILE } from "./generate-source-health-inventory";
import { capabilityFlagKey } from "../lib/capability-flag-key";
import { capabilityAuthorizes, coverageBasisErrors, policyIsComplete, type UnvalidatedPolicy } from "../lib/capability-policy";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
const CASES_FILE = path.join(DATA_DIR, "operation-cases.json");

type RegistryEntry = {
  artifact: string;
  prepDependencies: string[];
  emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  flagKey: string;
  policy: Record<string, unknown> | null;
  authorizationEligible: boolean;
};
const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;

let passed = 0, failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); passed += 1; }
  catch (e) { failed += 1; console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").slice(0, 6).join("\n        ")}`); }
}

// ---------------------------------------------------------------- the plan's assertions

check("the inventory is exactly the derived registry plus the sweep-only capability", () => {
  assert.deepStrictEqual(
    CAPABILITY_INVENTORY.map((s) => s.capabilityId).sort(),
    [...Object.keys(registry), ...SWEEP_ONLY].sort(),
    "inventory drifted from the derived registry",
  );
  for (const id of SWEEP_ONLY) {
    assert.ok(!registry[id], `${id} must NOT be in the operation registry: no operation reaches it`);
  }
});

check("table membership equals emittedDependencies exactly", () => {
  /**
   * Compared against emittedDependencies, not against the keys of requiredColumns.
   *
   * `SELECT COUNT(*) FROM t` depends on a table while naming no column of it. Building membership
   * from requiredColumns dropped such a table out of the inventory, and comparing only
   * required-column MAPS could not see it, because both sides were derived from the same keys.
   * Current fixture data has zero mismatches, so nothing here failed while the gap was open.
   */
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (!entry) continue;                       // the sweep-only capability has no operation row
    assert.deepStrictEqual(spec.tables.map((t) => t.name).sort(), [...entry.emittedDependencies].sort(),
      `${spec.capabilityId} table membership drifted from emittedDependencies`);
  }
});

check("required columns and preparation tables match the registry exactly", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (!entry) continue;
    // Tables with no named column carry an empty list rather than being absent.
    const expected = Object.fromEntries(entry.emittedDependencies.map((t) => [t, [...(entry.requiredColumns[t] ?? [])].sort()]));
    assert.deepStrictEqual(
      Object.fromEntries(spec.tables.map((t) => [t.name, [...t.requiredColumns].sort()])),
      expected,
      `${spec.capabilityId} required columns drifted`,
    );
    assert.deepStrictEqual(spec.preparationTables.map((t) => t.name).sort(), [...entry.prepDependencies].sort(),
      `${spec.capabilityId} preparation tables drifted`);
  }
});

check("a table emitted without a named column survives generation", () => {
  /**
   * The property the fixture cannot exercise, driven through the real generator with a synthetic
   * registry. Without this, the emittedDependencies fix is untested: every assertion above passes
   * on data that has no such table.
   */
  const synthetic = {
    "shr::t_alpha+t_beta::t_alpha(x)": {
      artifact: "shr",
      prepDependencies: [],
      emittedDependencies: ["t_alpha", "t_beta"],
      requiredColumns: { t_alpha: ["x"] },      // t_beta is read by COUNT(*), naming no column
      flagKey: capabilityFlagKey("shr", "shr::t_alpha+t_beta::t_alpha(x)"),
      policy: null,
      authorizationEligible: false,
    },
  };
  const rendered = renderInventory(synthetic as never);
  assert.ok(rendered.includes(`{ name: "t_beta", requiredColumns: [], minRows: 1 }`),
    "a table with no named column was dropped from the generated inventory");
  assert.ok(rendered.includes(`{ name: "t_alpha", requiredColumns: ["x"], minRows: 1 }`),
    "the column-bearing table should be unaffected");
});

check("an unavailable operation seals no capability", () => {
  const cases = JSON.parse(fs.readFileSync(CASES_FILE, "utf8")) as Record<string, { terminalKind: string; capability: string | null }>;
  for (const [branch, c] of Object.entries(cases)) {
    if (c.terminalKind !== "factual") assert.strictEqual(c.capability, null, `${branch} must seal nothing`);
  }
});

check("every capability owns a provider with atomic acquisition", () => {
  for (const spec of CAPABILITY_INVENTORY) assert.strictEqual(typeof spec.database.acquire, "function", spec.capabilityId);
});

check("current.national is registered although no operation reaches it", () => {
  // Frozen spec §8:241 requires independent validation of the Current national and sample-agency
  // tables. It has no eligible operation, so it cannot come from the operation catalog; Task 11's
  // sweep is what evaluates it.
  for (const id of SWEEP_ONLY) assert.ok(specFor(id), `${id} is missing from the inventory`);
});

check("no capability authorizes anything until its policy is authored AND well formed", () => {
  /**
   * Judged by the SHARED validator, not by a local "every field is non-null" rule.
   *
   * Repeating the shallow rule here is worse than omitting the check: it confirmed the generator's
   * own error instead of detecting it, because both sides applied the same wrong test. A policy with
   * an empty coverage table, an empty integrity array, or an empty receipt owner is type-valid,
   * non-null, and must NOT authorize.
   */
  for (const spec of CAPABILITY_INVENTORY) {
    assert.strictEqual(spec.authorizationEligible, capabilityAuthorizes(spec.policy as UnvalidatedPolicy | null, spec.tables),
      `${spec.capabilityId} misstates its eligibility`);
    const entry = registry[spec.capabilityId];
    if (!entry) continue;
    assert.deepStrictEqual(spec.policy, entry.policy, `${spec.capabilityId} policy drifted from the registry`);
    // Cross-check the registry's own pin against the same validator, so the two cannot disagree.
    assert.strictEqual(entry.authorizationEligible,
      capabilityAuthorizes(entry.policy, entry.emittedDependencies.map((name) => ({ name, requiredColumns: entry.requiredColumns[name] ?? [] }))),
      `${spec.capabilityId}: the registry's eligibility pin disagrees with the shared predicate`);
    assert.strictEqual(spec.authorizationEligible, entry.authorizationEligible,
      `${spec.capabilityId}: inventory eligibility drifted from the registry pin`);
  }
});

check("the GENERATOR refuses eligibility for a non-null but malformed policy", () => {
  /**
   * Driven through renderInventory, because the assertions over real data cannot tell the shallow
   * rule from the shared validator: every authored policy currently has null fields, so both rules
   * answer false. This is the only test that fails if the generator goes back to "all four fields
   * are non-null" -- which is the form it shipped in and the form the harness had already corrected.
   */
  const id = "shr::t_gamma::t_gamma(x)";
  const malformed = {
    coverage: { kind: "column", table: "", yearColumn: "year" },       // empty table name
    integrity: [],                                     // no rule is not a rule
    availability: { kind: "always" },
    receiptOwner: "",                                  // empty owner
    evidence: "type-valid and entirely non-null, yet it states nothing at all",
  };
  const rendered = renderInventory({
    [id]: {
      artifact: "shr", prepDependencies: [], emittedDependencies: ["t_gamma"],
      requiredColumns: { t_gamma: ["x"] }, flagKey: capabilityFlagKey("shr", id),
      policy: malformed, authorizationEligible: false,
    },
  } as never);
  assert.ok(!/authorizationEligible: true/.test(rendered),
    "the generator granted authority to a policy whose fields are non-null but state nothing");
});

check("an authored coverage basis must belong to the capability's emitted contract", () => {
  /**
   * Rejected at validation time as well as at runtime, so a stray basis is caught when it is
   * AUTHORED rather than only when it is evaluated. Driven partly by a synthetic spec because no
   * capability has coverage authored yet -- over real data alone this would assert nothing.
   */
  for (const spec of CAPABILITY_INVENTORY) {
    assert.deepStrictEqual(coverageBasisErrors(spec.policy as UnvalidatedPolicy | null, spec.tables), [],
      `${spec.capabilityId} authored a coverage basis outside its emitted contract`);
  }
  const declared = [{ name: "incidents", requiredColumns: ["year"] }];
  assert.strictEqual(coverageBasisErrors({ coverage: { kind: "column", table: "incidents", yearColumn: "foreign_year" } } as never, declared).length, 1,
    "an existing but unrequired column must be rejected");
  assert.strictEqual(coverageBasisErrors({ coverage: { kind: "column", table: "unrelated", yearColumn: "year" } } as never, declared).length, 1,
    "a table outside the contract must be rejected");
  assert.deepStrictEqual(coverageBasisErrors({ coverage: { kind: "column", table: "incidents", yearColumn: "year" } } as never, declared), [],
    "a basis inside the contract must be accepted");
});

check("the GENERATOR refuses eligibility for a COMPLETE policy with a stray basis", () => {
  /**
   * Shape completeness is not enough, and this is the only test that can tell the two predicates
   * apart. The policy below passes every shape rule -- all four fields authored, availability
   * discriminated, evidence cited -- and names a coverage column that exists nowhere in the
   * capability's contract. Judging eligibility by shape alone generated `authorizationEligible: true`
   * while coverageBasisErrors rejected the same policy, so the authorization PIN was wrong and only a
   * downstream assertion noticed.
   */
  const id = "shr::t_delta::t_delta(year)";
  const complete = {
    coverage: { kind: "column", table: "t_delta", yearColumn: "foreign_year" },   // exists in neither requiredColumns
    integrity: ["generation alignment holds"],
    availability: { kind: "always" },
    receiptOwner: "scripts/import-shr.py",
    evidence: "shape-complete in every respect, and pointing at a column outside the contract",
  };
  const entry = {
    artifact: "shr", prepDependencies: [], emittedDependencies: ["t_delta"],
    requiredColumns: { t_delta: ["year"] }, flagKey: capabilityFlagKey("shr", id),
    policy: complete, authorizationEligible: false,
  };
  assert.strictEqual(policyIsComplete(complete as never), true,
    "this mutation depends on the policy being shape-complete");
  assert.strictEqual(coverageBasisErrors(complete as never, [{ name: "t_delta", requiredColumns: ["year"] }]).length, 1,
    "and on its basis being rejected by the contract rule");
  const rendered = renderInventory({ [id]: entry } as never);
  assert.ok(!/authorizationEligible: true/.test(rendered),
    "a shape-complete policy with a coverage basis outside the contract was generated as eligible");
});

check("the registry pin is computed by the shared capability-specific predicate", () => {
  /**
   * Added because a mutation SURVIVED: reverting the taxonomy harness's pin to shape-only was caught
   * by nothing. The pin is only observably wrong when an authored policy is shape-complete AND names
   * a stray basis, and no such policy exists -- adding one to make the mutation visible would mean
   * authoring false policy. So the call site is constrained directly instead.
   */
  const harness = fs.readFileSync(path.join(process.cwd(), "scripts", "test-operation-taxonomy.ts"), "utf8");
  const assignments = harness
    .split("\n")
    .map((line) => /^\s*authorizationEligible:\s*(.+?),?\s*$/.exec(line)?.[1])
    .filter((value): value is string => Boolean(value));
  assert.ok(assignments.length > 0, "the harness no longer pins authorizationEligible");
  for (const assignment of assignments) {
    assert.match(assignment, /capabilityAuthorizes\(/,
      `the registry pin must use the capability-specific predicate, not shape alone: ${assignment}`);
  }
});

check("a non-null but malformed policy authorizes nothing", () => {
  // Driven through the real validator, because "non-null" was the bug. Each of these is type-valid.
  const base = {
    coverage: { kind: "column", table: "incidents", yearColumn: "year" },
    integrity: ["generation alignment: MAX(year) of a = MAX(year) of b"],
    availability: { kind: "always" },
    receiptOwner: "scripts/import-shr.py",
    evidence: "cited from the importer that writes the table and the spec section requiring it",
  };
  assert.strictEqual(policyIsComplete(base), true, "a well-formed policy must be eligible");
  for (const malformed of [
    { ...base, coverage: { kind: "column", table: "", yearColumn: "year" } },
    { ...base, coverage: { kind: "column", table: "incidents", yearColumn: "  " } },
    { ...base, integrity: [] },
    { ...base, integrity: [""] },
    { ...base, receiptOwner: "" },
    { ...base, availability: { kind: "conditional" } },
    /** Optional metadata: a short note is fine, a non-string is not. */
    { ...base, evidence: 42 },
  ]) {
    assert.strictEqual(policyIsComplete(malformed), false,
      `a malformed policy must NOT authorize: ${JSON.stringify(malformed)}`);
  }
});

// ---------------------------------------------------------------- generation, not authorship

check("the checked-in inventory is exactly what the generator produces", () => {
  // The assertion that makes "generated, not authored" true rather than aspirational. Editing
  // lib/source-health-inventory.ts by hand fails here, which is the whole point: a hand edit is
  // how three previous inventories went wrong.
  const onDisk = fs.readFileSync(INVENTORY_FILE, "utf8");
  assert.strictEqual(onDisk, renderInventory(),
    "lib/source-health-inventory.ts is not what the generator emits; re-run `npx tsx scripts/generate-source-health-inventory.ts`");
});

check("every spec carries the flag key pinned in the registry", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (!entry) continue;
    assert.strictEqual(spec.flagKey, entry.flagKey, `${spec.capabilityId} flag key drifted from the registry pin`);
  }
  const byFlag = new Map<string, string[]>();
  for (const spec of CAPABILITY_INVENTORY) byFlag.set(spec.flagKey, [...(byFlag.get(spec.flagKey) ?? []), spec.capabilityId]);
  const collisions = [...byFlag].filter(([, ids]) => ids.length > 1).map(([flag, ids]) => `${flag} <- ${ids.length}`);
  assert.deepStrictEqual(collisions, [], `flag key collisions:\n  ${collisions.join("\n  ")}`);
});

check("the registry pin matches the single flag-key derivation", () => {
  // The taxonomy harness pins flagKey into the registry; this file copies the pin. Both must agree
  // with the ONE derivation in lib/capability-flag-key.ts, or there are two formulas again and the
  // pin silently records the loser.
  for (const [id, entry] of Object.entries(registry)) {
    assert.strictEqual(entry.flagKey, capabilityFlagKey(entry.artifact, id),
      `${id}: the registry pin is not what the shared derivation produces`);
  }
});

check("artifact comes from the registry, not from the source the caller claimed", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (entry) assert.strictEqual(spec.artifact, entry.artifact, `${spec.capabilityId} artifact drifted`);
  }
});

/**
 * minRows is a DECISION, not derived data. The registry cannot supply it, so it is applied as one
 * uniform rule and asserted to be uniform -- otherwise it reads as per-capability evidence that
 * nobody actually gathered.
 *
 *   emitted table      -> 1: the operation reads its answer from it, so zero rows means no answer
 *   preparation table  -> 0: read while DECIDING, and finding nothing there is a legitimate
 *                            decline (an agency absent from a crosswalk), not an unhealthy source
 */
check("minRows follows one stated rule rather than per-capability guesswork", () => {
  const offenders: string[] = [];
  for (const spec of CAPABILITY_INVENTORY) {
    for (const t of spec.tables) if (t.minRows !== 1) offenders.push(`${spec.capabilityId}: ${t.name} minRows=${t.minRows}`);
    for (const t of spec.preparationTables) if (t.minRows !== 0) offenders.push(`${spec.capabilityId}: prep ${t.name} minRows=${t.minRows}`);
  }
  assert.deepStrictEqual(offenders, [], `minRows deviates from the rule (${offenders.length}):\n  ${offenders.join("\n  ")}`);
});

check("dependency rules remain unauthored, so the machinery has no live effect", () => {
  /**
   * Task 3 built the EVALUATION machinery; it did not author rules, because
   * "agency_year_reliability qualifies historical_agency_crime on ori/year/algorithm_version" is
   * hand-authored relational knowledge no observation can derive -- the same category as policy.
   * So every real capability still carries none, the machinery runs only over synthetic specs in
   * scripts/test-source-health.ts, and Task 3 is MACHINERY-ONLY pending the Stage 2B session.
   * This assertion is what makes that state explicit rather than an oversight.
   */
  for (const spec of CAPABILITY_INVENTORY) {
    assert.deepStrictEqual(spec.dependencies, [], `${spec.capabilityId} carries dependency rules Task 1 cannot derive`);
    assert.deepStrictEqual(spec.semanticDependencies, [], `${spec.capabilityId} carries semantic dependencies Task 1 cannot derive`);
  }
});

check("specFor resolves by capability id and rejects anything else", () => {
  const first = CAPABILITY_INVENTORY[0];
  assert.ok(first, "the inventory is empty");
  assert.strictEqual(specFor(first.capabilityId)?.capabilityId, first.capabilityId);
  assert.strictEqual(specFor("shr::invented::nothing(x)"), null);
  assert.strictEqual(specFor(""), null);
  // A short per-source label must not resolve: labels are not identity (two capabilities can share
  // a table set), which is why the id is structural.
  assert.strictEqual(specFor("incidents"), null);
});

check("the inventory is non-trivial and every spec is fully formed", () => {
  assert.ok(CAPABILITY_INVENTORY.length >= 52, `expected the full register, got ${CAPABILITY_INVENTORY.length}`);
  for (const spec of CAPABILITY_INVENTORY as readonly CapabilitySpec[]) {
    assert.ok(spec.capabilityId.includes("::"), `${spec.capabilityId} is not a structural id`);
    assert.ok(spec.tables.length > 0, `${spec.capabilityId} names no tables`);
    // NOT "every table names a column": an operation can depend on a table via COUNT(*) without
    // naming one, and requiring a column here would push the generator back to keying membership off
    // requiredColumns. At least one table must name a column, or nothing was observed at all.
    assert.ok(spec.tables.some((t) => t.requiredColumns.length > 0),
      `${spec.capabilityId} names no required column on any table`);
    assert.ok(/^PROOF_CAPABILITY_[A-Z_]+_[A-F0-9]{8}$/.test(spec.flagKey), `${spec.capabilityId} flag key is malformed: ${spec.flagKey}`);
  }
});

check("nothing in the register is authorization-eligible yet", () => {
  // The fail-closed state Stage 2A is supposed to be in. If this ever passes with a non-zero
  // count, policy was authored somewhere and that is a decision, not a drift.
  const eligible = CAPABILITY_INVENTORY.filter((s) => s.authorizationEligible).map((s) => s.capabilityId);
  assert.deepStrictEqual(eligible, [], `capabilities claiming authority:\n  ${eligible.join("\n  ")}`);
});

console.log(`\nsource health inventory: ${passed} passed, ${failed} failed`);
console.log(`capabilities ${CAPABILITY_INVENTORY.length} (registry ${Object.keys(registry).length} + sweep-only ${SWEEP_ONLY.length})`);
if (failed > 0) process.exitCode = 1;
