/**
 * Generates `lib/source-health-inventory.ts` from the derived operation catalogs.
 *
 * Run: `npx tsx scripts/generate-source-health-inventory.ts`
 *
 * The inventory is GENERATED, not authored. Three hand-written inventories were wrong before this
 * one (20, then 41, then 40 capabilities), each because a human retyped what an observation had
 * already established. `scripts/test-source-health-inventory.ts` asserts the checked-in file is
 * byte-identical to what this emits, so a hand edit fails the suite.
 *
 * The output is checked in rather than read at runtime: `lib/` must not depend on a path under
 * `scripts/fixtures/`, and a build-time read would put a test fixture on the request path.
 */
import fs from "node:fs";
import path from "node:path";
import { capabilityFlagKey } from "../lib/capability-flag-key";
import { capabilityAuthorizes } from "../lib/capability-policy";
/**
 * The capability with no eligible deterministic operation.
 *
 * Imported rather than declared here. It is not only this file's concern: the workbook must ASK
 * about it and the importer must accept an answer for it, and while it lived as a private constant
 * neither could see it -- so it was a capability that could be neither decided nor declined. One
 * carrier now, in `lib/sweep-only-capabilities.ts`.
 */
import { SWEEP_ONLY_SPECS } from "../lib/sweep-only-capabilities";

const DATA_DIR = path.join(process.cwd(), "scripts", "fixtures", "operation-taxonomy");
const REGISTRY_FILE = path.join(DATA_DIR, "capability-registry.json");
export const INVENTORY_FILE = path.join(process.cwd(), "lib", "source-health-inventory.ts");

type RegistryEntry = {
  artifact: string;
  prepDependencies: string[];
  emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  flagKey: string;
  policy: Record<string, unknown> | null;
  authorizationEligible: boolean;
};

/**
 * minRows is a DECISION. The registry cannot supply it, so one rule is applied uniformly and the
 * regression asserts the uniformity -- otherwise the numbers read as per-capability evidence that
 * nobody gathered.
 *
 *   emitted table     -> 1  the operation reads its answer from it, so zero rows means no answer
 *   preparation table -> 0  read while DECIDING; finding nothing there is a legitimate decline
 *                           (an agency absent from a crosswalk), not an unhealthy source
 */
const EMITTED_MIN_ROWS = 1;
const PREPARATION_MIN_ROWS = 0;

const literal = (value: unknown) => JSON.stringify(value);

/**
 * Hand-authored policy, keyed by capability id. Operation-backed capabilities receive theirs via the
 * registry, which the taxonomy derivation copies in; sweep-only ones have no registry row, so they
 * read the same file directly rather than being handed a null.
 */
function readAuthoredPolicy(): Record<string, Record<string, unknown>> {
  const file = path.join(DATA_DIR, "capability-policy.json");
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, Record<string, unknown>>;
  return Object.fromEntries(Object.entries(parsed).filter(([id]) => !id.startsWith("_")));
}

function renderSpec(id: string, artifact: string, emittedDependencies: string[],
  requiredColumns: Record<string, string[]>, prepDependencies: string[], flagKey: string,
  policy: Record<string, unknown> | null): string {
  /**
   * Table membership comes from emittedDependencies, NOT from the keys of requiredColumns.
   *
   * An operation can depend on a table without naming any of its columns -- `SELECT COUNT(*) FROM t`
   * reads the table and no column. Keying off requiredColumns dropped such a table out of the
   * health inventory entirely, so nothing would ever check it. Current fixture data has no such
   * case, which is exactly why the defect was invisible.
   */
  const tables = [...emittedDependencies].sort()
    .map((name) => `      { name: ${literal(name)}, requiredColumns: ${literal([...(requiredColumns[name] ?? [])].sort())}, minRows: ${EMITTED_MIN_ROWS} },`)
    .join("\n");
  const prep = [...prepDependencies].sort()
    .map((name) => `      { name: ${literal(name)}, requiredColumns: [], minRows: ${PREPARATION_MIN_ROWS} },`)
    .join("\n");
  return [
    `  {`,
    `    capabilityId: ${literal(id)},`,
    `    artifact: ${literal(artifact)},`,
    `    database: PROVIDERS[${literal(artifact)}],`,
    `    preparationTables: [${prep ? `\n${prep}\n    ` : ""}],`,
    `    tables: [\n${tables}\n    ],`,
    `    dependencies: [],`,
    `    semanticDependencies: [],`,
    `    flagKey: ${literal(flagKey)},`,
    `    policy: ${policy === null ? "null" : JSON.stringify(policy, null, 6).replace(/\n/g, "\n    ")},`,
    `    authorizationEligible: ${String(eligible(policy, emittedDependencies, requiredColumns))},`,
    `  },`,
  ].join("\n");
}

/**
 * Eligibility uses the SHARED predicate, never a local rule, and it is capability-specific.
 *
 * Two earlier versions were wrong in the same direction. The first marked a policy complete whenever
 * its four fields were non-null, ignoring shape entirely. The second used shape alone -- which cannot
 * see which tables the capability reads, so a well-shaped policy naming a stray coverage basis was
 * generated as ELIGIBLE while coverageBasisErrors rejected it. The pin itself was wrong; a downstream
 * regression caught it only afterwards.
 */
function eligible(
  policy: Record<string, unknown> | null,
  emittedDependencies: string[],
  requiredColumns: Record<string, string[]>,
): boolean {
  const declared = emittedDependencies.map((name) => ({ name, requiredColumns: requiredColumns[name] ?? [] }));
  return capabilityAuthorizes(policy, declared);
}

export function renderInventory(registryOverride?: Record<string, RegistryEntry>): string {
  const registry = registryOverride
    ?? (JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")) as Record<string, RegistryEntry>);

  const rows: string[] = [];
  for (const id of Object.keys(registry).sort()) {
    const entry = registry[id];
    // The flag key is read from the registry PIN, and separately asserted to equal
    // capabilityFlagKey(artifact, id) so the pin and the derivation cannot diverge unnoticed.
    rows.push(renderSpec(id, entry.artifact, entry.emittedDependencies, entry.requiredColumns,
      entry.prepDependencies, entry.flagKey, entry.policy));
  }
  /**
   * Sweep-only capabilities read their policy from the SAME source as every other capability.
   *
   * Their policy was hardcoded to null here, which made them authorable and un-authorizable: the
   * importer accepted a decision for one and the inventory then dropped it on the floor, so no
   * amount of authoring could ever reach the runtime. A capability that can be asked a question
   * whose answer is discarded is worse than one that is never asked.
   */
  const authoredPolicy = readAuthoredPolicy();
  for (const sweep of SWEEP_ONLY_SPECS) {
    rows.push(renderSpec(sweep.capabilityId, sweep.artifact, Object.keys(sweep.tables), sweep.tables,
      sweep.prepDependencies, capabilityFlagKey(sweep.artifact, sweep.capabilityId),
      authoredPolicy[sweep.capabilityId] ?? null));
  }

  const sweepIds = SWEEP_ONLY_SPECS.map((s) => s.capabilityId);
  /**
   * Both counts span EVERY capability the file emits, sweep-only included.
   *
   * The header counted only registry rows while the specs below it already carried sweep-only
   * policy, so the first sweep-only capability to be authored would have been described by a number
   * that did not include it -- a summary quietly disagreeing with the rows it summarises.
   */
  const authored = Object.values(registry).filter((e) => e.policy !== null).length
    + SWEEP_ONLY_SPECS.filter((s) => authoredPolicy[s.capabilityId]).length;
  const eligibleCount =
    Object.values(registry).filter((e) => eligible(e.policy, e.emittedDependencies, e.requiredColumns)).length
    + SWEEP_ONLY_SPECS.filter((s) => eligible(
      authoredPolicy[s.capabilityId] ?? null, Object.keys(s.tables), s.tables)).length;

  return `/**
 * GENERATED FILE -- DO NOT EDIT BY HAND.
 *
 * Produced by \`npx tsx scripts/generate-source-health-inventory.ts\` from the derived operation
 * catalogs. \`scripts/test-source-health-inventory.ts\` asserts this file is byte-identical to what
 * the generator emits, so a hand edit fails the suite: three hand-authored inventories were wrong
 * before this one.
 *
 * Capabilities: ${rows.length} (${Object.keys(registry).length} operation-backed + ${sweepIds.length} sweep-only).
 * Policy authored: ${authored}. Authorization-eligible: ${eligibleCount}.
 *
 * Nothing here authorizes anything. \`authorizationEligible\` is false until every policy field is
 * authored in \`scripts/fixtures/operation-taxonomy/capability-policy.json\`, which is Stage 2B work.
 */
import type { SourceId } from "./sources";
import { getDb } from "./rtci-db";
import { getNibrsDb } from "./nibrs-db";
import { getShrDb } from "./shr-db";
import { getHateCrimeDb } from "./hc-db";

export type Db = import("better-sqlite3").Database;
/** A handle and the path it was actually opened from, acquired together. */
export type OpenedDatabase = { db: Db; resolvedPath: string };
export type DatabaseProvider = { acquire: () => OpenedDatabase | null };
export type TableRequirement = { name: string; requiredColumns: string[]; minRows: number };
/**
 * A derived table and the upstream it must agree with.
 *
 * keyColumn is STATED, not inferred. Taking the derived table's first required column as the join
 * key made a semantic relationship depend on alphabetical ordering -- correct for sample_agencies
 * only because sorting happens to put ori first.
 */
export type DependencyRule = { derived: string; upstream: string; keyColumn: string; generationColumn?: string };
export type SemanticDependency = {
  table: string; requiredColumns: string[]; qualifies: string;
  keyColumn: string; yearColumn: string; versionColumn?: string;
  /**
   * Whether the qualifying table is a COMPLETE ledger or a SPARSE exception table.
   *
   * This is not a detail. \`agency_year_reliability\` is sparse: its builder inserts a row only for a
   * detected finding (scripts/build-agency-year-reliability.ts, inside \`for (const finding of
   * findings)\`), so an absent agency-year normally means no anomaly was recorded. Requiring every
   * qualified row to have a qualifying row would therefore degrade nearly every real capability
   * holding ordinary unflagged crime data.
   *
   *   complete -> every qualified row must have a qualifying row
   *   sparse   -> existing flags must be VALID; absence is not a defect, and build completeness
   *               cannot be established from row presence or MAX(year) at all, because a recent year
   *               may legitimately produce zero flags. It needs generation/receipt evidence.
   */
  coverage: "complete" | "sparse";
};
export type CapabilityPolicy = {
  /**
   * Discriminated, so an authored "no year dimension" is an ANSWER rather than an absence. It was
   * once the string "none", normalised to null on import, which made a considered decision
   * indistinguishable from never having been asked.
   */
  coverage:
    | { kind: "column"; table: string; yearColumn: string; justification?: string }
    | { kind: "none"; reason: string }
    | null;
  /**
   * A rule is DRAFT PROSE (a string) or BOUND ({ rule, boundTo }), and only a bound rule whose
   * target is in the generated check catalog authorizes. Prose is kept -- it is the record of what
   * "broken" means here and what a binding will be written from -- but a capability stays ineligible
   * while any rule is unbound, because a field that is mandatory BECAUSE integrity matters cannot
   * grant an eligibility that ignores it.
   */
  integrity: (string | { rule: string; boundTo: string })[] | null;
  /** Discriminated, so a conditional cannot be written without its condition. */
  availability: { kind: "always" } | { kind: "conditional"; condition: string } | null;
  receiptOwner: string | null;
  evidence: string;
};
export type CapabilitySpec = {
  capabilityId: string;              // the registry key; identity, not a label
  artifact: SourceId | "crime_data";
  database: DatabaseProvider;
  /** Read while RESOLVING/CONSTRUCTING; absent from the emitted SQL. */
  preparationTables: TableRequirement[];
  tables: TableRequirement[];
  /** Empty until Task 3 authors dependency rules; the regression asserts they stay empty. */
  dependencies: DependencyRule[];
  semanticDependencies: SemanticDependency[];
  /**
   * The env-var name that gates probing, PINNED here so a variable in ops config traces back to its
   * capability. Consumers read this; they must not re-derive it.
   */
  flagKey: string;
  /** Hand-authored policy, copied from capability-policy.json. null means "not yet authored". */
  policy: CapabilityPolicy | null;
  /** Computed from the policy, never set by hand. False unless every policy field is authored. */
  authorizationEligible: boolean;
};

/** Acquire a handle and the path it resolved to in one call, or nothing. */
function open(get: () => Db | null): OpenedDatabase | null {
  try {
    const db = get();
    return db ? { db, resolvedPath: db.name } : null;
  } catch {
    return null;
  }
}

/**
 * Each capability owns its provider, so no route has to hand a database over -- and a capability
 * cannot be evaluated against a handle that belongs to a different artifact.
 */
const PROVIDERS: Record<string, DatabaseProvider> = {
  crime_data: { acquire: () => open(() => getDb()) },
  nibrs: { acquire: () => open(() => getNibrsDb()) },
  shr: { acquire: () => open(() => getShrDb()) },
  hate_crime: { acquire: () => open(() => getHateCrimeDb()) },
};

/** Capabilities no deterministic operation reaches; evaluated by the digest-time sweep (Task 11). */
export const SWEEP_ONLY: readonly string[] = ${literal(sweepIds)};

export const CAPABILITY_INVENTORY: readonly CapabilitySpec[] = [
${rows.join("\n")}
];

const BY_ID = new Map(CAPABILITY_INVENTORY.map((spec) => [spec.capabilityId, spec]));

/**
 * Look a capability up by its structural id.
 *
 * There is no \`specFor(source, label)\` overload on purpose: a short per-source label is not
 * identity, because two capabilities can share a table set.
 */
export function specFor(capabilityId: string): CapabilitySpec | null {
  return BY_ID.get(capabilityId) ?? null;
}
`;
}

if (process.argv[1] && path.resolve(process.argv[1]).includes("generate-source-health-inventory")) {
  fs.writeFileSync(INVENTORY_FILE, renderInventory());
  console.log(`wrote ${path.relative(process.cwd(), INVENTORY_FILE)}`);
}
