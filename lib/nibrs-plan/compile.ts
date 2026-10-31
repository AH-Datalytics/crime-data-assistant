/**
 * Plan -> DuckDB compiler, v0 (engine phase 1, step 2): agency-level plan forms, compiled to one SQL statement over
 * nibrs-model's canonical parquet tables (read-only). Everything outside v0 is refused with its reason; nothing is
 * approximated.
 *
 * v0 covers:
 *   - one agency (ORI). States and the nation need status evidence across their agencies (D6) and come later;
 *   - an absolute period (resolve.ts gives it), or a set of years grouped by year ("in 2019 and 2024": each year's
 *     months only), with incident-date time basis, or arrest date for arrests (P50);
 *   - groupings: at most one time grouping (time.month or time.year), plus attribute groupings (`absent: "show"`: every
 *     category that occurs in the place and period is shown in every period row):
 *       - the counted entity's own columns (victim, offender or arrestee race, sex, ethnicity; offense location type);
 *       - age, in the plan's bins (P30: NN, NB and BB are under one year, in the bin holding 1; 99 is "over 98", a
 *         number; 00 is "Unknown"; blank is not recorded);
 *       - multi-valued (`multiValue: "each_value"`, required exactly for these): the weapons of an offense, the
 *         relationships of a victim, and the sexes of the incident's offenders for a crime (P49; offender 00, none
 *         known, is "unknown_offender"). A unit counts once under each value, so the answer carries the fixed
 *         statement `categories_overlap`; at most one grouping from another table;
 *   - one measure: offense segments (with their occurrence key) or incidents with given offense codes, victims connected
 *     to person offenses, carjacking offenses or incidents, offender segments of incidents with the codes (P44), or
 *     arrestee segments by arrest offense (P46: each arrest once, statement `arrests_counted_once`). Group B offenses
 *     are not offense segments and are refused;
 *   - statistics: `count`, and `share` of that count within the time grouping (each period's own total of the measure);
 *   - filters, each an existence:
 *       - over property at incident scope (`attribution: "incident_level_only"`), with `in` conditions on loss type and
 *         description, all on one property segment. The answer then carries the fixed statement `property_not_attributed`;
 *       - over the weapons of the counted offense, or of the offense connecting a counted victim (P31);
 *       - over a counted victim's relationships to its offenders (P36);
 *   - no transforms; cohort all_reporting.
 * A unit is placed in time by its incident date (the incident month), an arrest by its arrest date. Every data year
 * from the period's first year on is scanned, because an incident can arrive in a later year's file; for arrests every
 * built year, because an arrest sits in its incident's file.
 *
 * Status (D6), per month, from the agency-month status of the month's own data year (an arrest's: its arrest month):
 *   - REPORTED_CRIMES: the count; a category or measure with no units there is a known 0, VALUE (P51, Jeff 2026-10-29:
 *     "if the reporting shows crimes for that agency that month but a filter comes up empty then it should be 0");
 *   - REPORTED_ZERO: 0;
 *   - a share whose denominator is 0 is UNAVAILABLE;
 *   - UNKNOWN: blank;
 *   - rows counted under a month whose status is not REPORTED_CRIMES (an incident from a later year's file, say)
 *     contradict that status: EVIDENCE_CONFLICT, and a result holding one must be refused (`CompiledQuery.refuseOn`).
 * A year or a total is known only when every month in it is; it is REPORTED_ZERO only when every month is. A share is computed from its own month's units, never
 * from the cells shown.
 *
 * Measure definitions are an executable draft for the canonical tables, until the shared semantic layer (nibrs-model
 * D7/D8) lands; they are in `unitsSql` below.
 */
import { GROUP_B, MEASURE_CODES, PERSON_CODES } from "../nibrs-question-types";
import type { NibrsPlan } from "./plan";
import { clearanceDims, peopleFacts, type AnswerStatement } from "./result";
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

/**
 * Canonical table location: `<root>/<table>/data_year=<y>/data.parquet`. `agencies` (increment 4): compile the plan's
 * measure for each of these ORIs as a monthly grid (columns ori, period, count, status), whatever the plan's geography
 * names (several agencies, combined, or a state's agencies). Totals, combined sums, rates and rankings are rolled from
 * the grid (lib/nibrs-plan/transforms.ts), so each agency-month keeps its own status (D6).
 */
export type CompileTarget = { root: string; builtYears: number[]; agencies?: string[] };

const CARJACK_VEHICLES = ["03", "05", "24", "28", "37"];
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const list = (xs: string[]) => xs.map(q).join(", ");
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

type Entity = "victim" | "offense" | "incident" | "offender" | "arrestee";
type Read = (table: string) => string;
/**
 * Joins. A segment reaches its incident's other segments by the incident's keys alone. `key_occurrence` is NOT an
 * incident key: the canonical build numbers lines that share one segment's sequence (or code) within an incident, per
 * segment family (nibrs-model BUILD-RULES T1), so it joins only a parent segment to its own child rows (an offense to
 * its weapons; a victim to its connected offenses and offender relationships), never one family to another.
 */
const sameIncident = (x: string, y: string) => `${x}.data_year = ${y}.data_year AND ${x}.ori = ${y}.ori AND ${x}.incident_num = ${y}.incident_num`;
const sameVictim = (x: string, y: string) => `${sameIncident(x, y)} AND ${x}.victim_seq = ${y}.victim_seq AND ${x}.key_occurrence = ${y}.key_occurrence`;
const sameOffense = (x: string, y: string) => `${sameIncident(x, y)} AND ${x}.offense_code = ${y}.offense_code AND ${x}.key_occurrence = ${y}.key_occurrence`;

/**
 * A grouping v0 can read: the column (an expression over the units query's aliases: o, v, f, a), and for a dimension on
 * another table the LEFT JOIN that brings it (a unit with no such row falls in the not-recorded category, NULL).
 * `multi` marks a dimension with several values per unit; `age` one read in bins.
 */
type Groupable = { col: string; join?: (read: Read) => string; multi?: true; age?: true; binned?: (bins: { label: string; from: number; to: number }[]) => string };
const own = (col: string): Groupable => ({ col });
const age = (a: string): Groupable => ({ col: `${a}.age`, age: true });
/**
 * P49: a crime by an attribute of its incident's offenders (sex, race, ethnicity, age); offender 00 (none known) is its
 * own category. Each crime counts once under each category present.
 */
const offenderAttr = (a: string, attr: "sex" | "race" | "ethnicity" | "age"): Groupable => {
  const unknown = (x: string) => `CASE WHEN f2.offender_seq = '00' THEN 'unknown_offender' ELSE ${x} END`;
  return { col: unknown(`f2.${attr}`), multi: true, join: (read) => `LEFT JOIN ${read("offender")} f2 ON ${sameIncident("f2", a)}`,
    ...(attr === "age" ? { age: true as const, binned: (bins: { label: string; from: number; to: number }[]) => unknown(ageBins("f2.age", bins)) } : {}) };
};
/**
 * P65 (named pairing only): a victim by an attribute of the offenders its relationship segments link to it. A victim
 * with no relationship segment is "no_relationship", apart from a linked offender whose attribute is unknown.
 */
const pairAttr = (attr: "sex" | "race" | "ethnicity" | "age"): Groupable => {
  const none = (x: string) => `CASE WHEN r.data_year IS NULL THEN 'no_relationship' ELSE ${x} END`;
  return { col: none(`f3.${attr}`), multi: true,
    join: (read) => `LEFT JOIN ${read("victim_offender")} r ON ${sameVictim("r", "v")} LEFT JOIN ${read("offender")} f3 ON ${sameIncident("f3", "r")} AND f3.offender_seq = r.offender_number`,
    ...(attr === "age" ? { age: true as const, binned: (bins: { label: string; from: number; to: number }[]) => none(ageBins("f3.age", bins)) } : {}) };
};
const OFFENDER_ATTRS = ["sex", "race", "ethnicity", "age"] as const;
const offenderGroupings = (a: string) => Object.fromEntries(OFFENDER_ATTRS.map((x) => [`offender.${x}`, offenderAttr(a, x)]));
/**
 * P64, P67: an incident's clearance as of the file, read from its own data year: any arrestee row (C, N or M, P68)
 * makes it cleared by arrest; otherwise an exceptional clearance A-E; otherwise not cleared. Every unit of the incident
 * takes that status (P66). `ca` and `ic` are the joined incident facts.
 */
const typeOf = (arrested: string, exceptional: string) =>
  `CASE WHEN ${arrested} THEN 'arrest' WHEN ${exceptional} IN ('A', 'B', 'C', 'D', 'E') THEN ${exceptional} ELSE 'none' END`;
/** Each clearance dimension from the incident's type (arrest, A-E, none). */
const clearanceCols = (type: string): Record<string, string> => ({
  "offense.clearance_type": type,
  "offense.clearance_method": `CASE ${type} WHEN 'arrest' THEN 'arrest' WHEN 'none' THEN 'none' ELSE 'exceptional' END`,
  "offense.clearance_status": `CASE ${type} WHEN 'none' THEN 'none' ELSE 'cleared' END`,
});
const CLEARANCE_COL = clearanceCols(typeOf("ca.data_year IS NOT NULL", "ic.cleared_exceptionally"));
const clearanceJoin = (a: string) => (read: Read) =>
  `LEFT JOIN ${read("incident")} ic ON ${sameIncident("ic", a)} LEFT JOIN (SELECT DISTINCT data_year, ori, incident_num FROM ${read("arrestee")}) ca ON ${sameIncident("ca", a)}`;
const clearance = (a: string): Record<string, Groupable> =>
  Object.fromEntries(Object.entries(CLEARANCE_COL).map(([d, col]) => [d, { col, join: clearanceJoin(a) }]));
/** The same status as a condition on a unit's own incident (a clearance filter: "cleared by arrest", "uncleared"). */
function clearanceCond(read: Read, a: string, dimension: string, values: string[]): string {
  // Correlated subqueries only (DuckDB has no correlated outer join): the same rule as the grouping's joins.
  const type = typeOf(`EXISTS (SELECT 1 FROM ${read("arrestee")} a4 WHERE ${sameIncident("a4", a)})`,
    `(SELECT max(i4.cleared_exceptionally) FROM ${read("incident")} i4 WHERE ${sameIncident("i4", a)})`);
  return `(${clearanceCols(type)[dimension]}) IN (${list(values)})`;
}
const GROUPABLE: Record<Entity, Record<string, Groupable>> = {
  victim: { "victim.race": own("v.race"), "victim.sex": own("v.sex"), "victim.ethnicity": own("v.ethnicity"), "victim.age": age("v"),
    "victim_offender.relationship": { col: "r.offender_relationship", multi: true, join: (read) => `LEFT JOIN ${read("victim_offender")} r ON ${sameVictim("r", "v")}` },
    ...offenderGroupings("v"), ...Object.fromEntries(OFFENDER_ATTRS.map((x) => [`victim_offender.offender_${x}`, pairAttr(x)])), ...clearance("v") },
  offense: { "offense.location_type": own("o.location_type"),
    "offense_weapon.weapon": { col: "w.weapon", multi: true, join: (read) => `LEFT JOIN ${read("offense_weapon")} w ON ${sameOffense("w", "o")}` },
    ...offenderGroupings("o"), ...clearance("o") },
  incident: { ...clearance("o") },
  // P44 and the segment convention (Trap C): an offender record with sequence 00 (no offender information) is its own
  // category, "unknown_offender", whatever its blank fields hold.
  offender: Object.fromEntries(OFFENDER_ATTRS.map((x) => {
    const seq00 = (c: string) => `CASE WHEN f.offender_seq = '00' THEN 'unknown_offender' ELSE ${c} END`;
    return [`offender.${x}`, x === "age" ? { col: "f.age", age: true as const, binned: (bins: { label: string; from: number; to: number }[]) => seq00(ageBins("f.age", bins)) } : own(seq00(`f.${x}`))];
  })),
  arrestee: { "arrestee.race": own("a.race"), "arrestee.sex": own("a.sex"), "arrestee.ethnicity": own("a.ethnicity"), "arrestee.age": age("a") },
};

/** Age in bins (P30): infants in the bin holding 1, "00" Unknown, blank not recorded (NULL), 01-99 as numbers. */
function ageBins(col: string, bins: { label: string; from: number; to: number }[]): string {
  const infant = bins.find((b) => b.from <= 1 && 1 <= b.to)?.label;
  const n = `TRY_CAST(${col} AS INTEGER)`;
  return `CASE WHEN ${col} IS NULL OR trim(${col}) = '' THEN NULL WHEN ${col} = '00' THEN 'Unknown'
      WHEN ${col} IN ('NN', 'NB', 'BB') THEN ${infant ? q(infant) : "'Outside the groups'"}
      ${bins.map((b) => `WHEN ${n} BETWEEN ${b.from} AND ${b.to} THEN ${q(b.label)}`).join(" ")} ELSE 'Outside the groups' END`;
}

/** Weapon codes as the reader writes them: two characters (any automatic flag), or three (that code, automatic). */
function weaponIn(w: string, values: string[]): string {
  const two = values.filter((v) => v.length === 2), three = values.filter((v) => v.length === 3);
  const conds = [...(two.length ? [`${w}.weapon IN (${list(two)})`] : []), ...(three.length ? [`${w}.weapon || ${w}.weapon_automatic IN (${list(three)})`] : [])];
  return `(${conds.join(" OR ") || "FALSE"})`;
}
/** Property conditions v0 can apply: dimension -> property column. */
const PROPERTY_COLUMNS: Record<string, string> = { "property.loss_type": "loss_type", "property.description": "property_description" };

type Units = { sql: string; entity: Entity };
/**
 * The units of one measure: one row per counted unit and category, with its key, ORI, month (YYYYMM) and grouping
 * columns. `joins` bring groupings from other tables; `incidentFilter` adds the conditions on the counted unit (its
 * alias: o; v with its connecting victim_offense vo; f; a) and its incident.
 */
function unitsSql(measureId: string, unit: string, read: Read, groupCols: string[], joins: string, incidentFilter: (alias: string) => string,
  parts: { rest: (alias: string) => string; own: (alias: string) => string } = { rest: incidentFilter, own: () => "" }): Units | { error: string } {
  const extra = groupCols.map((c, i) => `, ${c} AS g${i}`).join("");
  if (measureId === "offenses.carjacking") {
    // D18: robbery-based, so counted by offense: the 120 segments of carjacking incidents (on 20261028-test5 the same
    // number as the incidents in every agency-month; the compile gate checks it).
    if (unit !== "offense") return { error: `offenses.carjacking is counted by offense, not ${unit}` };
    return { entity: "offense", sql: `SELECT DISTINCT o.data_year, o.ori, o.incident_num, o.offense_code || ':' || o.key_occurrence AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o ${joins}
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
  // Increment 6: every arrest on an incident (any arrest offense, Group B included), M left out (P68), by arrest date;
  // only through a condition on the incident (standalone Group B arrests have none and are not read).
  if (measureId === "arrests.all_crime") {
    if (unit !== "arrest") return { error: `"${measureId}" counts arrests` };
    const cond = incidentFilter("a");
    const groupA = `SELECT DISTINCT a.data_year, a.ori, a.incident_num, a.arrestee_seq || ':' || a.key_occurrence AS sub, substr(a.arrest_date, 1, 6) AS ym${extra}
      FROM ${read("arrestee")} a ${joins} WHERE coalesce(a.multiple_arrestee_indicator, '') <> 'M'${cond}`;
    // A condition on the incident: arrests through it (increment 6). A condition only on the arrestee ("juvenile
    // arrests") still counts every arrest, Group B included, with the condition on both (Codex 04.1).
    if (parts.rest("a")) return { entity: "arrestee", sql: groupA };
    // Increment 7: every arrest, with no incident condition: Group A arrestee segments (M left out, P68) and standalone
    // Group B arrests (the arrest transaction is the key; Group B has no multiple-arrestee indicator). A grouping reads
    // the arrestee's own columns, which both tables carry.
    if (joins.trim()) return { error: "v0 groups every arrest by the arrestee's own columns only" };
    return { entity: "arrestee", sql: `${groupA}
      UNION ALL
      SELECT DISTINCT a.data_year, a.ori, 'B:' || a.arrest_transaction_num AS incident_num, a.arrestee_seq || ':' || CAST(a.occurrence AS VARCHAR) AS sub, substr(a.arrest_date, 1, 6) AS ym${extra}
      FROM ${read("group_b_arrest")} a WHERE a.identical_to_line_no IS NULL${parts.own("a")}` };
  }
  // Exactly <kind>.<measure>, with a measure whose codes are known.
  const m = measureId.match(/^(offenses|incidents|victims|offenders|arrests)\.([a-z_]+)$/);
  const codes = m ? MEASURE_CODES[m[2]] ?? EXTRA_CODES[m[2]] : undefined;
  if (!m || !codes) return { error: `measure "${measureId}" has no executable definition in v0` };
  if (codes.some((c) => GROUP_B.has(c))) return { error: `"${measureId}" is a Group B offense: Group B arrests are not offense segments` };
  const kind = m[1];
  if (kind === "offenses" && unit === "offense") {
    // An offense segment's identity includes its occurrence key (a code repeated within an incident).
    return { entity: "offense", sql: `SELECT DISTINCT o.data_year, o.ori, o.incident_num, o.offense_code || ':' || o.key_occurrence AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o ${joins} WHERE o.offense_code IN (${list(codes)})${incidentFilter("o")}` };
  }
  if (kind === "incidents" && unit === "incident") {
    return { entity: "incident", sql: `SELECT DISTINCT o.data_year, o.ori, o.incident_num, NULL AS sub, substr(o.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offense")} o ${joins} WHERE o.offense_code IN (${list(codes)})${incidentFilter("o")}` };
  }
  if (kind === "victims" && unit === "victim") {
    if (!codes.every((c) => PERSON_CODES.has(c))) return { error: `"${measureId}" counts victims of offenses that are not crimes against persons; not in v0` };
    return { entity: "victim", sql: `SELECT DISTINCT v.data_year, v.ori, v.incident_num, v.victim_seq || ':' || v.key_occurrence AS sub, substr(v.incident_date, 1, 6) AS ym${extra}
      FROM ${read("victim")} v JOIN ${read("victim_offense")} vo
        ON vo.data_year = v.data_year AND vo.ori = v.ori AND vo.incident_num = v.incident_num
       AND vo.victim_seq = v.victim_seq AND vo.key_occurrence = v.key_occurrence ${joins}
      WHERE vo.connected_offense IN (${list(codes)})${incidentFilter("v")}` };
  }
  if (kind === "offenders" && unit === "offender") {
    // P44: the offender segments of incidents with the codes, one per segment (segment 00, no offender known, as recorded).
    return { entity: "offender", sql: `SELECT DISTINCT f.data_year, f.ori, f.incident_num, f.offender_seq || ':' || f.key_occurrence AS sub, substr(f.incident_date, 1, 6) AS ym${extra}
      FROM ${read("offender")} f ${joins}
      WHERE EXISTS (SELECT 1 FROM ${read("offense")} o WHERE ${sameIncident("o", "f")} AND o.offense_code IN (${list(codes)}))${incidentFilter("f")}` };
  }
  if (kind === "arrests" && (unit === "arrest" || unit === "arrestee")) {
    // P46, P50: Group A arrestee segments by arrest offense, each once, placed by arrest date. P68 (DE44): a segment the
    // FBI marks M is the same apprehension reported on another incident, so it is not counted (C and N are).
    return { entity: "arrestee", sql: `SELECT DISTINCT a.data_year, a.ori, a.incident_num, a.arrestee_seq || ':' || a.key_occurrence AS sub, substr(a.arrest_date, 1, 6) AS ym${extra}
      FROM ${read("arrestee")} a ${joins} WHERE a.arrest_offense IN (${list(codes)}) AND coalesce(a.multiple_arrestee_indicator, '') <> 'M'${incidentFilter("a")}` };
  }
  return { error: `measure "${measureId}" counted by ${unit} has no executable definition in v0` };
}

const ENTITY_OF: Record<string, Entity> = { offenses: "offense", incidents: "incident", victims: "victim", offenders: "offender", arrests: "arrestee" };
/** The alias of the counted unit's row in unitsSql. */
const UNIT_ALIAS: Record<Entity, string> = { offense: "o", incident: "o", victim: "v", offender: "f", arrestee: "a" };
/**
 * Increment 7: a condition on a person's own attribute, on alias `x`: `in` a set of sex, race or ethnicity codes, or an
 * age `between` two years (P30: NN, NB and BB are under one year, in a range starting at 1 or below; "00" Unknown and a
 * blank age meet no range).
 */
function personCond(x: string, f: { dimension: string; op: string; values?: (string | number)[] }): string | null {
  const attr = f.dimension.split(".")[1];
  if (["sex", "race", "ethnicity"].includes(attr) && f.op === "in" && f.values?.length) return `${x}.${attr} IN (${list(f.values.map(String))})`;
  if (attr === "age" && f.op === "between" && f.values?.length === 2) {
    const [lo, hi] = f.values.map(Number);
    if (!(lo >= 0 && hi >= lo && hi <= 99)) return null;
    return `(${lo <= 1 ? `${x}.age IN ('NN', 'NB', 'BB') OR ` : ""}TRY_CAST(${x}.age AS INTEGER) BETWEEN ${Math.max(lo, 1)} AND ${hi})`;
  }
  return null;
}
/** Measures the question vocabulary does not name yet (D19's drug crimes: 35A and 35B). */
const EXTRA_CODES: Record<string, string[]> = { drug_equipment: ["35B"] };

/**
 * The agencies of a place and their populations (increment 4), from the canonical agency table's batch-header rows:
 * the FBI's agency population for each data year (P15, P59: the FBI carries the latest forward into the current year).
 * By ORIs, or a state's city agencies (FBI agency indicator 1). Columns: ori, data_year, population, city, state.
 */
export function agencyPopulationSql(root: string, who: { oris: string[] } | { state: string; city: true }, years: number[]): string {
  const where = "oris" in who ? `ori IN (${list(who.oris)})` : `u.state_abbr = ${q(who.state)} AND u.agency_indicator = '1'`;
  // A year with a blank city takes the agency's latest named year.
  return `SELECT ori, u.data_year, u.population,
    coalesce(nullif(trim(u.city), ''), list_last(list_transform(list_filter(by_year, x -> trim(x.city) <> ''), x -> trim(x.city)))) AS city, u.state_abbr AS state
    FROM read_parquet(${q(`${root}/agency/data.parquet`)}), unnest(by_year) AS t(u)
    WHERE ${where} AND u.data_year IN (${years.map(Number).join(", ")}) ORDER BY ori, u.data_year`;
}

export function compilePlan(plan: NibrsPlan, period: ResolvedPeriod, t: CompileTarget): CompileResult {
  const no = (reason: string): CompileResult => ({ kind: "unsupported", reason });
  // A set of years ("in 2019 and 2024"): each year's months only, the last clipped to `through`, grouped by year.
  const yearSet = period.kind === "years" ? [...period.years].sort((a, b) => a - b) : null;
  if (yearSet && !plan.groupings.some((g) => g.dimension === "time.year")) return no("v0 compiles a set of years grouped by year");
  if (plan.measures.length !== 1) return no("v0 compiles one measure");
  const isArrest = plan.measures[0].id.startsWith("arrests.");
  if (plan.timeBasis !== (isArrest ? "arrest_date" : "incident_date"))
    return no(isArrest ? "v0 places arrests by arrest date (P50)" : `v0 places units by incident date, not ${plan.timeBasis}`);
  if (plan.measures[0].filters?.length) return no("v0 compiles plan-level filters only");
  if (plan.transforms.length) return no("v0 compiles plans without transforms");
  if (plan.coverage.cohort !== "all_reporting") return no("v0 compiles the all-reporting cohort only");
  const grid = t.agencies?.length ? [...new Set(t.agencies)].sort() : null;
  const place = plan.geography.places[0];
  if (!grid) {
    if (plan.geography.places.length !== 1) return no("v0 compiles one place");
    if (place.kind !== "agency") return no(`v0 compiles one agency; ${place.kind} totals need status evidence across their agencies (D6) and come later`);
  } else if (plan.groupings.length !== 1 || plan.groupings[0].dimension !== "time.month" || plan.statistics.length !== 1)
    return no("v0 compiles several agencies as a monthly grid of one count");
  const oriIs = (col: string) => (grid ? `${col} IN (${list(grid)})` : `${col} = ${q((place as { ori: string }).ori)}`);
  if (plan.groupings.some((g) => g.absent !== "show")) return no("v0 shows every category");

  // Groupings: at most one time grouping, first; then attributes of the counted entity.
  const m = plan.measures[0];
  const entity = ENTITY_OF[m.id.split(".")[0]];
  if (!entity) return no(`measure "${m.id}" has no executable definition in v0`);
  const timeDims = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const attrDims = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  if (timeDims.length > 1 || timeDims.some((g) => g.dimension !== "time.month" && g.dimension !== "time.year")) return no("v0 groups time by month or by year, once");
  if (timeDims.some((g) => g.bins || g.multiValue)) return no("v0 groups time without bins");
  if (timeDims.length && plan.groupings[0] !== timeDims[0]) return no("v0 puts the time grouping first");
  const groupCols: string[] = [];
  const joins: ((read: Read) => string)[] = [];
  for (const g of attrDims) {
    const d = GROUPABLE[entity][g.dimension];
    if (!d) return no(`v0 cannot group ${entity} by ${g.dimension}`);
    if (!!d.multi !== !!g.multiValue) return no(`${g.dimension} ${d.multi ? "has several values per unit: group it as multi-valued" : "has one value per unit, not several"}`);
    if (!!d.age !== !!g.bins) return no(d.age ? `v0 groups ${g.dimension} in bins` : `v0 bins ages only, not ${g.dimension}`);
    const bins = g.bins ?? [];
    if (bins.some((b, i) => b.from > b.to || bins.some((c, j) => j !== i && b.from <= c.to && c.from <= b.to))) return no("age bins must not overlap (P5)");
    groupCols.push(g.bins ? (d.binned ? d.binned(g.bins) : ageBins(d.col, g.bins)) : d.col);
    if (d.join) joins.push(d.join);
  }
  if (joins.length > 1) return no("v0 groups by one dimension from another table at a time");

  // Statistics: a count, and optionally its share within the time grouping.
  const [count, ...rest0] = plan.statistics;
  if (!count || count.kind !== "count" || count.measure !== m.as) return no("v0 compiles a count of the plan's measure first");
  // P66: the count's incidents, beside it (right after the count, before any share).
  const inc = rest0.find((s) => s.kind === "incidents");
  if (inc && (inc.measure !== m.as || rest0[0] !== inc || (m.unit !== "offense" && m.unit !== "victim"))) return no("v0 compiles the incidents of the counted offenses or victims, right after the count");
  const rest = rest0.filter((s) => s !== inc);
  if (rest.length > 1) return no("v0 compiles a count and at most one share");
  const share = rest[0];
  if (share && (share.kind !== "share" || share.measure !== m.as || share.denominator || JSON.stringify(share.within) !== JSON.stringify(timeDims.map((g) => g.dimension)) || !attrDims.length))
    return no("v0 compiles a share only of the counted measure, within the time grouping, over attribute categories");

  // Filters: existences over incident property, the counted unit's weapons, or a victim's relationships.
  const statements: AnswerStatement[] = [];
  const incidentConds: string[] = [];
  const unitConds: ((read: Read) => string)[] = [];
  // Clearance selections (P64, P66): a condition on the counted unit's own incident.
  const clearanceConds: { dimension: string; values: string[] }[] = [];
  const alias = UNIT_ALIAS[entity];
  const codes = MEASURE_CODES[m.id.split(".")[1]] ?? EXTRA_CODES[m.id.split(".")[1]] ?? [];
  /** Conditions on the counted person's own columns, on alias x. */
  const ownConds: ((x: string) => string)[] = [];
  for (const f of plan.filters) {
    if (f.kind === "attribute" && CLEARANCE_COL[f.dimension] && f.op === "in" && f.values?.length) { clearanceConds.push({ dimension: f.dimension, values: f.values.map(String) }); continue; }
    // Increment 7: a condition on the counted person's own attribute ("female victims", "juvenile arrests").
    if (f.kind === "attribute" && f.dimension.split(".")[0] === entity) {
      if (!personCond(alias, f)) return no(`v0 cannot apply ${f.op} on ${f.dimension}`);
      // Kept apart from the incident's conditions: every arrest applies it to standalone Group B arrests too (Codex 04.1).
      ownConds.push((x) => personCond(x, f)!);
      continue;
    }
    // Increment 7: P49, any offender of the unit's incident with the attributes ("assaults by juveniles"). Offender 00
    // (no offender information) has none.
    if (f.kind === "exists" && !f.negate && f.entity === "offender" && f.scope === "incident" && entity !== "offender") {
      const cs = f.where.map((w) => (w.kind === "attribute" && w.dimension.startsWith("offender.") ? personCond("f4", w) : null));
      if (cs.some((c) => !c)) return no("v0 applies offender conditions on the offender's sex, race, ethnicity or age only");
      unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("offender")} f4 WHERE ${sameIncident("f4", alias)} AND f4.offender_seq <> '00' AND ${cs.join(" AND ")})`);
      continue;
    }
    // Increment 7: P65, an offender the victim's relationship segments link to it ("victims of offenders who were under 18").
    if (f.kind === "exists" && !f.negate && f.entity === "victim_offender" && f.scope === "victim" && entity === "victim"
      && f.where.every((w) => w.kind === "attribute" && w.dimension.startsWith("victim_offender.offender_"))) {
      const cs = f.where.map((w) => personCond("f4", { ...w, dimension: w.dimension.replace("victim_offender.offender_", "offender.") }));
      if (cs.some((c) => !c)) return no("v0 applies linked-offender conditions on sex, race, ethnicity or age only");
      unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("victim_offender")} r4 JOIN ${read("offender")} f4 ON ${sameIncident("f4", "r4")} AND f4.offender_seq = r4.offender_number
        WHERE ${sameVictim("r4", "v")} AND ${cs.join(" AND ")})`);
      continue;
    }
    // Increment 7: an offender linked by a relationship segment, with that relationship, to a victim of the measure's
    // crime ("offenders ... where the victim was a stranger"); each offender once.
    if (f.kind === "exists" && !f.negate && f.entity === "victim_offender" && f.scope === "offender" && entity === "offender") {
      const w = f.where.length === 1 && f.where[0].kind === "attribute" && f.where[0].dimension === "victim_offender.relationship" && f.where[0].op === "in" && f.where[0].values?.length ? f.where[0] : null;
      if (!w || !codes.length) return no("v0 filters offenders by their relationship to a victim of the counted crime only");
      unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("victim_offender")} r4 JOIN ${read("victim_offense")} vo4 ON ${sameVictim("vo4", "r4")}
        WHERE ${sameIncident("r4", "f")} AND r4.offender_number = f.offender_seq AND r4.offender_relationship IN (${list(w.values!.map(String))}) AND vo4.connected_offense IN (${list(codes)}))`);
      continue;
    }
    if (f.kind === "exists" && !f.negate && f.entity !== "property") {
      const w = f.where.length === 1 && f.where[0].kind === "attribute" && f.where[0].op === "in" && f.where[0].values?.length ? f.where[0] : null;
      const values = (w?.values ?? []).map(String);
      const on = `${f.entity} ${w?.dimension} ${f.scope} ${entity}`;
      if (on === "offense_weapon offense_weapon.weapon offense offense")
        unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("offense_weapon")} w2 WHERE ${sameOffense("w2", "o")} AND ${weaponIn("w2", values)})`);
      else if (on === "offense_weapon offense_weapon.weapon victim victim")
        // P31: a weapon on the incident's offense segment with the code that connects the victim (one of the measure's
        // codes). A victim names its connected offense by code only, so any segment of that code in the incident counts.
        unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("offense_weapon")} w2 WHERE ${sameIncident("w2", "vo")} AND w2.offense_code = vo.connected_offense AND ${weaponIn("w2", values)})`);
      else if (on === "offense offense.offense incident arrestee")
        // Increment 6: an arrest on an incident that has an offense with one of the codes.
        unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("offense")} o2 WHERE ${sameIncident("o2", "a")} AND o2.offense_code IN (${list(values)}))`);
      else if (on === "victim_offender victim_offender.relationship victim victim")
        unitConds.push((read) => `EXISTS (SELECT 1 FROM ${read("victim_offender")} r2 WHERE ${sameVictim("r2", "v")} AND r2.offender_relationship IN (${list(values)}))`);
      else return no(`v0 cannot apply an existence over ${f.entity} at ${f.scope} scope to ${entity} counts`);
      continue;
    }
    if (f.kind !== "exists" || f.entity !== "property" || f.scope !== "incident" || f.attribution !== "incident_level_only" || f.negate)
      return no("v0 compiles filters that are existences over incident property, weapons or relationships only");
    const conds: string[] = [];
    for (const w of f.where) {
      const col = w.kind === "attribute" ? PROPERTY_COLUMNS[w.dimension] : undefined;
      if (!col || w.op !== "in" || !w.values?.length) return no(`v0 cannot apply the property condition on ${w.kind === "attribute" ? w.dimension : "?"}`);
      conds.push(`p.${col} IN (${list(w.values.map(String))})`);
    }
    incidentConds.push(conds.join(" AND "));
    if (!statements.includes("property_not_attributed")) statements.push("property_not_attributed");
  }

  const span = period.kind === "years"
    ? { from: `${yearSet![0]}-01`, to: period.through ?? `${yearSet![yearSet!.length - 1]}-12` }
    : { from: period.from, to: period.to };
  const inYears = (col: string) => (yearSet ? ` AND substr(${col}, 1, 4) IN (${list(yearSet.map(String))})` : "");
  const from = span.from.replace("-", ""), to = span.to.replace("-", "");
  const firstYear = Number(span.from.slice(0, 4));
  const years = isArrest ? t.builtYears : t.builtYears.filter((y) => y >= firstYear);
  if (!years.length) return no(`no built data year at or after ${firstYear}`);
  const read = (table: string) => `read_parquet([${years.map((y) => q(`${t.root}/${table}/data_year=${y}/data.parquet`)).join(", ")}], hive_partitioning = true)`;
  const and = (cs: string[]) => cs.map((c) => `
      AND ${c}`).join("");
  const restFilter = (a: string) => and([...incidentConds.map((c) => `EXISTS (SELECT 1 FROM ${read("property")} p WHERE p.data_year = ${a}.data_year AND p.ori = ${a}.ori AND p.incident_num = ${a}.incident_num AND ${c})`),
    ...unitConds.map((c) => c(read)), ...clearanceConds.map((c) => clearanceCond(read, a, c.dimension, c.values))]);
  const ownFilter = (a: string) => and(ownConds.map((c) => c(a)));
  const incidentFilter = (a: string) => restFilter(a) + ownFilter(a);
  const units = unitsSql(m.id, m.unit, read, groupCols, joins.map((j) => j(read)).join(" "), incidentFilter, { rest: restFilter, own: ownFilter });
  if ("error" in units) return no(units.error);
  if (attrDims.some((g) => g.multiValue)) statements.push("categories_overlap");
  if (units.entity === "arrestee") statements.push("arrests_counted_once");
  const people = peopleFacts(plan);
  if (people.throughIncident) statements.push("arrests_through_incident");
  if (people.allArrests) statements.push("arrests_include_group_b");
  if (people.pair) statements.push("pair_linked");
  if (people.pairCondition) statements.push("pair_condition");
  if (people.offenders) statements.push("offender_records");
  if (people.personFilter) statements.push("unknown_not_counted");
  // P64 for any clearance grouping or selection; P67 where arrests and exceptional clearances are told apart.
  const clr = clearanceDims(plan);
  if (clr.length) statements.push("clearance_as_of_file");
  if (clr.some((d) => d !== "offense.clearance_status")) statements.push("clearance_arrest_first");

  const g = groupCols.map((_, i) => `g${i}`);
  const gSel = g.map((x) => `, ${x}`).join("");
  const key = `(u.data_year, u.ori, u.incident_num, u.sub)`;
  const ikey = `(u.data_year, u.ori, u.incident_num)`;
  const inScope = `${oriIs("u.ori")} AND u.ym BETWEEN ${q(from)} AND ${q(to)}${inYears("u.ym")}`;
  // In grid mode every month and status is per agency (O: the ori column and join key).
  const O = grid ? "ori, " : "";
  const parts = [
    `units AS (${units.sql})`,
    `scoped AS (SELECT * FROM units u WHERE ${inScope})`,
    // Every month of the period, so a month with no rows still gets a status.
    `spine AS (SELECT ${O}ym FROM (SELECT strftime(d, '%Y%m') AS ym FROM range(DATE ${q(`${span.from}-01`)}, DATE ${q(`${span.to}-01`)} + INTERVAL 1 MONTH, INTERVAL 1 MONTH) r(d))${grid ? ` CROSS JOIN (SELECT unnest([${list(grid)}]) AS ori) a` : ""} WHERE TRUE${inYears("ym")})`,
    `status AS (SELECT ${O}CAST(data_year AS VARCHAR) || lpad(CAST(month AS VARCHAR), 2, '0') AS ym, status
      FROM ${read("agency_month_status")} WHERE ${oriIs("ori")})`,
    // The month's own total of the measure: the evidence for the month and every share's denominator.
    `month_total AS (SELECT ${grid ? "u.ori, " : ""}u.ym, COUNT(DISTINCT ${key}) AS n, COUNT(DISTINCT ${ikey}) AS ni FROM scoped u GROUP BY ${grid ? "u.ori, " : ""}u.ym)`,
    `month_cells AS (SELECT ${grid ? "s.ori, " : ""}s.ym, coalesce(t.n, 0) AS den, coalesce(t.ni, 0) AS deni,
      CASE WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' AND coalesce(t.n, 0) > 0 THEN 'EVIDENCE_CONFLICT'
           WHEN coalesce(st.status, 'UNKNOWN') = 'REPORTED_ZERO' THEN 'REPORTED_ZERO'
           WHEN coalesce(st.status, 'UNKNOWN') <> 'REPORTED_CRIMES' THEN 'UNKNOWN'
           ELSE 'VALUE' END AS month_cell
      FROM spine s LEFT JOIN status st USING (${O}ym) LEFT JOIN month_total t USING (${O}ym))`,
  ];
  if (g.length) {
    // Every category that occurs in the place and period, in every month.
    parts.push(`cats AS (SELECT DISTINCT ${g.join(", ")} FROM scoped)`);
    parts.push(`counted AS (SELECT u.ym${g.map((x) => `, u.${x}`).join("")}, COUNT(DISTINCT ${key}) AS n, COUNT(DISTINCT ${ikey}) AS ni FROM scoped u GROUP BY ALL)`);
    parts.push(`cells AS (SELECT mc.ym${g.map((x) => `, c.${x}`).join("")}, mc.den, mc.month_cell, coalesce(k.n, 0) AS n, coalesce(k.ni, 0) AS ni,
      mc.month_cell AS cell
      FROM month_cells mc CROSS JOIN cats c
      LEFT JOIN counted k ON k.ym = mc.ym${g.map((x) => ` AND k.${x} IS NOT DISTINCT FROM c.${x}`).join("")})`);
  } else {
    parts.push(`cells AS (SELECT ${O}ym, den, month_cell, den AS n, deni AS ni, month_cell AS cell FROM month_cells)`);
  }

  const grain = timeDims[0]?.dimension === "time.month" ? "month" : timeDims[0]?.dimension === "time.year" ? "year" : "total";
  const known = (c: string) => `${c} IN ('VALUE', 'REPORTED_ZERO')`;
  const countName = ident(count.as), shareName = share ? ident(share.as) : "";
  let body: string;
  if (grain === "month") {
    const shareCols = share ? `,
      CASE WHEN cell = 'VALUE' AND den > 0 THEN n::DOUBLE / den END AS ${shareName},
      CASE WHEN ${known("cell")} AND den = 0 THEN 'UNAVAILABLE' ELSE cell END AS ${ident(`${share.as}_status`)}` : "";
    body = `SELECT ${O}substr(ym, 1, 4) || '-' || substr(ym, 5, 2) AS period${gSel},
      CASE WHEN ${known("cell")} THEN n END AS ${countName}, cell AS ${ident(`${count.as}_status`)}${inc ? `,
      CASE WHEN ${known("cell")} THEN ni END AS ${ident(inc.as)}, cell AS ${ident(`${inc.as}_status`)}` : ""}${shareCols}
      FROM cells ORDER BY ${O}ym${gSel}`;
  } else {
    // A year or total is a sum of months: known only when every month of it is. A share of a year divides by the year's
    // own units, which (one unit, one category) is the sum of its months' totals.
    const pk = grain === "year" ? `substr(ym, 1, 4) AS period, ` : "";
    const rolled = (c: string) => `CASE WHEN bool_or(${c} = 'EVIDENCE_CONFLICT') THEN 'EVIDENCE_CONFLICT' WHEN bool_and(${known(c)}) THEN CASE WHEN bool_and(${c} = 'REPORTED_ZERO') THEN 'REPORTED_ZERO' ELSE 'VALUE' END ELSE 'UNKNOWN' END`;
    const shareCols = share ? `,
      CASE WHEN bool_and(${known("cell")}) AND sum(den) > 0 THEN sum(n)::DOUBLE / sum(den) END AS ${shareName},
      CASE WHEN bool_or(cell = 'EVIDENCE_CONFLICT') THEN 'EVIDENCE_CONFLICT' WHEN NOT bool_and(${known("cell")}) THEN 'UNKNOWN'
           WHEN sum(den) = 0 THEN 'UNAVAILABLE' ELSE 'VALUE' END AS ${ident(`${share.as}_status`)}` : "";
    body = `SELECT ${pk}${g.join(", ")}${g.length ? ", " : ""}
      CASE WHEN bool_and(${known("cell")}) THEN sum(n) END AS ${countName}, ${rolled("cell")} AS ${ident(`${count.as}_status`)}${inc ? `,
      CASE WHEN bool_and(${known("cell")}) THEN sum(ni) END AS ${ident(inc.as)}, ${rolled("cell")} AS ${ident(`${inc.as}_status`)}` : ""}${shareCols}
      FROM cells${grain === "year" || g.length ? ` GROUP BY ${[...(grain === "year" ? ["1"] : []), ...g].join(", ")} ORDER BY ${[...(grain === "year" ? ["1"] : []), ...g].join(", ")}` : ""}`;
  }
  const columns = [...(grid ? ["ori"] : []), ...(grain === "total" ? [] : ["period"]), ...attrDims.map((x) => x.dimension), count.as, `${count.as}_status`, ...(inc ? [inc.as, `${inc.as}_status`] : []), ...(share ? [share.as, `${share.as}_status`] : [])];
  const sql = `WITH ${parts.join(",\n")}\n${body}`;
  return { kind: "query", query: { sql, columns, scanYears: years, refuseOn: ["EVIDENCE_CONFLICT"], statements } };
}
