/**
 * Plan validation (spec: docs/superpowers/specs/2026-10-28-nibrs-plan-language.md, section "Validation").
 *
 * validatePlanShape: rules that need no semantic layer (P1-P14).
 * validatePlanSemantics: rules against a pinned semantic-layer version (S1-S7).
 * validateBindings: request accounting; every meaningful part of the question is bound (A1).
 *
 * Each returns a list of problems; an empty list means valid. A plan with any problem is never compiled.
 */
import type { Filter, NibrsPlan, PartRef, Period } from "./plan";
import { PLAN_VERSION } from "./plan";
import type { SemanticLayer } from "./semantic";

export type PlanProblem = { rule: string; path: string; message: string };

const YM = /^(\d{4})-(0[1-9]|1[0-2])$/;

function periodProblems(p: Period, path: string): PlanProblem[] {
  if (p.kind === "absolute") {
    if (!YM.test(p.from) || !YM.test(p.to)) return [{ rule: "P4", path, message: "months are YYYY-MM" }];
    if (p.from > p.to) return [{ rule: "P4", path, message: "the period ends before it starts" }];
    return [];
  }
  if ((p.anchor === "since") !== (p.from !== undefined)) return [{ rule: "P4", path, message: "'since' needs `from`, and only 'since' takes it" }];
  if ((p.anchor === "last_n_years" || p.anchor === "last_n_months") !== (p.count !== undefined)) return [{ rule: "P4", path, message: "last-n periods need `count`, and only they take it" }];
  if (p.from !== undefined && !YM.test(p.from)) return [{ rule: "P4", path, message: "months are YYYY-MM" }];
  return [];
}

function filterProblems(f: Filter, path: string): PlanProblem[] {
  if (f.kind === "attribute") {
    const needsValues = f.op === "in" || f.op === "not_in" || f.op === "between";
    if (needsValues && !(f.values && f.values.length)) return [{ rule: "P7", path, message: `${f.op} needs values` }];
    if (f.op === "between" && f.values!.length !== 2) return [{ rule: "P7", path, message: "between takes two values" }];
    return [];
  }
  const out: PlanProblem[] = [];
  if (!f.where.length) out.push({ rule: "P8", path, message: "an existence filter needs at least one condition" });
  if (f.entity === "property" && f.scope === "incident" && f.attribution !== "incident_level_only") {
    out.push({ rule: "P9", path, message: "property is linked to the incident, not an offense: set attribution 'incident_level_only'" });
  }
  f.where.forEach((w, i) => out.push(...filterProblems(w, `${path}.where[${i}]`)));
  return out;
}

export function validatePlanShape(plan: NibrsPlan): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });

  if (plan.version !== PLAN_VERSION) add("P1", "version", `expected ${PLAN_VERSION}`);
  if (!plan.semanticVersion) add("P1", "semanticVersion", "a plan is validated against a pinned semantic version");

  // P2: measures exist and have distinct names.
  if (!plan.measures.length) add("P2", "measures", "at least one measure");
  const names = plan.measures.map((m) => m.as);
  if (new Set(names).size !== names.length) add("P2", "measures", "measure names must be distinct");

  // P3: places.
  const places = plan.geography.places;
  if (!places.length) add("P3", "geography.places", "at least one place");
  if (plan.geography.combine === "combined") {
    if (places.length < 2) add("P3", "geography.combine", "'combined' needs two or more places");
    if (places.some((p) => p.kind === "national")) add("P3", "geography.combine", "the nation already contains every place; it cannot be combined with another");
  }
  if (places.filter((p) => p.kind === "national").length > 1) add("P3", "geography.places", "the nation appears twice");

  out.push(...periodProblems(plan.period, "period"));

  // P5: groupings are distinct; a geography grouping needs more than one place or an agency set.
  const dims = plan.groupings.map((g) => g.dimension);
  if (new Set(dims).size !== dims.length) add("P5", "groupings", "a dimension appears twice");
  plan.groupings.forEach((g, i) => {
    if (g.bins && !g.bins.length) add("P5", `groupings[${i}].bins`, "empty bins");
  });

  // P6: statistics reference declared measures; share partitions are groupings.
  const stats = plan.statistics;
  if (!stats.length) add("P6", "statistics", "at least one statistic");
  stats.forEach((s, i) => {
    const path = `statistics[${i}]`;
    const refs = s.kind === "ratio" ? [s.numerator, s.denominator] : [s.measure, ...(s.kind === "share" && s.denominatorMeasure ? [s.denominatorMeasure] : [])];
    for (const r of refs) if (!names.includes(r)) add("P6", path, `unknown measure "${r}"`);
    if (s.kind === "share") {
      for (const d of s.partition) if (!dims.includes(d)) add("P6", `${path}.partition`, `partition "${d}" is not a grouping`);
      if (s.partition.length === dims.length && dims.length > 0 && !s.denominatorMeasure) add("P6", `${path}.partition`, "a partition over every grouping makes every share 100%");
    }
    if (s.kind === "rate" && !(s.per > 0)) add("P6", `${path}.per`, "per must be positive");
    // P10: rates use complete agency-periods (D6, D8).
    if (s.kind === "rate" && plan.coverage.cohort === "all_reporting") add("P10", "coverage.cohort", "a rate needs the 'complete_periods' or 'same_agencies' cohort");
  });

  // P7-P9: filters.
  plan.filters.forEach((f, i) => out.push(...filterProblems(f, `filters[${i}]`)));
  plan.measures.forEach((m, i) => (m.filters ?? []).forEach((f, j) => out.push(...filterProblems(f, `measures[${i}].filters[${j}]`))));

  // P11-P13: transforms.
  const aliases = [...names, ...stats.filter((s) => s.kind === "ratio").map((s) => (s as { as: string }).as)];
  plan.transforms.forEach((t, i) => {
    const path = `transforms[${i}]`;
    if (t.kind === "rolling") {
      if (!dims.includes("time.month")) add("P11", path, "a rolling window needs the time.month grouping");
      if (!(t.months >= 2)) add("P11", path, "a window covers two or more months");
    }
    if (t.kind === "top_n") {
      if (!(t.n >= 1)) add("P12", path, "n must be at least 1");
      if (!aliases.includes(t.by)) add("P12", path, `unknown measure "${t.by}"`);
      for (const d of t.per) if (!dims.includes(d)) add("P12", path, `per "${d}" is not a grouping`);
      if (t.per.length === dims.length) add("P12", path, "nothing is left to rank within each group");
    }
    if (t.kind === "period_comparison") {
      out.push(...periodProblems(t.earlier, `${path}.earlier`), ...periodProblems(t.later, `${path}.later`));
      if (!t.outputs.length) add("P13", path, "at least one output");
      if (t.earlier.kind === "absolute" && t.later.kind === "absolute" && t.earlier.to >= t.later.from) add("P13", path, "the earlier period must end before the later one starts");
    }
  });

  // P14: the fixed coverage rules.
  if (plan.coverage.unknownMonths !== "show_unknown" || plan.coverage.filteredZero !== "requires_evidence") {
    add("P14", "coverage", "unknown months are never zero, and a filtered zero needs evidence (D6)");
  }
  return out;
}

export function validatePlanSemantics(plan: NibrsPlan, layer: SemanticLayer): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });
  if (plan.semanticVersion !== layer.version) add("S1", "semanticVersion", `plan was read against ${plan.semanticVersion}, layer is ${layer.version}`);
  const years = periodYears(plan.period);

  plan.measures.forEach((m, i) => {
    const sm = layer.measure(m.id);
    if (!sm) { add("S2", `measures[${i}]`, `unknown measure "${m.id}"`); return; }
    if (sm.unit !== m.unit) add("S2", `measures[${i}].unit`, `"${m.id}" counts ${sm.unit}, not ${m.unit}`);
    if (years && (years[0] < sm.validYears[0] || years[1] > sm.validYears[1])) add("S7", `measures[${i}]`, `"${m.id}" is defined for ${sm.validYears[0]}-${sm.validYears[1]}`);

    const reach = (dimension: string, path: string, how: "filter" | "group", multi: boolean) => {
      const d = layer.dimension(dimension);
      if (!d) { add("S3", path, `unknown dimension "${dimension}"`); return; }
      if (years && (years[0] < d.validYears[0] || years[1] > d.validYears[1])) add("S7", path, `"${dimension}" is recorded for ${d.validYears[0]}-${d.validYears[1]}`);
      if (d.entity === sm.entity || dimension.startsWith("time.") || dimension.startsWith("geo.")) return;
      const c = layer.cardinality(sm.entity, d.entity);
      if (!c) add("S4", path, `"${dimension}" is not related to ${sm.entity}`);
      else if (c === "many" && how === "filter") add("S5", path, `"${dimension}" has many values per ${sm.entity}: use an existence filter`);
      else if (c === "many" && how === "group" && !multi) add("S6", path, `"${dimension}" has many values per ${sm.entity}: set multiValue 'each_value' or filter to one value`);
    };
    [...plan.filters, ...(m.filters ?? [])].forEach((f, j) => {
      if (f.kind === "attribute") reach(f.dimension, `filters[${j}]`, "filter", false);
      else {
        const c = layer.cardinality(sm.entity, f.entity);
        if (!c && f.scope !== "incident") add("S4", `filters[${j}]`, `"${f.entity}" is not related to ${sm.entity}`);
        f.where.forEach((w, k) => { if (w.kind === "attribute" && !layer.dimension(w.dimension)) add("S3", `filters[${j}].where[${k}]`, `unknown dimension "${w.dimension}"`); });
      }
    });
    plan.groupings.forEach((g, j) => reach(g.dimension, `groupings[${j}]`, "group", g.multiValue === "each_value"));
  });
  return out;
}

/** A1: every part of clause 0 that carries meaning is bound to a plan path. */
export function validateBindings(plan: NibrsPlan, parts: PartRef[]): PlanProblem[] {
  const bound = new Set(plan.bindings.map((b) => `${b.part.span[0]}:${b.part.span[1]}`));
  return parts
    .filter((p) => !bound.has(`${p.span[0]}:${p.span[1]}`))
    .map((p) => ({ rule: "A1", path: "bindings", message: `"${p.text}" (${p.concept}) is not applied` }));
}

function periodYears(p: Period): [number, number] | null {
  if (p.kind === "absolute") return [Number(p.from.slice(0, 4)), Number(p.to.slice(0, 4))];
  // The end of a 'since' period is the release's last month, known only at compile time; the start is checked here.
  if (p.anchor === "since" && p.from) return [Number(p.from.slice(0, 4)), Number(p.from.slice(0, 4))];
  return null;
}
