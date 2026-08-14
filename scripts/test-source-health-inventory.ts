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

check("required columns and preparation tables match the registry exactly", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    const entry = registry[spec.capabilityId];
    if (!entry) continue;                       // the sweep-only capability has no operation row
    assert.deepStrictEqual(
      Object.fromEntries(spec.tables.map((t) => [t.name, [...t.requiredColumns].sort()])),
      entry.requiredColumns,
      `${spec.capabilityId} required columns drifted`,
    );
    assert.deepStrictEqual(spec.preparationTables.map((t) => t.name).sort(), [...entry.prepDependencies].sort(),
      `${spec.capabilityId} preparation tables drifted`);
  }
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

check("no capability authorizes anything until its policy is authored", () => {
  for (const spec of CAPABILITY_INVENTORY) {
    const complete = spec.policy !== null &&
      (["coverage", "integrity", "availability", "receiptOwner"] as const).every((f) => spec.policy![f] !== null);
    assert.strictEqual(spec.authorizationEligible, complete, `${spec.capabilityId} misstates its eligibility`);
    const entry = registry[spec.capabilityId];
    if (entry) assert.deepStrictEqual(spec.policy, entry.policy, `${spec.capabilityId} policy drifted from the registry`);
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

check("dependency rules are empty until Task 3 authors them", () => {
  // Asserted rather than left unstated, so Task 3 adding them is a visible change here instead of
  // silently filling fields this task pretended to populate.
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
    for (const t of spec.tables) assert.ok(t.requiredColumns.length > 0, `${spec.capabilityId}: ${t.name} has no required columns`);
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
