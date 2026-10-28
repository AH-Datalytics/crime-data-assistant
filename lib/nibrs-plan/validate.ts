/**
 * Plan validation (spec: docs/superpowers/specs/2026-10-28-nibrs-plan-language.md, "Validation").
 *
 *   parsePlan (plan.ts)        P0  reader JSON against the schema: shapes, discriminants, integers, month formats
 *   validatePlanShape          P1-P13 rules that need no semantic layer
 *   validatePlanSemantics      S1-S12 rules against a pinned semantic-layer version
 *   validateBindings           A1-A4  request accounting: every part bound, by path AND by value
 *   validateResolved (resolve) R1-R4  rules that need the pinned release
 *
 * Each returns problems; an empty list means valid. A plan with any problem is never compiled.
 */
import type { AttributeFilter, Filter, NibrsPlan, PartRef } from "./plan";
import { PLAN_VERSION } from "./plan";
import type { SemanticLayer } from "./semantic";
import { pathCardinality } from "./semantic";

export type PlanProblem = { rule: string; path: string; message: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dupes = <T>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => same(x, y)) !== i);
const TRANSFORM_ORDER = { rolling: 0, period_comparison: 1, rank: 2 } as const;

function attributeProblems(f: AttributeFilter, path: string): PlanProblem[] {
  const n = f.values?.length ?? 0;
  if ((f.op === "in" || f.op === "not_in") && n < 1) return [{ rule: "P7", path, message: `${f.op} needs values` }];
  if (f.op === "between" && n !== 2) return [{ rule: "P7", path, message: "between takes two values" }];
  if ((f.op === "is_unknown" || f.op === "is_known") && n) return [{ rule: "P7", path, message: `${f.op} takes no values` }];
  return [];
}

function filterProblems(f: Filter, path: string): PlanProblem[] {
  if (f.kind === "attribute") return attributeProblems(f, path);
  const out = f.where.flatMap((w, i) => attributeProblems(w, `${path}.where[${i}]`));
  if (f.entity === "property" && f.attribution !== "incident_level_only") {
    out.push({ rule: "P9", path, message: "property is linked to the incident, not an offense: set attribution 'incident_level_only'" });
  }
  return out;
}

export function validatePlanShape(plan: NibrsPlan): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });

  if (plan.version !== PLAN_VERSION) add("P1", "version", `expected ${PLAN_VERSION}`);

  // P2: names. Measures and statistics share one namespace, so a transform's target is never ambiguous.
  const measureNames = plan.measures.map((m) => m.as);
  const statNames = plan.statistics.map((s) => s.as);
  for (const n of dupes([...measureNames, ...statNames])) add("P2", "names", `"${n}" names two things`);

  // P3: places.
  const places = plan.geography.places;
  for (const p of dupes(places)) add("P3", "geography.places", `${JSON.stringify(p)} appears twice`);
  const groupDims = plan.groupings.map((g) => g.dimension);
  if (plan.geography.combine === "combined") {
    if (places.length < 2) add("P3", "geography.combine", "'combined' needs two or more places");
    if (places.some((p) => p.kind === "national")) add("P3", "geography.combine", "the nation already contains every place");
  }
  const separateMany = plan.geography.combine === "separate" && places.length > 1;
  if (separateMany && !groupDims.includes("geo.place")) add("P3", "groupings", "two or more separate places need the geo.place grouping");
  if (!separateMany && groupDims.includes("geo.place")) add("P3", "groupings", "geo.place groups two or more separate places");

  // P4: periods.
  const p = plan.period;
  if (p.kind === "absolute" && p.from > p.to) add("P4", "period", "the period ends before it starts");
  if (p.kind === "years" && (dupes(p.years).length || p.years.some((y, i) => i && y < p.years[i - 1]))) add("P4", "period.years", "years must be distinct and ascending");

  // P5: groupings and bins.
  for (const d of dupes(groupDims)) add("P5", "groupings", `"${d}" is grouped twice`);
  plan.groupings.forEach((g, i) => {
    if (!g.bins) return;
    const bins = [...g.bins].sort((a, b) => a.from - b.from);
    if (bins.some((b) => b.from > b.to)) add("P5", `groupings[${i}].bins`, "a bin ends before it starts");
    if (bins.some((b, j) => j && b.from <= bins[j - 1].to)) add("P5", `groupings[${i}].bins`, "bins overlap");
    if (dupes(g.bins.map((b) => b.label)).length) add("P5", `groupings[${i}].bins`, "bin labels repeat");
  });

  // P6: statistics name declared measures; share partitions are distinct groupings.
  plan.statistics.forEach((s, i) => {
    const path = `statistics[${i}]`;
    const refs = s.kind === "ratio" ? [s.numerator, s.denominator] : [s.measure, ...(s.kind === "share" && s.denominator ? [s.denominator] : [])];
    for (const r of refs) if (!measureNames.includes(r)) add("P6", path, `unknown measure "${r}"`);
    if (s.kind === "share") {
      for (const d of s.within) if (!groupDims.includes(d)) add("P6", `${path}.within`, `"${d}" is not a grouping`);
      for (const d of dupes(s.within)) add("P6", `${path}.within`, `"${d}" appears twice`);
    }
  });

  // P7-P9: filters.
  plan.filters.forEach((f, i) => out.push(...filterProblems(f, `filters[${i}]`)));
  plan.measures.forEach((m, i) => (m.filters ?? []).forEach((f, j) => out.push(...filterProblems(f, `measures[${i}].filters[${j}]`))));

  // P10: a same-agencies cohort compares periods: it needs a period comparison or a time grouping.
  if (plan.coverage.cohort === "same_agencies" && !plan.transforms.some((t) => t.kind === "period_comparison") && !groupDims.some((d) => d.startsWith("time."))) {
    add("P10", "coverage.cohort", "a same-agencies cohort needs periods to compare");
  }

  // P11-P13: transforms, in the fixed order rolling -> period_comparison -> rank, each naming existing statistics.
  plan.transforms.forEach((t, i) => {
    const path = `transforms[${i}]`;
    if (i && TRANSFORM_ORDER[t.kind] < TRANSFORM_ORDER[plan.transforms[i - 1].kind]) add("P11", path, "transforms run rolling, then period_comparison, then rank");
    const targets = t.kind === "rank" ? [t.by] : t.of;
    for (const x of targets) if (!statNames.includes(x)) add("P11", path, `unknown statistic "${x}"`);
    if (t.kind === "rolling" && !groupDims.includes("time.month")) add("P11", path, "a rolling window needs the time.month grouping");
    if (t.kind === "rank") {
      for (const d of t.per) if (!groupDims.includes(d)) add("P12", path, `per "${d}" is not a grouping`);
      if (!groupDims.some((d) => !t.per.includes(d))) add("P12", path, "nothing is left to rank within each group");
    }
    if (t.kind === "period_comparison") {
      for (const q of [t.earlier, t.later]) if (q.from > q.to) add("P13", path, "a comparison period ends before it starts");
      if (t.earlier.to >= t.later.from) add("P13", path, "the earlier period must end before the later one starts");
      if (p.kind === "absolute" && (t.earlier.from < p.from || t.later.to > p.to)) add("P13", path, "comparison periods must lie inside the plan's period");
    }
  });
  if (plan.transforms.filter((t) => t.kind === "rank").length > 1) add("P12", "transforms", "one rank per plan");
  return out;
}

export function validatePlanSemantics(plan: NibrsPlan, layer: SemanticLayer): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });
  if (plan.semanticVersion !== layer.version) add("S1", "semanticVersion", `plan was read against ${plan.semanticVersion}, layer is ${layer.version}`);
  const years = plan.period.kind === "absolute" ? [Number(plan.period.from.slice(0, 4)), Number(plan.period.to.slice(0, 4))]
    : plan.period.kind === "years" ? [plan.period.years[0], plan.period.years[plan.period.years.length - 1]] : null;
  const units = new Map(plan.measures.map((m) => [m.as, m.unit]));

  plan.measures.forEach((m, i) => {
    const sm = layer.measure(m.id);
    if (!sm) { add("S2", `measures[${i}]`, `unknown measure "${m.id}"`); return; }
    if (sm.unit !== m.unit) add("S2", `measures[${i}].unit`, `"${m.id}" counts ${sm.unit}, not ${m.unit}`);
    if (!sm.timeBases.includes(plan.timeBasis)) add("S2", "timeBasis", `"${m.id}" has no ${plan.timeBasis}`);
    if (years && (years[0] < sm.validYears[0] || years[1] > sm.validYears[1])) add("S7", `measures[${i}]`, `"${m.id}" is defined for ${sm.validYears[0]}-${sm.validYears[1]}`);

    const manyLinks = new Set<string>();
    const reach = (dimension: string, path: string, how: "filter" | "group", multi: boolean, bins: boolean) => {
      if (dimension === "geo.place") return;
      const d = layer.dimension(dimension);
      if (!d) { add("S3", path, `unknown dimension "${dimension}"`); return; }
      if (years && (years[0] < d.validYears[0] || years[1] > d.validYears[1])) add("S7", path, `"${dimension}" is recorded for ${d.validYears[0]}-${d.validYears[1]}`);
      if (bins && !d.numeric) add("S10", path, `"${dimension}" is not numeric; it cannot be binned`);
      if (dimension.startsWith("time.") || dimension.startsWith("geo.") || d.entity === sm.entity) {
        if (multi) add("S6", path, `"${dimension}" has one value per ${sm.entity}; multiValue does not apply`);
        return;
      }
      const route = layer.path(sm.entity, d.entity);
      if (!route) { add("S4", path, `"${dimension}" is not related to ${sm.entity}`); return; }
      if (pathCardinality(route) === "one") {
        if (multi) add("S6", path, `"${dimension}" has one value per ${sm.entity}; multiValue does not apply`);
        return;
      }
      if (route.some((l) => l.to === "property")) add("S9", path, "property is reached only through an incident-scoped existence filter");
      if (how === "filter") add("S5", path, `"${dimension}" has many values per ${sm.entity}: use an existence filter`);
      else if (!multi) add("S6", path, `"${dimension}" has many values per ${sm.entity}: set multiValue 'each_value' or filter to one value`);
      manyLinks.add(route.find((l) => l.cardinality === "many")!.id);
    };

    const filters = [...plan.filters.map((f, j) => [f, `filters[${j}]`] as const), ...(m.filters ?? []).map((f, j) => [f, `measures[${i}].filters[${j}]`] as const)];
    for (const [f, path] of filters) {
      if (f.kind === "attribute") { reach(f.dimension, path, "filter", false, false); continue; }
      // Existence: counted entity -> scope must be one row; scope -> target must be a declared path; every condition
      // must belong to the target, and be valid for the period.
      if (f.scope !== sm.entity) {
        const up = layer.path(sm.entity, f.scope);
        if (!up) add("S4", `${path}.scope`, `"${f.scope}" is not related to ${sm.entity}`);
        else if (pathCardinality(up) === "many") add("S8", `${path}.scope`, `a ${sm.entity} has many ${f.scope} rows; scope must be the unit itself or an entity it belongs to`);
      }
      const down = layer.entity(f.entity) ? (f.entity === f.scope ? [] : layer.path(f.scope, f.entity)) : undefined;
      if (!down) add("S4", `${path}.entity`, `"${f.entity}" is not reachable from ${f.scope}`);
      else if (down.some((l) => l.to === "property") && f.scope !== "incident") add("S9", `${path}.scope`, "property is linked to the incident: scope must be incident");
      f.where.forEach((w, k) => {
        const d = layer.dimension(w.dimension);
        if (!d) { add("S3", `${path}.where[${k}]`, `unknown dimension "${w.dimension}"`); return; }
        if (d.entity !== f.entity) add("S4", `${path}.where[${k}]`, `"${w.dimension}" belongs to ${d.entity}, not ${f.entity}`);
        if (years && (years[0] < d.validYears[0] || years[1] > d.validYears[1])) add("S7", `${path}.where[${k}]`, `"${w.dimension}" is recorded for ${d.validYears[0]}-${d.validYears[1]}`);
        for (const v of w.values ?? []) {
          const vy = d.valueYears?.[String(v)];
          if (d.values && !(String(v) in d.values) && !d.unknownCodes.includes(String(v))) add("S11", `${path}.where[${k}]`, `"${v}" is not a code of ${w.dimension}`);
          else if (vy && years && (years[0] < vy[0] || years[1] > vy[1])) add("S7", `${path}.where[${k}]`, `code "${v}" exists for ${vy[0]}-${vy[1]}`);
        }
      });
    }
    plan.groupings.forEach((g, j) => reach(g.dimension, `groupings[${j}]`, "group", g.multiValue === "each_value", !!g.bins));
    // S8: one-to-many dimensions must come through ONE link (a pair row), never a cross product of independent joins.
    if (manyLinks.size > 1) add("S8", "groupings", `dimensions reached through different one-to-many links (${[...manyLinks].join(", ")}) would multiply rows`);
  });

  // S12: statistic compatibility.
  plan.statistics.forEach((s, i) => {
    const sm = (name: string) => layer.measure(plan.measures.find((m) => m.as === name)?.id ?? "");
    if (s.kind === "share" && s.denominator && units.get(s.denominator) !== units.get(s.measure)) add("S12", `statistics[${i}]`, "a share's numerator and denominator count the same unit");
    if (s.kind === "rate" && sm(s.measure) && !sm(s.measure)!.additive.acrossAgencies) add("S12", `statistics[${i}]`, "a rate needs a measure that adds across agencies");
  });
  return out;
}

/* ------------------------------------------------------------------ request accounting --------------------------- */

/** Ledger concepts and the plan paths that may apply them. */
const CONCEPT_PATHS: Record<string, RegExp> = {
  measure: /^measures\[\d+\]$/,
  unit: /^measures\[\d+\]\.unit$/,
  place: /^geography\.places\[\d+\]$/,
  threshold: /^geography\.places\[\d+\]$/,
  period: /^(?:period|transforms\[\d+\]\.(?:earlier|later))$/,
  filter: /^(?:filters\[\d+\]|measures\[\d+\]\.filters\[\d+\])$/,
  "clearance-reason": /^(?:filters\[\d+\]|measures\[\d+\]\.filters\[\d+\])$/,
  clearance: /^(?:measures\[\d+\]|statistics\[\d+\]|filters\[\d+\]|measures\[\d+\]\.filters\[\d+\])$/,
  grain: /^groupings\[\d+\]$/,
  breakdown: /^groupings\[\d+\]$/,
  entity: /^(?:groupings\[\d+\]|geography\.places\[\d+\])$/,
  list: /^groupings\[\d+\]$/,
  share: /^statistics\[\d+\]$/,
  statistic: /^statistics\[\d+\]$/,
  rank: /^transforms\[\d+\]$/,
  change: /^transforms\[\d+\]$/,
  rolling: /^transforms\[\d+\]$/,
  combine: /^(?:geography\.combine|period)$/,
  cohort: /^coverage\.cohort$/,
};

/** Ledger filter dimension prefixes (lib/nibrs-question-types.ts filterLabel) -> semantic dimension name endings. */
const FILTER_DIMENSIONS: Record<string, string[]> = {
  sex: ["sex"], age: ["age"], race: ["race"], ethnicity: ["ethnicity"], weapon: ["weapon"], drug: ["drug_type"],
  location: ["location_type"], loss: ["loss_type"], relationship: ["relationship"], bias: ["bias"], dv: ["relationship"],
  clearance: ["clearance", "cleared_exceptionally"],
};

function at(plan: NibrsPlan, path: string): unknown {
  let x: unknown = plan;
  for (const k of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (x === null || typeof x !== "object" || !(k in (x as object))) return undefined;
    x = (x as Record<string, unknown>)[k];
  }
  return x;
}

/** Does the plan value at the binding's path carry the part's value? Concepts without a check pass on path alone. */
function valueApplied(part: PartRef, target: unknown): string | null {
  const v = part.value ?? "";
  if (!v) return null;
  if (part.concept === "measure") {
    const id = (target as { id?: string })?.id ?? "";
    return id.endsWith(`.${v}`) ? null : `measure "${id}" does not apply "${v}"`;
  }
  if (part.concept === "unit") {
    const u = String(target);
    return v.replace(/s$/, "") === u ? null : `unit ${u} does not apply "${v}"`;
  }
  if (part.concept === "place") {
    const p = target as { kind?: string; code?: string; label?: string };
    if (v === "national") return p.kind === "national" ? null : "the nation is not this place";
    const st = /^state:(.+)$/.exec(v);
    if (st) return p.kind === "state" ? null : `state ${st[1]} is not this place`;
    const ag = /^(?:city|county):([^:]+):/.exec(v);
    if (ag) return p.kind === "agency" && (p.label ?? "").toLowerCase().includes(ag[1].toLowerCase()) ? null : `"${ag[1]}" is not this place`;
    return null;
  }
  if (part.concept === "filter" || part.concept === "clearance-reason") {
    const [dim, val] = v.split(":");
    const f = target as Filter;
    const attrs = f.kind === "attribute" ? [f] : f.where;
    const ends = FILTER_DIMENSIONS[dim] ?? [dim];
    const hit = attrs.some((a) => ends.some((e) => a.dimension.endsWith(`.${e}`)) && (val === undefined || (a.values ?? []).map(String).includes(val) || a.op === "between" || a.op === "is_known" || a.op === "is_unknown"));
    return hit ? null : `no condition on ${dim} = ${val ?? "?"} at this path`;
  }
  if (part.concept === "period") {
    const m = /^(?:year:(\d{4})|(?:range|between):(\d{4}):(\d{4})|monthrange:(\d{4}-\d{2}):(\d{4}-\d{2})|month:(\d{4}-\d{2})|since:(\d{4}))$/.exec(v);
    if (!m) return null;
    const p = target as { kind?: string; from?: string; to?: string; years?: number[] };
    const want = m[1] ? [`${m[1]}-01`, `${m[1]}-12`] : m[2] ? [`${m[2]}-01`, `${m[3]}-12`] : m[4] ? [m[4], m[5]] : m[6] ? [m[6], m[6]] : null;
    if (m[7]) return p.kind === "since" && p.from === `${m[7]}-01` ? null : `period does not start in ${m[7]}`;
    return want && p.from === want[0] && p.to === want[1] ? null : `period ${p.from}..${p.to} does not apply "${v}"`;
  }
  return null;
}

/**
 * A1 every meaningful part (clause 0, and inherited parts) is bound; A2 the path exists; A3 the path is one this
 * concept may bind to; A4 the plan value at the path carries the part's value. A part cannot be "applied" by binding
 * it somewhere that does not carry it.
 */
export function validateBindings(plan: NibrsPlan, parts: PartRef[]): PlanProblem[] {
  const out: PlanProblem[] = [];
  const id = (p: PartRef) => `${p.clause}:${p.span[0]}:${p.span[1]}:${p.inherited}`;
  const bound = new Map(plan.bindings.map((b) => [id(b.part), b]));
  for (const part of parts) {
    const b = bound.get(id(part));
    if (!b) { out.push({ rule: "A1", path: "bindings", message: `"${part.text}" (${part.concept}) is not applied` }); continue; }
    const target = at(plan, b.path);
    if (target === undefined) { out.push({ rule: "A2", path: b.path, message: `"${part.text}" is bound to a path the plan does not have` }); continue; }
    const allowed = CONCEPT_PATHS[part.concept];
    if (allowed && !allowed.test(b.path)) { out.push({ rule: "A3", path: b.path, message: `a ${part.concept} cannot be applied at ${b.path}` }); continue; }
    const wrong = valueApplied(part, target);
    if (wrong) out.push({ rule: "A4", path: b.path, message: `"${part.text}": ${wrong}` });
  }
  return out;
}
