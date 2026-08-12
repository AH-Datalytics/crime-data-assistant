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
 * enforcement state and a particular source build, and neither was part of the cache
 * key. So an entry created while the proof system was `off` could be replayed under
 * `enforce`, carrying SQL whose creation no enforcement decision ever saw. Folding
 * both into the key means such an entry misses rather than being served.
 *
 * TODAY THIS IS BELT-AND-BRACES, AND THAT IS THE POINT. The cache is per-process and
 * in-memory, and changing a proof mode requires `pm2 reload --update-env`, which
 * restarts the workers and clears it. So the invalidation is currently unreachable by
 * accident. It is written anyway because that safety is incidental to the deployment
 * mechanism rather than guaranteed by the code, and it would vanish the moment the
 * cache moved to Redis or gained a longer TTL -- at which point the bug would be
 * silent and the reason for it forgotten.
 */

import { PROOF_SCHEMA_VERSION } from "./proof-finalize";
import { resolveMode, type ModeEnv } from "./proof-modes";
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
 * The signature a cached entry must match to be reused.
 *
 * Deliberately a plain string rather than a structured object: it is concatenated into
 * a cache key, and a stable, readable, greppable form makes a stale entry diagnosable
 * from the key alone.
 */
export function cacheValiditySignature(
  sourceId: SourceId,
  dataVersion: string | null | undefined,
  env: ModeEnv = process.env,
): string {
  // The family-less mode is the right granularity here. Per-family enforcement can
  // only narrow behavior, and a cache key that varied per family would fragment the
  // cache for no gain -- the cached artifact is source-level SQL, not a family answer.
  const mode = resolveMode(sourceId, null, env).mode;
  const version = dataVersion && dataVersion.trim() !== "" ? dataVersion.trim() : UNKNOWN_DATA_VERSION;
  return `p${PROOF_SCHEMA_VERSION}|m:${mode}|d:${version}`;
}
