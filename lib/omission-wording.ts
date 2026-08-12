/**
 * Approved factual templates for omitted entities, generated from reason codes.
 *
 * Source of truth: docs/superpowers/specs/2026-08-11-verified-answer-only-handoff.md
 * §7 ("The user-facing wording layer maps reason codes to approved factual
 * templates") and §2.4 (what may and may not be said about why data is missing).
 *
 * WHY DISCLOSURE IS GENERATED AND NOT DETECTED. The first version of this check
 * asked whether each omitted entity's name appeared anywhere in the narrative. That
 * passes on "Dallas had 10 murders in 2020" -- a sentence that mentions Dallas while
 * disclosing nothing about its absence, and which in a comparison context actively
 * implies the opposite. Substring presence is not evidence of disclosure, and §2.4's
 * rule is about what the user is actually told.
 *
 * So the notice is produced deterministically here, and disclosure means the
 * delivered narrative CONTAINS that generated notice. There is no path from
 * arbitrary prose to a passing disclosure check.
 *
 * A consequence worth stating plainly: nothing in Stage 1 injects this notice, so
 * real traffic with omissions will record `entityCompleteness: failed` rather than
 * crediting a limited-scope answer. That is the honest reading -- today's prose is
 * not a controlled disclosure -- and it is the measurement the shadow period exists
 * to collect. Stage 4 generates narratives from bindings, at which point the notice
 * is present by construction rather than by coincidence.
 *
 * THE SOURCE/CAPABILITY SPLIT IS ENFORCED HERE TOO. A reason outside
 * SOURCE_ATTRIBUTABLE_OMISSION_REASONS gets capability wording, never a claim about
 * the data -- so an `unknown` attribution cannot become "not in this source" merely
 * because it reached the wording layer.
 */

import {
  isSourceAttributable,
  type Omission,
  type OmissionReason,
} from "./proof-contract";

/**
 * One approved sentence per reason, taking the entity list.
 *
 * Every source-attributable template states a fact about the data and is therefore
 * only reachable when attribution carried evidence (assertOmissionEvidence already
 * downgrades an unevidenced reason to `unknown`). The remaining templates describe
 * this product's limits.
 */
const TEMPLATES: Record<OmissionReason, (labels: string) => string> = {
  not_in_source: (labels) => `${labels} could not be found in this source.`,
  outside_source_years: (labels) => `${labels} falls outside the years this source covers.`,
  nonreporting_period: (labels) => `${labels} did not report data for the requested period.`,
  insufficient_reporting_coverage: (labels) =>
    `${labels} does not have enough reporting coverage in this period to include.`,
  filtered_by_metric_definition: (labels) => `${labels} is excluded by the definition of this measure.`,
  consolidation_mapping: (labels) => `${labels} is reported here under a consolidated agency.`,
  // Capability framing below: none of these asserts anything about the data itself.
  unsupported_geography_type: (labels) => `${labels} cannot currently be included as this kind of place.`,
  source_unhealthy: (labels) => `${labels} cannot be included right now while this source is being checked.`,
  capability_path_unavailable: (labels) => `${labels} cannot currently be included through this path.`,
  unknown: (labels) => `${labels} cannot currently be included through this path.`,
};

/** Entities named inline before switching to a count (§2.4's bounded list rule). */
export const MAX_INLINE_OMISSION_LABELS = 5;

function formatLabels(labels: string[]): string {
  if (labels.length === 1) return labels[0];
  if (labels.length <= MAX_INLINE_OMISSION_LABELS) {
    return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
  }
  const shown = labels.slice(0, MAX_INLINE_OMISSION_LABELS).join(", ");
  return `${shown} and ${labels.length - MAX_INLINE_OMISSION_LABELS} others`;
}

/**
 * The notice that would disclose these omissions, or null when there are none.
 *
 * Grouped by reason so each group gets its own approved sentence, and ordered by the
 * reason's position in the closed set so the same omissions always produce the same
 * string. A notice that varied run to run could not be compared against a delivered
 * narrative at all.
 */
export function buildOmissionNotice(omissions: Omission[]): string | null {
  if (omissions.length === 0) return null;

  const byReason = new Map<OmissionReason, string[]>();
  for (const omission of omissions) {
    const label = omission.label?.trim();
    if (!label) continue;
    const existing = byReason.get(omission.reason);
    if (existing) existing.push(label);
    else byReason.set(omission.reason, [label]);
  }
  if (byReason.size === 0) return null;

  const sentences: string[] = [];
  for (const [reason, labels] of [...byReason.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    // Labels sorted for the same determinism reason as the groups.
    sentences.push(TEMPLATES[reason](formatLabels([...labels].sort())));
  }
  return sentences.join(" ");
}

/**
 * Whether a reason may be phrased as a statement about the source.
 *
 * Re-exported from the frozen contract so the wording layer and the attribution
 * layer answer this question from one definition.
 */
export function reasonMayBlameSource(reason: OmissionReason): boolean {
  return isSourceAttributable(reason);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Does the delivered narrative actually carry the generated disclosure?
 *
 * Compares against the WHOLE generated notice rather than looking for entity names,
 * so a narrative that merely mentions an omitted city does not qualify. Whitespace
 * and case are normalized because the narrative layer reflows text; nothing else is.
 */
export function narrativeDisclosesOmissions(
  narrative: string | null | undefined,
  omissions: Omission[],
): boolean {
  const notice = buildOmissionNotice(omissions);
  if (notice === null) return true;
  if (!narrative) return false;
  return normalize(narrative).includes(normalize(notice));
}
