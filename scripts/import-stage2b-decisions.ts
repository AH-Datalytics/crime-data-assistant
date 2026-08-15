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
 *
 * What arrives is a CHANGE SET, not a snapshot. The importer used to rebuild the file from whatever
 * it was handed, which made every omission a deletion: a partial export silently dropped the
 * capabilities it did not mention, and a stale full export silently reverted newer work. Each
 * changed entry now carries the value it was authored against, so a merge that would overwrite
 * someone else's newer answer is refused by name instead of performed quietly.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { capabilityAuthorizes, coverageBasisErrors, policyShapeErrors, type UnvalidatedPolicy } from "../lib/capability-policy";
import {
  DECISIONS_VERSION, PLAIN_LANGUAGE_MODULE_FILE, buildWorkbookModel, decidableRegistry,
  registryFingerprint, type RegistryEntry,
} from "./generate-stage2b-workbook";

/**
 * The SAME translation the page runs, loaded from the same file the page inlines.
 *
 * Re-implementing it here would put two derivations behind one confirmation: the person would
 * approve what the page proposed and the importer would write what it derived, and nothing would
 * notice they had diverged.
 */
const require = createRequire(import.meta.url);
const { createStage2bPlainLanguage } = require(PLAIN_LANGUAGE_MODULE_FILE) as {
  createStage2bPlainLanguage: () => any;
};
const PL = createStage2bPlainLanguage();

/** What a change-set entry may carry. A withdrawal carries only its operation. */
const ENTRY_KEYS: readonly string[] = ["human", "proposed", "unresolved", "mappingConfirmed", "operation"];

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
export const POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");

export type ImportResult =
  | { ok: true; policy: Record<string, unknown>; authored: string[]; cleared: string[]; eligible: string[] }
  | { ok: false; errors: string[] };

/** Fixed field order and null-normalisation, so two equal entries always compare equal. */
function canonical(entry: unknown): string {
  if (entry === null || entry === undefined) return "null";
  const e = entry as Record<string, unknown>;
  return JSON.stringify({
    coverage: e.coverage ?? null,
    integrity: e.integrity ?? null,
    availability: e.availability ?? null,
    receiptOwner: e.receiptOwner ?? null,
    evidence: e.evidence ?? "",
  });
}

const isUntouched = (candidate: UnvalidatedPolicy): boolean =>
  candidate.coverage === null && candidate.integrity === null && candidate.availability === null
  && candidate.receiptOwner === null && String(candidate.evidence ?? "").trim() === "";

export function importDecisions(
  raw: string,
  registryOverride?: Record<string, RegistryEntry>,
  policyOverride?: Record<string, unknown>,
): ImportResult {
  const registryInput = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const registry = decidableRegistry(registryInput);
  const workbookModel = buildWorkbookModel(registryInput);
  const errors: string[] = [];

  let parsed: { v?: unknown; fingerprint?: unknown; decisions?: unknown; basedOn?: unknown };
  try { parsed = JSON.parse(raw); }
  catch (error) { return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] }; }

  if (parsed.v !== DECISIONS_VERSION) errors.push(`decisions version ${String(parsed.v)} is not ${DECISIONS_VERSION}`);
  const expected = registryFingerprint(registryInput);
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
  const basedOn = (parsed.basedOn ?? null) as Record<string, unknown> | null;
  if (!basedOn || typeof basedOn !== "object" || Array.isArray(basedOn)) {
    return { ok: false, errors: [...errors, "the export carries no basedOn baseline, so a safe merge is impossible"] };
  }

  const existingFile = policyOverride
    ?? (fs.existsSync(POLICY_FILE)
      ? JSON.parse(fs.readFileSync(POLICY_FILE, "utf8")) as Record<string, unknown>
      : {});
  const docs = Object.fromEntries(Object.entries(existingFile).filter(([id]) => id.startsWith("_")));
  const current: Record<string, unknown> = Object.fromEntries(
    Object.entries(existingFile).filter(([id]) => !id.startsWith("_")),
  );

  const merged: Record<string, unknown> = { ...current };
  const authored: string[] = [];
  const cleared: string[] = [];
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

    /**
     * Optimistic concurrency, per entry. The session recorded what the policy held for this
     * capability when it began; if the file no longer holds that, someone has changed it since and
     * this import would overwrite their answer with one authored in ignorance of it.
     */
    if (!Object.prototype.hasOwnProperty.call(basedOn, id)) {
      errors.push(`${id}: the export changes this capability but records no baseline for it`);
      continue;
    }
    if (canonical(basedOn[id]) !== canonical(current[id] ?? null)) {
      errors.push(
        `${id}: policy has changed since this session began — it was authored against ` +
        `${basedOn[id] === null ? "no entry" : "a different entry"}, but the file now holds ` +
        `${current[id] === undefined ? "no entry" : "another"}; re-open the workbook and redo this one`,
      );
      continue;
    }

    /**
     * Withdrawal is a NAMED operation, never inferred from blank fields.
     *
     * Clearing every field used to be read as deletion, while the page offered only "Undecided" and
     * no confirmation -- so "I have not decided this yet" and "remove what was decided" were the
     * same gesture, and the destructive reading won. An entry that is merely blank is now refused
     * with the name of the operation that would have been meant.
     */
    if (decision.operation !== undefined) {
      if (decision.operation !== "withdraw") {
        errors.push(`${id}: unknown operation ${JSON.stringify(decision.operation)}`);
        continue;
      }
      if (Object.keys(decision).length > 1) {
        errors.push(`${id}: a withdrawal carries no other fields`);
        continue;
      }
      if (current[id] === undefined) {
        errors.push(`${id}: nothing is authored here to withdraw`);
        continue;
      }
      delete merged[id];
      cleared.push(id);
      continue;
    }

    /**
     * Checked on what ARRIVED, not on what is copied out of it. Rebuilding the candidate from the
     * known fields silently dropped anything else the file carried, so an unknown top-level key
     * could never produce an error -- the validator only ever saw the fields it already expected.
     */
    const strayKeys = Object.keys(decision).filter((key) => !ENTRY_KEYS.includes(key));
    if (strayKeys.length) {
      errors.push(`${id}: the entry carries ${strayKeys.map((k) => JSON.stringify(k)).join(", ")}, which it does not have`);
      continue;
    }

    /**
     * THE TRANSLATION IS RE-DERIVED HERE, and the confirmation must match it.
     *
     * The page proposes a technical mapping from a human answer and shows it; this recomputes that
     * mapping from the SAME human answer with the SAME code, and refuses if the file's proposal
     * disagrees. Trusting the file's `proposed` block would have let a page -- or a hand edit --
     * ship a policy the person never saw beside the question they answered, which is the one thing
     * a human-facing workbook must not be able to do.
     */
    const capability = workbookModel.find((c) => c.id === id);
    if (!capability) { errors.push(`${id}: not a capability in the workbook model`); continue; }
    const humanAnswer = decision.human;
    if (!humanAnswer || typeof humanAnswer !== "object" || Array.isArray(humanAnswer)) {
      errors.push(`${id}: the entry carries no human answer, so there is nothing a mapping could have come from`);
      continue;
    }
    const rederived = PL.proposeMapping(capability, humanAnswer);
    const asJson = (value: unknown) => JSON.stringify(value ?? null);
    if (asJson(decision.proposed) !== asJson(rederived.proposed)) {
      errors.push(`${id}: the exported technical mapping is not what this answer produces; `
        + "re-open the workbook, review the mapping again and confirm it");
      continue;
    }
    const expectedFingerprint = PL.mappingFingerprint(rederived.proposed);
    if (!decision.mappingConfirmed) {
      errors.push(`${id}: the technical mapping was never confirmed; the workbook shows it beside the `
        + "answer and asks you to approve it before it can become policy");
      continue;
    }
    if (decision.mappingConfirmed !== expectedFingerprint) {
      errors.push(`${id}: the confirmed mapping is stale — the answer changed after it was approved, `
        + "so the mapping that was approved is not the one in this file");
      continue;
    }

    const candidate: UnvalidatedPolicy = {
      coverage: rederived.proposed.coverage ?? null,
      integrity: rederived.proposed.integrity ?? null,
      availability: rederived.proposed.availability ?? null,
      receiptOwner: rederived.proposed.receiptOwner ?? null,
      evidence: typeof rederived.proposed.evidence === "string" ? rederived.proposed.evidence : "",
    };

    if (isUntouched(candidate)) {
      if (current[id] !== undefined) {
        errors.push(`${id}: every field is blank, which is not a withdrawal — `
          + 'use the workbook\'s "Withdraw" action if you mean to remove the authored policy');
      }
      continue;   // nothing authored here and nothing to remove: stays absent, the fail-closed default
    }

    // Shape, re-checked here rather than trusted from the page.
    const shape = policyShapeErrors(candidate).filter((problem) =>
      // An unauthored entry legitimately cites no evidence yet; evidence is only REQUIRED once the
      // entry is otherwise complete, which capabilityAuthorizes enforces below.
      !(problem.startsWith("evidence") && String(candidate.evidence).trim() === ""));
    for (const problem of shape) errors.push(`${id}: ${problem}`);

    // The basis must belong to THIS capability's contract -- the same rule the runtime applies.
    const declared = entry.emittedDependencies.map((name) => ({ name, requiredColumns: entry.requiredColumns[name] ?? [] }));
    for (const problem of coverageBasisErrors(candidate, declared)) errors.push(`${id}: ${problem}`);

    merged[id] = candidate;
    authored.push(id);
    if (capabilityAuthorizes(candidate, declared)) eligible.push(id);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, policy: { ...docs, ...merged }, authored, cleared, eligible };
}

/** Serialise the merged policy, documentation blocks first and capabilities in a stable order. */
export function writePolicy(policy: Record<string, unknown>): string {
  const docs = Object.keys(policy).filter((id) => id.startsWith("_")).sort();
  const entries = Object.keys(policy).filter((id) => !id.startsWith("_")).sort();
  const ordered: Record<string, unknown> = {};
  for (const id of [...docs, ...entries]) ordered[id] = policy[id];
  return `${JSON.stringify(ordered, null, 2)}\n`;
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
  console.log(`merged ${result.authored.length} authored capability(ies)`
    + (result.cleared.length ? `, withdrew ${result.cleared.length}` : "")
    + `; ${result.eligible.length} now authorization-eligible`);
  console.log("Re-run the derivation and the suites: TAXONOMY_DERIVE=1 npx tsx scripts/test-operation-taxonomy.ts && npm test");
}
