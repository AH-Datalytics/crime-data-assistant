/**
 * What the USER asked for -- not what the generated SQL happened to ask for.
 *
 * WHY THIS MODULE EXISTS. Stage 1 first derived the requested-entity set with
 * requestedEntitiesFromSql(), scraping `agency = '...'` and `city IN (...)` out of
 * the query that ran. That makes the completeness check unable to detect the one
 * failure it was built for. If a user asks to compare Austin and Dallas and the
 * model emits SQL naming only Austin, then:
 *
 *   requested = {Austin}   (from the SQL)
 *   returned  = {Austin}
 *   → entityCompleteness PASSES, and Dallas is silently gone.
 *
 * Handoff §2.4: "Never silently drop a requested city, agency, year, category, or
 * measure." A check that reads its expectations out of the artifact it is meant to
 * audit cannot enforce that. The request is the only trustworthy source of what was
 * requested.
 *
 * lib/query-contract.ts already resolves a question into canonical geographies via
 * lib/geo-place-resolver, so this module reads that resolution rather than doing a
 * third parse of the question.
 */

import type { QueryContract } from "./query-contract";
import type { OmittedCandidate } from "./omission-attribution";
import { entityAliasKeys } from "./result-disclosure";

/** A canonical entity the user asked about. */
export interface RequestedEntity {
  /** Stable identifier: canonical name plus state when known. */
  entityId: string;
  /** Display label for the wording layer. */
  label: string;
  state: string | null;
}

/**
 * Geography kinds that name a specific place a result can include or omit.
 *
 * `national` is excluded because a national request has no per-entity
 * completeness question, and `unknown` because an unresolved mention is not a
 * canonical entity -- it is a clarification case, which checkCanonicalGeographies
 * handles.
 */
const ENTITY_KINDS = new Set(["city", "county", "agency", "campus"]);

export function requestedEntitiesFromRequest(contract: QueryContract | null): RequestedEntity[] {
  if (!contract) return [];
  const entities: RequestedEntity[] = [];
  const seen = new Set<string>();
  for (const geo of contract.geographies) {
    if (!ENTITY_KINDS.has(geo.kind)) continue;
    const label = geo.name ?? geo.canonicalName;
    if (!label) continue;
    // An unresolved mention is not counted as requested: it has no canonical
    // identity to compare a result row against, and treating it as a requested
    // entity would manufacture an omission for every ambiguous place name.
    if (geo.needsClarification.length > 0) continue;
    const entityId = `${label}${geo.state ? `, ${geo.state}` : ""}`.toLowerCase();
    if (seen.has(entityId)) continue;
    seen.add(entityId);
    entities.push({ entityId, label, state: geo.state });
  }
  return entities;
}

/**
 * The requested entities absent from the result, ready for attribution.
 *
 * Computed here rather than in each route so that no route can forget to supply
 * omittedCandidates -- the first revision left every route passing none, which
 * meant the whole attribution system recorded zero omissions while appearing to
 * work.
 *
 * Comparison uses entityAliasKeys() on both sides, so "St. Louis" requested
 * against "Saint Louis" returned is a match rather than a fabricated omission.
 */
export function omittedCandidatesFor(
  requested: RequestedEntity[],
  returnedEntityKeys: string[],
  requestedYears: number[],
): OmittedCandidate[] {
  if (requested.length === 0) return [];
  const returned = new Set(returnedEntityKeys.flatMap((entity) => entityAliasKeys(entity)));
  if (returned.size === 0) {
    // Nothing recognizable came back. Every requested entity is a candidate; the
    // attribution layer decides whether that is a source fact or a capability gap.
    return requested.map((entity) => ({
      entityId: entity.entityId,
      label: entity.label,
      state: entity.state,
      requestedYears,
    }));
  }
  return requested
    .filter((entity) => !entityAliasKeys(entity.label).some((key) => returned.has(key)))
    .map((entity) => ({
      entityId: entity.entityId,
      label: entity.label,
      state: entity.state,
      requestedYears,
    }));
}

/**
 * Years the request covers, bounded so a wide range cannot become an unbounded array.
 *
 * Used for omission attribution ("present in source but not for the requested
 * years"). The cap matters: a question spanning 1930-2025 would otherwise build a
 * 96-element array per candidate inside the request-path latency budget.
 */
export const MAX_REQUESTED_YEARS = 32;

export function requestedYearsFromContract(contract: QueryContract | null): number[] {
  if (!contract) return [];
  const { startYear, endYear } = contract.time;
  if (startYear === null && endYear === null) return [];
  const start = startYear ?? endYear!;
  const end = endYear ?? startYear!;
  if (end < start) return [];
  const span = end - start + 1;
  if (span > MAX_REQUESTED_YEARS) return [start, end];
  return Array.from({ length: span }, (_, i) => start + i);
}
