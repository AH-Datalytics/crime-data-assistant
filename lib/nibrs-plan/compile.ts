/**
 * Plan -> DuckDB compiler, v0 (engine phase 1, step 2): the simplest plan forms, compiled to one SQL statement over
 * nibrs-model's canonical parquet tables (read-only). Everything outside v0 is refused with its reason; nothing is
 * approximated.
 *
 * v0 covers:
 *   - one agency (ORI). States and the nation need status evidence across their agencies (D6) and come next;
 *   - an absolute period (resolve.ts gives it), by month (time.month), by year (time.year) or as one total, with every
 *     row shown (`absent: "show"`), no bins;
 *   - incident-date time basis;
 *   - one measure with the `count` statistic: offenses (segments) or incidents with given offense codes, victims
 *     connected to person offenses, and carjacking incidents. Group B offenses are not offense segments and are refused;
 *   - no filters, no transforms, cohort all_reporting.
 * A unit is placed in time by its incident date (the incident month). Every data year from the period's first year on
 * is scanned, because an incident can arrive in a later year's file.
 *
 * Status (D6), per month: the agency-month status of the incident month's own data year.
 *   REPORTED_CRIMES gives the count; a zero count there is UNKNOWN_UNEVIDENCED_ZERO (blank).
 *   REPORTED_ZERO gives 0; UNKNOWN gives blank.
 *   Rows counted for a month whose status is not REPORTED_CRIMES (an incident from a later year's file, say) contradict
 *   that status: the cell is EVIDENCE_CONFLICT, and a result holding one must be refused, never shown
 *   (`CompiledQuery.refuseOn`).
 * A year or a total is known only when every month in it is.
 *
 * Measure definitions are an executable draft for the canonical tables, until the shared semantic layer (nibrs-model
 * D7/D8) lands; each is in `unitsSql` below.
 */
import { GROUP_B, MEASURE_CODES, PERSON_CODES } from "../nibrs-question-types";
import type { NibrsPlan } from "./plan";
import type { ResolvedPeriod } from "./resolve";

export type CompiledQuery = {
  sql: string;
  /** Output columns in order: the grouping (period key) when there is one, then value and status. */
  columns: string[];
  scanYears: number[];
  /** Statuses that make the whole result unusable: the caller refuses it. */
  refuseOn: string[];
  notes: string[];
};
export type CompileResult = { kind: "query"; query: CompiledQuery } | { kind: "unsupported"; reason: string };

/** Canonical table location: `<root>/<table>/data_year=<y>/data.parquet`. */
export type CompileTarget = { root: string; builtYears: number[] };

const CARJACK_VEHICLES = ["03", "05", "24", "28", "37"];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]) => xs.map(q).join(", ");

/** The units of one measure: one row per counted unit, with its key, ORI and incident month (YYYYMM). */
function unitsSql(measureId: string, unit: string, t: CompileTarget, years: number[]): string | { error: string } {
  const read = (table: string) => `read_parquet([${years.map((y) => q(`${t.root}/${table}/data_year=${y}/data.parquet`)).join(", ")}], hive_partitioning = true)`;
  if (measureId === "incidents.carjacking") {
    if (unit !== "incident") return { error: `carjacking is counted by incident, not ${unit}` };
    return `SELECT DISTINCT o.data_year, o.ori, o.incident_num, NULL AS sub, substr(o.incident_date, 1, 6) AS ym
      FROM ${read("offense")} o
      WHERE o.offense_code = '120' AND EXISTS (
        SELECT 1 FROM ${read("property")} p
        WHERE p.data_year = o.data_year AND p.ori = o.ori AND p.incident_num = o.incident_num
          AND p.loss_type = '7' AND p.property_description IN (${list(CARJACK_VEHICLES)}))`;
  }
  // Exactly <kind>.<measure>, with a measure whose codes are known.
  const m = measureId.match(/^(offenses|incidents|victims)\.([a-z_]+)$/);
  const codes = m ? MEASURE_CODES[m[2]] : undefined;
  if (!m || !codes) return { error: `measure "${measureId}" has no executable definition in v0` };
  if (codes.some((c) => GROUP_B.has(c))) return { error: `"${measureId}" is a Group B offense: Group B arrests are not offense segments` };
  const kind = m[1];
  if (kind === "offenses" && unit === "offense") {
    // An offense segment's identity includes its occurrence key (a code repeated within an incident).
    return `SELECT o.data_year, o.ori, o.incident_num, o.offense_code || ':' || o.key_occurrence AS sub, substr(o.incident_date, 1, 6) AS ym
      FROM ${read("offense")} o WHERE o.offense_code IN (${list(codes)})`;
  }
  if (kind === "incidents" && unit === "incident") {
    return `SELECT DISTINCT o.data_year, o.ori, o.incident_num, NULL AS sub, substr(o.incident_date, 1, 6) AS ym
      FROM ${read("offense")} o WHERE o.offense_code IN (${list(codes)})`;
  }
  if (kind === "victims" && unit === "victim") {
    if (!codes.every((c) => PERSON_CODES.has(c))) return { error: `"${measureId}" counts victims of offenses that are not crimes against persons; not in v0` };
    return `SELECT DISTINCT v.data_year, v.ori, v.incident_num, v.victim_seq || ':' || v.key_occurrence AS sub, substr(v.incident_date, 1, 6) AS ym
      FROM ${read("victim")} v JOIN ${read("victim_offense")} vo
        ON vo.data_year = v.data_year AND vo.ori = v.ori AND vo.incident_num = v.incident_num
       AND vo.victim_seq = v.victim_seq AND vo.key_occurrence = v.key_occurrence
      WHERE vo.connected_offense IN (${list(codes)})`;
  }
  return { error: `measure "${measureId}" counted by ${unit} has no executable definition in v0` };
}

export function compilePlan(plan: NibrsPlan, period: ResolvedPeriod, t: CompileTarget): CompileResult {
  const no = (reason: string): CompileResult => ({ kind: "unsupported", reason });
  if (period.kind !== "absolute") return no("v0 compiles absolute periods only (year lists come later)");
  if (plan.timeBasis !== "incident_date") return no(`v0 places units by incident date, not ${plan.timeBasis}`);
  if (plan.measures.length !== 1) return no("v0 compiles one measure");
  if (plan.statistics.length !== 1 || plan.statistics[0].kind !== "count") return no("v0 compiles the count statistic only");
  if (plan.filters.length || plan.measures[0].filters?.length) return no("v0 compiles plans without filters");
  if (plan.transforms.length) return no("v0 compiles plans without transforms");
  if (plan.coverage.cohort !== "all_reporting") return no("v0 compiles the all-reporting cohort only");
  if (plan.geography.places.length !== 1) return no("v0 compiles one place");
  const dims = plan.groupings.map((g) => g.dimension);
  if (dims.some((d) => d !== "time.month" && d !== "time.year") || dims.length > 1) return no("v0 groups by month or by year only");
  if (plan.groupings.some((g) => g.absent !== "show" || g.bins || g.multiValue)) return no("v0 shows every period row, without bins");
  const place = plan.geography.places[0];
  if (place.kind !== "agency") return no(`v0 compiles one agency; ${place.kind} totals need status evidence across their agencies (D6) and come next`);

  const from = period.from.replace("-", ""), to = period.to.replace("-", "");
  const firstYear = Number(period.from.slice(0, 4));
  const years = t.builtYears.filter((y) => y >= firstYear);
  if (!years.length) return no(`no built data year at or after ${firstYear}`);
  const m = plan.measures[0];
  const units = unitsSql(m.id, m.unit, t, years);
  if (typeof units !== "string") return no(units.error);

  const grain = dims[0] === "time.month" ? "month" : dims[0] === "time.year" ? "year" : "total";
  const counted = `counted AS (SELECT u.ym, COUNT(DISTINCT (u.data_year, u.ori, u.incident_num, u.sub)) AS n
      FROM units u WHERE u.ori = ${q(place.ori)} AND u.ym BETWEEN ${q(from)} AND ${q(to)} GROUP BY u.ym)`;
  // Every month of the period, so a month with no rows still gets a status.
  const spine = `spine AS (SELECT strftime(d, '%Y%m') AS ym FROM range(DATE ${q(`${period.from}-01`)}, DATE ${q(`${period.to}-01`)} + INTERVAL 1 MONTH, INTERVAL 1 MONTH) r(d))`;
  const status = `status AS (SELECT CAST(data_year AS VARCHAR) || lpad(CAST(month AS VARCHAR), 2, '0') AS ym, status
      FROM read_parquet([${years.map((y) => q(`${t.root}/agency_month_status/data_year=${y}/data.parquet`)).join(", ")}], hive_partitioning = true)
      WHERE ori = ${q(place.ori)})`;
  const cells = `cells AS (SELECT s.ym, coalesce(c.n, 0) AS n,
      CASE WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' AND coalesce(c.n, 0) > 0 THEN 'EVIDENCE_CONFLICT'
           WHEN coalesce(st.status, 'UNKNOWN') = 'REPORTED_ZERO' THEN 'REPORTED_ZERO'
           WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' THEN 'UNKNOWN'
           WHEN coalesce(c.n, 0) = 0 THEN 'UNKNOWN_UNEVIDENCED_ZERO' ELSE 'VALUE' END AS cell
      FROM spine s LEFT JOIN status st USING (ym) LEFT JOIN counted c USING (ym))`;
  const known = `bool_and(cell IN ('VALUE', 'REPORTED_ZERO'))`;
  const rolled = `CASE WHEN bool_or(cell = 'EVIDENCE_CONFLICT') THEN 'EVIDENCE_CONFLICT' WHEN ${known} THEN 'VALUE' ELSE 'UNKNOWN' END`;
  const body = grain === "month"
    ? `SELECT substr(ym, 1, 4) || '-' || substr(ym, 5, 2) AS period, CASE WHEN cell IN ('VALUE', 'REPORTED_ZERO') THEN n END AS value, cell AS status FROM cells ORDER BY ym`
    : grain === "year"
      // A year is a sum of its months; it is known only when every month of it in the period is known.
      ? `SELECT substr(ym, 1, 4) AS period, CASE WHEN ${known} THEN sum(n) END AS value, ${rolled} AS status FROM cells GROUP BY 1 ORDER BY 1`
      : `SELECT CASE WHEN ${known} THEN sum(n) END AS value, ${rolled} AS status FROM cells`;
  const sql = `WITH units AS (${units}),\n${counted},\n${spine},\n${status},\n${cells}\n${body}`;
  return { kind: "query", query: { sql, columns: grain === "total" ? ["value", "status"] : ["period", "value", "status"], scanYears: years, refuseOn: ["EVIDENCE_CONFLICT"], notes: [] } };
}
