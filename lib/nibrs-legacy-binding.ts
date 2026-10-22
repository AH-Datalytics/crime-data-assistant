/**
 * Stage 2b (NIBRS), plan §5 and lessons L1-L3: a FIXED path owns a NIBRS request only when every non-context part of the
 * request's ledger is a value that path actually used to build its statement. Each builder records `applied` from its OWN
 * variables (the contract, the resolved places and the year scope it interpolated -- task 0 fixed-paths.md), never by
 * re-reading the request. A path that does not apply every part does not answer; the request goes to the supported
 * types (N1-N7). Binding applies to every request, TEXT or NUMERIC (L1), and no fixed path applies "why" except the
 * ranking-explanation follow-up (r1.1 R1).
 */
import type { Part, RequestLedger } from "./request-accounting";
import type { QueryContract, QueryContractGeography } from "./query-contract";
import { relativeYearRangeForQuestion } from "./time-conventions";
import { MEASURE_CODES } from "./nibrs-question-types";

/**
 * The places a statement read, as DATA (not a matcher function), so a plan compiles deterministically, compares equal and
 * can be written into evidence: the nation, states by name, agencies by name and state.
 */
export type PlaceSet = { national?: true; states?: string[]; agencies?: { name: string; state: string }[] };

export const placeIs = {
  national: { national: true } as PlaceSet,
  state: (name: string): PlaceSet => ({ states: [name] }),
  agency: (name: string, state: string): PlaceSet => ({ agencies: [{ name, state }] }),
  any: (...sets: PlaceSet[]): PlaceSet => ({
    ...(sets.some((s) => s.national) ? { national: true as const } : {}),
    states: sets.flatMap((s) => s.states ?? []),
    agencies: sets.flatMap((s) => s.agencies ?? []),
  }),
};

const agencyName = (n: string) => n.toUpperCase().replace(/\s+CITY$/, "");
/** Whether a ledger place value (`national`, `state:<Name>`, `city|county:<Name>:<ST>`) is one of the set's places. */
export function placeMatches(set: PlaceSet, value: string): boolean {
  if (value === "national") return Boolean(set.national);
  if (value.startsWith("state:")) return (set.states ?? []).includes(value.slice(6));
  const [kind, name, st] = value.split(":");
  if (kind !== "city" && kind !== "county") return false;
  return (set.agencies ?? []).some((a) => st?.toUpperCase() === a.state.toUpperCase() && agencyName(name ?? "") === agencyName(a.name));
}

export type NibrsApplied = {
  /** completeness | coverage-lookup | peer | cohort */
  operations?: string[];
  places?: PlaceSet;
  /** The offense code groups the statement counts, one group per measure it reports. */
  codeGroups?: string[][];
  /** The statement counts every offense (no measure restriction). */
  allOffenses?: boolean;
  /** Family measures the statement restricts to (domestic_violence, hate_crime, carjacking, ...). */
  families?: string[];
  units?: string[];
  statistic?: "count" | "rate" | "share" | "clearance_rate" | "total_value" | "average_value" | null;
  /** r2.1 F1: a rolling-window sum the compiler performed (window length in months). */
  rolling?: number;
  /** r2.1 F1: a period total the compiler performed (counts summed, or a clearance rate / average pooled). */
  combine?: boolean;
  /** The path is a clearance path ("clearance rate", "clearances", "cleared" apply). */
  clearance?: boolean;
  /** The explicit period the statement used. A default period is applied as "no period part". */
  years?: { start: number; end: number } | null;
  /** Exact period values a two-year comparison applies (each of its years, or the pair as a range). */
  periodValues?: string[];
  grains?: ("year" | "month")[];
  /** `dimension:value` filter values the statement restricts on. */
  filters?: string[];
  breakdowns?: string[];
  rank?: { dir: "top" | "bottom"; n: number } | null;
  thresholds?: { op: ">=" | ">"; amount: number }[];
  change?: ("increase" | "decrease" | "neutral")[];
  versus?: "places" | "years" | "any";
  entities?: string[];
  lists?: string[];
  share?: boolean;
  peerCount?: number;
  /** ONLY the ranking-explanation follow-up (r1.1 R1). */
  explain?: boolean;
};

/** Contract codes, with the contract's range tokens ("23A-23H") expanded. */
export function expandCodes(codes: string[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    const m = /^(\d\d)([A-Z])-(\d\d)([A-Z])$/.exec(c);
    if (m && m[1] === m[3]) for (let x = m[2].charCodeAt(0); x <= m[4].charCodeAt(0); x += 1) out.push(m[1] + String.fromCharCode(x));
    else out.push(c);
  }
  return out;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size && a.every((x) => b.includes(x));

/** The year range a ledger period value names, by the same conventions the builders use; null when it names none. */
export function periodRange(value: string, now: Date): { start: number; end: number | "open" } | null {
  let m: RegExpExecArray | null;
  if ((m = /^year:(\d{4})$/.exec(value))) return { start: Number(m[1]), end: Number(m[1]) };
  if ((m = /^(?:range|between):(\d{4}):(\d{4})$/.exec(value))) { const a = Number(m[1]); const b = Number(m[2]); return { start: Math.min(a, b), end: Math.max(a, b) }; }
  if ((m = /^years:(\d{4}):(\d{4})$/.exec(value))) { const a = Number(m[1]); const b = Number(m[2]); return Math.abs(a - b) === 1 ? { start: Math.min(a, b), end: Math.max(a, b) } : null; }
  if ((m = /^since:(\d{4})$/.exec(value))) return { start: Number(m[1]), end: "open" };
  if ((m = /^last:(\d+)$/.exec(value))) { const r = relativeYearRangeForQuestion(`last ${m[1]} years`, now); return r ? { start: r.start, end: r.end } : null; }
  if (value === "lastyear") { const r = relativeYearRangeForQuestion("last 1 years", now); return r ? { start: r.end, end: r.end } : null; }
  return null;
}

/** What a comparison word stands between: two places, two years, or something else. */
function versusBetween(ledger: RequestLedger, v: Part): "places" | "years" | "other" {
  const parts = ledger.parts.filter((p) => p.state !== "context");
  const left = parts.filter((p) => p.span[1] <= v.span[0]).sort((x, y) => y.span[1] - x.span[1])[0];
  const right = parts.filter((p) => p.span[0] >= v.span[1]).sort((x, y) => x.span[0] - y.span[0])[0];
  if (left?.concept === "place" && right?.concept === "place") return "places";
  if (left?.concept === "period" && right?.concept === "period") return "years";
  return "other";
}

function applies(part: Part, a: NibrsApplied, now: Date, ledger: RequestLedger): boolean {
  const v = part.value ?? "";
  switch (part.concept) {
    case "completeness": case "coverage-lookup": case "cohort": case "meta-codes":
      return Boolean(a.operations?.includes(part.concept));
    case "peer": {
      if (!a.operations?.includes("peer")) return false;
      const n = v.split(":")[1];
      return !n || (a.peerCount !== undefined && Number(n) === a.peerCount);
    }
    case "place": return Boolean(a.places && placeMatches(a.places, v));
    case "measure": {
      if (v === "unspecified") return Boolean(a.allOffenses || a.codeGroups?.length);
      if (v === "all_crime") return Boolean(a.allOffenses);
      if (a.families?.includes(v)) return true;
      const codes = MEASURE_CODES[v];
      return Boolean(codes && a.codeGroups?.some((g) => sameSet(expandCodes(g), codes)));
    }
    case "unit": return Boolean(a.units?.includes(v));
    case "statistic": {
      if (!a.statistic) return false;
      if (v === "count") return a.statistic === "count";
      if (v === "rate" || v === "per100k" || v === "percapita") return a.statistic === "rate";
      if (v === "total_value" || v === "average_value") return a.statistic === v;
      return false;
    }
    case "rolling": return v === "rolling12" && a.rolling === 12;
    case "combine": return Boolean(a.combine);
    case "clearance": return Boolean(a.clearance);
    case "share": return Boolean(a.share);
    case "period": {
      if (a.periodValues?.includes(v)) return true;
      const r = periodRange(v, now);
      if (!r || !a.years) return false;
      return r.start === a.years.start && (r.end === "open" || r.end === a.years.end);
    }
    case "grain": return Boolean(a.grains?.includes(v as "year" | "month"));
    case "filter": case "clearance-reason": return Boolean(a.filters?.includes(v));
    case "breakdown": {
      if (a.breakdowns?.includes(v)) return true;
      // "by offender age" / "by victim age": an age breakdown counted in that person's unit.
      const whose = /^(offender|victim)-age$/.exec(v);
      return Boolean(whose && a.breakdowns?.includes("age") && a.units?.includes(whose[1] === "offender" ? "offenders" : "victims"));
    }
    case "change": {
      const dir = (v.split(":")[1] ?? "neutral") as "increase" | "decrease" | "neutral";
      return Boolean(a.change?.includes(dir));
    }
    case "rank": {
      if (!a.rank) return false;
      const [dir, token] = v.split(":");
      if ((dir === "top" || dir === "bottom") && dir !== a.rank.dir) return false;
      if (token) return /^\d+$/.test(token) && Number(token) === a.rank.n;
      return true;
    }
    case "threshold": {
      const [op, tok] = v.split("|");
      return Boolean(a.thresholds?.some((t) => t.op === op && String(t.amount) === tok));
    }
    case "entity": return Boolean(a.entities?.includes(v));
    case "list": return Boolean(a.lists?.includes(v));
    case "versus": return Boolean(a.versus) && (a.versus === "any" || versusBetween(ledger, part) === a.versus);
    case "explain": return Boolean(a.explain);
    default: return false;
  }
}

/**
 * True when the path's applied values account for every non-context part of the ledger, and there is at least one such
 * part (no vacuous ownership of a ledger of context and residue).
 */
export function nibrsLegacyBound(ledger: RequestLedger, a: NibrsApplied, now = new Date(), excluded: (p: Part) => boolean = () => false): boolean {
  const meaningful = ledger.parts.filter((p) => p.state !== "context" && !excluded(p));
  return meaningful.length > 0 && meaningful.every((p) => applies(p, a, now, ledger));
}

/** The parts a path's applied values do not account for (for the log, the witness and the typed decline). */
export function nibrsUnboundParts(ledger: RequestLedger, a: NibrsApplied, now = new Date(), excluded: (p: Part) => boolean = () => false): Part[] {
  return ledger.parts.filter((p) => p.state !== "context" && !excluded(p) && !applies(p, a, now, ledger));
}

/**
 * r2.1 F1: the one part a TYPED answer may leave to its stated limitation instead of applying: the turn's explanation
 * request in clause 1, beside an explicit numeric ask in clause 0 (L7). Fixed paths never use this exclusion.
 */
export const typedExplainLimitation = (p: Part): boolean => p.concept === "explain" && p.clause === 1;

/** Place matchers from the contract geographies a builder used. A geography of kind "unknown" is the nation. */
export function placesFromGeographies(geos: QueryContractGeography[]): PlaceSet {
  const tests = geos.map((g): PlaceSet => {
    if (g.kind === "national" || g.kind === "unknown") return placeIs.national;
    if (g.kind === "state") return placeIs.state(g.canonicalName ?? g.name ?? "");
    const name = (g.name ?? "").replace(/\s+(?:police\s+(?:department|dept\.?)|county\s+sheriff(?:['’]s)?(?:\s+office)?|sheriff(?:['’]s)?(?:\s+office)?)$/i, "").replace(/\s+county$/i, "");
    return placeIs.agency(name, g.state ?? "");
  });
  return placeIs.any(...tests);
}

/**
 * The common fields from the contract and year scope a planner builder interpolated (task 0 fixed-paths.md). Each
 * builder adds what its own code fixes: units, statistic, grains, breakdowns, filters.
 */
export function appliedFromContract(contract: QueryContract, years: { startYear: number | null; endYear: number | null; defaulted?: boolean } | null, extra: NibrsApplied): NibrsApplied {
  // The PRIMARY geography only: the single-place builders interpolate `contract.geography` (or index 0) and ignore any
  // other geography the contract lists. A builder that uses several passes its own `places` (witness r1: "robberies in
  // Fort Worth, Texas and in Texas" was owned by the city builder while "and in Texas" was dropped).
  return {
    places: placesFromGeographies([contract.geography]),
    codeGroups: contract.metric.offenses.map((o) => expandCodes(o.codes)),
    years: years && !years.defaulted && years.startYear !== null && years.endYear !== null ? { start: years.startYear, end: years.endYear } : null,
    ...extra,
  };
}
