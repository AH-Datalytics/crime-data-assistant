/**
 * Generates `capability-policy.json` from the ONE authored source.
 *
 * Run: `npx tsx scripts/generate-capability-policy.ts`
 *
 * Policy is a DERIVED ARTIFACT, like `lib/source-health-inventory.ts`. It used to be authored
 * alongside the human answers, which meant two authoritative records of one decision and an
 * endless supply of ways for them to disagree -- a crash between two writes, an orphaned answer,
 * an update that kept its id and passed a key-only check. Deriving it makes disagreement
 * unrepresentable: there is nothing to disagree with.
 *
 * `scripts/test-stage2b-workbook.ts` asserts the checked-in file is byte-identical to what this
 * emits, so a hand edit fails the suite, and every consumer reads it through
 * `loadGeneratedPolicy`, which refuses a file generated from a different version of the record.
 */
import fs from "node:fs";
import path from "node:path";
import {
  AUTHORED_FILE, GENERATED_POLICY_FILE, derivePolicy, readAuthoredRecord, recordDigest,
  recordShapeErrors,
} from "../lib/stage2b-authored-record";
import {
  buildWorkbookModel, loadCatalog, loadPlainLanguage, workbookFingerprint, type RegistryEntry,
} from "./generate-stage2b-workbook";

const REGISTRY_FILE = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy", "capability-registry.json");

export function renderPolicyFile(policy: Record<string, unknown>, generatedFrom: string): string {
  const ordered: Record<string, unknown> = {
    _README: {
      purpose: "GENERATED FILE -- DO NOT EDIT BY HAND. Derived from capability-answers.json, which is "
        + "the one authored source for Stage 2B. Editing this file is pointless: the regression asserts "
        + "it is byte-identical to what scripts/generate-capability-policy.ts emits, and every consumer "
        + "refuses it when its _generatedFrom no longer matches the record it came from.",
      authored_in: "scripts/fixtures/operation-taxonomy/capability-answers.json",
      regenerate_with: "npx tsx scripts/generate-capability-policy.ts",
      eligibility: "A capability authorizes nothing until every policy field is authored and well formed, "
        + "the coverage basis names a table and column it actually reads, and every integrity rule can be "
        + "executed. Nothing can execute one today, so no capability is authorization-eligible and the "
        + "workbook produces recorded drafts. Entries with origin \"legacy\" predate the workbook, have no "
        + "human answer behind them, and authorize nothing whatever their fields contain.",
    },
    _generatedFrom: generatedFrom,
  };
  for (const id of Object.keys(policy).sort()) ordered[id] = policy[id];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function generatePolicyFile(): { text: string; errors: string[]; expired: string[] } {
  const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>;
  const catalog = loadCatalog();
  const pl = loadPlainLanguage(catalog);
  const { entries } = readAuthoredRecord();

  const shape = recordShapeErrors(entries);
  if (shape.length) return { text: "", errors: shape, expired: [] };

  /**
   * Derived against the contract in force NOW, so a confirmation given under wording that has since
   * changed stops producing policy. Those entries are named rather than silently dropped: nothing
   * is lost -- the answer is still in the record, waiting to be re-confirmed in the workbook.
   */
  const derived = derivePolicy(entries, buildWorkbookModel(registry), pl, workbookFingerprint(registry, catalog));
  if (derived.errors.length) return { text: "", errors: derived.errors, expired: derived.expired };
  return { text: renderPolicyFile(derived.policy, recordDigest(AUTHORED_FILE)), errors: [], expired: derived.expired };
}

if (process.argv[1] && path.resolve(process.argv[1]).includes("generate-capability-policy")) {
  const result = generatePolicyFile();
  if (result.errors.length) {
    console.error(`refusing to generate policy from ${path.basename(AUTHORED_FILE)}:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exit(1);
  }
  fs.writeFileSync(GENERATED_POLICY_FILE, result.text);
  console.log(`wrote ${path.relative(process.cwd(), GENERATED_POLICY_FILE)}`);
  for (const id of result.expired) {
    console.log(`  ${id}: confirmed against an older decision contract, so it derives no policy until`
      + " someone re-opens the workbook and confirms the wording that exists now");
  }
}
