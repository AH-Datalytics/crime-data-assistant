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

export function formatShrResolutionGuidance(places: ShrResolvedAgency[]): string | null {
  const resolved = places.filter((place) => place.status === "resolved");
  if (resolved.length === 0) return null;
  const lines = resolved.map((place) => {
    const ranges = place.ranges.map((range) => `${range.ori} for ${range.startYear}-${range.endYear}`).join(", ");
    return `- ${place.label}, ${place.state}: ${ranges}`;
  });
  return `[SYSTEM: Deterministic SHR geography resolution for the reconstructed question. Use the resolved ORI and year ranges below as hard constraints. Do not filter a resolved place with i.agency or substitute another agency. For comparisons, group/display using the requested place labels.\n${lines.join("\n")}]`;
}

export function rewriteShrResolvedAgencyPredicates(
  sql: string,
  places: ShrResolvedAgency[],
): { sql: string; rewritten: boolean; warning?: string } {
  if (!/\bi\.agency\s*(?:=|LIKE)\s*'/i.test(sql)) return { sql, rewritten: false };
  const lower = sql.toLowerCase();
  const whereIndex = lower.indexOf(" where ");
  const head = whereIndex >= 0 ? sql.slice(0, whereIndex) : sql;
  if (/\bi\.agency\b(?!\s*=)/i.test(head) || /\bgroup\s+by[\s\S]*\bi\.agency\b(?!\s*=)/i.test(sql) || /\border\s+by[\s\S]*\bi\.agency\b(?!\s*=)/i.test(sql)) {
    return { sql, rewritten: false, warning: "SHR resolved agency SQL uses i.agency outside a simple predicate." };
  }
  let rewrittenSql = sql;
  for (const place of places.filter((candidate) => candidate.status === "resolved")) {
    const names = [...new Set([place.requestedName, place.label])].filter(Boolean);
    const ranges = place.ranges.map((range) =>
      `(i.ori = '${range.ori.replace(/'/g, "''")}' AND i.year BETWEEN ${range.startYear} AND ${range.endYear})`
    );
    if (ranges.length === 0) continue;
    const replacement = ranges.length === 1 ? ranges[0] : `(${ranges.join(" OR ")})`;
    for (const name of names) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      rewrittenSql = rewrittenSql.replace(new RegExp(`i\\.agency\\s*=\\s*'${escaped}'`, "gi"), replacement);
    }
  }
  if (rewrittenSql === sql || /\bi\.agency\s*(?:=|LIKE)\s*'/i.test(rewrittenSql)) {
    return { sql, rewritten: false, warning: "SHR SQL contains an unresolved agency-name predicate." };
  }
  return { sql: rewrittenSql, rewritten: true };
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

// SHR keeps Louisville's pre-merger and successor agencies under different ORIs.
// Resolve the public place name to the later ORI for post-merger requests.
const SUCCESSION_CHAINS = [
  { state: "KY", aliasKey: "LOUISVILLE", label: "Louisville / Louisville Metro", oris: ["KY05602", "KY05680"] },
] as const;

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
  if (active.length === 0 && !SUCCESSION_CHAINS.some((candidate) =>
    candidate.state === normalizedState && candidate.aliasKey === agencySearchKey(requestedName)
  )) {
    const result = unavailable("not_in_source", "SHR has no records for " + requestedName + ", " + normalizedState + ", during " + startYear + "-" + endYear + ".");
    entries.set(key, result);
    return result;
  }
  const succession = SUCCESSION_CHAINS.find((candidate) =>
    candidate.state === normalizedState && candidate.aliasKey === agencySearchKey(requestedName)
  );
  if (succession) {
    const chainRows = db.prepare(
      "SELECT ori, canonical_agency, agency_type, first_year, last_year, incident_count, source_agency_names " +
      "FROM shr_agency_identity WHERE upper(state) = ? AND ori IN (" + succession.oris.map(() => "?").join(",") + ")"
    ).all(normalizedState, ...succession.oris) as IdentityRow[];
    if (chainRows.length === succession.oris.length) {
      const chainRanges = chainRows
        .map((row) => ({ ori: row.ori, startYear: Math.max(startYear, row.first_year), endYear: Math.min(endYear, row.last_year) }))
        .filter((range) => range.startYear <= range.endYear)
        .sort((a, b) => a.startYear - b.startYear || a.endYear - b.endYear);
      for (let index = 1; index < chainRanges.length; index++) {
        const previous = chainRanges[index - 1];
        const current = chainRanges[index];
        if (previous.endYear > current.startYear) {
          if (previous.endYear - current.startYear > 0) {
            const result = unavailable("ambiguous", "Overlapping SHR succession ranges would combine multiple agencies in the same year.");
            entries.set(key, result);
            return result;
          }
        }
      }
      const ranges = chainRanges.filter((range) => range.startYear <= range.endYear);
      if (ranges.length > 0) {
        const result = {
          requestedName, label: succession.label, state: normalizedState, agencyType: chainRows[0].agency_type,
          status: "resolved" as const, confidence: "high" as const, oris: [...new Set(ranges.map((range) => range.ori))], ranges,
          reason: "Resolved through SHR agency succession for " + succession.label + ".",
        };
        entries.set(key, result);
        return result;
      }
    }
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
