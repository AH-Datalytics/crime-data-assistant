import type Database from "better-sqlite3";

/**
 * Resolving a county question to a Historical agency without going through its name.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Historical importer used to rewrite county names on the way in. `Jefferson` became
 * `Jefferson County`, `Baltimore County Police Department` became `Baltimore County`, and
 * `Jacksonville Sheriff's Office` became `Jacksonville County` -- a county Florida does not
 * have. The application then asked for those invented names back: `WHERE ha.agency = 'Cook
 * County'`. Once the rebuilt tables keep what `geographies.csv` actually says, every one of
 * those predicates stops matching, and 3,126 of 3,127 shared county agencies are affected.
 *
 * Two of the rewrites also destroyed a distinction. In Georgia the sheriff's office and the
 * county police department are separate agencies with separate ORIs, and both were renamed to
 * the same string -- so today `agency = 'Chatham County'` matches two different departments
 * and the usual `ORDER BY COUNT(*) DESC LIMIT 1` picks whichever filed more years. The user
 * has no way to ask for the other one and no signal that a choice was made.
 *
 * HOW IT RESOLVES INSTEAD
 * -----------------------
 * `agency_county_crosswalk` already maps every ORI to its county by FIPS code, from a tracked
 * participation crosswalk, and says nothing about agency names. So a county question resolves
 * county -> ORI -> agency, and the agency's name is never a predicate. That works unchanged
 * against the current production database and the rebuilt one, because the rebuild does not
 * touch the crosswalk and does not move any ORI: 3,058 counties resolve on both, 2,992 and
 * 2,988 of them to exactly one agency.
 *
 * This is deliberately not fuzzy matching. The county key is an exact lookup into a
 * FIPS-keyed table, and `type = 'county'` is required, so nothing here can drift onto a
 * same-named city -- Maricopa County and the city of Maricopa, Bibb County and Bibb City,
 * St. Louis County and St. Louis city all stay apart.
 *
 * WHAT IT DOES NOT DO
 * -------------------
 * It does not choose between two county agencies. Where a county has both a sheriff's office
 * and a county police department -- 66 counties in the current database, 70 in the rebuilt one
 * -- both come back and the caller has to ask. Silently picking one is the habit this module
 * exists to end.
 */

/** One Historical agency that serves a county, with the identity that addresses it. */
export type HistoricalCountyAgency = {
  ori: string;
  /** The agency's name as the database spells it. Descriptive; never used as a predicate. */
  agency: string;
  state: string;
  countyFips: string | null;
  /** The county's name from the crosswalk, e.g. `Duval`. */
  countyName: string | null;
};

export type HistoricalCountyResolution =
  | { status: "resolved"; agency: HistoricalCountyAgency; countyKey: string }
  | { status: "ambiguous"; agencies: HistoricalCountyAgency[]; countyKey: string }
  | { status: "unknown"; countyKey: string };

/**
 * The crosswalk's own spelling of a county key: upper case, letters digits and spaces only,
 * `Saint` and `St.` both written `ST`, and no county/parish/borough word.
 *
 * Matched to the table rather than invented -- all 1,834 keys in it are `[A-Z0-9 ]+` and none
 * contains the word COUNTY. The existing helper in geo-source-mapper.ts left the full stop in
 * place, so `St. Louis County` produced `ST. LOUIS` and matched nothing.
 */
export function countyKeyFromDisplayName(name: string): string {
  return (name || "")
    .replace(/\bSaint\b/gi, "St")
    .replace(/\bSt\./gi, "St")
    .replace(/\b(county|parish|borough|census area|municipality)\b/gi, " ")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A predicate on `ha.ori` selecting the law-enforcement agency (or agencies) *of* a county --
 * the sheriff's office or county police department, not every agency inside its borders.
 *
 * Emitted as SQL rather than a resolved ORI so the plan builders, which hold no database
 * handle, can still address the agency by identity instead of by name.
 */
export function historicalCountyAgencyPredicate(state: string, countyName: string): string {
  const countyKey = countyKeyFromDisplayName(countyName);
  return `ha.ori IN (SELECT cw.ori9 FROM agency_county_crosswalk cw ` +
    `JOIN historical_agency cha ON cha.ori = cw.ori9 ` +
    `WHERE UPPER(cw.state) = ${quote(state.toUpperCase())} AND cw.county_key = ${quote(countyKey)} ` +
    `AND LOWER(cha.type) = 'county')`;
}

/**
 * A predicate on `ha.ori` selecting every agency that reports inside a county.
 *
 * Kept separate from the one above on purpose. "How much crime was there in Cook County" and
 * "what did the Cook County Sheriff report" are different questions with different answers,
 * and the county-scope clarifier in lib/followup-transform.ts exists to tell them apart.
 * Nothing here may quietly turn one into the other.
 */
export function historicalCountywidePredicate(state: string, countyName: string): string {
  const countyKey = countyKeyFromDisplayName(countyName);
  return `ha.ori IN (SELECT cw.ori9 FROM agency_county_crosswalk cw ` +
    `WHERE UPPER(cw.state) = ${quote(state.toUpperCase())} AND cw.county_key = ${quote(countyKey)} ` +
    `AND cw.ori9 IS NOT NULL)`;
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
  } catch {
    return false;
  }
}

/**
 * Resolve a county place to the agency that polices it, for the paths that hold a database.
 *
 * Returns every match rather than the first: a caller that needs one agency must handle two.
 */
export function resolveHistoricalCountyAgency(
  db: Database.Database | null | undefined,
  state: string | null | undefined,
  countyName: string
): HistoricalCountyResolution {
  const countyKey = countyKeyFromDisplayName(countyName);
  if (!db || !state || !countyKey) return { status: "unknown", countyKey };
  if (!tableExists(db, "agency_county_crosswalk") || !tableExists(db, "historical_agency")) {
    return { status: "unknown", countyKey };
  }
  let rows: HistoricalCountyAgency[] = [];
  try {
    rows = db.prepare(`
      SELECT ha.ori AS ori,
             ha.agency AS agency,
             UPPER(cw.state) AS state,
             cw.county_fips AS countyFips,
             cw.county_name AS countyName
      FROM agency_county_crosswalk cw
      JOIN historical_agency ha ON ha.ori = cw.ori9
      WHERE UPPER(cw.state) = ? AND cw.county_key = ? AND LOWER(ha.type) = 'county'
      ORDER BY ha.ori
    `).all(state.toUpperCase(), countyKey) as HistoricalCountyAgency[];
  } catch {
    return { status: "unknown", countyKey };
  }
  if (rows.length === 1) return { status: "resolved", agency: rows[0], countyKey };
  if (rows.length > 1) return { status: "ambiguous", agencies: rows, countyKey };
  return { status: "unknown", countyKey };
}

function normalizedWords(value: string): string {
  return ` ${(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/**
 * The county phrase the user typed, e.g. `Duval County` or `Orleans Parish`.
 *
 * The capture takes up to three words before the suffix, which means it also swallows the
 * words leading up to it: "violent crime in Baltimore County" yielded
 * `violent crime in Baltimore County`, whose key matched no county and silently disabled
 * every check downstream. Leading filler is dropped the same way lib/county-clarifier.ts
 * does it, so the two agree about which county a sentence names.
 */
const COUNTY_FILLER_TOKEN_RE = /^(the|a|an|in|for|from|within|inside|across|covering|of|at|to|and|crime|crimes|violent|property|murder|murders|homicide|homicides|robbery|robberies|assault|assaults|burglary|burglaries|theft|thefts|gun|violence|data|stats|statistics|trend|trends|rate|rates|show|me|compare|changed|has|how|what|since|scorecard|about|give|us)$/i;

export function countyNameFromQuestion(question: string): string | null {
  const match = (question || "").match(
    /\b([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3})\s+(County|Parish|Borough)\b/i
  );
  if (!match) return null;
  const tokens = match[1].split(/\s+/);
  const lastFiller = tokens.reduce((last, token, index) => (COUNTY_FILLER_TOKEN_RE.test(token) ? index : last), -1);
  const name = tokens.slice(lastFiller + 1).join(" ").trim();
  if (!name) return null;
  return `${name} ${match[2]}`;
}

/**
 * The agency the question names, when it names one of the candidates.
 *
 * Three rules, each needing evidence, none guessing. Where none applies the caller asks.
 *
 * 0. A candidate whose name *is* the phrase the user typed, exactly -- unless another
 *    candidate extends that name. On the current database St. Louis County has two
 *    county-typed rows, `St. Louis County` and `St. Louis` (the city, mis-typed), and
 *    "St. Louis County" names one and not the other. But in the rebuilt data Baltimore
 *    County's two agencies are `Baltimore County` and `Baltimore County Police Department`,
 *    and the shorter name matching says nothing about which of the two forces is meant.
 * 1. A candidate whose own name says more than the bare county name and appears in the
 *    question -- "Chatham County Police Department".
 * 2. Where exactly one of two candidates is a named police department and the user asked for
 *    the sheriff, the other is the answer by elimination.
 */
/**
 * The candidate whose ORI the user typed back, when they named exactly one.
 *
 * The decline message offers these codes as the way to pick between two agencies recorded
 * under the same name, so the code has to accept them: offering an affordance and then not
 * honouring it leaves the user with no way through at all.
 *
 * Tokenised rather than matched with a word-boundary pattern, so an ORI embedded in a longer
 * identifier cannot count as a mention.
 */
export function selectCountyAgencyByOri(
  answer: string,
  candidates: { ori: string; agency: string }[],
): { ori: string; agency: string } | null {
  const tokens = new Set((answer || "").toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const named = candidates.filter((entry) => tokens.has(entry.ori.toUpperCase()));
  return named.length === 1 ? named[0] : null;
}

export function selectNamedCountyAgency(
  question: string,
  countyKey: string,
  candidates: { ori: string; agency: string }[],
  countyName = "",
  currentAnswer = "",
): { ori: string; agency: string } | null {
  const asked = normalizedWords(question);

  // An ORI code the user typed back is the strongest evidence there is: it is the exact
  // identifier, and where two agencies share a name it is the only thing that separates them.
  // Read from the current answer alone -- an ORI mentioned earlier in the conversation is
  // context, not a choice -- and only when exactly one is named, so quoting both is not a pick.
  const byOri = selectCountyAgencyByOri(currentAnswer || question, candidates);
  if (byOri) return byOri;

  const typed = normalizedWords(countyName).trim();
  if (typed) {
    const exact = candidates.filter((entry) => normalizedWords(entry.agency).trim() === typed);
    const extended = candidates.some((entry) => {
      const name = normalizedWords(entry.agency).trim();
      return name !== typed && name.startsWith(`${typed} `);
    });
    if (exact.length === 1 && !extended) return exact[0];
  }

  const distinctive = candidates.filter((entry) => {
    const name = normalizedWords(entry.agency).trim();
    return name && countyKeyFromDisplayName(entry.agency) !== countyKey && asked.includes(` ${name} `);
  });
  if (distinctive.length === 1) return distinctive[0];

  if (/\bsheriff'?s?\b/i.test(question) && candidates.length === 2) {
    const departments = candidates.filter((entry) => /police\s+department/i.test(entry.agency));
    if (departments.length === 1) {
      const other = candidates.find((entry) => entry.ori !== departments[0].ori);
      if (other) return other;
    }
  }
  return null;
}

/**
 * The label a county agency is shown under.
 *
 * Taken from the crosswalk's county name plus the state's own word for a county, so the user
 * still reads "Cook County" and "Jefferson Parish" whatever the database happens to spell the
 * agency. Where the agency has its own descriptive name -- `Jacksonville Sheriff's Office`,
 * `Riley County Police Department` -- that name is shown instead, because it is the answer to
 * "which agency is this" and the county label would hide it.
 */
export function historicalCountyLabel(agency: HistoricalCountyAgency): string {
  const name = (agency.agency || "").trim();
  const word = agency.state?.toUpperCase() === "LA" ? "Parish" : "County";
  if (!agency.countyName) return name;
  const plain = countyKeyFromDisplayName(name) === countyKeyFromDisplayName(agency.countyName);
  return plain ? `${agency.countyName} ${word}` : name;
}
