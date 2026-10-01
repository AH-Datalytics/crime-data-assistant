import { buildQueryContract } from "./query-contract";

/**
 * Cause C/D — an explicit police-clearance refinement, and only that.
 *
 * WHAT IT IS FOR. GC-004: "Which states have the highest share of rapes cleared by exception in
 * 2025?" and then "Now what about just the share that's prosecution declined". The second turn
 * names a different clearance reason for the same request, and nothing else. Read on its own it
 * establishes no offense, no place and no period, so the contract built from it reads
 * `topic: unknown`, `unit: ratio`, and a statement that plainly computes a share was refused
 * twice on `structural-measure-unit-unmodeled` and delivered the generic failure template.
 *
 * WHY THIS AND NOT A GENERAL PREVIOUS-TURN PREFIX. I proposed one; it does not survive contact
 * with the same conversation. With GC-004's setup as the prior turn, a rule that fires on
 * "the contract has no topic" also accepts:
 *
 *   "now for 2024"                    -> concatenation makes the period 2024 THROUGH 2025
 *   "How many agencies reported in 2024?" -> an agency count acquires the rape-clearance metric
 *   "What is the population of Chicago?"  -> a population question acquires rape clearances, 2025
 *
 * An unknown topic means the parser did not recognize one. It does not mean the reader asked to
 * inherit anything. So this recognizes the refinement POSITIVELY — the turn must name a clearance
 * reason and settle nothing else — and composes by SUBSTITUTION rather than concatenation, which
 * is what keeps "2024" from becoming "2024 through 2025".
 *
 * WHAT IT INHERITS. The applicable prior user request's offense, geography and period, carried by
 * reusing that request's own words with its clearance reason replaced. Nothing else: not a
 * threshold, not a limit, and nothing from the assistant's answer. An earlier answer that mentions
 * a cutoff is model prose, never permission — see `lib/nibrs-clearance-ranking-request.ts`, which
 * ships with this and refuses the invented cutoff the saved statement carries.
 *
 * SCOPE. NIBRS, one step back, and only when this turn settles nothing of its own. A turn that
 * names its own year, place, offense or measure is a new request and is left exactly as written.
 */

export type ClearanceReasonId =
  | "prosecution-declined"
  | "death-of-offender"
  | "victim-refused"
  | "other-jurisdiction"
  | "juvenile-no-custody"
  | "cleared-by-arrest";

export interface ClearanceRefinement {
  reason: ClearanceReasonId;
  /** The wording written into the refined request. */
  reasonPhrase: string;
  /** The prior user request this refines, exactly as the reader wrote it. */
  priorQuestion: string;
  /** That request with its clearance reason replaced by the newly asked one. */
  refinedQuestion: string;
}

export interface HistoryTurn {
  role: string;
  content: string;
  /** The tab the turn belongs to, when the caller carries it. Absent means "same tab". */
  source?: string;
}

/**
 * The five NIBRS exceptional-clearance reasons plus clearance by arrest, in the wording the
 * product's own NIBRS prompt uses for `cleared_A`…`cleared_E`.
 */
const CLEARANCE_REASONS: Array<{ id: ClearanceReasonId; asked: RegExp; phrase: string }> = [
  { id: "prosecution-declined",
    asked: /\bprosecutions?\s+(?:was\s+|were\s+)?declin\w*|\bdeclined\s+(?:to\s+)?prosecut\w*|\bdeclination(?:s)?\b|\bprosecution\s+declined\b/i,
    phrase: "cleared because prosecution was declined" },
  { id: "death-of-offender",
    asked: /\bdeath of (?:the )?offender\b|\boffender (?:has )?died\b/i,
    phrase: "cleared because the offender died" },
  { id: "victim-refused",
    asked: /\bvictim refused to cooperate\b|\bvictim(?:s)? (?:would not|wouldn't|did not|didn't) cooperate\b/i,
    phrase: "cleared because the victim refused to cooperate" },
  { id: "other-jurisdiction",
    asked: /\bin custody of (?:an ?|the )?other jurisdiction\b|\bextradition (?:was )?denied\b/i,
    phrase: "cleared because the offender was in the custody of another jurisdiction" },
  { id: "juvenile-no-custody",
    asked: /\bjuvenile\s*\/?\s*no custody\b|\bjuvenile,? no custody\b/i,
    phrase: "cleared as a juvenile with no custody taken" },
  { id: "cleared-by-arrest",
    asked: /\bcleared by arrest\b|\bclearances? by arrest\b/i,
    phrase: "cleared by arrest" },
];

/**
 * The clearance wording in the PRIOR request that the new reason replaces.
 *
 * BOUNDED ON PURPOSE (Codex review CD1). The first version carried
 * `/\bcleared\s+because\s+[^,.?!]+/` — greedy to the end of the sentence. Refining a request that
 * this module had itself composed, "…cleared because prosecution was declined in 2025?", it
 * swallowed "in 2025" along with the reason, and the replacement dropped the year: the contract's
 * period went from 2025 to null. So the replaceable set is the exact phrases this module writes,
 * plus the standard aggregate forms, and nothing open-ended. A prior request phrased some other
 * way has no replaceable span, the refinement declines, and the turn keeps its existing path —
 * which is the safe outcome, not a silent rewrite.
 *
 * Order matters: the longest, most specific form first, so "cleared by exceptional means" is not
 * half-replaced by the "cleared by exception" pattern.
 */
const PRIOR_REASON_PHRASES: RegExp[] = [
  ...CLEARANCE_REASONS.map((reason) => new RegExp(`\\b${reason.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")),
  /\bcleared\s+as\s+a\s+juvenile\s+with\s+no\s+custody\s+taken\b/i,
  /\bcleared\s+by\s+exceptional\s+means\b/i,
  /\bcleared\s+by\s+exception\b/i,
  /\bexceptionally\s+cleared\b/i,
];

/**
 * A measure the turn asks for that is NOT the prior request's.
 *
 * WHY (Codex review CD1). "Now what about the count of prosecutions declined?" has
 * `topic: unknown` — but only because the parser does not recognize that phrase, and an
 * unrecognized contract is not an absent measure. Read as "settles nothing of its own", the turn
 * became the prior request's SHARE question and the explicit COUNT was lost. Naming a clearance
 * reason does not establish that everything else may be inherited.
 *
 * The supported shape is a refinement of the SAME measure. A turn that asks for a count, a total,
 * or a different denominator is asking for something else, and this module declines rather than
 * rewriting it.
 */
const COMPETING_MEASURE = /\b(?:counts?|numbers?|totals?|tallies|tally|how\s+many|per\s+capita|per\s+100[,.]?000|per\s+100k|rate\s+per)\b/i;

/** Which clearance reason this turn asks for, or null when it asks for none. */
function askedReason(question: string): { id: ClearanceReasonId; phrase: string } | null {
  const matches = CLEARANCE_REASONS.filter((reason) => reason.asked.test(question ?? ""));
  // Two reasons in one turn is a comparison, not a refinement, and this does not compose one.
  if (matches.length !== 1) return null;
  return { id: matches[0].id, phrase: matches[0].phrase };
}

/**
 * Whether this turn settles anything of its own.
 *
 * Read from the product's own contract rather than from a word list, so the three counterexamples
 * above are excluded by the same parser that would otherwise have been handed the wrong request:
 * "now for 2024" has a period, "What is the population of Chicago?" has a geography, and
 * "How many agencies reported in 2024?" has both a period and a topic of its own.
 */
function settlesNothingOfItsOwn(question: string, source: string): boolean {
  // Read BEFORE the contract, because the contract is exactly what cannot see this: a measure the
  // parser does not recognize arrives here as `topic: unknown`, which is silence about the
  // measure rather than evidence that the reader asked for none.
  if (COMPETING_MEASURE.test(question ?? "")) return false;
  const contract = buildQueryContract(question, source as Parameters<typeof buildQueryContract>[1]);
  if (!contract) return false;
  if (contract.metric.topic !== "unknown") return false;
  if (contract.metric.offenseCodes.length > 0) return false;
  if (contract.time.startYear !== null || contract.time.endYear !== null) return false;
  if (contract.geography.kind !== "unknown") return false;
  return true;
}

/**
 * The prior user request this turn refines, or null.
 *
 * ONE STEP BACK, never more. GC-070 is why: its conversation had already moved from a rolling
 * murder series to plain year ranges two turns before the scored turn, and reaching past the
 * immediately preceding request would have restored a measure the reader had left behind.
 */
function applicablePriorRequest(history: HistoryTurn[] | undefined, source: string): string | null {
  if (!Array.isArray(history)) return null;
  const userTurns = history.filter((turn) => turn?.role === "user" && typeof turn.content === "string");
  const prior = userTurns[userTurns.length - 1];
  if (!prior) return null;
  // A turn carried from another tab is not continuity, whatever it says.
  if (prior.source && prior.source !== source) return null;
  const contract = buildQueryContract(prior.content, source as Parameters<typeof buildQueryContract>[1]);
  if (!contract) return null;
  if (contract.metric.topic === "unknown") return null;
  // The prior request has to have been about clearance, or there is no reason to replace.
  if (contract.metric.unit !== "clearance_rate") return null;
  return prior.content;
}

/**
 * Recognize an explicit police-clearance refinement and compose the request it refines.
 *
 * Returns null — meaning "leave the turn exactly as the reader wrote it" — unless every condition
 * holds: the tab is NIBRS, the turn names exactly one clearance reason, the turn settles nothing
 * of its own, the immediately preceding user request on the same tab was a clearance request, and
 * that request contains a clearance phrase this reason can replace.
 */
export function resolveClearanceRefinement(
  question: string,
  history: HistoryTurn[] | undefined,
  source: string,
): ClearanceRefinement | null {
  if (source !== "nibrs") return null;
  const reason = askedReason(question);
  if (!reason) return null;
  if (!settlesNothingOfItsOwn(question, source)) return null;

  const priorQuestion = applicablePriorRequest(history, source);
  if (!priorQuestion) return null;

  const replaceable = PRIOR_REASON_PHRASES.find((pattern) => pattern.test(priorQuestion));
  // No phrase to replace means no safe composition. Guessing where the reason belongs in someone
  // else's sentence is how a refinement becomes a different question.
  if (!replaceable) return null;

  const refinedQuestion = priorQuestion.replace(replaceable, reason.phrase);
  if (refinedQuestion === priorQuestion) return null;
  return { reason: reason.id, reasonPhrase: reason.phrase, priorQuestion, refinedQuestion };
}
