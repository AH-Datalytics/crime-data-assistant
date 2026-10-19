/**
 * Stage 2a (Historical): compile an issued H1-H6 spec into the application's own statements, read the raw cells, and
 * build the delivered rows, columns, title, chart and description. No model text, no model SQL.
 *
 * Coverage is computed per CELL (place x year x measure) in application code, before anything is combined (stage 1
 * lesson 6). Absence is never 0: a missing agency row is "no report", a NULL column "not reported", a rate with no valid
 * population "no population", a state/national year the table lacks "no data". Totals are summed here, never by SQL SUM.
 *
 * Sources (task 0 matrix, audit/request-accounting-stage2/2a-r1/task0/facts.md F1):
 *   national/state crime  historical_state_national (FBI estimates); violent/property/total = component sums, no value if
 *                         any component is missing; rates = sums of component rates; total_offenses is never used.
 *   agency crime          historical_agency_crime; rates use historical_agency_population (as the accepted paths do).
 *   clearance             historical_agency_clearance (agency) / national_clearance_rate (nation).
 *   staffing              historical_staffing, agency only; no "Employees*" substitution.
 */
import { recordWhyFacts } from "./why-scope";
import type Database from "better-sqlite3";
import type { TypedDeliveredSeries } from "./historical-national-rape";
import { findConsolidatedAgency } from "./agency-consolidations";
import { historicalCountyAgencyPredicate } from "./historical-county-identity";
import { STATE_NAME_TO_ABBR } from "./state-population";
import {
  MEASURE_LABEL, resolveYears, sourceFor,
  type Bounds, type ChangeSpec, type HistoricalSpec, type Measure, type PlaceRef, type RankSpec, type SeriesSpec, type SourceId, type Statistic,
} from "./historical-question-types";
import type { ChartConfig } from "./types";

export type CompiledAnswer = {
  kind: "answer";
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  title: string;
  explanation: string;
  chartConfig: ChartConfig | null;
  /** Requested and returned entity labels, for the proof layer. */
  requestedEntities: string[];
  returnedEntities: string[];
  /** One entry per delivered series, with the years whose delivered value is not null (the rape-correction notes). */
  deliveredSeries: TypedDeliveredSeries[];
};
export type CompileResult = CompiledAnswer | { kind: "decline"; explanation: string };

export type CompileDeps = {
  db: Database.Database;
  /** Runs one application-built statement (the route checks it with its structural guard first). */
  execute: (sql: string) => Record<string, unknown>[];
  now?: Date;
};

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const r1 = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10);
const STATE_FULL = new Set([...Object.keys(STATE_NAME_TO_ABBR as Record<string, string>).filter((n) => n.toLowerCase() !== "united states"), "District of Columbia"]);
const displayState = (s: string) => { const u = s.toUpperCase(); return u === "NB" ? "NE" : u === "GM" ? "GU" : u; };
const sourceState = (s: string) => { const u = s.toUpperCase(); return u === "NE" ? "nb" : u === "GU" ? "gm" : u.toLowerCase(); };

/* ------------------------------------------------------------------------------------- bounds ------------------- */

const BOUND_SQL: Record<SourceId, string> = {
  agency_crime: "SELECT MIN(year) AS mn, MAX(year) AS mx FROM historical_agency_crime",
  state_national: "SELECT MIN(year) AS mn, MAX(year) AS mx FROM historical_state_national",
  agency_clearance: "SELECT MIN(year) AS mn, MAX(year) AS mx FROM historical_agency_clearance WHERE COALESCE(murder_clr, rape_clr, robbery_clr, assault_clr, burglary_clr, theft_clr, motor_vehicle_theft_clr, violent_clr, property_clr) IS NOT NULL",
  national_clearance: "SELECT MIN(year) AS mn, MAX(year) AS mx FROM national_clearance_rate",
  staffing: "SELECT MIN(year) AS mn, MAX(year) AS mx FROM historical_staffing WHERE all_total > 0",
};
const boundCache = new WeakMap<Database.Database, Map<SourceId, Bounds>>();

/** Measured year bounds of a source table (C3). Null when they cannot be read; never a hard-coded default. */
export function historicalSourceBounds(db: Database.Database, source: SourceId): Bounds {
  let m = boundCache.get(db);
  if (!m) { m = new Map(); boundCache.set(db, m); }
  if (m.has(source)) return m.get(source)!;
  let b: Bounds = null;
  try {
    const row = db.prepare(BOUND_SQL[source]).get() as { mn: number | null; mx: number | null } | undefined;
    b = row && row.mn !== null && row.mx !== null ? { min: Number(row.mn), max: Number(row.mx) } : null;
  } catch { b = null; }
  m.set(source, b);
  return b;
}

/* ------------------------------------------------------------------------------------- agencies ----------------- */

type Agency = { ori: string; label: string };

/** One Historical agency for a named city or county, or a decline. Never a guess between two. */
export function resolveHistoricalAgency(db: Database.Database, place: Extract<PlaceRef, { kind: "agency" }>): Agency | string {
  const consolidation = findConsolidatedAgency(place.state, place.name);
  if (consolidation) return { ori: consolidation.historicalOri, label: `${consolidation.alias}, ${place.state.toUpperCase()}` };
  let rows: { ori: string; agency: string; state: string }[] = [];
  try {
    if (place.agencyKind === "county") {
      rows = db.prepare(`SELECT ha.ori, ha.agency, ha.state FROM historical_agency ha WHERE ${historicalCountyAgencyPredicate(place.state, place.name)}`).all() as typeof rows;
    } else {
      const names = [...new Set([place.name, place.name.replace(/\s+city$/i, "")].map((n) => n.toUpperCase()))];
      rows = db.prepare(`SELECT ori, agency, state FROM historical_agency WHERE UPPER(state) = ? AND LOWER(type) = 'city' AND UPPER(agency) IN (${names.map(() => "?").join(", ")})`).all(sourceState(place.state).toUpperCase(), ...names) as typeof rows;
    }
  } catch { rows = []; }
  if (rows.length === 0) return `I couldn't find a Historical ${place.agencyKind === "county" ? "county agency" : "city agency"} for ${place.label}, so I haven't answered with a number for it.`;
  if (rows.length > 1) return `I found more than one Historical agency for ${place.label} (${rows.map((r) => r.ori).join(", ")}), so I haven't picked one. Please name the agency.`;
  return { ori: rows[0].ori, label: `${rows[0].agency}, ${displayState(rows[0].state)}` };
}

/* ------------------------------------------------------------------------------------- cells -------------------- */

type Cell = { value: number | null; note: string | null; population?: number | null };
const AGENCY_COL: Record<string, string> = { murder: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "assault", burglary: "burglary", theft: "theft", motor_vehicle_theft: "motor_vehicle_theft", violent: "violent", property: "property" };
const SN_COL: Record<string, string> = { murder: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "aggravated_assault", burglary: "burglary", theft: "theft", motor_vehicle_theft: "auto_theft" };
const SN_PARTS: Record<string, string[]> = { violent: ["murder", "rape", "robbery", "aggravated_assault"], property: ["burglary", "theft", "motor_vehicle_theft"], total: ["murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft"] };
const CLR_COL: Record<string, string> = { murder: "murder_clr", rape: "rape_clr", robbery: "robbery_clr", aggravated_assault: "assault_clr", burglary: "burglary_clr", theft: "theft_clr", motor_vehicle_theft: "motor_vehicle_theft_clr", violent: "violent_clr", property: "property_clr" };
const NCLR_COL: Record<string, string> = { murder: "murder_rate", rape: "rape_rate", robbery: "robbery_rate", aggravated_assault: "assault_rate", burglary: "burglary_rate", theft: "theft_rate", motor_vehicle_theft: "auto_theft_rate", violent: "violent_rate", property: "property_rate" };
const STAFF_COL: Record<string, string> = { officers: "officer_total", civilians: "civilian_total", employees: "all_total" };
const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/**
 * A series reader: the statement it runs and a cell function over the rows it returned. Each statement selects ONLY the
 * requested measures, and a rate is ONE expression over its approved population (the structural guard's contract holds
 * for application-built statements too). The count expression is also selected for an agency rate so a missing count
 * ("not reported") is told apart from a missing population ("no population").
 */
type SeriesReader = { sql: string; cell: (year: number, measure: Measure) => Cell };
const yearsClause = (col: string, years: number[]) => `${col} BETWEEN ${Math.min(...years)} AND ${Math.max(...years)}`;
const slug = (m: string) => m.replace(/[^a-z_]/g, "");

function agencyCountExpr(m: Measure): string {
  return m === "total" ? "(hac.violent + hac.property)" : `hac.${AGENCY_COL[m]}`;
}
function agencyCrimeReader(deps: CompileDeps, ori: string, years: number[], statistic: Statistic, measures: Measure[]): SeriesReader {
  const rate = statistic !== "count";
  const cols = measures.flatMap((m) => rate
    ? [`${agencyCountExpr(m)} AS c_${slug(m)}`, `${agencyCountExpr(m)} * 100000.0 / NULLIF(hap.population, 0) AS r_${slug(m)}`]
    : [`${agencyCountExpr(m)} AS c_${slug(m)}`]);
  const sql = `SELECT hac.year AS year, ${cols.join(", ")}${rate ? ", hap.population AS hap_population" : ""} FROM historical_agency_crime hac${rate ? " LEFT JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year" : ""} WHERE hac.ori = ${q(ori)} AND ${yearsClause("hac.year", years)} ORDER BY hac.year`;
  const rows = deps.execute(sql);
  const byYear = new Map(rows.map((r) => [Number(r.year), r]));
  return { sql, cell: (year, m) => {
    const row = byYear.get(year);
    if (!row) return { value: null, note: "no report" };
    const count = num(row[`c_${slug(m)}`]);
    if (count === null) return { value: null, note: "not reported" };
    if (!rate) return { value: count, note: null };
    const pop = num(row.hap_population);
    const value = num(row[`r_${slug(m)}`]);
    if (pop === null || pop <= 0 || value === null) return { value: null, note: "no population" };
    return { value, note: null, population: pop };
  } };
}
function stateExpr(m: Measure, statistic: Statistic): string {
  const parts = SN_PARTS[m] ?? [m];
  const cols = parts.map((p) => (statistic === "count" ? SN_COL[p] : `${SN_COL[p]}_rate`));
  return cols.length === 1 ? cols[0] : `(${cols.join(" + ")})`;
}
function stateReader(deps: CompileDeps, stateName: string, years: number[], statistic: Statistic, measures: Measure[]): SeriesReader {
  const cols = measures.map((m) => `${stateExpr(m, statistic)} AS v_${slug(m)}`);
  const sql = `SELECT year, ${cols.join(", ")}, population FROM historical_state_national WHERE state = ${q(stateName)} AND ${yearsClause("year", years)} ORDER BY year`;
  const rows = deps.execute(sql);
  const byYear = new Map(rows.map((r) => [Number(r.year), r]));
  return { sql, cell: (year, m) => {
    const row = byYear.get(year);
    if (!row) return { value: null, note: "no data" };
    const v = num(row[`v_${slug(m)}`]);
    return v === null ? { value: null, note: "not reported" } : { value: v, note: null, population: num(row.population) };
  } };
}
function clearanceReader(deps: CompileDeps, place: { kind: "agency"; ori: string } | { kind: "national" }, years: number[], measures: Measure[]): SeriesReader {
  const sql = place.kind === "agency"
    ? `SELECT year, ${measures.map((m) => `${CLR_COL[m]} AS v_${slug(m)}`).join(", ")} FROM historical_agency_clearance WHERE ori = ${q(place.ori)} AND ${yearsClause("year", years)} ORDER BY year`
    : `SELECT year, ${measures.map((m) => `${NCLR_COL[m]} AS v_${slug(m)}`).join(", ")} FROM national_clearance_rate WHERE ${yearsClause("year", years)} ORDER BY year`;
  const rows = deps.execute(sql);
  const byYear = new Map(rows.map((r) => [Number(r.year), r]));
  return { sql, cell: (year, m) => {
    const row = byYear.get(year);
    const v = row ? num(row[`v_${slug(m)}`]) : null;
    return v === null ? { value: null, note: "no clearance figures" } : { value: v, note: null };
  } };
}
function staffingReader(deps: CompileDeps, ori: string, years: number[], statistic: Statistic, measures: Measure[]): SeriesReader {
  const per = statistic === "per_100k" ? "100000.0" : "1000.0";
  const rate = statistic !== "count";
  const cols = measures.flatMap((m) => rate
    ? [`hs.${STAFF_COL[m]} AS c_${slug(m)}`, `hs.${STAFF_COL[m]} * ${per} / NULLIF(hap.population, 0) AS r_${slug(m)}`]
    : [`hs.${STAFF_COL[m]} AS c_${slug(m)}`]);
  const sql = `SELECT hs.year AS year, hs.all_total AS all_total, ${cols.join(", ")}${rate ? ", hap.population AS hap_population" : ""} FROM historical_staffing hs${rate ? " LEFT JOIN historical_agency_population hap ON hap.ori = hs.ori AND hap.year = hs.year" : ""} WHERE hs.ori = ${q(ori)} AND ${yearsClause("hs.year", years)} ORDER BY hs.year`;
  const rows = deps.execute(sql);
  const byYear = new Map(rows.map((r) => [Number(r.year), r]));
  return { sql, cell: (year, m) => {
    const row = byYear.get(year);
    const all = row ? num(row.all_total) : null;
    if (!row || all === null || all <= 0) return { value: null, note: "no staffing reported" };
    const v = num(row[`c_${slug(m)}`]);
    if (v === null || v <= 0) return { value: null, note: "only total employees reported" };
    if (!rate) return { value: v, note: null };
    const pop = num(row.hap_population);
    const value = num(row[`r_${slug(m)}`]);
    if (pop === null || pop <= 0 || value === null) return { value: null, note: "no population" };
    return { value, note: null, population: pop };
  } };
}

/* ------------------------------------------------------------------------------------- wording ------------------ */

const STAT_WORD: Record<Statistic, string> = {
  count: "reported count", rate_per_100k: "rate per 100,000 residents", percent_cleared: "percent cleared",
  per_1000: "per 1,000 residents", per_100k: "per 100,000 residents",
};
function sourceWord(source: SourceId): string {
  return source === "state_national" ? "FBI state and national estimates"
    : source === "agency_crime" ? "FBI agency reports"
      : source === "agency_clearance" ? "FBI agency clearance figures"
        : source === "national_clearance" ? "FBI national clearance figures"
          : "FBI police employee (staffing) reports";
}
function yearsText(years: number[]): string {
  if (years.length === 0) return "";
  const sorted = [...years].sort((a, b) => a - b);
  const runs: string[] = [];
  let start = sorted[0], prev = sorted[0];
  for (const y of sorted.slice(1).concat([NaN])) {
    if (y === prev + 1) { prev = y; continue; }
    runs.push(start === prev ? String(start) : `${start}–${prev}`);
    start = y; prev = y;
  }
  return runs.join(", ");
}
const NOTE_SENTENCE: Record<string, string> = {
  "no report": "no report for", "not reported": "not reported for", "no population": "no population recorded (so no rate) for",
  "no data": "no data for", "no clearance figures": "no clearance figures for", "no staffing reported": "no staffing reported for",
  "only total employees reported": "only total employees were reported (no officer/civilian split) for",
};
const SINGULAR: Record<Measure, string> = {
  murder: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "aggravated assault", burglary: "burglary", theft: "theft",
  motor_vehicle_theft: "motor vehicle theft", violent: "violent crime", property: "property crime", total: "total crime (violent plus property)",
  officers: "sworn officers", civilians: "civilian employees", employees: "total employees",
};
function measureText(m: Measure, statistic: Statistic): string {
  if (statistic === "count") return MEASURE_LABEL[m];
  if (statistic === "percent_cleared") return `${SINGULAR[m]} clearance rate (percent cleared)`;
  if (statistic === "rate_per_100k") return `${SINGULAR[m]} rate per 100,000 residents`;
  return `${SINGULAR[m]} ${STAT_WORD[statistic]}`;
}

/* ------------------------------------------------------------------------------------- compile ------------------ */

type SeriesTarget = { place: PlaceRef; label: string; source: SourceId; reader: (years: number[], measures: Measure[]) => SeriesReader };

function seriesTarget(deps: CompileDeps, spec: { family: SeriesSpec["family"]; statistic: Statistic }, place: PlaceRef): SeriesTarget | string {
  const source = sourceFor(spec.family, place);
  if (!["agency_crime", "state_national", "agency_clearance", "national_clearance", "staffing"].includes(source)) return source;
  const sid = source as SourceId;
  if (place.kind === "agency") {
    const agency = resolveHistoricalAgency(deps.db, place);
    if (typeof agency === "string") return agency;
    const reader = sid === "agency_crime" ? (ys: number[], ms: Measure[]) => agencyCrimeReader(deps, agency.ori, ys, spec.statistic, ms)
      : sid === "agency_clearance" ? (ys: number[], ms: Measure[]) => clearanceReader(deps, { kind: "agency", ori: agency.ori }, ys, ms)
        : (ys: number[], ms: Measure[]) => staffingReader(deps, agency.ori, ys, spec.statistic, ms);
    // Stage 3b r2 (R2.4'): an agency crime rate is that agency's count for a year divided by its population for that year
    // (agencyCrimeReader's SQL: count * per / population); recorded with the place it names.
    if (sid === "agency_crime" && spec.statistic !== "count") recordWhyFacts({ kind: "rate", method: "historical-annual", per: String(spec.statistic).includes("1000") && !String(spec.statistic).includes("100k") ? 1000 : 100000, places: [agency.label] });
    return { place, label: agency.label, source: sid, reader };
  }
  const stateName = place.kind === "national" ? "United States" : place.name;
  const reader = sid === "national_clearance" ? (ys: number[], ms: Measure[]) => clearanceReader(deps, { kind: "national" }, ys, ms) : (ys: number[], ms: Measure[]) => stateReader(deps, stateName, ys, spec.statistic, ms);
  return { place, label: stateName, source: sid, reader };
}

export function compileHistoricalSpec(spec: HistoricalSpec, deps: CompileDeps): CompileResult {
  try {
    if (spec.type === "H4") return compileRank(spec, deps);
    if (spec.type === "H6") return compileChange(spec, deps);
    return compileSeries(spec, deps);
  } catch (err) {
    return { kind: "decline", explanation: `I couldn't build this Historical answer (${err instanceof Error ? err.message : String(err)}), so I haven't answered with a number.` };
  }
}

function compileSeries(spec: SeriesSpec, deps: CompileDeps): CompileResult {
  const now = deps.now ?? new Date();
  const places: PlaceRef[] = spec.type === "H5"
    ? statesInTable(deps).map((name) => ({ kind: "state", name, label: name }))
    : spec.places;
  const targets: SeriesTarget[] = [];
  for (const p of places) {
    const t = seriesTarget(deps, spec, p);
    if (typeof t === "string") return { kind: "decline", explanation: t };
    targets.push(t);
  }
  // Data-anchored forms in a mixed-source request anchor on the EARLIEST source max (C3).
  const sourceBounds = new Map(targets.map((t) => [t.source, historicalSourceBounds(deps.db, t.source)]));
  const maxes = [...sourceBounds.values()].map((b) => b?.max).filter((x): x is number => typeof x === "number");
  const mixed = new Set(targets.map((t) => t.source)).size > 1;
  const dataAnchored = spec.period.form === "latest" || spec.period.form === "all" || spec.period.form === "none";
  const anchor = mixed && dataAnchored && maxes.length ? Math.min(...maxes) : undefined;

  const columns = spec.total ? ["period", "place", "measure", "statistic", "value", "years_with_reports", "note"] : ["year", "place", "measure", "statistic", "value", "note"];
  const rows: Record<string, unknown>[] = [];
  const sqls: string[] = [];
  const notes: string[] = [];
  const returned: string[] = [];
  const delivered: TypedDeliveredSeries[] = [];
  let anyYears = false;
  let periodWords = "";
  for (const t of targets) {
    const resolved = resolveYears(spec.period, sourceBounds.get(t.source) ?? null, now, anchor);
    if (resolved.kind === "decline") {
      if (targets.length === 1) return { kind: "decline", explanation: `I can't answer for ${t.label}: ${resolved.reason}` };
      notes.push(`${t.label}: ${resolved.reason}`);
      continue;
    }
    const b = sourceBounds.get(t.source);
    if (resolved.explicit && b && resolved.years.every((y) => y < b.min || y > b.max)) {
      const msg = `${sourceWord(t.source)} cover ${b.min}–${b.max}, so there is nothing for ${yearsText(resolved.years)}`;
      if (targets.length === 1) return { kind: "decline", explanation: `I can't answer for ${t.label}: ${msg}. The latest year in this source is ${b.max}.` };
      notes.push(`${t.label}: ${msg}.`);
    }
    anyYears = true;
    const reader = t.reader(resolved.years, spec.measures);
    sqls.push(reader.sql);
    periodWords = periodWords || yearsText(resolved.years);
    if (resolved.clippedFrom) {
      const req = resolved.clippedFrom;
      const missing = req.filter((y) => !resolved.years.includes(y));
      notes.push(`${t.label}: you asked for ${yearsText(req)}; ${sourceWord(t.source)} in this data cover ${b ? `${b.min}–${anchor ?? b.max}` : "fewer years"}, so ${yearsText(missing)} ${missing.length === 1 ? "is" : "are"} not included.`);
    }
    let gotValue = false;
    for (const m of spec.measures) {
      const cells = resolved.years.map((y) => ({ y, c: reader.cell(y, m) }));
      if (spec.total) {
        const valued = cells.filter((x) => x.c.value !== null);
        const missing = cells.filter((x) => x.c.value === null).map((x) => x.y);
        const value = valued.length ? valued.reduce((a, x) => a + (x.c.value as number), 0) : null;
        const period = `${Math.min(...resolved.years)}-${Math.max(...resolved.years)}`;
        // A period total's series years are the years summed into it (plan r2 §2).
        delivered.push({ source: t.source, placeKind: t.place.kind, measure: m, statistic: spec.statistic, years: valued.map((x) => x.y) });
        rows.push({ period, place: t.label, measure: m, statistic: spec.statistic, value, years_with_reports: valued.length, note: missing.length ? `no report for ${yearsText(missing).replace(/–/g, "-")}` : null });
        if (valued.length) gotValue = true;
        if (missing.length) notes.push(valued.length
          ? `${t.label}: the total covers the ${valued.length} year${valued.length === 1 ? "" : "s"} with reports; no report for ${yearsText(missing)}.`
          : `${t.label}: no report for ${yearsText(missing)}, so there is no total.`);
        continue;
      }
      const byNote = new Map<string, number[]>();
      delivered.push({ source: t.source, placeKind: t.place.kind, measure: m, statistic: spec.statistic, years: cells.filter((x) => x.c.value !== null).map((x) => x.y) });
      for (const { y, c } of cells) {
        const rounded = spec.statistic === "count" ? c.value : r1(c.value);
        rows.push({ year: y, place: t.label, measure: m, statistic: spec.statistic, value: rounded, note: c.note });
        if (c.value !== null) gotValue = true;
        if (c.note) byNote.set(c.note, [...(byNote.get(c.note) ?? []), y]);
      }
      for (const [note, ys] of byNote) {
        const who = spec.measures.length > 1 ? `${t.label} ${MEASURE_LABEL[m]}` : t.label;
        notes.push(`${who}: ${NOTE_SENTENCE[note] ?? note} ${yearsText(ys)}.`);
      }
    }
    if (gotValue) returned.push(t.label);
  }
  if (!anyYears) return { kind: "decline", explanation: `I can't answer this: ${notes.join(" ")}` };
  const measureWords = spec.measures.map((m) => measureText(m, spec.statistic)).join(", ");
  const placeWords = spec.type === "H5" ? "each state" : targets.map((t) => t.label).join(", ");
  const sources = [...new Set(targets.map((t) => sourceWord(t.source)))].join(" and ");
  const lead = spec.total
    ? `Total ${MEASURE_LABEL[spec.measures[0]]} in ${placeWords}, ${periodWords} (${sources}).`
    : `${capital(measureWords)} for ${placeWords}, ${periodWords}${spec.type === "H1" && rows.length === 1 ? "" : ", by year"} (${sources}).`;
  const rapeNote = spec.measures.includes("rape") ? " Rape here is the FBI UCR rape category, which can be narrower than legal definitions of sexual assault." : "";
  const countyNote = targets.some((t) => t.place.kind === "agency" && t.place.agencyKind === "county") ? " A county figure here is the county (sheriff's) agency's own report, not a countywide total of every agency in the county." : "";
  const staffNote = spec.family === "staffing" ? " Years marked as having only total employees are shown without an officer or civilian figure; nothing is substituted." : "";
  const anchorNote = anchor !== undefined ? ` ${anchor} is the latest year all of these sources have, so every series stops there.` : "";
  const explanation = [lead + anchorNote + rapeNote + countyNote + staffNote, ...notes, "Agency reporting to the FBI can be incomplete in some years."].join(" ").replace(/\s+/g, " ").trim();
  const title = spec.total ? `Total ${capital(MEASURE_LABEL[spec.measures[0]])}, ${placeWords}` : `${capital(measureWords)}: ${spec.type === "H5" ? "By State" : placeWords}`;
  const chartConfig: ChartConfig | null = spec.total || rows.length <= 1 ? null : {
    type: "line", xAxis: "year", yAxis: ["value"], title,
    yAxisLabel: spec.statistic === "count" ? "Count" : STAT_WORD[spec.statistic],
  } as unknown as ChartConfig;
  return { kind: "answer", sql: sqls.join(";\n"), columns, rows, title, explanation, chartConfig, requestedEntities: targets.map((t) => t.label), returnedEntities: returned, deliveredSeries: delivered };
}

function statesInTable(deps: CompileDeps): string[] {
  const rows = deps.execute("SELECT DISTINCT state FROM historical_state_national ORDER BY state");
  return rows.map((r) => String(r.state)).filter((s) => STATE_FULL.has(s));
}

const ENTITY_TYPES: Record<RankSpec["entity"], string[]> = {
  city: ["city"], county: ["county"], agency: ["city", "county", "university", "tribal", "other", "state_police"], state: [],
};

function compileRank(spec: RankSpec, deps: CompileDeps): CompileResult {
  const now = deps.now ?? new Date();
  const source: SourceId = spec.entity === "state" ? "state_national" : spec.family === "clearance" ? "agency_clearance" : spec.family === "staffing" ? "staffing" : "agency_crime";
  const bounds = historicalSourceBounds(deps.db, source);
  const resolved = resolveYears(spec.period.form === "none" ? { form: "latest" } : spec.period, bounds, now);
  if (resolved.kind === "decline") return { kind: "decline", explanation: `I can't build this ranking: ${resolved.reason}` };
  const year = resolved.years[0];
  if (bounds && (year < bounds.min || year > bounds.max)) return { kind: "decline", explanation: `I can't build this ranking for ${year}: ${sourceWord(source)} cover ${bounds.min}–${bounds.max}. The latest year in this source is ${bounds.max}.` };
  // r2 §4: every place in scope is read (LEFT JOIN from the agency list), so each exclusion is counted under one reason
  // and stated -- nothing is left out silently. States are counted against the 50 states and DC.
  type Reason = "no report" | "not reported" | "no population";
  type Entry = { place: string; value: number | null; population: number | null; reason: Reason | null };
  let sql: string;
  let entries: Entry[];
  let statesMissing = 0;
  const rate = spec.statistic !== "count" && spec.statistic !== "percent_cleared";
  if (spec.entity === "state") {
    sql = `SELECT state, year, ${stateExpr(spec.measure, spec.statistic)} AS v, population FROM historical_state_national WHERE year = ${year} ORDER BY state`;
    const rows = deps.execute(sql).filter((r) => STATE_FULL.has(String(r.state)));
    entries = rows.map((r) => ({ place: String(r.state), value: num(r.v), population: spec.statistic === "count" ? null : num(r.population), reason: num(r.v) === null ? "not reported" : null }));
    statesMissing = STATE_FULL.size - entries.filter((e) => e.value !== null).length;
  } else {
    const types = ENTITY_TYPES[spec.entity].map(q).join(", ");
    const scope = spec.scope.kind === "state" ? ` AND UPPER(ha.state) = ${q(sourceState((STATE_NAME_TO_ABBR as Record<string, string>)[spec.scope.name] ?? spec.scope.name).toUpperCase())}` : "";
    const per = spec.statistic === "per_1000" ? "1000.0" : "100000.0";
    const countExpr = spec.family === "crime" ? agencyCountExpr(spec.measure) : spec.family === "clearance" ? `hac.${CLR_COL[spec.measure]}` : `hac.${STAFF_COL[spec.measure]}`;
    const cols = [`${countExpr} AS c`, ...(rate ? [`${countExpr} * ${per} / NULLIF(hap.population, 0) AS r`] : []), ...(spec.family === "staffing" ? ["hac.all_total AS all_total"] : [])];
    const table = spec.family === "crime" ? "historical_agency_crime" : spec.family === "clearance" ? "historical_agency_clearance" : "historical_staffing";
    sql = `SELECT ha.ori, ha.agency, ha.state, hac.ori AS reported_ori, ${cols.join(", ")}, hap.population AS hap_population FROM historical_agency ha LEFT JOIN ${table} hac ON hac.ori = ha.ori AND hac.year = ${year} LEFT JOIN historical_agency_population hap ON hap.ori = ha.ori AND hap.year = ${year} WHERE LOWER(ha.type) IN (${types})${scope} ORDER BY ha.agency`;
    const rows = deps.execute(sql);
    entries = rows.map((r) => {
      const pop = num(r.hap_population);
      const c = num(r.c);
      const place = `${String(r.agency)}, ${displayState(String(r.state))}`;
      if (r.reported_ori === null || r.reported_ori === undefined) return { place, value: null, population: pop, reason: "no report" as Reason };
      if (spec.family === "staffing") {
        const all = num(r.all_total);
        if (all === null || all <= 0) return { place, value: null, population: pop, reason: "no report" as Reason };
        if (c === null || c <= 0) return { place, value: null, population: pop, reason: "not reported" as Reason };
      } else if (c === null) return { place, value: null, population: pop, reason: "not reported" as Reason };
      if (!rate) return { place, value: c, population: pop, reason: null };
      return pop && pop > 0 ? { place, value: num(r.r), population: pop, reason: null } : { place, value: null, population: pop, reason: "no population" as Reason };
    });
  }
  const countOf = (reason: Reason) => entries.filter((e) => e.reason === reason).length;
  let pool = entries.filter((e) => e.value !== null);
  let belowMin = 0;
  let unknownPopulation = 0;
  if (spec.min) {
    // Q3: a missing population means the minimum can't be checked -- "population unknown", never "below the minimum".
    unknownPopulation = pool.filter((e) => e.population === null).length;
    const known = pool.filter((e) => e.population !== null);
    pool = known.filter((e) => (spec.min!.op === ">" ? (e.population as number) > spec.min!.amount : (e.population as number) >= spec.min!.amount));
    belowMin = known.length - pool.length;
  }
  const perResident = rate;
  // r2 §3: a per-resident LIST (no rank words) is alphabetical, not ranked, so no tiny place appears to lead.
  const alphabetical = !spec.rank && perResident && spec.entity !== "state"; // states are exempt (owner ruling): no tiny denominators
  const dir = spec.rank?.dir ?? "top";
  if (alphabetical) pool.sort((a, b) => a.place.localeCompare(b.place));
  else pool.sort((a, b) => (dir === "top" ? (b.value as number) - (a.value as number) : (a.value as number) - (b.value as number)) || a.place.localeCompare(b.place));
  const chosen = spec.rank ? pool.slice(0, spec.rank.n) : pool;
  const rows = chosen.map((e, i) => ({ rank: alphabetical ? null : i + 1, place: e.place, year, measure: spec.measure, statistic: spec.statistic, value: spec.statistic === "count" ? e.value : r1(e.value), population: perResident ? e.population : null }));
  const entityWord = spec.entity === "state" ? "states" : spec.entity === "city" ? "cities" : spec.entity === "county" ? "county agencies" : "agencies";
  const oneWord = spec.entity === "state" ? "state" : spec.entity === "city" ? "city agency" : spec.entity === "county" ? "county agency" : "agency";
  const manyWord = spec.entity === "state" ? "states" : spec.entity === "city" ? "city agencies" : spec.entity === "county" ? "county agencies" : "agencies";
  const scopeWord = spec.scope.kind === "state" ? ` in ${spec.scope.name}` : spec.entity === "state" ? "" : " nationwide";
  const minWord = spec.min ? `, among ${entityWord} with ${spec.min.op === ">" ? "more than" : "at least"} ${spec.min.amount.toLocaleString("en-US")} residents` : "";
  const what = measureText(spec.measure, spec.statistic);
  const head = spec.rank
    ? `${spec.rank.dir === "top" ? "Top" : "Bottom"} ${spec.rank.n} ${entityWord}${scopeWord} by ${what} in ${year}${minWord}${spec.rank.stated ? "" : spec.rank.n === 1 ? "" : ` (${spec.rank.n} shown, since no number was given)`}.`
    : alphabetical
      ? `${capital(what)} for ${entityWord}${scopeWord} in ${year}${minWord}, listed alphabetically: this is a list, not a ranking.`
      : `${capital(what)} for ${entityWord}${scopeWord} in ${year}${minWord}, highest first.`;
  const latestWord = spec.period.form === "none" || spec.period.form === "latest" ? ` ${year} is the latest year in this source.` : "";
  const n = (k: number, verbOne: string, verbMany: string) => `${k} ${k === 1 ? oneWord : manyWord}${scopeWord} ${k === 1 ? verbOne : verbMany}`;
  const excluded = [
    spec.entity === "state" && statesMissing ? `${statesMissing} ${statesMissing === 1 ? "state has" : "states (of the 50 and DC) have"} no figures for ${year}, so ${statesMissing === 1 ? "it is" : "they are"} not shown.` : "",
    spec.entity !== "state" && countOf("no report") ? `${n(countOf("no report"), "has", "have")} no report for ${year}, so ${countOf("no report") === 1 ? "it is" : "they are"} not shown.` : "",
    spec.entity !== "state" && countOf("not reported") ? `${n(countOf("not reported"), "has", "have")} a report for ${year} without this figure, so ${countOf("not reported") === 1 ? "it is" : "they are"} not shown.` : "",
    countOf("no population") ? `${n(countOf("no population"), "has", "have")} no population recorded for ${year}, so no rate.` : "",
    unknownPopulation ? `${n(unknownPopulation, "has", "have")} an unknown population (population unknown), so the minimum can't be checked and ${unknownPopulation === 1 ? "it is" : "they are"} not shown.` : "",
    belowMin ? `${n(belowMin, "is", "are")} below the minimum population.` : "",
  ].filter(Boolean).join(" ");
  const clearanceNote = spec.family === "clearance" ? " Clearance figures are percentages; small agencies can show 0% or 100% from very few cases." : "";
  const explanation = `${head}${latestWord} Source: ${sourceWord(source)}.${clearanceNote} ${excluded}`.replace(/\s+/g, " ").trim();
  if (rows.length === 0) return { kind: "decline", explanation: `No ${entityWord}${scopeWord} have a ${what} for ${year}${minWord}. ${excluded}`.trim() };
  const title = spec.rank ? `${spec.rank.dir === "top" ? "Top" : "Bottom"} ${spec.rank.n} ${capital(entityWord)}${scopeWord} by ${capital(what)}, ${year}` : `${capital(what)} by ${capital(entityWord.replace(/ies$/, "y").replace(/s$/, ""))}${scopeWord}, ${year}`;
  const chartConfig = { type: "bar", xAxis: "place", yAxis: ["value"], title } as unknown as ChartConfig;
  // One series per delivered row, with that row's own place kind: a state row is never national, whatever the scope.
  const deliveredSeries: TypedDeliveredSeries[] = chosen.map((e) => ({ source, placeKind: spec.entity === "state" ? "state" : "agency", measure: spec.measure, statistic: spec.statistic, years: e.value === null ? [] : [year] }));
  return { kind: "answer", sql, columns: ["rank", "place", "year", "measure", "statistic", "value", "population"], rows, title, explanation, chartConfig, requestedEntities: [], returnedEntities: rows.map((r) => r.place), deliveredSeries };
}

function compileChange(spec: ChangeSpec, deps: CompileDeps): CompileResult {
  const targets: SeriesTarget[] = [];
  for (const p of spec.places) {
    const t = seriesTarget(deps, { family: spec.family, statistic: spec.base }, p);
    if (typeof t === "string") return { kind: "decline", explanation: t };
    targets.push(t);
  }
  let later: number;
  if (spec.later === "anchor") {
    const maxes = targets.map((t) => historicalSourceBounds(deps.db, t.source)?.max);
    if (maxes.some((m) => typeof m !== "number")) return { kind: "decline", explanation: "The latest year in this data can't be confirmed, so I can't resolve \"since\" for a change. Please name both years." };
    later = Math.min(...(maxes as number[]));
    if (later <= spec.earlier) return { kind: "decline", explanation: `The latest year in this data is ${later}, so there is nothing after ${spec.earlier} to compare.` };
  } else later = spec.later;
  const rows: Record<string, unknown>[] = [];
  const sqls: string[] = [];
  const notes: string[] = [];
  const returned: string[] = [];
  const delivered: TypedDeliveredSeries[] = [];
  for (const t of targets) {
    const reader = t.reader([spec.earlier, later], [spec.measure]);
    sqls.push(reader.sql);
    const e = reader.cell(spec.earlier, spec.measure);
    const l = reader.cell(later, spec.measure);
    delivered.push({ source: t.source, placeKind: t.place.kind, measure: spec.measure, statistic: spec.base, years: [e.value === null ? null : spec.earlier, l.value === null ? null : later].filter((y): y is number => y !== null) });
    let change: number | null = null, pct: number | null = null, note: string | null = null;
    if (e.value === null || l.value === null) {
      note = [e.value === null ? `${e.note} for ${spec.earlier}` : null, l.value === null ? `${l.note} for ${later}` : null].filter(Boolean).join("; ");
      notes.push(`${t.label}: ${note}, so no change is shown.`);
    } else {
      change = l.value - e.value;
      if (e.value === 0) { note = "no percent change from a base of 0"; notes.push(`${t.label}: ${spec.earlier} had 0, so no percent change from a base of 0 is shown.`); }
      else pct = change / e.value * 100;
      returned.push(t.label);
    }
    const out = (v: number | null) => (spec.base === "count" ? v : r1(v));
    rows.push({ place: t.label, measure: spec.measure, statistic: spec.base, earlier_year: spec.earlier, earlier_value: out(e.value), later_year: later, later_value: out(l.value), change: change === null ? null : r1(change), percent_change: r1(pct), note });
  }
  const what = measureText(spec.measure, spec.base);
  const anchorWord = spec.later === "anchor" ? ` ${later} is the latest year in this data.` : "";
  const explanation = `Change in ${what} from ${spec.earlier} to ${later} for ${targets.map((t) => t.label).join(", ")} (${[...new Set(targets.map((t) => sourceWord(t.source)))].join(" and ")}). Percent change uses ${spec.earlier} as the base.${anchorWord} ${notes.join(" ")}`.replace(/\s+/g, " ").trim();
  const title = `Change in ${capital(what)}, ${spec.earlier} to ${later}`;
  return { kind: "answer", sql: sqls.join(";\n"), columns: ["place", "measure", "statistic", "earlier_year", "earlier_value", "later_year", "later_value", "change", "percent_change", "note"], rows, title, explanation, chartConfig: null, requestedEntities: targets.map((t) => t.label), returnedEntities: returned, deliveredSeries: delivered };
}

function capital(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s; }
