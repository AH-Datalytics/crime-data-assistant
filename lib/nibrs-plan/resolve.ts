/**
 * Release resolution: turn a plan's relative periods and agency sets into what a pinned release holds, then check the
 * rules that need it (R1-R4). Runs after validatePlanShape/Semantics and before compilation; a plan with any problem
 * is not compiled.
 */
import type { AbsolutePeriod, NibrsPlan, Period, Place } from "./plan";
import type { SemanticLayer } from "./semantic";
import type { PlanProblem } from "./validate";

export type ReleaseInfo = { id: string; firstMonth: string; lastMonth: string };

/** Resolves a place to the ORIs it covers in a data year (from the release's agency tables). */
export type GeographyResolver = { members(place: Place, year: number): string[] };

export type ResolvedPeriod = AbsolutePeriod | { kind: "years"; years: number[] };

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export function resolvePeriod(p: Period, release: ReleaseInfo): ResolvedPeriod {
  const [ly, lm] = release.lastMonth.split("-").map(Number);
  switch (p.kind) {
    case "absolute":
    case "years":
      return p;
    case "since":
      return { kind: "absolute", from: p.from, to: release.lastMonth };
    case "latest_month_in_release":
      return { kind: "absolute", from: release.lastMonth, to: release.lastMonth };
    case "latest_calendar_year_in_release": {
      const y = lm === 12 ? ly : ly - 1;
      return { kind: "absolute", from: ym(y, 1), to: ym(y, 12) };
    }
    case "last_n": {
      if (p.unit === "years") {
        const end = lm === 12 ? ly : ly - 1;
        return { kind: "absolute", from: ym(end - p.count + 1, 1), to: ym(end, 12) };
      }
      const start = ly * 12 + (lm - 1) - (p.count - 1);
      return { kind: "absolute", from: ym(Math.floor(start / 12), (start % 12) + 1), to: release.lastMonth };
    }
  }
}

function span(r: ResolvedPeriod): [string, string] {
  return r.kind === "absolute" ? [r.from, r.to] : [ym(Math.min(...r.years), 1), ym(Math.max(...r.years), 12)];
}

export function validateResolved(plan: NibrsPlan, release: ReleaseInfo, layer: SemanticLayer, geo: GeographyResolver):
  { problems: PlanProblem[]; period: ResolvedPeriod; combined?: { total: number; deduplicated: number } } {
  const problems: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => problems.push({ rule, path, message });
  const period = resolvePeriod(plan.period, release);
  const [from, to] = span(period);

  // R1: inside the release, and inside every measure's and dimension's era.
  if (from < release.firstMonth || to > release.lastMonth) add("R1", "period", `${from}..${to} is outside the release (${release.firstMonth}..${release.lastMonth})`);
  if (from > to) add("R1", "period", "the resolved period is empty");
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  plan.measures.forEach((m, i) => {
    const sm = layer.measure(m.id);
    if (sm && (y0 < sm.validYears[0] || y1 > sm.validYears[1])) add("R1", `measures[${i}]`, `"${m.id}" is defined for ${sm.validYears[0]}-${sm.validYears[1]}`);
  });
  const dims = [...plan.groupings.map((g) => g.dimension), ...allAttributeFilters(plan).map((f) => f.dimension)];
  for (const d of dims) {
    const sd = layer.dimension(d);
    if (sd && (y0 < sd.validYears[0] || y1 > sd.validYears[1])) add("R1", "dimensions", `"${d}" is recorded for ${sd.validYears[0]}-${sd.validYears[1]}`);
  }

  // R2: comparison periods lie inside the plan's period, in order, without overlap.
  plan.transforms.forEach((t, i) => {
    if (t.kind !== "period_comparison") return;
    for (const [name, p] of [["earlier", t.earlier], ["later", t.later]] as const) {
      if (p.from < from || p.to > to) add("R2", `transforms[${i}].${name}`, `${p.from}..${p.to} is outside the plan's period ${from}..${to}`);
    }
    if (t.earlier.to >= t.later.from) add("R2", `transforms[${i}]`, "the earlier period must end before the later one starts");
  });

  // R3: a combined geography counts the deduplicated union of agencies, per data year.
  let combined: { total: number; deduplicated: number } | undefined;
  if (plan.geography.combine === "combined") {
    let total = 0, dedup = 0;
    for (let y = y0; y <= y1; y++) {
      const lists = plan.geography.places.map((p) => geo.members(p, y));
      total += lists.reduce((n, l) => n + l.length, 0);
      dedup += new Set(lists.flat()).size;
    }
    combined = { total, deduplicated: dedup };
  }

  // R4: every place resolves to at least one agency in some year.
  plan.geography.places.forEach((p, i) => {
    let any = false;
    for (let y = y0; y <= y1 && !any; y++) any = geo.members(p, y).length > 0;
    if (!any) add("R4", `geography.places[${i}]`, "no agency in the release matches this place in the period");
  });
  return { problems, period, combined };
}

function allAttributeFilters(plan: NibrsPlan) {
  const fs = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])];
  return fs.flatMap((f) => (f.kind === "attribute" ? [f] : f.where));
}
