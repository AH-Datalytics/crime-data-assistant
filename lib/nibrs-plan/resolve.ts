/**
 * Release resolution: turn a plan's relative periods and agency sets into what a pinned release holds, then check the
 * rules that need it (R1-R5). Runs after validatePlanShape/Semantics and before compilation; a plan with any problem
 * is not compiled.
 */
import type { AbsolutePeriod, NibrsPlan, Period, Place } from "./plan";
import type { SemanticLayer } from "./semantic";
import type { PlanProblem } from "./validate";
import { attributeConditions, attributeValueProblems, ungroupedRates } from "./validate";

/** asOf: the request's date (YYYY-MM-DD), for calendar-relative periods ("last year"). */
export type ReleaseInfo = { id: string; firstMonth: string; lastMonth: string; asOf?: string };

/** Resolves a place to the ORIs it covers in a data year (from the release's agency tables). */
export type GeographyResolver = { members(place: Place, year: number): string[] };

/** A noncontiguous selection whose last year runs past the release carries `through`: that year only through that month. */
export type ResolvedPeriod = AbsolutePeriod | { kind: "years"; years: number[]; through?: string };

const ym = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;

export function resolvePeriod(p: Period, release: ReleaseInfo): ResolvedPeriod {
  const [ly, lm] = release.lastMonth.split("-").map(Number);
  switch (p.kind) {
    case "absolute":
    case "years":
      return p;
    case "since":
      return { kind: "absolute", from: p.from, to: release.lastMonth };
    case "previous_calendar_year": {
      if (!release.asOf) throw new Error("previous_calendar_year needs the request date (ReleaseInfo.asOf)");
      const y = Number(release.asOf.slice(0, 4)) - 1;
      return { kind: "absolute", from: ym(y, 1), to: ym(y, 12) };
    }
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
  { problems: PlanProblem[]; period: ResolvedPeriod; clippedTo?: string; combined?: { total: number; deduplicated: number } } {
  // The returned period is the effective one: clipped to the release's last month when it runs past it.
  const problems: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => problems.push({ rule, path, message });
  const requested = resolvePeriod(plan.period, release);
  const [from, asked] = span(requested);
  // A period running past the release's last month (a year still in progress) is answered through that month: it is
  // clipped, and the clip is recorded (`clippedTo`, and the resolved period in provenance), never silent. A period
  // starting after the release's last month, or before its first, is outside the release (R1).
  const clippedTo = asked > release.lastMonth && from <= release.lastMonth ? release.lastMonth : undefined;
  const to = clippedTo ?? asked;
  const period: ResolvedPeriod = !clippedTo ? requested
    : requested.kind === "absolute" ? { ...requested, to: clippedTo } : { ...requested, through: clippedTo };

  // R1: inside the release, and inside every measure's and dimension's era.
  if (from < release.firstMonth || from > release.lastMonth) add("R1", "period", `${from}..${asked} is outside the release (${release.firstMonth}..${release.lastMonth})`);
  if (from > to) add("R1", "period", "the resolved period is empty");
  // A selected year that starts after the release's last month has no data at all: outside the release.
  if (requested.kind === "years") for (const y of requested.years) if (ym(y, 1) > release.lastMonth) add("R1", "period", `${y} is outside the release (${release.firstMonth}..${release.lastMonth})`);
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4));
  // The years actually selected: a noncontiguous period selects only its own years, never the ones between.
  const selected = period.kind === "years" ? period.years : Array.from({ length: Math.max(0, y1 - y0 + 1) }, (_, k) => y0 + k);
  const inSelection = (q: AbsolutePeriod) => period.kind === "years"
    ? Array.from({ length: Number(q.to.slice(0, 4)) - Number(q.from.slice(0, 4)) + 1 }, (_, k) => Number(q.from.slice(0, 4)) + k).every((y) => selected.includes(y))
    : q.from >= from && q.to <= to;
  plan.measures.forEach((m, i) => {
    const sm = layer.measure(m.id);
    if (sm && (y0 < sm.validYears[0] || y1 > sm.validYears[1])) add("R1", `measures[${i}]`, `"${m.id}" is defined for ${sm.validYears[0]}-${sm.validYears[1]}`);
  });
  for (const g of plan.groupings) {
    const sd = layer.dimension(g.dimension);
    if (sd && (y0 < sd.validYears[0] || y1 > sd.validYears[1])) add("R1", "groupings", `"${g.dimension}" is recorded for ${sd.validYears[0]}-${sd.validYears[1]}`);
  }
  // Every condition's dimension and codes, against the RESOLVED years (a 'since' plan is checked here).
  for (const [f, path] of attributeConditions(plan)) {
    const sd = layer.dimension(f.dimension);
    if (!sd) continue;
    if (y0 < sd.validYears[0] || y1 > sd.validYears[1]) add("R1", path, `"${f.dimension}" is recorded for ${sd.validYears[0]}-${sd.validYears[1]}`);
    for (const pr of attributeValueProblems(f, sd, [y0, y1], path)) if (pr.rule === "S7") add("R1", path, pr.message);
  }

  // R2: comparison periods lie inside the plan's period, in order, without overlap.
  plan.transforms.forEach((t, i) => {
    if (t.kind !== "period_comparison") return;
    for (const [name, p] of [["earlier", t.earlier], ["later", t.later]] as const) {
      if (!inSelection(p)) add("R2", `transforms[${i}].${name}`, `${p.from}..${p.to} is outside the plan's selected period`);
      // A compared period is a whole period: it may not run past the release (clipping would change the comparison).
      if (p.from < release.firstMonth || p.to > release.lastMonth) add("R2", `transforms[${i}].${name}`, `${p.from}..${p.to} is not entirely inside the release (${release.firstMonth}..${release.lastMonth})`);
    }
    if (t.earlier.to >= t.later.from) add("R2", `transforms[${i}]`, "the earlier period must end before the later one starts");
  });

  // R3: a combined geography counts the deduplicated union of agencies, per data year.
  let combined: { total: number; deduplicated: number } | undefined;
  if (plan.geography.combine === "combined") {
    let total = 0, dedup = 0;
    for (const y of selected) {
      const lists = plan.geography.places.map((p) => geo.members(p, y));
      total += lists.reduce((n, l) => n + l.length, 0);
      dedup += new Set(lists.flat()).size;
    }
    combined = { total, deduplicated: dedup };
  }

  // R4: every place resolves to at least one agency in some year.
  plan.geography.places.forEach((p, i) => {
    let any = false;
    for (const y of selected) any = any || geo.members(p, y).length > 0;
    if (!any) add("R4", `geography.places[${i}]`, "no agency in the release matches this place in the period");
  });

  // R5: a rate's population is one data year's; a rate with no time grouping and no comparison needs its RESOLVED
  // period inside one data year (a 'since 2026-01' rate is January-October 2026; a 'since 2024' rate is refused).
  if (y0 !== y1 || (period.kind === "years" && period.years.length > 1)) {
    for (const r of ungroupedRates(plan)) add("R5", "statistics", `rate "${r}" spans ${from}..${to}: group by time.year or time.month`);
  }
  return { problems, period, ...(clippedTo ? { clippedTo } : {}), combined };
}
