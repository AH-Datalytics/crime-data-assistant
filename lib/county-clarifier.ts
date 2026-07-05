/**
 * County scope clarifier (ruling 2026-07-05): a data question about
 * "X County/Parish/Borough" always asks whether the user wants the countywide
 * total (all mapped agencies via agency_county_crosswalk) or the sheriff's
 * office / county agency record only — the two answers differ hugely and both
 * are reasonable readings of "crime in X County".
 *
 * Fires AFTER the geo state-ambiguity clarifier (routes call that first), so
 * bare multi-state counties like "Cook County" resolve the state before scope.
 * Does not re-ask within a session once the clarifier has been asked or the
 * user has specified a scope.
 */

const COUNTY_MENTION_RE = /\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})\s+(County|Parish|Borough)\b/i;

const FILLER_TOKEN_RE = /^(the|a|an|in|for|from|within|inside|across|covering|of|at|to|and|crime|crimes|violent|property|murder|murders|homicide|homicides|robbery|robberies|assault|assaults|burglary|burglaries|theft|thefts|gun|violence|data|stats|statistics|trend|trends|rate|rates|show|me|compare|changed|has|how|what|since)$/i;

/** Question (or a history message) already picks a scope — countywide or single agency. */
const SCOPE_DISAMBIGUATED_RE = /\b(county\s*-?\s*wide|countywide total|all (?:law enforcement |reporting |mapped )?agencies|every agency|combined agencies|sheriff|sheriffs?'?s?\s+(?:office|department)|county police|county agency|police department|pd\b|just the county|only the county)\b/i;

/** Metadata/roster questions about a county are not scope-ambiguous crime totals. */
const METADATA_QUESTION_RE = /\b(which|what|list(?:\s+of)?|how many)\s+(cities|agencies|departments|towns|places)\b|\b(cities|agencies|departments)\s+(?:are\s+)?in\b/i;

/** Signature phrase used to detect that this clarifier was already asked in the session. */
const CLARIFIER_SIGNATURE = "countywide total (all law enforcement agencies";

export type CountyScopeClarification = {
  id: string;
  explanation: string;
};

type HistoryMessage = { role?: string; content?: unknown };

export function getCountyScopeClarification(
  question: string,
  rawHistory?: unknown
): CountyScopeClarification | null {
  const history: HistoryMessage[] = Array.isArray(rawHistory) ? (rawHistory as HistoryMessage[]) : [];
  const match = question.match(COUNTY_MENTION_RE);
  if (!match) return null;

  // Strip leading verbs/fillers the capture may have swallowed ("in Cook" is fine,
  // "Show Me Cook" is not) — mirror countyScopeFromQuestion's token cleanup.
  // Drop everything up to the last filler token, then title-case for display.
  const rawTokens = match[1].split(/\s+/);
  const lastFiller = rawTokens.reduce((last, t, i) => (FILLER_TOKEN_RE.test(t) ? i : last), -1);
  const tokens = rawTokens.slice(lastFiller + 1);
  const name = tokens
    .map((t) => (t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t))
    .join(" ")
    .trim();
  if (!name) return null;
  const suffix = match[2].charAt(0).toUpperCase() + match[2].slice(1).toLowerCase();

  if (SCOPE_DISAMBIGUATED_RE.test(question)) return null;
  if (METADATA_QUESTION_RE.test(question)) return null;

  // Session memory: once asked or answered, never re-ask
  if (history.length > 0) {
    for (const msg of history) {
      const content = typeof msg?.content === "string" ? msg.content : JSON.stringify(msg?.content ?? "");
      if (!content) continue;
      if (content.toLowerCase().includes(CLARIFIER_SIGNATURE)) return null;
      if (msg?.role === "user" && SCOPE_DISAMBIGUATED_RE.test(content)) return null;
    }
  }

  const label = `${name} ${suffix}`;
  return {
    id: `county-scope-${name.toLowerCase().replace(/\s+/g, "-")}`,
    explanation:
      `For ${label}, do you want the countywide total (all law enforcement agencies mapped to ${label}, summed — ` +
      `totals depend on each agency's reporting participation) or the sheriff's office only (the single county agency record)? ` +
      `Choose: Countywide total or Sheriff's office only.`,
  };
}
