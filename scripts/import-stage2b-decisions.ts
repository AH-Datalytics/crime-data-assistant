/**
 * Validates a workbook export and writes it into the ONE authored source.
 *
 * Run: `npx tsx scripts/import-stage2b-decisions.ts <path-to-stage2b-policy-decisions.json>`
 *
 * Separate from the workbook ON PURPOSE. The browser page can only produce a downloaded file; this
 * checked-in script is the single thing that may change `capability-answers.json`, so no page can
 * edit the repository and no incomplete session can convert itself into authorization. Everything
 * the workbook could get wrong is re-checked here against the live registry rather than trusted.
 *
 * It sets no flags and activates nothing: authoring policy makes a capability ELIGIBLE to be
 * probed, which is a different act from enabling it.
 *
 * ONE RECORD, ONE RENAME. Policy is derived from the record by
 * `scripts/generate-capability-policy.ts`, so there is no second authoritative file to fall out of
 * step with -- which is what every previous synchronisation defect came down to. The record is
 * written through a single atomic rename; regenerating the derived policy afterwards is a separate
 * step, and a stale one is refused at read time rather than silently trusted.
 *
 * What arrives is a CHANGE SET. Each changed entry carries the value it was authored against, so a
 * merge that would overwrite someone else's newer answer is refused by name instead of performed
 * quietly.
 */
import fs from "node:fs";
import path from "node:path";
import { coverageBasisErrors, policyShapeErrors, type UnvalidatedPolicy } from "../lib/capability-policy";
import {
  AUTHORED_FILE, GENERATED_POLICY_FILE, type AuthoredEntry, type AuthoredRecord,
  commitAuthoredRecord, derivePolicy, derivedEntryAuthorizes, entryDigest, readAuthoredRecord,
  recordShapeErrors, renderAuthoredRecord,
} from "../lib/stage2b-authored-record";
import {
  DECISIONS_VERSION, buildWorkbookModel, decidableRegistry, loadCatalog, loadPlainLanguage,
  workbookFingerprint, type RegistryEntry,
} from "./generate-stage2b-workbook";
import { generatePolicyFile } from "./generate-capability-policy";

/**
 * The SAME translation the page runs, from the same file the page inlines.
 *
 * Re-implementing it here would put two derivations behind one confirmation: the person would
 * approve what the page proposed and the importer would write what it derived, and nothing would
 * notice they had diverged.
 */
const CATALOG = loadCatalog();
const PL = loadPlainLanguage(CATALOG);

/** What a change-set entry may carry. A withdrawal carries only its operation. */
const ENTRY_KEYS: readonly string[] = ["human", "proposed", "unresolved", "preserved", "mappingConfirmed", "operation"];

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
export { AUTHORED_FILE, GENERATED_POLICY_FILE };

export type ImportResult =
  | {
      ok: true;
      /** The new authored record. The ONLY thing that gets written. */
      docs: Record<string, unknown>;
      entries: AuthoredRecord;
      /** What that record derives to. Reported, never stored independently. */
      policy: Record<string, unknown>;
      decided: string[];
      open: string[];
      cleared: string[];
      eligible: string[];
    }
  | { ok: false; errors: string[] };

/** Fixed field order and null-normalisation, so two entries that mean the same compare equal. */
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

export function importDecisions(
  raw: string,
  registryOverride?: Record<string, RegistryEntry>,
  recordOverride?: { docs: Record<string, unknown>; entries: AuthoredRecord },
): ImportResult {
  const registryInput = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);
  const registry = decidableRegistry(registryInput);
  const model = buildWorkbookModel(registryInput);
  const errors: string[] = [];

  let parsed: {
    v?: unknown; contractFingerprint?: unknown; decisions?: unknown;
    basedOn?: unknown; basedOnEntry?: unknown;
  };
  try { parsed = JSON.parse(raw); }
  catch (error) { return { ok: false, errors: [`not valid JSON: ${(error as Error).message}`] }; }

  if (parsed.v !== DECISIONS_VERSION) errors.push(`decisions version ${String(parsed.v)} is not ${DECISIONS_VERSION}`);
  const expected = workbookFingerprint(registryInput, CATALOG);
  if (parsed.contractFingerprint !== expected) {
    errors.push(
      `this export was authored against decision contract ${String(parsed.contractFingerprint)}, but the contract is now ${expected}; ` +
      "regenerate the workbook and re-check every answer (the contract covers the questions, the "
      + "options and their consequences, and the translation, not only the database structure)",
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
  const basedOnEntry = (parsed.basedOnEntry ?? null) as Record<string, unknown> | null;
  if (!basedOnEntry || typeof basedOnEntry !== "object" || Array.isArray(basedOnEntry)) {
    return {
      ok: false,
      errors: [...errors, "the export names no authored entry it was based on, so a safe merge is impossible"],
    };
  }

  const existing = recordOverride ?? readAuthoredRecord();
  const shape = recordShapeErrors(existing.entries);
  if (shape.length) return { ok: false, errors: [...errors, ...shape.map((e) => `the authored record is malformed — ${e}`)] };
  /** What the record currently derives to. There is no separately stored policy to consult. */
  const current = derivePolicy(existing.entries, model, PL, expected);
  if (current.errors.length) {
    return { ok: false, errors: [...errors, ...current.errors.map((e) => `the authored record does not derive — ${e}`)] };
  }

  const entries: AuthoredRecord = { ...existing.entries };
  const decided: string[] = [];
  const open: string[] = [];
  const cleared: string[] = [];

  for (const id of Object.keys(decisions as Record<string, unknown>).sort()) {
    const registryEntry = registry[id];
    if (!registryEntry) { errors.push(`${id}: not a capability in the registry`); continue; }

    const decision = (decisions as Record<string, Record<string, unknown>>)[id];
    if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
      errors.push(`${id}: decision is not an object`);
      continue;
    }
    const strayKeys = Object.keys(decision).filter((key) => !ENTRY_KEYS.includes(key));
    if (strayKeys.length) {
      errors.push(`${id}: the entry carries ${strayKeys.map((k) => JSON.stringify(k)).join(", ")}, which it does not have`);
      continue;
    }

    /**
     * Optimistic concurrency, per entry, against the AUTHORED ENTRY itself.
     *
     * This was checked against what the record derives, which cannot see the thing being
     * overwritten. Two people answering the same unconfirmed capability both derive no policy, so
     * both compared equal and the second import silently replaced the first's human answer; two
     * different answers that derive the same policy had the same hole. The record is what is
     * written, so the record is what the baseline names.
     */
    if (!Object.prototype.hasOwnProperty.call(basedOnEntry, id)) {
      errors.push(`${id}: the export changes this capability but names no authored entry it was based on`);
      continue;
    }
    if (basedOnEntry[id] !== entryDigest(existing.entries[id])) {
      errors.push(`${id}: the recorded answer has changed since this session began; `
        + "re-open the workbook and redo this one");
      continue;
    }
    /**
     * And the derived baseline too, which is what the page merged against. It can be stale while
     * the record is current -- a session loaded from an older file carries the older file's
     * baseline -- and an unresolved answer would then preserve fields from a policy nobody has.
     */
    if (!Object.prototype.hasOwnProperty.call(basedOn, id)) {
      errors.push(`${id}: the export changes this capability but records no baseline for it`);
      continue;
    }
    if (canonical(basedOn[id]) !== canonical(current.policy[id] ?? null)) {
      errors.push(`${id}: policy has changed since this session began; re-open the workbook and redo this one`);
      continue;
    }

    if (decision.operation !== undefined) {
      if (decision.operation !== "withdraw") { errors.push(`${id}: unknown operation ${JSON.stringify(decision.operation)}`); continue; }
      if (Object.keys(decision).length > 1) { errors.push(`${id}: a withdrawal carries no other fields`); continue; }
      if (!(id in entries)) { errors.push(`${id}: nothing is recorded here to withdraw`); continue; }
      delete entries[id];
      cleared.push(id);
      continue;
    }

    const capability = model.find((c) => c.id === id);
    if (!capability) { errors.push(`${id}: not a capability in the workbook model`); continue; }
    const humanAnswer = decision.human;
    if (!humanAnswer || typeof humanAnswer !== "object" || Array.isArray(humanAnswer)) {
      errors.push(`${id}: the entry carries no human answer, so there is nothing a mapping could have come from`);
      continue;
    }

    /**
     * THE TRANSLATION IS RE-DERIVED HERE, and the confirmation must match it. Trusting the file's
     * `proposed` block would let a page -- or a hand edit -- ship policy the person never saw
     * beside the question they answered.
     */
    const preserved = (current.policy[id] ?? null) as Record<string, unknown> | null;
    const rederived = PL.proposeMapping(capability, humanAnswer);
    const remerged = PL.mergeWithExisting(rederived.proposed, preserved);
    const asJson = (value: unknown) => JSON.stringify(value ?? null);
    if (asJson(decision.proposed) !== asJson(remerged.merged)) {
      errors.push(`${id}: the exported technical mapping is not what this answer produces; `
        + "re-open the workbook, review the mapping again and confirm it");
      continue;
    }

    if (!decision.mappingConfirmed) {
      /**
       * Recorded as work in progress. An unconfirmed answer derives NO policy, so nothing it could
       * imply reaches the runtime -- it is kept so reopening the workbook does not lose it.
       */
      entries[id] = { kind: "open", human: humanAnswer as Record<string, unknown>, contractFingerprint: expected };
      open.push(id);
      continue;
    }
    if (decision.mappingConfirmed !== PL.mappingFingerprint(remerged.merged)) {
      errors.push(`${id}: the confirmed mapping is stale — the answer changed after it was approved, `
        + "so the mapping that was approved is not the one in this file");
      continue;
    }

    const candidate: UnvalidatedPolicy = {
      coverage: remerged.merged.coverage ?? null,
      integrity: remerged.merged.integrity ?? null,
      availability: remerged.merged.availability ?? null,
      receiptOwner: remerged.merged.receiptOwner ?? null,
      evidence: typeof remerged.merged.evidence === "string" ? remerged.merged.evidence : "",
    };
    const shapeProblems = policyShapeErrors(candidate).filter((problem) =>
      !(problem.startsWith("evidence") && String(candidate.evidence).trim() === ""));
    for (const problem of shapeProblems) errors.push(`${id}: ${problem}`);
    const declared = registryEntry.emittedDependencies.map(
      (name) => ({ name, requiredColumns: registryEntry.requiredColumns[name] ?? [] }));
    for (const problem of coverageBasisErrors(candidate, declared)) errors.push(`${id}: ${problem}`);

    entries[id] = {
      kind: "decided",
      human: humanAnswer as Record<string, unknown>,
      /** Carried so re-derivation needs nothing outside the entry. */
      preserved: Object.fromEntries((decision.preserved as string[] ?? [])
        .filter((field) => preserved && preserved[field] !== undefined && preserved[field] !== null)
        .map((field) => [field, (preserved as Record<string, unknown>)[field]])),
      contractFingerprint: expected,
      confirmed: decision.mappingConfirmed as string,
      /** Audit evidence. `derivePolicy` refuses the record if it ever disagrees with re-derivation. */
      mapping: remerged.merged,
    };
    decided.push(id);
  }

  if (errors.length) return { ok: false, errors };

  // The record has to derive cleanly as a whole, not merely entry by entry.
  const finalShape = recordShapeErrors(entries);
  if (finalShape.length) return { ok: false, errors: finalShape };
  const derived = derivePolicy(entries, model, PL, expected);
  if (derived.errors.length) return { ok: false, errors: derived.errors };

  const eligible = Object.keys(derived.policy).filter((id) => {
    const registryEntry = registry[id];
    if (!registryEntry) return false;
    const declared = registryEntry.emittedDependencies.map(
      (name) => ({ name, requiredColumns: registryEntry.requiredColumns[name] ?? [] }));
    return derivedEntryAuthorizes(derived.policy[id] as UnvalidatedPolicy, declared);
  });

  return { ok: true, docs: existing.docs, entries, policy: derived.policy, decided, open, cleared, eligible };
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
  // One atomic rename of the one authored file. Nothing else is authoritative.
  commitAuthoredRecord(renderAuthoredRecord(result.docs, result.entries));
  console.log(`recorded ${result.decided.length} confirmed decision(s), ${result.open.length} in progress`
    + (result.cleared.length ? `, withdrew ${result.cleared.length}` : "")
    + `; ${result.eligible.length} authorization-eligible`);

  const generated = generatePolicyFile();
  if (generated.errors.length) {
    console.error("the record was written, but the derived policy could not be generated:");
    for (const error of generated.errors) console.error(`  - ${error}`);
    console.error("Nothing is corrupt: the record is whole, and every consumer refuses a policy that lags it.");
    process.exit(1);
  }
  fs.writeFileSync(GENERATED_POLICY_FILE, generated.text);
  console.log(`regenerated ${path.relative(process.cwd(), GENERATED_POLICY_FILE)}`);
  console.log("Re-run the suites: npm test");
}
