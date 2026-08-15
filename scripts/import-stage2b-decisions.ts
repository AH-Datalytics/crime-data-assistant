/**
 * Validates a workbook export and writes it into the policy source.
 *
 * Run: `npx tsx scripts/import-stage2b-decisions.ts <path-to-stage2b-policy-decisions.json>`
 *
 * Separate from the workbook ON PURPOSE. The browser page can only produce a downloaded file; this
 * checked-in script is the single thing that may change `capability-policy.json`, so no page can
 * edit the repository and no incomplete session can convert itself into authorization. Everything
 * the workbook could get wrong is re-checked here against the live registry rather than trusted.
 *
 * It sets no flags and activates nothing: authoring policy makes a capability ELIGIBLE to be
 * probed, which is a different act from enabling it.
 */
import fs from "node:fs";
import path from "node:path";
import { capabilityAuthorizes, coverageBasisErrors, policyShapeErrors, type UnvalidatedPolicy } from "../lib/capability-policy";
import { DECISIONS_VERSION, registryFingerprint, type RegistryEntry } from "./generate-stage2b-workbook";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
export const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");

export type ImportResult =
  | { ok: true; policy: Record<string, unknown>; authored: string[]; eligible: string[] }
  | { ok: false; errors: string[] };

/**
 * A decided coverage basis, or null. `"none"` is the workbook's way of saying "this capability has
 * no year dimension", which is a DECISION and is recorded as such -- not as an undecided null.
 */
function normalizeCoverage(value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (value === null || value === undefined) return { ok: true, value: null };
  if (value === "none") return { ok: true, value: null };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "coverage must be a { table, yearColumn } pair, null, or \"none\"" };
  return { ok: true, value };
}

export function importDecisions(
  raw: string,
  registryOverride?: Record<string, RegistryEntry>,
): ImportResult {
  const registry = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const errors: string[] = [];

  let parsed: { v?: unknown; fingerprint?: unknown; decisions?: unknown };
  try { parsed = JSON.parse(raw); }
  catch (error) { return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] }; }

  if (parsed.v !== DECISIONS_VERSION) errors.push(`decisions version ${String(parsed.v)} is not ${DECISIONS_VERSION}`);
  const expected = registryFingerprint(registry);
  if (parsed.fingerprint !== expected) {
    // Stale export: the questions themselves may have changed, so answers to the old ones cannot be
    // carried across silently.
    errors.push(
      `this export was authored against registry structure ${String(parsed.fingerprint)}, but the registry is now ${expected}; ` +
      "regenerate the workbook and re-check every answer",
    );
  }
  const decisions = parsed.decisions;
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) {
    return { ok: false, errors: [...errors, "the export carries no decisions object"] };
  }

  const policy: Record<string, unknown> = {};
  const authored: string[] = [];
  const eligible: string[] = [];

  for (const id of Object.keys(decisions as Record<string, unknown>).sort()) {
    const entry = registry[id];
    // An id the registry does not contain cannot be imported: the workbook is generated FROM the
    // registry, so anything else is either stale or invented.
    if (!entry) { errors.push(`${id}: not a capability in the registry`); continue; }

    const decision = (decisions as Record<string, Record<string, unknown>>)[id];
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      errors.push(`${id}: decision is not an object`);
      continue;
    }

    const coverage = normalizeCoverage(decision.coverage);
    if (!coverage.ok) { errors.push(`${id}: ${coverage.error}`); continue; }

    const candidate: UnvalidatedPolicy = {
      coverage: coverage.value,
      integrity: decision.integrity ?? null,
      availability: decision.availability ?? null,
      receiptOwner: decision.receiptOwner ?? null,
      evidence: typeof decision.evidence === "string" ? decision.evidence : "",
    };

    const untouched = candidate.coverage === null && candidate.integrity === null
      && candidate.availability === null && candidate.receiptOwner === null
      && String(candidate.evidence).trim() === "";
    if (untouched) continue;   // never decided; stays absent, which is the fail-closed default

    // Shape, re-checked here rather than trusted from the page.
    const shape = policyShapeErrors(candidate).filter((problem) =>
      // An unauthored entry legitimately cites no evidence yet; evidence is only REQUIRED once the
      // entry is otherwise complete, which capabilityAuthorizes enforces below.
      !(problem.startsWith("evidence") && String(candidate.evidence).trim() === ""));
    for (const problem of shape) errors.push(`${id}: ${problem}`);

    // The basis must belong to THIS capability's contract -- the same rule the runtime applies.
    const declared = entry.emittedDependencies.map((name) => ({ name, requiredColumns: entry.requiredColumns[name] ?? [] }));
    for (const problem of coverageBasisErrors(candidate, declared)) errors.push(`${id}: ${problem}`);

    policy[id] = candidate;
    authored.push(id);
    if (capabilityAuthorizes(candidate, declared)) eligible.push(id);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, policy, authored, eligible };
}

/** Rewrite the policy file, preserving its `_`-prefixed documentation blocks verbatim. */
export function writePolicy(policy: Record<string, unknown>): string {
  const existing = fs.existsSync(POLICY_FILE)
    ? JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) as Record<string, unknown>
    : {};
  const docs = Object.fromEntries(Object.entries(existing).filter(([id]) => id.startsWith("_")));
  const merged: Record<string, unknown> = { ...docs };
  for (const id of Object.keys(policy).sort()) merged[id] = policy[id];
  return `${JSON.stringify(merged, null, 2)}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]).includes("import-stage2b-decisions")) {
  const file = process.argv[2];
  if (!file) { console.error("usage: npx tsx scripts/import-stage2b-decisions.ts <decisions.json>"); process.exit(2); }
  const result = importDecisions(fs.readFileSync(file, "utf8"));
  if (!result.ok) {
    console.error(`refused ${path.basename(file)}:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  fs.writeFileSync(POLICY_FILE, writePolicy(result.policy));
  console.log(`imported ${result.authored.length} authored capability(ies); ${result.eligible.length} now authorization-eligible`);
  console.log("Re-run the derivation and the suites: TAXONOMY_DERIVE=1 npx tsx scripts/test-operation-taxonomy.ts && npm test");
}
