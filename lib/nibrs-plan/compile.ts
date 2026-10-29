/**
 * Plan -> DuckDB compiler, v0 (engine phase 1, step 2): agency-level plan forms, compiled to one SQL statement over
 * nibrs-model's canonical parquet tables (read-only). Everything outside v0 is refused with its reason; nothing is
 * approximated.
 *
 * v0 covers:
 *   - one agency (ORI). States and the nation need status evidence across their agencies (D6) and come later;
 *   - an absolute period (resolve.ts gives it) with incident-date time basis;
 *   - groupings: at most one time grouping (time.month or time.year), plus attribute groupings on the counted entity's
 *     own columns (victim race, sex, ethnicity; offense location type). Every category that occurs in the place and
 *     period is shown in every period row (`absent: "show"`); no bins, no multi-value;
 *   - one measure: offense segments (with their occurrence key) or incidents with given offense codes, victims connected
 *     to person offenses, or carjacking offenses or incidents. Group B offenses are not offense segments and are refused;
 *   - statistics: `count`, and `share` of that count within the time grouping (each period's own total of the measure);
 *   - filters: an existence over property at incident scope (`attribution: "incident_level_only"`), with `in`
 *     conditions on loss type and description, all on one property segment. The answer then carries the fixed
 *     statement `property_not_attributed`;
 *   - no transforms; cohort all_reporting.
 * A unit is placed in time by its incident date (the incident month). Every data year from the period's first year on
 * is scanned, because an incident can arrive in a later year's file.
 *
 * Status (D6), per month, from the agency-month status of the incident month's own data year:
 *   - REPORTED_CRIMES: the count; a category or measure with no units there is UNKNOWN_UNEVIDENCED_ZERO (blank);
 *   - REPORTED_ZERO: 0 (a share of an empty month is UNAVAILABLE);
 *   - UNKNOWN: blank;
 *   - rows counted under a month whose status is not REPORTED_CRIMES (an incident from a later year's file, say)
 *     contradict that status: EVIDENCE_CONFLICT, and a result holding one must be refused (`CompiledQuery.refuseOn`).
 * A year or a total is known only when every month in it is. A share is computed from its own month's units, never
 * from the cells shown.
 *
 * Measure definitions are an executable draft for the canonical tables, until the shared semantic layer (nibrs-model
 * D7/D8) lands; they are in `unitsSql` below.
 */
import { GROUP_B, MEASURE_CODES, PERSON_CODES } from "../nibrs-question-types";
import type { NibrsPlan } from "./plan";
import type { AnswerStatement } from "./result";
import type { ResolvedPeriod } from "./resolve";

export type CompiledQuery = {
  sql: string;
  /** Output columns in order: the period key (when grouped by time), each attribute grouping, then per statistic its value and status. */
  columns: string[];
  scanYears: number[];
  /** Statuses that make the whole result unusable: the caller refuses it. */
  refuseOn: string[];
  /** The fixed answer statements this result requires (result.ts). */
  statements: AnswerStatement[];
};
export type CompileResult = { kind: "query"; query: CompiledQuery } | { kind: "unsupported"; reason: string };

/** Canonical table location: `<root>/<table>/data_year=<y>/data.parquet`. */
export type CompileTarget = { root: string; builtYears: number[] };

const CARJACK_VEHICLES = ["03", "05", "24", "28", "37"];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]) => xs.map(q).join(", ");
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Attribute groupings v0 can read, by the counted entity: dimension -> column of that entity's table alias. */
const GROUPABLE: Record<string, Record<string, string>> = {
  victim: { "victim.race": "v.race", "victim.sex": "v.sex", "victim.ethnicity": "v.ethnicity" },
  offense: { "offense.location_type": "o.location_type" },
  incident: {},
};
/** Property conditions v0 can apply: dimension -> property column. */
const PROPERTY_COLUMNS: Record<string, string> = { "property.loss_type": "loss_type", "property.description": "property_description" };

type Units = { sql: string; entity: "victim" | "offense" | "incident" };
/** The units of one measure: one row per counted unit, with its key, ORI, incident month (YYYYMM) and grouping columns. */
function unitsSql(measureId: string, unit: string, read: (table: string) => string, groupCols: string[], incidentFilter: (alias: string) => string): Units | { error: string } {
  const extra = groupCols.map((c, i) => `, ${c} AS g${i}`).join("");
  if (measureId === "offenses.carjacking") {
    // D18: robbery-based, so counted by offense: the 120 segments of carjacking incidents (on 20261028-test5 the same
    // number as the incidents in every agency-month; the compile gate checks it).
    if (unit !== "offense") return { error: `offenses.carjacking is counted by offense, not ${unit}` };
    return { entity: "offense", sql: `SELECT o.data_year, o.ori, o.incident_num, o.offense_code || ':' || o.key_occurrence AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o
      WHERE o.offense_code = '120' AND EXISTS (
        SELECT 1 FROM ${read("property")} p
        WHERE p.data_year = o.data_year AND p.ori = o.ori AND p.incident_num = o.incident_num
          AND p.loss_type = '7' AND p.property_description IN (${list(CARJACK_VEHICLES)}))${incidentFilter("o")}` };
  }
  if (measureId === "incidents.carjacking") {
    if (unit !== "incident") return { error: `carjacking is counted by incident, not ${unit}` };
    return { entity: "incident", sql: `SELECT DISTINCT o.data_year, o.ori, o.incident_num, NULL AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o
      WHERE o.offense_code = '120' AND EXISTS (
        SELECT 1 FROM ${read("property")} p
        WHERE p.data_year = o.data_year AND p.ori = o.ori AND p.incident_num = o.incident_num
          AND p.loss_type = '7' AND p.property_description IN (${list(CARJACK_VEHICLES)}))${incidentFilter("o")}` };
  }
  // Exactly <kind>.<measure>, with a measure whose codes are known.
  const m = measureId.match(/^(offenses|incidents|victims)\.([a-z_]+)$/);
  const codes = m ? MEASURE_CODES[m[2]] : undefined;
  if (!m || !codes) return { error: `measure "${measureId}" has no executable definition in v0` };
  if (codes.some((c) => GROUP_B.has(c))) return { error: `"${measureId}" is a Group B offense: Group B arrests are not offense segments` };
  const kind = m[1];
  if (kind === "offenses" && unit === "offense") {
    // An offense segment's identity includes its occurrence key (a code repeated within an incident).
    return { entity: "offense", sql: `SELECT o.data_year, o.ori, o.incident_num, o.offense_code || ':' || o.key_occurrence AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o WHERE o.offense_code IN (${list(codes)})${incidentFilter("o")}` };
  }
  if (kind === "incidents" && unit === "incident") {
    return { entity: "incident", sql: `SELECT DISTINCT o.data_year, o.ori, o.incident_num, NULL AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o WHERE o.offense_code IN (${list(codes)})${incidentFilter("o")}` };
  }
  if (kind === "victims" && unit === "victim") {
    if (!codes.every((c) => PERSON_CODES.has(c))) return { error: `"${measureId}" counts victims of offenses that are not crimes against persons; not in v0` };
    return { entity: "victim", sql: `SELECT DISTINCT v.data_year, v.ori, v.incident_num, v.victim_seq || ':' || v.key_occurrence AS sub, substr(v.incident_date, 1, 6) AS ym${extra}
      FROM ${read("victim")} v JOIN ${read("victim_offense")} vo
        ON vo.data_year = v.data_year AND vo.ori = v.ori AND vo.incident_num = v.incident_num
       AND vo.victim_seq = v.victim_seq AND vo.key_occurrence = v.key_occurrence
      WHERE vo.connected_offense IN (${list(codes)})${incidentFilter("v")}` };
  }
  return { error: `measure "${measureId}" counted by ${unit} has no executable definition in v0` };
}

const ENTITY_OF: Record<string, string> = { offenses: "offense", incidents: "incident", victims: "victim" };

export function compilePlan(plan: NibrsPlan, period: ResolvedPeriod, t: CompileTarget): CompileResult {
  const no = (reason: string): CompileResult => ({ kind: "unsupported", reason });
  if (period.kind !== "absolute") return no("v0 compiles absolute periods only (year lists come later)");
  if (plan.timeBasis !== "incident_date") return no(`v0 places units by incident date, not ${plan.timeBasis}`);
  if (plan.measures.length !== 1) return no("v0 compiles one measure");
  if (plan.measures[0].filters?.length) return no("v0 compiles plan-level filters only");
  if (plan.transforms.length) return no("v0 compiles plans without transforms");
  if (plan.coverage.cohort !== "all_reporting") return no("v0 compiles the all-reporting cohort only");
  if (plan.geography.places.length !== 1) return no("v0 compiles one place");
  const place = plan.geography.places[0];
  if (place.kind !== "agency") return no(`v0 compiles one agency; ${place.kind} totals need status evidence across their agencies (D6) and come later`);
  if (plan.groupings.some((g) => g.absent !== "show" || g.bins || g.multiValue)) return no("v0 shows every category, without bins or multi-value groupings");

  // Groupings: at most one time grouping, first; then attributes of the counted entity.
  const m = plan.measures[0];
  const entity = ENTITY_OF[m.id.split(".")[0]] ?? "";
  const timeDims = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const attrDims = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if (timeDims.length > 1 || timeDims.some((g) => g.dimension !== "time.month" && g.dimension !== "time.year")) return no("v0 groups time by month or by year, once");
  if (timeDims.length && plan.groupings[0] !== timeDims[0]) return no("v0 puts the time grouping first");
  const groupCols: string[] = [];
  for (const g of attrDims) {
    const col = GROUPABLE[entity]?.[g.dimension];
    if (!col) return no(`v0 cannot group ${entity || m.id} by ${g.dimension}`);
    groupCols.push(col);
  }

  // Statistics: a count, and optionally its share within the time grouping.
  const [count, ...rest] = plan.statistics;
  if (!count || count.kind !== "count" || count.measure !== m.as) return no("v0 compiles a count of the plan's measure first");
  if (rest.length > 1) return no("v0 compiles a count and at most one share");
  const share = rest[0];
  if (share && (share.kind !== "share" || share.measure !== m.as || share.denominator || JSON.stringify(share.within) !== JSON.stringify(timeDims.map((g) => g.dimension)) || !attrDims.length))
    return no("v0 compiles a share only of the counted measure, within the time grouping, over attribute categories");

  // Filters: incident-scoped existence over property only.
  const statements: AnswerStatement[] = [];
  const incidentConds: string[] = [];
  for (const f of plan.filters) {
    if (f.kind !== "exists" || f.entity !== "property" || f.scope !== "incident" || f.attribution !== "incident_level_only" || f.negate)
      return no("v0 compiles filters that are incident-level existences over property only");
    const conds: string[] = [];
    for (const w of f.where) {
      const col = w.kind === "attribute" ? PROPERTY_COLUMNS[w.dimension] : undefined;
      if (!col || w.op !== "in" || !w.values?.length) return no(`v0 cannot apply the property condition on ${w.kind === "attribute" ? w.dimension : "?"}`);
      conds.push(`p.${col} IN (${list(w.values.map(String))})`);
    }
    incidentConds.push(conds.join(" AND "));
    if (!statements.includes("property_not_attributed")) statements.push("property_not_attributed");
  }

  const from = period.from.replace("-", ""), to = period.to.replace("-", "");
  const firstYear = Number(period.from.slice(0, 4));
  const years = t.builtYears.filter((y) => y >= firstYear);
  if (!years.length) return no(`no built data year at or after ${firstYear}`);
  const read = (table: string) => `read_parquet([${years.map((y) => q(`${t.root}/${table}/data_year=${y}/data.parquet`)).join(", ")}], hive_partitioning = true)`;
  const incidentFilter = (a: string) => incidentConds.map((c) => `
      AND EXISTS (SELECT 1 FROM ${read("property")} p WHERE p.data_year = ${a}.data_year AND p.ori = ${a}.ori AND p.incident_num = ${a}.incident_num AND ${c})`).join("");
  const units = unitsSql(m.id, m.unit, read, groupCols, incidentFilter);
  if ("error" in units) return no(units.error);

  const g = groupCols.map((_, i) => `g${i}`);
  const gSel = g.map((x) => `, ${x}`).join("");
  const key = `(u.data_year, u.ori, u.incident_num, u.sub)`;
  const inScope = `u.ori = ${q(place.ori)} AND u.ym BETWEEN ${q(from)} AND ${q(to)}`;
  const parts = [
    `units AS (${units.sql})`,
    `scoped AS (SELECT * FROM units u WHERE ${inScope})`,
    // Every month of the period, so a month with no rows still gets a status.
    `spine AS (SELECT strftime(d, '%Y%m') AS ym FROM range(DATE ${q(`${period.from}-01`)}, DATE ${q(`${period.to}-01`)} + INTERVAL 1 MONTH, INTERVAL 1 MONTH) r(d))`,
    `status AS (SELECT CAST(data_year AS VARCHAR) || lpad(CAST(month AS VARCHAR), 2, '0') AS ym, status
      FROM ${read("agency_month_status")} WHERE ori = ${q(place.ori)})`,
    // The month's own total of the measure: the evidence for the month and every share's denominator.
    `month_total AS (SELECT u.ym, COUNT(DISTINCT ${key}) AS n FROM scoped u GROUP BY u.ym)`,
    `month_cells AS (SELECT s.ym, coalesce(t.n, 0) AS den,
      CASE WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' AND coalesce(t.n, 0) > 0 THEN 'EVIDENCE_CONFLICT'
           WHEN coalesce(st.status, 'UNKNOWN') = 'REPORTED_ZERO' THEN 'REPORTED_ZERO'
           WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' THEN 'UNKNOWN'
           WHEN coalesce(t.n, 0) = 0 THEN 'UNKNOWN_UNEVIDENCED_ZERO' ELSE 'VALUE' END AS month_cell
      FROM spine s LEFT JOIN status st USING (ym) LEFT JOIN month_total t USING (ym))`,
  ];
  if (g.length) {
    // Every category that occurs in the place and period, in every month.
    parts.push(`cats AS (SELECT DISTINCT ${g.join(", ")} FROM scoped)`);
    parts.push(`counted AS (SELECT u.ym${g.map((x) => `, u.${x}`).join("")}, COUNT(DISTINCT ${key}) AS n FROM scoped u GROUP BY ALL)`);
    parts.push(`cells AS (SELECT mc.ym${g.map((x) => `, c.${x}`).join("")}, mc.den, mc.month_cell, coalesce(k.n, 0) AS n,
      CASE WHEN mc.month_cell = 'VALUE' AND coalesce(k.n, 0) = 0 THEN 'UNKNOWN_UNEVIDENCED_ZERO' ELSE mc.month_cell END AS cell
      FROM month_cells mc CROSS JOIN cats c
      LEFT JOIN counted k ON k.ym = mc.ym${g.map((x) => ` AND k.${x} IS NOT DISTINCT FROM c.${x}`).join("")})`);
  } else {
    parts.push(`cells AS (SELECT ym, den, month_cell, den AS n, month_cell AS cell FROM month_cells)`);
  }

  const grain = timeDims[0]?.dimension === "time.month" ? "month" : timeDims[0]?.dimension === "time.year" ? "year" : "total";
  const known = (c: string) => `${c} IN ('VALUE', 'REPORTED_ZERO')`;
  const countName = ident(count.as), shareName = share ? ident(share.as) : "";
  let body: string;
  if (grain === "month") {
    const shareCols = share ? `,
      CASE WHEN cell = 'VALUE' AND den > 0 THEN n::DOUBLE / den END AS ${shareName},
      CASE WHEN cell = 'VALUE' AND den > 0 THEN 'VALUE' WHEN cell = 'REPORTED_ZERO' THEN 'UNAVAILABLE' ELSE cell END AS ${ident(`${share.as}_status`)}` : "";
    body = `SELECT substr(ym, 1, 4) || '-' || substr(ym, 5, 2) AS period${gSel},
      CASE WHEN ${known("cell")} THEN n END AS ${countName}, cell AS ${ident(`${count.as}_status`)}${shareCols}
      FROM cells ORDER BY ym${gSel}`;
  } else {
    // A year or total is a sum of months: known only when every month of it is. A share of a year divides by the year's
    // own units, which (one unit, one category) is the sum of its months' totals.
    const pk = grain === "year" ? `substr(ym, 1, 4) AS period, ` : "";
    const rolled = (c: string) => `CASE WHEN bool_or(${c} = 'EVIDENCE_CONFLICT') THEN 'EVIDENCE_CONFLICT' WHEN bool_and(${known(c)}) THEN CASE WHEN sum(n) = 0 AND bool_or(month_cell = 'VALUE') THEN 'UNKNOWN_UNEVIDENCED_ZERO' WHEN sum(n) = 0 THEN 'REPORTED_ZERO' ELSE 'VALUE' END ELSE 'UNKNOWN' END`;
    const shareCols = share ? `,
      CASE WHEN bool_and(${known("cell")}) AND sum(n) > 0 THEN sum(n)::DOUBLE / sum(den) END AS ${shareName},
      CASE WHEN bool_or(cell = 'EVIDENCE_CONFLICT') THEN 'EVIDENCE_CONFLICT' WHEN NOT bool_and(${known("cell")}) THEN 'UNKNOWN'
           WHEN sum(den) = 0 THEN 'UNAVAILABLE' WHEN sum(n) = 0 THEN 'UNKNOWN_UNEVIDENCED_ZERO' ELSE 'VALUE' END AS ${ident(`${share.as}_status`)}` : "";
    body = `SELECT ${pk}${g.join(", ")}${g.length ? ", " : ""}
      CASE WHEN bool_and(${known("cell")}) AND NOT (sum(n) = 0 AND bool_or(month_cell = 'VALUE')) THEN sum(n) END AS ${countName}, ${rolled("cell")} AS ${ident(`${count.as}_status`)}${shareCols}
      FROM cells${grain === "year" || g.length ? ` GROUP BY ${[...(grain === "year" ? ["1"] : []), ...g].join(", ")} ORDER BY ${[...(grain === "year" ? ["1"] : []), ...g].join(", ")}` : ""}`;
  }
  const columns = [...(grain === "total" ? [] : ["period"]), ...attrDims.map((x) => x.dimension), count.as, `${count.as}_status`, ...(share ? [share.as, `${share.as}_status`] : [])];
  const sql = `WITH ${parts.join(",\n")}\n${body}`;
  return { kind: "query", query: { sql, columns, scanYears: years, refuseOn: ["EVIDENCE_CONFLICT"], statements } };
}
