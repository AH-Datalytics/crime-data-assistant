/**
 * Stage 3a (Current Trends), plan §5 and r1.1 F1: a fixed path -- or a typed answer -- owns a Current request only when
 * every non-context part of the request's ledger is a value it actually applied, AND the owner policy allows what it
 * applied (no national or state rate on Current: ruling 3). Each path records `applied` from its OWN variables
 * (audit/request-accounting-stage3/3a-r1/task0/fixed-paths.md), never by re-reading the request. No fixed path applies
 * "why".
 */
import type { Part, RequestLedger } from "./request-accounting";
import { placeIs, placeMatches, type PlaceSet } from "./nibrs-legacy-binding";

export { placeIs, type PlaceSet };

export type CurrentApplied = {
  /** completeness | coverage-lookup */
  operations?: string[];
  places?: PlaceSet;
  /** Measure ids the answer reported, each a whole offense set (murder ... motor_vehicle_theft, violent_crime, property_crime, all7). */
  measures?: string[];
  statistic?: "count" | "rate" | null;
  /** A rolling-window sum the answer computed (window length in months). */
  rolling?: number;
  /** A period total the answer computed over several months. */
  combine?: boolean;
  /** The ledger period values the answer's executed months correspond to (derived from those months, or a resolved relative form). */
  periodValues?: string[];
  grains?: ("month" | "year" | "trend")[];
  rank?: { dir: "top" | "bottom"; n: number } | null;
  thresholds?: { op: ">=" | ">"; amount: number }[];
  /** Count conditions a ranking applied ("with at least 10 murders"). */
  countThresholds?: { op: ">=" | ">"; amount: number }[];
  change?: ("increase" | "decrease" | "neutral")[];
  versus?: "places" | "periods" | "any";
  entities?: string[];
  lists?: string[];
  /** C6: the peer group the answer selected, with the number of peers asked for (null: the default). */
  peer?: { n: number | null };
  /** C3 "most common crime": the answer sorted its measures by value. */
  sort?: "most-common";
};

const MONTH_KEY = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

/**
 * The ledger period values a set of executed months corresponds to. `cutoff` is the source's latest month: a year whose
 * months run from January to the cutoff is that year as far as it goes ("in 2026" = January-May 2026, named as partial).
 */
export function periodValuesOfMonths(months: [number, number][], cutoff: { year: number; month: number }): string[] {
  if (!months.length) return [];
  const sorted = [...months].sort((a, b) => a[0] * 100 + a[1] - (b[0] * 100 + b[1]));
  const keys = sorted.map(([y, m]) => y * 12 + m);
  const contiguous = keys.every((k, i) => i === 0 || k === keys[i - 1] + 1);
  const out: string[] = [];
  const [fy, fm] = sorted[0];
  const [ly, lm] = sorted[sorted.length - 1];
  const yearEnd = (y: number) => (y === cutoff.year ? cutoff.month : 12);
  if (sorted.length === 1) out.push(`month:${MONTH_KEY(fy, fm)}`);
  if (contiguous) {
    out.push(`monthrange:${MONTH_KEY(fy, fm)}:${MONTH_KEY(ly, lm)}`);
    if (fm === 1 && lm === yearEnd(ly)) {
      if (fy === ly) { out.push(`year:${fy}`); if (fy === cutoff.year) out.push("ytd"); }
      else { out.push(`range:${fy}:${ly}`, `between:${fy}:${ly}`); }
      if (ly === cutoff.year && lm === cutoff.month) out.push(`since:${fy}`);
    }
  }
  return out;
}

function versusBetween(ledger: RequestLedger, v: Part): "places" | "periods" | "other" {
  const parts = ledger.parts.filter((p) => p.state !== "context");
  const left = parts.filter((p) => p.span[1] <= v.span[0]).sort((x, y) => y.span[1] - x.span[1])[0];
  const right = parts.filter((p) => p.span[0] >= v.span[1]).sort((x, y) => x.span[0] - y.span[0])[0];
  if (left?.concept === "place" && right?.concept === "place") return "places";
  if (left?.concept === "period" && right?.concept === "period") return "periods";
  // "the Austin robbery count compare to Texas" / "San Francisco against 3 cities of similar size": a place on the right.
  if (right?.concept === "place" || right?.concept === "peer") return "places";
  return "other";
}

function applies(part: Part, a: CurrentApplied, ledger: RequestLedger): boolean {
  const v = part.value ?? "";
  switch (part.concept) {
    case "completeness": case "coverage-lookup":
      return Boolean(a.operations?.includes(part.concept));
    case "place": return Boolean(a.places && placeMatches(a.places, v));
    case "measure":
      if (v === "unspecified") return Boolean(a.measures?.length);
      return Boolean(a.measures?.includes(v));
    case "overview": return Boolean(a.measures?.includes("all7"));
    case "sort": return a.sort === "most-common" && Boolean(a.measures?.length);
    case "statistic":
      if (!a.statistic) return false;
      if (v === "count") return a.statistic === "count";
      if (v === "rate" || v === "per100k" || v === "percapita") return a.statistic === "rate";
      return false;
    case "rolling": return v === "rolling12" && a.rolling === 12;
    case "combine": return Boolean(a.combine);
    case "period": {
      const norm = v.replace(/^between:/, "range:");
      return Boolean(a.periodValues?.includes(v) || a.periodValues?.includes(norm));
    }
    case "grain": return Boolean(a.grains?.includes(v as "month" | "year" | "trend"));
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
    case "count-threshold": {
      const [op, tok] = v.split("|");
      return Boolean(a.countThresholds?.some((t) => t.op === op && String(t.amount) === tok));
    }
    case "entity": return Boolean(a.entities?.includes(v));
    case "list": return Boolean(a.lists?.includes(v));
    case "versus": return Boolean(a.versus) && (a.versus === "any" || versusBetween(ledger, part) === a.versus);
    case "peer": {
      if (!a.peer) return false;
      const n = v.split(":")[1];
      return n ? a.peer.n === Number(n) : a.peer.n === null;
    }
    default: return false;
  }
}

/**
 * Ruling 3 (r1.1 F1): what Current may deliver at all. A rate is allowed only for agencies; a national or state figure
 * is a count of sample agencies.
 */
export function currentPolicyAllows(a: CurrentApplied): boolean {
  // A ranking's place is the scope it ranks cities within; each rate is a city's own. Anything else with a national or
  // state place and a rate would be the sample's own rate, which Current does not give.
  if (a.statistic === "rate" && !a.rank && (a.places?.national || (a.places?.states?.length ?? 0) > 0)) return false;
  return true;
}

/**
 * True when the path's applied values account for every non-context part of the ledger (there being at least one), and
 * the owner policy allows them.
 */
export function currentLegacyBound(ledger: RequestLedger, a: CurrentApplied, excluded: (p: Part) => boolean = () => false): boolean {
  const meaningful = ledger.parts.filter((p) => p.state !== "context" && !excluded(p));
  return meaningful.length > 0 && meaningful.every((p) => applies(p, a, ledger)) && currentPolicyAllows(a);
}

/** The parts a path's applied values do not account for (for the log, the witness and the typed decline). */
export function currentUnboundParts(ledger: RequestLedger, a: CurrentApplied, excluded: (p: Part) => boolean = () => false): Part[] {
  return ledger.parts.filter((p) => p.state !== "context" && !excluded(p) && !applies(p, a, ledger));
}

/** The one part a TYPED answer may leave to its stated limitation: the turn's explanation request in clause 1 (L7). */
export const currentExplainLimitation = (p: Part): boolean => p.concept === "explain" && p.clause === 1;
