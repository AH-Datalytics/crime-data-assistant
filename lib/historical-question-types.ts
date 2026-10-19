/**
 * Stage 2a (Historical): the CLOSED list of supported question types H1-H6 (plan docs/superpowers/plans/2026-10-08-
 * request-accounting-stage2a-historical.md, r1.1 + K2/K7; owner list docs/superpowers/2026-10-08-historical-nibrs-
 * supported-question-types-draft.md).
 *
 *   H1 one measure, one place              H4 list or rank places, one year
 *   H2 one measure, 2-10 named places      H5 all states by year
 *   H3 2-10 measures of one family, 1 place H6 change between two single years
 *
 * The matcher reads the ledger's parts into slots and returns ONE of: a complete typed spec, a named decline, a
 * clarification, or `none` (no numeric reading). It never drops or swaps a part: after a spec is built, the FINAL GATE
 * checks every non-context part of clause 0 against the spec by VALUE (consumedBy). A part whose value is not in the
 * spec declines the whole request, naming the part (stage 1 lessons 2-4). Requested values are kept RAW (rank counts and
 * population amounts as exact digit tokens) and converted only losslessly (lesson 3). Explicit periods never fall to a
 * default (lesson 5). A spec is validated before it is returned (lesson 7).
 */
import type { Part, RequestLedger } from "./request-accounting";
import { refusalSentences } from "./request-accounting";
import { relativeYearRangeForQuestion } from "./time-conventions";

export type CrimeMeasure = "murder" | "rape" | "robbery" | "aggravated_assault" | "burglary" | "theft" | "motor_vehicle_theft" | "violent" | "property" | "total";
export type StaffingMeasure = "officers" | "civilians" | "employees";
export type Measure = CrimeMeasure | StaffingMeasure;
export type Family = "crime" | "clearance" | "staffing";
export type Statistic = "count" | "rate_per_100k" | "percent_cleared" | "per_1000" | "per_100k";
export type PlaceRef =
  | { kind: "national"; label: "United States" }
  | { kind: "state"; name: string; label: string }
  | { kind: "agency"; agencyKind: "city" | "county"; name: string; state: string; label: string };
export type SourceId = "agency_crime" | "state_national" | "agency_clearance" | "national_clearance" | "staffing";
export type Bounds = { min: number; max: number } | null;

/** A requested period, kept as the request stated it. */
export type PeriodRequest =
  | { form: "year"; year: number }
  | { form: "range"; from: number; to: number }
  | { form: "since"; from: number }
  | { form: "after"; year: number }
  | { form: "before"; year: number }
  | { form: "last"; n: number; includeCurrent?: boolean }
  | { form: "lastyear" }
  | { form: "latest" }
  | { form: "all" }
  | { form: "none" };

export type SeriesSpec = {
  type: "H1" | "H2" | "H3" | "H5";
  family: Family;
  measures: Measure[];
  statistic: Statistic;
  places: PlaceRef[];
  period: PeriodRequest;
  /** H1 only: one period total over a multi-year range (counts only). */
  total: boolean;
};
export type RankSpec = {
  type: "H4";
  family: Family;
  measure: Measure;
  statistic: Statistic;
  entity: "state" | "city" | "county" | "agency";
  scope: PlaceRef; // national or one state
  period: PeriodRequest; // year | lastyear | latest | none
  rank: { dir: "top" | "bottom"; n: number; stated: boolean } | null;
  min: { op: ">=" | ">"; amount: number; token: string } | null;
};
export type ChangeSpec = {
  type: "H6";
  family: Family;
  measure: Measure;
  base: "count" | "rate_per_100k";
  places: PlaceRef[];
  earlier: number;
  later: number | "anchor";
};
export type HistoricalSpec = SeriesSpec | RankSpec | ChangeSpec;

export type TypeDecision =
  | { kind: "spec"; spec: HistoricalSpec; explainLimitation: string | null }
  | { kind: "decline"; parts: Part[]; explanation: string }
  | { kind: "clarify"; explanation: string }
  | { kind: "none" };

export type TypeContext = {
  /** Measured year bounds of a source table; null when they cannot be read (open forms are then declined). */
  bounds: (source: SourceId) => Bounds;
  now?: Date;
};

/* ------------------------------------------------------------------------------------------ labels ------------- */

export const MEASURE_LABEL: Record<Measure, string> = {
  murder: "murders", rape: "rapes", robbery: "robberies", aggravated_assault: "aggravated assaults", burglary: "burglaries",
  theft: "thefts", motor_vehicle_theft: "motor vehicle thefts", violent: "violent crimes", property: "property crimes", total: "total crimes (violent plus property)",
  officers: "sworn officers", civilians: "civilian employees", employees: "total employees",
};
const CRIME: ReadonlySet<string> = new Set(["murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft", "violent", "property", "total"]);
const STAFF: ReadonlySet<string> = new Set(["officers", "civilians", "employees"]);
const RANK_MAX = 50;
const RANK_DEFAULT = 20;

/* ------------------------------------------------------------------------------------- small helpers ----------- */

function placeFromValue(value: string): PlaceRef | "ambiguous" | null {
  if (value === "national") return { kind: "national", label: "United States" };
  const [kind, name, state] = value.split(":");
  if (kind === "ambiguous") return "ambiguous";
  if (kind === "state") return { kind: "state", name, label: name };
  if ((kind === "city" || kind === "county") && name && state) return { kind: "agency", agencyKind: kind, name, state, label: `${name}, ${state}` };
  return null;
}
export function placeKey(p: PlaceRef): string {
  return p.kind === "national" ? "national" : p.kind === "state" ? `state:${p.name}` : `${p.agencyKind}:${p.name}:${p.state}`;
}
function periodFromValue(value: string): PeriodRequest | null {
  const [form, a, b] = value.split(":");
  const n = (x: string) => Number(x);
  switch (form) {
    case "year": return { form: "year", year: n(a) };
    case "range": return { form: "range", from: n(a), to: n(b) };
    case "between": return { form: "range", from: Math.min(n(a), n(b)), to: Math.max(n(a), n(b)) };
    case "since": return { form: "since", from: n(a) };
    case "after": return { form: "after", year: n(a) };
    case "before": return { form: "before", year: n(a) };
    case "last": return /^\d{1,2}$/.test(a) && n(a) >= 1 && n(a) <= 60 ? { form: "last", n: n(a) } : null;
    case "lastinc": return /^\d{1,2}$/.test(a) && n(a) >= 1 && n(a) <= 60 ? { form: "last", n: n(a), includeCurrent: true } : null;
    case "lastyear": return { form: "lastyear" };
    case "latest": return { form: "latest" };
    case "all": return { form: "all" };
    default: return null;
  }
}
export function periodKey(p: PeriodRequest): string {
  switch (p.form) {
    case "year": return `year:${p.year}`;
    case "range": return `range:${p.from}:${p.to}`;
    case "since": return `since:${p.from}`;
    case "after": return `after:${p.year}`;
    case "before": return `before:${p.year}`;
    case "last": return p.includeCurrent ? `lastinc:${p.n}` : `last:${p.n}`;
    default: return p.form;
  }
}
/** Lossless numeric token: digits only, no leading zeros, a safe integer whose decimal string equals the token. */
export function exactCount(token: string): number | null {
  if (!/^\d+$/.test(token)) return null;
  const t = token.replace(/^0+(?=\d)/, "");
  const n = Number(t);
  return Number.isSafeInteger(n) && String(n) === t ? n : null;
}

/** The source table a series reads, or a decline reason. */
const CLEARANCE_PHRASE: Partial<Record<Measure, string>> = { murder: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "aggravated assault", burglary: "burglary", theft: "theft", motor_vehicle_theft: "motor vehicle theft", violent: "violent crime", property: "property crime" };

export function sourceFor(family: Family, place: PlaceRef, measure?: Measure): SourceId | string {
  if (family === "crime") return place.kind === "agency" ? "agency_crime" : "state_national";
  if (family === "clearance") {
    if (place.kind === "agency") return "agency_clearance";
    if (place.kind === "national") return "national_clearance";
    // The same wording as the existing clearance-grain decline (lib/historical-clearance-grain.ts stateDeclineMessage).
    const phrase = measure ? CLEARANCE_PHRASE[measure] : null;
    const subject = phrase ? `a statewide ${phrase} clearance rate` : "statewide clearance rates";
    return `Historical does not provide ${subject} for ${place.label}, and individual agency percentages cannot be combined into one reliably. I can show the national clearance rate, or individual ${place.label} agencies' reported rates where available.`;
  }
  if (place.kind === "agency") return "staffing";
  return "Historical doesn't total police staffing for a state or the nation (agency reporting varies too much for a reliable sum); ask for a specific agency.";
}

/* ------------------------------------------------------------------------------------- period resolution ------- */

export type ResolvedYears =
  | { kind: "years"; years: number[]; explicit: boolean; clippedFrom: number[] | null }
  | { kind: "decline"; reason: string };

const span = (a: number, b: number) => (a > b ? [] : Array.from({ length: b - a + 1 }, (_, i) => a + i));

/**
 * The years one series reads for a requested period. Explicit forms (a year, a range) are never moved: years the source
 * lacks stay in the list and become "no data" cells. Open and relative forms are clipped to the source's bounds, and the
 * clip is reported. `anchor` overrides the source max for data-anchored forms in a mixed-source request (C3).
 */
export function resolveYears(p: PeriodRequest, bounds: Bounds, now: Date, anchor?: number): ResolvedYears {
  const explicit = p.form === "year" || p.form === "range";
  if (explicit) {
    if (p.form === "range" && p.from > p.to) return { kind: "decline", reason: `the period ${p.from} to ${p.to} ends before it starts.` };
    const ys = p.form === "year" ? [p.year] : span(p.from, p.to);
    return { kind: "years", years: ys, explicit: true, clippedFrom: null };
  }
  if (!bounds) return { kind: "decline", reason: "the latest year in this data can't be confirmed, so I can't resolve an open or relative period. Please name the years." };
  const max = anchor ?? bounds.max;
  let requested: number[];
  switch (p.form) {
    // Open-ended to the latest data: the source's last year is where "since" ends, not a clip of the request.
    case "since": requested = span(p.from, Math.max(p.from, max)); break;
    case "after": requested = span(p.year + 1, Math.max(p.year + 1, max)); break;
    case "before": requested = span(bounds.min, p.year - 1); break;
    case "last": {
      const r = relativeYearRangeForQuestion(`last ${p.n} years${p.includeCurrent ? " including this year" : ""}`, now);
      requested = r ? span(r.start, r.end) : [];
      break;
    }
    case "lastyear": {
      const r = relativeYearRangeForQuestion("last 1 years", now);
      requested = r ? [r.end] : [];
      break;
    }
    case "latest": requested = [max]; break;
    case "all": case "none": requested = span(bounds.min, max); break;
  }
  const years = requested.filter((y) => y >= bounds.min && y <= max);
  if (years.length === 0) {
    const why = p.form === "since" || p.form === "after"
      ? `the latest year in this source is ${max}, so there is nothing ${p.form === "after" ? `after ${p.year}` : `from ${p.from}`} yet.`
      : p.form === "before" ? `this source starts in ${bounds.min}, so there is nothing before ${p.year}.`
        : `this source covers ${bounds.min}-${max}, which doesn't include the period asked for.`;
    return { kind: "decline", reason: why };
  }
  const clipped = requested.length !== years.length ? requested : null;
  return { kind: "years", years, explicit: false, clippedFrom: clipped };
}

/* ---------------------------------------------------------------------------------------------- matcher -------- */

type Slots = {
  parts: Part[];
  measures: Part[]; staffing: Part[]; clearance: Part[]; statistic: Part[]; places: Part[]; periods: Part[];
  rank: Part[]; threshold: Part[]; change: Part[]; versus: Part[]; combine: Part[]; grain: Part[]; list: Part[];
  entity: Part[]; operations: Part[]; explain: Part[]; other: Part[];
};

function slots(ledger: RequestLedger): Slots {
  const s: Slots = { parts: [], measures: [], staffing: [], clearance: [], statistic: [], places: [], periods: [], rank: [], threshold: [], change: [], versus: [], combine: [], grain: [], list: [], entity: [], operations: [], explain: [], other: [] };
  for (const p of ledger.parts) {
    if (p.state === "context") continue;
    if (p.concept === "explain" && p.clause === 1) { s.explain.push(p); continue; }
    s.parts.push(p);
    const by: Record<string, keyof Slots> = { measure: "measures", staffing: "staffing", clearance: "clearance", statistic: "statistic", place: "places", period: "periods", rank: "rank", threshold: "threshold", change: "change", versus: "versus", combine: "combine", grain: "grain", list: "list", entity: "entity", scorecard: "operations", peer: "operations", "coverage-lookup": "operations", completeness: "operations", "prison-population": "operations", explain: "explain" };
    const key = by[p.concept];
    (key ? s[key] : s.other).push(p);
  }
  return s;
}

const decline = (parts: Part[], explanation: string): TypeDecision => ({ kind: "decline", parts, explanation });
const quoteAll = (parts: Part[]) => parts.map((p) => `"${p.text.trim()}"`).join(" and ");

/** Words for parts no type can use (the operation paths that did not take the request, a stray clause). */
function cannotUse(parts: Part[], s?: Slots): TypeDecision {
  const extra = (s?.parts ?? []).filter((p) => !["scorecard", "peer", "coverage-lookup", "completeness", "prison-population", "place"].includes(p.concept));
  // One sentence per concept: several peer phrases ("the national average", "peer city average") are named together.
  const byConcept = new Map<string, Part[]>();
  for (const p of parts) byConcept.set(p.concept, [...(byConcept.get(p.concept) ?? []), p]);
  const grouped = [...byConcept.values()].map((ps) => ({ ...ps[0], text: ps.map((p) => p.text.trim()).join("\" and \"") }));
  const sentences = grouped.map((p) => {
    if (p.concept === "scorecard") return extra.length
      ? `A scorecard shows a place's latest year with no other conditions, so I can't apply ${quoteAll(extra)} to it, and I haven't answered with a number that leaves ${extra.length === 1 ? "it" : "them"} out. Ask for the scorecard alone, or for the measure and years you want.`
      : `I couldn't build the scorecard for this place, so I haven't answered with a number.`;
    if (p.concept === "peer") return `I couldn't build the peer comparison ("${p.text.trim()}") for this wording, so I haven't answered with a number that leaves it out. Name the cities to compare instead.`;
    if (p.concept === "coverage-lookup") return `I can't list Historical data coverage for this question ("${p.text.trim()}"); ask "what data do you have for <place>" instead.`;
    if (p.concept === "completeness") return `I couldn't answer the completeness part ("${p.text.trim()}") together with the rest of this question.`;
    if (p.concept === "prison-population") return "The U.S. prison population is not in these datasets: they record crimes reported to law enforcement, not incarceration or other court and corrections outcomes.";
    return p.explanation ?? `I can't apply "${p.text.trim()}" to a Historical answer here, so I haven't answered with a number that leaves it out.`;
  });
  return decline(parts, [...new Set(sentences)].join(" "));
}

/** Read the statistic for a family from the statistic parts (one statistic per request). */
function statisticFor(family: Family, statParts: Part[], clearanceParts: Part[]): { stat: Statistic } | TypeDecision {
  const scales = statParts.filter((p) => (p.value ?? "").startsWith("scale:"));
  if (scales.length) return decline(scales, `I can give crime rates per 100,000 residents (and staffing per 1,000 or per 100,000 residents), not ${quoteAll(scales)}. I haven't answered with a different scale.`);
  const want = new Set<Statistic>();
  for (const p of statParts) {
    const v = p.value;
    if (family === "crime") want.add(v === "count" ? "count" : v === "per1000" ? ("per_1000" as Statistic) : "rate_per_100k");
    else if (family === "clearance") want.add(v === "count" ? "count" : "percent_cleared");
    else want.add(v === "count" ? "count" : v === "per100k" ? "per_100k" : "per_1000");
  }
  if (family === "clearance") {
    if (want.has("count")) return decline(statParts.filter((p) => p.value === "count"), "Historical stores clearances as percentages, not counts, so I can't give a number of cleared cases.");
    return { stat: "percent_cleared" };
  }
  if (family === "crime" && want.has("per_1000")) return decline(statParts.filter((p) => p.value === "per1000"), `I can give crime rates per 100,000 residents, not ${quoteAll(statParts.filter((p) => p.value === "per1000"))}.`);
  if (want.size > 1) return decline(statParts, "I can show counts or rates in one answer, not both. Ask for one of them.");
  void clearanceParts;
  return { stat: want.size ? [...want][0] : "count" };
}

function placeList(parts: Part[]): PlaceRef[] | TypeDecision {
  const out: PlaceRef[] = [];
  const seen = new Set<string>();
  for (const p of parts) {
    const ref = placeFromValue(p.value ?? "");
    if (ref === "ambiguous") return { kind: "clarify", explanation: `"${p.text.trim()}" could mean more than one place. Please name the state (for example "${p.text.trim()}, Texas") or say city or county.` };
    if (!ref) return decline([p], `I couldn't place "${p.text.trim()}" in the Historical agency list, so I haven't answered with a number that leaves it out.`);
    if (seen.has(placeKey(ref))) continue;
    seen.add(placeKey(ref));
    out.push(ref);
  }
  return out;
}

/** The single requested period (identical repeats count once); two different periods are a named conflict. */
function onePeriod(parts: Part[]): PeriodRequest | TypeDecision {
  if (parts.length === 0) return { form: "none" };
  const reqs = parts.map((p) => ({ p, r: periodFromValue(p.value ?? "") }));
  const bad = reqs.filter((x) => !x.r);
  if (bad.length) return decline(bad.map((x) => x.p), `I can't read ${quoteAll(bad.map((x) => x.p))} as a period here.`);
  const keys = new Set(reqs.map((x) => periodKey(x.r!)));
  if (keys.size > 1) return decline(parts, `This question names more than one period (${quoteAll(parts)}); ask for one period, or use "change from <year> to <year>" to compare two years.`);
  return reqs[0].r!;
}

function isDecision(x: unknown): x is TypeDecision {
  return Boolean(x && typeof x === "object" && "kind" in (x as Record<string, unknown>) && ["decline", "clarify", "none", "spec"].includes((x as { kind: string }).kind));
}

/** Measures of one family, deduplicated by value (identical repeats count once). */
function familyAndMeasures(s: Slots): { family: Family; measures: Measure[] } | TypeDecision {
  const crime = s.measures.map((p) => p.value ?? "");
  const staff = s.staffing.map((p) => p.value ?? "");
  const unspecified = s.measures.filter((p) => p.value === "unspecified");
  if (staff.length && (crime.filter((v) => v !== "unspecified").length || s.clearance.length)) {
    return decline([...s.staffing, ...s.measures, ...s.clearance], "Staffing and crime figures can't be combined in one answer; ask for them separately.");
  }
  if (staff.length) return { family: "staffing", measures: [...new Set(staff)] as Measure[] };
  const family: Family = s.clearance.length ? "clearance" : "crime";
  if (unspecified.length) {
    return { kind: "clarify", explanation: family === "clearance"
      ? "Which offense's clearance rate do you want: violent crime, property crime, or a specific offense such as murder or burglary?"
      : "Which crime do you want: violent crime, property crime, total crime (both), or a specific offense such as murder or burglary?" };
  }
  const measures = [...new Set(crime)] as Measure[];
  if (measures.length === 0) {
    if (family === "clearance") return { kind: "clarify", explanation: "Which offense's clearance rate do you want: violent crime, property crime, or a specific offense such as murder or burglary?" };
    return { kind: "none" };
  }
  if (family === "clearance" && measures.includes("total")) {
    return decline(s.measures.filter((p) => p.value === "total"), "Clearance figures exist for violent and property crime and the eight offenses, not a total of all crime.");
  }
  if (measures.some((m) => !CRIME.has(m))) return decline(s.measures, "I couldn't read that offense.");
  return { family, measures };
}

/**
 * Match a finalized Historical ledger to one supported type. Recognition refusals are the route's job (they run first);
 * this sees only recognized and context parts.
 */
export function matchHistoricalType(ledger: RequestLedger, ctx: TypeContext): TypeDecision {
  const now = ctx.now ?? new Date();
  const s = slots(ledger);
  const explainLimitation = s.explain.length ? "I can show the numbers, not explain causes or reasons, so the \"why\" part isn't answered here." : null;
  if (s.operations.length) return cannotUse(s.operations, s);
  if (s.other.length) return cannotUse(s.other);

  const fm = familyAndMeasures(s);
  if (isDecision(fm)) return fm;
  const { family, measures } = fm;

  const st = statisticFor(family, s.statistic, s.clearance);
  if (isDecision(st)) return st;
  const statistic = st.stat;

  const places = placeList(s.places);
  if (isDecision(places)) return places;

  const withLimit = (d: TypeDecision): TypeDecision => (d.kind === "spec" ? { ...d, explainLimitation } : d);

  // ---------------- H6: change between two years ("change", or "2023 vs 2019": a comparison word between two years)
  const yearVersus = s.versus.some((v) => {
    const left = [...s.parts].filter((p) => p.span[1] <= v.span[0]).sort((a, b) => b.span[1] - a.span[1])[0];
    const right = [...s.parts].filter((p) => p.span[0] >= v.span[1]).sort((a, b) => a.span[0] - b.span[0])[0];
    return left?.concept === "period" && right?.concept === "period";
  });
  if (s.change.length || yearVersus) {
    if (s.rank.length || s.list.length || s.entity.length || s.threshold.length) {
      return decline([...s.change, ...s.rank, ...s.list, ...s.entity, ...s.threshold], "I can compare two years for named places, but I can't rank or list places by change here.");
    }
    if (family === "clearance") return decline([...s.change, ...s.clearance], "I can't compute a change in clearance percentages in this version; ask for the clearance rate by year instead.");
    if (measures.length !== 1) return decline(s.measures.length ? s.measures : s.staffing, "A change compares one measure at a time; ask for each measure separately.");
    if (family === "staffing" && statistic !== "count") return decline(s.statistic, "I can compare staffing counts between two years, not per-resident staffing.");
    if (statistic !== "count" && statistic !== "rate_per_100k") return decline(s.statistic, "A change compares counts or rates per 100,000.");
    if (places.length < 1 || places.length > 10) return places.length < 1
      ? { kind: "clarify", explanation: "Which place do you want the change for: the U.S., a state, or a city or county agency?" }
      : decline(s.places, "I can compare up to 10 named places at a time.");
    if (s.combine.length || s.grain.length) return decline([...s.combine, ...s.grain], "A change compares two single years; it isn't a total or a series.");
    const ends = changeEndpoints(s);
    if (isDecision(ends)) return ends;
    const spec: ChangeSpec = { type: "H6", family, measure: measures[0], base: statistic === "rate_per_100k" ? "rate_per_100k" : "count", places, earlier: ends.earlier, later: ends.later };
    return withLimit(gate(ledger, spec, s, ctx, now));
  }

  // ---------------- H4 / H5: lists and rankings
  const listEntity = s.list.map((p) => (p.value ?? "").replace(/^list:/, ""));
  const entityKinds = [...new Set([...s.entity.map((p) => p.value ?? ""), ...listEntity])];
  if (s.rank.length || s.list.length || s.entity.length) {
    if (entityKinds.length !== 1) {
      if (entityKinds.length === 0) return { kind: "clarify", explanation: "What should be ranked: states, cities, counties or agencies?" };
      return decline([...s.entity, ...s.list], `This question names more than one kind of place to rank (${quoteAll([...s.entity, ...s.list])}).`);
    }
    const entity = entityKinds[0] as RankSpec["entity"];
    if (measures.length !== 1) return decline(s.measures.length ? s.measures : s.staffing, "A ranking or list uses one measure; ask for each measure separately.");
    const period = onePeriod(s.periods);
    if (isDecision(period)) return period;
    // H5: all states by year
    if (entity === "state" && !s.rank.length && (s.grain.length || (s.list.some((p) => /year/i.test(p.text))) || (period.form !== "year" && period.form !== "none" && period.form !== "lastyear" && period.form !== "latest"))) {
      if (family !== "crime") return decline([...s.list, ...s.clearance, ...s.staffing], family === "clearance" ? "Historical has no state clearance figures." : "Historical doesn't total police staffing by state.");
      if (places.length) return decline(s.places, "\"By state\" lists every state; it can't be limited to named places here.");
      const spec: SeriesSpec = { type: "H5", family, measures, statistic, places: [], period, total: false };
      return withLimit(gate(ledger, spec, s, ctx, now));
    }
    if (!(period.form === "year" || period.form === "lastyear" || period.form === "latest" || period.form === "none")) {
      return decline(s.periods, "A ranking or list covers one year only; name a single year.");
    }
    let scope: PlaceRef = { kind: "national", label: "United States" };
    if (places.length > 1) return decline(s.places, "Rankings here are of every state, city, county or agency in one scope (the U.S. or one state), not of a list of places.");
    if (places.length === 1) {
      if (places[0].kind === "agency") return decline(s.places, "Rankings here are of every state, city, county or agency in one scope (the U.S. or one state), not within a city.");
      scope = places[0];
    }
    if (entity === "state" && scope.kind !== "national") return decline(s.places, "A state ranking covers the whole country.");
    if (family === "clearance" && s.rank.length) return decline([...s.rank, ...s.clearance], "I don't rank places by clearance rate: only percentages are stored, so an agency that cleared 1 of 1 cases would lead. I can list clearance rates for the agencies in a state.");
    if (family === "clearance" && entity === "state") return decline(s.clearance, "Historical has no state clearance figures.");
    if (family === "staffing" && entity === "state") return decline(s.staffing, "Historical doesn't total police staffing by state.");
    // rank
    let rank: RankSpec["rank"] = null;
    if (s.rank.length) {
      const dirs = new Set(s.rank.map((p) => (p.value ?? "").split(":")[0]).filter((d) => d === "top" || d === "bottom"));
      if (dirs.size > 1) return decline(s.rank, `This question asks for both the highest and the lowest (${quoteAll(s.rank)}); ask for one.`);
      const tokens = [...new Set(s.rank.map((p) => (p.value ?? "").split(":")[1]).filter((t) => t))];
      if (tokens.length > 1) return decline(s.rank, `This question asks for two different numbers of places (${quoteAll(s.rank.filter((p) => (p.value ?? "").split(":")[1]))}); ask for one.`);
      const dir = (dirs.size ? [...dirs][0] : "top") as "top" | "bottom";
      let n: number;
      let stated = false;
      if (tokens.length === 1) {
        const exact = exactCount(tokens[0]);
        if (exact === null) return decline(s.rank, `I can't use the number "${tokens[0]}" here; it's larger than I can count exactly.`);
        if (exact < 1) return decline(s.rank, "Ask for at least one place.");
        if (exact > RANK_MAX) return decline(s.rank, `I can rank up to ${RANK_MAX} places; you asked for ${tokens[0]}.`);
        n = exact; stated = true;
      } else {
        const singular = s.entity.some((p) => /\b(?:city|state|county|agency|department|town)\b/i.test(p.text) && !/(?:cities|states|counties|agencies|departments|towns)/i.test(p.text));
        n = singular ? 1 : RANK_DEFAULT;
      }
      rank = { dir, n, stated };
    } else if (scope.kind === "national" && entity !== "state") {
      return decline(s.list.length ? s.list : s.entity, "A list of every city, county or agency in the country is too long to show; name a state, or ask for the top N.");
    }
    // minimum population
    let min: RankSpec["min"] = null;
    if (s.threshold.length) {
      if (entity === "state") return decline(s.threshold, "A minimum population applies to cities, counties or agencies, not to states.");
      const maxes = s.threshold.filter((p) => (p.value ?? "").startsWith("max|"));
      if (maxes.length) return decline(maxes, `I can apply a minimum population, not a maximum (${quoteAll(maxes)}).`);
      const keys = [...new Set(s.threshold.map((p) => p.value ?? ""))];
      if (keys.length > 1) return decline(s.threshold, `This question gives more than one population limit (${quoteAll(s.threshold)}); give one.`);
      const [op, token] = keys[0].split("|");
      const amount = exactCount(token);
      if (amount === null) return decline(s.threshold, `I can't use the number "${token}" here; it's larger than I can count exactly.`);
      min = { op: op === ">" ? ">" : ">=", amount, token };
    }
    const perResident = (family === "crime" && statistic === "rate_per_100k") || (family === "staffing" && statistic !== "count");
    // r2 §3: the minimum-population question is for RANKINGS; a per-resident LIST is answered alphabetically instead.
    if (perResident && entity !== "state" && !min && rank) {
      return { kind: "clarify", explanation: `What minimum population should I use for this ranking? Without one, places with a few hundred residents lead any per-resident ranking. For example: "with at least 100,000 people".` };
    }
    if (s.combine.length || s.grain.length) return decline([...s.combine, ...s.grain], "A ranking or list covers one year; it isn't a total or a series.");
    const spec: RankSpec = { type: "H4", family, measure: measures[0], statistic, entity, scope, period, rank, min };
    return withLimit(gate(ledger, spec, s, ctx, now));
  }

  // ---------------- H1 / H2 / H3: series
  if (places.length === 0) return { kind: "clarify", explanation: "Which place do you want: the U.S., a state, or a city or county agency?" };
  if (places.length > 10) return decline(s.places, "I can compare up to 10 named places at a time.");
  if (measures.length > 1 && places.length > 1) return decline([...s.measures, ...s.places], "I can show one measure for several places, or several measures for one place, but not both at once.");
  if (measures.length > 10) return decline(s.measures, "I can show up to 10 measures at a time.");
  const period = onePeriod(s.periods);
  if (isDecision(period)) return period;
  let total = false;
  if (s.combine.length) {
    if (places.length > 1) return decline(s.combine, `I show each place separately, so I can't add places together (${quoteAll(s.combine)}).`);
    if (statistic !== "count") return decline(s.combine, "Only counts can be totaled over a period; rates and percentages can't.");
    total = period.form !== "year";
  }
  // Several measures with a rate word: the rate must cover every measure -- each measure followed by its own rate word
  // ("murder rate and robbery rate"), or one plural rate word after the whole list ("murder and robbery rates").
  // "murders and the robbery rate" mixes a count and a rate and is declined (one statistic per answer).
  if (measures.length > 1 && statistic !== "count") {
    const q = ledger.question;
    const rateParts = s.statistic.filter((p) => p.value !== "count");
    const measureParts = [...s.measures, ...s.staffing].sort((a, b) => a.span[0] - b.span[0]);
    const eachHasOwn = measureParts.every((m) => rateParts.some((r) => r.span[0] >= m.span[1] && /^\s*$/.test(q.slice(m.span[1], r.span[0]))));
    const last = measureParts[measureParts.length - 1];
    const sharedPlural = rateParts.length === 1 && /s$/i.test(rateParts[0].text) && rateParts[0].span[0] >= last.span[1] && /^\s*$/.test(q.slice(last.span[1], rateParts[0].span[0]))
      && measureParts.slice(1).every((m, i) => /^[\s,]*(?:and|&)?[\s,]*$/i.test(q.slice(measureParts[i].span[1], m.span[0])));
    if (!eachHasOwn && !sharedPlural && family !== "clearance") return decline([...rateParts, ...measureParts], "I can show counts or rates in one answer, not both, and I can't tell which of these measures the rate is for. Ask for the rates of each measure (for example \"murder rate and robbery rate\") or for counts.");
  }
  const type = measures.length > 1 ? "H3" : places.length > 1 ? "H2" : "H1";
  if (total && type !== "H1") return decline(s.combine, "A period total is for one measure in one place.");
  const spec: SeriesSpec = { type, family, measures, statistic, places, period, total };
  return withLimit(gate(ledger, spec, s, ctx, now));
}

function changeEndpoints(s: Slots): { earlier: number; later: number | "anchor" } | TypeDecision {
  const reqs = s.periods.map((p) => ({ p, v: p.value ?? "" }));
  const ranges = reqs.filter((x) => /^(?:range|between):/.test(x.v));
  const years = reqs.filter((x) => /^year:/.test(x.v));
  const since = reqs.filter((x) => /^since:/.test(x.v));
  const others = reqs.filter((x) => !/^(?:range|between|year|since):/.test(x.v));
  if (others.length) return decline(others.map((x) => x.p), "A change compares two single years; name them (for example \"from 2019 to 2023\").");
  if (ranges.length === 1 && years.length === 0 && since.length === 0) {
    const [form, a, b] = ranges[0].v.split(":");
    const A = Number(a), B = Number(b);
    if (form === "range" && A > B) return decline([ranges[0].p], `The comparison ${A} to ${B} ends before it starts; ask "from ${B} to ${A}".`);
    if (A === B) return decline([ranges[0].p], "A change needs two different years.");
    return { earlier: Math.min(A, B), later: Math.max(A, B) };
  }
  if (years.length === 2 && ranges.length === 0 && since.length === 0) {
    const A = Number(years[0].v.split(":")[1]), B = Number(years[1].v.split(":")[1]);
    if (A === B) return decline(years.map((x) => x.p), "A change needs two different years.");
    return { earlier: Math.min(A, B), later: Math.max(A, B) };
  }
  if (since.length === 1 && ranges.length === 0 && years.length === 0) return { earlier: Number(since[0].v.split(":")[1]), later: "anchor" };
  if (reqs.length === 0) return { kind: "clarify", explanation: "Which two years should I compare (for example \"from 2019 to 2023\")?" };
  return decline(reqs.map((x) => x.p), "A change compares two single years, not ranges; name two years (for example \"from 2019 to 2023\").");
}

/* ------------------------------------------------------------------------------------------- the final gate ---- */

/** Is this part's VALUE in the spec? (consumption by value, stage 1 lessons 2 and 4) */
export function consumedBy(spec: HistoricalSpec, part: Part, s?: Slots): boolean {
  const v = part.value ?? "";
  const measures: string[] = spec.type === "H4" || spec.type === "H6" ? [spec.measure] : spec.measures;
  const stat: Statistic = spec.type === "H6" ? spec.base : spec.statistic;
  const places: PlaceRef[] = spec.type === "H4" ? (spec.scope.kind === "national" ? [] : [spec.scope]) : spec.places;
  switch (part.concept) {
    case "measure": return spec.family !== "staffing" && measures.includes(v);
    case "staffing": return spec.family === "staffing" && measures.includes(v);
    case "clearance": return spec.family === "clearance";
    case "statistic": {
      if (v === "count") return stat === "count";
      if (spec.family === "crime") return stat === "rate_per_100k" && (v === "rate" || v === "percapita" || v === "per100k");
      if (spec.family === "clearance") return stat === "percent_cleared" && v === "rate";
      return (stat === "per_1000" && (v === "rate" || v === "percapita" || v === "per1000")) || (stat === "per_100k" && v === "per100k");
    }
    case "place": {
      if (v === "national") return spec.type === "H4" ? spec.scope.kind === "national" : places.some((p) => p.kind === "national");
      const ref = placeFromValue(v);
      return Boolean(ref && ref !== "ambiguous" && places.some((p) => placeKey(p) === placeKey(ref)));
    }
    case "period": {
      if (spec.type === "H6") {
        const [form, a, b] = v.split(":");
        if (form === "since") return spec.later === "anchor" && Number(a) === spec.earlier;
        if (form === "year") return Number(a) === spec.earlier || Number(a) === spec.later;
        if (form === "range" || form === "between") return Math.min(Number(a), Number(b)) === spec.earlier && Math.max(Number(a), Number(b)) === spec.later;
        return false;
      }
      const req = periodFromValue(v);
      return Boolean(req && periodKey(req) === periodKey(spec.period));
    }
    case "rank": {
      if (spec.type !== "H4" || !spec.rank) return false;
      const [dir, token] = v.split(":");
      if ((dir === "top" || dir === "bottom") && dir !== spec.rank.dir) return false;
      if (token) return spec.rank.stated && exactCount(token) === spec.rank.n;
      return true;
    }
    case "threshold": {
      if (spec.type !== "H4" || !spec.min) return false;
      const [op, token] = v.split("|");
      return (op === ">" ? ">" : op === ">=" ? ">=" : "max") === spec.min.op && exactCount(token) === spec.min.amount;
    }
    case "entity": return spec.type === "H4" ? spec.entity === v : spec.type === "H5" ? v === "state" : false;
    case "list": {
      const e = v.replace(/^list:/, "");
      return (spec.type === "H4" && spec.entity === e) || (spec.type === "H5" && e === "state");
    }
    case "grain": return spec.type === "H1" ? !spec.total : spec.type === "H2" || spec.type === "H3" || spec.type === "H5";
    case "change": return spec.type === "H6";
    case "versus": {
      // r2 §1: a comparison word is consumed only where it stands between two places (H2, H6) or two years (H6).
      const between = s ? versusBetween(s.parts, part) : "other";
      if (spec.type === "H6") return between === "places" || between === "years";
      return spec.type === "H2" && between === "places";
    }
    case "combine": return spec.type === "H1" && (spec.total || spec.period.form === "year") && spec.statistic === "count";
    default: return false;
  }
}

/** What a comparison word stands between, by the parts on either side of it. */
function versusBetween(parts: Part[], v: Part): "places" | "years" | "other" {
  const left = parts.filter((p) => p.span[1] <= v.span[0]).sort((x, y) => y.span[1] - x.span[1])[0];
  const right = parts.filter((p) => p.span[0] >= v.span[1]).sort((x, y) => x.span[0] - y.span[0])[0];
  if (left?.concept === "place" && right?.concept === "place") return "places";
  if (left?.concept === "period" && right?.concept === "period") return "years";
  return "other";
}

/** Every non-context part of clause 0 must be consumed by value; otherwise the request is declined naming them. */
function gate(ledger: RequestLedger, spec: HistoricalSpec, s: Slots, ctx: TypeContext, now: Date): TypeDecision {
  const invalid = validateSpec(spec);
  if (invalid) return decline([], invalid);
  const unanswerable = preflight(spec, ctx, now);
  if (unanswerable) return decline(s.periods.length ? s.periods : [], unanswerable);
  const unconsumed = s.parts.filter((p) => p.clause === 0 && !consumedBy(spec, p, s));
  if (unconsumed.length) {
    return decline(unconsumed, refusalSentences(unconsumed.map((p) => ({ ...p, explanation: p.explanation ?? `I can't apply "${p.text.trim()}" to this answer, so I haven't answered with a number that leaves it out.` }))).join(" "));
  }
  void ledger;
  return { kind: "spec", spec, explainLimitation: null };
}

/**
 * Before a spec is issued: every series has a source, and the period resolves to at least one year that source holds
 * (lesson 5: an explicit or open period that is empty is declined by name, never defaulted). In a request naming several
 * places, one place's empty period is reported in the answer instead (the compiler states it); all empty is a decline.
 */
function preflight(spec: HistoricalSpec, ctx: TypeContext, now: Date): string | null {
  const latest = (src: SourceId) => { const b = ctx.bounds(src); return b ? ` The latest year in this source is ${b.max}.` : ""; };
  const check = (places: PlaceRef[], period: PeriodRequest): string | null => {
    const reasons: string[] = [];
    for (const place of places) {
      const src = sourceFor(spec.family, place, (spec.type === "H4" || spec.type === "H6") ? spec.measure : spec.measures[0]);
      if (!["agency_crime", "state_national", "agency_clearance", "national_clearance", "staffing"].includes(src)) return src;
      const sid = src as SourceId;
      const b = ctx.bounds(sid);
      const r = resolveYears(period, b, now);
      if (r.kind === "decline") { reasons.push(`${place.label}: ${r.reason}`); continue; }
      if (r.explicit && b && r.years.every((y) => y < b.min || y > b.max)) reasons.push(`${place.label}: this source covers ${b.min}-${b.max}, so there is nothing for ${r.years.length === 1 ? r.years[0] : `${r.years[0]}-${r.years[r.years.length - 1]}`}.${latest(sid)}`);
    }
    return reasons.length === places.length && reasons.length > 0 ? `I can't answer this: ${reasons.join(" ")}` : null;
  };
  if (spec.type === "H6") {
    for (const place of spec.places) { const src = sourceFor(spec.family, place, spec.measure); if (!["agency_crime", "state_national", "agency_clearance", "national_clearance", "staffing"].includes(src)) return src; }
    return null;
  }
  if (spec.type === "H4") {
    const src: SourceId = spec.entity === "state" ? "state_national" : spec.family === "clearance" ? "agency_clearance" : spec.family === "staffing" ? "staffing" : "agency_crime";
    const b = ctx.bounds(src);
    const r = resolveYears(spec.period.form === "none" ? { form: "latest" } : spec.period, b, now);
    if (r.kind === "decline") return `I can't build this ranking: ${r.reason}`;
    if (b && (r.years[0] < b.min || r.years[0] > b.max)) return `I can't build this ranking for ${r.years[0]}: this source covers ${b.min}-${b.max}.${latest(src)}`;
    return null;
  }
  if (spec.type === "H5") return check([{ kind: "state", name: "Texas", label: "The state figures" }], spec.period);
  return check(spec.places, spec.period);
}

/** Each type's required fields; a spec that fails is a named decline, never compiled (lesson 7). */
export function validateSpec(spec: HistoricalSpec): string | null {
  const bad = "I can't answer that combination yet.";
  switch (spec.type) {
    case "H1": return spec.places.length === 1 && spec.measures.length === 1 ? null : bad;
    case "H2": return spec.places.length >= 2 && spec.measures.length === 1 && !spec.total ? null : bad;
    case "H3": return spec.places.length === 1 && spec.measures.length >= 2 && !spec.total ? null : bad;
    case "H5": return spec.places.length === 0 && spec.measures.length === 1 && spec.family === "crime" ? null : bad;
    case "H4": return spec.measure && (spec.scope.kind === "national" || spec.scope.kind === "state") ? null : bad;
    case "H6": return spec.places.length >= 1 && (spec.later === "anchor" || spec.later > spec.earlier) ? null : bad;
  }
}

export function isStaffingMeasure(m: string): m is StaffingMeasure { return STAFF.has(m); }
