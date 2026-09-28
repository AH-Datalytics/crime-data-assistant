/**
 * Does this turn continue a multi-agency request the user has not moved off?
 *
 * THE GAP THIS CLOSES. The ownership restriction reads the plan resolved for THIS turn. "now do it
 * for 2024" names no place, so the resolver returns nothing, the restriction cannot fire, and the
 * model still answers from the conversation it can see — which is how a 36-city comparison that was
 * correctly refused came back one turn later with 35 agencies and no attribution (GC-073, logs
 * 918/919). The refusal carried no SQL, so the query-bearing follow-up detector does not see it
 * either, and the explicit year makes the contract read the fragment as standalone.
 *
 * WHAT THIS IS NOT. It is not "inherit the last multi-place question whenever geography is unknown".
 * A place-free question is not necessarily a continuation: after a multi-city request, "murders
 * nationwide in 2024" or "how does this data work" is a NEW request and must not inherit anything.
 * So this walks the CURRENT CHAIN backwards and stops at the first user turn that establishes a
 * scope of its own. If that scope is multi-agency the restriction is inherited; if it is a single
 * agency, a nationwide request or a different topic, nothing is inherited and the turn proceeds
 * exactly as it does today.
 *
 * It decides ONE thing: whether the existing pre-model restriction applies. It never rewrites SQL,
 * reuses a prior figure, changes a period, or certifies anything. Its only possible effect is a
 * refusal that already exists, reached one turn later than it should have been.
 *
 * Authority comes from the user's own messages in the bounded same-source history. An assistant
 * answer, its SQL, or any client-supplied plan is not authority: a previous answer is exactly what
 * this protection exists to avoid trusting. There is no stored plan and none is invented.
 */
import { buildQueryContract } from "./query-contract";
import { normalizeHistoryWithSource } from "./chat-history";
import type { SourceId } from "./source-contracts";

/**
 * A continuation that changes only WHEN, carrying the previous subject forward.
 *
 * Deliberately narrow and anchored to the start of the utterance. It must match "now do it for
 * 2024", "same for 2023", "what about 2022" -- and must not match a sentence that carries its own
 * subject, such as "murders nationwide in 2024", because that is a new request whose own scope the
 * resolver will read normally.
 */
const TEMPORAL_CONTINUATION = new RegExp(
  "^\\s*(?:and\\s+|but\\s+|ok(?:ay)?[,\\s]+|now[,\\s]+|then[,\\s]+)*" +
  "(?:(?:can\\s+you\\s+)?(?:do|show|run|give|repeat|redo)\\s+(?:me\\s+)?)?" +
  "(?:it|that|the\\s+same|same|this)?\\s*" +
  "(?:again\\s+)?(?:for|in|with|using)?\\s*" +
  "(?:the\\s+year\\s+)?(?:\\d{4})(?:\\s*(?:-|to|through|and)\\s*\\d{4})?\\s*\\??\\s*$",
  "i",
);
/** "what about 2024" / "how about 2024-2025" */
const WHAT_ABOUT_YEAR = /^\s*(?:and\s+|now\s+)?(?:what|how)\s+about\s+(?:the\s+year\s+)?\d{4}(?:\s*(?:-|to|through|and)\s*\d{4})?\s*\??\s*$/i;

/** Is this utterance only a change of period, carrying its subject from earlier? */
export function isTemporalContinuation(question: string): boolean {
  const q = String(question ?? "").trim();
  if (!q || q.length > 120) return false;           // a long sentence carries its own subject
  return TEMPORAL_CONTINUATION.test(q) || WHAT_ABOUT_YEAR.test(q);
}

/**
 * How many distinct places does this utterance ask about in its own right?
 *
 * Uses the existing contract interpretation rather than a second opinion about what a place is, so
 * this cannot drift from what the rest of the request pipeline believes. Pure: no database.
 */
function scopeOf(question: string, source: SourceId): { establishes: boolean; localMembers: number } {
  let contract;
  try { contract = buildQueryContract(question, source); }
  catch { return { establishes: false, localMembers: 0 }; }
  const geographies = Array.isArray(contract?.geographies) ? contract.geographies : [];
  const named = geographies.filter((g) => g && g.kind !== "unknown" && g.name);

  /*
   * ESTABLISHING A SCOPE AND REQUESTING AN AGENCY ARE DIFFERENT QUESTIONS, and an earlier version of
   * this file answered the second with the first. It counted every named geography, so "murders in
   * Baltimore in Maryland" read as two requested agencies -- one city plus one state -- and inherited
   * a multi-agency restriction onto what is a single-agency request. "Compare Texas and California"
   * was worse: two states, zero requested agencies, still inherited.
   *
   * The resolver's own filter is the authority here: `nibrs-place-resolver.ts:512` keeps only city,
   * agency and campus when it builds requested members. This mirrors that list rather than inventing
   * a second opinion about what counts as an agency.
   *
   * A state or national mention still ESTABLISHES scope -- it is a new request and must end an
   * inherited chain -- it simply is not itself a requested agency.
   */
  const LOCAL_MEMBER_KINDS = new Set(["city", "agency", "campus"]);
  const localMembers = named.filter((g) => LOCAL_MEMBER_KINDS.has(g.kind)).length;
  const kinds = new Set(geographies.map((g) => g?.kind).filter(Boolean));
  const establishesNonLocal = kinds.has("national") || kinds.has("state");
  return { establishes: named.length > 0 || establishesNonLocal, localMembers };
}

export type InheritedMultiAgencyRequest = {
  /** The user turn whose scope is still current, as the user wrote it. */
  request: string;
  /** How many distinct places that request named. */
  places: number;
  /** How many user turns back it sits, 1 being the immediately preceding one. */
  turnsBack: number;
};

/**
 * The still-current multi-agency request this turn continues, or null.
 *
 * Returns null -- meaning "behave exactly as before" -- whenever anything is unclear. This is a
 * refusal-only decision, but a wrong refusal is still a broken answer, so the bar for inheriting is
 * an unbroken chain back to a request the user has not replaced.
 */
export function inheritedMultiAgencyRequest(
  question: string,
  rawHistory: unknown,
  source: SourceId,
): InheritedMultiAgencyRequest | null {
  if (!isTemporalContinuation(question)) return null;
  // If this turn names its own scope it is not inheriting one, whatever its shape.
  if (scopeOf(question, source).establishes) return null;

  /*
   * THE SOURCE BOUNDARY HAS TO SURVIVE FILTERING.
   *
   * The route hands the model `normalizeHistoryForTab(history, "nibrs")`, which DELETES other-source
   * turns. Feed that to this decision and an intervening question about a different database becomes
   * invisible: the older NIBRS turns sit adjacent and the chain silently reconnects across a gap the
   * user actually made. So this reads the source-tagged view instead, under the same bound.
   *
   * Untagged legacy entries carry no source and are treated as same-source, which preserves the
   * existing behaviour for older clients rather than making them refuse.
   */
  const history = normalizeHistoryWithSource(rawHistory);
  if (history.length === 0) return null;

  let turnsBack = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const turn = history[i];
    if (turn.role !== "user" || typeof turn.content !== "string") continue;
    // A tagged turn about another source ends the chain: the conversation moved, and whatever was
    // asked before it is no longer what this follow-up continues.
    if (turn.source && turn.source !== source) return null;
    const content = turn.content.trim();
    if (!content) continue;
    turnsBack += 1;
    // Another bare temporal continuation: the chain continues through it unchanged.
    if (isTemporalContinuation(content)) continue;
    const scope = scopeOf(content, source);
    // The first turn that establishes a scope decides it. Two or more REQUESTED LOCAL MEMBERS
    // inherit; anything else -- one agency, a state, nationwide, a new topic -- stops the chain.
    if (!scope.establishes) return null;
    return scope.localMembers >= 2 ? { request: content, places: scope.localMembers, turnsBack } : null;
  }
  return null;
}
