/**
 * The capability matrix, generator (Jeff's structural answer to matching capabilities one by one): every combination of
 *   measure x breakdown x scope (agency, several agencies, state, nation) x time grain
 * becomes ONE generated question, with an id, so the engine's coverage is a number (answered / declined / excluded of all) instead of a list of anecdotes.
 *
 *   npx tsx scripts/gen-capability-matrix.ts                      writes scripts/fixtures/nibrs-capability-matrix.jsonl (+ a summary on stdout)
 *
 * Output, one JSON object per line (the format Engine 2.0's census and scripts/run-capability-matrix.ts both use):
 *   { id, measure, codes (null = every offense code), measure_conditions ([]: every matrix measure is a plain code list), breakdown, family, unit (victim|offender|arrestee|offense|incident, or measure_default = the measure's own unit by the counting contract),
 *     group_by (entity.field or null), filters [{entity, field, op, values}], scope, places [{kind, name, ori?, state?}], grain, period {from, to} (YYYY-MM, inclusive), time_grouping (none|month|year),
 *     cohort (all_reporting), question, excluded?: reason, timing?: true }
 * `excluded` marks a combination that is not a valid question by definition (it is never asked; it is counted as excluded with the reason). `timing: true` marks the plain
 * measure x (state | nation) x one-year totals: the runner's Texas/US per-measure raw timing table is exactly those rows, read from the same results file.
 *
 * The vocabulary comes from scripts/lib/cube-measure-forms.ts (MEASURE_NOUNS, the same nouns behind the 786 shadow questions); the places are real agencies of
 * fixed ORIs picked by population band from scripts/fixtures/nibrs-shadow/agencies.json (deterministic). Nothing reads data.
 */
import fs from "node:fs";
import { GROUP_B, MEASURE_CODES, PERSON_CODES } from "../lib/nibrs-question-types";
import { MEASURE_NOUNS } from "./lib/cube-measure-forms";

type Ag = { ori: string; kind: string; name: string; state: string; population: number; sources?: string[] };
const agencies = (JSON.parse(fs.readFileSync("scripts/fixtures/nibrs-shadow/agencies.json", "utf8")) as { agencies: Ag[] }).agencies;
const city = agencies.filter((a) => a.kind === "city" && (a.sources ?? []).includes("nibrs") && a.population > 0).sort((a, b) => a.ori.localeCompare(b.ori));
const band = (lo: number, hi: number, skip = 0) => city.filter((a) => a.population >= lo && a.population < hi)[skip];
const nm = (a: Ag | undefined) => (a ? `${a.name}, ${a.state}` : "Memphis, Tennessee");

/** Scopes: one agency (a mid-size city), several agencies (two cities, asked together), a state, the nation. `places` is the same scope as data (ORIs for agencies). */
type Place = { kind: "agency" | "state" | "nation"; name: string; ori?: string; state?: string };
const pl = (a: Ag | undefined): Place => (a ? { kind: "agency", name: `${a.name}, ${a.state}`, ori: a.ori, state: a.state } : { kind: "agency", name: "Memphis, Tennessee" });
const SCOPES: { scope: "agency" | "several" | "state" | "nation"; place: string; places: Place[] }[] = [
  { scope: "agency", place: nm(band(60_000, 120_000)), places: [pl(band(60_000, 120_000))] },
  { scope: "several", place: `${nm(band(60_000, 120_000, 1))} and ${nm(band(60_000, 120_000, 2))}`, places: [pl(band(60_000, 120_000, 1)), pl(band(60_000, 120_000, 2))] },
  { scope: "state", place: "Ohio", places: [{ kind: "state", name: "Ohio", state: "OH" }] },
  { scope: "nation", place: "the United States", places: [{ kind: "nation", name: "the United States" }] },
];
/** Time grains and the words that ask for them. */
const GRAINS: { grain: string; at: (p: string) => string; period: { from: string; to: string }; time_grouping: "none" | "month" | "year" }[] = [
  { grain: "year", at: (p) => `in ${p} in 2024`, period: { from: "2024-01", to: "2024-12" }, time_grouping: "none" },
  { grain: "month_in_year", at: (p) => `in ${p} in March 2024`, period: { from: "2024-03", to: "2024-03" }, time_grouping: "none" },
  { grain: "months_of_year", at: (p) => `by month in ${p} in 2024`, period: { from: "2024-01", to: "2024-12" }, time_grouping: "month" },
  { grain: "years", at: (p) => `by year in ${p} from 2020 to 2024`, period: { from: "2020-01", to: "2024-12" }, time_grouping: "year" },
];
/** Breakdowns: the family they belong to, and how the question is phrased around the measure noun (n). A breakdown "none" is the plain count. */
type B = { breakdown: string; family: "total" | "victims" | "offenders" | "arrests" | "offenses" | "incidents"; phrase: (n: string) => string };
const B_: B[] = [
  { breakdown: "none", family: "total", phrase: (n) => n },
  ...["sex", "race", "ethnicity", "age group"].flatMap((a): B[] => [
    { breakdown: `victims_${a}`, family: "victims", phrase: (n) => `${n} victims by ${a}` },
    { breakdown: `offenders_${a}`, family: "offenders", phrase: (n) => `${n} offenders by ${a}` },
    { breakdown: `arrests_${a}`, family: "arrests", phrase: (n) => `${n} arrests by ${a}` },
  ]),
  { breakdown: "arrests_juvenile", family: "arrests", phrase: (n) => `juvenile ${n} arrests` },
  { breakdown: "offenses_time_of_day", family: "offenses", phrase: (n) => `${n} by time of day` },
  { breakdown: "offenses_location", family: "offenses", phrase: (n) => `${n} by location` },
  { breakdown: "offenses_weapon", family: "offenses", phrase: (n) => `${n} by weapon` },
  { breakdown: "offenses_firearm", family: "offenses", phrase: (n) => `${n} with a firearm` },
  { breakdown: "incidents_time_of_day", family: "incidents", phrase: (n) => `${n} incidents by time of day` },
  { breakdown: "incidents_clearance", family: "incidents", phrase: (n) => `${n} incidents by clearance type` },
];

/** Each breakdown as data: the counted unit, the attribute grouped by (entity.field) and any filter the question words add. */
const BREAKDOWN_DATA = (b: B): { unit: string; group_by: string | null; filters: { entity: string; field: string; op: string; values: string[] }[] } => {
  const m = /^(victims|offenders|arrests)_(sex|race|ethnicity|age group)$/.exec(b.breakdown);
  if (m) return { unit: m[1] === "arrests" ? "arrestee" : m[1].slice(0, -1), group_by: `${m[1] === "arrests" ? "arrestee" : m[1].slice(0, -1)}.${m[2].replace(" ", "_")}`, filters: [] };
  switch (b.breakdown) {
    case "none": return { unit: "measure_default", group_by: null, filters: [] };
    case "arrests_juvenile": return { unit: "arrestee", group_by: null, filters: [{ entity: "arrestee", field: "age", op: "between", values: ["0", "17"] }] };
    case "offenses_time_of_day": return { unit: "offense", group_by: "incident.hour_bin", filters: [] };
    case "offenses_location": return { unit: "offense", group_by: "offense.location_type", filters: [] };
    case "offenses_weapon": return { unit: "offense", group_by: "offense_weapon.weapon", filters: [] };
    case "offenses_firearm": return { unit: "offense", group_by: null, filters: [{ entity: "offense_weapon", field: "weapon", op: "in", values: ["11", "12", "13", "14", "15"] }] };
    case "incidents_time_of_day": return { unit: "incident", group_by: "incident.hour_bin", filters: [] };
    case "incidents_clearance": return { unit: "incident", group_by: "offense.clearance_type", filters: [] };
  }
  return { unit: "measure_default", group_by: null, filters: [] };
};
const EXTRA_CODES: Record<string, string[]> = { drug_equipment: ["35B"], drug_crimes: ["35A", "35B"] };

/**
 * Combinations that are not valid questions by definition: never asked, counted as excluded with the reason (class A "invalid combination" or B "not in the data" of Engine 2.0's decline classes).
 * Reason strings are Engine 2.0's (2026-11-21). Not in the matrix, so no rule here: (a) arrests by victim/offender attributes (no such breakdown is generated), (c) clearance by victim/offender/arrest (only
 * incidents by clearance is generated), (d) rates by group (no rates), (e) police staffing (not a NIBRS measure), (g) grains before 2017 (the grains start in 2020).
 */
const EXTRA_MEASURE_CODES: Record<string, string[]> = { drug_equipment: ["35B"], drug_crimes: ["35A", "35B"] };
const codesOf = (m: string): string[] => MEASURE_CODES[m] ?? EXTRA_MEASURE_CODES[m] ?? [];
const isGroupB = (m: string) => codesOf(m).length > 0 && codesOf(m).every((c) => GROUP_B.has(c));
const isPersonOnly = (m: string) => codesOf(m).length > 0 && codesOf(m).every((c) => PERSON_CODES.has(c));
// Group A crimes with no victim record (against society, or no victim segment): victims and offenders are not defined (kept from the first version of the matrix).
const NO_VICTIM = new Set(["bad_checks", "runaway", "all_other_offenses", "family_offense_nonviolent", "peeping_tom", "curfew_loitering", "drunkenness", "liquor_law", "disorderly_conduct", "trespass", "drug_equipment", "drug_possession", "drug_crimes", "dui", "weapon_law", "all_crime"]);
function excluded(measure: string, b: B, grain: string): string | null {
  // A grain that is already a time series beside a category breakdown is NOT excluded: it is asked, and a decline is recorded as the answer (the point of the matrix).
  void grain;
  // (b) Group B arrests are standalone arrest records: no incident, so only arrests (and the plain count) exist.
  if (isGroupB(measure) && ["victims", "offenders", "offenses", "incidents"].includes(b.family))
    return "Group B arrests have no incident: no weapon, location, clearance, offender or victim attribute, no property";
  if (/^(?:victims|offenders)_/.test(b.breakdown) && NO_VICTIM.has(measure)) return "a crime against society or property with no victim record: victims/offenders are not defined for this measure";
  // (f) victims of crimes against property are counted by age only (P11, Jeff 2026-11-15; P120 for a victim age).
  if (/^victims_(?:sex|race|ethnicity)$/.test(b.breakdown) && !isPersonOnly(measure) && !NO_VICTIM.has(measure))
    return "victims of crimes against property are counted by age only (P11, Jeff 2026-11-15)";
  return null;
}

const rows: object[] = [];
let n = 0;
for (const measure of Object.keys(MEASURE_NOUNS).sort()) {
  const noun = MEASURE_NOUNS[measure][0];
  for (const b of B_) for (const s of SCOPES) for (const g of GRAINS) {
    const ex = excluded(measure, b, g.grain);
    // "several" is asked as one combined question; the phrase carries both names.
    const question = `${b.phrase(noun)} ${g.at(s.place)}`;
    const bd = BREAKDOWN_DATA(b);
    rows.push({ id: `M${String(++n).padStart(5, "0")}`, measure, codes: MEASURE_CODES[measure] ?? EXTRA_CODES[measure] ?? null, measure_conditions: [], breakdown: b.breakdown, family: b.family, unit: bd.unit, group_by: bd.group_by, filters: bd.filters,
      scope: s.scope, places: s.places, grain: g.grain, period: g.period, time_grouping: g.time_grouping, cohort: "all_reporting", question, ...(ex ? { excluded: ex } : {}),
      ...(b.breakdown === "none" && g.grain === "year" && (s.scope === "state" || s.scope === "nation") ? { timing: true } : {}) });
  }
}
fs.writeFileSync("scripts/fixtures/nibrs-capability-matrix.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ex = rows.filter((r) => (r as { excluded?: string }).excluded).length;
console.log(`matrix: ${rows.length} combinations (${ex} excluded, ${rows.length - ex} to ask) over ${Object.keys(MEASURE_NOUNS).length} measures x ${B_.length} breakdowns x ${SCOPES.length} scopes x ${GRAINS.length} grains; timing rows ${rows.filter((r) => (r as { timing?: boolean }).timing).length}`);
console.log(`places: ${SCOPES.map((s) => `${s.scope}=${s.place}`).join("; ")}`);
