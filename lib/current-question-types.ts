/**
 * Stage 3a (Current Trends): the CLOSED list of supported question types (plan docs/superpowers/plans/2026-10-10-
 * request-accounting-stage3a-current.md r1.2; owner list docs/superpowers/2026-10-10-stage3-current-trends-question-
 * types-draft.md, approved by Jeff).
 *
 *   C1 one place, one measure, over time       C4 city rankings (the existing city-ranking path, bound by value)
 *   C2 named places side by side                C5 change between two periods
 *   C3 several measures for one place           C6 a city and the cities in its FBI population group
 *      ("overview" = all seven; "most common crime" = C3 sorted)
 *
 * The matcher reads the ledger's parts into ONE spec, or returns a named decline or clarification. It never drops or
 * swaps a part: each part is CONSUMED by a slot by value, and any non-context part of clause 0 left unconsumed declines
 * the whole request, naming it. A spec is validated before it is returned.
 */
import type { Part, RequestLedger } from "./request-accounting";
import { refusalSentences } from "./request-accounting";

/* ------------------------------------------------------------------ vocabulary ---------------------------------- */

export const OFFENSES_OF: Record<string, string[]> = {
  murder: ["Murder"], rape: ["Rape"], robbery: ["Robbery"], aggravated_assault: ["Aggravated Assault"], burglary: ["Burglary"],
  theft: ["Theft"], motor_vehicle_theft: ["Motor Vehicle Theft"],
  violent_crime: ["Murder", "Rape", "Robbery", "Aggravated Assault"], property_crime: ["Burglary", "Theft", "Motor Vehicle Theft"],
};
export const ALL7 = ["murder", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft"];
export const MEASURE_LABEL: Record<string, string> = {
  murder: "murder", rape: "rape", robbery: "robbery", aggravated_assault: "aggravated assault", burglary: "burglary", theft: "theft",
  motor_vehicle_theft: "motor vehicle theft", violent_crime: "violent crime", property_crime: "property crime",
};

/* ------------------------------------------------------------------ the spec ------------------------------------ */

export type CPlace =
  | { kind: "national" }
  | { kind: "state"; name: string; code: string }
  | { kind: "agency"; agencyKind: "city" | "county"; name: string; state: string; text: string };

export type CPeriod =
  | { form: "year"; year: number }
  | { form: "range"; from: number; to: number }
  | { form: "month"; year: number; month: number }
  | { form: "monthrange"; from: [number, number]; to: [number, number] }
  | { form: "since"; from: number }
  | { form: "last"; n: number }
  | { form: "lastyear" }
  | { form: "latest" }
  | { form: "latestmonth" }
  | { form: "ytd" }
  | { form: "none" };

export type Grain = "total" | "month" | "year" | "rolling";
export type Statistic = "count" | "rate";

export type SeriesSpec = { type: "series"; measures: string[]; statistic: Statistic; places: CPlace[]; period: CPeriod; grain: Grain; sort: boolean; overview: boolean; uiNotes: string[] };
/** r2 F3: one or more places (C2), two or more periods in order; each adjacent pair is a change. */
export type ChangeSpec = { type: "change"; measure: string; statistic: Statistic; places: CPlace[]; periods: CPeriod[]; uiNotes: string[] };
export type PeerSpec = { type: "peers"; target: Extract<CPlace, { kind: "agency" }>; n: number | null; measure: string; statistic: Statistic; period: CPeriod; grain: "total" | "month" | "year"; uiNotes: string[] };
export type CurrentSpec = SeriesSpec | ChangeSpec | PeerSpec;

export type CurrentTypeDecision =
  | { kind: "spec"; spec: CurrentSpec; explainLimitation: string | null }
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

function placeOf(p: Part): CPlace | null {
  const v = p.value ?? "";
  if (v === "national") return { kind: "national" };
  if (v.startsWith("state:")) { const name = v.slice(6); const code = STATE_CODE[name]; return code ? { kind: "state", name, code } : null; }
  const m = /^(city|county):(.+):([A-Z]{2})?$/.exec(v);
  if (m) return { kind: "agency", agencyKind: m[1] as "city" | "county", name: m[2], state: m[3] ?? "", text: p.text };
  return null;
}

function periodOf(p: Part): CPeriod | null {
  const v = p.value ?? "";
  let m: RegExpExecArray | null;
  if ((m = /^year:(\d{4})$/.exec(v))) return { form: "year", year: Number(m[1]) };
  if ((m = /^(?:range|between):(\d{4}):(\d{4})$/.exec(v))) { const a = Number(m[1]); const b = Number(m[2]); return { form: "range", from: Math.min(a, b), to: Math.max(a, b) }; }
  if ((m = /^month:(\d{4})-(\d{2})$/.exec(v))) return { form: "month", year: Number(m[1]), month: Number(m[2]) };
  if ((m = /^monthrange:(\d{4})-(\d{2}):(\d{4})-(\d{2})$/.exec(v))) return { form: "monthrange", from: [Number(m[1]), Number(m[2])], to: [Number(m[3]), Number(m[4])] };
  if ((m = /^since:(\d{4})$/.exec(v))) return { form: "since", from: Number(m[1]) };
  if ((m = /^last:(\d+)$/.exec(v))) return { form: "last", n: Number(m[1]) };
  if (v === "lastyear") return { form: "lastyear" };
  if (v === "latest") return { form: "latest" };
  if (v === "latestmonth") return { form: "latestmonth" };
  if (v === "ytd") return { form: "ytd" };
  return null;
}

const cannot = (p: Part, why: string) => `I can't apply "${p.text.trim()}": ${why} I haven't answered with a number that leaves it out.`;

export const NO_SAMPLE_RATE = "Current Trends uses a sample of agencies, so it has no national or state rate; the Historical tab has FBI rates for the U.S. and every state.";
export const NO_STATE_RANKING = "Current Trends uses a sample of agencies in each state, so it doesn't rank states; the Historical tab has FBI figures for every state.";

/* ------------------------------------------------------------------ the matcher --------------------------------- */

/**
 * Read clause 0 of the ledger into one spec. `consumed` collects every part a slot used; any meaningful part left over
 * declines the request naming it. Clause 1 holds an explanation request beside an explicit numeric ask (L7).
 */
export function matchCurrentType(ledger: RequestLedger): CurrentTypeDecision {
  const parts = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const explain = ledger.parts.some((p) => p.clause === 1 && p.concept === "explain");
  const consumed = new Set<Part>();
  const take = (ps: Part[]) => { for (const p of ps) consumed.add(p); return ps; };
  const of = (c: string) => parts.filter((p) => p.concept === c);
  // A turn that also asks "why" is told, in the same decline, that causes aren't explained (decision 12).
  const WHY = "I also can't explain why the figures are what they are: Current Trends records reported offenses, not their causes.";
  const declineParts = (ps: Part[], why: (p: Part) => string): CurrentTypeDecision => ({ kind: "decline", parts: ps, explanation: [...ps.map(why), ...(explain ? [WHY] : [])].join(" ") });
  const uiNotes: string[] = [];

  const ops = parts.filter((p) => ["coverage-lookup", "completeness", "explain"].includes(p.concept));
  if (ops.length) return declineParts(ops, (p) => cannot(p, p.concept === "explain" ? "I report what Current Trends records; I can't explain causes." : "that is answered only by its own fixed path, which couldn't answer this request."));

  // ---- measures ----
  const measureParts = take(of("measure"));
  const named = measureParts.map((p) => p.value!).filter((v) => v !== "unspecified");
  const overview = take(of("overview")).length > 0;
  const sort = take(of("sort")).length > 0;
  let measures = named.flatMap((v) => (v === "all7" ? ALL7 : [v]));
  if (!measures.length && (overview || sort)) measures = [...ALL7];
  if (measureParts.some((p) => p.value === "rape") && /\bsexual\s+assaults?\b/i.test(ledger.question)) {
    uiNotes.push("This uses the FBI's UCR category \"Rape\" (which includes forcible rape, sodomy and sexual assault with an object), not every legal definition of sexual assault.");
  }

  // ---- places, periods, statistic ----
  const placeParts = take(of("place"));
  const places = placeParts.map(placeOf);
  if (places.some((p) => p === null)) return declineParts(placeParts.filter((p) => placeOf(p) === null), (p) => cannot(p, "I couldn't resolve that place to one Current Trends agency, a state or the nation."));
  const periodParts = take(of("period"));
  const periods = periodParts.map(periodOf);
  if (periods.some((p) => p === null)) return declineParts(periodParts, (p) => cannot(p, "I couldn't read that as a period."));
  const statParts = take(of("statistic"));
  const scaled = statParts.filter((p) => /^scale:/.test(p.value ?? ""));
  if (scaled.length) return declineParts(scaled, (p) => cannot(p, "rates are given per 100,000 residents."));
  const stats = new Set(statParts.map((p) => (p.value === "count" ? "count" : "rate")));
  if (stats.size > 1) return declineParts(statParts, (p) => cannot(p, "I give one statistic per answer: a count or a rate per 100,000."));
  const statistic: Statistic = stats.has("rate") ? "rate" : "count";
  const rolling = take(of("rolling")).length > 0;
  const grainParts = take(of("grain"));
  const grains = grainParts.map((p) => p.value);
  const combineParts = take(of("combine"));
  const changeParts = of("change");
  const versusParts = of("versus");
  const rankParts = of("rank");
  const thresholdParts = of("threshold");
  const entityParts = of("entity");
  const listParts = of("list");
  const peerParts = of("peer");

  // ---- rankings belong to the city-ranking path (C4); a state ranking is declined with the Historical pointer ----
  if (!peerParts.length && (rankParts.length || thresholdParts.length || listParts.length || (entityParts.length && /\b(?:which|list)\b/i.test(ledger.question)))) {
    const states = [...entityParts, ...listParts].filter((p) => /state/.test(p.value ?? ""));
    if (states.length) return declineParts(states, () => NO_STATE_RANKING);
    const rankish = [...rankParts, ...thresholdParts, ...listParts, ...entityParts];
    return declineParts(rankish.slice(0, 1), (p) => cannot(p, "city rankings come from the city ranking, which couldn't build this one; ask for one offense, a count or a rate, and one year."));
  }

  // ---- national and state rates (ruling 3) ----
  if (statistic === "rate" && places.some((p) => p && p.kind !== "agency")) return declineParts(statParts, () => NO_SAMPLE_RATE);

  // ---- C6: similar-sized cities ----
  if (peerParts.length) {
    take(peerParts); take(versusParts);
    const [kindToken, nToken] = [(peerParts[0].value ?? "").split(":")[2], (peerParts[0].value ?? "").split(":")[1]];
    const target = places[0];
    if (kindToken === "county" || (target && target.kind === "agency" && target.agencyKind === "county")) {
      return declineParts(peerParts, () => "The FBI groups counties by metropolitan status, not size, so there is no population group to match a county with. I haven't answered with a number that leaves it out.");
    }
    if (places.length !== 1 || !target || target.kind !== "agency") return declineParts(peerParts, (p) => cannot(p, "similar-sized cities are matched to one named city."));
    const n = nToken ? Number(nToken) : null;
    if (n !== null && (!Number.isSafeInteger(n) || n < 1 || n > 9)) return declineParts(peerParts, () => `I can compare a city with up to 9 similar-sized cities at a time (10 places in all), so I can't give "${peerParts[0].text.trim()}". I haven't answered with a number that leaves it out.`);
    if (measures.length !== 1) return { kind: "none" };
    if (rolling || changeParts.length || combineParts.length) return declineParts([...of("rolling"), ...changeParts, ...combineParts], (p) => cannot(p, "a comparison with similar-sized cities gives one value per city for one period."));
    const period = periods.length === 1 ? periods[0]! : periods.length === 0 ? null : undefined;
    if (period === undefined) return declineParts(periodParts.slice(1), (p) => cannot(p, "one period per answer."));
    if (period === null) return declineParts(peerParts, (p) => cannot(p, "a comparison with similar-sized cities needs a period (a year or a month)."));
    // r2 F3d: by month or by year over the whole period's selection; "trend" alone is a monthly series.
    const peerGrain = grains.includes("month") ? "month" : grains.includes("year") ? "year" : grains.includes("trend") ? "month" : "total";
    return finish({ type: "peers", target, n, measure: measures[0], statistic, period, grain: peerGrain, uiNotes });
  }

  // ---- C5: change between two periods ----
  const versusPeriods = versusParts.filter(() => periodParts.length === 2);
  if (changeParts.length || versusPeriods.length) {
    take(changeParts); take(versusPeriods);
    if (measures.length !== 1) return declineParts([...changeParts, ...versusPeriods].slice(0, 1), (p) => cannot(p, "I compare one measure at a time between periods."));
    // r2 F3b: named places, each with its own periods and changes.
    const changePlaces: CPlace[] = places.length ? (places as CPlace[]) : [{ kind: "national" }];
    // r2 F3c: two named periods, or every year of a range (each adjacent pair is a change).
    let seq: CPeriod[] | null = null;
    if (periods.length === 2) seq = [periods[0]!, periods[1]!];
    else if (periods.length === 1 && periods[0]!.form === "range") {
      const r = periods[0] as Extract<CPeriod, { form: "range" }>;
      seq = []; for (let y = r.from; y <= r.to; y += 1) seq.push({ form: "year", year: y });
      if (seq.length > 12) return declineParts(periodParts, (p) => cannot(p, "I compare up to 12 years at a time."));
    }
    if (!seq || seq.length < 2) return declineParts([...changeParts, ...versusPeriods].slice(0, 1), (p) => cannot(p, "I compare named periods (two or more years, or the same months of two years)."));
    if (rolling || combineParts.length || grains.some((g) => g !== "year" && g !== "trend")) return declineParts([...of("rolling"), ...combineParts, ...grainParts.filter((p) => p.value !== "year" && p.value !== "trend")], (p) => cannot(p, "a change compares period totals."));
    take(versusParts);
    return finish({ type: "change", measure: measures[0], statistic, places: changePlaces, periods: seq, uiNotes });
  }

  // ---- C1 / C2 / C3 series ----
  // Option 3 batch 1 (P041): rates or yearly figures were asked for, but no offense: ask which, keeping what was asked.
  if (!measures.length && (statParts.length || grainParts.length)) {
    const asked = [grains.includes("year") ? "annual" : grains.includes("month") ? "monthly" : "", statistic === "rate" ? "rates" : "counts"].filter(Boolean).join(" ");
    const when = periodParts.map((p) => p.text.trim()).join(" ");
    return { kind: "clarify", explanation: `Which offense do you want ${asked}${when ? ` ${when}` : ""} for (for example murder, violent crime or property crime), and for which place?` };
  }
  if (!measures.length) return { kind: "none" };
  const seriesPlaces = places.length ? (places as CPlace[]) : [{ kind: "national" as const }];
  if (!places.length) uiNotes.push("No place was named, so this covers the national sample of agencies.");
  if (measures.length > 1 && seriesPlaces.length > 1) return declineParts(measureParts.slice(1), (p) => cannot(p, "I give one measure for several places, or several measures for one place."));
  if (sort && seriesPlaces.length > 1) return declineParts(of("sort"), (p) => cannot(p, "the most common crime is found for one place at a time."));
  if (periods.length > 1) return declineParts(periodParts.slice(1), (p) => cannot(p, "one period per answer."));
  // "The most common crime" with no period: the latest full year, said so (a sort needs one period as a whole).
  if (sort && !periods.length) uiNotes.push("No period was named, so this uses the latest full year of data.");
  const period: CPeriod = periods[0] ?? (sort ? { form: "latest" } : { form: "none" });
  if (statistic === "rate" && combineParts.length) return declineParts(combineParts, () => "Current Trends gives one rate per year, not a single rate across several years, so I can't give a combined rate. I haven't answered with a number that leaves it out.");
  take(versusParts.filter(() => seriesPlaces.length > 1));
  const multi = ["range", "since", "last", "none"].includes(period.form);
  let grain: Grain = rolling ? "rolling" : grains.includes("month") ? "month" : grains.includes("year") ? "year" : multi && !combineParts.length ? "month" : "total";
  if (sort && grain !== "total") return declineParts(of("sort"), (p) => cannot(p, "the most common crime is found for one period as a whole."));
  if (rolling && combineParts.length) return declineParts(combineParts, (p) => cannot(p, "a rolling 12-month answer gives one total per month."));
  if (grain === "total" && multi && combineParts.length === 0) grain = "month";
  return finish({ type: "series", measures, statistic, places: seriesPlaces, period, grain, sort, overview, uiNotes });

  function finish(spec: CurrentSpec): CurrentTypeDecision {
    const left = parts.filter((p) => !consumed.has(p) && p.concept !== "explain"
      && !(p.concept === "measure" && p.value === "unspecified" && measures.length > 0)
      && !(p.concept === "entity" && (p.value === "city" || p.value === "agency" || p.value === "county"))
      && !(p.concept === "grain" && p.value === "trend"));
    if (left.length) return { kind: "decline", parts: left, explanation: refusalSentences(left.map((p) => ({ ...p, explanation: p.explanation ?? cannot(p, cannotReason(p)) }))).join(" ") };
    const invalid = validateSpec(spec);
    if (invalid) return { kind: "decline", parts: [], explanation: invalid };
    const limits = [explain ? "I can't explain why the figures are what they are: Current Trends records reported offenses, not their causes." : null].filter(Boolean);
    return { kind: "spec", spec, explainLimitation: limits.length ? limits.join(" ") : null };
  }
}

function cannotReason(p: Part): string {
  switch (p.concept) {
    case "list": return "this answer type doesn't list every place.";
    case "versus": return "comparisons are answered as named places side by side, or as two named periods.";
    case "grain": return "that time grain isn't available for this answer.";
    case "change": return "I compare one measure for one place between two named periods.";
    default: return "I couldn't use it in a supported question type.";
  }
}

export function validateSpec(spec: CurrentSpec): string | null {
  if (spec.type === "change" && spec.places.length > 10) return "I can compare up to ten places at a time. I haven't answered with a number that leaves any of them out.";
  if (spec.type === "series" && spec.places.length > 10) return "I can compare up to ten places at a time. I haven't answered with a number that leaves any of them out.";
  return null;
}
