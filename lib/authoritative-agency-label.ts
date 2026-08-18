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
 * Nothing lied about the numbers. The identity attached to them was carried over from the
 * user's own earlier wording, and the query that produced them selected only year and violent
 * count, so there was no agency name in the result for the narrative to draw on. Intent and
 * identity are different things: a user may say what they want, and may be wrong about what it
 * is called, and the answer must still say which agency the figures belong to.
 *
 * WHAT IT DOES
 * ------------
 * Deterministic and server-owned, rather than another line in the prompt. The model is told the
 * authoritative label, and then the label is enforced on the way out, because a prompt is a
 * request and this is a fact.
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
    return {
      ori: row.ori,
      agency: String(row.agency).trim(),
      state: row.state,
      type: row.type,
    };
  } catch {
    return null;
  }
}

/**
 * Descriptors that name what kind of law-enforcement body an agency is.
 *
 * Longest first, so "sheriff's office" is replaced whole rather than leaving a stray "office".
 */
const ROLE_PHRASES = [
  "sheriff's department",
  "sheriffs department",
  "sheriff's office",
  "sheriffs office",
  "county police department",
  "metropolitan police department",
  "police department",
  "county police",
  "sheriff",
];

function normalize(value: string): string {
  return value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type AuthoritativeLabelResult = {
  text: string;
  changed: boolean;
  /** What was replaced, for logging and for tests to assert against. */
  corrections: string[];
};

/**
 * Make every agency label in a narrative agree with the resolved record.
 *
 * Two passes, both conservative:
 *
 * 1. Anything presented as the name of this ORI -- `Something (ORI MD0030100)` -- is replaced
 *    with the authoritative name. This is the shape the defect actually took.
 * 2. A role descriptor that the authoritative name does not contain is replaced with the
 *    authoritative name. "Sheriff's office" cannot survive in an answer about a police
 *    department; "police department" is left alone when that is what the agency is.
 *
 * Text that says nothing about which agency this is comes back untouched.
 */
export function enforceAuthoritativeAgencyLabel(
  text: string | null | undefined,
  record: AuthoritativeAgency,
): AuthoritativeLabelResult {
  const corrections: string[] = [];
  if (!text) return { text: text ?? "", changed: false, corrections };
  const authoritative = record.agency;
  const authoritativeNormalized = normalize(authoritative);
  let out = text;

  // 1. A name presented as this ORI's.
  //
  // Only a run of capitalised words counts as the name. Matching any words at all swallowed
  // the sentence around it -- "Annual violent crime counts for Baltimore County Sheriff's
  // Office (ORI …)" became "Annual Baltimore County Police Department (ORI …)". A proper name
  // is capitalised; the prose leading up to it is not.
  const ori = escapeRegExp(record.ori);
  const word = "[A-Z][\\w''’.\\-&/]*";
  const labelled = new RegExp(
    `((?:${word})(?:\\s+(?:of|and|the|for)\\s+${word}|\\s+${word})*)(\\s*\\(\\s*(?:ORI\\s*[:\\-]?\\s*)?${ori}\\s*\\))`,
    "g",
  );
  out = out.replace(labelled, (whole, name: string, suffix: string) => {
    if (normalize(name) === authoritativeNormalized) return whole;
    corrections.push(`${name.trim()} -> ${authoritative}`);
    return `${authoritative}${suffix}`;
  });

  // 2. A kind of agency the authoritative name contradicts.
  //
  // Bounded on the left, which the first version was not. It allowed six arbitrary preceding
  // words, so it treated the sentence's own framing as part of the agency's name:
  // "Rates for the sheriff's office fell" became "Baltimore County Police Department fell",
  // and "According to the sheriff's office," lost "According to". Meaning changed, grammar
  // broke, and the production sentence only survived because pass 1 reached it first.
  //
  // Two shapes, and nothing else is touched:
  //
  //   a. a proper name immediately followed by the role -- "Baltimore County Sheriff's
  //      Office" -- where the capitalised run really is part of the label. Adjacency is
  //      required: a lowercase word between them means the capitals belong to the sentence,
  //      not to the agency.
  //   b. the bare role -- "the sheriff's office" -- where only the role words are replaced and
  //      every surrounding word, determiner included, is left where it was.
  for (const phrase of ROLE_PHRASES) {
    if (authoritativeNormalized.includes(phrase)) continue;
    const role = escapeRegExp(phrase).replace(/'/g, "['’]");
    const properWord = "[A-Z][\\w''’.\\-&/]*";

    // a. a capitalised run directly against the role phrase
    const named = new RegExp(`\\b((?:${properWord})(?:\\s+${properWord}){0,5})\\s+(${role})\\b`, "gi");
    out = out.replace(named, (match: string, lead: string) => {
      // The run has to be capitalised in the text itself; the pattern is case-insensitive so
      // that the role words match either way, which would otherwise let lowercase prose in.
      if (!/^[A-Z]/.test(lead) || !lead.split(/\s+/).every((w) => /^[A-Z]/.test(w))) return match;
      if (normalize(match) === authoritativeNormalized) return match;
      corrections.push(`${match.trim()} -> ${authoritative}`);
      return authoritative;
    });

    // b. the role phrase alone, with its grammatical context untouched
    const bare = new RegExp(`\\b${role}\\b`, "gi");
    out = out.replace(bare, (match: string) => {
      corrections.push(`${match.trim()} -> ${authoritative}`);
      return authoritative;
    });
  }

  // Replacing a phrase that already sat beside the name can double it up.
  const doubled = new RegExp(`(${escapeRegExp(authoritative)})(\\s+\\1)+`, "gi");
  out = out.replace(doubled, "$1");

  return { text: out, changed: out !== text, corrections };
}
