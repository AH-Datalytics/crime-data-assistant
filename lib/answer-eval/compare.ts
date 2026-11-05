/**
 * Turning a candidate's plan into the labeled set's terms, and comparing it with a label (answer evaluation part 4).
 *
 * Every field gets one of three verdicts:
 *   match       the same meaning (after an explicit, listed equivalence only);
 *   material    a different meaning: a different answer;
 *   unverified  the comparison cannot decide: a label word or plan form the maps below do not know, or a detail
 *               the label cannot express (a share's numerator and denominator roles, transform parameters).
 * An unverified field never earns correctness credit and never proves a wrong answer (Codex runner review r1).
 */
import { CIRCUMSTANCE } from "../nibrs-plan/draft-layer";
import { MEASURE_CODES } from "../nibrs-question-types";
import { AGE_BINS } from "../nibrs-plan/from-spec";
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ResolvedPeriod } from "../nibrs-plan/resolve";
import type { Meaning } from "./case";
import fs from "node:fs";
import path from "node:path";

/** The agencies' FBI names (scripts/fixtures/nibrs-shadow/agency-names.json), read once. */
let NAMES: Map<string, string> | null = null;
const fbiNames = () => (NAMES ??= new Map(Object.entries(JSON.parse(fs.readFileSync(path.join(process.cwd(), "scripts/fixtures/nibrs-shadow/agency-names.json"), "utf8")).names as Record<string, string>)));

export type Diff = { field: string; expected: string; actual: string; kind: "material" | "unverified" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const singular = (s: string) => s.replace(/(?<=[a-z]{3})s\b/g, "");

/* ------------------------------------------------------------------ measures and units ----------------------------- */

/** Label words and plan ids (draft layer, without the unit prefix) that name the same measure. Anything else is unknown. */
const MEASURES: Record<string, string> = {
  murder: "murder", homicide: "murder", "murder and non negligent manslaughter": "murder", "murder and nonnegligent manslaughter": "murder",
  rape: "rape", robbery: "robbery", "aggravated assault": "aggravated assault", "simple assault": "simple assault", assault: "assault",
  burglary: "burglary", theft: "theft", "larceny theft": "theft", larceny: "theft", "motor vehicle theft": "motor vehicle theft", "auto theft": "motor vehicle theft", "car theft": "motor vehicle theft",
  "theft from motor vehicle": "theft from motor vehicle", "vehicle burglary": "theft from motor vehicle", shoplifting: "shoplifting", arson: "arson",
  carjacking: "carjacking", "carjacking robbery in which a motor vehicle was taken": "carjacking", "violent crime": "violent crime", "violent crime ucr": "violent crime", "property crime": "property crime", "property crime ucr": "property crime",
  "sex offense": "sex offense", "drug possession": "drug narcotic violation", "drug narcotic violation": "drug narcotic violation", "drug equipment violation": "drug equipment violation", "drug equipment": "drug equipment violation",
  dui: "driving under the influence", "driving under the influence": "driving under the influence", "domestic violence": "domestic violence", "hate crime": "hate crime",
  "all offense": "all offenses", "all offenses": "all offenses", "all crime offenses": "all offenses", "all crime": "all offenses",
  // Increment 5: a label's cleared offenses (the national clearance rate, P57).
  "murder cleared": "murder cleared",
};
export function measureName(s: string): string | null {
  const n = singular(norm(s.replace(/^[a-z_]+\./, "").replace(/_cleared$/, "").replace(/_/g, " ")));
  return MEASURES[n] ?? MEASURES[norm(s)] ?? null;
}
const UNITS: Record<string, string> = {
  victim: "victim", offense: "offense", incident: "incident", offender: "offender", arrest: "arrest", arrestee: "arrest", "group b arrest": "arrest", group_b_arrest: "arrest",
  "fbi composite": "fbi standard", "fbi standard": "fbi standard", fbi_standard: "fbi standard", "victim robbery by offense": "fbi standard", dollar: "dollars", dollars: "dollars",
  "property segment": "property segment", property_segment: "property segment", officer: "officer", employee: "employee",
};
export const unitName = (s: string): string | null => UNITS[s] ?? UNITS[singular(norm(s.replace(/_/g, " ")))] ?? null;

/* ------------------------------------------------------------------ filters ---------------------------------------- */

/** A filter as family and value class ("weapon:firearm"); null when either is unknown. */
const FIREARM = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
/** Only an inclusive condition ("in" / "between") on exactly the listed values maps; anything else is unknown. */
function planFilterKey(dimension: string, values: (string | number)[], op: string): string | null {
  const v = values.map(String);
  if (op !== "in" && op !== "between") return null;
  if (op === "between" && !/[._]age$/.test(dimension)) return null;
  if (dimension.endsWith("weapon")) return [...v].sort().join("+") === [...FIREARM].sort().join("+") ? "weapon:firearm" : v.join("+") === "20" ? "weapon:knife" : null;
  if (dimension === "offense.clearance_method") return v.join("+") === "exceptional" ? "clearance:exceptional" : v.join("+") === "arrest" ? "clearance:arrest" : null;
  if (dimension === "offense.clearance_type") return v.join("+") === "B" ? "clearance:prosecution declined" : null;
  // Increment 6: an offense of the incident (arrests reached through it), by the crime with exactly those codes.
  if (dimension === "offense.offense") { const name = Object.keys(MEASURE_CODES).find((k) => [...MEASURE_CODES[k]].sort().join("+") === [...v].sort().join("+")); return name ? `incident offense:${name.replace(/_/g, " ")}` : null; }
  // Increment 6: a clearance status selection (P66).
  if (dimension === "offense.clearance_status") return v.join("+") === "cleared" ? "clearance:cleared" : v.join("+") === "none" ? "clearance:uncleared" : null;
  if (dimension === "victim_offender.relationship") return v.join("+") === "ST" ? "relationship:stranger" : null;
  // Element 31: the circumstance codes selected.
  if (dimension === "victim_circumstance.circumstance") return `circumstance:${[...v].sort().join("+")}`;
  if (dimension === "property.loss_type") return v.join("+") === "7" ? "loss:stolen" : v.join("+") === "6" ? "loss:seized" : null;
  // Increment 7: a linked offender (P65) is told apart from any offender of the incident (P49).
  // An age range is "under 18" (1-17, P30) or "<from>-<to>" ("young adults" chosen as 18 to 24).
  const range = op === "between" && v.length === 2 ? (v.join("+") === "1+17" ? "under 18" : `${v[0]}-${v[1]}`) : null;
  if (dimension === "victim_offender.offender_age" && range) return `linked offender age:${range}`;
  if (/\.age$/.test(dimension) && range) return `${dimension.split(".")[0]} age:${range}`;
  if (/\.sex$/.test(dimension)) return v.join("+") === "F" ? `${dimension.split(".")[0]} sex:female` : v.join("+") === "M" ? `${dimension.split(".")[0]} sex:male` : null;
  return null;
}
/** Increment 6: a property selection on one segment (N2) as "property:firearm stolen"; null for any other. */
const PROPERTY_WHAT: Record<string, string> = { "13": "firearm", "03+05+24+28+37": "vehicle", "03": "car" };
const PROPERTY_LOSS: Record<string, string> = { "7": "stolen", "5": "recovered", "6": "seized", "4": "damaged", "2": "burned" };
function propertyKey(where: { kind: string; dimension?: string; values?: (string | number)[]; op?: string }[]): string | null {
  const at = (d: string) => where.find((w) => w.kind === "attribute" && w.dimension === d && w.op === "in");
  const what = PROPERTY_WHAT[[...(at("property.description")?.values ?? []).map(String)].sort().join("+")];
  const loss = PROPERTY_LOSS[(at("property.loss_type")?.values ?? []).map(String).join("+")];
  return where.length === 2 && what && loss ? `property:${what} ${loss}` : null;
}
function labelFilterKey(f: string): string | null {
  const [fam, ...rest] = f.split(":");
  const family = norm(fam), value = norm(rest.join(":"));
  // Increment 6: clearance selections in words, and property on one segment.
  if (!rest.length) {
    if (/^(not cleared|uncleared)$/.test(family)) return "clearance:uncleared";
    if (/^cleared by arrest$/.test(family)) return "clearance:arrest";
    if (/^cleared by exceptional means$/.test(family)) return "clearance:exceptional";
    if (/^cleared\b/.test(family)) return "clearance:cleared";
  }
  if (family === "incident offense") return value ? `incident offense:${value}` : null;
  if (family === "property") { const m = /^(firearm|vehicle|car) (stolen|recovered|seized|damaged|burned)$/.exec(value); return m ? `property:${m[1]} ${m[2]}` : null; }
  if (family === "weapon") return /firearm|gun/.test(value) ? "weapon:firearm" : /knife/.test(value) ? "weapon:knife" : null;
  if (family === "clearance") return /prosecution declined/.test(value) ? "clearance:prosecution declined" : /exceptional/.test(value) ? "clearance:exceptional" : /arrest/.test(value) ? "clearance:arrest" : null;
  if (family === "relationship") return /stranger/.test(value) ? "relationship:stranger" : null;
  // Element 31: a label names the circumstances by the FBI's names ("gangland (organized crime involvement) or juvenile
  // gang"), each one of its codes.
  if (family === "circumstance") {
    const codes = value.split(/\s+or\s+/).map((w) => Object.keys(CIRCUMSTANCE).find((c) => norm(CIRCUMSTANCE[c]) === w.trim()));
    return codes.length && codes.every(Boolean) ? `circumstance:${(codes as string[]).sort().join("+")}` : null;
  }
  // Increment 3: a comparison of the same months of each year; rolling windows counted only when complete.
  if (family === "the same months of each year") return "same-months";
  if (/requires all twelve source months/.test(norm(f))) return "rolling:complete windows";
  // Increment 4: a ranking's agencies.
  if (norm(f) === "city agencies") return "agency:city";
  if (/^250,000 residents or more$/.test(f.trim())) return "population:250000+";
  if (/^agencies that reported every month of /.test(norm(f))) return "reporters:every month";
  if (family === "loss") return /stolen/.test(value) ? "loss:stolen" : /seized/.test(value) ? "loss:seized" : null;
  if (/^(victim|offender|arrestee) age$/.test(family)) {
    const who = family === "offender age" && /pair linked/.test(value) ? "linked offender age" : family;
    const r = /under 18/.test(value) ? "under 18" : /^(\d+) to (\d+)\b/.exec(value)?.slice(1, 3).join("-");
    return r ? `${who}:${r}` : null;
  }
  if (/^(victim|offender|arrestee) sex$/.test(family)) return /female/.test(value) ? `${family.split(" ")[0]} sex:female` : /\bmale/.test(value) ? `${family.split(" ")[0]} sex:male` : null;
  return null;
}

/* ------------------------------------------------------------------ groupings -------------------------------------- */

const GROUPINGS: Record<string, string> = {
  "time.year": "year", year: "year", "time.month": "month", month: "month", "time.quarter": "quarter", quarter: "quarter", "geo.agency": "agency", agency: "agency", city: "agency", "geo.state": "state", state: "state",
  "victim.race": "victim race", "victim race": "victim race", "victim.sex": "victim sex", "victim sex": "victim sex", "victim.ethnicity": "victim ethnicity", "victim ethnicity": "victim ethnicity", "victim.age": "victim age", "victim age": "victim age",
  "offender.race": "offender race", "offender race": "offender race", "offender.sex": "offender sex", "offender sex": "offender sex", "offender.age": "offender age", "offender age": "offender age",
  // Increment 7: offender ethnicity, the arrestee's own attributes, and the linked offenders' (P65).
  "offender.ethnicity": "offender ethnicity", "offender ethnicity": "offender ethnicity",
  "arrestee.race": "arrestee race", "arrestee race": "arrestee race", "arrestee.sex": "arrestee sex", "arrestee sex": "arrestee sex",
  "arrestee.ethnicity": "arrestee ethnicity", "arrestee ethnicity": "arrestee ethnicity", "arrestee.age": "arrestee age", "arrestee age": "arrestee age",
  "victim_offender.offender_race": "linked offender race", "victim_offender.offender_sex": "linked offender sex",
  "victim_offender.offender_ethnicity": "linked offender ethnicity", "victim_offender.offender_age": "linked offender age",
  "offense.location_type": "location type", "location type": "location type", "offense.clearance_type": "clearance type", "clearance type": "clearance type",
  "offense.clearance_status": "clearance status", "clearance status": "clearance status",
  "offense_weapon.weapon": "weapon", weapon: "weapon", "victim_offender.relationship": "relationship", relationship: "relationship", "offense.offense": "offense type", "offense type": "offense type",
  "victim_circumstance.circumstance": "circumstance", circumstance: "circumstance",
  // Increment 3: a monthly series of rolling 12-month windows.
  "rolling 12-month": "rolling 12-month", "month (rolling 12-month total ending that month)": "rolling 12-month",
};
/**
 * A label's grouping may explain itself in parentheses ("offender race (crimes grouped by ...)"); "pair-linked" there
 * names P65's linked offenders.
 */
const groupingName = (s: string): string | null => {
  if (GROUPINGS[s]) return GROUPINGS[s];
  const base = s.replace(/\s*\(.*\)\s*$/, ""), g = GROUPINGS[base] ?? GROUPINGS[norm(base)] ?? null;
  return g && /pair-linked/i.test(s) && g.startsWith("offender ") ? `linked ${g}` : g;
};

/* ------------------------------------------------------------------ periods and places ----------------------------- */

export type Release = { firstMonth: string; lastMonth: string; asOf: string };
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const latestCompleteYear = (r: Release) => (r.lastMonth.endsWith("-12") ? Number(r.lastMonth.slice(0, 4)) : Number(r.lastMonth.slice(0, 4)) - 1);

/** A label's period as months against a release; null when the rule wording is not known (unverified). */
export function labelPeriod(p: Meaning["period"], r: Release): { from: string; to: string; years?: number[] } | null {
  if ("from" in p) return p;
  const rule = p.rule.toLowerCase();
  const lcy = latestCompleteYear(r);
  let m: RegExpMatchArray | null;
  if (/^latest complete year$/.test(rule)) return { from: ym(lcy, 1), to: ym(lcy, 12) };
  if ((m = rule.match(/^last (\d+) complete years$/))) return { from: ym(lcy - Number(m[1]) + 1, 1), to: ym(lcy, 12) };
  if (/^calendar year before today$/.test(rule)) { const y = Number(r.asOf.slice(0, 4)) - 1; return { from: ym(y, 1), to: ym(y, 12) }; }
  if ((m = rule.match(/^year to date(?: (\d{4}))? through the latest month$/))) { const y = Number(m[1] ?? r.lastMonth.slice(0, 4)); return { from: ym(y, 1), to: r.lastMonth }; }
  if ((m = rule.match(/^(\d{4}) through the latest complete year$/))) return { from: ym(Number(m[1]), 1), to: ym(lcy, 12) };
  if ((m = rule.match(/^(\d{4})(?:-(\d{2}))? through the latest (?:month|year) in the data$/))) return { from: ym(Number(m[1]), Number(m[2] ?? 1)), to: r.lastMonth };
  // Increment 3: a set of years ("the years 2019 and 2024"), and the 12 months ending at the latest month (P56).
  if ((m = rule.match(/^the years? (\d{4}(?:(?:, | and |, and )\d{4})*)$/))) {
    const years = [...m[1].matchAll(/\d{4}/g)].map((x) => Number(x[0])).sort((a, b) => a - b);
    const last = years[years.length - 1];
    return { from: ym(years[0], 1), to: ym(last, 12) > r.lastMonth ? r.lastMonth : ym(last, 12), years };
  }
  if (/^the 12 months ending at the latest month in the data$/.test(rule)) {
    const k = Number(r.lastMonth.slice(0, 4)) * 12 + Number(r.lastMonth.slice(5, 7)) - 1 - 11;
    return { from: ym(Math.floor(k / 12), (k % 12) + 1), to: r.lastMonth };
  }
  // The whole release: what "every year available" holds for the release the candidate runs on.
  if (/^every year (?:in the data|available)$/.test(rule)) return { from: r.firstMonth, to: r.lastMonth };
  return null;
}

const STATE_NAMES: Record<string, string> = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming" };
const STATE_CODES = Object.fromEntries(Object.entries(STATE_NAMES).map(([c, n]) => [n, c]));

/** A place as a comparable key: the nation; a state by code; a local agency by state and its full name without the agency-type words. */
function placeKey(p: { kind: string; name: string; state?: string }): string {
  if (p.kind === "national") return "national";
  if (p.kind === "state") return `state:${p.state ?? STATE_CODES[norm(p.name)] ?? norm(p.name)}`;
  const name = norm(p.name).replace(/\b(police|department|dept|pd|sheriff s|sheriffs|sheriff|office|metropolitan|metro|city of|city|division|agency|bureau)\b/g, " ").replace(/\s+/g, " ").trim();
  return `local:${p.state ?? ""}:${name}`;
}

/**
 * The FBI's name for an ORI when a label's agency name is that same agency in other words ("Portland Police Bureau"
 * is the FBI's "Portland Police Department"): the names agree once the words for police and agency are set aside, and
 * both are the same kind of agency, a sheriff never a police department (Codex 02.7).
 */
const agencyKind = (name: string) => (/\bsheriff/i.test(name) ? "sheriff" : /\b(marshal|constable)/i.test(name) ? "other" : "police");
export function fbiNameFor(labelName: string, ori: string): string | null {
  const fbi = fbiNames().get(ori);
  return fbi && agencyKind(fbi) === agencyKind(labelName) && placeKey({ kind: "agency", name: fbi }) === placeKey({ kind: "agency", name: labelName }) ? fbi : null;
}

/* ------------------------------------------------------------------ plan -> meaning --------------------------------- */

/** What a plan says, in the comparator's terms (not all of it fits the label schema; extra parts travel alongside). */
export type PlanView = {
  meaning: Meaning;
  /** Measure and unit pairs, roles kept: the subset of a share is not the same as its population. */
  measures: { name: string; unit: string; role: "value" | "numerator" | "denominator" }[];
  filterKeys: (string | null)[];
  statistics: string[];
  years: number[] | null;          // a year selection, else null
  yearsThrough: string | null;     // the month its last year is clipped to (a year still in progress), else null
  rank: { direction: string; limit: number | null; by: string | null } | null;
  /** A rate's population (increment 4): one agency's, each agency's own, or the agencies' summed; null otherwise. */
  denominator: "agency" | "each agency" | "summed agencies" | "reporting agencies" | null;
  /** A period comparison's two periods (increment 3), checked against the periods the label implies. */
  comparison: { earlier: { from: string; to: string }; later: { from: string; to: string } } | null;
  untracked: string[];             // plan features the label schema cannot express (transform parameters, bins)
  /**
   * Increment 6: a share of a measure in its own units (the share cleared): the ratio's numerator is the denominator's
   * measure with filters of its own, the denominator has none. Its roles are then read from the plan.
   */
  subsetShare?: boolean;
};

export function planToMeaning(plan: NibrsPlan, period: ResolvedPeriod): PlanView {
  const places = plan.geography.places.map((p) => {
    const at = p.kind === "agency_set" ? p.within : p;
    if (at.kind === "national") return { kind: "national" as const, name: "United States" };
    if (at.kind === "state") return { kind: "state" as const, name: STATE_NAMES[at.code] ?? at.code, state: at.code };
    // An agency by its FBI name (the name a label gives), its state from the place label ("Denver, Colorado").
    if (at.kind === "agency") {
      const tail = at.label.replace(/^.*,\s*/, "");
      const st = /, D\.C\.$/.test(at.label) ? "DC" : /^[A-Z]{2}$/.test(tail) ? tail : STATE_CODES[norm(tail)];
      return { kind: "agency" as const, name: fbiNames().get(at.ori) ?? at.label.replace(/,[^,]*$/, ""), ...(st ? { state: st } : {}) };
    }
    return { kind: "county" as const, name: at.label };
  });
  const months = period.kind === "absolute" ? { from: period.from, to: period.to } : { from: ym(Math.min(...period.years), 1), to: period.through ?? ym(Math.max(...period.years), 12) };
  const years = period.kind === "years" ? [...period.years].sort() : null;
  const byAs = new Map(plan.measures.map((m) => [m.as, m]));
  const roles = new Map<string, "numerator" | "denominator">();
  for (const s of plan.statistics) if (s.kind === "ratio") { roles.set(s.numerator, "numerator"); roles.set(s.denominator, "denominator"); }
  // The incidents beside a count (P66) are supporting numbers, not the question's statistic.
  const statistics = plan.statistics.filter((s) => s.kind !== "incidents").map((s) => s.kind);
  const ratioStat = plan.statistics.find((s) => s.kind === "ratio");
  const num = ratioStat && ratioStat.kind === "ratio" ? byAs.get(ratioStat.numerator) : undefined, den = ratioStat && ratioStat.kind === "ratio" ? byAs.get(ratioStat.denominator) : undefined;
  const subsetShare = !!num && !!den && num.id === den.id && num.unit === den.unit && !!num.filters?.length && !den.filters?.length;
  const transforms = plan.transforms.map((t) => t.kind);
  const headline = transforms.includes("rank") ? "rank" : transforms.includes("period_comparison") ? "change" : statistics[statistics.length - 1];
  const filterKeys: (string | null)[] = [];
  const keysOf = (fs: NibrsPlan["filters"]) => fs.flatMap((f): (string | null)[] =>
    f.kind === "attribute" ? [planFilterKey(f.dimension, f.values ?? [], f.op)]
    : f.negate ? [null] // a negated existence has no label equivalent here
    : f.entity === "property" ? [propertyKey(f.where)]
    : f.where.map((w) => (w.kind === "attribute" ? planFilterKey(w.dimension, w.values ?? [], w.op) : null)));
  filterKeys.push(...keysOf(plan.filters));
  // A filter every measure carries (a composite's weapon, P31) is one filter of the question, as a label lists it; a
  // filter on only some measures stays per measure.
  const perMeasure = plan.measures.map((m) => keysOf(m.filters ?? []));
  const same = perMeasure.length > 1 && perMeasure.every((k) => JSON.stringify(k) === JSON.stringify(perMeasure[0])) && !perMeasure[0].includes(null);
  filterKeys.push(...(same ? perMeasure[0] : perMeasure.flat()));
  for (const m of plan.measures) if (m.id.endsWith("_cleared")) filterKeys.push("clearance:cleared");
  for (const p of plan.geography.places) if (p.kind === "agency_set") for (const w of p.where)
    filterKeys.push(w.field === "agency.population" && w.op === ">=" ? `population:${w.value}+`
      : w.field === "agency.type" && JSON.stringify(w.value) === '["city"]' ? "agency:city" : null);
  const rankT = plan.transforms.find((t) => t.kind === "rank");
  // Increment 4: a ranking ranks only agencies that reported every month of its period (P60), the engine's rule for
  // every ranking.
  // Increment 5: a state or national sum over the every-month set (P61's button) is the same filter.
  if (rankT || (plan.coverage.cohort === "same_agencies" && plan.geography.places.some((p) => p.kind === "state" || p.kind === "national"))) filterKeys.push("reporters:every month");
  // Increment 3: a comparison of the same months of each year (not whole years) and rolling 12-month windows are label
  // terms: a filter key and a grouping. Comparisons of whole years read as a change by year.
  const cmpT = plan.transforms.find((t) => t.kind === "period_comparison");
  const rollT = plan.transforms.find((t) => t.kind === "rolling");
  // "The same months of each year": both periods the same months of the year, and not whole years.
  const moy = (p: { from: string; to: string }) => `${p.from.slice(5)}..${p.to.slice(5)}`;
  if (cmpT && cmpT.kind === "period_comparison" && moy(cmpT.earlier) === moy(cmpT.later) && moy(cmpT.earlier) !== "01..12"
    && cmpT.earlier.from.slice(0, 4) === cmpT.earlier.to.slice(0, 4) && cmpT.later.from.slice(0, 4) === cmpT.later.to.slice(0, 4)) filterKeys.push("same-months");
  if (rollT) filterKeys.push("rolling:complete windows");
  const groupings = [...plan.groupings.map((g) => (rollT && rollT.kind === "rolling" && g.dimension === "time.month" ? `rolling ${rollT.months}-month` : g.dimension)),
    ...(cmpT && !plan.groupings.some((g) => g.dimension === "time.year") ? ["time.year"] : [])];
  // Plan details the label schema cannot express: compared as unverified, never as matches.
  const untracked = [
    ...plan.transforms.filter((t) => t.kind === "rolling" && t.months !== 12).map((t) => `rolling ${"months" in t ? t.months : ""} months`),
    // A category breakdown's share of its own period (within exactly the time groupings) is the standard breakdown
    // share, checked against independent counts; any other share's roles stay unverified.
    ...plan.statistics.filter((s) => s.kind === "share" && !(s.within.join("+") === plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension).join("+")
      && plan.groupings.some((g) => !g.dimension.startsWith("time.")) && !s.denominator)).map((s) => `share within ${"within" in s ? s.within.join("+") || "all" : "?"}`),
    // Today's age groups (P30) are what the labels name; any other bins are not in the label schema.
    ...plan.groupings.filter((g) => g.bins && JSON.stringify(g.bins) !== JSON.stringify(AGE_BINS)).map((g) => `${g.dimension} bins`),
  ];
  return {
    meaning: {
      source: plan.source, places, combine: plan.geography.combine, period: months,
      measures: plan.measures.map((m) => ({ name: m.id, unit: m.unit })), filters: [], groupings: groupings.filter((g) => g !== "geo.place"),
      statistic: headline as Meaning["statistic"], cohort: plan.coverage.cohort,
    },
    measures: plan.measures.map((m) => ({ name: m.id, unit: m.unit, role: roles.get(m.as) ?? "value" })),
    filterKeys, statistics: [...new Set([headline, ...statistics])], subsetShare, years, yearsThrough: period.kind === "years" ? period.through ?? null : null,
    rank: rankT && rankT.kind === "rank" ? { direction: rankT.direction, limit: rankT.limit, by: plan.statistics.find((x) => x.as === rankT.by)?.kind ?? null } : null,
    denominator: denominatorOf(plan),
    comparison: cmpT && cmpT.kind === "period_comparison" ? { earlier: { from: cmpT.earlier.from, to: cmpT.earlier.to }, later: { from: cmpT.later.from, to: cmpT.later.to } } : null,
    untracked,
  };
}

/** A per-100,000 rate's population, in the label's terms. */
function denominatorOf(plan: NibrsPlan): PlanView["denominator"] {
  const r = plan.statistics.find((x) => x.kind === "rate");
  if (!r || r.kind !== "rate" || r.per !== 100000) return null;
  const ps = plan.geography.places;
  if (ps.length === 1 && ps[0].kind === "agency") return "agency";
  // Increment 5 (P62): a state or national sum's rate is over the reporting agencies' summed populations.
  if (ps.length === 1 && (ps[0].kind === "state" || ps[0].kind === "national")) return "reporting agencies";
  if (ps.every((p) => p.kind === "agency") && plan.geography.combine === "combined") return "summed agencies";
  return "each agency";
}
function labelDenominator(d: string): PlanView["denominator"] {
  if (/^residents of the reporting agencies \(the sum of their FBI agency populations\), per 100,000$/.test(d)) return "reporting agencies";
  if (/^residents of .+'s jurisdiction \(the FBI's agency population\), per 100,000$/.test(d)) return "agency";
  if (/^each agency's residents \(the FBI's agency population\), per 100,000$/.test(d)) return "each agency";
  if (/^the two agencies' residents together \(the FBI's agency populations\), per 100,000$/.test(d)) return "summed agencies";
  return null;
}

/* ------------------------------------------------------------------ comparison ------------------------------------- */

const join = (xs: (string | null)[]) => xs.map((x) => x ?? "?").sort().join(" + ");

/** Field-by-field comparison of a plan with an expected meaning (a label). */
export function compareMeaning(expected: Meaning, actual: PlanView, r: Release): Diff[] {
  const out: Diff[] = [];
  const add = (field: string, e: string, a: string, kind: Diff["kind"]) => out.push({ field, expected: e, actual: a, kind });
  // Any unknown component leaves the field unverified, even when the placeholders look alike.
  const decide = (field: string, e: (string | null)[], a: (string | null)[]) => {
    if (e.includes(null) || a.includes(null)) { add(field, join(e), join(a), "unverified"); return; }
    if (join(e) !== join(a)) add(field, join(e), join(a), "material");
  };
  if (expected.source !== actual.meaning.source) add("source", expected.source, actual.meaning.source, "material");
  // Places that differ only by the word "county" may be the same agency or a city and a county of one name: unverified.
  const ePl = expected.places.map(placeKey), aPl = actual.meaning.places.map(placeKey);
  const noCounty = (xs: string[]) => join(xs.map((x) => x.replace(/\bcounty\b/g, "").replace(/\s+/g, " ").trim()));
  if (join(ePl) !== join(aPl) && noCounty(ePl) === noCounty(aPl)) add("places", join(ePl), join(aPl), "unverified");
  else decide("places", ePl, aPl);
  if (expected.places.length > 1 || actual.meaning.places.length > 1) {
    if ((expected.combine ?? "separate") !== actual.meaning.combine) add("combine", expected.combine ?? "separate", actual.meaning.combine ?? "separate", "material");
  }
  const ep = labelPeriod(expected.period, r);
  const ap = actual.meaning.period as { from: string; to: string };
  if (!ep) add("period", JSON.stringify(expected.period), `${ap.from}..${ap.to}`, "unverified");
  else if (ep.years) {
    // A label's set of years matches exactly that set, through the label's end.
    const end = actual.yearsThrough ?? (actual.years ? `${actual.years[actual.years.length - 1]}-12` : "");
    if (!actual.years || actual.years.join(",") !== ep.years.join(",") || end !== ep.to)
      add("period", `years ${ep.years.join(", ")} through ${ep.to}`, actual.years ? `years ${actual.years.join(", ")} through ${end}` : `${ap.from}..${ap.to}`, "material");
  } else if (actual.years) {
    // A year selection matches only a label range of exactly those years, from January through the effective end: December,
    // or the month its last year is clipped to.
    const span = Array.from({ length: Number(ep.to.slice(0, 4)) - Number(ep.from.slice(0, 4)) + 1 }, (_, i) => Number(ep.from.slice(0, 4)) + i);
    const end = actual.yearsThrough ?? `${actual.years[actual.years.length - 1]}-12`;
    const shown = `years ${actual.years.join(", ")}${actual.yearsThrough ? ` through ${actual.yearsThrough}` : ""}`;
    if (!ep.from.endsWith("-01") || ep.to !== end || span.join(",") !== actual.years.join(",")) add("period", `${ep.from}..${ep.to}`, shown, "material");
  } else if (`${ep.from}..${ep.to}` !== `${ap.from}..${ap.to}`) add("period", `${ep.from}..${ep.to}`, `${ap.from}..${ap.to}`, "material");
  // Measures with their units, kept together. A share's numerator and denominator roles cannot be read from the label.
  const ratio = actual.measures.some((m) => m.role !== "value");
  const aPairs = ratio ? [...new Set(actual.measures.map((m) => `${measureName(m.name) ?? "?"}|${unitName(m.unit) ?? "?"}`))] : actual.measures.map((m) => `${measureName(m.name) ?? "?"}|${unitName(m.unit) ?? "?"}`);
  const ePairs = expected.measures.map((m) => `${measureName(m.name) ?? "?"}|${unitName(m.unit) ?? "?"}`);
  decide("measures", ePairs.map((x) => (x.includes("?") ? null : x)), aPairs.map((x) => (x.includes("?") ? null : x)));
  // A share of a measure in its own units (the share cleared) reads its roles from the plan, against a label whose
  // denominator is all of that measure.
  // The label's denominator must name all of its one measure, in its unit ("all shoplifting offenses in the period");
  // any other wording keeps the roles unverified (Codex increment-6 review 02.3).
  const dm = /^all (.+) (offenses|victims|incidents) in the period$/i.exec(expected.denominator ?? "");
  const ownShare = !!actual.subsetShare && expected.statistic === "share" && expected.measures.length === 1 && !!dm
    && measureName(dm[1]) !== null && measureName(dm[1]) === measureName(expected.measures[0].name) && unitName(dm[2]) === unitName(expected.measures[0].unit);
  if (ratio && !ownShare) add("share roles", expected.denominator ?? "(label gives no roles)", actual.measures.map((m) => `${m.role}:${m.name}`).join(", "), "unverified");
  decide("filters", expected.filters.map(labelFilterKey), actual.filterKeys);
  decide("groupings", [...new Set(expected.groupings.map(groupingName))], [...new Set(actual.meaning.groupings.map(groupingName))]);
  // Statistic: the label's headline must be among the plan's statistics. A ratio of a measure to itself reads as a share
  // only when the roles are verified, so share-versus-ratio stays unverified.
  const eStat = expected.rank ? "rank" : expected.statistic;
  if (!actual.statistics.includes(eStat) && !(ownShare && actual.statistics.includes("ratio"))) add("statistic", eStat, actual.statistics.join(" + "), eStat === "share" && actual.statistics.includes("ratio") ? "unverified" : "material");
  if (expected.rank) {
    if (!actual.rank) add("rank", JSON.stringify(expected.rank), "none", "material");
    else {
      if (expected.rank.direction !== actual.rank.direction) add("rank direction", expected.rank.direction, actual.rank.direction, "material");
      if (expected.rank.limit !== actual.rank.limit) add("rank limit", String(expected.rank.limit), String(actual.rank.limit), "material");
      if (!actual.rank.by) add("rank by", expected.rank.by, "(the ranked statistic is not mapped)", "unverified");
      else if (expected.rank.by !== actual.rank.by) add("rank by", expected.rank.by, actual.rank.by, "material");
    }
  }
  // Increment 3: a change's two periods, as the label implies them. Its period runs from the earlier period's start to
  // the later period's end. Whole years compare the first year with the last (the last through the label's end). "The
  // same months of each year: A through B" compares those months of both years ("through the latest month": through
  // the label's end month). Labels that say neither stay unverified.
  if (expected.statistic === "change" && ep && !ep.years) {
    const sm = expected.filters.find((f) => /^the same months of each year:/i.test(f));
    const fy = ep.from.slice(0, 4), ty = ep.to.slice(0, 4);
    const monthNo = (w: string) => ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"].indexOf(w.toLowerCase()) + 1;
    let want: { earlier: { from: string; to: string }; later: { from: string; to: string } } | null = null;
    if (!sm) want = { earlier: { from: `${fy}-01`, to: `${fy}-12` }, later: { from: `${ty}-01`, to: ep.to } };
    else {
      const m = /:\s*([a-z]+) through (?:the latest month|([a-z]+))\s*$/i.exec(sm);
      const a = m ? monthNo(m[1]) : 0, b = m ? (m[2] ? monthNo(m[2]) : Number(ep.to.slice(5))) : 0;
      if (a > 0 && b > 0) { const mm = (n: number) => String(n).padStart(2, "0"); want = { earlier: { from: `${fy}-${mm(a)}`, to: `${fy}-${mm(b)}` }, later: { from: `${ty}-${mm(a)}`, to: `${ty}-${mm(b)}` } }; }
    }
    const show = (c: NonNullable<typeof want>) => `${c.earlier.from}..${c.earlier.to} vs ${c.later.from}..${c.later.to}`;
    if (!actual.comparison) add("comparison", want ? show(want) : "a change", "no period comparison", "material");
    else if (!want) add("comparison", sm ?? "(label gives no periods)", show(actual.comparison), "unverified");
    else if (show(want) !== show(actual.comparison)) add("comparison", show(want), show(actual.comparison), "material");
  } else if (actual.comparison) add("comparison", "(label states no change)", `${actual.comparison.earlier.from}..${actual.comparison.later.to}`, expected.statistic === "change" ? "unverified" : "material");
  if (expected.cohort && expected.cohort !== (actual.meaning.cohort ?? "all_reporting")) add("cohort", expected.cohort, actual.meaning.cohort ?? "all_reporting", "material");
  if (expected.denominator && !ratio) {
    const want = labelDenominator(expected.denominator);
    if (!want || !actual.denominator) add("denominator", expected.denominator, actual.denominator ?? "(not represented in the plan's meaning)", "unverified");
    else if (want !== actual.denominator) add("denominator", want, actual.denominator, "material");
  }
  for (const u of actual.untracked) add("untracked", "(not in the label schema)", u, "unverified");
  return out;
}
