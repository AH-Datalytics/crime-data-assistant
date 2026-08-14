import { createHash } from "node:crypto";

/**
 * The environment-variable name that gates probing for one capability.
 *
 * ONE derivation, imported by everything that needs it. Generation owns it and pins the result per
 * capability in the registry; the request path reads that pin (`spec.flagKey`) rather than
 * recomputing. Two implementations of one derivation is a drift the pin cannot prevent, because the
 * consumer would simply ignore it.
 *
 * The name goes through a DIGEST of the capability id, not through the id itself:
 *
 *   - A structural id contains `::`, `+`, `(`, `)` and `,`, so it cannot be uppercased into an
 *     identifier.
 *   - A short readable label is not unique. Two capabilities can share a table set --
 *     `shr:metadata-agency-directory` and `shr:metadata-year-coverage` both read `incidents` --
 *     which is exactly why required columns are part of capability identity. A label would have to
 *     be hand-maintained, and a hand-maintained map is what produced three wrong inventories.
 *
 * Consequence, deliberate and approved 2026-08-14: changing a capability's contract changes its
 * flag, so probing must be re-enabled explicitly for the new contract instead of being inherited by
 * a name that silently now means something else. Readability is traded away because the registry
 * provides the lookup.
 */
export function capabilityFlagKey(artifact: string, capabilityId: string): string {
  const digest = createHash("sha256").update(capabilityId).digest("hex").slice(0, 8).toUpperCase();
  return `PROOF_CAPABILITY_${artifact.toUpperCase()}_${digest}`;
}
