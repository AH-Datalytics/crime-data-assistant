/**
 * Stage 2b (NIBRS): the CLOSED list of supported question types N1-N7 (plan docs/superpowers/plans/2026-10-09-request-
 * accounting-stage2b-nibrs.md, r1.1; owner list docs/superpowers/2026-10-09-nibrs-supported-question-types-draft.md).
 *
 *   N1 one place, one or more measures      N4 filters (any the chosen table holds together)
 *   N2 named places, each its own row        N5 clearance: rate, method, reasons, shares of clearances or offenses
 *   N3 one breakdown, with shares            N6 rankings: states by count or rate; cities/agencies by clearance rate
 *   N7 change between two years, one place
 *
 * The matcher reads the ledger's parts into ONE spec, or returns a named decline or clarification. It never drops or
 * swaps a part: each part is CONSUMED by a slot by value, and any non-context part of clause 0 left unconsumed declines
 * the whole request, naming it (stage 1 lessons 2-4). A spec is validated before it is returned.
 */
import type { Part, RequestLedger } from "./request-accounting";
import { refusalSentences } from "./request-accounting";
import { COMMERCIAL_LOCATION_NAMES } from "./nibrs-codes";

/* ------------------------------------------------------------------ vocabulary ---------------------------------- */

export type Unit = "victims" | "offenses" | "offenders" | "arrests" | "incidents" | "pairs" | "dollars" | "mixed";
export type FamilyMeasure = "domestic_violence" | "hate_crime" | "carjacking" | "motor_vehicle_property" | "property_value";

/** Offense measures and their NIBRS codes (the product's contract codes, lib/query-contract.ts). */
export const MEASURE_CODES: Record<string, string[]> = {
  murder: ["09A"], homicide: ["09A"], rape: ["11A", "11B", "11C"], robbery: ["120"], aggravated_assault: ["13A"], simple_assault: ["13B"],
  sex_offense: ["11A", "11B", "11C", "11D", "36A", "36B"], burglary: ["220"], theft_from_motor_vehicle: ["23F"], motor_vehicle_theft: ["240"],
  shoplifting: ["23C"], theft: ["23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H"], arson: ["200"], drug_possession: ["35A"], dui: ["90D"],
  violent_crime: ["09A", "11A", "11B", "11C", "120", "13A"], property_crime: ["200", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240"],
};
/** Crimes against persons count victims (the FBI NIBRS convention; CLAUDE.md "Person crimes must use victim summary tables"). */
export const PERSON_CODES = new Set(["09A", "09B", "09C", "11A", "11B", "11C", "11D", "13A", "13B", "13C", "100", "36A", "36B", "64A", "64B"]);
export const FAMILIES = new Set<string>(["domestic_violence", "hate_crime", "carjacking", "motor_vehicle_property", "property_value"]);
export const GROUP_B = new Set(["90A", "90B", "90C", "90D", "90E", "90F", "90G", "90H", "90I", "90J", "90Z"]);

export const MEASURE_LABEL: Record<string, string> = {
  murder: "murder", homicide: "homicide", rape: "rape", robbery: "robbery", aggravated_assault: "aggravated assault", simple_assault: "simple assault",
  sex_offense: "sex offense", burglary: "burglary", theft_from_motor_vehicle: "theft from motor vehicle", motor_vehicle_theft: "motor vehicle theft",
  shoplifting: "shoplifting", theft: "theft", arson: "arson", drug_possession: "drug possession", dui: "DUI", violent_crime: "violent crime",
  property_crime: "property crime", domestic_violence: "domestic violence", hate_crime: "hate crime", carjacking: "carjacking",
  motor_vehicle_property: "motor vehicle property", property_value: "property",
};

/** Filter value labels, for the delivered `filter` column ("sex: female; age: under 18"). */
/** The owner-decided commercial location types, named in every answer that applies them (plan r1.3). */
function commercialList(): string {
  const n = COMMERCIAL_LOCATION_NAMES;
  return `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}`;
}

export function filterLabel(dimValue: string): string {
  const [dim, v] = dimValue.split(":");
  const L: Record<string, Record<string, string>> = {
    sex: { F: "female", M: "male" }, age: { "Under 18": "under 18" }, race: { B: "Black", W: "White", A: "Asian" }, ethnicity: { H: "Hispanic" },
    weapon: { 12: "handgun", 13: "rifle", 14: "shotgun", 20: "knife", firearm: "firearm" },
    drug: { E: "marijuana", L: "amphetamines/methamphetamine", A: "crack cocaine", B: "cocaine", D: "heroin" },
    dv: { intimate_partner: "intimate partner", family: "family" },
    bias: { 21: "anti-Jewish", 12: "anti-Black", 11: "anti-White", 32: "anti-Hispanic", 14: "anti-Asian", 24: "anti-Islamic", 41: "anti-gay" },
    loss: { 7: "stolen", 5: "recovered", 4: "damaged", 6: "seized" },
    clearance: { A: "death of offender", B: "prosecution declined", C: "in custody elsewhere", D: "victim refused to cooperate", E: "juvenile, no custody", arrest: "by arrest", exceptional: "by exceptional means" },
    location: { 20: "residence/home", 13: "highway/road/alley/street", 22: "school/college", 18: "parking lot/garage", "07": "convenience store", 14: "hotel/motel", commercial: `commercial location types (${commercialList()})` },
    relationship: { ST: "stranger" },
  };
  const DIM: Record<string, string> = { drug: "drug type", dv: "category" };
  return `${DIM[dim] ?? dim}: ${L[dim]?.[v] ?? v}`;
}

/* ------------------------------------------------------------------ the spec ------------------------------------ */

export type NPlace =
  | { kind: "national"; label: "United States" }
  | { kind: "state"; name: string; code: string; label: string }
  | { kind: "agency"; agencyKind: "city" | "county"; name: string; state: string; text: string };

export type NPeriod =
  | { form: "year"; year: number }
  | { form: "range"; from: number; to: number }
  | { form: "years"; list: number[] }
  | { form: "month"; year: number; month: number }
  | { form: "monthrange"; from: [number, number]; to: [number, number] }
  | { form: "since"; from: number }
  | { form: "last"; n: number }
  | { form: "lastyear" }
  | { form: "latest" }
  | { form: "none" };

export type Grain = "total" | "year" | "month" | "rolling";
export type Statistic = "count" | "rate" | "clearance_rate" | "total_value" | "average_value";

export type SeriesSpec = { type: "series"; measures: string[]; unit: Unit | null; statistic: Statistic; filters: string[]; places: NPlace[]; period: NPeriod; grain: Grain;
  /** A rolling series' window (Jeff 2026-11-05: any length named; an average when asked): months null when none is named. */
  window?: { months: number | null; average: boolean } };
export type BreakdownSpec = { type: "breakdown"; measure: string; unit: Unit | null; filters: string[]; dim: string; place: NPlace; period: NPeriod; byYear?: true; byMonth?: true };
export type ShareSpec = { type: "share"; measure: string; unit: Unit | null; population: string[]; subset: string[]; denominator: "units" | "clearances"; place: NPlace; period: NPeriod; byState?: true };
export type RankSpec = { type: "rank"; entity: "state" | "city" | "agency"; measure: string; statistic: "count" | "rate" | "clearance_rate"; scope: NPlace; period: NPeriod; rank: { dir: "top" | "bottom"; n: number | null } | null; min: { op: ">=" | ">"; amount: number } | null };
export type ChangeSpec = { type: "change"; measure: string; unit: Unit | null; statistic: "count" | "rate"; place: NPlace; earlier: number; later: number };
export type NibrsSpec = SeriesSpec | BreakdownSpec | ShareSpec | RankSpec | ChangeSpec;

export type NibrsTypeDecision =
  | { kind: "spec"; spec: NibrsSpec; explainLimitation: string | null }
  | { kind: "decline"; parts: Part[]; explanation: string }
  | { kind: "clarify"; explanation: string }
  | { kind: "none" };

const STATE_CODE: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME",
  Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "Puerto Rico": "PR",
};
export const STATE_NAME_BY_CODE: Record<string, string> = Object.fromEntries(Object.entries(STATE_CODE).map(([n, c]) => [c, n]));

function placeOf(p: Part): NPlace | null {
  const v = p.value ?? "";
  if (v === "national") return { kind: "national", label: "United States" };
  if (v.startsWith("state:")) { const name = v.slice(6); const code = STATE_CODE[name]; return code ? { kind: "state", name, code, label: name } : null; }
  const m = /^(city|county):(.+):([A-Z]{2})?$/.exec(v);
  if (m) return { kind: "agency", agencyKind: m[1] as "city" | "county", name: m[2], state: m[3] ?? "", text: p.text };
  return null;
}

function periodOf(p: Part): NPeriod | null {
  const v = p.value ?? "";
  let m: RegExpExecArray | null;
  if ((m = /^year:(\d{4})$/.exec(v))) return { form: "year", year: Number(m[1]) };
  if ((m = /^(?:range|between):(\d{4}):(\d{4})$/.exec(v))) { const a = Number(m[1]); const b = Number(m[2]); return { form: "range", from: Math.min(a, b), to: Math.max(a, b) }; }
  if ((m = /^years:(\d{4}):(\d{4})$/.exec(v))) return { form: "years", list: [Number(m[1]), Number(m[2])].sort() };
  if ((m = /^month:(\d{4})-(\d{2})$/.exec(v))) return { form: "month", year: Number(m[1]), month: Number(m[2]) };
  if ((m = /^monthrange:(\d{4})-(\d{2}):(\d{4})-(\d{2})$/.exec(v))) return { form: "monthrange", from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] };
  if ((m = /^since:(\d{4})$/.exec(v))) return { form: "since", from: Number(m[1]) };
  if ((m = /^last:(\d+)$/.exec(v))) return { form: "last", n: Number(m[1]) };
  if (v === "lastyear") return { form: "lastyear" };
  if (v === "latest") return { form: "latest" };
  return null;
}

/** Population threshold `op|digits` (the 2a token); `max` thresholds are declined (lists keep a floor only). */
function thresholdOf(p: Part): { op: ">=" | ">"; amount: number } | null {
  const [op, tok] = (p.value ?? "").split("|");
  if ((op !== ">=" && op !== ">") || !/^\d+$/.test(tok ?? "")) return null;
  const amount = Number(tok);
  return Number.isSafeInteger(amount) ? { op, amount } : null;
}

const cannot = (p: Part, why: string) => `I can't apply "${p.text.trim()}": ${why} I haven't answered with a number that leaves it out.`;

/* ------------------------------------------------------------------ the matcher --------------------------------- */

/**
 * Read clause 0 of the ledger into one spec. `consumed` collects every part a slot used; any meaningful part left over
 * declines the request naming it. Clause 1 holds an explanation request beside an explicit numeric ask (L7).
 */
/**
 * `monthlyBreakdowns` (the shadow engine only; coordinator 2026-11-02): a breakdown by month, or over part of a year,
 * is answered from the monthly build instead of declined. The live route reads yearly summary tables and leaves it off.
 */
export type MatchOptions = { monthlyBreakdowns?: boolean };
export function matchNibrsType(ledger: RequestLedger, opts: MatchOptions = {}): NibrsTypeDecision {
  const parts = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const explain = ledger.parts.some((p) => p.clause === 1 && p.concept === "explain");
  const consumed = new Set<Part>();
  const take = (ps: Part[]) => { for (const p of ps) consumed.add(p); return ps; };
  const of = (c: string) => parts.filter((p) => p.concept === c);
  const declineParts = (ps: Part[], why: (p: Part) => string): NibrsTypeDecision => ({ kind: "decline", parts: ps, explanation: ps.map(why).join(" ") });

  if (parts.some((p) => ["peer", "cohort", "coverage-lookup", "completeness", "explain"].includes(p.concept))) {
    const ops = parts.filter((p) => ["peer", "cohort", "coverage-lookup", "completeness", "explain"].includes(p.concept));
    return declineParts(ops, (p) => cannot(p, p.concept === "explain" ? "I report what NIBRS records; I can't explain causes." : "that is answered only by its own fixed path, which couldn't answer this request."));
  }

  // ---- measures (families inferred from their filters) ----
  const filters = take(of("filter").concat(of("clearance-reason"))).map((p) => p.value!).filter(Boolean);
  let measures = take(of("measure")).map((p) => p.value!).filter((v) => v !== "unspecified");
  if (measures.length === 0) {
    if (filters.some((f) => f.startsWith("dv:"))) measures = ["domestic_violence"];
    else if (filters.some((f) => f.startsWith("drug:"))) measures = ["drug_possession"];
    else if (filters.some((f) => f.startsWith("bias:"))) measures = ["hate_crime"];
  }
  const units = take(of("unit")).map((p) => p.value as Unit);
  const unit: Unit | null = units.length ? (units[0] === "arrests" ? "arrests" : units[0]) : null;
  if (new Set(units).size > 1) return declineParts(of("unit"), (p) => cannot(p, "one counting unit per question; ask for victims, offenders, arrests or offenses separately."));

  // ---- places and periods ----
  const placeParts = take(of("place"));
  const places = placeParts.map(placeOf);
  if (places.some((p) => p === null)) return declineParts(placeParts.filter((p) => placeOf(p) === null), (p) => cannot(p, "I couldn't resolve that place to one NIBRS agency, a state or the nation."));
  // No place named: the nation, as the fixed paths read a request with no geography (contract kind "unknown"); the answer
  // says so (gold GC-002).
  const nationDefaulted = placeParts.length === 0;
  if (nationDefaulted) places.push({ kind: "national", label: "United States" });
  const periodParts = take(of("period"));
  const periods = periodParts.map(periodOf);
  if (periods.some((p) => p === null)) return declineParts(periodParts, (p) => cannot(p, "I couldn't read that as a period."));
  const changeParts = of("change");
  const rollingParts = take(of("rolling"));
  const rolling = rollingParts.length > 0;
  const rv = rollingParts.map((p) => String(p.value)).find((v) => v !== "rolling12") ?? (rolling ? "rolling12" : null);
  const window = rv ? { months: rv === "rolling12" ? 12 : /:(\d+)$/.test(rv) ? Number(/:(\d+)$/.exec(rv)![1]) : null, average: rv.startsWith("rolling-avg") } : undefined;
  const grainParts = take(of("grain"));
  const grains = grainParts.map((p) => p.value);
  const combine = take(of("combine")).length > 0;
  const breakdowns = of("breakdown");
  const share = of("share");
  const clearance = of("clearance");
  const statParts = of("statistic");
  const rankParts = of("rank");
  const thresholdParts = of("threshold");
  const entityParts = of("entity");
  const listParts = of("list");

  if (breakdowns.length > 1) return declineParts(breakdowns.slice(1), (p) => cannot(p, "I give one breakdown per answer; ask for one breakdown at a time."));

  // ---- statistic ----
  let statistic: Statistic = "count";
  for (const p of statParts) {
    take([p]);
    if (["rate", "per100k", "percapita"].includes(p.value ?? "")) statistic = "rate";
    else if (p.value === "total_value" || p.value === "average_value") statistic = p.value;
    else if (p.value === "count") { /* count */ }
    else return declineParts([p], (q) => cannot(q, "rates are given per 100,000 people."));
  }
  const clearanceRate = clearance.some((p) => p.value === "rate");
  // r2 (L12): a part a type does not apply is declined by name here; the route also binds every typed answer by value.
  const monthPeriodParts = periodParts.filter((p) => /^month/.test(p.value ?? ""));
  const unitParts = of("unit");

  // ---- N6: rankings (rank words, a threshold, or a list of entities) ----
  if (rankParts.length || thresholdParts.length || (entityParts.length && listParts.length === 0 && /\b(?:which|list)\b/i.test(ledger.question) && !placeParts.some((p) => p.value?.startsWith("city:")))) {
    take(rankParts); take(thresholdParts); take(entityParts); take(clearance);
    const entity = entityParts.map((p) => p.value)[0] ?? (rankParts.length ? null : null);
    if (!entity || !["state", "city", "agency"].includes(entity)) return { kind: "none" };
    if (measures.length !== 1) return { kind: "none" };
    if (changeParts.length) return declineParts(changeParts, (p) => cannot(p, "I rank places by a level, not by a change, in this version."));
    const rankVal = rankParts.map((p) => p.value ?? "").find((v) => /^(?:top|bottom):/.test(v)) ?? null;
    const n = rankVal ? rankVal.split(":")[1] : "";
    const rank = rankVal ? { dir: rankVal.startsWith("bottom") ? "bottom" as const : "top" as const, n: n ? Number(n) : (entity === "state" && /\bwhich\s+state\s+has\b/i.test(ledger.question) ? 1 : null) } : null;
    if (rank && rank.n === null && /\bwhich\s+(?:state|city|agency)\s+(?:has|had)\b/i.test(ledger.question)) rank.n = 1;
    const thresholds = thresholdParts.map(thresholdOf);
    if (thresholds.some((t) => t === null) || thresholds.length > 1) return declineParts(thresholdParts, (p) => cannot(p, "I can apply one minimum population (\"at least\" or \"over\"), not a maximum."));
    const notInRank = [...of("filter"), ...of("clearance-reason"), ...unitParts, ...monthPeriodParts, ...grainParts, ...of("rolling"), ...of("combine")];
    if (notInRank.length) return declineParts(notInRank, (p) => cannot(p, p.concept === "unit"
      ? "rankings count each offense in its standard unit (victims for crimes against persons, offenses otherwise); a ranking in another unit isn't built."
      : p.concept === "period" ? "a ranking covers a full year."
        : ["grain", "rolling", "combine"].includes(p.concept) ? "a ranking covers one year."
          : "a ranking of only part of an offense isn't built."));
    // r3: a state ranking is national, without a population minimum, of one offense counted in one unit.
    if (entity === "state") {
      const notInStateRank = [...thresholdParts, ...placeParts.filter((p) => placeOf(p)?.kind !== "national")];
      if (notInStateRank.length) return declineParts(notInStateRank, (p) => cannot(p, p.concept === "threshold" ? "states are ranked without a population minimum." : "a state ranking covers every state; it can't be limited to one place."));
      const mc = MEASURE_CODES[measures[0]] ?? [];
      if (mc.some((c) => PERSON_CODES.has(c)) && mc.some((c) => !PERSON_CODES.has(c))) return declineParts(of("measure"), (p) => cannot(p, "a combined category counts victims and offenses together, and states aren't ranked on a mixed count in this version."));
    }
    const scope = places[0] ?? { kind: "national" as const, label: "United States" as const };
    if (places.length > 1 || (scope.kind === "agency")) return declineParts(placeParts, (p) => cannot(p, "a ranking covers the nation or one state."));
    const stat = clearanceRate ? "clearance_rate" : statistic === "rate" ? "rate" : statistic === "count" ? "count" : null;
    if (!stat) return { kind: "none" };
    return finish({ type: "rank", entity: entity as "state" | "city" | "agency", measure: measures[0], statistic: stat, scope, period: periods[0] ?? { form: "none" }, rank, min: thresholds[0] ?? null });
  }

  // ---- N7: change between two years ----
  // Reader cluster 2 (2026-11-05): "How has violent crime in Alaska changed since 2018?", "...over the past 5 years":
  // a change over a span with no two years named asks for the series over that span, answered as one (the figures by
  // year; no comparison computed, no comment on direction).
  // Never a percent change ("% change", "percent change": Codex reader-change review 01): that asks for one computed
  // figure, so it keeps its own path (declined until two years are named), never answered as counts.
  const percentAsked = ledger.parts.some((p) => p.clause === 0 && ((p.concept === "punctuation" && p.text.trim() === "%") || (p.concept === "share" && /percent/i.test(p.text))))
    || changeParts.some((p) => /percent|%/i.test(p.text));
  const overSpan = (periods[0]?.form === "since" || periods[0]?.form === "last") && periods.length === 1 && !of("versus").length && !percentAsked;
  if (changeParts.length && !rankParts.length && overSpan) take(changeParts);
  else if (changeParts.length && !rankParts.length) {
    take(changeParts);
    const p = periods[0];
    const ends = p?.form === "range" ? [p.from, p.to] : p?.form === "years" ? p.list : null;
    if (!ends || places.length !== 1 || measures.length !== 1 || breakdowns.length || filters.length) return declineParts(changeParts, (q) => cannot(q, "I compare one measure for one place between two named years (for example \"from 2023 to 2025\")."));
    return finish({ type: "change", measure: measures[0], unit, statistic: statistic === "rate" ? "rate" : "count", place: places[0]!, earlier: ends[0], later: ends[1] });
  }

  const one = (what: string) => (places.length === 1 ? null : what);

  // ---- shares (r1.1 R3): population vs subset by where the words sit ----
  if (share.length) {
    take(share);
    take(clearance);
    // "by state" on a nationwide clearance share: one share per state (gold GC-001). Only clearance shares are split.
    const byStateParts = listParts.filter((p) => p.value === "list:state");
    const byState = byStateParts.length > 0 && places.length === 1 && places[0]!.kind === "national" && of("clearance-reason").length + filters.filter((f) => f.startsWith("clearance:")).length > 0;
    if (byState) take(byStateParts);
    if (measures.length !== 1 || one("one place")) return { kind: "none" };
    if (breakdowns.length) return breakdownDecision();
    const shareTime = [...monthPeriodParts, ...periodParts.filter((p) => /^years:/.test(p.value ?? "")), ...grainParts, ...of("rolling"), ...of("combine")];
    if (shareTime.length) return declineParts(shareTime, (p) => cannot(p, "a share covers one period as a whole; ask for each year on its own."));
    const shareStart = share[0].span[0];
    const structural = /\b(?:share|percent(?:age)?|proportion|portion)\s+of\b/i.test(share[0].text) || /\b(?:what|which)\s+(?:share|percent(?:age)?|proportion|portion)\s+of\b/i.test(ledger.question.slice(shareStart));
    if (!structural) return { kind: "clarify", explanation: "Do you mean the share of all clearances, or the share of all offenses? Ask, for example, \"what share of rape clearances were prosecution declined\" or \"what share of rapes were cleared because prosecution was declined\"." };
    // The subset begins at the first linking word after the population ("were", "was", "that", "who", "involved").
    const tail = ledger.question.slice(shareStart);
    const link = /\b(?:were|was|that|who|which|involved|involving|had)\b/i.exec(tail.slice(share[0].text.length));
    const subsetStart = link ? shareStart + share[0].text.length + link.index : Number.POSITIVE_INFINITY;
    const fparts = of("filter").concat(of("clearance-reason"));
    const subset = fparts.filter((p) => p.span[0] >= subsetStart).map((p) => p.value!);
    const population = fparts.filter((p) => p.span[0] < subsetStart).map((p) => p.value!);
    if (subset.length === 0) return { kind: "clarify", explanation: "Which part of the total should the share measure? Name it after \"were\" or \"that\" (for example \"what share of robbery offenders were under 18\")." };
    if ([...population, ...subset].some((f) => f.startsWith("clearance:"))) {
      const notInClearance = [...fparts.filter((p) => !(p.value ?? "").startsWith("clearance:")), ...unitParts.filter((p) => p.value !== "offenses")];
      if (notInClearance.length) return declineParts(notInClearance, (p) => cannot(p, p.concept === "unit"
        ? "clearance figures count offense records, not other units."
        : "NIBRS's clearance tables don't record it, so a clearance share can't be restricted by it."));
    }
    // r4: a clearance condition on the population ("rapes cleared by exceptional means") divides by those clearances,
    // however it is worded; otherwise the noun decides (clearances vs offenses).
    const clearancesDenominator = population.some((f) => f.startsWith("clearance:")) || clearance.some((p) => p.span[0] < subsetStart && p.value === "clearances");
    return finish({ type: "share", measure: measures[0], unit, population, subset, denominator: clearancesDenominator ? "clearances" : "units", place: places[0]!, period: periods[0] ?? { form: "none" }, ...(byState ? { byState: true } : {}) });
  }

  // ---- N3 / N5 breakdowns ----
  if (breakdowns.length) return breakdownDecision();

  // ---- N1 / N2 / N5 series ----
  take(clearance);
  if (measures.length === 0) return { kind: "none" };
  if (clearanceRate) statistic = "clearance_rate";
  if (places.length === 0) return { kind: "none" };
  if (periods.length > 1) return declineParts(periodParts.slice(1), (p) => cannot(p, "one period per answer."));
  let grain: Grain = rolling ? "rolling" : grains.includes("month") ? "month" : grains.includes("year") ? "year" : combine ? "total" : "total";
  const period = periods[0] ?? { form: "none" as const };
  if (!rolling && !grains.length && (period.form === "range" || period.form === "years" || period.form === "since" || period.form === "last")) grain = combine ? "total" : "year";
  // A grain asked for or chosen by a button stays ("murders in total", then "Every year available": by year), else the
  // period question asked again for ever (coordinator 2026-11-05: "murders in Total" crashed).
  if (combine && !grains.length && !(period.form === "range" || period.form === "years" || period.form === "since" || period.form === "last")) grain = "total";
  if (!rolling && monthPeriodParts.length) grain = "month";
  // r2 §3: rates are for complete years; a rate over several years is given per year.
  if ((statistic === "rate" || statistic === "clearance_rate") && grain === "month") {
    const named = statistic === "rate" ? statParts : clearance.filter((p) => p.value === "rate");
    return declineParts(named.length ? named : [...monthPeriodParts, ...grainParts], (p) => cannot(p, "rates are given for complete years, not for single months."));
  }
  if (statistic === "rate" && grain === "total" && of("combine").length) {
    return declineParts(of("combine"), (p) => cannot(p, "a rate over several years is given per year; ask without \"total\" for one rate per year."));
  }
  return finish({ type: "series", measures, unit, statistic, filters, places: places as NPlace[], period, grain, ...(grain === "rolling" && window ? { window } : {}) });

  function breakdownDecision(): NibrsTypeDecision {
    take(breakdowns); take(clearance);
    // Named before the measure check, so a monthly or rolling breakdown is declined by name even when no offense is
    // named (gold GC-101).
    if (rolling || (grains.includes("month") && !opts.monthlyBreakdowns)) return declineParts([...of("rolling"), ...grainParts.filter((p) => p.value === "month")], (p) => cannot(p, "breakdowns come from yearly tables; monthly or rolling breakdowns aren't available."));
    if (monthPeriodParts.length && !opts.monthlyBreakdowns) return declineParts(monthPeriodParts, (p) => cannot(p, "breakdowns come from yearly tables; a breakdown for part of a year isn't available."));
    const separateYears = periodParts.filter((p) => /^years:/.test(p.value ?? ""));
    if (separateYears.length) return declineParts(separateYears, (p) => cannot(p, "a breakdown covers one year or one range of years; ask for each year on its own."));
    if (measures.length !== 1 || one("one place")) return { kind: "none" };
    let dim = breakdowns[0].value!;
    let bUnit = unit;
    // r2: "by offender age" / "by victim age" fixes whose age (Codex review-13).
    const whose = /^(offender|victim)-age$/.exec(dim);
    if (whose) {
      const wanted: Unit = whose[1] === "offender" ? "offenders" : "victims";
      if (bUnit && bUnit !== wanted) return declineParts([breakdowns[0], ...unitParts], (p) => cannot(p, `an age breakdown of ${whose[1]}s counts ${wanted}, not ${bUnit}.`));
      bUnit = wanted; dim = "age";
    }
    if (dim === "clearance-type" || dim === "clearance-method") {
      // Owner 2026-10-25 ("virginia murder clearances by exception by type in 2025"): "by exception" with the
      // clearance-TYPE breakdown is not a conflicting restriction; it asks for the exceptional types only (death of
      // offender, prosecution declined, ...). It is consumed as that narrowing; every other restriction still declines.
      const exceptionalOnly = (p: Part) => dim === "clearance-type" && p.concept === "filter" && p.value === "clearance:exceptional";
      const notInClearance = [...of("filter").filter((p) => !exceptionalOnly(p)), ...of("clearance-reason"), ...unitParts.filter((p) => p.value !== "offenses")];
      if (notInClearance.length) return declineParts(notInClearance, (p) => cannot(p, p.concept === "unit"
        ? "clearance figures count offense records, not other units."
        : "NIBRS's clearance tables don't record it, so a clearance breakdown can't be restricted by it."));
    }
    const byYear = grains.includes("year"), byMonth = grains.includes("month");
    if (byYear && byMonth) return declineParts(grainParts, (p) => cannot(p, "a breakdown is by year or by month, not both."));
    return finish({ type: "breakdown", measure: measures[0], unit: bUnit, filters, dim, place: places[0]!, period: periods[0] ?? { form: "none" },
      ...(byYear ? { byYear: true as const } : {}), ...(byMonth ? { byMonth: true as const } : {}) });
  }

  function finish(spec: NibrsSpec): NibrsTypeDecision {
    // The final gate: every meaningful clause-0 part must have been consumed by a slot.
    const left = parts.filter((p) => !consumed.has(p) && p.concept !== "explain" && !(p.concept === "measure" && p.value === "unspecified" && measures.length > 0) && !(p.concept === "entity" && spec.type !== "rank" && (p.value === "county" || p.value === "agency")));
    if (left.length) return { kind: "decline", parts: left, explanation: refusalSentences(left.map((p) => ({ ...p, explanation: p.explanation ?? cannot(p, cannotReason(p)) }))).join(" ") };
    const invalid = validateSpec(spec);
    if (invalid) return { kind: "decline", parts: [], explanation: invalid };
    const limits = [
      nationDefaulted && !(spec.type === "share" && spec.byState) ? "No place was named, so this covers the nation: every agency that reported to NIBRS." : null,
      explain ? "I can't explain why the figures are what they are: NIBRS records reported offenses, not their causes." : null,
    ].filter(Boolean);
    return { kind: "spec", spec, explainLimitation: limits.length ? limits.join(" ") : null };
  }
}

function cannotReason(p: Part): string {
  switch (p.concept) {
    case "list": return "this answer type doesn't list every place.";
    case "versus": return "comparisons are answered as named places side by side; ask for the places and the years.";
    case "grain": return "that time grain isn't available for this answer.";
    case "clearance": return "clearance figures need an offense, one place and a year.";
    default: return "I couldn't use it in a supported question type.";
  }
}

export function validateSpec(spec: NibrsSpec): string | null {
  if (spec.type === "series" && spec.places.length > 10) return "I can compare up to 10 named places at a time.";
  if (spec.type === "change" && !(spec.earlier < spec.later)) return "The earlier year must come before the later year.";
  return null;
}
