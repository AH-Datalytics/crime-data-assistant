/**
 * Stage 2a (Historical), plan r1.1 C1: a FIXED (legacy) path owns a request only when every non-context part of the
 * request's ledger is a value that path actually used to build its statement. The values come from the builder's own
 * variables (an `applied` field added to each plan, or the plan's resolved identity), never from re-reading the request.
 * A path that does not apply every part does not answer; the request falls through to the supported types (H1-H6).
 */
import type { Part, RequestLedger } from "./request-accounting";
import { relativeYearRangeForQuestion } from "./time-conventions";

export type LegacyApplied = {
  operations?: string[];             // scorecard | completeness | coverage-lookup | peer | prison-population
  places?: (value: string) => boolean;
  measures?: string[];
  clearance?: boolean;
  statistic?: "count" | "rate" | null; // null: the path shows its own fixed statistic(s); a statistic part is not applied
  periodKeys?: string[];
  relativeYears?: { start: number; end: number } | null;
  /** r2 §1: the change directions the path shows (a signed change shows every direction). */
  change?: ("increase" | "decrease" | "neutral")[];
  /** r2 §1: the path's ranking, by VALUE: its direction and the exact number of places it shows. */
  rank?: { dir: "top" | "bottom"; n: number };
  entities?: string[];
  grain?: boolean;
  /** r2 §1: what a comparison word may stand between in this path. */
  versus?: "places" | "years" | "any";
};

const OFFENSE_COLUMN_TO_MEASURE: Record<string, string> = {
  "hac.murder": "murder", "hac.rape": "rape", "hac.robbery": "robbery", "hac.assault": "aggravated_assault",
  "hac.burglary": "burglary", "hac.theft": "theft", "hac.motor_vehicle_theft": "motor_vehicle_theft",
  "hac.violent": "violent", "hac.property": "property",
};
export function measureForOffenseColumn(column: string): string | null {
  return OFFENSE_COLUMN_TO_MEASURE[column] ?? null;
}

function lastYearsOf(value: string, now: Date): { start: number; end: number } | null {
  const m = /^last:(\d{1,2})$/.exec(value);
  if (m) return relativeYearRangeForQuestion(`last ${m[1]} years`, now);
  const inc = /^lastinc:(\d{1,2})$/.exec(value);
  if (inc) return relativeYearRangeForQuestion(`last ${inc[1]} years including this year`, now);
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

function applies(part: Part, a: LegacyApplied, now: Date, ledger: RequestLedger): boolean {
  const v = part.value ?? "";
  switch (part.concept) {
    case "scorecard": case "completeness": case "coverage-lookup": case "peer": case "prison-population":
      return Boolean(a.operations?.includes(part.concept));
    case "place": return Boolean(a.places?.(v));
    case "measure": case "staffing": return Boolean(a.measures?.includes(v));
    case "clearance": return Boolean(a.clearance);
    case "statistic": {
      if (a.statistic === undefined || a.statistic === null) return false;
      return v === "count" ? a.statistic === "count" : (v === "rate" || v === "percapita" || v === "per100k") && a.statistic === "rate";
    }
    case "period": {
      if (a.periodKeys?.includes(v)) return true;
      const rel = lastYearsOf(v, now);
      return Boolean(rel && a.relativeYears && rel.start === a.relativeYears.start && rel.end === a.relativeYears.end);
    }
    case "change": {
      const dir = (v.split(":")[1] ?? "neutral") as "increase" | "decrease" | "neutral";
      return Boolean(a.change?.includes(dir));
    }
    case "rank": {
      if (!a.rank) return false;
      const [dir, token] = v.split(":");
      if ((dir === "top" || dir === "bottom") && dir !== a.rank.dir) return false;
      if (token) return /^\d+$/.test(token) && Number(token) === a.rank.n && String(a.rank.n) === token.replace(/^0+(?=\d)/, "");
      return true;
    }
    case "entity": return Boolean(a.entities?.includes(v));
    case "grain": return Boolean(a.grain);
    case "versus": return Boolean(a.versus) && (a.versus === "any" || versusBetween(ledger, part) === a.versus);
    default: return false;
  }
}

/**
 * True when the path's applied values account for every non-context part of the ledger, and it applies at least one
 * (plan r3 §1: no vacuous ownership of a ledger of context and residue). An explanation request ("why") is never
 * applied by a fixed path, so a request carrying one is never owned here.
 */
export function historicalLegacyBound(ledger: RequestLedger, a: LegacyApplied, now = new Date()): boolean {
  const meaningful = ledger.parts.filter((p) => p.state !== "context");
  return meaningful.length > 0 && meaningful.every((p) => applies(p, a, now, ledger));
}

/** Place-value matchers built from a builder's resolved identity. */
export const placeIs = {
  national: (v: string) => v === "national",
  state: (name: string) => (v: string) => v === `state:${name}`,
  agency: (name: string, state: string) => (v: string) => {
    const [kind, n, st] = v.split(":");
    return (kind === "city" || kind === "county") && st?.toUpperCase() === state.toUpperCase() && n?.toUpperCase().replace(/\s+CITY$/, "") === name.toUpperCase().replace(/\s+CITY$/, "");
  },
  any: (...tests: ((v: string) => boolean)[]) => (v: string) => tests.some((t) => t(v)),
};

/** The period keys an explicit start-end range answers. */
export function rangeKeys(start: number, end: number): string[] {
  return start === end ? [`year:${start}`, `range:${start}:${end}`, `between:${start}:${end}`] : [`range:${start}:${end}`, `between:${start}:${end}`, `between:${end}:${start}`];
}
