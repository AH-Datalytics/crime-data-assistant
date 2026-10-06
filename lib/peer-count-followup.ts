import { buildQueryContract } from "./query-contract";
import { asksComparableAgencyClearance } from "./nibrs-deterministic-queries";
import type { HistoryTurn } from "./clearance-refinement-followup";
import { STATE_NAME_TO_ABBR } from "./state-population";

/**
 * AGENCY+RANK batch (GC-116): "Add San Francisco PD to the table and increase to 8 comparable agencies."
 *
 * The turn changes only how many population peers the previous comparison uses. On its own it names no
 * offense or clearance measure, so the owned peer plan never recognized it and the planner declined it
 * for lack of population evidence. This carries the IMMEDIATELY PRECEDING request forward with the new
 * count and nothing else changed: same subject, offense, measure and period, peers still chosen on
 * population alone. The subject is always in the owned table, so "add <subject> to the table" is
 * satisfied by that plan rather than by a separate member.
 *
 * AGENCY+RANK correction F1 (Codex :36392): the turn is RECOGNIZED POSITIVELY as a count-only amendment,
 * not merely found to contain a count. The whole turn must be one of these forms and nothing else:
 *   <count clause>
 *   add <subject> [back] [to the table | to the comparison | too | as well][,] and <count clause>
 *   <count clause>[,] and add <subject> [back] [to the table | to the comparison | too | as well]
 * where <count clause> is "[please] [increase|change|expand|raise|bump|go] [it|that|this|the table] [up] to
 * N comparable agencies [instead]" (or "use|show N comparable agencies"). Any other wording -- an eligibility
 * condition ("only agencies that reported all 12 months"), a membership change ("exclude the original agency"),
 * another measure ("counts instead"), a period or offense -- is not a count-only amendment, so the turn is left
 * exactly as written for the existing handling (which declines it). <subject> must be the prior request's
 * subject by identity: the same place name with the department words removed, and the same state when the turn
 * states or implies one. "San Francisco, TX" is not San Francisco Police Department, CA.
 */
export interface PeerCountFollowup {
  peerCount: number;
  priorQuestion: string;
  refinedQuestion: string;
}

const PEER_WORDS = String.raw`(?:most\s+)?(?:similar(?:[-\s]+siz(?:e|ed)|ly[-\s]+sized)?|comparable|peer)\s+(?:agencies|departments|cities)`;
const COUNT_PATTERNS = [
  new RegExp(String.raw`\b(\d{1,2})(\s+agencies\s+of\s+(?:similar|comparable)\s+size)\b`, "i"),
  new RegExp(String.raw`\b(\d{1,2})(\s+(?:other\s+|more\s+)?${PEER_WORDS})\b`, "i"),
];

const COUNT_CLAUSE = String.raw`(?:please\s+)?(?:(?:increase|change|expand|raise|bump|go)\s+(?:it\s+|that\s+|this\s+|the\s+(?:table|comparison|list)\s+)?(?:up\s+)?to\s+|(?:use|show)\s+)(\d{1,2})\s+(?:${PEER_WORDS}|agencies\s+of\s+(?:similar|comparable)\s+size)(?:\s+instead)?`;
const ADD_TAIL = String.raw`(?:\s+back)?(?:\s+(?:to\s+(?:the\s+)?(?:table|comparison|list)|too|as\s+well))?`;
const FORMS: { re: RegExp; count: number; subject: number | null }[] = [
  { re: new RegExp(String.raw`^${COUNT_CLAUSE}$`, "i"), count: 1, subject: null },
  { re: new RegExp(String.raw`^add\s+(.+?)${ADD_TAIL}\s*,?\s+and\s+${COUNT_CLAUSE}$`, "i"), count: 2, subject: 1 },
  { re: new RegExp(String.raw`^${COUNT_CLAUSE}\s*,?\s+and\s+add\s+(.+?)${ADD_TAIL}$`, "i"), count: 1, subject: 2 },
];

const placeKey = (name: string) => name.toLowerCase()
  .replace(/,.*$/, "")
  .replace(/\b(?:police\s+department|police\s+dept\.?|police|pd|department|dept)\b/g, "")
  .replace(/[^a-z ]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

/** The turn as one of the count-only forms, or null. */
function countOnlyAmendment(question: string): { count: number; subject: string | null } | null {
  const turn = question.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();
  for (const form of FORMS) {
    const m = form.re.exec(turn);
    if (!m) continue;
    const count = Number(m[form.count]);
    if (!(count >= 1 && count <= 20)) return null;
    return { count, subject: form.subject === null ? null : m[form.subject].trim() };
  }
  return null;
}

/** The state written after a comma ("San Francisco, TX" / "San Francisco, Texas"); undefined when none, null when unreadable. */
function statedState(subject: string): string | null | undefined {
  const suffix = /,\s*(.+)$/.exec(subject)?.[1]?.trim().replace(/\.$/, "");
  if (!suffix) return undefined;
  if (/^[A-Za-z]{2}$/.test(suffix)) return suffix.toUpperCase();
  const name = Object.keys(STATE_NAME_TO_ABBR).find((n) => n.toLowerCase() === suffix.toLowerCase());
  return name ? STATE_NAME_TO_ABBR[name] : null;
}

/**
 * True only when `subject` names the prior request's subject: the same place name (department words removed) and,
 * when the turn writes a state, that same state. The state is read from the turn's own text: the query contract
 * resolves a well-known city name to its usual state and so cannot establish what the reader wrote.
 */
function isPriorSubject(subject: string, priorQuestion: string): boolean {
  const prior = buildQueryContract(priorQuestion, "nibrs")?.geography;
  if (!prior?.name || prior.kind === "unknown") return false;
  if (!placeKey(subject) || placeKey(subject) !== placeKey(prior.name)) return false;
  const state = statedState(subject);
  if (state === undefined) return true;
  return state !== null && Boolean(prior.state) && state === String(prior.state).toUpperCase();
}

export function resolvePeerCountFollowup(
  question: string,
  history: HistoryTurn[] | undefined,
  source: string,
): PeerCountFollowup | null {
  if (source !== "nibrs" || !Array.isArray(history)) return null;
  const amendment = countOnlyAmendment(question);
  if (!amendment) return null;

  const userTurns = history.filter((turn) => turn?.role === "user" && typeof turn.content === "string");
  const prior = userTurns[userTurns.length - 1];
  if (!prior || (prior.source && prior.source !== source)) return null;
  const priorQuestion = prior.content;
  if (!asksComparableAgencyClearance(priorQuestion)) return null;
  if (amendment.subject !== null && !isPriorSubject(amendment.subject, priorQuestion)) return null;

  const replaceable = COUNT_PATTERNS.find((pattern) => pattern.test(priorQuestion));
  if (!replaceable) return null;
  const refinedQuestion = priorQuestion.replace(replaceable, (_whole, _count: string, rest: string) => `${amendment.count}${rest}`);
  return { peerCount: amendment.count, priorQuestion, refinedQuestion };
}
