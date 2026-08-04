/**
 * Qualifier awareness for the deterministic fatal-shooting path.
 *
 * Production 7881 asked for "police fatal shootings" and received ALL firearm
 * homicides: 14,777 for 2023 against a correct 349, a 42x overstatement, with a
 * narrative ("Fatal shootings (firearm homicides) by year since 2000") that
 * never mentioned the dropped qualifier.
 *
 * Cause: the deterministic path in app/api/shr-query/route.ts fires on any
 * mention of "shooting" and builds a fixed firearm-homicide query. It parses
 * years only (lib/shr-deterministic-shooting.ts) and has no concept of
 * qualifiers, so "police" was invisible to it. Because the path bypasses the
 * model entirely this was 100% reproducible and no prompt change could fix it.
 *
 * Two behaviours are needed, and they are deliberately separate:
 *   1. SUPPORTED qualifiers get a real predicate. Officer-involved killings are
 *      expressible: incidents.circumstance = 'Felon Killed by Police'
 *      (18,697 rows, all homicide_type = 'Murder').
 *   2. UNSUPPORTED qualifiers must make the deterministic path DECLINE, so the
 *      question falls through to the model rather than being answered as a
 *      different question. Answering a narrower question with a broader number
 *      is worse than a slower, model-generated answer.
 */

export type ShootingQualifier = {
  /** Stable id for guardrail tagging. */
  id: string;
  /** SQL predicate implementing the qualifier, or null when unsupported. */
  clause: string | null;
  /** Phrase for titles, e.g. "Police Fatal Shootings". */
  titleLabel: string;
  /** Phrase for the narrative, e.g. "police fatal shootings". */
  narrativeLabel: string;
  /** Extra caveat the narrative must carry. */
  caveat: string | null;
};

const POLICE_RE =
  /\b(?:police|officer[-\s]?involved|officer|law\s+enforcement|cop)\b[^.?!]{0,40}\b(?:shoot\w*|kill\w*|homicid\w*|shot)\b|\b(?:shoot\w*|kill\w*|shot)\b[^.?!]{0,30}\bby\s+(?:police|an?\s+officer|law\s+enforcement|cops?)\b/i;

/**
 * Qualifiers the deterministic path cannot express. Each would silently narrow
 * or change the meaning of a plain firearm-homicide count, so their presence
 * must stop the deterministic path rather than be ignored.
 *
 * Note: these must NOT overlap with dimensions the route already handles
 * (place, year, monthly grain) or with phrasing the caller filters earlier
 * (nonfatal), or the path would decline on questions it answers correctly.
 */
const UNSUPPORTED_QUALIFIER_RES: { id: string; re: RegExp }[] = [
  { id: "domestic", re: /\b(?:domestic|intimate\s+partner|spousal|family[-\s]related)\b/i },
  { id: "gang", re: /\bgangs?\b|\bgang[-\s]related\b/i },
  { id: "juvenile", re: /\b(?:juveniles?|minors?|child|children|teens?|teenagers?)\b/i },
  { id: "stranger", re: /\b(?:strangers?|acquaintances?)\b/i },
  { id: "self-defense", re: /\b(?:self[-\s]?defen[cs]e|justifiable|private\s+citizens?)\b/i },
  { id: "mass", re: /\bmass\s+(?:shootings?|killings?)\b/i },
  { id: "drug", re: /\b(?:drugs?[-\s]related|narcotics?)\b/i },
];

/** Officer-involved killings, expressible via the circumstance field. */
export const POLICE_SHOOTING_QUALIFIER: ShootingQualifier = {
  id: "police",
  clause: "i.circumstance = 'Felon Killed by Police'",
  titleLabel: "Police Fatal Shootings",
  narrativeLabel: "fatal police shootings",
  // SHR is well below independent tallies; presenting it bare would overstate
  // its completeness for exactly the users most likely to ask.
  caveat:
    "SHR counts officer-involved killings only where the reporting agency recorded the circumstance as 'Felon Killed by Police', so these counts are substantially lower than independent tallies such as the Washington Post or Mapping Police Violence databases.",
};

/**
 * Classify a shooting question's qualifier.
 *
 * Returns:
 *   - { kind: "none" }                 plain fatal-shooting question, proceed
 *   - { kind: "supported", qualifier } add the predicate and adjust labels
 *   - { kind: "unsupported", ids }     DECLINE; let the model handle it
 */
export function classifyShootingQualifier(
  question: string
): { kind: "none" } | { kind: "supported"; qualifier: ShootingQualifier } | { kind: "unsupported"; ids: string[] } {
  if (POLICE_RE.test(question)) {
    return { kind: "supported", qualifier: POLICE_SHOOTING_QUALIFIER };
  }
  const ids = UNSUPPORTED_QUALIFIER_RES.filter(({ re }) => re.test(question)).map(({ id }) => id);
  if (ids.length > 0) return { kind: "unsupported", ids };
  return { kind: "none" };
}
