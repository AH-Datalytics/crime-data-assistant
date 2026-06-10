import type Database from "better-sqlite3";

export interface ShrAgencyProbe {
  agency: string;
  state: string | null;
  where: string;
  params: string[];
}

const STOP_TOKENS = new Set([
  "city",
  "county",
  "police",
  "department",
  "dept",
  "dep",
  "pd",
  "sheriff",
  "office",
]);

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function agencyTokens(agency: string): string[] {
  const tokens = agency
    .replace(/\bSt\./gi, "St")
    .split(/[^A-Za-z0-9]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2)
    .filter((s) => !STOP_TOKENS.has(s.toLowerCase()));
  const kept = unique(tokens);
  return kept.length > 0 ? kept : [agency];
}

export function buildShrAgencyProbe(sql: string): ShrAgencyProbe | null {
  const agency = sql.match(/\b(?:\w+\.)?agency\s*=\s*'([^']+)'/i)?.[1]?.trim();
  if (!agency) return null;

  const state = sql.match(/\b(?:\w+\.)?state\s*=\s*'([A-Z]{2})'/i)?.[1]?.toUpperCase() ?? null;
  const clauses = agencyTokens(agency).map(() => "agency LIKE ?");
  const params = agencyTokens(agency).map((token) => `%${token}%`);
  if (state) {
    clauses.push("state = ?");
    params.push(state);
  }

  return {
    agency,
    state,
    where: clauses.join(" AND "),
    params,
  };
}

export function isZeroResult(rows: Record<string, unknown>[], columns: string[]): boolean {
  if (rows.length === 0) return true;
  if (rows.length !== 1) return false;
  const dataCols = columns.filter((c) => !["year", "month", "state", "state_name", "agency", "agency_type"].includes(c));
  if (dataCols.length === 0) return false;
  return dataCols.every((col) => Number(rows[0]?.[col] ?? 0) === 0);
}

export function runShrAgencyProbe(db: Database.Database, sql: string): { probe: ShrAgencyProbe; count: number } | null {
  const probe = buildShrAgencyProbe(sql);
  if (!probe) return null;
  const row = db.prepare(`SELECT COUNT(*) AS count FROM incidents WHERE ${probe.where}`).get(...probe.params) as { count: number };
  return { probe, count: Number(row?.count ?? 0) };
}

export function appendShrAgencyProbeCaveat(explanation: string, agency: string): string {
  const sentence = `Note: SHR contains records under similar agency names for ${agency}, so a zero result may reflect an agency-name or agency-type mismatch rather than no homicides.`;
  const trimmed = (explanation || "The query returned no results.").trim();
  if (trimmed.includes(sentence)) return trimmed;
  return `${trimmed}\n\n${sentence}`;
}
