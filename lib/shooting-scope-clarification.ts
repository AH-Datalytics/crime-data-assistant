/**
 * Cause B — fatal or nonfatal, asked before the answer (frozen Decision 14).
 *
 * A shared, pure policy core. Given a shootings question, it decides whether the request left
 * the fatal / nonfatal choice open, and carries the user's answer back onto the request they
 * originally asked.
 *
 * WHY THIS EXISTS. "shootings in Chicago since 2015" (GC-110) reached the SHR route's
 * deterministic fatal path, which answered with twelve years of firearm homicides and appended
 * "nonfatal shootings are not tracked in this database". Nothing had asked. Decision 14 requires
 * the ambiguity to be RESOLVED before answering rather than silently decided, and a note at the
 * end of an answer is not a resolution — the reader has already been given a number by then.
 *
 * WHAT IT DOES NOT DO, and each of these cost something to get wrong before:
 *   - it never infers "fatal" from the absence of a nonfatal word. That inference is the defect;
 *   - it never infers the scope from the tab. Choosing SHR is not choosing fatal;
 *   - it never infers the scope from the mere existence of history. The previous assistant turn
 *     must be THIS question, or nothing is inherited;
 *   - it decides nothing about qualifiers, geography or years. Those gates keep their own rules
 *     and their own order.
 *
 * THE AMBIGUITY TEST IS NOT NEW. `lib/query-guidance.ts` has classified this exact request as a
 * BLOCKING `shooting-scope` warning all along — "The FBI does not systemically track all
 * shootings" — and nothing in any route ever acted on it; it reached the query log and the plan
 * metadata and stopped there. This module reuses that rule rather than writing a second one, so
 * the two cannot drift apart.
 */

import { getQueryGuidanceWarnings } from "./query-guidance";

/** `stated` means the request settled it — either way. `unspecified` is the one that asks. */
export type ShootingScope = "stated" | "unspecified" | "not_applicable";

export interface ShootingScopeDecision {
  scope: ShootingScope;
  /** True only when the product must ask before answering. */
  needsClarification: boolean;
  /** The question to ask. Empty unless needsClarification. */
  clarificationQuestion: string;
  reason: string;
}

/**
 * The question itself.
 *
 * It offers no nonfatal count, because there is none: answering "nonfatal" reaches the existing
 * capability limitation in `lib/refusal-safety.ts`, which explains what the product does and does
 * not hold. Decision 14 is explicit that a nearest measure may be offered only where one genuinely
 * exists, so this asks which of the two the reader meant and promises nothing about either.
 */
export const SHOOTING_SCOPE_CLARIFICATION_QUESTION =
  "\"Shootings\" can mean two different things here, and they come from different records. "
  + "Do you mean fatal shootings — firearm homicides, which the Supplementary Homicide Reports "
  + "hold — or nonfatal shootings, where the person was shot and survived? "
  + "Say fatal or nonfatal and I will take it from there.";

/**
 * The wording that makes a question a shootings question, and the wording that states it is
 * about survivors.
 *
 * These two literals were inline in `app/api/shr-query/route.ts`. They are here so that the gate
 * that ASKS and the branch that ANSWERS read the same definition; a second copy in the route is
 * how the two would come to disagree about what counts as a nonfatal request.
 */
export const ASKS_SHOOTING_WORDING = /\b(shootings?|shot\b|gunshot|people\s+shot|gun\s+violence)\b/i;
export const STATES_NONFATAL = /\b(nonfatal|non-fatal|non fatal|shooting incidents?|people\s+shot|gunshot (wound|victim)|shot and (survived|wounded|injured))\b/i;

/** Does the existing guidance rule call this request ambiguous? */
function guidanceCallsItAmbiguous(question: string): boolean {
  return getQueryGuidanceWarnings(question ?? "")
    .some((warning) => warning.id === "shooting-scope" && warning.kind === "blocking");
}

/**
 * Decide whether a shootings question must be clarified before it is answered.
 *
 * The order is: not a shootings question at all → nothing to ask; the request states its scope
 * → nothing to ask; otherwise the existing guidance rule decides.
 */
export function classifyShootingScope(question: string): ShootingScopeDecision {
  const q = question ?? "";
  if (!ASKS_SHOOTING_WORDING.test(q)) {
    return { scope: "not_applicable", needsClarification: false, clarificationQuestion: "", reason: "not a shootings question" };
  }
  if (STATES_NONFATAL.test(q)) {
    return { scope: "stated", needsClarification: false, clarificationQuestion: "", reason: "the request states that it is about survivors" };
  }
  if (!guidanceCallsItAmbiguous(q)) {
    return { scope: "stated", needsClarification: false, clarificationQuestion: "", reason: "the request states its scope" };
  }
  return {
    scope: "unspecified",
    needsClarification: true,
    clarificationQuestion: SHOOTING_SCOPE_CLARIFICATION_QUESTION,
    reason: "the request leaves fatal and nonfatal open, and answering would choose one for the user",
  };
}

/** A turn that answers the question — and only that. "What about Houston" is a new request. */
export function answersShootingScopeClarification(question: string): "fatal" | "nonfatal" | null {
  const q = (question ?? "").trim();
  if (/^(?:the\s+)?non[-\s]?fatal(?:\s+(?:ones?|shootings?|please))?\s*[.!]?$/i.test(q)) return "nonfatal";
  if (/^(?:the\s+)?fatal(?:\s+(?:ones?|shootings?|please))?\s*[.!]?$/i.test(q)) return "fatal";
  return null;
}

/**
 * Whether the assistant's LAST turn was this question.
 *
 * Deliberately the last turn rather than anywhere in the conversation: "fatal" three turns after
 * the question is not an answer to it, and treating it as one would attach the word to whatever
 * request happened to be in flight.
 */
export function shootingScopeClarificationAlreadyAsked(
  history: { role: string; content: string }[] | undefined,
): boolean {
  if (!Array.isArray(history)) return false;
  const assistantTurns = history.filter((turn) => turn?.role === "assistant");
  const last = assistantTurns[assistantTurns.length - 1];
  return typeof last?.content === "string" && last.content.includes("Say fatal or nonfatal");
}

/**
 * The full gate.
 *
 * ONLY AN EXPLICIT CHOICE RESOLVES THIS. The first version of this function treated "we already
 * asked" as though it were "they already answered": once the question had been put, an unanswered
 * or rephrased ambiguous request fell straight through to the deterministic fatal path and got a
 * number. Repeating "shootings in Chicago since 2015" after the question, or asking the same thing
 * about Houston, both silently selected fatal counts (Codex review B1, with witnesses in
 * `audit/phase3-cause-b-2026-09-25/codex-review/scope-witness.json`). That is the defect this
 * module exists to prevent, arriving one turn later than where I was looking for it.
 *
 * So history no longer resolves anything. It is read for one purpose only: to say in the `reason`
 * that the choice is still pending, so a log can tell a first question from a reminder. The choice
 * is made by the REQUEST — either because the reader stated it, or because
 * `resolveShootingScopeFollowup` carried their explicit answer onto the request they asked about.
 *
 * Asking again is not a loop. It is the honest state: nobody has chosen yet, and choosing for them
 * is what Decision 14 forbids.
 */
export function shouldAskShootingScope(
  question: string,
  history?: { role: string; content: string }[],
): ShootingScopeDecision {
  const decision = classifyShootingScope(question);
  if (!decision.needsClarification) return decision;
  if (shootingScopeClarificationAlreadyAsked(history)) {
    return { ...decision, reason: "the choice is still pending, so the question stands rather than being decided" };
  }
  return decision;
}

export interface ShootingScopeFollowup {
  scope: "fatal" | "nonfatal";
  /** The request the question was asked about, exactly as the user wrote it. */
  carriedQuestion: string;
  /** That request with the chosen scope in it, so the place and the years are not lost. */
  reconstructedQuestion: string;
}

/**
 * The user's answer, carried back onto the request they originally asked.
 *
 * Without this, "fatal" is a bare word: the SHR route would see no place, no years and no
 * subject, and the turn would become an unrelated request rather than the answer it is. Three
 * things must all hold, and none of them is "there is history":
 *
 *   1. the assistant's last turn was this question;
 *   2. this turn answers it;
 *   3. the user turn the question was asked about is a shootings question we can put the word into.
 *
 * If the third fails there is nothing to reconstruct, and guessing would be worse than declining.
 */
export function resolveShootingScopeFollowup(
  question: string,
  history: { role: string; content: string }[] | undefined,
): ShootingScopeFollowup | null {
  if (!shootingScopeClarificationAlreadyAsked(history)) return null;
  const scope = answersShootingScopeClarification(question);
  if (!scope) return null;

  const turns = Array.isArray(history) ? history : [];
  const askedAt = turns.map((turn) => turn?.role === "assistant"
    && typeof turn.content === "string" && turn.content.includes("Say fatal or nonfatal"))
    .lastIndexOf(true);
  if (askedAt < 0) return null;
  const carried = turns.slice(0, askedAt).reverse()
    .find((turn) => turn?.role === "user" && typeof turn.content === "string" && ASKS_SHOOTING_WORDING.test(turn.content));
  if (!carried) return null;

  const carriedQuestion = carried.content;
  const word = scope === "fatal" ? "fatal" : "nonfatal";
  // Put the word where the reader would have put it, and nowhere else: in front of the first
  // "shooting(s)". A question phrased some other way keeps its own words and gains a prefix.
  const reconstructedQuestion = /\bshootings?\b/i.test(carriedQuestion)
    ? carriedQuestion.replace(/\bshootings?\b/i, (match) => `${word} ${match}`)
    : `${word} ${carriedQuestion}`;
  return { scope, carriedQuestion, reconstructedQuestion };
}
