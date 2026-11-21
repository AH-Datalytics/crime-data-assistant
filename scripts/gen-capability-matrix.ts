/**
 * The capability matrix, generator (Jeff's structural answer to matching capabilities one by one): every combination of
 *   measure x breakdown x scope (agency, several agencies, state, nation) x time grain
 * becomes ONE generated question, with an id, so the engine's coverage is a number (answered / declined / excluded of all) instead of a list of anecdotes.
 *
 *   npx tsx scripts/gen-capability-matrix.ts                      writes scripts/fixtures/nibrs-capability-matrix.jsonl (+ a summary on stdout)
 *
 * Output, one JSON object per line (the format Engine 2.0's census and scripts/run-capability-matrix.ts both use):
 *   { id, measure, breakdown, family, scope, grain, question, excluded?: reason, timing?: true }
 * `excluded` marks a combination that is not a valid question by definition (it is never asked; it is counted as excluded with the reason). `timing: true` marks the plain
 * measure x (state | nation) x one-year totals: the runner's Texas/US per-measure raw timing table is exactly those rows, read from the same results file.
 *
 * The vocabulary comes from scripts/lib/cube-measure-forms.ts (MEASURE_NOUNS, the same nouns behind the 786 shadow questions); the places are real agencies of
 * fixed ORIs picked by population band from scripts/fixtures/nibrs-shadow/agencies.json (deterministic). Nothing reads data.
 */
import fs from "node:fs";
import { MEASURE_NOUNS } from "./lib/cube-measure-forms";

type Ag = { ori: string; kind: string; name: string; state: string; population: number; sources?: string[] };
const agencies = (JSON.parse(fs.readFileSync("scripts/fixtures/nibrs-shadow/agencies.json", "utf8")) as { agencies: Ag[] }).agencies;
const city = agencies.filter((a) => a.kind === "city" && (a.sources ?? []).includes("nibrs") && a.population > 0).sort((a, b) => a.ori.localeCompare(b.ori));
const band = (lo: number, hi: number, skip = 0) => city.filter((a) => a.population >= lo && a.population < hi)[skip];
const nm = (a: Ag | undefined) => (a ? `${a.name}, ${a.state}` : "Memphis, Tennessee");

/** Scopes: one agency (a mid-size city), several agencies (two cities, asked together), a state, the nation. */
const SCOPES: { scope: "agency" | "several" | "state" | "nation"; place: string }[] = [
  { scope: "agency", place: nm(band(60_000, 120_000)) },
  { scope: "several", place: `${nm(band(60_000, 120_000, 1))} and ${nm(band(60_000, 120_000, 2))}` },
  { scope: "state", place: "Ohio" },
  { scope: "nation", place: "the United States" },
];
/** Time grains and the words that ask for them. */
const GRAINS: { grain: string; at: (p: string) => string }[] = [
  { grain: "year", at: (p) => `in ${p} in 2024` },
  { grain: "month_in_year", at: (p) => `in ${p} in March 2024` },
  { grain: "months_of_year", at: (p) => `by month in ${p} in 2024` },
  { grain: "years", at: (p) => `by year in ${p} from 2020 to 2024` },
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

/** Combinations that are not valid questions by definition: never asked, counted as excluded with the reason. */
function excluded(measure: string, b: B, grain: string): string | null {
  // A grain that is already a time series cannot sit beside a category breakdown in one table the engine builds (the plan allows one time grouping, then attributes).
  // That is NOT excluded: it is asked, and a decline is recorded as the answer (the point of the matrix). Only definitional impossibilities are excluded here.
  if (/^(?:victims|offenders)_/.test(b.breakdown) && ["bad_checks", "runaway", "all_other_offenses", "family_offense_nonviolent", "peeping_tom", "curfew_loitering", "drunkenness", "liquor_law", "disorderly_conduct", "trespass", "drug_equipment", "drug_possession", "drug_crimes", "dui", "weapon_law", "all_crime"].includes(measure))
    return "a crime against society or property with no victim record: victims/offenders are not defined for this measure";
  void grain;
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
    rows.push({ id: `M${String(++n).padStart(5, "0")}`, measure, breakdown: b.breakdown, family: b.family, scope: s.scope, grain: g.grain, question, ...(ex ? { excluded: ex } : {}),
      ...(b.breakdown === "none" && g.grain === "year" && (s.scope === "state" || s.scope === "nation") ? { timing: true } : {}) });
  }
}
fs.writeFileSync("scripts/fixtures/nibrs-capability-matrix.jsonl", rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const ex = rows.filter((r) => (r as { excluded?: string }).excluded).length;
console.log(`matrix: ${rows.length} combinations (${ex} excluded, ${rows.length - ex} to ask) over ${Object.keys(MEASURE_NOUNS).length} measures x ${B_.length} breakdowns x ${SCOPES.length} scopes x ${GRAINS.length} grains; timing rows ${rows.filter((r) => (r as { timing?: boolean }).timing).length}`);
console.log(`places: ${SCOPES.map((s) => `${s.scope}=${s.place}`).join("; ")}`);
