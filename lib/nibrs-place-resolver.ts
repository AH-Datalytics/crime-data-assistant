import Database from "better-sqlite3";
import { buildQueryContract, type QueryContract, type QueryContractGeography } from "./query-contract";
import { pastCompleteCalendarYearsRange } from "./time-conventions";
import type { SourceResolutionStatus } from "./source-contracts";
import { findConsolidatedAgency } from "./agency-consolidations";
import { cityLookupCandidates } from "./nibrs-city-aliases";
import { findNibrsAgencyAlias } from "./nibrs-agency-aliases";
import { containsInternalLeak } from "./scaffold-helpers";

export type NibrsPlaceKind =
  | "city_police"
  | "county_police"
  | "sheriff"
  | "agency"
  | "campus"
  | "covered";

export type NibrsResolutionStatus = SourceResolutionStatus;

export type NibrsOriYear = {
  year: number;
  ori: string;
  population: number | null;
};

export type NibrsOriRange = {
  ori: string;
  startYear: number;
  endYear: number;
};

export type NibrsResolvedPlace = {
  contractIndex: number;
  requestedName: string;
  label: string;
  state: string;
  kind: NibrsPlaceKind;
  status: NibrsResolutionStatus;
  confidence: "high" | "medium" | "low";
  oriYears: NibrsOriYear[];
  oriRanges: NibrsOriRange[];
  reason: string;
};

export type NibrsPlaceResolutionPlan = {
  question: string;
  startYear: number;
  endYear: number;
  places: NibrsResolvedPlace[];
  hasStateComparison: boolean;
  elapsedMs: number;
};

type AgencyRow = {
  ori: string;
  year: number;
  population: number | null;
  pop_group: string | null;
  agency_type: string | null;
};

type CrosswalkRow = {
  ori: string | null;
  ori9: string | null;
  agency_name: string | null;
};

const resolverCache = new WeakMap<Database.Database, Map<string, NibrsResolvedPlace>>();

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table));
}

function normalized(value: string): string {
  return value
    .toUpperCase()
    .replace(/\bDEPARTMENT\b/g, "DEPT")
    .replace(/\bPOLICE\b/g, "PD")
    .replace(/\bSHERIFF(?:'S)?\s+OFFICE\b/g, "SHERIFF")
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceStates(geography: QueryContractGeography): string[] {
  const source = geography.sourceCodes?.nibrs ?? geography.state;
  const values = Array.isArray(source) ? source : source ? [source] : [];
  return values.map((value) => value.toUpperCase());
}

function requestedYears(contract: QueryContract): { startYear: number; endYear: number } {
  const currentYear = new Date().getFullYear();
  if (contract.time.startYear !== null) {
    return {
      startYear: contract.time.startYear,
      endYear: contract.time.endYear ?? currentYear,
    };
  }
  if (contract.time.endYear !== null) {
    return { startYear: contract.time.endYear, endYear: contract.time.endYear };
  }
  if (contract.time.partialYear) return { startYear: currentYear, endYear: currentYear };
  const range = pastCompleteCalendarYearsRange(5);
  return { startYear: range.start, endYear: range.end };
}

function compressOriYears(rows: NibrsOriYear[]): NibrsOriRange[] {
  const ordered = [...rows].sort((a, b) => a.year - b.year || a.ori.localeCompare(b.ori));
  const ranges: NibrsOriRange[] = [];
  for (const row of ordered) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.ori === row.ori && previous.endYear + 1 === row.year) {
      previous.endYear = row.year;
    } else {
      ranges.push({ ori: row.ori, startYear: row.year, endYear: row.year });
    }
  }
  return ranges;
}

/**
 * Recover the years an agency reported under a different `city` label.
 *
 * The source was re-normalized at 2017 and a number of agencies changed the city string they file
 * under while keeping the same ORI -- Everglades City becomes Everglades, Heber becomes Heber City,
 * Worcester becomes Snow Hill -- so a lookup by city name finds only the half of the requested range
 * that matches the label it searched for. `city` is a label; `ori` is the identity.
 *
 * Strictly a gap-fill. It only adds years that the city lookup left empty, and never replaces a year
 * whose primary agency was already chosen, so an ORI that legitimately lost primacy in some year
 * cannot reclaim it here.
 */
function fillRenamedYears(
  db: Database.Database,
  chosen: NibrsOriYear[],
  states: string[],
  startYear: number,
  endYear: number
): NibrsOriYear[] {
  if (chosen.length === 0) return chosen;
  const claimed = new Set(chosen.map((item) => item.year));
  const missing: number[] = [];
  for (let year = startYear; year <= endYear; year += 1) if (!claimed.has(year)) missing.push(year);
  if (missing.length === 0 || states.length === 0) return chosen;

  const oris = [...new Set(chosen.map((item) => item.ori))];
  const rows = db.prepare(`
    SELECT ori, year, population, pop_group, agency_type
    FROM agencies
    WHERE ori IN (${oris.map(() => "?").join(",")})
      AND state IN (${states.map(() => "?").join(",")})
      AND agency_type = 'City'
      AND population > 0
      AND year IN (${missing.map(() => "?").join(",")})
    ORDER BY year, pop_group, population DESC, ori
  `).all(...oris, ...states, ...missing) as AgencyRow[];
  if (rows.length === 0) return chosen;

  const filled = [...chosen];
  for (const item of choosePrimaryByYear(rows)) {
    if (!claimed.has(item.year)) filled.push(item);
  }
  return filled.sort((a, b) => a.year - b.year);
}

function choosePrimaryByYear(rows: AgencyRow[]): NibrsOriYear[] {
  const byYear = new Map<number, AgencyRow[]>();
  for (const row of rows) {
    const values = byYear.get(row.year) ?? [];
    values.push(row);
    byYear.set(row.year, values);
  }
  return [...byYear.entries()]
    .sort(([a], [b]) => a - b)
    .map(([year, candidates]) => {
      candidates.sort((a, b) =>
        String(a.pop_group ?? "ZZ").localeCompare(String(b.pop_group ?? "ZZ")) ||
        Number(b.population ?? 0) - Number(a.population ?? 0) ||
        a.ori.localeCompare(b.ori)
      );
      const winner = candidates[0];
      return { year, ori: winner.ori, population: winner.population };
    });
}

function placeResult(
  geography: QueryContractGeography,
  contractIndex: number,
  kind: NibrsPlaceKind,
  status: NibrsResolutionStatus,
  oriYears: NibrsOriYear[],
  reason: string,
  label?: string
): NibrsResolvedPlace {
  return {
    contractIndex,
    requestedName: geography.name ?? "",
    label: label ?? geography.canonicalName ?? `${geography.name}, ${geography.state}`,
    state: geography.state ?? "",
    kind,
    status,
    confidence: status === "resolved" ? "high" : status === "ambiguous" ? "low" : "medium",
    oriYears,
    oriRanges: compressOriYears(oriYears),
    reason,
  };
}

function resolveCity(
  db: Database.Database,
  geography: QueryContractGeography,
  contractIndex: number,
  startYear: number,
  endYear: number,
  cityName = geography.name ?? ""
): NibrsResolvedPlace {
  const states = sourceStates(geography);
  if (!cityName || states.length === 0) {
    return placeResult(geography, contractIndex, "city_police", "unsupported", [], "City and state are required.");
  }
  const consolidated = states
    .map((state) => findConsolidatedAgency(state, cityName))
    .find((entry) => Boolean(entry));
  if (consolidated) {
    if (!consolidated.nibrsOri) {
      return placeResult(geography, contractIndex, "city_police", "not_in_source", [], "Registry records no surviving NIBRS agency for this consolidation.", `${consolidated.alias}, ${consolidated.state}`);
    }
    const rows = db.prepare(`
      SELECT ori, year, population, pop_group, agency_type
      FROM agencies WHERE ori = ? AND year BETWEEN ? AND ? ORDER BY year
    `).all(consolidated.nibrsOri, startYear, endYear) as AgencyRow[];
    const oriYears = rows.map((row) => ({ year: row.year, ori: row.ori, population: row.population }));
    return oriYears.length > 0
      ? placeResult(geography, contractIndex, "city_police", "resolved", oriYears, "Resolved through the verified consolidated-agency successor ORI.", `${consolidated.alias}, ${consolidated.state}`)
      : placeResult(geography, contractIndex, "city_police", "covered", [], `The successor ORI has no agency rows during ${startYear}-${endYear}.`, `${consolidated.alias}, ${consolidated.state}`);
  }
  // A city whose real agency the ordinary lookup cannot reach, because it files
  // as something other than agency_type 'City'. NIBRS-only: this never affects
  // Historical. See lib/nibrs-agency-aliases.
  const nibrsAlias = states
    .map((state) => findNibrsAgencyAlias(state, cityName))
    .find((entry) => Boolean(entry));
  if (nibrsAlias) {
    const rows = db.prepare(`
      SELECT ori, year, population, pop_group, agency_type
      FROM agencies WHERE ori = ? AND year BETWEEN ? AND ? ORDER BY year
    `).all(nibrsAlias.nibrsOri, startYear, endYear) as AgencyRow[];
    const oriYears = rows.map((row) => ({ year: row.year, ori: row.ori, population: row.population }));
    // No label override: the display name stays whatever the user asked for.
    return oriYears.length > 0
      ? placeResult(geography, contractIndex, "city_police", "resolved", oriYears, "Resolved through the verified NIBRS agency alias for a city whose department does not file as a City agency.")
      : placeResult(geography, contractIndex, "city_police", "covered", [], `The registered NIBRS agency has no rows during ${startYear}-${endYear}.`);
  }

  const placeholders = states.map(() => "?").join(",");
  // Every spelling the agencies table might file this city under. Matching one
  // literal silently picks whichever agency happens to carry it -- see
  // lib/nibrs-city-aliases.
  const cityCandidates = cityLookupCandidates(cityName);
  const cityPlaceholders = cityCandidates.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ori, year, population, pop_group, agency_type
    FROM agencies
    WHERE city IN (${cityPlaceholders})
      AND state IN (${placeholders})
      AND agency_type = 'City'
      AND population > 0
      AND year BETWEEN ? AND ?
    ORDER BY year, pop_group, population DESC, ori
  `).all(...cityCandidates, ...states, startYear, endYear) as AgencyRow[];
  const oriYears = fillRenamedYears(db, choosePrimaryByYear(rows), states, startYear, endYear);
  if (oriYears.length > 0) {
    return placeResult(
      geography,
      contractIndex,
      "city_police",
      "resolved",
      oriYears,
      `Resolved the primary city agency for ${oriYears.length} requested year(s).`
    );
  }

  const historical = db.prepare(`
    SELECT MIN(year) AS first_year, MAX(year) AS last_year
    FROM agencies
    WHERE city IN (${cityPlaceholders}) AND state IN (${placeholders}) AND agency_type = 'City'
  `).get(...cityCandidates, ...states) as { first_year: number | null; last_year: number | null } | undefined;
  const crosswalk = tableExists(db, "agency_county_crosswalk")
    ? db.prepare(`
        SELECT 1
        FROM agency_county_crosswalk
        WHERE state IN (${placeholders}) AND upper(agency_name) = ?
        LIMIT 1
      `).get(...states, cityName.toUpperCase())
    : null;
  if (historical?.first_year != null || crosswalk) {
    return placeResult(
      geography,
      contractIndex,
      "covered",
      "covered",
      [],
      `No active city-agency ORI exists for ${startYear}-${endYear}. The jurisdiction may be inactive or served under a coverage/contract arrangement; no covering agency can be safely inferred.`
    );
  }
  return placeResult(geography, contractIndex, "city_police", "not_in_source", [], "No matching NIBRS city agency was found.");
}

function agencyLocation(name: string): string {
  return normalized(name)
    .replace(/\bCOUNTY\s+(?:SHERIFF|PD)(?:\s+DEPT)?\b/g, " ")
    .replace(/\b(?:SHERIFF|PD)(?:\s+DEPT)?\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which spelling the source actually carries, decided without reference to the requested years.
 *
 * Returns the single candidate that exists; "ambiguous" when the catalogue carries both as separate
 * agencies -- 27 (state, name) pairs do, and at least eight are genuinely different municipalities --
 * and a null name when it carries neither, which the caller passes on to the ordinary lookup so it
 * can distinguish "no rows in these years" from "not in the source".
 */
function chooseCityIdentity(
  db: Database.Database,
  states: string[],
  candidates: string[]
): { kind: "single" | "none" | "ambiguous"; name: string | null; candidates: string[] } {
  if (states.length === 0) return { kind: "none", name: null, candidates };
  const statePlaceholders = states.map(() => "?").join(",");
  const present = candidates.filter((candidate) => {
    const literals = cityLookupCandidates(candidate);
    if (literals.length === 0) return false;
    const row = db.prepare(`
      SELECT 1 AS present
      FROM agencies
      WHERE city IN (${literals.map(() => "?").join(",")})
        AND state IN (${statePlaceholders})
        AND agency_type = 'City'
      LIMIT 1
    `).get(...literals, ...states) as { present?: number } | undefined;
    return Boolean(row?.present);
  });
  // Candidates are supplied in preference order, the name as written first. When both spellings are
  // real agencies -- REDWOOD and REDWOOD CITY both are -- the one the user actually typed decides,
  // because that is an exact match against the catalogue and settles identity without consulting the
  // requested years at all. Choosing on row availability instead is precisely what handed back the
  // wrong town. Nothing here is ambiguous once the exact written name is present.
  const chosen = candidates.find((candidate) => present.includes(candidate));
  return chosen
    ? { kind: "single", name: chosen, candidates: present }
    : { kind: "none", name: null, candidates };
}

function resolveCountyAgency(
  db: Database.Database,
  geography: QueryContractGeography,
  contractIndex: number,
  startYear: number,
  endYear: number,
  kind: "sheriff" | "county_police"
): NibrsResolvedPlace {
  const states = sourceStates(geography);
  const location = agencyLocation(geography.name ?? "");
  if (!location || states.length === 0) {
    return placeResult(geography, contractIndex, kind, "unsupported", [], "County agency and state are required.");
  }
  if (!tableExists(db, "agency_county_crosswalk")) {
    return placeResult(geography, contractIndex, kind, "unsupported", [], "The agency county crosswalk is unavailable.");
  }
  const placeholders = states.map(() => "?").join(",");
  const crosswalk = db.prepare(`
    SELECT ori, ori9, agency_name
    FROM agency_county_crosswalk
    WHERE state IN (${placeholders}) AND county_key = ?
    ORDER BY agency_name, ori9
  `).all(...states, location) as CrosswalkRow[];
  const candidates = crosswalk.filter((row) => {
    const agencyName = normalized(row.agency_name ?? "");
    const ori = row.ori9 ?? row.ori ?? "";
    if (kind === "county_police") {
      return agencyName.includes(location) && /\bCOUNTY\s+PD\b/.test(agencyName);
    }
    return /\bSHERIFF\b/.test(agencyName) || ori.endsWith("0000");
  });
  const candidateOris = [...new Set(candidates.map((row) => row.ori9 ?? row.ori).filter((ori): ori is string => Boolean(ori)))];
  if (candidateOris.length === 0) {
    return placeResult(geography, contractIndex, kind, "not_in_source", [], "No exact county-agency crosswalk match was found.");
  }
  const oriPlaceholders = candidateOris.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ori, year, population, pop_group, agency_type
    FROM agencies
    WHERE ori IN (${oriPlaceholders})
      AND year BETWEEN ? AND ?
      AND agency_type = 'County'
    ORDER BY year, population DESC, ori
  `).all(...candidateOris, startYear, endYear) as AgencyRow[];
  const oriYears = choosePrimaryByYear(rows);
  const orisByYear = new Map<number, Set<string>>();
  for (const row of rows) {
    const values = orisByYear.get(row.year) ?? new Set<string>();
    values.add(row.ori);
    orisByYear.set(row.year, values);
  }
  if (oriYears.length === 0) {
    return placeResult(geography, contractIndex, kind, "not_in_source", [], "The crosswalk match has no agency rows in the requested years.");
  }
  if ([...orisByYear.values()].some((values) => values.size > 1)) {
    return placeResult(geography, contractIndex, kind, "ambiguous", oriYears, "Multiple county agencies remain after exact type matching.");
  }
  return placeResult(
    geography,
    contractIndex,
    kind,
    "resolved",
    oriYears,
    `Resolved ${kind === "sheriff" ? "the sheriff/county agency" : "the county police department"} by exact state, county key, and agency type.`
  );
}

function resolveGeography(
  db: Database.Database,
  geography: QueryContractGeography,
  contractIndex: number,
  startYear: number,
  endYear: number
): NibrsResolvedPlace {
  if (geography.kind === "city") return resolveCity(db, geography, contractIndex, startYear, endYear);
  if (geography.kind === "campus") {
    return placeResult(geography, contractIndex, "campus", "unsupported", [], "Campus agencies continue through the specialized campus resolver.");
  }
  if (geography.kind !== "agency") {
    return placeResult(geography, contractIndex, "agency", "unsupported", [], "This geography is not a single local agency.");
  }
  const name = geography.name ?? "";
  if (/\bcounty\s+police\b/i.test(name)) {
    return resolveCountyAgency(db, geography, contractIndex, startYear, endYear, "county_police");
  }
  if (/\bsheriff\b/i.test(name)) {
    return resolveCountyAgency(db, geography, contractIndex, startYear, endYear, "sheriff");
  }
  // "Pocomoke City Police Department" is genuinely ambiguous: the trailing "City" may belong to the
  // place name or to the department's style, and the string cannot say which. 376 distinct
  // municipalities in `agencies` have names ending in "City", so neither reading can be assumed --
  // consuming the "City" resolved GC-084's police department to a city that does not exist, and a
  // regex that special-cases one name would fix one of 376. Try the name as written first, then the
  // stripped form, and let the source decide which one it actually files under.
  const cityPolice = name.match(/^(.+?)\s+police\s+(?:department|dept\.?)$/i);
  if (cityPolice) {
    const asWritten = cityPolice[1];
    const stripped = asWritten.replace(/\s+city$/i, "");
    if (stripped === asWritten) {
      return resolveCity(db, geography, contractIndex, startYear, endYear, asWritten);
    }
    // Identity first, availability second. Choosing whichever spelling happened to have rows in the
    // requested range let a year with no data fall through to a DIFFERENT municipality: asked for
    // Redwood City PD in a year REDWOOD CITY did not report, the resolver answered with REDWOOD --
    // a separate town of 5,604 people. Which agency was meant is a question about the source's
    // catalogue, not about the years requested, so it is settled without the year filter first.
    const identity = chooseCityIdentity(db, sourceStates(geography), [asWritten, stripped]);
    if (identity.kind === "ambiguous") {
      return placeResult(geography, contractIndex, "city_police", "ambiguous", [],
        `Both "${identity.candidates[0]}" and "${identity.candidates[1]}" exist as separate agencies here, ` +
        `so the name alone does not say which was meant.`);
    }
    // A name the catalogue does not carry at all still goes through resolveCity, which distinguishes
    // "covered but not in these years" from "not in the source" better than this function can.
    return resolveCity(db, geography, contractIndex, startYear, endYear, identity.name ?? asWritten);
  }
  return placeResult(geography, contractIndex, "agency", "unsupported", [], "The named agency needs an exact crosswalk or specialized resolver.");
}

export function resolveNibrsPlaces(
  db: Database.Database,
  question: string,
  contract: QueryContract | null = buildQueryContract(question, "nibrs")
): NibrsPlaceResolutionPlan | null {
  if (!contract) return null;
  const started = performance.now();
  const years = requestedYears(contract);
  const stateGeographies = contract.geographies.filter((geography) => geography.kind === "state" && geography.state);
  const hasStateComparison =
    stateGeographies.length > 0 &&
    /\b(?:compare|versus|vs\.?|and)\b/i.test(question);
  const disambiguatingState = !hasStateComparison && stateGeographies.length === 1
    ? stateGeographies[0]
    : null;
  const local = contract.geographies
    .map((geography, contractIndex) => {
      if (
        disambiguatingState &&
        ["city", "agency", "campus"].includes(geography.kind) &&
        (geography.confidence === "low" || geography.needsClarification.length > 0)
      ) {
        return {
          contractIndex,
          geography: {
            ...geography,
            state: disambiguatingState.state,
            sourceCodes: disambiguatingState.sourceCodes,
            confidence: "high" as const,
            needsClarification: [],
          },
        };
      }
      return { geography, contractIndex };
    })
    .filter(({ geography }) => ["city", "agency", "campus"].includes(geography.kind));
  if (local.length === 0) return null;

  let cache = resolverCache.get(db);
  if (!cache) {
    cache = new Map();
    resolverCache.set(db, cache);
  }
  const places = local.map(({ geography, contractIndex }) => {
    const key = [
      "nibrs",
      geography.kind,
      geography.state,
      geography.name,
      years.startYear,
      years.endYear,
    ].join("|").toUpperCase();
    const cached = cache!.get(key);
    if (cached) return { ...cached, contractIndex };
    let resolved: NibrsResolvedPlace;
    try {
      resolved = resolveGeography(db, geography, contractIndex, years.startYear, years.endYear);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      resolved = placeResult(
        geography,
        contractIndex,
        geography.kind === "city" ? "city_police" : "agency",
        "unsupported",
        [],
        `Resolver lookup failed safely: ${reason}`
      );
    }
    cache!.set(key, resolved);
    return resolved;
  });
  return {
    question,
    startYear: years.startYear,
    endYear: years.endYear,
    places,
    hasStateComparison,
    elapsedMs: Number((performance.now() - started).toFixed(1)),
  };
}

export function resolvedPlaceForContractIndex(
  plan: NibrsPlaceResolutionPlan | null | undefined,
  contractIndex: number
): NibrsResolvedPlace | null {
  return plan?.places.find((place) => place.contractIndex === contractIndex && place.status === "resolved") ?? null;
}

export function formatNibrsResolutionGuidance(plan: NibrsPlaceResolutionPlan | null): string | null {
  if (!plan) return null;
  const resolved = plan.places.filter((place) => place.status === "resolved");
  if (resolved.length === 0) return null;
  const lines = resolved.map((place) => {
    const ranges = place.oriRanges.map((range) =>
      `${range.ori} for ${range.startYear}-${range.endYear}`
    ).join("; ");
    return `- ${place.label}: ${ranges}`;
  });
  return [
    "[SYSTEM: Deterministic NIBRS agency resolution completed before SQL generation.",
    "Use these ORIs for the corresponding local geography and correlate each ORI to its stated years.",
    "Do not broaden a local branch with city-name, county-name, or agency-name substring matching.",
    ...lines,
    "State or national comparison branches may use their proper aggregate scope.]",
  ].join("\n");
}

/**
 * Enforcement wrapper around the warn-only audit. Fires only when the SQL selects
 * agencies by city NAME while verified ORIs already exist for the resolved city
 * places -- the exact shape that summed twelve same-named agencies into
 * "St. Louis" in production 8376 (163 murders against SLMPD's real 131) and
 * dropped Jacksonville, whose sheriff's office is not agency_type = 'City'.
 *
 * SQL with no city predicate (state and national aggregate branches) is left to
 * the warn-only audit, because matching by state there is correct.
 *
 * Returns a retry issue rather than rewriting the SQL: substituting ORIs into an
 * arbitrary multi-city, multi-year query is easy to get subtly wrong, so the
 * route retries and then blocks.
 */
export function resolvedOriEnforcementIssue(
  plan: NibrsPlaceResolutionPlan | null,
  sql: string
): { issue: string; labels: string[] } | null {
  if (!plan) return null;
  if (!/\bcity\s*(?:=|\bIN\b|\bLIKE\b)/i.test(sql)) return null;
  const cityPlaces = plan.places.filter(
    (place) => place.status === "resolved" && place.kind === "city_police"
  );
  if (cityPlaces.length === 0) return null;
  const upperSql = sql.toUpperCase();
  const missing = cityPlaces.filter((place) => {
    const oris = [...new Set(place.oriYears.map((item) => item.ori))];
    return !oris.some((ori) => upperSql.includes(ori.toUpperCase()));
  });
  if (missing.length === 0) return null;
  const lines = missing.map((place) => {
    const ranges = place.oriRanges
      .map((range) => `${range.ori} for ${range.startYear}-${range.endYear}`)
      .join("; ");
    return `- ${place.label}: ${ranges}`;
  });
  return {
    labels: missing.map((place) => place.label),
    issue: [
      "[SYSTEM: Your SQL selects agencies by city name, but deterministic resolution already identified the exact agency ORIs for these places. City-name matching pulls in unrelated agencies that share a mailing city, and misses agencies whose type is not 'City'. Rewrite the query to filter the fact table by these ORIs (ori IN (...), or one branch per place) and remove the city-name predicates for them:",
      ...lines,
      "]",
    ].join("\n"),
  };
}

/**
 * How a candidate answer covers the members the question actually named.
 *
 * `plan.places` is one entry per requested local geography, so this is the question's own member
 * list rather than anything inferred from the SQL. Coverage uses the same uppercase ORI test as
 * `auditNibrsResolvedOriUsage`, so the warning and the enforcement can never disagree about whether
 * a place is in the query.
 */
export type NibrsMemberCoverage = {
  /** Every named member, whatever became of it. */
  requested: NibrsResolvedPlace[];
  /** Resolved, and at least one of its ORIs appears in the SQL. */
  covered: NibrsResolvedPlace[];
  /** Resolved to real ORIs, and absent from the SQL: an answer that silently drops it. */
  omitted: NibrsResolvedPlace[];
  /** Named but never resolved to an ORI, so no SQL could have carried it. */
  unresolved: NibrsResolvedPlace[];
};

export function nibrsMemberCoverage(
  plan: NibrsPlaceResolutionPlan | null,
  sql: string
): NibrsMemberCoverage | null {
  if (!plan || plan.places.length === 0) return null;
  const upperSql = (sql || "").toUpperCase();
  const inSql = (place: NibrsResolvedPlace) =>
    [...new Set(place.oriYears.map((item) => item.ori))]
      .some((ori) => upperSql.includes(ori.toUpperCase()));
  const resolved = plan.places.filter((place) => place.status === "resolved");
  return {
    requested: plan.places,
    covered: resolved.filter(inSql),
    omitted: resolved.filter((place) => !inSql(place)),
    unresolved: plan.places.filter((place) => place.status !== "resolved"),
  };
}

/**
 * A question named several agencies, the SQL answers for some of them, and the rest are simply
 * gone. That is the failure this exists to stop: not a refusal, which is visibly unhelpful, but a
 * confident answer about a subset presented as the whole.
 *
 * Deliberately narrow in two ways. It needs at least two named members, because a single-agency
 * answer cannot be a subset of itself. And it needs at least one member *covered*, which is what
 * makes it certain the query is about these members at all -- a state-level query that happens to
 * follow a resolved place is not an omission, and `auditNibrsResolvedOriUsage` already warns when
 * nothing resolved is used.
 */
export function omittedMemberEnforcementIssue(
  plan: NibrsPlaceResolutionPlan | null,
  sql: string
): { issue: string; labels: string[]; requested: number; covered: number } | null {
  const coverage = nibrsMemberCoverage(plan, sql);
  if (!coverage) return null;
  if (coverage.requested.length < 2) return null;
  if (coverage.omitted.length === 0) return null;

  // SQL that identifies agencies by city label carries no ORI at all, so `covered` is zero and the
  // "at least one covered" precondition would silence this rule on the very identity confusion the
  // milestone is about. `resolvedOriEnforcementIssue` already enforces that shape -- but only where a
  // resolved city_police member exists. When every named member is a county agency (two sheriffs, say,
  // and sheriffs do file under a city label: MD0240000 is SNOW HILL) nothing would fire at all. Take
  // label identity as the trigger in exactly that otherwise-uncovered case, and nowhere else, so the
  // two rules compose instead of both firing.
  const identifiesByCityLabel = /\bcity\s*(?:=|\bIN\b|\bLIKE\b)/i.test(sql || "");
  const cityPoliceResolved = coverage.requested
    .some((place) => place.status === "resolved" && place.kind === "city_police");
  const labelIdentifiedGap = coverage.covered.length === 0 && identifiesByCityLabel && !cityPoliceResolved;
  if (coverage.covered.length === 0 && !labelIdentifiedGap) return null;
  const lines = coverage.omitted.map((place) => {
    const ranges = place.oriRanges
      .map((range) => `${range.ori} for ${range.startYear}-${range.endYear}`)
      .join("; ");
    return `- ${place.label}: ${ranges || [...new Set(place.oriYears.map((item) => item.ori))].join(", ")}`;
  });
  return {
    labels: coverage.omitted.map((place) => place.label),
    // Carried so a caller states the real counts instead of deriving them from the omitted list,
    // which is only correct while exactly one member is covered.
    requested: coverage.requested.length,
    covered: coverage.covered.length,
    issue: [
      `[SYSTEM: The question named ${coverage.requested.length} agencies and your SQL returns data for only ` +
        `${coverage.covered.length} of them. Answering for a subset without saying so reports one agency's ` +
        `figures as though they covered every agency asked about. Include these resolved agencies in the ` +
        `query as well -- add their ORIs to the filter and keep each agency distinguishable in the output, ` +
        `rather than summing them into one undifferentiated total:`,
      ...lines,
      "]",
    ].join("\n"),
  };
}

/**
 * Requested members that could not be resolved at all, when others could.
 *
 * There is no SQL fix for these -- the source has no agency to query -- so the answer has to say
 * which ones are missing instead of quietly narrowing to the ones that worked. Silent on a
 * single-member question, where the whole answer is already about that one place.
 */
export function unresolvedMemberDisclosure(
  plan: NibrsPlaceResolutionPlan | null
): { note: string; labels: string[]; unsafeLabel: boolean } | null {
  if (!plan || plan.places.length < 2) return null;
  const resolved = plan.places.filter((place) => place.status === "resolved");
  const unresolved = plan.places.filter((place) => place.status !== "resolved");
  if (resolved.length === 0 || unresolved.length === 0) return null;
  // Labels come from the user's question, so one can carry text the internal-leak firewall refuses --
  // an agency "name" containing a table name, for instance. Naming it would make the whole explanation
  // be replaced by the safe message, taking this disclosure with it and leaving the answer claiming a
  // coverage it does not have. So the limitation is stated either way: with names when they are safe
  // to render, and by count when they are not. The firewall is never bypassed; the sentence is written
  // so it has nothing to catch.
  const names = unresolved.map((place) => place.label);
  const safeNames = names.filter((name) => !containsInternalLeak(name));
  const covered = resolved.map((place) => place.label).filter((label) => !containsInternalLeak(label));
  const coveredText = covered.length === resolved.length && covered.length > 0
    ? covered.join(", ")
    : `${resolved.length} of the agencies you named`;

  /** The same safe-naming rule as above, applied to one group of members. */
  const phraseFor = (group: NibrsResolvedPlace[]) => {
    const groupNames = group.map((place) => place.label);
    const safe = groupNames.filter((name) => !containsInternalLeak(name));
    const listed = safe.length === groupNames.length && groupNames.length > 0
      ? (groupNames.length === 1
        ? groupNames[0]
        : `${groupNames.slice(0, -1).join(", ")} and ${groupNames[groupNames.length - 1]}`)
      : (groupNames.length === 1 ? "another agency you named" : `${groupNames.length} other agencies you named`);
    return { listed, singular: groupNames.length === 1 };
  };

  // TWO DIFFERENT FACTS, AND THEY ARE NOT INTERCHANGEABLE.
  //
  // `covered` is the resolver's word for an agency it DID identify and that simply has no rows in the
  // requested years. Reporting it as one that "could not be matched to an agency in this data" told
  // the reader the source does not know the agency, which is false and is the opposite of what the
  // resolver recorded; the honest limitation is about the PERIOD, not the identity. Collapsing the
  // two also hid which one a follow-up question could actually fix.
  const unavailable = unresolved.filter((place) => place.status === "covered");
  const unmatched = unresolved.filter((place) => place.status !== "covered");
  const clauses: string[] = [];
  if (unmatched.length > 0) {
    const { listed, singular } = phraseFor(unmatched);
    clauses.push(
      `${listed} ${singular ? "was" : "were"} also asked about but could not be matched to an agency in this data`
    );
  }
  if (unavailable.length > 0) {
    const { listed, singular } = phraseFor(unavailable);
    clauses.push(
      `${listed} ${singular ? "is a known agency that has" : "are known agencies that have"} no data in this ` +
      `source for ${plan.startYear}-${plan.endYear}`
    );
  }
  const singularAll = names.length === 1;
  return {
    labels: names,
    unsafeLabel: safeNames.length !== names.length || covered.length !== resolved.length,
    note:
      `This answer covers ${coveredText} only. ` +
      `${clauses.join("; ")}, so ${singularAll ? "it is" : "they are"} not included in these figures.`,
  };
}

/**
 * Which named members the ANSWER actually contains, read from the returned rows.
 *
 * An identifier appearing in query text is not membership. Executed witnesses show a requested ORI
 * present in the SQL and absent from the result in at least four ways: an unused CTE that mentions
 * it, a HAVING that removes it, a LIMIT that truncates it away, and ordinary omission. Being allowed
 * by a filter is not being returned. So this reads the rows that were produced, whatever SQL, retry
 * or rewrite produced them -- which also means one check covers every execution path instead of one
 * check per SQL site.
 *
 * `identifiable` is false when no returned cell carries any member's ORI or label: the result shape
 * cannot say who the numbers belong to, which for a multi-agency question is its own failure rather
 * than evidence of absence.
 */
export type NibrsDeliveredMembership = {
  requested: NibrsResolvedPlace[];
  resolved: NibrsResolvedPlace[];
  returned: NibrsResolvedPlace[];
  missing: NibrsResolvedPlace[];
  unresolved: NibrsResolvedPlace[];
  identifiable: boolean;
};

export function nibrsDeliveredMembership(
  plan: NibrsPlaceResolutionPlan | null,
  rows: Record<string, unknown>[]
): NibrsDeliveredMembership | null {
  if (!plan || plan.places.length === 0) return null;
  const cells = new Set<string>();
  for (const row of rows ?? []) {
    for (const value of Object.values(row ?? {})) {
      if (value === null || value === undefined) continue;
      const text = String(value).trim().toUpperCase();
      if (text) cells.add(text);
    }
  }
  // An answer may identify its members by ORI or by name, and a name arrives in a few FORMATS:
  // "Chicago, IL" as a label against "CHICAGO" in a city column, or the requested name with its
  // "Police Department" suffix. Those are formatting differences, and normalizing both sides then
  // comparing for EQUALITY settles them.
  //
  // Deliberately NOT containment. Within a single state, 2,930 real city names are proper substrings
  // of other real city names -- JACKSON in JACKSONVILLE, FAYETTE in LAFAYETTE, MOBILE in
  // "MOBILE REGIONAL AIRPORT", and NJ's UNION inside UNION CITY, UNION BEACH and UNION TOWNSHIP. A
  // loose match would accept a different agency's rows as proof the requested member was present, so
  // the omission would stop firing -- this milestone's own defect, inverted, and invisible to a suite
  // whose decoys all stay silent. Where equality is not enough, the answer is the ORI, not a looser
  // string test.
  const norm = (value: unknown) => String(value ?? "")
    .toUpperCase()
    .replace(/,\s*[A-Z]{2}\s*$/, "")            // a trailing ", IL" state code is formatting
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  const nameFormsOf = (place: NibrsResolvedPlace) => [
    place.label,
    place.requestedName,
    place.requestedName.replace(/\s+(?:city\s+)?police\s+(?:department|dept\.?)$/i, ""),
  ].map(norm).filter((value) => value.length >= 3);
  const identifiersOf = (place: NibrsResolvedPlace) =>
    [...new Set(place.oriYears.map((item) => item.ori))].map((ori) => ori.trim().toUpperCase());

  const normalizedCells = [...cells].map(norm).filter(Boolean);
  const resolved = plan.places.filter((place) => place.status === "resolved");
  const returned = resolved.filter((place) =>
    identifiersOf(place).some((ori) => cells.has(ori))
    || nameFormsOf(place).some((name) => normalizedCells.includes(name)));
  return {
    requested: plan.places,
    resolved,
    returned,
    missing: resolved.filter((place) => !returned.includes(place)),
    unresolved: plan.places.filter((place) => place.status !== "resolved"),
    identifiable: returned.length > 0,
  };
}

/**
 * The delivery gate for the bounded multi-agency family: a question named several agencies, rows
 * came back, and they do not represent every resolved member -- or cannot say which member they
 * represent at all.
 *
 * Silent on a single-agency question, on an empty result (no claim is being made), and where every
 * resolved member is present. A member the source never had is not a failure here; it is disclosed
 * separately, because there is no query that could have included it.
 */
export function deliveredMembershipFailure(
  plan: NibrsPlaceResolutionPlan | null,
  rows: Record<string, unknown>[]
): { reason: string; missing: string[]; returned: string[]; identifiable: boolean } | null {
  const membership = nibrsDeliveredMembership(plan, rows);
  if (!membership) return null;
  if (membership.requested.length < 2) return null;
  if (membership.resolved.length === 0) return null;
  if (!rows || rows.length === 0) return null;
  if (membership.identifiable && membership.missing.length === 0) return null;

  const returned = membership.returned.map((place) => place.label);
  const missing = membership.missing.map((place) => place.label);
  const reason = membership.identifiable
    ? `the result contains ${returned.join(", ")} but nothing for ${missing.join(", ")}`
    : `the result does not identify which of ${membership.resolved.map((place) => place.label).join(", ")} its figures belong to`;
  return { reason, missing, returned, identifiable: membership.identifiable };
}

export function auditNibrsResolvedOriUsage(
  plan: NibrsPlaceResolutionPlan | null,
  sql: string
): string[] {
  if (!plan) return [];
  const warnings: string[] = [];
  for (const place of plan.places.filter((item) => item.status === "resolved")) {
    const oris = [...new Set(place.oriYears.map((item) => item.ori))];
    if (!oris.some((ori) => sql.toUpperCase().includes(ori.toUpperCase()))) {
      warnings.push(`resolved ORI missing for ${place.label}: ${oris.join(",")}`);
    }
  }
  return warnings;
}
