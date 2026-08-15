/**
 * The ONE authored source for Stage 2B, and the only thing that may be written by hand-driven work.
 *
 * WHY THIS EXISTS. The same decision used to live in two authoritative files -- the human answers
 * and the technical policy -- written one after the other. Every review found another way for them
 * to disagree: a crash between the writes, an orphaned answer, an update that kept its id and so
 * passed a key-only check. Each was fixed narrowly and the next one appeared in the same place,
 * because the defect was not any of the bugs; it was having two records of one fact.
 *
 * So there is one record now. `capability-answers.json` holds what a person was asked, what they
 * answered, and their confirmation. `capability-policy.json` is DERIVED from it by
 * `scripts/generate-capability-policy.ts`, exactly the way `lib/source-health-inventory.ts` is
 * derived, and is guarded by a byte-identical regression. Policy cannot disagree with the answers
 * because policy is not independently stored.
 *
 * THE DERIVED MAPPING IS NEVER AUTHORITATIVE. An entry may carry a `mapping` snapshot as audit
 * evidence, and it must equal what re-derivation produces; if it does not, the record is refused.
 * Policy is always taken from the re-derivation, never from the snapshot.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capabilityAuthorizes, type UnvalidatedPolicy } from "./capability-policy";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
/** The sole authored source. */
export const AUTHORED_FILE = path.join(DATA_DIR, "capability-answers.json");
/** Derived from it. Never authored, never trusted without checking which record produced it. */
export const GENERATED_POLICY_FILE = path.join(DATA_DIR, "capability-policy.json");

/**
 * Three kinds of entry, and no fourth.
 *
 *   decided  a workbook answer whose technical mapping the person read and confirmed
 *   open     a workbook answer they have not confirmed; recorded, derives NO policy
 *   legacy   policy that predates the workbook, migrated once; permanently non-authorizing
 *
 * The union is what makes "answer without policy" and "policy without answer" unrepresentable
 * rather than merely checked for: every entry is one of these, and policy comes out of the entry.
 */
export type AuthoredEntry =
  | {
      kind: "decided";
      human: Record<string, unknown>;
      /** Values an unresolved answer inherited, so re-derivation needs nothing outside the entry. */
      preserved: Record<string, unknown>;
      contractFingerprint: string;
      confirmed: string;
      /** Audit evidence only. Must equal re-derivation, and is never used as policy. */
      mapping?: Record<string, unknown>;
    }
  | { kind: "open"; human: Record<string, unknown>; contractFingerprint: string }
  | { kind: "legacy"; policy: Record<string, unknown> };

export type AuthoredRecord = Record<string, AuthoredEntry>;

const isDocKey = (id: string) => id.startsWith("_");

/** Documentation blocks are carried verbatim and are not entries. */
export function splitRecord(raw: Record<string, unknown>): {
  docs: Record<string, unknown>;
  entries: AuthoredRecord;
} {
  const docs: Record<string, unknown> = {};
  const entries: AuthoredRecord = {};
  for (const [id, value] of Object.entries(raw)) {
    if (isDocKey(id)) docs[id] = value;
    else entries[id] = value as AuthoredEntry;
  }
  return { docs, entries };
}

export function readAuthoredRecord(file = AUTHORED_FILE): { docs: Record<string, unknown>; entries: AuthoredRecord } {
  if (!fs.existsSync(file)) return { docs: {}, entries: {} };
  return splitRecord(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>);
}

/** Shape problems in the record. A malformed entry is refused, never coerced. */
export function recordShapeErrors(entries: AuthoredRecord): string[] {
  const bad: string[] = [];
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { bad.push(`${id}: entry is not an object`); continue; }
    const keys = Object.keys(entry).sort().join(",");
    if (entry.kind === "decided") {
      if (!entry.human || typeof entry.human !== "object") bad.push(`${id}: a decided entry needs the human answer`);
      if (!entry.confirmed) bad.push(`${id}: a decided entry needs the confirmation it was given under`);
      if (!entry.contractFingerprint) bad.push(`${id}: a decided entry needs the contract it was decided against`);
      if (!entry.preserved || typeof entry.preserved !== "object") bad.push(`${id}: a decided entry needs its preserved values, even when empty`);
      const allowed = ["confirmed", "contractFingerprint", "human", "kind", "mapping", "preserved"];
      const extra = Object.keys(entry).filter((k) => !allowed.includes(k));
      if (extra.length) bad.push(`${id}: a decided entry carries ${extra.join(", ")}, which it does not have`);
    } else if (entry.kind === "open") {
      if (!entry.human || typeof entry.human !== "object") bad.push(`${id}: an open entry needs the human answer`);
      if (keys !== "contractFingerprint,human,kind") bad.push(`${id}: an open entry carries fields it does not have`);
    } else if (entry.kind === "legacy") {
      if (!entry.policy || typeof entry.policy !== "object") bad.push(`${id}: a legacy entry needs the policy it migrated`);
      if (keys !== "kind,policy") bad.push(`${id}: a legacy entry carries fields it does not have`);
    } else {
      bad.push(`${id}: kind must be "decided", "open" or "legacy", not ${JSON.stringify((entry as { kind?: unknown }).kind)}`);
    }
  }
  return bad;
}

export type DerivedPolicy = {
  policy: Record<string, unknown>;
  errors: string[];
  /** Decided entries omitted because they were confirmed against a contract that no longer holds. */
  expired: string[];
};

/**
 * The policy a record implies. Deterministic, and a pure function of the record and the contract.
 *
 * `open` entries derive nothing: an answer nobody confirmed is recorded work in progress, not a
 * decision. `legacy` entries derive their migrated policy, marked so that nothing can ever read
 * them as authorizing. `decided` entries derive through the ONE translation function, and the
 * audit snapshot -- if present -- must equal that derivation exactly.
 *
 * THE CONFIRMATION EXPIRES WITH THE CONTRACT. A `decided` entry records the contract it was
 * confirmed against, and this checked nothing until now: re-wording a question, changing what an
 * option is said to do, or changing the translation itself left the old policy deriving -- and
 * potentially active -- under a confirmation that approved something nobody had read. An entry
 * whose stored contract is not the current one is OMITTED rather than refused, because refusing it
 * would take the whole record down with it; the answer is still there for the workbook to reopen
 * and the person to confirm again. Omitting is the fail-closed reading: no policy, so no
 * authorization, until a human re-confirms under the wording that now exists.
 */
export function derivePolicy(
  entries: AuthoredRecord,
  capabilities: { id: string }[],
  pl: {
    proposeMapping: (cap: unknown, human: unknown) => { proposed: Record<string, unknown> };
    mergeWithExisting: (proposed: Record<string, unknown>, existing: unknown) => { merged: Record<string, unknown> };
    mappingFingerprint: (proposed: unknown) => string;
  },
  /** The contract in force NOW. Required, so no caller can derive without deciding what it is. */
  contractFingerprint: string,
): DerivedPolicy {
  const byId = new Map(capabilities.map((c) => [c.id, c]));
  const policy: Record<string, unknown> = {};
  const errors: string[] = [];
  const expired: string[] = [];

  for (const id of Object.keys(entries).sort()) {
    const entry = entries[id];
    if (entry.kind === "legacy") {
      policy[id] = { ...entry.policy, origin: "legacy" };
      continue;
    }
    const capability = byId.get(id);
    if (!capability) { errors.push(`${id}: an answer is recorded for a capability the registry does not contain`); continue; }
    if (entry.kind === "open") continue;

    /**
     * Before anything is re-derived, not after. A changed contract can change the translation, so
     * the snapshot and confirmation checks below would report a stale entry as a CONTRADICTION --
     * a hard error that stops the record deriving at all, instead of the one entry standing down.
     */
    if (entry.contractFingerprint !== contractFingerprint) { expired.push(id); continue; }

    const derived = pl.mergeWithExisting(pl.proposeMapping(capability, entry.human).proposed, entry.preserved);
    if (entry.mapping && JSON.stringify(entry.mapping) !== JSON.stringify(derived.merged)) {
      errors.push(`${id}: the recorded mapping snapshot is not what this answer re-derives to, `
        + "so the record disagrees with itself");
      continue;
    }
    if (pl.mappingFingerprint(derived.merged) !== entry.confirmed) {
      errors.push(`${id}: the confirmation does not match what this answer re-derives to; `
        + "it was given for a different mapping");
      continue;
    }
    policy[id] = derived.merged;
  }
  return { policy, errors, expired };
}

/**
 * The exact authored entry, as a value two sessions can compare.
 *
 * Optimistic concurrency used to be checked against what the record DERIVES, which cannot see the
 * difference between two answers that derive the same thing -- and derives nothing at all for an
 * unconfirmed one, so two people answering the same open capability both compared equal to null and
 * the second silently replaced the first's authoritative human answer. The record is what is being
 * overwritten, so the record is what a baseline has to name.
 *
 * Key order is normalised, because the baseline travels through a browser and back and must not
 * depend on how a JSON round trip happened to order it.
 */
export function entryDigest(entry: AuthoredEntry | null | undefined): string {
  if (!entry) return "absent";
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        out[key] = stable((value as Record<string, unknown>)[key]);
      }
      return out;
    }
    return value;
  };
  return createHash("sha256").update(JSON.stringify(stable(entry))).digest("hex").slice(0, 16);
}

/** The digest of the authored record's exact bytes, stamped into anything generated from it. */
export function recordDigest(file = AUTHORED_FILE): string {
  if (!fs.existsSync(file)) return "absent";
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

/**
 * Read the generated policy, refusing it if it was not generated from the record on disk NOW.
 *
 * Every consumer goes through here. A generated file that silently lags its source is the same
 * defect as two authoritative files, just slower to notice: the digest turns it into a loud
 * failure with the command that fixes it.
 */
export function loadGeneratedPolicy(
  policyFile = GENERATED_POLICY_FILE,
  authoredFile = AUTHORED_FILE,
): Record<string, unknown> {
  if (!fs.existsSync(policyFile)) {
    throw new Error(`${path.basename(policyFile)} has not been generated. Run: npx tsx scripts/generate-capability-policy.ts`);
  }
  const raw = JSON.parse(fs.readFileSync(policyFile, "utf8")) as Record<string, unknown>;
  const stamped = (raw._generatedFrom ?? null) as string | null;
  const actual = recordDigest(authoredFile);
  if (stamped !== actual) {
    throw new Error([
      `${path.basename(policyFile)} was generated from a different version of ${path.basename(authoredFile)}`,
      `  it says it came from ${String(stamped)}; the record on disk is ${actual}`,
      "  Nothing may read a generated policy that lags its source. Run:",
      "    npx tsx scripts/generate-capability-policy.ts",
    ].join("\n"));
  }
  return Object.fromEntries(Object.entries(raw).filter(([id]) => !isDocKey(id)));
}

/** Which ids the record says are permanently non-authorizing, whatever their policy contains. */
export function legacyIds(entries: AuthoredRecord): string[] {
  return Object.keys(entries).filter((id) => entries[id].kind === "legacy").sort();
}

/** Fail-closed eligibility over a derived policy entry. A legacy entry never authorizes. */
export function derivedEntryAuthorizes(
  entry: UnvalidatedPolicy | null,
  declared: readonly { name: string; requiredColumns: readonly string[] }[],
): boolean {
  if (entry && entry.origin === "legacy") return false;
  return capabilityAuthorizes(entry, declared);
}

/**
 * ONE atomic rename. There is no second file to fall out of step with.
 *
 * `failAt` exists for the fault-injection regression: the authoritative file must be wholly the old
 * content or wholly the new one at every boundary, never a mixture and never absent.
 */
export function commitAuthoredRecord(
  serialized: string,
  options: { file?: string; failAt?: "before-write" | "after-write" | "after-rename" } = {},
): void {
  const file = options.file ?? AUTHORED_FILE;
  const staged = `${file}.staged`;
  if (options.failAt === "before-write") throw new Error("injected failure before the staged write");
  fs.writeFileSync(staged, serialized);
  if (options.failAt === "after-write") {
    // The staged file exists; the authoritative one is untouched. Leave the stage for inspection.
    throw new Error("injected failure after the staged write");
  }
  fs.renameSync(staged, file);
  if (options.failAt === "after-rename") throw new Error("injected failure after the rename");
}

/** Serialise the record: documentation first, then entries in a stable order. */
export function renderAuthoredRecord(docs: Record<string, unknown>, entries: AuthoredRecord): string {
  const ordered: Record<string, unknown> = {};
  for (const id of Object.keys(docs).sort()) ordered[id] = docs[id];
  for (const id of Object.keys(entries).sort()) ordered[id] = entries[id];
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
