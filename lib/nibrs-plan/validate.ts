/**
 * Plan validation (spec: docs/superpowers/specs/2026-10-28-nibrs-plan-language.md, "Validation").
 *
 *   parsePlan (plan.ts)        P0  reader JSON against the strict schema: shapes, discriminants, integers, months,
 *                                  and no unknown fields (an unsupported field is refused, never stripped)
 *   validatePlanShape          P1-P14 rules that need no semantic layer
 *   validatePlanSemantics      S1-S12 rules against a pinned semantic-layer version
 *   validateBindings           A1-A4  request accounting: every part bound, by path AND by value
 *   validateResolved (resolve) R1-R6  rules that need the pinned release
 *
 * Each returns problems; an empty list means valid. A plan with any problem is never compiled.
 */
import type { AttributeFilter, Filter, NibrsPlan, PartRef, Period } from "./plan";
import { PLAN_VERSION } from "./plan";
import type { SemanticDimension, SemanticLayer } from "./semantic";
import { pathCardinality } from "./semantic";

export type PlanProblem = { rule: string; path: string; message: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const dupes = <T>(xs: T[]) => xs.filter((x, i) => xs.findIndex((y) => same(x, y)) !== i);
const TRANSFORM_ORDER = { rolling: 0, period_comparison: 1, rank: 2 } as const;

/** Every attribute condition in a plan, with its path: global filters, measure filters, existence conditions. */
export function attributeConditions(plan: NibrsPlan): [AttributeFilter, string][] {
  const out: [AttributeFilter, string][] = [];
  const add = (f: Filter, path: string) => {
    if (f.kind === "attribute") out.push([f, path]);
    else f.where.forEach((w, k) => out.push([w, `${path}.where[${k}]`]));
  };
  plan.filters.forEach((f, i) => add(f, `filters[${i}]`));
  plan.measures.forEach((m, i) => (m.filters ?? []).forEach((f, j) => add(f, `measures[${i}].filters[${j}]`)));
  return out;
}

function attributeShape(f: AttributeFilter, path: string): PlanProblem[] {
  const n = f.values?.length ?? 0;
  if ((f.op === "in" || f.op === "not_in") && n < 1) return [{ rule: "P7", path, message: `${f.op} needs values` }];
  if (f.op === "between" && n !== 2) return [{ rule: "P7", path, message: "between takes two values" }];
  if ((f.op === "is_unknown" || f.op === "is_known") && n) return [{ rule: "P7", path, message: `${f.op} takes no values` }];
  return [];
}

/**
 * One validator for every attribute condition, wherever it sits: codes must be the dimension's codes, `between` needs
 * a numerically decoded dimension and ascending integer bounds, and every code must be valid in every year of
 * `years` (the plan's own years before resolution, the resolved years after).
 */
export function attributeValueProblems(f: AttributeFilter, d: SemanticDimension, years: [number, number] | null, path: string): PlanProblem[] {
  const out: PlanProblem[] = [];
  if (f.op === "between") {
    const [a, b] = (f.values ?? []).map(Number);
    if (!d.numeric) out.push({ rule: "S11", path, message: `between needs a numeric dimension; ${d.id} is coded` });
    else if (!Number.isInteger(a) || !Number.isInteger(b) || a > b || a < d.numeric.min || b > d.numeric.max) out.push({ rule: "S11", path, message: `between needs ascending integers within ${d.numeric.min}-${d.numeric.max}` });
    return out;
  }
  for (const v of (f.values ?? []).map(String)) {
    const known = (d.values && v in d.values) || d.unknownCodes.includes(v) || (d.numeric && (v in d.numeric.special || (/^\d+$/.test(v) && +v >= d.numeric.min && +v <= d.numeric.max)));
    if ((d.values || d.numeric) && !known) { out.push({ rule: "S11", path, message: `"${v}" is not a code of ${d.id}` }); continue; }
    const vy = d.valueYears?.[v];
    if (vy && years && (years[0] < vy[0] || years[1] > vy[1])) out.push({ rule: "S7", path, message: `code "${v}" of ${d.id} exists for ${vy[0]}-${vy[1]}` });
  }
  return out;
}

/** Whether a period spans more than one data year; null for relative periods, decided after resolution (R5). */
function multiYear(p: Period): boolean | null {
  if (p.kind === "absolute") return p.from.slice(0, 4) !== p.to.slice(0, 4);
  if (p.kind === "years") return p.years.length > 1;
  if (p.kind === "latest_calendar_year_in_release" || p.kind === "latest_month_in_release") return false;
  return null;
}

/**
 * The rates whose cells must each lie in one data year by the plan's own period: rates not evaluated through a
 * period comparison (those are checked by P13), in a plan with no time.year or time.month grouping.
 */
export function ungroupedRates(plan: NibrsPlan): string[] {
  const dims = plan.groupings.map((g) => g.dimension);
  if (dims.includes("time.year") || dims.includes("time.month")) return [];
  const compared = new Set(plan.transforms.flatMap((t) => (t.kind === "period_comparison" ? t.of : [])));
  return plan.statistics.filter((s) => s.kind === "rate" && !compared.has(s.as)).map((s) => s.as);
}

export function validatePlanShape(plan: NibrsPlan): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });

  if (plan.version !== PLAN_VERSION) add("P1", "version", `expected ${PLAN_VERSION}`);

  // P2: measures and statistics share one namespace, so a transform's target is never ambiguous.
  const measureNames = plan.measures.map((m) => m.as);
  const statNames = plan.statistics.map((s) => s.as);
  for (const n of dupes([...measureNames, ...statNames])) add("P2", "names", `"${n}" names two things`);
  const statKind = new Map(plan.statistics.map((s) => [s.as, s.kind]));

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
  for (const [f, path] of attributeConditions(plan)) out.push(...attributeShape(f, path));
  const exists = [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].filter((f) => f.kind === "exists");
  exists.forEach((f) => {
    if (f.kind === "exists" && f.entity === "property" && f.attribution !== "incident_level_only") add("P9", "filters", "property is linked to the incident, not an offense: set attribution 'incident_level_only'");
  });

  // P10: a same-agencies cohort compares periods.
  const hasComparison = plan.transforms.some((t) => t.kind === "period_comparison");
  if (plan.coverage.cohort === "same_agencies" && !hasComparison && !groupDims.some((d) => d.startsWith("time."))) {
    add("P10", "coverage.cohort", "a same-agencies cohort needs periods to compare");
  }

  // P11-P13: transforms.
  const compared = new Map<string, string[]>();
  plan.transforms.forEach((t, i) => {
    const path = `transforms[${i}]`;
    if (i && TRANSFORM_ORDER[t.kind] < TRANSFORM_ORDER[plan.transforms[i - 1].kind]) add("P11", path, "transforms run rolling, then period_comparison, then rank");
    if (t.kind === "rank") return;
    for (const x of t.of) if (!statNames.includes(x)) add("P11", path, `unknown statistic "${x}"`);
    if (t.kind === "rolling") {
      if (!groupDims.includes("time.month")) add("P11", path, "a rolling window needs the time.month grouping");
      if (hasComparison) add("P11", path, "a rolling window and a period comparison are not combined in v1");
      for (const x of t.of) if (statKind.get(x) === "rate") add("P11", path, "a rate inside a rolling window is not supported in v1");
    }
    if (t.kind === "period_comparison") {
      for (const q of [t.earlier, t.later]) if (q.from > q.to) add("P13", path, "a comparison period ends before it starts");
      if (t.earlier.to >= t.later.from) add("P13", path, "the earlier period must end before the later one starts");
      if (p.kind === "absolute" && (t.earlier.from < p.from || t.later.to > p.to)) add("P13", path, "comparison periods must lie inside the plan's period");
      if (t.of.some((x) => statKind.get(x) === "rate") && [t.earlier, t.later].some((q) => q.from.slice(0, 4) !== q.to.slice(0, 4))) add("P13", path, "a compared rate needs each period inside one data year");
      for (const x of t.of) {
        if (compared.has(x)) add("P13", path, `"${x}" is compared twice; its outputs would collide`);
        compared.set(x, t.outputs);
      }
    }
  });
  const ranks = plan.transforms.filter((t) => t.kind === "rank");
  if (ranks.length > 1) add("P12", "transforms", "one rank per plan");
  plan.transforms.forEach((t, i) => {
    if (t.kind !== "rank") return;
    const path = `transforms[${i}]`;
    const [base, output] = t.by.split(".");
    if (!statNames.includes(base)) add("P12", path, `unknown statistic "${base}"`);
    const outs = compared.get(base);
    if (outs && !output) add("P12", path, `"${base}" is compared: rank by one of its outputs (${outs.map((o) => `${base}.${o}`).join(", ")})`);
    if (outs && output && !outs.includes(output as never)) add("P12", path, `the comparison of "${base}" has no ${output} output`);
    if (!outs && output) add("P12", path, `"${base}" is not compared; it has no ${output}`);
    for (const d of t.per) if (!groupDims.includes(d)) add("P12", path, `per "${d}" is not a grouping`);
    if (!groupDims.some((d) => !t.per.includes(d))) add("P12", path, "nothing is left to rank within each group");
  });

  // P14: a rate's population is one data year's, so a rate spans one year per cell.
  if (multiYear(p) === true) for (const r of ungroupedRates(plan)) {
    add("P14", "statistics", `rate "${r}" spans several data years: group by time.year or time.month, or compare one-year periods`);
  }
  return out;
}

export function planYears(p: Period): [number, number] | null {
  if (p.kind === "absolute") return [Number(p.from.slice(0, 4)), Number(p.to.slice(0, 4))];
  if (p.kind === "years") return [p.years[0], p.years[p.years.length - 1]];
  return null; // relative: checked after resolution (R1)
}

export function validatePlanSemantics(plan: NibrsPlan, layer: SemanticLayer): PlanProblem[] {
  const out: PlanProblem[] = [];
  const add = (rule: string, path: string, message: string) => out.push({ rule, path, message });
  if (plan.source !== layer.source) add("S1", "source", `plan reads ${plan.source}, layer describes ${layer.source}`);
  if (plan.semanticVersion !== layer.version) add("S1", "semanticVersion", `plan was read against ${plan.semanticVersion}, layer is ${layer.version}`);
  const years = planYears(plan.period);
  const units = new Map(plan.measures.map((m) => [m.as, m.unit]));

  // Codes and eras of every attribute condition, wherever it sits (S3, S7, S11).
  for (const [f, path] of attributeConditions(plan)) {
    const d = layer.dimension(f.dimension);
    if (!d) { add("S3", path, `unknown dimension "${f.dimension}"`); continue; }
    if (years && (years[0] < d.validYears[0] || years[1] > d.validYears[1])) add("S7", path, `"${f.dimension}" is recorded for ${d.validYears[0]}-${d.validYears[1]}`);
    out.push(...attributeValueProblems(f, d, years, path));
  }

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
      if (!d) { if (how === "group") add("S3", path, `unknown dimension "${dimension}"`); return; }
      if (how === "group" && years && (years[0] < d.validYears[0] || years[1] > d.validYears[1])) add("S7", path, `"${dimension}" is recorded for ${d.validYears[0]}-${d.validYears[1]}`);
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
      // belongs to the target.
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
        if (d && d.entity !== f.entity) add("S4", `${path}.where[${k}]`, `"${w.dimension}" belongs to ${d.entity}, not ${f.entity}`);
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
    // A composite's share needs the SAME composite as denominator (its own filters aside): two composites share a
    // unit label ("fbi_standard") without sharing a meaning.
    if (s.kind === "share" && s.denominator) {
      const [n, d] = [sm(s.measure), sm(s.denominator)];
      if (n && d && (n.aggregation.kind === "composite" || d.aggregation.kind === "composite") && n.id !== d.id) add("S12", `statistics[${i}]`, "a composite's share needs the same composite as its denominator");
    }
    if (s.kind === "rate" && sm(s.measure) && !sm(s.measure)!.additive.acrossAgencies) add("S12", `statistics[${i}]`, "a rate needs a measure that adds across agencies");
  });
  return out;
}

/* ------------------------------------------------------------------ request accounting --------------------------- */

const STATE_CODE: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE", "District of Columbia": "DC",
  Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME",
  Maryland: "MD", Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH", Oklahoma: "OK",
  Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY", "Puerto Rico": "PR",
};
const UNIT_OF: Record<string, string> = { victims: "victim", offenses: "offense", offenders: "offender", arrests: "arrest", incidents: "incident", pairs: "victim_offender", dollars: "dollars" };
/** Ledger filter dimensions (lib/nibrs-question-types.ts filterLabel) -> semantic dimension name endings. */
const FILTER_DIMENSIONS: Record<string, string[]> = {
  sex: ["sex"], age: ["age"], race: ["race"], ethnicity: ["ethnicity"], weapon: ["weapon"], drug: ["drug_type"],
  location: ["location_type"], loss: ["loss_type"], relationship: ["relationship"], bias: ["bias"], dv: ["relationship"],
  clearance: ["exceptional_clearance", "clearance_type", "clearance_method"],
};
/** Ledger filter values that name a range or a family rather than one code: the exact condition they mean. */
const FILTER_VALUE_RANGE: Record<string, [number, number]> = { "age:Under 18": [1, 17] };
const FILTER_VALUE_SET: Record<string, string[]> = {
  "weapon:firearm": ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"],
  "dv:intimate_partner": ["SE", "CS", "BG", "XS", "XR", "HR"],
  "dv:family": ["CH", "PA", "SB", "OF", "SC", "SP", "GP", "GC", "IL", "CF", "BE"],
  "location:commercial": ["02", "03", "05", "07", "08", "09", "12", "14", "17", "19", "21", "23", "24", "40", "41", "47", "55"],
};
const sameSet = (a: unknown[], b: string[]) => a.length === b.length && b.every((x) => a.map(String).includes(x));

function at(plan: NibrsPlan, path: string): unknown {
  let x: unknown = plan;
  for (const k of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (x === null || typeof x !== "object" || !(k in (x as object))) return undefined;
    x = (x as Record<string, unknown>)[k];
  }
  return x;
}

const PERIOD_FORMS: [RegExp, (m: RegExpExecArray) => Period][] = [
  [/^year:(\d{4})$/, (m) => ({ kind: "absolute", from: `${m[1]}-01`, to: `${m[1]}-12` })],
  [/^(?:range|between):(\d{4}):(\d{4})$/, (m) => ({ kind: "absolute", from: `${Math.min(+m[1], +m[2])}-01`, to: `${Math.max(+m[1], +m[2])}-12` })],
  [/^years:(\d{4}):(\d{4})$/, (m) => ({ kind: "years", years: [+m[1], +m[2]].sort((a, b) => a - b) })],
  [/^month:(\d{4}-\d{2})$/, (m) => ({ kind: "absolute", from: m[1], to: m[1] })],
  [/^monthrange:(\d{4}-\d{2}):(\d{4}-\d{2})$/, (m) => ({ kind: "absolute", from: m[1], to: m[2] })],
  [/^since:(\d{4})$/, (m) => ({ kind: "since", from: `${m[1]}-01` })],
  [/^last:(\d+)$/, (m) => ({ kind: "last_n", unit: "years", count: +m[1] })],
  [/^lastyear$/, () => ({ kind: "previous_calendar_year" })],
  [/^latest$/, () => ({ kind: "latest_calendar_year_in_release" })],
];

/**
 * Does the plan value at the binding's path carry the part's value? Every concept has an explicit check; a concept
 * without one cannot be bound at all (A3), so an unsupported condition can never be marked applied.
 */
/**
 * Authoritative place identity, from the app's geography resolver (never the plan's display label): the ORIs a
 * ledger place value ("city:Baltimore:MD") resolves to. null when the resolver does not know the place.
 */
export type PlaceAuthority = (ledgerValue: string) => { oris: string[]; fips?: string[] } | null;

function valueApplied(plan: NibrsPlan, part: PartRef, path: string, target: unknown, places: PlaceAuthority, clearanceAsked: boolean): string | null {
  const v = part.value ?? "";
  const t = target as Record<string, unknown>;
  switch (part.concept) {
    case "measure":
      if (!/^measures\[\d+\]$/.test(path)) return "a measure binds to measures[i]";
      {
        // Ids are "<unit>.<name>@<version>" or a qualified composite "<name>.<variant>@<version>" (violent_crime.ucr@1).
        const parts = String(t.id ?? "").replace(/@\d+$/, "").split(".");
        // A cleared-offense measure applies its offense ("rape clearances": offenses.rape_cleared), but only when the
        // question asks about clearances; otherwise it would answer a subset of what was asked.
        const last = parts[parts.length - 1];
        return last === v || (clearanceAsked && last === `${v}_cleared`) || parts[0] === v ? null : `the measure at ${path} is not "${v}"`;
      }
    case "unit":
      if (!/^measures\[\d+\]\.unit$/.test(path)) return "a unit binds to measures[i].unit";
      // "arrests" is Group A arrestees or Group B arrests, as the offense decides.
      return UNIT_OF[v] === target || (v === "arrests" && target === "group_b_arrest") ? null : `unit ${String(target)} does not apply "${v}"`;
    case "place": {
      // A ranking's place is its scope: the agency set's `within`.
      if (!/^geography\.places\[\d+\](?:\.within)?$/.test(path)) return "a place binds to geography.places";
      if (v === "national") return t.kind === "national" ? null : "this place is not the nation";
      const st = /^state:(.+)$/.exec(v);
      if (st) return t.kind === "state" && t.code === STATE_CODE[st[1]] ? null : `this place is not ${st[1]}`;
      const ag = /^(city|county):([^:]+):([A-Z]{2})?$/.exec(v);
      if (ag) {
        const known = places(v);
        if (!known) return `place "${v}" has no mapping`;
        if (t.kind === "agency") return known.oris.includes(String(t.ori)) ? null : `ORI ${String(t.ori)} is not ${ag[2]}${ag[3] ? `, ${ag[3]}` : ""}`;
        if (t.kind === "county") return (known.fips ?? []).includes(String(t.fips)) ? null : `county ${String(t.fips)} is not ${ag[2]}`;
        return `this place is not ${ag[2]}`;
      }
      return `place value "${v}" has no mapping`;
    }
    case "threshold": {
      const [op, n] = v.split("|");
      const preds = (t.kind === "agency_set" ? (t.where as { field: string; op: string; value: unknown }[]) : []);
      return preds.some((q) => q.field === "agency.population" && q.op === op && q.value === Number(n)) ? null : `no population ${op} ${n} at ${path}`;
    }
    case "period": {
      const form = PERIOD_FORMS.find(([re]) => re.test(v));
      if (!form) return `period value "${v}" has no mapping`;
      return same(form[1](form[0].exec(v)!), target) ? null : `the period at ${path} does not apply "${v}"`;
    }
    case "filter":
    case "clearance-reason": {
      const [dim, val] = v.split(":");
      const f = target as Filter;
      if (!f || (f.kind !== "attribute" && f.kind !== "exists")) return "a condition binds to a filter";
      const ends = FILTER_DIMENSIONS[dim];
      if (!ends) return `filter dimension "${dim}" has no mapping`;
      const range = FILTER_VALUE_RANGE[v];
      const conds = f.kind === "attribute" ? [f] : f.negate ? [] : f.where;
      // The condition must MEAN the part exactly: the same range, the same family, or exactly the one code.
      const want = FILTER_VALUE_SET[v] ?? [val];
      const hit = conds.some((a) => ends.some((e) => a.dimension.endsWith(`.${e}`)) && (
        range ? a.op === "between" && same((a.values ?? []).map(Number), range)
          : a.op === "in" && sameSet(a.values ?? [], want)));
      return hit ? null : `no condition meaning exactly ${dim} = ${val} at ${path}`;
    }
    case "grain": {
      const want = v === "month" ? "time.month" : v === "year" ? "time.year" : null;
      return want && (t as { dimension?: string }).dimension === want ? null : `grouping at ${path} is not by ${v}`;
    }
    case "breakdown": {
      const dim = String(t.dimension ?? "");
      const whose = /^(offender|victim|arrestee)-age$/.exec(v);
      const name = ({ location: "location_type" } as Record<string, string>)[v] ?? v.replace(/-/g, "_");
      const ok = whose ? dim === `${whose[1]}.age` || dim === `victim_offender.${whose[1]}_age` : dim.split(".").pop() === name;
      return ok ? null : `grouping at ${path} is not by ${v}`;
    }
    case "entity":
    case "list": {
      const ent = v.replace(/^list:/, "");
      const want = ent === "state" ? "geo.state" : ent === "city" || ent === "agency" || ent === "county" ? "geo.agency" : null;
      if (want && t.dimension === want) return null;
      if (path.startsWith("geography.places") && (t.kind === "agency_set" || (ent === "state" && t.kind === "state"))) return null;
      return `${path} does not group or select ${ent}`;
    }
    case "statistic": {
      // Rates are per 100,000 people in this product (today's rule); the multiplier is part of the value.
      if (["rate", "per100k", "percapita"].includes(v)) return t.kind === "rate" && t.per === 100000 ? null : `statistic at ${path} is not a rate per 100,000`;
      const want = v === "average_value" ? "ratio" : "count";
      return t.kind === want ? null : `statistic at ${path} is not a ${want}`;
    }
    case "share":
      return t.kind === "share" || t.kind === "ratio" ? null : `statistic at ${path} is not a share`;
    case "clearance":
      if (v === "rate") return t.kind === "ratio" ? null : "a clearance rate binds to a ratio";
      // A cleared-offense measure, or a breakdown by clearance type or method (cleared and not cleared).
      return /cleared/.test(String(t.id ?? "")) || t.kind === "ratio" || /^offense\.clearance_(?:type|method)$/.test(String(t.dimension ?? "")) ? null : `nothing at ${path} counts clearances`;
    case "rank": {
      const m = /^(top|bottom):(\d*)$/.exec(v);
      if (!m) return `rank value "${v}" has no mapping`;
      const limit = m[2] ? Number(m[2]) : null;
      return t.kind === "rank" && t.direction === m[1] && (limit === null || t.limit === limit) ? null : `the rank at ${path} is not ${v}`;
    }
    case "change":
      return t.kind === "period_comparison" ? null : "a change binds to a period comparison";
    case "rolling":
      return t.kind === "rolling" ? null : "a rolling request binds to a rolling transform";
    case "combine":
      return (path === "geography.combine" && target === "combined") || (path === "period" && !plan.groupings.some((g) => g.dimension.startsWith("time."))) ? null : "nothing combines here";
    case "cohort":
      return path === "coverage.cohort" && target === "same_agencies" ? null : "a cohort binds to coverage.cohort same_agencies";
    default:
      return `"${part.concept}" cannot be applied by a plan`;
  }
}

/**
 * A1 every meaningful part (clause 0, and inherited parts) is bound; A2 the path exists; A3/A4 the plan value at the
 * path carries the part's value, by an explicit per-concept rule (A3 when the concept has no rule or the path is the
 * wrong kind, A4 when the value differs).
 */
export function validateBindings(plan: NibrsPlan, parts: PartRef[], places: PlaceAuthority): PlanProblem[] {
  const out: PlanProblem[] = [];
  const id = (p: PartRef) => `${p.clause}:${p.span[0]}:${p.span[1]}:${p.inherited}`;
  const bound = new Map(plan.bindings.map((b) => [id(b.part), b]));
  const clearanceAsked = parts.some((p) => p.concept === "clearance" || p.concept === "clearance-reason" || (p.concept === "filter" && (p.value ?? "").startsWith("clearance:")));
  for (const part of parts) {
    const b = bound.get(id(part));
    if (!b) { out.push({ rule: "A1", path: "bindings", message: `"${part.text}" (${part.concept}) is not applied` }); continue; }
    const target = at(plan, b.path);
    if (target === undefined) { out.push({ rule: "A2", path: b.path, message: `"${part.text}" is bound to a path the plan does not have` }); continue; }
    const wrong = valueApplied(plan, part, b.path, target, places, clearanceAsked);
    if (wrong) out.push({ rule: /has no mapping|cannot be applied|binds to/.test(wrong) ? "A3" : "A4", path: b.path, message: `"${part.text}": ${wrong}` });
  }
  return out;
}
