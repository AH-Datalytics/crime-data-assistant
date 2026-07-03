import type Database from "better-sqlite3";

/**
 * Zero-result agency probe for the NIBRS tab (query-audit-2026-07-03 F25).
 *
 * #4595: "firearm crimes in jackson mississippi" returned 0 rows with a generic
 * "try broadening" message, even though Jackson PD has 311 firearm offenders in
 * 2025 — an inherited 2019-2025 consistent-reporter filter excluded an agency
 * that only began reporting in 2025. When an agency-scoped query returns
 * nothing, look up the agency's actual reporting span and say so.
 *
 * Mirrors lib/shr-agency-probe.ts; NIBRS SQL scopes agencies via ORI literals
 * or agencies-table subqueries (city/state), not agency-name columns.
 */

export interface NibrsAgencyScope {
  /** Human label for the scoped place/agency, e.g. "Jackson, MS" */
  label: string;
  cityFilters: { comparator: "=" | "LIKE"; value: string }[];
  state: string | null;
  oris: string[];
}

export interface NibrsAgencyProbeResult {
  scope: NibrsAgencyScope;
  reported: boolean;
  minYear: number | null;
  maxYear: number | null;
  usedConsistentReporterFilter: boolean;
}

function titleCase(value: string): string {
  return value.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

export function extractNibrsAgencyScope(sql: string): NibrsAgencyScope | null {
  // Multi-state SQL (e.g. Kansas City MO vs KS comparisons) has no safe flat
  // city/state pairing — a single global state would silently drop one side of
  // the comparison (CODEX_REVIEW_9577edc finding 3). Stand down instead.
  const stateLiterals = new Set(
    [...sql.matchAll(/\b(?:\w+\.)?state\s*=\s*'([A-Z]{2})'/gi)].map((m) => m[1].toUpperCase())
  );
  if (stateLiterals.size > 1) return null;
  const state = stateLiterals.size === 1 ? [...stateLiterals][0] : null;

  const cityFilters = [...sql.matchAll(/\b(?:\w+\.)?city\s*(=|LIKE)\s*'([^']+)'/gi)].map((m) => ({
    comparator: m[1].toUpperCase() as "=" | "LIKE",
    value: m[2],
  }));

  const oriLiterals = [...sql.matchAll(/\b(?:\w+\.)?ori\s*=\s*'([A-Z0-9]{7,9})'/gi)].map((m) => m[1]);
  const oriList = sql.match(/\b(?:\w+\.)?ori\s+IN\s*\(\s*('[^)]+')\s*\)/i);
  if (oriList && !/SELECT/i.test(oriList[1])) {
    for (const m of oriList[1].matchAll(/'([A-Z0-9]{7,9})'/gi)) oriLiterals.push(m[1]);
  }

  if (cityFilters.length === 0 && oriLiterals.length === 0) return null;

  const label = cityFilters.length > 0
    ? `${titleCase(cityFilters[0].value.replace(/%/g, ""))}${state ? `, ${state}` : ""}`
    : oriLiterals.join(", ");

  return { label, cityFilters, state, oris: [...new Set(oriLiterals)] };
}

export function runNibrsAgencyProbe(db: Database.Database, sql: string): NibrsAgencyProbeResult | null {
  const scope = extractNibrsAgencyScope(sql);
  if (!scope) return null;

  let oris = scope.oris;
  if (oris.length === 0 && scope.cityFilters.length > 0) {
    const clauses = scope.cityFilters.map((f) => `city ${f.comparator} ?`);
    const params: string[] = scope.cityFilters.map((f) => f.value);
    let where = `(${clauses.join(" OR ")})`;
    if (scope.state) {
      where += " AND state = ?";
      params.push(scope.state);
    }
    const rows = db.prepare(`SELECT DISTINCT ori FROM agencies WHERE ${where} LIMIT 200`).all(...params) as { ori: string }[];
    oris = rows.map((r) => r.ori);
  }
  if (oris.length === 0) return null;

  const placeholders = oris.map(() => "?").join(",");
  const span = db.prepare(
    `SELECT MIN(year) AS minYear, MAX(year) AS maxYear
     FROM nibrs_agency_completeness
     WHERE ori IN (${placeholders}) AND months_reported > 0`
  ).get(...oris) as { minYear: number | null; maxYear: number | null };

  return {
    scope,
    reported: span?.minYear != null,
    minYear: span?.minYear ?? null,
    maxYear: span?.maxYear ?? null,
    usedConsistentReporterFilter: /\bnibrs_consistent_reporters\b/i.test(sql),
  };
}

export function appendNibrsAgencyProbeCaveat(explanation: string, probe: NibrsAgencyProbeResult): string {
  const trimmed = (explanation || "The query returned no results.").trim();
  let sentence: string;
  if (!probe.reported) {
    sentence = `Note: ${probe.scope.label} does not appear in NIBRS reporting data — this agency may not report to NIBRS. Not all agencies participate.`;
  } else {
    sentence = `Note: ${probe.scope.label} has NIBRS data only for ${probe.minYear}–${probe.maxYear}.`;
    if (probe.usedConsistentReporterFilter) {
      sentence += ` The consistent-reporter restriction requires agencies to report every month of the full requested span, which excludes agencies with shorter reporting histories — try asking for ${probe.minYear}–${probe.maxYear} without the coverage restriction.`;
    } else {
      sentence += ` Try limiting the year range to ${probe.minYear}–${probe.maxYear}.`;
    }
  }
  if (trimmed.includes(sentence)) return trimmed;
  return `${trimmed}\n\n${sentence}`;
}
