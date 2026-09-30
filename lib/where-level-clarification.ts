/**
 * GC-003: "what crime type and WHERE had the highest share of offenses cleared because of prosecution
 * being declined in 2025?" -- "where" asks for places without saying which kind (Codex closeout
 * direction; approved with the combined scope).
 *
 * The rows can be states, cities or individual agencies, and each is a different ranking with a
 * different winner. Choosing one silently is the same unasked-identity error S1 exists to stop, so a
 * "where" that names no level is asked about, in owned wording. It is a policy, not a default: no level
 * is invented to make the frozen question answerable.
 *
 * THE LEVEL IS EXPLICIT when the request (or the route's reconstruction of it from valid carried
 * context) names a kind of place, asks to rank by one, or names the places themselves (a named city
 * or state sets the level, so "where was murder highest, Chicago or Houston?" is not asked about).
 *
 * A PENDING CHOICE STAYS PENDING UNTIL IT IS ANSWERED (Codex combined review, CL2). Having asked is not
 * having been answered: the same ambiguous request is asked again, however often it arrives. The choice
 * is resolved only by a reply that IS, as a whole, an affirmative choice of one level ("states", "by
 * city", "individual agencies"; Codex correction ruling CR-2), and that reply is carried into the
 * original request by the established pending-choice path in `lib/followup-transform.ts` (as the
 * county-scope answer is), so the level reaches the plan. A non-answer ("Not by state", "I don't know")
 * asks again (`pendingWhereLevelReask`). A self-contained new request supersedes the pending one and is
 * judged on its own words.
 *
 * GC-049's binding is a different limitation (a named agency with no bound identity) and is not
 * decided here.
 */
import { buildQueryContract, type QueryContract } from "./query-contract";
import { asksWhere, asksForPlaces } from "./level-ranking-eligibility";
import { requestedScope } from "./structural-semantics";

export const WHERE_LEVEL_CLARIFICATION_ID = "where-level-unstated";

/** The phrase that identifies this clarification in history; part of the question below. */
export const WHERE_LEVEL_SIGNATURE = "by state, by city, or by individual police agency";

export const WHERE_LEVEL_CLARIFICATION_QUESTION =
  `Where do you want that ranked — ${WHERE_LEVEL_SIGNATURE}? ` +
  "Each gives a different answer, so I'd rather ask than pick one for you.";

/** The evaluation disposition, stated so a clarification is never scored as the numerical answer. */
export const WHERE_LEVEL_DISPOSITION =
  "clarification: the level was not named, so this turn asks for it and delivers no figure; " +
  "an answer-required expectation for the same turn is not met by it";

const RANKING = /\b(?:highest|lowest|most|fewest|least|greatest|largest|biggest|smallest|worst|best|top|bottom)\b/i;

export type WhereLevel = "state" | "city" | "agency";

/**
 * A reply that answers the level question: the WHOLE reply must be an affirmative choice of one level
 * (Codex correction ruling, CR-2). Recognising a level word anywhere read "Not by state" as choosing
 * states. Now the reply must be, in its entirety, an optional lead-in ("by", "rank it by", "I'd like",
 * "go with"), one level, and an optional courtesy ("please", "only", "thanks"). Anything else -- a
 * negation, "I don't know", two levels, a new question -- is not an answer.
 */
const LEVEL_NOUN: { level: WhereLevel; pattern: string }[] = [
  { level: "state", pattern: "states?|state[-\\s]?level" },
  { level: "city", pattern: "cit(?:y|ies)|city[-\\s]?level" },
  { level: "agency", pattern: "(?:individual\\s+)?(?:police\\s+)?(?:agenc(?:y|ies)|departments?)" },
];
const LEAD = "(?:(?:please\\s+)?(?:rank(?:ed)?|show|list|use|go\\s+with|do|make\\s+it|i\\s+want|i'?d\\s+like|i\\s+would\\s+like|let'?s\\s+(?:go|do))\\s+)?(?:(?:it|them|that)\\s+)?(?:by\\s+|at\\s+the\\s+|per\\s+)?(?:the\\s+)?(?:individual\\s+)?";
const TRAIL = "(?:\\s+(?:level|only))?(?:\\s*,?\\s*(?:please|thanks|thank\\s+you))?\\s*[.!]?";

export function whereLevelReply(question: string): WhereLevel | null {
  const text = (question ?? "").trim();
  for (const { level, pattern } of LEVEL_NOUN) {
    if (new RegExp(`^${LEAD}(?:${pattern})${TRAIL}$`, "i").test(text)) return level;
  }
  return null;
}

/**
 * Is this turn a self-contained new request rather than a reply to the pending question? It names a
 * year, an offense or measure, or asks its own question -- enough to be judged on its own words.
 */
function selfContainedRequest(question: string, contract: QueryContract | null): boolean {
  const text = (question ?? "").trim();
  return /\b(?:19|20)\d\d\b/.test(text)
    || (contract !== null && (contract.metric.topic !== "unknown" || contract.metric.offenseCodes.length > 0))
    || /^(?:which|what|how|where|who|when|show|list|rank|compare)\b/i.test(text);
}

/**
 * A turn that neither chooses a level nor makes a new request ("Not by state", "I don't know"). The one
 * rule both the re-ask and the reply's walk-back use (Codex admission review, AR-1): a re-ask after a
 * non-answer still belongs to the pending request, but a clarification that follows a NEW request
 * belongs to that new request.
 */
export function isLevelNonAnswer(text: string): boolean {
  return whereLevelReply(text) === null && !selfContainedRequest(text, buildQueryContract(text, "nibrs"));
}

/**
 * While the question is PENDING, a turn that neither chooses a level nor makes a new request ("Not by
 * state", "I don't know", "hmm") leaves the original request waiting: the question is asked again, in
 * owned wording, rather than the turn going to a path that may guess or fail.
 */
export function pendingWhereLevelReask(opts: {
  question: string;
  contract: QueryContract | null;
  history: { role: string; content: string }[] | undefined;
}): { id: string; explanation: string; disposition: string } | null {
  if (!pendingWhereLevel(opts.history)) return null;
  if (whereLevelReply(opts.question) !== null) return null;             // answered: resolved by the follow-up path
  if (selfContainedRequest(opts.question, opts.contract)) return null;  // superseded: judged on its own words
  return {
    id: WHERE_LEVEL_CLARIFICATION_ID,
    explanation: `I still need to know which level you mean before I can build that. ${WHERE_LEVEL_CLARIFICATION_QUESTION}`,
    disposition: WHERE_LEVEL_DISPOSITION,
  };
}

/** Is the most recent assistant turn this clarification, still waiting for its answer? */
export function pendingWhereLevel(history: { role: string; content: string }[] | undefined): boolean {
  if (!Array.isArray(history)) return false;
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h?.role !== "assistant") continue;
    return typeof h.content === "string" && h.content.includes(WHERE_LEVEL_SIGNATURE);
  }
  return false;
}

export function whereLevelClarification(opts: {
  /** The request as the route reconstructs it (a follow-up carries its context in). */
  question: string;
  contract: QueryContract | null;
}): { id: string; explanation: string; disposition: string } | null {
  const { question, contract } = opts;
  if (!contract || !asksWhere(question)) return null;
  // Only a ranking of places has a level to choose; "where can I find the data?" asks nothing of the kind.
  if (!RANKING.test(question)) return null;
  // Named kind of place ("which states", "cities with", "by agency"): the level is explicit. `asksForPlaces`
  // is true for a bare "where" too, so the place-noun half is what is tested here.
  if (asksForPlaces(question.replace(/\bwhere\b/gi, " "))) return null;
  const level = requestedScope(question, contract).rowLevel;
  if (level === "state" || level === "city" || level === "agency" || level === "county") return null;
  return { id: WHERE_LEVEL_CLARIFICATION_ID, explanation: WHERE_LEVEL_CLARIFICATION_QUESTION, disposition: WHERE_LEVEL_DISPOSITION };
}
