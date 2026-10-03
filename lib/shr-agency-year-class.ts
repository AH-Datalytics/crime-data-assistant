/**
 * The SHR agency/year classification relation (Codex combined ruling, 2026-10-02: "use the existing authority
 * consistently"). One row per SHR agency (ORI, state) per year it appears in `incidents`, holding the decision of
 * the SAME period-bound classifier the city ranking uses (`loadShrTypeEvidence` + `classifyShrAgency`,
 * lib/shr-agency-classification.ts) -- materialized, not re-derived by a second algorithm.
 *
 *   membership  'eligible' (City) | 'ineligible' (a type other than City -- NOT automatically County) | 'unresolved'
 *   agency_type the exact NIBRS type for eligible/ineligible rows; NULL when unresolved, so `agency_type = 'City'`
 *               can never admit an unresolved agency
 *   reason      the unresolved reason; NULL otherwise
 *   basis       the classification basis as JSON (source, NIBRS ORI, typed/blank years, carry-forward)
 *
 * WHY. `incidents.agency_type` was never source data: every value was written by the old identity normalizer
 * (legacy labels, NIBRS lookups and name defaults), and the 2026 rows have none at all. The model path and one
 * deterministic fallback read it as "blank means City", so a sheriff counted as a city, or a strict filter found
 * no 2026 cities. This relation replaces that column as the ONLY City/County authority for counted rows; the
 * derived result is never written back into `incidents`.
 *
 * Built by scripts/build-shr-agency-type-evidence.ts in the same transaction as the evidence tables. A year is
 * classified from evidence up to that year only (SC-1), so no later year decides an earlier one.
 *
 * This module imports only the classifier so the pinned builder gains no new dependency.
 */
import type Database from "better-sqlite3";
import { classifyShrAgency, loadShrTypeEvidence, shrAgencyKey, SHR_TYPE_SOURCE } from "./shr-agency-classification";

export const SHR_YEAR_CLASS_TABLE = "shr_agency_year_class";
export const SHR_YEAR_CLASS_META_TABLE = "shr_agency_year_class_meta";

export const SHR_YEAR_CLASS_DDL = `
  CREATE TABLE ${SHR_YEAR_CLASS_TABLE} (
    ori TEXT NOT NULL, state TEXT NOT NULL, year INTEGER NOT NULL,
    membership TEXT NOT NULL CHECK (membership IN ('eligible', 'ineligible', 'unresolved')),
    agency_type TEXT, reason TEXT, basis TEXT,
    PRIMARY KEY (ori, state, year)
  );
  CREATE TABLE ${SHR_YEAR_CLASS_META_TABLE} (
    generation TEXT NOT NULL, built_at TEXT NOT NULL, source TEXT NOT NULL, agency_years INTEGER NOT NULL
  );
`;

export type YearClassRow = {
  ori: string; state: string; year: number;
  membership: "eligible" | "ineligible" | "unresolved"; agency_type: string | null; reason: string | null; basis: string | null;
};

/** Every (ori, state, year) of `incidents`, classified per year by the existing period-bound classifier. */
export function computeYearClassRows(db: Database.Database): YearClassRow[] {
  const keys = db.prepare(
    "SELECT DISTINCT ori, state, year FROM incidents" +
    " WHERE ori IS NOT NULL AND ori <> '' AND state IS NOT NULL AND state <> '' AND year IS NOT NULL ORDER BY year, ori, state",
  ).all() as { ori: string; state: string; year: number }[];
  const rows: YearClassRow[] = [];
  let evidenceYear: number | null = null;
  let evidence: ReturnType<typeof loadShrTypeEvidence> | null = null;
  for (const k of keys) {
    if (evidenceYear !== k.year) { evidence = loadShrTypeEvidence(db, k.year); evidenceYear = k.year; }
    const c = classifyShrAgency(evidence!.byAgency.get(shrAgencyKey(k.ori, k.state)) ?? null, evidence!.built, k.year);
    rows.push(c.membership === "unresolved"
      ? { ori: k.ori, state: k.state, year: k.year, membership: "unresolved", agency_type: null, reason: c.reason, basis: null }
      : { ori: k.ori, state: k.state, year: k.year, membership: c.membership, agency_type: c.agencyType, reason: null, basis: JSON.stringify(c.basis) });
  }
  return rows;
}

/** Drop and rebuild the relation inside the CALLER's transaction (the evidence builder's). */
export function writeYearClass(db: Database.Database, rows: YearClassRow[], builtAt: string): void {
  db.exec(`DROP TABLE IF EXISTS ${SHR_YEAR_CLASS_TABLE}; DROP TABLE IF EXISTS ${SHR_YEAR_CLASS_META_TABLE};`);
  db.exec(SHR_YEAR_CLASS_DDL);
  const ins = db.prepare(`INSERT INTO ${SHR_YEAR_CLASS_TABLE} (ori, state, year, membership, agency_type, reason, basis) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) ins.run(r.ori, r.state, r.year, r.membership, r.agency_type, r.reason, r.basis);
  db.prepare(`INSERT INTO ${SHR_YEAR_CLASS_META_TABLE} (generation, built_at, source, agency_years) VALUES (?, ?, ?, ?)`)
    .run(builtAt, builtAt, SHR_TYPE_SOURCE, rows.length);
}

export type YearClassAvailability =
  | { available: true; generation: string; agencyYears: number }
  | { available: false; reason: "not-built" | "stale"; detail: string };

const tableExists = (db: Database.Database, name: string) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

/**
 * Is the relation present AND current? Current means every (ori, state, year) of `incidents` has a row: a refresh
 * that added agency-years without rebuilding the relation makes it STALE, and stale is treated as unavailable.
 */
export function yearClassAvailability(db: Database.Database): YearClassAvailability {
  if (!tableExists(db, SHR_YEAR_CLASS_TABLE) || !tableExists(db, SHR_YEAR_CLASS_META_TABLE)) {
    return { available: false, reason: "not-built", detail: "the agency/year classification has not been built" };
  }
  const meta = db.prepare(`SELECT generation, agency_years FROM ${SHR_YEAR_CLASS_META_TABLE} LIMIT 1`).get() as { generation: string; agency_years: number } | undefined;
  if (!meta) return { available: false, reason: "not-built", detail: "the agency/year classification has no generation record" };
  const missing = (db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT ori, state, year FROM incidents WHERE ori IS NOT NULL AND ori <> '' AND state IS NOT NULL AND state <> '' AND year IS NOT NULL) k` +
    ` WHERE NOT EXISTS (SELECT 1 FROM ${SHR_YEAR_CLASS_TABLE} c WHERE c.ori = k.ori AND c.state = k.state AND c.year = k.year)`,
  ).get() as { n: number }).n;
  if (missing > 0) return { available: false, reason: "stale", detail: `${missing} agency-years in the data have no classification` };
  return { available: true, generation: meta.generation, agencyYears: meta.agency_years };
}

/** Per-process cache: the coverage check reads every agency-year, so it is not repeated on every request. */
const CACHE_MS = 10 * 60 * 1000;
const cache = new WeakMap<Database.Database, { at: number; value: YearClassAvailability }>();
export function cachedYearClassAvailability(db: Database.Database, now = Date.now()): YearClassAvailability {
  const hit = cache.get(db);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  const value = yearClassAvailability(db);
  cache.set(db, { at: now, value });
  return value;
}

export type ClassScope = { years: [number, number] | null; states: string[] | null };

/**
 * Agencies a City/County-dependent answer could NOT classify, within the statement's own year and state scope:
 * agency-years with no classification row, or an unresolved one. An upper bound for the request (the measure
 * filter is not applied), stated as such.
 */
export function unresolvedInScope(db: Database.Database, scope: ClassScope): { agencies: number; incidents: number } {
  return unresolvedInScopes(db, [scope]);
}

/**
 * The same count over the UNION of several counting scopes (SCA-2): one statement with the scopes OR'd, so an
 * agency or incident in two scopes is counted once, and no requested state's unclassified agencies are dropped.
 */
export function unresolvedInScopes(db: Database.Database, scopes: ClassScope[]): { agencies: number; incidents: number } {
  const ors: string[] = [];
  const args: (string | number)[] = [];
  for (const scope of scopes) {
    const and: string[] = [];
    if (scope.years) { and.push("i.year BETWEEN ? AND ?"); args.push(scope.years[0], scope.years[1]); }
    if (scope.states && scope.states.length > 0) { and.push(`i.state IN (${scope.states.map(() => "?").join(", ")})`); args.push(...scope.states); }
    ors.push(and.length > 0 ? `(${and.join(" AND ")})` : "1 = 1");
  }
  if (ors.length === 0) return { agencies: 0, incidents: 0 };
  const r = db.prepare(
    `SELECT COUNT(DISTINCT i.ori || '|' || i.state) AS agencies, COUNT(*) AS incidents FROM incidents i` +
    ` LEFT JOIN ${SHR_YEAR_CLASS_TABLE} c ON c.ori = i.ori AND c.state = i.state AND c.year = i.year` +
    ` WHERE (c.ori IS NULL OR c.membership = 'unresolved') AND (${ors.join(" OR ")})`,
  ).get(...args) as { agencies: number; incidents: number };
  return { agencies: r.agencies, incidents: r.incidents };
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const oneScope = (scope: ClassScope) => {
  const years = scope.years ? (scope.years[0] === scope.years[1] ? `${scope.years[0]}` : `${scope.years[0]}-${scope.years[1]}`) : "all years";
  return scope.states && scope.states.length > 0 ? `${scope.states.join(", ")} in ${years}` : `all states in ${years}`;
};
/** "in TX in 2025" / "in AL in 2025 and TX in 2025": every counting scope, de-duplicated. */
const scopeWords = (scopes: ClassScope[]) => {
  const list = [...new Set(scopes.map(oneScope))];
  return ` in ${list.length <= 1 ? list[0] ?? "all states in all years" : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`}`;
};
const asScopes = (s: ClassScope | ClassScope[]) => (Array.isArray(s) ? s : [s]);

/** How the classification decides a type, stated as the classifier does it (period-bound, carry-forward). */
const BASIS =
  "Agencies are counted as cities or counties from the NIBRS agency records up to each year; where the latest " +
  "record is earlier, its type is carried forward.";
/** What "unresolved" covers: not only a missing type. */
const UNRESOLVED_WHY = "no matching NIBRS agency, several possible matches, or missing or conflicting types";

/** The disclosure appended to an answer that counted only classified agencies. */
export function unresolvedDisclosure(u: { agencies: number; incidents: number }, scope: ClassScope | ClassScope[]): string {
  return `${BASIS} ${plural(u.agencies, "agency", "agencies")} with up to ${plural(u.incidents, "incident record", "incident records")}` +
    `${scopeWords(asScopes(scope))} could not be classified (${UNRESOLVED_WHY}), so they are not included in these figures.`;
}

/** The limited answer when nothing classified matched but unclassified agencies exist: never an apparent zero. */
export function unresolvedLimitation(u: { agencies: number; incidents: number }, scope: ClassScope | ClassScope[]): string {
  return `I can't give a reliable figure for that. It depends on which agencies are cities or counties, and ` +
    `${plural(u.agencies, "agency", "agencies")} with up to ${plural(u.incidents, "incident record", "incident records")}` +
    `${scopeWords(asScopes(scope))} could not be classified (${UNRESOLVED_WHY}), so they could not be counted either way. ` +
    `Among the agencies that could be classified, none matched, but that is not the same as zero.`;
}

/** Why a City/County-dependent answer cannot be given at all right now. */
export const YEAR_CLASS_UNAVAILABLE_TEXT =
  "I can't answer that reliably right now: it depends on which agencies are cities or counties, and the " +
  "agency classification for the Homicide Reports data isn't available. I won't treat agencies without a known type as cities.";
