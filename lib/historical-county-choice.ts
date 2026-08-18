import type Database from "better-sqlite3";
import {
  countyKeyFromDisplayName,
  countyNameFromQuestion,
  resolveHistoricalCountyAgency,
  selectNamedCountyAgency,
} from "./historical-county-identity";

/**
 * The second county question: once the user has said they want the county's own agency
 * rather than a countywide total, *which* agency did they mean?
 *
 * `lib/county-clarifier.ts` asks the first question -- countywide or the county agency. For
 * about seventy counties the second answer is not a single agency: a sheriff's office and a
 * county police department both report, under separate ORIs, as separate forces. Chatham,
 * Cobb, DeKalb and Clayton in Georgia, Baltimore County in Maryland.
 *
 * Until now nothing detected that. The system prompt was told to ask, which is not
 * enforcement -- the model cannot be the only thing standing between a user and a number
 * assembled from the wrong agency, and a name predicate matching two ORIs followed by
 * `LIMIT 1` publishes one of them with no signal that a choice was made. This runs
 * server-side, before any factual SQL, and returns a clarification naming both.
 *
 * It deliberately does not fire for countywide requests: those are an all-ORI path and have
 * no single agency to choose.
 */

/** The user has asked for the county's own agency rather than a countywide total. */
const SINGLE_AGENCY_RE =
  /\b(sheriff|sheriffs?'?s?\s+(?:office|department)|county police|county agency|police department|pd\b|just the county|only the county)\b/i;

/** The user has asked for everything inside the county. No single agency applies. */
const COUNTYWIDE_RE =
  /\b(county\s*-?\s*wide|countywide total|all (?:law enforcement |reporting |mapped )?agencies|every agency|combined agencies)\b/i;

/** Signature used to notice this clarifier already ran in the session. */
const CLARIFIER_SIGNATURE = "is served by more than one law enforcement agency";

export type CountyAgencyChoice = {
  id: string;
  explanation: string;
  county: string;
  state: string;
  agencies: { ori: string; agency: string }[];
};

type HistoryMessage = { role?: string; content?: unknown };

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

export function getHistoricalCountyAgencyChoice(
  db: Database.Database | null | undefined,
  question: string,
  rawHistory?: unknown,
): CountyAgencyChoice | null {
  if (!db) return null;
  const history: HistoryMessage[] = Array.isArray(rawHistory) ? (rawHistory as HistoryMessage[]) : [];

  const countyName = countyNameFromQuestion(question)
    ?? history.map((msg) => countyNameFromQuestion(asText(msg?.content))).find(Boolean)
    ?? null;
  if (!countyName) return null;
  const countyKey = countyKeyFromDisplayName(countyName);
  if (!countyKey) return null;

  const conversation = [question, ...history.map((msg) => asText(msg?.content))].join("\n");
  if (COUNTYWIDE_RE.test(conversation)) return null;
  if (!SINGLE_AGENCY_RE.test(conversation)) return null;

  // Asked once. A user who answers "the sheriff" for a county whose agencies are not named
  // that way would otherwise be asked the same question forever.
  for (const msg of history) {
    if (asText(msg?.content).toLowerCase().includes(CLARIFIER_SIGNATURE)) return null;
  }

  const state = stateFromConversation(db, countyKey, conversation);
  if (!state) return null;

  const resolution = resolveHistoricalCountyAgency(db, state, countyName);
  if (resolution.status !== "ambiguous") return null;

  const candidates = resolution.agencies.map((entry) => ({ ori: entry.ori, agency: entry.agency }));
  // The user may already have named one, in this message or in an earlier answer.
  if (selectNamedCountyAgency(conversation, countyKey, candidates, countyName)) return null;

  const named = candidates.map((entry) => `${entry.agency} (ORI ${entry.ori})`).join(" and ");
  return {
    id: `county-agency-${countyKey.toLowerCase().replace(/\s+/g, "-")}-${state.toLowerCase()}`,
    county: countyName,
    state,
    agencies: candidates,
    explanation:
      `${countyName}, ${state} ${CLARIFIER_SIGNATURE.replace("is served by", "is served by")}: ${named}. ` +
      `They are separate departments that report separately, so I did not combine them and I did not pick one. ` +
      `Which do you want?`,
  };
}

/**
 * The state this county question is about.
 *
 * Only a state the crosswalk actually pairs with this county counts, and only when exactly
 * one does -- otherwise the state clarifier upstream has work to do first and guessing here
 * would pre-empt it.
 */
function stateFromConversation(
  db: Database.Database,
  countyKey: string,
  conversation: string,
): string | null {
  let states: string[];
  try {
    states = (db.prepare(`
      SELECT DISTINCT UPPER(cw.state) AS state
      FROM agency_county_crosswalk cw
      JOIN historical_agency ha ON ha.ori = cw.ori9
      WHERE cw.county_key = ? AND LOWER(ha.type) = 'county'
    `).all(countyKey) as { state: string }[]).map((row) => row.state);
  } catch {
    return null;
  }
  if (states.length === 0) return null;
  if (states.length === 1) return states[0];
  const mentioned = states.filter((state) => new RegExp(`\\b${state}\\b`).test(conversation));
  return mentioned.length === 1 ? mentioned[0] : null;
}
