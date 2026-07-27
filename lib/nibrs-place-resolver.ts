import Database from "better-sqlite3";
import { buildQueryContract, type QueryContract, type QueryContractGeography } from "./query-contract";
import { pastCompleteCalendarYearsRange } from "./time-conventions";
import type { SourceResolutionStatus } from "./source-contracts";

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
  const placeholders = states.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT ori, year, population, pop_group, agency_type
    FROM agencies
    WHERE city = ?
      AND state IN (${placeholders})
      AND agency_type = 'City'
      AND population > 0
      AND year BETWEEN ? AND ?
    ORDER BY year, pop_group, population DESC, ori
  `).all(cityName.toUpperCase(), ...states, startYear, endYear) as AgencyRow[];
  const oriYears = choosePrimaryByYear(rows);
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
    WHERE city = ? AND state IN (${placeholders}) AND agency_type = 'City'
  `).get(cityName.toUpperCase(), ...states) as { first_year: number | null; last_year: number | null } | undefined;
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
  const cityPolice = name.match(/^(.+?)\s+(?:city\s+)?police\s+(?:department|dept\.?)$/i);
  if (cityPolice) return resolveCity(db, geography, contractIndex, startYear, endYear, cityPolice[1]);
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
