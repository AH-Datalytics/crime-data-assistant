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
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ResolvedPeriod } from "../nibrs-plan/resolve";
import type { Meaning } from "./case";

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
  carjacking: "carjacking", "violent crime": "violent crime", "violent crime ucr": "violent crime", "property crime": "property crime", "property crime ucr": "property crime",
  "sex offense": "sex offense", "drug possession": "drug narcotic violation", "drug narcotic violation": "drug narcotic violation", "drug equipment violation": "drug equipment violation",
  dui: "driving under the influence", "driving under the influence": "driving under the influence", "domestic violence": "domestic violence", "hate crime": "hate crime",
  "all offense": "all offenses", "all offenses": "all offenses", "all crime offenses": "all offenses", "all crime": "all offenses",
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
  if (op === "between" && !/\.age$/.test(dimension)) return null;
  if (dimension.endsWith("weapon")) return [...v].sort().join("+") === [...FIREARM].sort().join("+") ? "weapon:firearm" : v.join("+") === "20" ? "weapon:knife" : null;
  if (dimension === "offense.clearance_method") return v.join("+") === "exceptional" ? "clearance:exceptional" : v.join("+") === "arrest" ? "clearance:arrest" : null;
  if (dimension === "offense.clearance_type") return v.join("+") === "B" ? "clearance:prosecution declined" : null;
  if (dimension === "property.loss_type") return v.join("+") === "7" ? "loss:stolen" : v.join("+") === "6" ? "loss:seized" : null;
  if (/\.age$/.test(dimension) && op === "between" && v.join("+") === "1+17") return `${dimension.split(".")[0]} age:under 18`;
  if (/\.sex$/.test(dimension)) return v.join("+") === "F" ? `${dimension.split(".")[0]} sex:female` : v.join("+") === "M" ? `${dimension.split(".")[0]} sex:male` : null;
  return null;
}
function labelFilterKey(f: string): string | null {
  const [fam, ...rest] = f.split(":");
  const family = norm(fam), value = norm(rest.join(":"));
  if (family === "weapon") return /firearm|gun/.test(value) ? "weapon:firearm" : /knife/.test(value) ? "weapon:knife" : null;
  if (family === "clearance") return /prosecution declined/.test(value) ? "clearance:prosecution declined" : /exceptional/.test(value) ? "clearance:exceptional" : /arrest/.test(value) ? "clearance:arrest" : null;
  if (family === "loss") return /stolen/.test(value) ? "loss:stolen" : /seized/.test(value) ? "loss:seized" : null;
  if (/^(victim|offender|arrestee) age$/.test(family)) return /under 18/.test(value) ? `${family}:under 18` : null;
  if (/^(victim|offender|arrestee) sex$/.test(family)) return /female/.test(value) ? `${family.split(" ")[0]} sex:female` : /\bmale/.test(value) ? `${family.split(" ")[0]} sex:male` : null;
  return null;
}

/* ------------------------------------------------------------------ groupings -------------------------------------- */

const GROUPINGS: Record<string, string> = {
  "time.year": "year", year: "year", "time.month": "month", month: "month", "geo.agency": "agency", agency: "agency", city: "agency", "geo.state": "state", state: "state",
  "victim.race": "victim race", "victim race": "victim race", "victim.sex": "victim sex", "victim sex": "victim sex", "victim.age": "victim age", "victim age": "victim age",
  "offender.race": "offender race", "offender race": "offender race", "offender.sex": "offender sex", "offender sex": "offender sex", "offender.age": "offender age", "offender age": "offender age",
  "offense.location_type": "location type", "location type": "location type", "offense.clearance_type": "clearance type", "clearance type": "clearance type",
  "offense_weapon.weapon": "weapon", weapon: "weapon", "victim_offender.relationship": "relationship", relationship: "relationship", "offense.offense": "offense type", "offense type": "offense type",
};
const groupingName = (s: string): string | null => GROUPINGS[s] ?? GROUPINGS[norm(s)] ?? null;

/* ------------------------------------------------------------------ periods and places ----------------------------- */

export type Release = { firstMonth: string; lastMonth: string; asOf: string };
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
const latestCompleteYear = (r: Release) => (r.lastMonth.endsWith("-12") ? Number(r.lastMonth.slice(0, 4)) : Number(r.lastMonth.slice(0, 4)) - 1);

/** A label's period as months against a release; null when the rule wording is not known (unverified). */
export function labelPeriod(p: Meaning["period"], r: Release): { from: string; to: string } | null {
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
  return null;
}

const STATE_NAMES: Record<string, string> = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming" };
const STATE_CODES = Object.fromEntries(Object.entries(STATE_NAMES).map(([c, n]) => [n, c]));

/** A place as a comparable key: the nation; a state by code; a local agency by state and its full name without the agency-type words. */
function placeKey(p: { kind: string; name: string; state?: string }): string {
  if (p.kind === "national") return "national";
  if (p.kind === "state") return `state:${p.state ?? STATE_CODES[norm(p.name)] ?? norm(p.name)}`;
  const name = norm(p.name).replace(/\b(police|department|dept|pd|sheriff s|sheriffs|sheriff|office|metropolitan|city of|city|division)\b/g, " ").replace(/\s+/g, " ").trim();
  return `local:${p.state ?? ""}:${name}`;
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
  rank: { direction: string; limit: number | null } | null;
  untracked: string[];             // plan features the label schema cannot express (transform parameters, bins)
};

export function planToMeaning(plan: NibrsPlan, period: ResolvedPeriod): PlanView {
  const places = plan.geography.places.map((p) => {
    const at = p.kind === "agency_set" ? p.within : p;
    if (at.kind === "national") return { kind: "national" as const, name: "United States" };
    if (at.kind === "state") return { kind: "state" as const, name: STATE_NAMES[at.code] ?? at.code, state: at.code };
    if (at.kind === "agency") { const st = at.label.match(/,\s*([A-Z]{2})$/)?.[1]; return { kind: "agency" as const, name: at.label.replace(/,\s*[A-Z]{2}$/, ""), ...(st ? { state: st } : {}) }; }
    return { kind: "county" as const, name: at.label };
  });
  const months = period.kind === "absolute" ? { from: period.from, to: period.to } : { from: ym(Math.min(...period.years), 1), to: period.through ?? ym(Math.max(...period.years), 12) };
  const years = period.kind === "years" ? [...period.years].sort() : null;
  const byAs = new Map(plan.measures.map((m) => [m.as, m]));
  const roles = new Map<string, "numerator" | "denominator">();
  for (const s of plan.statistics) if (s.kind === "ratio") { roles.set(s.numerator, "numerator"); roles.set(s.denominator, "denominator"); }
  const statistics = plan.statistics.map((s) => s.kind);
  const transforms = plan.transforms.map((t) => t.kind);
  const headline = transforms.includes("rank") ? "rank" : transforms.includes("period_comparison") ? "change" : statistics[statistics.length - 1];
  const filterKeys: (string | null)[] = [];
  for (const f of [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])]) {
    if (f.kind === "attribute") filterKeys.push(planFilterKey(f.dimension, f.values ?? [], f.op));
    else if (f.negate) filterKeys.push(null); // a negated existence has no label equivalent here
    else for (const w of f.where) filterKeys.push(w.kind === "attribute" ? planFilterKey(w.dimension, w.values ?? [], w.op) : null);
  }
  for (const m of plan.measures) if (m.id.endsWith("_cleared")) filterKeys.push("clearance:cleared");
  for (const p of plan.geography.places) if (p.kind === "agency_set") for (const w of p.where) filterKeys.push(w.field === "agency.population" && w.op === ">=" ? `population:${w.value}+` : null);
  const rankT = plan.transforms.find((t) => t.kind === "rank");
  // Plan details the label schema cannot express: compared as unverified, never as matches.
  const untracked = [
    ...plan.transforms.filter((t) => t.kind === "rolling").map((t) => `rolling ${"months" in t ? t.months : ""} months`),
    ...plan.transforms.filter((t) => t.kind === "period_comparison").map((t) => ("earlier" in t ? `comparison ${t.earlier.from}..${t.earlier.to} vs ${t.later.from}..${t.later.to}` : "comparison")),
    ...plan.statistics.filter((s) => s.kind === "share").map((s) => `share within ${"within" in s ? s.within.join("+") || "all" : "?"}`),
    ...plan.groupings.filter((g) => g.bins).map((g) => `${g.dimension} bins`),
  ];
  return {
    meaning: {
      source: plan.source, places, combine: plan.geography.combine, period: months,
      measures: plan.measures.map((m) => ({ name: m.id, unit: m.unit })), filters: [], groupings: plan.groupings.map((g) => g.dimension).filter((g) => g !== "geo.place"),
      statistic: headline as Meaning["statistic"], cohort: plan.coverage.cohort,
    },
    measures: plan.measures.map((m) => ({ name: m.id, unit: m.unit, role: roles.get(m.as) ?? "value" })),
    filterKeys, statistics: [...new Set([headline, ...statistics])], years, yearsThrough: period.kind === "years" ? period.through ?? null : null,
    rank: rankT && rankT.kind === "rank" ? { direction: rankT.direction, limit: rankT.limit } : null,
    untracked,
  };
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
  else if (actual.years) {
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
  if (ratio) add("share roles", expected.denominator ?? "(label gives no roles)", actual.measures.map((m) => `${m.role}:${m.name}`).join(", "), "unverified");
  decide("filters", expected.filters.map(labelFilterKey), actual.filterKeys);
  decide("groupings", [...new Set(expected.groupings.map(groupingName))], [...new Set(actual.meaning.groupings.map(groupingName))]);
  // Statistic: the label's headline must be among the plan's statistics. A ratio of a measure to itself reads as a share
  // only when the roles are verified, so share-versus-ratio stays unverified.
  const eStat = expected.rank ? "rank" : expected.statistic;
  if (!actual.statistics.includes(eStat)) add("statistic", eStat, actual.statistics.join(" + "), eStat === "share" && actual.statistics.includes("ratio") ? "unverified" : "material");
  if (expected.rank) {
    if (!actual.rank) add("rank", JSON.stringify(expected.rank), "none", "material");
    else {
      if (expected.rank.direction !== actual.rank.direction) add("rank direction", expected.rank.direction, actual.rank.direction, "material");
      if (expected.rank.limit !== actual.rank.limit) add("rank limit", String(expected.rank.limit), String(actual.rank.limit), "material");
      add("rank by", expected.rank.by, "(the ranked statistic is not mapped)", "unverified");
    }
  }
  if (expected.cohort && expected.cohort !== (actual.meaning.cohort ?? "all_reporting")) add("cohort", expected.cohort, actual.meaning.cohort ?? "all_reporting", "material");
  if (expected.denominator && !ratio) add("denominator", expected.denominator, "(not represented in the plan's meaning)", "unverified");
  for (const u of actual.untracked) add("untracked", "(not in the label schema)", u, "unverified");
  return out;
}
