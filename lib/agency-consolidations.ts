/**
 * Consolidated / merged law-enforcement agencies.
 *
 * WHY THIS EXISTS
 * ---------------
 * When a city PD merges with a county sheriff, the FBI does not rename the old
 * agency -- it opens a NEW ORI for the successor and leaves the predecessor's rows
 * in place. In `historical_agency_crime` those predecessor rows keep appearing for
 * decades with every crime column NULL and a population frozen at its pre-merger
 * value. Louisville is the clearest case:
 *
 *   KY0560200  Louisville        1960-2003 real, then NULL rows through 2024, pop stuck at 300,404
 *   KY0568000  Louisville Metro  1932-2025 real, pop 691,630
 *
 * A user asking about "Louisville" exact-name-matches the DEAD ORI, so the answer
 * silently describes 2003 -- with a population less than half the real city.
 *
 * The sources also disagree on what these agencies are called. RTCI's `agencies`
 * table uses the friendly name ("Louisville", "Las Vegas", "Charlotte", "Nashville");
 * historical UCR uses the formal post-merger name ("Louisville Metro",
 * "Las Vegas Metropolitan Police Department", "Charlotte-Mecklenburg",
 * "Metropolitan Nashville Police Department"). Left alone, the same question gets a
 * different agency name depending on which tab answers it.
 *
 * THE CONVENTION
 * --------------
 * `alias` is the single display name, used in every tab and every response. It is
 * the friendly name, because that is what RTCI already emits and what users type.
 * The per-source fields carry whatever that source actually calls the agency, and
 * exist only to build queries -- never to label output.
 *
 * HOW ENTRIES WERE VERIFIED
 * -------------------------
 * Each row below was confirmed against `crime_data.db`: the predecessor's last year
 * with non-NULL crime data, the successor's reporting span, and a population check
 * that the successor is not smaller than the agency it absorbed. Name similarity
 * alone was NOT sufficient -- "Wilson, KS" and "Wilson County, KS" share a name and
 * are unrelated jurisdictions, and "Kankakee" / "Kankakee County" are a city PD and
 * a county sheriff that both still exist. Macon is the case that proves the
 * population check earns its keep: its successor is named "Bibb County", which
 * shares no words with "Macon", and the match rests on 156,339 -> 157,114.
 */

export type ConsolidatedAgency = {
  /** Display name -- the ONLY string that should reach a user. */
  alias: string;
  /** USPS state code, upper case. Keys are state-scoped: Santa Clara UT is a merged agency, Santa Clara CA is not. */
  state: string;
  /** Exact `historical_agency.agency` for the surviving agency. */
  historicalAgency: string;
  /** Exact `historical_agency.type` for the survivor -- several are 'county', not 'city'. */
  historicalType: "city" | "county";
  /** Verified surviving 9-character ORI in Historical/NIBRS. */
  historicalOri: string;
  /** Verified NIBRS ORI. Explicit because ORI mappings must never be inferred. */
  nibrsOri?: string;
  /** Verified SHR 7-character ORI. Absent means SHR has no surviving identity. */
  shrOri?: string;
  /** Verified SHR predecessor ORI when a continuous historical query must span both identities. */
  shrPredecessorOri?: string;
  /** Exact `agencies.agency` (RTCI) when RTCI covers it. RTCI carries only ~700 large agencies. */
  currentAgency?: string;
  /** Verified labels emitted by source identity tables; presentation-only, never query keys. */
  sourceDisplayNames?: string[];
  /** The defunct predecessor still present in historical_agency, when one exists. */
  predecessor?: string;
  /** Last year the predecessor reported real data. Absent when the predecessor has no rows at all. */
  predecessorLastYear?: number;
  /** Evidence trail for this row. */
  note: string;
};

export const CONSOLIDATED_AGENCIES: ConsolidatedAgency[] = [
  {
    alias: "Las Vegas", state: "NV",
    historicalAgency: "Las Vegas Metropolitan Police Department", historicalType: "city",
    historicalOri: "NV0020100", nibrsOri: "NV0020100", shrOri: "NV00201",
    currentAgency: "Las Vegas",
    sourceDisplayNames: ["Las Vegas Metro Police Department"],
    note: "LVMPD (Las Vegas PD + Clark County Sheriff, 1973). No 'Las Vegas' agency row exists at all, so the bare name resolved to nothing. Survivor 1958-2025, pop 1,712,136.",
  },
  {
    alias: "Charlotte", state: "NC",
    historicalAgency: "Charlotte-Mecklenburg", historicalType: "city",
    historicalOri: "NC0600100", nibrsOri: "NC0600100", shrOri: "NC06001",
    currentAgency: "Charlotte",
    note: "Charlotte PD + Mecklenburg County Police merged 1993. No 'Charlotte' agency row exists. Survivor 1930-2025, pop 1,035,037.",
  },
  {
    alias: "Nashville", state: "TN",
    historicalAgency: "Metropolitan Nashville Police Department", historicalType: "city",
    historicalOri: "TN0190100", nibrsOri: "TN0190100", shrOri: "TN01901",
    currentAgency: "Nashville",
    note: "Metro Nashville-Davidson consolidated 1963. No 'Nashville' agency row exists. Survivor 1932-2025, pop 718,499.",
  },
  {
    alias: "Louisville", state: "KY",
    historicalAgency: "Louisville Metro", historicalType: "city",
    historicalOri: "KY0568000", nibrsOri: "KY0568000", shrOri: "KY05680", shrPredecessorOri: "KY05602",
    currentAgency: "Louisville",
    predecessor: "Louisville", predecessorLastYear: 2003,
    note: "Louisville PD + Jefferson County PD merged Jan 2003. Predecessor KY0560200 keeps NULL rows through 2024 with pop frozen at 300,404; survivor KY0568000 runs to 2025 at pop 691,630. 2003 is split across both ORIs, so it is not a usable year for either.",
  },
  {
    alias: "Macon", state: "GA",
    historicalAgency: "Bibb County", historicalType: "county",
    historicalOri: "GA0110000", nibrsOri: "GA0110000", shrOri: "GA01100",
    sourceDisplayNames: ["Bibb"],
    predecessor: "Macon", predecessorLastYear: 2013,
    note: "Macon-Bibb County consolidated 2014. Successor is filed as 'Bibb County' and shares no words with 'Macon'; the link is the population handoff 156,339 (Macon, last real 2013) -> 157,114 (Bibb County, 2025).",
  },
  {
    alias: "Augusta", state: "GA",
    historicalAgency: "Augusta-Richmond County", historicalType: "county",
    historicalOri: "GA1210000", nibrsOri: "GA1210000", shrOri: "GA12100",
    sourceDisplayNames: ["Augusta-Richmond"],
    predecessor: "Augusta", predecessorLastYear: 1996,
    note: "Augusta + Richmond County consolidated 1996. Predecessor stops at 1996 (pop 52,970 -- the old city limits only); survivor 1960-2025 at pop 201,734.",
  },
  {
    alias: "Athens", state: "GA",
    historicalAgency: "Athens-Clarke County", historicalType: "city",
    historicalOri: "GA0290100", nibrsOri: "GA0290100", shrOri: "GA02901",
    sourceDisplayNames: ["Athens-Clarke"],
    note: "Athens + Clarke County consolidated 1991. Separate failure mode: there is no GA entry for 'Athens' in the geo catalog at all, so 'Athens, GA' collided with Athens in AL/IL/OH/PA/TN/TX/WI/WV and returned a clarification request instead of an answer. Survivor 1950-2025, pop 129,208.",
  },
  {
    alias: "Butte", state: "MT",
    historicalAgency: "Butte-Silver Bow County", historicalType: "county",
    historicalOri: "MT0470000", nibrsOri: "MT0470000", shrOri: "MT04700",
    sourceDisplayNames: ["Silver Bow"],
    predecessor: "Butte-Silver Bow", predecessorLastYear: 1981,
    note: "Butte + Silver Bow County consolidated 1977. 'Butte' is not in the geo catalog under any spelling; the catalog holds 'Butte-Silver Bow', which is itself the dead city ORI (last real 1981). Survivor 1960-2025, pop 36,189.",
  },
  {
    alias: "Hartsville", state: "TN",
    historicalAgency: "Hartsville/Trousdale County", historicalType: "county",
    historicalOri: "TN0850000", nibrsOri: "TN0850000", shrOri: "TN08500",
    sourceDisplayNames: ["Trousdale"],
    predecessor: "Hartsville", predecessorLastYear: 2000,
    note: "Hartsville + Trousdale County consolidated. Predecessor last real 2000 (pop 2,410); survivor 1963-2025 at pop 12,310.",
  },
  {
    alias: "Santa Clara", state: "UT",
    historicalAgency: "Santa Clara/Ivins", historicalType: "city",
    historicalOri: "UT0271500", nibrsOri: "UT0271500", shrOri: "UT02715",
    sourceDisplayNames: ["Santa Clara/ivins"],
    predecessor: "Santa Clara", predecessorLastYear: 2011,
    note: "Santa Clara + Ivins combined PD. UT-scoped ONLY -- Santa Clara, CA is a separate live agency and must not be rewritten.",
  },
  {
    alias: "Fox Valley", state: "WI",
    historicalAgency: "Fox Valley Metro", historicalType: "city",
    historicalOri: "WI0450400", nibrsOri: "WI0450400", shrOri: "WI04504",
    sourceDisplayNames: ["Fox Valley Metro"],
    predecessor: "Fox Valley", predecessorLastYear: 2008,
    note: "Fox Valley Metro PD. Predecessor last real 2008 (pop 17,101); survivor 1960-2025 at pop 22,950.",
  },
  {
    alias: "Saugatuck", state: "MI",
    historicalAgency: "Saugatuck-Douglas", historicalType: "city",
    historicalOri: "MI0335300", nibrsOri: "MI0335300", shrOri: "MI03353",
    sourceDisplayNames: ["Douglas"],
    predecessor: "Saugatuck", predecessorLastYear: 1997,
    note: "Saugatuck + Douglas combined PD. Predecessor last real 1997 (pop 877); survivor 1971-2025 at pop 2,305.",
  },
  {
    alias: "Grand Beach", state: "MI",
    historicalAgency: "Grand Beach/Michiana", historicalType: "city",
    historicalOri: "MI1160100", nibrsOri: "MI1160100",
    predecessor: "Grand Beach", predecessorLastYear: 2019,
    note: "Grand Beach + Michiana combined PD. Predecessor last real 2019 (pop 221); survivor reports 2025 at pop 504.",
  },
  {
    alias: "Manhattan", state: "KS",
    historicalAgency: "Riley County", historicalType: "county",
    historicalOri: "KS0810000", nibrsOri: "KS0810000", shrOri: "KS08100",
    sourceDisplayNames: ["Riley County Police Department"],
    predecessor: "Manhattan", predecessorLastYear: 1992,
    note: "Manhattan PD, Ogden PD, and the Riley County Sheriff consolidated into Riley County Police Department. Historical survivor reports through 2025; NIBRS successor reports through 2026 while the city ORI has population but no summary facts.",
  },
  {
    alias: "Anaconda", state: "MT",
    historicalAgency: "Anaconda-Deer Lodge County", historicalType: "county",
    historicalOri: "MT0120000", nibrsOri: "MT0120000", shrOri: "MT01200",
    sourceDisplayNames: ["Deer Lodge"],
    predecessor: "Anaconda", predecessorLastYear: 1979,
    note: "Anaconda and Deer Lodge County consolidated in 1977. Transition-era population rows overlap, so official consolidation and the matching source ORIs provide the identity evidence.",
  },
];

/**
 * Cases that LOOK like this bug but are deliberately excluded, so a future sweep
 * does not "rediscover" them and wire in a wrong answer.
 *
 * - Jacksonville, FL: 'Jacksonville' [city] stops at 2020 (pop 654,126) while
 *   'Jacksonville County' [county] runs to 2025 (pop 1,008,920). Jacksonville/Duval
 *   did consolidate (1968), but 654,126 does not match Jacksonville's actual ~950k
 *   city population, and 2020 is also exactly when Florida agencies stopped
 *   submitting UCR during the state's NIBRS transition. Two explanations fit and the
 *   population check cannot separate them -- this needs FBI CDE confirmation before
 *   any rewrite. Left alone on purpose.
 * - Kankakee, IL: 'Kankakee' [city] and 'Kankakee County' [county] are a city PD and
 *   a county sheriff that both still exist. The city's 2020 stop is Illinois
 *   reporting, not a merger.
 * - The ~96 other "<City>" / "<City> County" name pairs found by sweeping: small
 *   cities sharing a name with their county. Not mergers.
 */
export const CONSOLIDATION_EXCLUSIONS = ["Jacksonville, FL", "Kankakee, IL"] as const;

function key(state: string, name: string): string {
  return `${state.trim().toUpperCase()}|${name.trim().toUpperCase()}`;
}

const BY_ALIAS = new Map<string, ConsolidatedAgency>();
const BY_ANY_NAME = new Map<string, ConsolidatedAgency>();
for (const entry of CONSOLIDATED_AGENCIES) {
  BY_ALIAS.set(key(entry.state, entry.alias), entry);
  // Look-ups also succeed on the formal successor name and on the dead predecessor,
  // so a question phrased "Charlotte-Mecklenburg" or "Butte-Silver Bow" lands on the
  // same entry -- and therefore gets the same display name -- as one phrased
  // "Charlotte" or "Butte".
  for (const name of [entry.alias, entry.historicalAgency, entry.predecessor, entry.currentAgency]) {
    if (name) BY_ANY_NAME.set(key(entry.state, name), entry);
  }
}

/**
 * Look up a consolidation by state and any known name for it (alias, formal
 * successor name, dead predecessor name, or RTCI name). Returns undefined for the
 * overwhelming majority of agencies, which are not consolidations.
 */
export function findConsolidatedAgency(state: string | undefined | null, name: string | undefined | null): ConsolidatedAgency | undefined {
  if (!state || !name) return undefined;
  return BY_ANY_NAME.get(key(state, name));
}

/** The display name for a place, which is the alias when one exists and the input otherwise. */
export function consolidatedDisplayName(state: string | undefined | null, name: string): string {
  return findConsolidatedAgency(state, name)?.alias ?? name;
}

/** The `historical_agency` name and type to query for a place. */
export function historicalAgencyTarget(
  state: string | undefined | null,
  name: string,
  fallbackType: "city" | "county" = "city",
): { agency: string; type: "city" | "county"; ori?: string } {
  const entry = findConsolidatedAgency(state, name);
  return entry
    ? { agency: entry.historicalAgency, type: entry.historicalType, ori: entry.historicalOri }
    : { agency: name, type: fallbackType };
}

/** Replace a source/formal agency label with the friendly alias. State keeps ambiguous names scoped. */
export function consolidatedDisplayValue(state: string | undefined | null, value: string): string {
  const known = findConsolidatedAgency(state, value);
  if (known) return known.alias;
  if (!state) return value;
  const normalizedKey = key(state, value);
  return CONSOLIDATED_AGENCIES.find((entry) =>
    entry.sourceDisplayNames?.some((name) => key(entry.state, name) === normalizedKey),
  )?.alias ?? value;
}

/** Normalize formal successor names in narrative text. Predecessor aliases are intentionally not replaced globally. */
export function consolidatedDisplayText(value: string): string {
  let output = value;
  const formal = [...CONSOLIDATED_AGENCIES].sort((a, b) => b.historicalAgency.length - a.historicalAgency.length);
  for (const entry of formal) {
    const escaped = entry.historicalAgency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output.replace(new RegExp(`\\b${escaped}\\b`, "gi"), entry.alias);
  }
  return output;
}

export function normalizeConsolidatedDisplayRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const agencyColumns = new Set(["agency", "agency_name", "canonical_agency", "city", "jurisdiction"]);
  return rows.map((row) => {
    const state = typeof row.state === "string" ? row.state : typeof row.state_abbr === "string" ? row.state_abbr : undefined;
    const next = { ...row };
    let changed = false;
    for (const column of Object.keys(next)) {
      if (!agencyColumns.has(column.toLowerCase()) || typeof next[column] !== "string") continue;
      const normalized = consolidatedDisplayValue(state, String(next[column]));
      const display = normalized === next[column] ? consolidatedDisplayText(normalized) : normalized;
      if (display !== next[column]) { next[column] = display; changed = true; }
    }
    return changed ? next : row;
  });
}

/** Alias groups for the source mapper, as `STATE|NORMALIZED_NAME` -> candidate agency names, successor first. */
export function consolidationAliasGroups(): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const entry of CONSOLIDATED_AGENCIES) {
    const names = [entry.historicalAgency, entry.alias, entry.predecessor].filter((n): n is string => Boolean(n));
    groups.set(key(entry.state, entry.alias), [...new Set(names.map((n) => n.toUpperCase()))]);
  }
  return groups;
}

export function isExcludedFromConsolidation(state: string, name: string): boolean {
  return (CONSOLIDATION_EXCLUSIONS as readonly string[]).includes(`${name}, ${state.toUpperCase()}`);
}

/** The RTCI (`agencies.agency`) name for a place, used only for cross-checking counts. */
export function consolidatedRtciAgency(state: string | undefined | null, name: string): string {
  const entry = findConsolidatedAgency(state, name);
  return entry?.currentAgency ?? entry?.alias ?? name;
}

const escapeForRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Does this SQL actually target the post-consolidation successor?
 *
 * Two accepted forms. The successor ORI literal is the unambiguous one. The other is
 * the successor's OWN historical agency name scoped to its state, which is what the
 * model naturally writes -- `ha.agency = 'Louisville Metro' AND ha.state = 'ky'` joins
 * to exactly KY0568000, so refusing it rejected a correct answer.
 *
 * The predecessor stays blocked: the name match is an exact quoted equality, so
 * `agency = 'Louisville'` (dead after the 2003 merger, population frozen at 300,404)
 * cannot satisfy a target whose successor is `'Louisville Metro'`.
 *
 * The state predicate is not optional. "Bibb County" is Macon's successor in GA and is
 * also a real, unrelated agency in AL, so the name alone would admit the wrong state.
 */
export function consolidationTargetSatisfied(sql: string, entry: ConsolidatedAgency): boolean {
  const upper = sql.toUpperCase();
  if (upper.includes(entry.historicalOri)) return true;
  const namePattern = new RegExp(`AGENCY\\s*=\\s*'${escapeForRegExp(entry.historicalAgency.toUpperCase())}'`);
  const statePattern = new RegExp(`STATE\\s*=\\s*'${escapeForRegExp(entry.state.toUpperCase())}'`);
  return namePattern.test(upper) && statePattern.test(upper);
}
