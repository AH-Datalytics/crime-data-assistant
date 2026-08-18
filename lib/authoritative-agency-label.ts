import type Database from "better-sqlite3";

/**
 * When the server has resolved a request to one agency, that agency's name comes from the
 * database — not from what anybody called it.
 *
 * WHY THIS EXISTS
 * ---------------
 * Baltimore County is policed by two agencies. A user asked for "sheriff's office only", could
 * not be answered because the old data recorded both under one name, picked `MD0030100` by its
 * ORI, and got back figures correctly restricted to that agency under the heading "Baltimore
 * County Sheriff's Office". `MD0030100` is the Baltimore County **Police Department**. The
 * sheriff's office is `MD0030000` — the other one.
 *
 * Nothing lied about the numbers. The identity attached to them was carried over from the user's
 * own earlier wording, and the query selected only year and violent count, so no agency name was
 * in the result for the narrative to draw on. Intent and identity are different things.
 *
 * WHY IT NO LONGER REWRITES PROSE
 * -------------------------------
 * Three attempts tried to correct the name in place, and each produced a new defect. Allowing a
 * few preceding words swallowed the sentence: "Rates for the sheriff's office fell" became
 * "Baltimore County Police Department fell". Requiring those words to be capitalised fixed that
 * and broke lowercase text instead: "baltimore county sheriff's office reported" became
 * "baltimore county Baltimore County Police Department reported" — two adjacent identities.
 *
 * The common cause is that **the span of a name in free prose cannot be discovered reliably**.
 * Every regex is a guess about where the name starts, and a wrong guess either eats the sentence
 * or leaves half a name behind. So this no longer guesses.
 *
 * It renders the label deterministically from the record, detects whether the narrative
 * contradicts it, and on contradiction replaces the narrative with a short server-authored
 * sentence rather than repairing it. A plainer true answer beats a richer one that might be
 * wrong — which is the same trade the rest of this application makes.
 *
 * It never invents. If the resolved ORI is not in the Historical agency table there is no
 * authoritative name, and the caller declines rather than publishing a guess.
 */

export type AuthoritativeAgency = {
  ori: string;
  agency: string;
  state: string | null;
  type: string | null;
};

/** The agency record for a resolved ORI, or nothing if the database does not hold one. */
export function lookupAuthoritativeAgency(
  db: Database.Database | null | undefined,
  ori: string | null | undefined,
): AuthoritativeAgency | null {
  if (!db || !ori) return null;
  try {
    const row = db.prepare(
      "SELECT ori, agency, state, type FROM historical_agency WHERE ori = ?",
    ).get(ori) as { ori: string; agency: string | null; state: string | null; type: string | null } | undefined;
    if (!row || !row.agency || !String(row.agency).trim()) return null;
    return { ori: row.ori, agency: String(row.agency).trim(), state: row.state, type: row.type };
  } catch {
    return null;
  }
}

/**
 * Descriptors that name what kind of law-enforcement body an agency is.
 *
 * Used only to *detect* a contradiction. Nothing is spliced in their place.
 */
const ROLE_PHRASES = [
  "sheriff's department",
  "sheriffs department",
  "sheriff's office",
  "sheriffs office",
  "sheriff",
  "county police department",
  "metropolitan police department",
  "police department",
  "county police",
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The label the answer shows for this agency. Rendered, never extracted. */
export function renderAuthoritativeAgencyLabel(record: AuthoritativeAgency): string {
  const state = (record.state || "").trim().toUpperCase();
  return state ? `${record.agency}, ${state}` : record.agency;
}

/**
 * Does this narrative claim a kind of agency the record contradicts?
 *
 * Detection only. "Police department" in text about a police department is not a contradiction;
 * "sheriff's office" is.
 */
export function narrativeContradictsRecord(
  text: string | null | undefined,
  record: AuthoritativeAgency,
): { contradicts: boolean; phrases: string[] } {
  if (!text) return { contradicts: false, phrases: [] };
  const authoritative = normalize(record.agency);
  const found: string[] = [];
  for (const phrase of ROLE_PHRASES) {
    if (authoritative.includes(phrase)) continue;
    const pattern = new RegExp(`\\b${escapeRegExp(phrase).replace(/'/g, "['’]")}\\b`, "i");
    if (pattern.test(text)) found.push(phrase);
  }
  return { contradicts: found.length > 0, phrases: found };
}

/** The sentence used when the model's own wording cannot be trusted about which agency this is. */
export function authoritativeFallbackExplanation(record: AuthoritativeAgency): string {
  return `These figures are for ${renderAuthoritativeAgencyLabel(record)} (ORI ${record.ori}), `
    + "the agency selected for this question.";
}

export type AuthoritativeIdentityResult = {
  explanation: string;
  title: string;
  changed: boolean;
  /** What was replaced and why, for logging and for tests to assert against. */
  corrections: string[];
};

/**
 * Make an answer's identity agree with the resolved record.
 *
 * The title is rendered from the record whenever it would otherwise contradict it. The
 * explanation is replaced wholesale on contradiction — not patched — because patching is what
 * produced three rounds of malformed text. Narratives that say nothing contradictory are left
 * exactly as they are, which is the common case.
 */
export function applyAuthoritativeIdentity(
  explanation: string | null | undefined,
  title: string | null | undefined,
  record: AuthoritativeAgency,
): AuthoritativeIdentityResult {
  const corrections: string[] = [];
  let nextExplanation = explanation ?? "";
  let nextTitle = title ?? "";

  const explanationCheck = narrativeContradictsRecord(nextExplanation, record);
  if (explanationCheck.contradicts) {
    corrections.push(
      `explanation claimed ${explanationCheck.phrases.join(", ")}; replaced with a server-authored `
      + `sentence naming ${record.agency}`,
    );
    nextExplanation = authoritativeFallbackExplanation(record);
  }

  const titleCheck = narrativeContradictsRecord(nextTitle, record);
  if (titleCheck.contradicts) {
    corrections.push(`title claimed ${titleCheck.phrases.join(", ")}; rendered from the record`);
    nextTitle = renderAuthoritativeAgencyLabel(record);
  }

  return {
    explanation: nextExplanation,
    title: nextTitle,
    changed: nextExplanation !== (explanation ?? "") || nextTitle !== (title ?? ""),
    corrections,
  };
}
