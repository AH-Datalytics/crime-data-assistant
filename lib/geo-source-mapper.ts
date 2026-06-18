import type Database from "better-sqlite3";
import { agencySearchKey } from "./shr-agency-normalization";
import type { GeoPlaceCandidate, GeoPlaceResolution } from "./geo-place-resolver";

export type GeoSource = "current" | "historical" | "nibrs" | "shr";

export type GeoSourceMapStatus =
  | "safe_exact"
  | "needs_clarification"
  | "unsupported"
  | "dangerous_scope"
  | "unknown";

export type GeoSourceMatch = {
  ori?: string;
  ori9?: string;
  agency?: string;
  city?: string;
  state?: string;
  countyFips?: string;
  countyName?: string;
  population?: number | null;
  sourceTable?: string;
};

export type GeoSourceMapping = {
  source: GeoSource;
  status: GeoSourceMapStatus;
  placeId: string;
  label: string;
  filters: string[];
  matches: GeoSourceMatch[];
  reason: string;
};

export type GeoSourceMapperDbs = {
  currentHistorical?: Database.Database | null;
  nibrs?: Database.Database | null;
  shr?: Database.Database | null;
};

type ParsedCandidate = {
  kind: "city" | "county" | "state" | "agency_alias";
  state?: string;
  key?: string;
};

type DbSource = Extract<GeoSource, "current" | "historical" | "nibrs" | "shr">;

const SOURCES: GeoSource[] = ["current", "historical", "nibrs", "shr"];

const HISTORICAL_CITY_ALIASES = new Map<string, string[]>([
  ["NC|CHARLOTTE", ["CHARLOTTE MECKLENBURG", "CHARLOTTE-MECKLENBURG"]],
  ["TN|NASHVILLE", ["METROPOLITAN NASHVILLE", "NASHVILLE"]],
  ["NV|LAS VEGAS", ["LAS VEGAS METROPOLITAN", "LAS VEGAS"]],
  ["KY|LOUISVILLE", ["LOUISVILLE METRO", "LOUISVILLE"]],
]);

export function mapGeoCandidateToSources(
  candidate: GeoPlaceCandidate,
  dbs: GeoSourceMapperDbs
): GeoSourceMapping[] {
  return SOURCES.map((source) => mapCandidateToSource(candidate, source, dbs));
}

export function mapGeoResolutionToSources(
  resolution: GeoPlaceResolution,
  dbs: GeoSourceMapperDbs
): { mentionText: string; candidate: GeoPlaceCandidate; mappings: GeoSourceMapping[] }[] {
  return resolution.mentions.flatMap((mention) =>
    mention.candidates.map((candidate) => ({
      mentionText: mention.text,
      candidate,
      mappings: mapGeoCandidateToSources(candidate, dbs),
    }))
  );
}

function mapCandidateToSource(
  candidate: GeoPlaceCandidate,
  source: GeoSource,
  dbs: GeoSourceMapperDbs
): GeoSourceMapping {
  const parsed = parseCandidateId(candidate.id);
  if (!parsed) {
    return base(candidate, source, "unknown", [], [], `Unsupported place id format: ${candidate.id}`);
  }
  if (parsed.kind === "agency_alias") {
    return base(candidate, source, "unsupported", [], [], "Agency aliases are not mapped by the source-level place mapper yet.");
  }
  if (!parsed.state) {
    return base(candidate, source, "needs_clarification", [], [], "Place candidate has no state code.");
  }
  if (parsed.kind === "state") return mapState(candidate, source, parsed.state, dbs);
  if (parsed.kind === "county") return mapCounty(candidate, source, parsed.state, dbs);
  return mapCity(candidate, source, parsed.state, dbs);
}

function mapState(
  candidate: GeoPlaceCandidate,
  source: GeoSource,
  state: string,
  dbs: GeoSourceMapperDbs
): GeoSourceMapping {
  const db = dbFor(source, dbs);
  const table = stateValidationTable(source);
  if (!db || !tableExists(db, table)) {
    return base(candidate, source, "unknown", [`state = '${state}'`], [], `${source} database/table unavailable for shadow validation.`);
  }
  const row = safeGet<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${table} WHERE upper(state) = ?`, [state]);
  if ((row?.c ?? 0) > 0) {
    return base(candidate, source, "safe_exact", [`state = '${state}'`], [], `State code ${state} is directly filterable in ${table}.`);
  }
  return base(candidate, source, "unsupported", [`state = '${state}'`], [], `No ${source} rows found for state ${state}.`);
}

function stateValidationTable(source: GeoSource): string {
  if (source === "current") return "agency_monthly";
  if (source === "historical") return "historical_agency";
  if (source === "shr") return "incidents";
  return "agencies";
}

function mapCounty(
  candidate: GeoPlaceCandidate,
  source: GeoSource,
  state: string,
  dbs: GeoSourceMapperDbs
): GeoSourceMapping {
  const db = dbFor(source, dbs);
  const countyKey = countyKeyFromName(candidate.name);
  const filters = [`agency_county_crosswalk.state = '${state}'`, `agency_county_crosswalk.county_key = '${countyKey}'`];
  if (!db) return base(candidate, source, "unknown", filters, [], `${source} database unavailable for county crosswalk validation.`);
  if (!tableExists(db, "agency_county_crosswalk")) {
    return base(candidate, source, "unknown", filters, [], `${source} has no agency_county_crosswalk table available to this process.`);
  }
  const rows = safeAll<GeoSourceMatch>(db, `
    SELECT
      ori,
      ori9,
      agency_name AS agency,
      state,
      county_fips AS countyFips,
      county_name AS countyName,
      'agency_county_crosswalk' AS sourceTable
    FROM agency_county_crosswalk
    WHERE upper(state) = ? AND county_key = ?
    ORDER BY agency_name
    LIMIT 50
  `, [state, countyKey]);
  if (rows.length > 0) {
    return base(candidate, source, "safe_exact", filters, rows, `Countywide geography maps through ${rows.length} crosswalk row(s) sampled from agency_county_crosswalk.`);
  }
  return base(candidate, source, "unsupported", filters, [], `No agency_county_crosswalk rows found for ${countyKey}, ${state}.`);
}

function mapCity(
  candidate: GeoPlaceCandidate,
  source: GeoSource,
  state: string,
  dbs: GeoSourceMapperDbs
): GeoSourceMapping {
  if (source === "current") return mapCurrentCity(candidate, state, dbs.currentHistorical);
  if (source === "historical") return mapHistoricalCity(candidate, state, dbs.currentHistorical);
  if (source === "nibrs") return mapNibrsCity(candidate, state, dbs.nibrs);
  return mapShrCity(candidate, state, dbs.shr);
}

function mapCurrentCity(
  candidate: GeoPlaceCandidate,
  state: string,
  db?: Database.Database | null
): GeoSourceMapping {
  const filters = [`state = '${state}'`, `type = 'City'`, `agency ~= '${candidate.name}'`];
  if (!db) return base(candidate, "current", "unknown", filters, [], "current database unavailable for city validation.");
  if (!tableExists(db, "agencies")) {
    return base(candidate, "current", "unknown", filters, [], "current agencies table unavailable.");
  }
  const matches = matchAgencyTable(db, "agencies", state, candidate.name, ["City"]);
  if (matches.length === 1) return base(candidate, "current", "safe_exact", filters, matches, "One current city agency matches this place.");
  if (matches.length > 1) return base(candidate, "current", "needs_clarification", filters, matches, "Multiple current agencies match this city name/state.");
  return base(candidate, "current", "unsupported", filters, [], "No current city agency matched this place.");
}

function mapHistoricalCity(
  candidate: GeoPlaceCandidate,
  state: string,
  db?: Database.Database | null
): GeoSourceMapping {
  const filters = [`state = '${state}'`, `type = 'city'`, `agency ~= '${candidate.name}'`];
  if (!db) return base(candidate, "historical", "unknown", filters, [], "historical database unavailable for city validation.");
  if (!tableExists(db, "historical_agency")) {
    return base(candidate, "historical", "unknown", filters, [], "historical_agency table unavailable.");
  }
  const aliases = historicalCityKeys(state, candidate.name);
  const rows = safeAll<GeoSourceMatch>(db, `
    SELECT DISTINCT
      ori,
      agency,
      upper(state) AS state,
      'historical_agency' AS sourceTable
    FROM historical_agency
    WHERE upper(state) = ? AND lower(type) = 'city'
  `, [state]).filter((row) => aliases.has(normalizePlaceKey(row.agency || ""))).slice(0, 50);
  if (rows.length === 1) return base(candidate, "historical", "safe_exact", filters, rows, "One historical city agency matches this place.");
  if (rows.length > 1) return base(candidate, "historical", "needs_clarification", filters, rows, "Multiple historical city agencies match this place.");
  return base(candidate, "historical", "unsupported", filters, [], "No historical city agency matched this place.");
}

function mapNibrsCity(
  candidate: GeoPlaceCandidate,
  state: string,
  db?: Database.Database | null
): GeoSourceMapping {
  const filters = [`agencies.state = '${state}'`, `agencies.city = '${candidate.name.toUpperCase()}'`];
  if (!db) return base(candidate, "nibrs", "unknown", filters, [], "nibrs database unavailable for city validation.");
  if (!tableExists(db, "agencies")) return base(candidate, "nibrs", "unknown", filters, [], "nibrs agencies table unavailable.");
  const cityColumn = firstExistingColumn(db, "agencies", ["city", "agency", "agency_name"]);
  if (!cityColumn || !columnExists(db, "agencies", "state")) {
    return base(candidate, "nibrs", "unknown", filters, [], "nibrs agencies table does not expose city/state columns.");
  }
  const typeColumn = firstExistingColumn(db, "agencies", ["agency_type", "type"]);
  const populationColumn = firstExistingColumn(db, "agencies", ["population"]);
  const aliases = new Set([normalizePlaceKey(candidate.name)]);
  const rows = safeAll<Record<string, unknown>>(db, `
    SELECT DISTINCT
      ori,
      ${cityColumn} AS city,
      state
      ${populationColumn ? `, ${populationColumn} AS population` : ""}
      ${typeColumn ? `, ${typeColumn} AS agency_type` : ""}
    FROM agencies
    WHERE upper(state) = ?
    LIMIT 10000
  `, [state])
    .filter((row) => aliases.has(normalizePlaceKey(String(row.city || ""))))
    .filter((row) => !typeColumn || /city/i.test(String(row.agency_type || "")))
    .map((row) => ({
      ori: String(row.ori || ""),
      city: String(row.city || ""),
      state: String(row.state || ""),
      population: typeof row.population === "number" ? row.population : null,
      sourceTable: "agencies",
    }))
    .slice(0, 50);
  if (rows.length > 0) return base(candidate, "nibrs", "safe_exact", filters, rows, `NIBRS city/state filter matches ${rows.length} agency row(s) sampled.`);
  return base(candidate, "nibrs", "unsupported", filters, [], "No NIBRS city/state agency rows matched this place.");
}

function mapShrCity(
  candidate: GeoPlaceCandidate,
  state: string,
  db?: Database.Database | null
): GeoSourceMapping {
  const searchKey = agencySearchKey(candidate.name);
  const filters = [`shr_agency_alias.state = '${state}'`, `shr_agency_alias.alias_key = '${searchKey}'`];
  if (!db) return base(candidate, "shr", "unknown", filters, [], "shr database unavailable for city validation.");
  if (!tableExists(db, "shr_agency_alias")) {
    return base(candidate, "shr", "unknown", filters, [], "shr_agency_alias table unavailable.");
  }
  const rows = safeAll<GeoSourceMatch & { agency_type?: string }>(db, `
    SELECT DISTINCT
      ori,
      canonical_agency AS agency,
      state,
      agency_type,
      'shr_agency_alias' AS sourceTable
    FROM shr_agency_alias
    WHERE upper(state) = ? AND alias_key = ?
    ORDER BY canonical_agency
    LIMIT 50
  `, [state, searchKey]).filter((row) => /city/i.test(String(row.agency_type || "")));
  if (rows.length === 1) return base(candidate, "shr", "safe_exact", filters, rows, "One SHR city agency alias matches this place.");
  if (rows.length > 1) return base(candidate, "shr", "needs_clarification", filters, rows, "Multiple SHR city aliases match this place.");
  return base(candidate, "shr", "unsupported", filters, [], "No SHR city alias matched this place.");
}

function matchAgencyTable(
  db: Database.Database,
  table: string,
  state: string,
  placeName: string,
  allowedTypes: string[]
): GeoSourceMatch[] {
  const aliases = new Set([normalizePlaceKey(placeName)]);
  return safeAll<GeoSourceMatch & { type?: string }>(db, `
    SELECT DISTINCT
      ori,
      agency,
      upper(state) AS state,
      type,
      '${table}' AS sourceTable
    FROM ${table}
    WHERE upper(state) = ?
    ORDER BY agency
    LIMIT 10000
  `, [state])
    .filter((row) => !allowedTypes.length || allowedTypes.some((type) => normalizePlaceKey(type) === normalizePlaceKey(row.type || "")))
    .filter((row) => aliases.has(normalizePlaceKey(row.agency || "")))
    .slice(0, 50);
}

function base(
  candidate: GeoPlaceCandidate,
  source: GeoSource,
  status: GeoSourceMapStatus,
  filters: string[],
  matches: GeoSourceMatch[],
  reason: string
): GeoSourceMapping {
  return {
    source,
    status,
    placeId: candidate.id,
    label: candidate.canonicalQuery || candidate.name,
    filters,
    matches,
    reason,
  };
}

function dbFor(source: DbSource, dbs: GeoSourceMapperDbs): Database.Database | null | undefined {
  if (source === "current" || source === "historical") return dbs.currentHistorical;
  return dbs[source];
}

function parseCandidateId(id: string): ParsedCandidate | null {
  const parts = id.split(":");
  if (parts[0] === "state" && parts[1]) return { kind: "state", state: parts[1].toUpperCase() };
  if ((parts[0] === "city" || parts[0] === "county") && parts[1]) {
    return { kind: parts[0], state: parts[1].toUpperCase(), key: parts[2] };
  }
  if (parts[0] === "agency_alias") return { kind: "agency_alias", state: parts[1]?.toUpperCase(), key: parts[2] };
  return null;
}

function historicalCityKeys(state: string, placeName: string): Set<string> {
  const key = normalizePlaceKey(placeName);
  const aliases = new Set<string>([key]);
  for (const alias of HISTORICAL_CITY_ALIASES.get(`${state}|${key}`) || []) {
    aliases.add(normalizePlaceKey(alias));
  }
  return aliases;
}

function countyKeyFromName(name: string): string {
  return name
    .replace(/\b(county|parish|borough|census area|municipality)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function normalizePlaceKey(value: string): string {
  return (value || "")
    .replace(/\bSaint\b/gi, "St")
    .replace(/\bSt\./gi, "St")
    .replace(/\b(city|town|village|borough|township)\b/gi, "")
    .replace(/\b(police|department|dept|sheriff'?s?|office|ofc|metro|metropolitan)\b/gi, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function tableExists(db: Database.Database, table: string): boolean {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
  } catch {
    return false;
  }
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => (row as { name?: string }).name === column);
  } catch {
    return false;
  }
}

function firstExistingColumn(db: Database.Database, table: string, candidates: string[]): string | null {
  return candidates.find((column) => columnExists(db, table, column)) || null;
}

function safeAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  }
}

function safeGet<T>(db: Database.Database, sql: string, params: unknown[] = []): T | null {
  try {
    return db.prepare(sql).get(...params) as T | undefined || null;
  } catch {
    return null;
  }
}
