import Database from "better-sqlite3";
import { agencySearchKey } from "./shr-agency-normalization";
import type { SourceResolutionStatus } from "./source-contracts";

export type ShrResolvedAgency = {
  requestedName: string;
  label: string;
  state: string;
  agencyType: "City" | "County" | "Other";
  status: SourceResolutionStatus;
  confidence: "high" | "medium" | "low";
  oris: string[];
  ranges: { ori: string; startYear: number; endYear: number }[];
  reason: string;
};

export function buildShrCanonicalLabelCase(
  places: Pick<ShrResolvedAgency, "oris" | "label">[],
  alias = "i",
): string {
  const labelCases = places.flatMap((place) =>
    place.oris.map((ori) => `WHEN ${alias}.ori = '${ori.replace(/'/g, "''")}' THEN '${place.label.replace(/'/g, "''")}'`)
  );
  return `(CASE ${labelCases.join(" ")} ELSE ${alias}.agency END)`;
}

type IdentityRow = {
  ori: string;
  canonical_agency: string;
  agency_type: "City" | "County" | "Other";
  first_year: number;
  last_year: number;
  incident_count: number;
  source_agency_names: string;
};

const cache = new WeakMap<Database.Database, Map<string, ShrResolvedAgency>>();

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function requestedType(kind: "city" | "agency" | "campus" = "city"): string[] | null {
  if (kind === "city") return ["City"];
  if (kind === "agency") return null;
  return ["Other"];
}

export function resolveShrAgency(
  db: Database.Database,
  requestedName: string,
  state: string,
  options: { kind?: "city" | "agency" | "campus"; startYear?: number; endYear?: number } = {},
): ShrResolvedAgency {
  const normalizedState = state.toUpperCase();
  const startYear = options.startYear ?? 1976;
  const endYear = options.endYear ?? new Date().getFullYear();
  const key = [requestedName, normalizedState, options.kind ?? "city", startYear, endYear].join("|").toUpperCase();
  let entries = cache.get(db);
  if (!entries) {
    entries = new Map();
    cache.set(db, entries);
  }
  const cached = entries.get(key);
  if (cached) return cached;

  const unavailable = (status: SourceResolutionStatus, reason: string): ShrResolvedAgency => ({
    requestedName, label: requestedName, state: normalizedState, agencyType: "Other", status,
    confidence: "low", oris: [], ranges: [], reason,
  });
  if (!tableExists(db, "shr_agency_alias") || !tableExists(db, "shr_agency_identity")) {
    const result = unavailable("unsupported", "SHR agency identity tables are unavailable.");
    entries.set(key, result);
    return result;
  }

  const allowed = requestedType(options.kind);
  const typeSql = allowed ? " AND a.agency_type IN (" + allowed.map(() => "?").join(",") + ")" : "";
  const rows = db.prepare(
    "SELECT DISTINCT a.ori, a.canonical_agency, a.agency_type, i.first_year, i.last_year, i.incident_count, i.source_agency_names " +
    "FROM shr_agency_alias a " +
    "JOIN shr_agency_identity i ON i.ori = a.ori AND upper(i.state) = upper(a.state) " +
    "WHERE upper(a.state) = ? AND a.alias_key = ?" + typeSql +
    " ORDER BY a.canonical_agency, a.ori"
  ).all(normalizedState, agencySearchKey(requestedName), ...(allowed || [])) as IdentityRow[];

  if (rows.length === 0) {
    const result = unavailable("not_in_source", "No SHR agency identity matches " + requestedName + ", " + normalizedState + ".");
    entries.set(key, result);
    return result;
  }
  let active = rows.filter((row) => row.last_year >= startYear && row.first_year <= endYear);
  if (active.length === 0) {
    const result = unavailable("not_in_source", "SHR has no records for " + requestedName + ", " + normalizedState + ", during " + startYear + "-" + endYear + ".");
    entries.set(key, result);
    return result;
  }
  const distinctLabels = [...new Set(active.map((row) => row.canonical_agency))];
  if (distinctLabels.length > 1) {
    const result = {
      requestedName, label: requestedName, state: normalizedState, agencyType: active[0].agency_type, status: "ambiguous" as const,
      confidence: "low" as const, oris: [], ranges: [],
      reason: "Multiple SHR agencies match " + requestedName + ", " + normalizedState + ".",
    };
    entries.set(key, result);
    return result;
  }
  if (active.length > 1 && distinctLabels.length === 1) {
    const ranked = [...active].sort((a, b) => b.incident_count - a.incident_count);
    const sameSourceName = ranked.every((row) => row.source_agency_names === ranked[0].source_agency_names);
    if (sameSourceName && ranked[0].incident_count >= ranked[1].incident_count * 10) {
      active = [ranked[0]];
    }
  }
  const ranges = active.map((row) => ({
    ori: row.ori,
    startYear: Math.max(startYear, row.first_year),
    endYear: Math.min(endYear, row.last_year),
  }));
  const sortedRanges = [...ranges].sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
  const overlapping = sortedRanges.some((range, index) =>
    sortedRanges.slice(0, index).some((previous) => previous.ori !== range.ori && previous.endYear >= range.startYear)
  );
  if (overlapping) {
    const result = {
      requestedName, label: requestedName, state: normalizedState, agencyType: active[0].agency_type, status: "ambiguous" as const,
      confidence: "low" as const, oris: [], ranges: [],
      reason: "Overlapping SHR ORI ranges would combine multiple agencies in the same year.",
    };
    entries.set(key, result);
    return result;
  }
  const result = {
    requestedName, label: distinctLabels[0], state: normalizedState, agencyType: active[0].agency_type,
    status: "resolved" as const, confidence: "high" as const,
    oris: [...new Set(ranges.map((range) => range.ori))], ranges,
    reason: "Resolved through SHR agency identity for " + distinctLabels[0] + ".",
  };
  entries.set(key, result);
  return result;
}
