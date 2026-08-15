/**
 * The capabilities no deterministic operation reaches.
 *
 * These cannot come from the operation catalog, because the catalog is derived BY EXECUTION and
 * nothing executes them: frozen spec §8:241 still requires Current Trends to independently validate
 * the national and sample-agency tables, and the digest-time sweep is what evaluates them. Their
 * tables are stated rather than observed, which is the whole reason they need a hand-written home.
 *
 * ONE carrier, because they were previously private to the inventory generator. The workbook is
 * built from the registry, so a capability living only inside the generator was asked about by
 * nothing and, had anyone authored it anyway, refused by the importer as "not a capability in the
 * registry" -- a capability that could be neither decided nor declined. Every consumer that thinks
 * in registry entries now gets them from here.
 */
import { capabilityFlagKey } from "./capability-flag-key";

export type SweepOnlySpec = {
  capabilityId: string;
  artifact: string;
  tables: Record<string, string[]>;
  prepDependencies: string[];
};

export const SWEEP_ONLY_SPECS: readonly SweepOnlySpec[] = [
  {
    capabilityId: "crime_data::national_monthly::sweep",
    artifact: "crime_data",
    tables: { national_monthly: ["agency_count", "count", "month", "offense", "year"] },
    prepDependencies: [],
  },
];

export const SWEEP_ONLY_IDS: readonly string[] = SWEEP_ONLY_SPECS.map((spec) => spec.capabilityId);

/** Registry-shaped, so consumers keyed off the registry need no special case for these. */
export type SweepRegistryEntry = {
  artifact: string;
  prepDependencies: string[];
  emittedDependencies: string[];
  requiredColumns: Record<string, string[]>;
  flagKey: string;
  policy: Record<string, unknown> | null;
  authorizationEligible: boolean;
};

export function sweepOnlyRegistryEntries(): Record<string, SweepRegistryEntry> {
  const entries: Record<string, SweepRegistryEntry> = {};
  for (const spec of SWEEP_ONLY_SPECS) {
    entries[spec.capabilityId] = {
      artifact: spec.artifact,
      prepDependencies: [...spec.prepDependencies],
      emittedDependencies: Object.keys(spec.tables).sort(),
      requiredColumns: Object.fromEntries(
        Object.keys(spec.tables).sort().map((table) => [table, [...spec.tables[table]].sort()]),
      ),
      flagKey: capabilityFlagKey(spec.artifact, spec.capabilityId),
      policy: null,
      authorizationEligible: false,
    };
  }
  return entries;
}

/**
 * The full question set the workbook and the importer must agree on.
 *
 * Both derive it here rather than each merging the sweep list its own way, because the registry
 * fingerprint is computed over this set: two merges that differed by one capability would produce
 * two fingerprints, and every export would read as stale against the importer that must accept it.
 */
export function decidableCapabilities<T>(registry: Record<string, T>): Record<string, T | SweepRegistryEntry> {
  return { ...registry, ...sweepOnlyRegistryEntries() };
}
