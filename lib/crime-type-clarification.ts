/**
 * Increment 3 — violent / property / both clarification (frozen Decision 9).
 *
 * A shared, pure policy core. Given a question, it decides whether the user said "crime"
 * broadly enough that answering would mean silently choosing a definition for them.
 *
 * WHY THIS EXISTS. `lib/claude.ts` rule 3b instructed the opposite: "DEFAULT TO BROAD
 * QUERIES OVER CLARIFICATION ... DO NOT ask what crime type or time period". The product
 * was doing exactly as told, and all seven Decision 9 expectations failed. Rule 3b is
 * corrected alongside this control; enforcement without that correction would produce a
 * bot arguing with its own instructions.
 *
 * Decision 9 is narrow, and the narrowness matters:
 *   - it applies to CRIME TYPE only, never to time period, place or anything else;
 *   - it applies only when the user's word for the subject is bare ("crime", "crimes");
 *   - a user who names an offence, a category, or says "all crime" has already chosen.
 *
 * Over-asking is a real cost — the review accepted one extra turn, not a habit of them.
 */

/**
 * Tabs exempt from the gate, and the reason — stated positively rather than inferred
 * from the absence of a frozen case.
 *
 * `hate_crime` fixes the crime category to hate crime by the choice of tab. A user there
 * has already narrowed the subject, so "crime" in that context is not the bare, unchosen
 * word Decision 9 is about, and asking violent/property/both would be a non-sequitur.
 * Every other tab carries the gate.
 */
export const CRIME_TYPE_GATE_EXEMPT_TABS = ["hate_crime"] as const;

export function tabExemptFromCrimeTypeGate(tab: string): boolean {
  return (CRIME_TYPE_GATE_EXEMPT_TABS as readonly string[]).includes(tab);
}

export type CrimeTypeScope = "violent" | "property" | "both" | "specific" | "unspecified";

export interface CrimeTypeDecision {
  scope: CrimeTypeScope;
  /** True only when the product must ask before answering. */
  needsClarification: boolean;
  /** The question to ask. Empty unless needsClarification. */
  clarificationQuestion: string;
  reason: string;
}

export const CRIME_TYPE_CLARIFICATION_QUESTION =
  "Did you mean violent crime, property crime, or both?";

/** A bare reference to crime with no qualifier: "crime in Baltimore", "crime trends". */
const BARE_CRIME = /\bcrimes?\b/i;

/** The user already chose a category. */
const EXPLICIT_CATEGORY: { pattern: RegExp; scope: CrimeTypeScope }[] = [
  { pattern: /\bviolent (?:crimes?|offen[cs]es?)\b/i, scope: "violent" },
  { pattern: /\bproperty (?:crimes?|offen[cs]es?)\b/i, scope: "property" },
  { pattern: /\bviolent and property\b/i, scope: "both" },
  { pattern: /\bproperty and violent\b/i, scope: "both" },
  { pattern: /\b(?:both|all|total|overall) (?:types? of )?crimes?\b/i, scope: "both" },
  { pattern: /\ball (?:part\s*(?:i|1)|index) (?:crimes?|offen[cs]es?)\b/i, scope: "both" },
];

/**
 * A specific offence or measure. Naming one is a choice, so no clarification is due.
 * Kept deliberately broad: the cost of missing one is an unnecessary question.
 */
const SPECIFIC_SUBJECT = [
  /\bmurders?\b/i, /\bhomicides?\b/i, /\bkillings?\b/i,
  /\brapes?\b/i, /\bsexual assaults?\b/i,
  /\brobber(?:y|ies)\b/i, /\bassaults?\b/i, /\baggravated assaults?\b/i,
  /\bburglar(?:y|ies)\b/i, /\bthefts?\b/i, /\blarcen(?:y|ies)\b/i,
  /\bshoplifting\b/i, /\bmotor vehicle thefts?\b/i, /\bcar thefts?\b/i, /\bauto thefts?\b/i,
  /\bcarjackings?\b/i, /\barsons?\b/i, /\bshootings?\b/i, /\bfirearms?\b/i, /\bguns?\b/i,
  /\bdomestic (?:violence|abuse)\b/i, /\bhate crimes?\b/i, /\bdrug\b/i, /\bDUI\b/i,
  /\bstaffing\b/i, /\bofficers?\b/i, /\bemployment\b/i, /\bpopulation\b/i,
  // The stem, not the noun. GC-003 asks about offenses "cleared"; the list exempted only
  // "clearance", so the same measure counted as chosen or unchosen depending on which form of
  // the word the reader used. This is the vocabulary `lib/clearance-referent.ts` already treats
  // as a named police measure.
  /\bclear(?:ed|ance|ances)\b/i, /\barrests?\b/i, /\bvictims?\b/i, /\boffenders?\b/i,
];

/**
 * Contexts where "crime" is not the subject being measured, so no clarification is due:
 * a question about the data itself, or about an agency's coverage.
 */
const NOT_A_MEASUREMENT_SUBJECT = [
  /\bwhat (?:data|datasets?|tables?|sources?)\b/i,
  /\bwhich agencies\b/i,
  /\bcrime data (?:explorer|available|coverage)\b/i,
  /\bhow (?:far back|many years)\b/i,
];

/**
 * The crime TYPE is what the user is asking for, or they have already asked for a
 * breakdown by type. Either way the question answers itself and must not be interrupted.
 *
 * Both patterns come from frozen cases that expect a direct answer:
 *   GC-075 "What is the most prevalent crime in Lewis County, Missouri?"  — the type IS
 *          the answer, so asking which type to use would be absurd.
 *   GC-076 "total crime last 10 years broken down by vilont vs nonvilont" — the user
 *          asked for the split. Note the typos: this is matched on the BREAKDOWN phrasing
 *          rather than on the category words, so a misspelling cannot trigger a needless
 *          question.
 */
const TYPE_IS_THE_ANSWER = [
  /\b(?:most|least)\s+(?:prevalent|common|frequent|reported)\s+(?:crimes?|offen[cs]es?)\b/i,
  /\b(?:what|which)\s+(?:kinds?|types?|categor(?:y|ies))\s+of\s+(?:crimes?|offen[cs]es?)\b/i,
  // "what crime type ...", "which offense category ...". The list already exempted
  // `which crimes?`, which carried "which crime type" for free; "what crime type" — GC-003's
  // own wording — fell through to the bare-crime rule and was asked to choose a crime type it
  // had just asked the product to name. The determiner is not what makes a question ambiguous.
  /\b(?:what|which)\s+(?:crime|offen[cs]e)\s+(?:type|categor(?:y|ies)|kinds?)\b/i,
  /\bwhich\s+crimes?\b/i,
  /\bcrimes?\s+by\s+type\b/i,
  /\bbroken\s+down\s+by\b/i,
  /\bbreakdown\s+(?:of|by)\b/i,
  /\bby\s+(?:crime\s+)?(?:type|category|offen[cs]e)\b/i,
  /\bvs\.?\s|\bversus\b/i,
];

const any = (patterns: RegExp[], q: string) => patterns.some(p => p.test(q));

/**
 * Decide whether a bare "crime" question must be clarified before it is answered.
 *
 * This asks about crime TYPE only. It never asks about time period — Decision 9 does not
 * cover that, and the corrected rule 3b still tells the model to choose a sensible span.
 */
export function classifyCrimeTypeScope(question: string): CrimeTypeDecision {
  const q = question ?? "";

  for (const { pattern, scope } of EXPLICIT_CATEGORY) {
    if (pattern.test(q)) {
      return { scope, needsClarification: false, clarificationQuestion: "", reason: "the user named a category" };
    }
  }
  if (any(SPECIFIC_SUBJECT, q)) {
    return { scope: "specific", needsClarification: false, clarificationQuestion: "", reason: "the user named a specific offence or measure" };
  }
  if (any(NOT_A_MEASUREMENT_SUBJECT, q)) {
    return { scope: "unspecified", needsClarification: false, clarificationQuestion: "", reason: "the question is about the data, not a crime measure" };
  }
  if (any(TYPE_IS_THE_ANSWER, q)) {
    return { scope: "both", needsClarification: false, clarificationQuestion: "", reason: "the crime type is what the user asked for, or they asked for a breakdown by type" };
  }
  if (BARE_CRIME.test(q)) {
    return {
      scope: "unspecified",
      needsClarification: true,
      clarificationQuestion: CRIME_TYPE_CLARIFICATION_QUESTION,
      reason: "the subject is a bare reference to crime, so answering would choose a definition for the user",
    };
  }
  return { scope: "unspecified", needsClarification: false, clarificationQuestion: "", reason: "no bare crime reference" };
}

/**
 * A follow-up that answers the clarification, so the gate must not fire twice.
 * "violent", "property", "both" on their own are answers to the question we just asked.
 */
export function answersCrimeTypeClarification(question: string): boolean {
  return /^\s*(violent|property|both|violent crime|property crime|both please|all of (?:it|them))\b/i.test(question ?? "");
}

/**
 * Whether the clarification was already asked in this conversation. Decision 9 requires
 * one question, not a loop: if we already asked, we proceed with whatever we were told.
 */
export function clarificationAlreadyAsked(history: { role: string; content: string }[] | undefined): boolean {
  if (!Array.isArray(history)) return false;
  return history.some(h => h?.role === "assistant" && typeof h.content === "string"
    && /violent crime, property crime, or both/i.test(h.content));
}

/** The full gate, including conversation state. */
export function shouldAskCrimeType(
  question: string,
  history?: { role: string; content: string }[],
): CrimeTypeDecision {
  const decision = classifyCrimeTypeScope(question);
  if (!decision.needsClarification) return decision;
  if (answersCrimeTypeClarification(question) || clarificationAlreadyAsked(history)) {
    return { ...decision, needsClarification: false, clarificationQuestion: "", reason: "the clarification was already asked or answered" };
  }
  return decision;
}
