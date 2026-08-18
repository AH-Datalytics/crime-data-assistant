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
 * `lib/county-clarifier.ts` asks the first question. For about seventy counties the second
 * answer is not a single agency: a sheriff's office and a county police department both
 * report, under separate ORIs, as separate forces.
 *
 * WHERE INTENT COMES FROM
 * -----------------------
 * From the user, and only from the user. The first version of this read the whole
 * conversation, which meant the scope clarifier's own text -- "Countywide total or Sheriff's
 * office only?" -- was scanned for intent. It contains the words "countywide total", so every
 * answer to it looked like a countywide request and this check never ran on the one flow it
 * exists for. Assistant turns are read for structured state -- was the question already asked
 * -- and for nothing else.
 *
 * WHY THREE OUTCOMES AND NOT ONE NULL
 * -----------------------------------
 * A single `null` for "resolved", "ask them" and "they answered and I cannot honour it" told
 * the caller nothing, so the route could not pin the chosen ORI and could not decline when the
 * answer was unusable -- leaving the model free to generate another two-agency query. Each
 * outcome is now distinct, and `resolved` carries the ORI the executed SQL is required to use.
 */

/** The user has asked for everything inside the county. No single agency applies. */
const COUNTYWIDE_RE =
  /\b(county\s*-?\s*wide|countywide total|all (?:law enforcement |reporting |mapped )?agencies|every agency|combined agencies)\b/i;

/** The user has asked for the county's own agency rather than a countywide total. */
const SINGLE_AGENCY_RE =
  /\b(sheriff|county police|county agency|police department|pd\b|just the county|only the county)\b/i;

/**
 * The answer names a particular force rather than merely choosing the single-agency scope.
 * "Sheriff's office only" is a claim about which department; "county agency only" is not.
 */
const NAMES_A_FORCE_RE = /\b(sheriff|police department|county police)\b/i;

/** Signature used to notice this clarifier already ran in the session. */
const CLARIFIER_SIGNATURE = "is served by more than one law enforcement agency";

/** An FBI ORI code, which the decline offers as the way to pick between same-named agencies. */
const ORI_CODE_RE = /\b[A-Z]{2}[A-Z0-9]{5,10}\b/;

export type CountyAgencyOption = { ori: string; agency: string };

export type CountyAgencyDecision =
  | { kind: "none" }
  /** An all-ORI request. The single-agency choice does not apply. */
  | { kind: "countywide" }
  /** Two agencies and nothing yet says which. Ask, naming both. */
  | {
      kind: "clarify";
      id: string;
      explanation: string;
      county: string;
      state: string;
      agencies: CountyAgencyOption[];
    }
  /** The user named one. The executed SQL must use this ORI. */
  | { kind: "resolved"; county: string; state: string; ori: string; agency: string }
  /** They answered and the data cannot honour it. Decline; run no factual SQL. */
  | {
      kind: "unresolved";
      id: string;
      explanation: string;
      county: string;
      state: string;
      agencies: CountyAgencyOption[];
    };

type HistoryMessage = { role?: string; content?: unknown };

function asText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? "");
}

function normalizedAgencyName(value: string): string {
  return (value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

export function getHistoricalCountyAgencyDecision(
  db: Database.Database | null | undefined,
  question: string,
  rawHistory?: unknown,
): CountyAgencyDecision {
  if (!db) return { kind: "none" };
  const history: HistoryMessage[] = Array.isArray(rawHistory) ? (rawHistory as HistoryMessage[]) : [];
  const userTurns = history.filter((msg) => msg?.role === "user").map((msg) => asText(msg?.content));
  const assistantTurns = history.filter((msg) => msg?.role !== "user").map((msg) => asText(msg?.content));

  // Everything the user has said, and nothing an assistant offered them.
  const said = [question, ...userTurns].filter(Boolean).join("\n");

  const countyName = countyNameFromQuestion(question)
    ?? userTurns.map((text) => countyNameFromQuestion(text)).find(Boolean)
    ?? null;
  if (!countyName) return { kind: "none" };
  const countyKey = countyKeyFromDisplayName(countyName);
  if (!countyKey) return { kind: "none" };

  // The newest answer wins. A user who asked for the countywide total and then changed their
  // mind, or the reverse, must not be held to the older phrase still sitting in history.
  const currentSaysCountywide = COUNTYWIDE_RE.test(question);
  const currentSaysSingle = SINGLE_AGENCY_RE.test(question) || ORI_CODE_RE.test(question);
  if (currentSaysSingle) {
    // fall through to the single-agency path
  } else if (currentSaysCountywide) {
    return { kind: "countywide" };
  } else if (COUNTYWIDE_RE.test(said)) {
    return { kind: "countywide" };
  } else if (!SINGLE_AGENCY_RE.test(said)) {
    return { kind: "none" };
  }

  const state = stateFromUserTurns(db, countyKey, said);
  if (!state) return { kind: "none" };

  const resolution = resolveHistoricalCountyAgency(db, state, countyName);
  if (resolution.status !== "ambiguous") return { kind: "none" };

  const agencies: CountyAgencyOption[] = resolution.agencies.map((entry) => ({
    ori: entry.ori,
    agency: entry.agency,
  }));

  // `question` is passed separately so an ORI counts only when it is this turn's answer.
  const chosen = selectNamedCountyAgency(said, countyKey, agencies, countyName, question);
  if (chosen) {
    return { kind: "resolved", county: countyName, state, ori: chosen.ori, agency: chosen.agency };
  }

  const id = `county-agency-${countyKey.toLowerCase().replace(/\s+/g, "-")}-${state.toLowerCase()}`;
  const named = agencies.map((entry) => `${entry.agency} (ORI ${entry.ori})`).join(" and ");

  // They named a force and nothing in the data answers to it. On the database in production
  // today both of Baltimore County's agencies are called `Baltimore County`, so "the sheriff's
  // office" cannot be matched to either -- and asking again would put the same unanswerable
  // question a second time. Say so, and run nothing.
  const alreadyAsked = assistantTurns.some((text) => text.toLowerCase().includes(CLARIFIER_SIGNATURE));
  if (NAMES_A_FORCE_RE.test(said) || alreadyAsked) {
    // Why the answer could not be used depends on the data, and saying the wrong reason is its
    // own kind of untruth. On the current database both of Baltimore County's agencies really
    // are recorded as `Baltimore County`, and no wording could separate them. On the rebuilt
    // database they have different names, so the honest report is that this particular reply
    // did not identify one of them.
    const sameName = new Set(agencies.map((entry) => normalizedAgencyName(entry.agency))).size === 1;
    const reason = sameName
      ? `they are recorded under the same name, so I cannot tell which one you mean: ${named}. `
        + `I did not answer from either, because attributing one department's figures to the other `
        + `would be wrong.`
      : `your reply did not identify one of them: ${named}. I did not answer from either, because `
        + `picking one would attribute its figures to the wrong department.`;
    return {
      kind: "unresolved",
      id: `${id}-${sameName ? "indistinguishable" : "unidentified"}`,
      county: countyName,
      state,
      agencies,
      explanation:
        `${countyName}, ${state} has two county law enforcement agencies in the FBI Historical file and `
        + `${reason} You can ask for one by its ORI code.`,
    };
  }

  return {
    kind: "clarify",
    id,
    county: countyName,
    state,
    agencies,
    explanation:
      `${countyName}, ${state} ${CLARIFIER_SIGNATURE}: ${named}. `
      + `They are separate departments that report separately, so I did not combine them and I did `
      + `not pick one. Which do you want?`,
  };
}

/**
 * The state this county question is about, from what the user typed.
 *
 * Both spellings count. A follow-up like "county agency only" carries no state at all, so the
 * abbreviation *or* the name has to be recovered from the original question -- losing
 * "Maryland" because only "MD" was looked for would drop the whole check.
 */
function stateFromUserTurns(
  db: Database.Database,
  countyKey: string,
  said: string,
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
  const mentioned = states.filter((state) => {
    if (new RegExp(`\\b${state}\\b`).test(said)) return true;
    const name = STATE_NAMES[state];
    return Boolean(name) && new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(said);
  });
  return mentioned.length === 1 ? mentioned[0] : null;
}
