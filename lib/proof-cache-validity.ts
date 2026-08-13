/**
 * What makes a cached response still valid to replay.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §4 ("cache-hit answers still require current proof, and cache validity must
 * incorporate enforcement state and source data version") and §13 ("cache hits cannot
 * bypass proof, and enforcement/source-version changes invalidate incompatible cache
 * entries").
 *
 * WHAT THE CACHE ACTUALLY HOLDS. lib/response-cache stores the model's SQL and
 * pre-query explanation, not the answer. A hit skips the Claude call and re-runs that
 * SQL against live data, so the ROWS are always fresh and the result still travels the
 * route's normal exit -- which means it already passes through proof finalization.
 * That half of §13 is satisfied by the route integration, not by this module.
 *
 * WHAT THIS MODULE FIXES. The cached SQL itself was authored under a particular
 * enforcement configuration and a particular source build, and neither was part of the
 * cache key. So an entry created while the proof system was `off` could be replayed
 * under `enforce`, carrying SQL whose creation no enforcement decision ever saw.
 *
 * WHY A FINGERPRINT OVER THE WHOLE CONFIGURATION, NOT THE RESOLVED MODE. A first
 * revision used resolveMode(sourceId, null, env) -- the FAMILY-LESS mode. But
 * enforcement is granted per source x family and therefore never appears in a
 * family-less resolution, so turning on
 * PROOF_MODE_FAMILY_CURRENT_CLEARANCE_TYPE=enforce left the signature byte-identical
 * and every stale entry kept serving. The signature now fingerprints every proof
 * variable that applies to the source, so any configuration change that could affect
 * an answer changes the key -- including one that only affects a single family.
 *
 * TODAY THIS IS BELT-AND-BRACES, AND THAT IS THE POINT. The cache is per-process and
 * in-memory, and changing a proof mode requires `pm2 reload --update-env`, which
 * restarts the workers and clears it. So the invalidation is currently unreachable by
 * accident. It is written anyway because that safety is incidental to the deployment
 * mechanism rather than guaranteed by the code, and it would vanish the moment the
 * cache moved to Redis or gained a longer TTL -- at which point the bug would be
 * silent and the reason for it forgotten.
 */

import { createHash } from "node:crypto";
import { PROOF_SCHEMA_VERSION } from "./proof-finalize";
import {
  ENV_GLOBAL_MODE,
  ENV_KILL_SWITCH,
  enforcedTargets,
  envKeyForSource,
  type ModeEnv,
} from "./proof-modes";
import type { SourceId } from "./proof-contract";

/**
 * Placeholder recorded when the source build identifier is not yet known.
 *
 * Stage 2 introduces the per-capability source-health registry, which is what will
 * supply a real version. Until then every entry carries this marker, and the Stage 2
 * change to real versions invalidates the whole cache exactly once -- which is the
 * correct behavior, not a side effect to be worked around.
 */
export const UNKNOWN_DATA_VERSION = "unknown";

/**
 * Every proof environment variable that can affect an answer from this source.
 *
 * Family keys are included by prefix scan rather than by a fixed list, for the same
 * reason enforcedTargets() scans them: families are declared by the plan library, and
 * this module must not need editing when one is added. A family that is added and
 * enabled must change the fingerprint on its own.
 */
function applicableProofEnv(sourceId: SourceId, env: ModeEnv): string[] {
  const familyPrefix = `PROOF_MODE_FAMILY_${sourceId.toUpperCase()}_`;
  const keys = [ENV_KILL_SWITCH, ENV_GLOBAL_MODE, envKeyForSource(sourceId)];
  for (const key of Object.keys(env)) {
    if (key.startsWith(familyPrefix)) keys.push(key);
  }
  // Sorted so the fingerprint does not depend on environment iteration order.
  return [...new Set(keys)].sort().map((key) => `${key}=${env[key] ?? ""}`);
}

/** Short, stable fingerprint of the applicable configuration. */
export function proofConfigFingerprint(sourceId: SourceId, env: ModeEnv = process.env): string {
  const material = applicableProofEnv(sourceId, env).join("\n");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 12);
}

/**
 * The signature a cached entry must match to be reused, or undefined when nothing about
 * this source's configuration can legitimately invalidate an entry yet.
 *
 * UNDEFINED IS LOAD-BEARING. lib/response-cache builds the pre-Stage-1 key when no
 * signature is supplied, so returning undefined means byte-identical cache keys to the
 * baseline release. A first revision returned a signature unconditionally, which changed
 * every key while claiming to be inert.
 *
 * WHY OBSERVATION IS NOT ENOUGH TO DIVERGE, THOUGH IT ONCE WAS. An earlier revision
 * diverged as soon as the source was OBSERVING, on the theory that entries authored
 * with no proof observation should not be replayed once the system is watching. That was
 * wrong twice over. It broke invariant 14 ("off and shadow cannot change routing, SQL,
 * retries, rows, narrative, charts"): warming a question under `off` and then enabling
 * shadow in the same process produced a MISS, which re-invoked the model and was free to
 * return different SQL, rows, narrative and charts. And it bought nothing, because a
 * cache hit re-runs the cached SQL through the route's normal exit and is therefore
 * proof-finalized on replay anyway -- the entry gets observed either way. §4/§13 asks
 * validity to carry "enforcement state and source data version"; shadow is neither.
 *
 * SO DIVERGENCE BEGINS AT ENFORCEMENT, OR AT A KNOWN SOURCE VERSION. Enforcement is
 * granted per source x family and can never appear in a family-less resolution, so the
 * question "is anything enforcing here?" has to go through enforcedTargets rather than
 * resolveMode(sourceId, null, ...) -- which is the same reason applicableProofEnv scans
 * family keys by prefix. Until Stage 2 supplies real versions, an unenforced source
 * therefore uses the baseline key, and off <-> shadow entries interoperate in both
 * directions.
 */
export function cacheValiditySignature(
  sourceId: SourceId,
  dataVersion: string | null | undefined,
  env: ModeEnv = process.env,
): string | undefined {
  const version = dataVersion && dataVersion.trim() !== "" ? dataVersion.trim() : null;
  const enforcingThisSource = enforcedTargets(env).some((target) => target.sourceId === sourceId);
  if (!enforcingThisSource && version === null) return undefined;
  return `p${PROOF_SCHEMA_VERSION}|c:${proofConfigFingerprint(sourceId, env)}|d:${version ?? UNKNOWN_DATA_VERSION}`;
}
