/**
 * Turning a candidate's outcome into the labeled set's terms, and comparing it with a label (answer evaluation part 4).
 * The comparison separates MATERIAL differences (a different place, period, measure, unit, filter, grouping, statistic or
 * cohort: a different answer) from NAMING ones (a label or plan word the maps below do not know yet). A naming
 * difference is reported for the maps to be extended, never counted as a wrong answer.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ResolvedPeriod } from "../nibrs-plan/resolve";
import type { Meaning } from "./case";

export type Diff = { field: string; expected: string; actual: string; kind: "material" | "naming" };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().replace(/s$/, "");

/** Measure words: plan ids (draft layer) and label words, to one name. */
const MEASURE_ALIASES: Record<string, string> = {
  homicide: "murder", "murder and nonnegligent manslaughter": "murder", "violent crime ucr": "violent crime",
  "drug possession": "drug narcotic violation", "drug narcotic violation": "drug narcotic violation", "car theft": "motor vehicle theft",
  "auto theft": "motor vehicle theft", "vehicle burglary": "theft from motor vehicle", "property value": "stolen property", dui: "driving under the influence",
};
export const measureName = (s: string) => { const n = norm(s.replace(/^[a-z_]+\./, "").replace(/_cleared$/, "").replace(/_/g, " ")); return MEASURE_ALIASES[n] ?? n; };

const UNIT_ALIASES: Record<string, string> = {
  fbi_standard: "fbi standard", "victim robbery by offense": "fbi standard", "victims robbery by offense": "fbi standard",
  group_b_arrest: "arrest", "group b arrest": "arrest", arrestee: "arrest", property_segment: "property segment", dollar: "dollars",
};
export const unitName = (s: string) => { const n = norm(s.replace(/_/g, " ")); return UNIT_ALIASES[s] ?? UNIT_ALIASES[n] ?? n; };

/** A dimension or filter, reduced to its family ("weapon", "victim race", "clearance", "year"). */
export const dimensionName = (s: string) => {
  const n = norm(s.split(":")[0].replace(/^(time|geo|offense|victim_offender|offense_weapon|offense_bias|property|property_drug)\./, (m) => (m.startsWith("victim_offender") ? "relationship " : "")).replace(/[._]/g, " "));
  const map: Record<string, string> = { weapon: "weapon", "clearance type": "clearance type", "clearance method": "clearance", clearance: "clearance", relationship: "relationship", "location type": "location type", location: "location type", "loss type": "loss", loss: "loss", bias: "bias", "drug type": "drug type", agency: "agency", city: "agency", state: "state", year: "year", month: "month" };
  return map[n] ?? n;
};

export type Release = { firstMonth: string; lastMonth: string; asOf: string };
const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
/** The release's latest calendar year whose December it holds. */
const latestCompleteYear = (r: Release) => (r.lastMonth.endsWith("-12") ? Number(r.lastMonth.slice(0, 4)) : Number(r.lastMonth.slice(0, 4)) - 1);

/** A label's period, as months against a release; null when the rule wording is not known (a naming difference). */
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

const STATE_NAMES: Record<string, string> = { AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california", CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia", FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois", IN: "indiana", IA: "iowa", KS: "kansa", KY: "kentucky", LA: "louisiana", ME: "maine", MD: "maryland", MA: "massachusett", MI: "michigan", MN: "minnesota", MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada", NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york", NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon", PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota", TN: "tennessee", TX: "texa", UT: "utah", VT: "vermont", VA: "virginia", WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming" };
const stateKey = (code: string) => `state:${STATE_NAMES[code] ?? code.toLowerCase()}`;

/** A place as a comparable key: the nation; a state by name; an agency or city by its state and first name word. */
const placeKey = (p: { kind: string; name: string; state?: string }) => {
  if (p.kind === "national") return "national";
  if (p.kind === "state") return p.state ? stateKey(p.state) : `state:${norm(p.name)}`;
  return `local:${p.state ?? ""}:${norm(p.name).split(" ")[0]}`;
};

/** A NIBRS plan (with its resolved period) in the labeled set's terms. */
export function planToMeaning(plan: NibrsPlan, period: ResolvedPeriod): { meaning: Meaning; statistics: string[] } {
  const places = plan.geography.places.map((p) => {
    const at = p.kind === "agency_set" ? p.within : p;
    if (at.kind === "national") return { kind: "national" as const, name: "United States" };
    if (at.kind === "state") return { kind: "state" as const, name: STATE_NAMES[at.code] ?? at.code, state: at.code };
    if (at.kind === "agency") return { kind: "agency" as const, name: at.label.replace(/,\s*[A-Z]{2}$/, ""), ...(at.label.match(/,\s*([A-Z]{2})$/) ? { state: at.label.match(/,\s*([A-Z]{2})$/)![1] } : {}) };
    return { kind: "county" as const, name: at.label };
  });
  const months = period.kind === "absolute" ? { from: period.from, to: period.to } : { from: ym(Math.min(...period.years), 1), to: period.through ?? ym(Math.max(...period.years), 12) };
  const transforms = plan.transforms.map((t) => t.kind);
  // A ratio of a measure to the same measure (a subset over its population, cleared offenses over offenses) is a share.
  const base = (as: string) => plan.measures.find((m) => m.as === as)?.id.replace(/_cleared$/, "");
  const kinds = plan.statistics.map((s) => (s.kind === "ratio" && base(s.numerator) === base(s.denominator) ? "share" : s.kind));
  const statistic = transforms.includes("rank") ? "rank" : transforms.includes("period_comparison") ? "change" : kinds[kinds.length - 1];
  const filters = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].map((f) => (f.kind === "attribute" ? f.dimension : `${f.entity}.${f.where.map((w) => w.dimension.split(".")[1]).join("+")}`));
  for (const m of plan.measures) if (m.id.endsWith("_cleared")) filters.push("clearance");
  // A population condition on an agency set ("cities of 250,000 or more") is a filter in the label's terms.
  for (const p of plan.geography.places) if (p.kind === "agency_set" && p.where.some((x) => x.field === "agency.population")) filters.push("population");
  // Measures once each: a share's population and subset are one measure in the label's terms.
  const measures = [...new Map(plan.measures.map((m) => [`${m.id.replace(/_cleared$/, "")}|${m.unit}`, { name: m.id, unit: m.unit }])).values()];
  return {
    meaning: {
      source: plan.source,
      places,
      combine: plan.geography.combine,
      period: months,
      measures,
      filters,
      groupings: plan.groupings.map((g) => g.dimension).filter((g) => g !== "geo.place"),
      statistic: statistic as Meaning["statistic"],
      cohort: plan.coverage.cohort,
    },
    // Every statistic the plan reports: a breakdown's counts and shares both answer "how many by X".
    statistics: [...new Set([statistic, ...kinds])],
  };
}

/** Statistic words that name the same thing: a percent cleared is a share of offenses. */
const statisticFamily = (s: string, units: string[]) => (units.includes("percent cleared") && ["rate", "share", "ratio"].includes(s) ? "share" : s);

/** Field-by-field comparison of an actual meaning (from a plan) with an expected one (a label). */
export function compareMeaning(expected: Meaning, actual: Meaning, r: Release, actualStatistics: string[] = [actual.statistic]): Diff[] {
  const out: Diff[] = [];
  const d = (field: string, e: string, a: string, kind: Diff["kind"] = "material") => { if (e !== a) out.push({ field, expected: e, actual: a, kind }); };
  d("source", expected.source, actual.source);
  const ePlaces = expected.places.map(placeKey).sort().join(" | ");
  const aPlaces = actual.places.map(placeKey).sort().join(" | ");
  d("places", ePlaces, aPlaces);
  const ep = labelPeriod(expected.period, r);
  const ap = "from" in actual.period ? actual.period : null;
  if (!ep) out.push({ field: "period", expected: JSON.stringify(expected.period), actual: JSON.stringify(actual.period), kind: "naming" });
  else if (ap) d("period", `${ep.from}..${ep.to}`, `${ap.from}..${ap.to}`);
  const eM = expected.measures.map((m) => measureName(m.name)).sort().join(" + ");
  const aM = actual.measures.map((m) => measureName(m.name)).sort().join(" + ");
  if (eM !== aM) out.push({ field: "measures", expected: eM, actual: aM, kind: "material" });
  // A percent cleared is a share of offenses: its unit is the offense.
  const eUnits = expected.measures.map((m) => unitName(m.unit));
  d("units", eUnits.map((u) => (u === "percent cleared" ? "offense" : u)).sort().join(" + "), actual.measures.map((m) => unitName(m.unit)).sort().join(" + "));
  const filterName = (f: string) => { const n = dimensionName(f); return n === "clearance type" ? "clearance" : /resident(s)? or more|agency population/.test(n) ? "population" : n; };
  d("filters", [...new Set(expected.filters.map(filterName))].sort().join(", "), [...new Set(actual.filters.map(filterName))].sort().join(", "));
  d("groupings", [...new Set(expected.groupings.map(dimensionName))].sort().join(", "), [...new Set(actual.groupings.map(dimensionName))].sort().join(", "));
  // A ranking states its rank; a label may name the ranked statistic and its rank.
  const eStat = expected.rank ? "rank" : statisticFamily(expected.statistic, eUnits);
  const aStats = actualStatistics.map((s) => statisticFamily(s, eUnits));
  if (!aStats.includes(eStat)) out.push({ field: "statistic", expected: eStat, actual: aStats.join(" + "), kind: "material" });
  if (expected.cohort) d("cohort", expected.cohort, actual.cohort ?? "all_reporting");
  return out;
}
