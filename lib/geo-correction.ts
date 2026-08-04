/**
 * Canonical-place hint (Task 21, completion). When a place resolves confidently
 * only via the typo-tolerant fallback — i.e. the canonical name does NOT appear
 * literally in the question — the model still receives the raw misspelling.
 * This builds a short hint naming the corrected place so obscure typos the
 * model can't self-correct still reach the right geography. Common typos the
 * model already handles produce the same (harmless) hint.
 */

import { resolveGeoPlaces } from "./geo-place-resolver";

export function geoCorrectionHint(question: string): string | null {
  const q = question.toLowerCase();
  const resolution = resolveGeoPlaces(question);
  const hints: string[] = [];
  for (const mention of resolution.mentions) {
    if (mention.requiresClarification || mention.candidates.length !== 1) continue;
    const candidate = mention.candidates[0];
    // Only when the resolved place isn't literally in the question (a typo was
    // corrected) — an exact match needs no hint.
    if (q.includes(candidate.name.toLowerCase())) continue;
    const canonical = candidate.canonicalQuery ?? (candidate.state ? `${candidate.name}, ${candidate.state}` : candidate.name);
    hints.push(`"${mention.text}" appears to mean ${canonical}`);
  }
  if (hints.length === 0) return null;
  return `Note: ${hints.join("; ")}. Use the corrected place name${hints.length > 1 ? "s" : ""} when building the query.`;
}

/** Append the canonical-place hint to the question the model sees (not the logged/cached key). */
export function applyGeoCorrection(question: string): string {
  const hint = geoCorrectionHint(question);
  return hint ? `${question}\n\n[${hint}]` : question;
}
