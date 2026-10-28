/**
 * From today's reader to the plan language: a typed spec (lib/nibrs-question-types.ts, N1-N7) and its request ledger
 * become a NibrsPlan, with every part of the question bound to the plan path that applies it. The plan is then
 * validated like any reader output (validate.ts, resolve.ts). Nothing here runs SQL.
 *
 * This is the bridge that lets the new engine answer what today's reader already understands while the plan-filling
 * reader is built, and it measures how much of today's traffic the new engine can reach
 * (scripts/nibrs-plan-reachability.ts).
 *
 * Place identity is an input: the ORIs come from the app's geography resolver (resolveNibrsPlaces at run time), never
 * from the spec's display text.
 */
import type { RequestLedger } from "../request-accounting";
import { GROUP_B, MEASURE_CODES, PERSON_CODES, type NibrsSpec, type NPeriod, type NPlace } from "../nibrs-question-types";
import { COMMERCIAL_LOCATION_CODES } from "../nibrs-codes";
import type { AttributeFilter, CountingUnit, Filter, Grouping, MeasureSpec, NibrsPlan, PartBinding, PartRef, Period, Place, Statistic, Transform } from "./plan";
import { PLAN_VERSION } from "./plan";

export type AdapterDeps = {
  semanticVersion: string;
  /** The app's geography resolver: the plan place for a ledger place value ("city:Fort Worth:TX"), or null. */
  resolvePlace(value: string, place: NPlace): Place | null;
};

export type AdapterResult =
  | { kind: "plan"; plan: NibrsPlan; parts: PartRef[] }
  | { kind: "unmapped"; reason: string };

const FIREARM = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
const DV: Record<string, string[]> = {
  intimate_partner: ["SE", "CS", "BG", "XS", "XR", "HR"],
  family: ["CH", "PA", "SB", "OF", "SC", "SP", "GP", "GC", "IL", "CF", "BE"],
};
/** Today's age groups (scripts/nibrs-auto-update.py age_group_expr), as bins; special codes stay their own categories. */
const AGE_BINS = [
  { label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "25-34", from: 25, to: 34 },
  { label: "35-44", from: 35, to: 44 }, { label: "45-54", from: 45, to: 54 }, { label: "55-64", from: 55, to: 64 },
  { label: "65+", from: 65, to: 99 },
];
const COMPOSITES: Record<string, { id: string; unit: CountingUnit }> = {
  violent_crime: { id: "violent_crime.ucr", unit: "fbi_standard" },
  property_crime: { id: "property_crime.ucr", unit: "offense" },
  all_crime: { id: "all_crime.offenses", unit: "offense" },
};
const FAMILY_DEFAULT_UNIT: Record<string, CountingUnit> = {
  carjacking: "incident", domestic_violence: "victim", hate_crime: "offense",
  motor_vehicle_property: "dollars", property_value: "dollars",
};
const UNIT_OF: Record<string, CountingUnit> = { victims: "victim", offenders: "offender", arrests: "arrest", offenses: "offense", incidents: "incident", pairs: "victim_offender", dollars: "dollars" };
const PLURAL: Record<string, string> = { group_b_arrest: "group_b_arrests", victim: "victims", offender: "offenders", arrest: "arrests", offense: "offenses", incident: "incidents", victim_offender: "victim_offender", dollars: "property", property_segment: "property" };
/** The entity a counting unit counts, for filters and groupings on its attributes. */
const ENTITY: Record<string, string> = { group_b_arrest: "group_b_arrest", victim: "victim", offender: "offender", arrest: "arrestee", offense: "offense", incident: "incident", victim_offender: "victim_offender", fbi_standard: "incident", dollars: "property" };

/** A Group B offense (DUI ...) is recorded only as Group B arrests, counted by arrest date. */
export const isGroupB = (measure: string) => (MEASURE_CODES[measure] ?? []).length > 0 && MEASURE_CODES[measure].every((c) => GROUP_B.has(c));

export function unitFor(measure: string, unit: string | null): CountingUnit {
  if (isGroupB(measure)) return "group_b_arrest";
  if (unit) return UNIT_OF[unit] ?? "offense";
  if (COMPOSITES[measure]) return COMPOSITES[measure].unit;
  if (FAMILY_DEFAULT_UNIT[measure]) return FAMILY_DEFAULT_UNIT[measure];
  const codes = MEASURE_CODES[measure] ?? [];
  return codes.length && codes.every((c) => PERSON_CODES.has(c)) ? "victim" : "offense";
}

export function measureId(measure: string, unit: CountingUnit): string {
  if (COMPOSITES[measure] && unit === COMPOSITES[measure].unit) return COMPOSITES[measure].id;
  if (measure === "motor_vehicle_property" || measure === "property_value") return `property.${measure}`;
  return `${PLURAL[unit] ?? "offenses"}.${measure}`;
}

function period(p: NPeriod): Period | null {
  switch (p.form) {
    case "year": return { kind: "absolute", from: `${p.year}-01`, to: `${p.year}-12` };
    case "range": return { kind: "absolute", from: `${p.from}-01`, to: `${p.to}-12` };
    case "years": return { kind: "years", years: [...p.list].sort((a, b) => a - b) };
    case "month": { const m = `${p.year}-${String(p.month).padStart(2, "0")}`; return { kind: "absolute", from: m, to: m }; }
    case "monthrange": return { kind: "absolute", from: `${p.from[0]}-${String(p.from[1]).padStart(2, "0")}`, to: `${p.to[0]}-${String(p.to[1]).padStart(2, "0")}` };
    case "since": return { kind: "since", from: `${p.from}-01` };
    case "last": return { kind: "last_n", unit: "years", count: p.n };
    case "lastyear": return { kind: "previous_calendar_year" };
    case "latest": case "none": return { kind: "latest_calendar_year_in_release" };
  }
}

/** One spec filter ("sex:F", "weapon:firearm", "dv:family" ...) as a plan filter on the counted entity. */
export function filterFor(value: string, unit: CountingUnit): Filter | null {
  const [dim, val] = value.split(":");
  const ent = ENTITY[unit] ?? "offense";
  const onEntity = (entity: string, cond: AttributeFilter): Filter =>
    entity === ent ? cond : { kind: "exists", scope: ent, entity, where: [cond], ...(entity === "property" || entity === "property_drug" ? { attribution: "incident_level_only" as const, scope: "incident" } : {}) };
  const attr = (dimension: string, values: (string | number)[], op: AttributeFilter["op"] = "in"): AttributeFilter => ({ kind: "attribute", dimension, op, values });
  const person = ["victim", "offender", "arrestee", "group_b_arrest"].includes(ent) ? ent : "victim";
  switch (dim) {
    case "sex": case "race": case "ethnicity": return onEntity(person, attr(`${person}.${dim}`, [val]));
    case "age": return val === "Under 18" ? onEntity(person, attr(`${person}.age`, [1, 17], "between")) : null;
    case "weapon": return { kind: "exists", scope: ent === "arrestee" ? "arrestee" : ent, entity: "offense_weapon", where: [attr("offense_weapon.weapon", val === "firearm" ? FIREARM : [val])] };
    case "location": return onEntity("offense", attr("offense.location_type", val === "commercial" ? COMMERCIAL_LOCATION_CODES : [val]));
    // Counting property, the loss type applies to the counted segments; counting anything else, to the incident.
    case "loss": return ent === "property" ? attr("property.loss_type", [val]) : { kind: "exists", scope: "incident", entity: "property", attribution: "incident_level_only", where: [attr("property.loss_type", [val])] };
    case "drug": return { kind: "exists", scope: "incident", entity: "property_drug", attribution: "incident_level_only", where: [attr("property_drug.drug_type", [val])] };
    case "dv": return DV[val] ? { kind: "exists", scope: "victim", entity: "victim_offender", where: [attr("victim_offender.relationship", DV[val])] } : null;
    case "relationship": return { kind: "exists", scope: "victim", entity: "victim_offender", where: [attr("victim_offender.relationship", [val])] };
    case "bias": return { kind: "exists", scope: "offense", entity: "offense_bias", where: [attr("offense_bias.bias", [val])] };
    case "clearance":
      return ["arrest", "exceptional"].includes(val) ? onEntity("offense", attr("offense.clearance_method", [val])) : onEntity("offense", attr("offense.clearance_type", [val]));
    default: return null;
  }
}

/** A breakdown dimension as a grouping, from the counted entity's point of view. */
export function groupingFor(dim: string, unit: CountingUnit): Grouping | null {
  const ent = ENTITY[unit] ?? "offense";
  const g = (dimension: string, extra: Partial<Grouping> = {}): Grouping => ({ dimension, unknown: "visible", absent: "show", ...extra });
  const person = ["victim", "offender", "arrestee", "group_b_arrest"].includes(ent) ? ent : "victim";
  switch (dim) {
    case "age": return g(`${person}.age`, { bins: AGE_BINS });
    case "offender-age": return g("offender.age", { bins: AGE_BINS });
    case "victim-age": return g("victim.age", { bins: AGE_BINS });
    case "arrestee-age": return g("arrestee.age", { bins: AGE_BINS });
    case "sex": case "race": case "ethnicity": return g(`${person}.${dim}`);
    case "location": return ent === "offense" ? g("offense.location_type") : g("offense.location_type", { multiValue: "each_value" });
    case "weapon": return g("offense_weapon.weapon", { multiValue: "each_value" });
    case "clearance-type": return g("offense.clearance_type");
    case "clearance-method": return g("offense.clearance_method");
    case "relationship": return g("victim_offender.relationship", { multiValue: "each_value" });
    case "offense": return ent === "offense" ? g("offense.offense") : g("victim_offense.offense", { multiValue: "each_value" });
    case "victim-offender-race": return g("victim_offender.victim_offender_race");
    case "hour": return g("incident.hour");
    case "drug": return g("property_drug.drug", { multiValue: "each_value" });
    default: return null;
  }
}

export function planFromSpec(spec: NibrsSpec, ledger: RequestLedger, deps: AdapterDeps): AdapterResult {
  const ALL = { cohort: "all_reporting" as const, unknownMonths: "show_unknown" as const, filteredZero: "requires_evidence" as const };
  const measures: MeasureSpec[] = [];
  const filters: Filter[] = [];
  const groupings: Grouping[] = [];
  const statistics: Statistic[] = [];
  const transforms: Transform[] = [];
  const defaults: NibrsPlan["defaults"] = [];
  const filterPath = new Map<string, string>();
  const measurePath = new Map<string, string>();
  let places: Place[] = [];
  let periodValue: Period;

  const addMeasure = (name: string, unit: CountingUnit, as: string, extra: Filter[] = []) => {
    measures.push({ id: measureId(name, unit), unit, as, ...(extra.length ? { filters: extra } : {}) });
    if (!measurePath.has(name)) measurePath.set(name, `measures[${measures.length - 1}]`);
  };
  const addFilters = (values: string[], unit: CountingUnit, into: Filter[], pathOf: (i: number) => string): string | null => {
    for (const v of values) {
      const f = filterFor(v, unit);
      if (!f) return `filter ${v} has no plan form`;
      into.push(f);
      filterPath.set(v, pathOf(into.length - 1));
    }
    return null;
  };
  const resolve = (p: NPlace): Place | null => {
    if (p.kind === "national") return { kind: "national" };
    if (p.kind === "state") return { kind: "state", code: p.code };
    return deps.resolvePlace(`${p.agencyKind}:${p.name}:${p.state}`, p);
  };
  const periodOf = (p: NPeriod, grainNeeded: boolean): Period => {
    const out = period(p)!;
    if (p.form === "none") defaults.push({ path: "period", value: "latest_calendar_year_in_release", reason: grainNeeded ? "no period named: a monthly series covers the latest calendar year whose December the release holds (today's rule)" : "no period named: the latest calendar year whose December the release holds (today's rule)" });
    return out;
  };

  switch (spec.type) {
    case "series": {
      // Clearances count offense records (today's rule), whatever the measure's standard unit; a clearance condition
      // ("cleared by arrest") counts the cleared offenses themselves.
      // "how many rapes were cleared": the ledger's clearance part, which today's typed spec does not carry.
      const clearedWording = ledger.parts.some((p) => p.clause === 0 && p.concept === "clearance" && (p.value === "cleared" || p.value === "clearances"));
      const clearance = spec.statistic === "clearance_rate" || clearedWording || spec.filters.some((f) => f.startsWith("clearance:"));
      const names = [...new Set(spec.measures)];
      const unit0 = clearance ? "offense" : unitFor(names[0], spec.unit);
      for (const m of names) {
        const u = clearance ? "offense" : unitFor(m, spec.unit);
        if (spec.statistic === "clearance_rate") {
          addMeasure(m, u, m);
          addMeasure(`${m}_cleared`, u, `${m}_cleared`);
        } else if (clearance) {
          addMeasure(`${m}_cleared`, u, m);
          measurePath.set(m, `measures[${measures.length - 1}]`);
        } else addMeasure(m, u, m);
      }
      const err = addFilters(spec.filters, unit0, filters, (i) => `filters[${i}]`);
      if (err) return { kind: "unmapped", reason: err };
      places = spec.places.map(resolve).filter((p): p is Place => !!p);
      if (places.length !== spec.places.length) return { kind: "unmapped", reason: "a place did not resolve" };
      if (places.length > 1) groupings.push({ dimension: "geo.place", unknown: "visible", absent: "show" });
      periodValue = periodOf(spec.period, spec.grain === "month");
      if (spec.grain === "month" || spec.grain === "rolling") groupings.push({ dimension: "time.month", unknown: "visible", absent: "show" });
      if (spec.grain === "year") groupings.push({ dimension: "time.year", unknown: "visible", absent: "show" });
      // A fixed list: the loop adds denominator measures, which must not be visited themselves.
      for (const m of measures.filter((x) => !x.as.endsWith("_cleared"))) {
        if (spec.statistic === "rate") statistics.push({ kind: "rate", as: `${m.as}_rate`, measure: m.as, per: 100000 });
        else if (spec.statistic === "clearance_rate") statistics.push({ kind: "ratio", as: `${m.as}_clearance_rate`, numerator: `${m.as}_cleared`, denominator: m.as });
        else if (spec.statistic === "average_value") {
          // The denominator counts the same property as the numerator's dollars (motor-vehicle segments for
          // motor-vehicle value), with the same filters.
          measures.push({ id: `${m.id}_segments`, unit: "property_segment", as: `${m.as}_segments`, ...(m.filters ? { filters: m.filters } : {}) });
          statistics.push({ kind: "ratio", as: `${m.as}_average`, numerator: m.as, denominator: `${m.as}_segments` });
        } else statistics.push({ kind: "count", as: `${m.as}_count`, measure: m.as });
      }
      if (spec.grain === "rolling") transforms.push({ kind: "rolling", of: statistics.map((s) => s.as), months: 12 });
      break;
    }
    case "breakdown": {
      const clearanceDim = spec.dim === "clearance-type" || spec.dim === "clearance-method";
      const unit = spec.dim === "victim-offender-race" ? "victim_offender" : clearanceDim ? "offense" : unitFor(spec.measure, spec.unit);
      if (unit === "fbi_standard" && !["location", "hour", "offense"].includes(spec.dim)) {
        return { kind: "unmapped", reason: `a breakdown of ${spec.measure} by ${spec.dim}: a mixed-unit composite has no single counted person` };
      }
      // Today's clearance breakdowns count every offense, with "not cleared" as its own category, so the parts sum to
      // the reported total; "by exception by type" narrows to the exceptional clearances (its filter).
      addMeasure(spec.measure, unit, spec.measure);
      const err = addFilters(spec.filters, unit, filters, (i) => `filters[${i}]`);
      if (err) return { kind: "unmapped", reason: err };
      const p = resolve(spec.place);
      if (!p) return { kind: "unmapped", reason: "the place did not resolve" };
      places = [p];
      periodValue = periodOf(spec.period, false);
      if (spec.byYear) groupings.push({ dimension: "time.year", unknown: "visible", absent: "show" });
      const g = groupingFor(spec.dim, unit);
      if (!g) return { kind: "unmapped", reason: `breakdown ${spec.dim} has no plan form` };
      groupings.push(g);
      statistics.push({ kind: "count", as: "count", measure: spec.measure });
      statistics.push({ kind: "share", as: "share", measure: spec.measure, within: spec.byYear ? ["time.year"] : [] });
      break;
    }
    case "share": {
      const unit = unitFor(spec.measure, spec.unit);
      const clearedSubset = spec.subset.some((f) => f.startsWith("clearance:"));
      const popName = spec.denominator === "clearances" ? `${spec.measure}_cleared` : spec.measure;
      const popUnit = spec.denominator === "clearances" || clearedSubset ? "offense" : unit;
      const popFilters: Filter[] = [];
      let err = addFilters(spec.population, popUnit, popFilters, (i) => `measures[0].filters[${i}]`);
      if (err) return { kind: "unmapped", reason: err };
      addMeasure(popName, popUnit, "population", popFilters);
      measurePath.set(spec.measure, "measures[0]");
      const subFilters: Filter[] = [...popFilters];
      err = addFilters(spec.subset, popUnit, subFilters, (i) => `measures[1].filters[${i}]`);
      if (err) return { kind: "unmapped", reason: err };
      // A subset defined by a clearance ("rapes that were cleared by exception") counts the cleared offenses.
      addMeasure(clearedSubset ? `${spec.measure}_cleared` : popName, popUnit, "subset", subFilters);
      const p = resolve(spec.place);
      if (!p) return { kind: "unmapped", reason: "the place did not resolve" };
      places = [p];
      periodValue = periodOf(spec.period, false);
      if (spec.byState) groupings.push({ dimension: "geo.state", unknown: "visible", absent: "show" });
      statistics.push({ kind: "ratio", as: "share", numerator: "subset", denominator: "population" });
      break;
    }
    case "rank": {
      const unit = spec.statistic === "clearance_rate" ? "offense" : unitFor(spec.measure, null);
      addMeasure(spec.measure, unit, spec.measure);
      if (spec.statistic === "clearance_rate") addMeasure(`${spec.measure}_cleared`, "offense", `${spec.measure}_cleared`);
      const scope = resolve(spec.scope);
      if (!scope || (scope.kind !== "national" && scope.kind !== "state")) return { kind: "unmapped", reason: "a ranking scope is the nation or a state" };
      if (spec.entity === "state") {
        places = [scope];
        groupings.push({ dimension: "geo.state", unknown: "visible", absent: "show" });
      } else {
        // Cities, or every agency, within the scope: an agency set when there is a type or population condition.
        const where: Extract<Place, { kind: "agency_set" }>["where"] = [];
        if (spec.entity === "city") where.push({ field: "agency.type", op: "in", value: ["city"] });
        if (spec.min) where.push({ field: "agency.population", op: spec.min.op, value: spec.min.amount });
        places = [where.length ? { kind: "agency_set", where, within: scope } : scope];
        groupings.push({ dimension: "geo.agency", unknown: "visible", absent: "show" });
      }
      periodValue = periodOf(spec.period, false);
      const stat: Statistic = spec.statistic === "rate" ? { kind: "rate", as: "rate", measure: spec.measure, per: 100000 }
        : spec.statistic === "clearance_rate" ? { kind: "ratio", as: "clearance_rate", numerator: `${spec.measure}_cleared`, denominator: spec.measure }
          : { kind: "count", as: "count", measure: spec.measure };
      statistics.push(stat);
      transforms.push({ kind: "rank", by: stat.as, direction: spec.rank?.dir ?? "top", per: [], limit: spec.rank?.n ?? null });
      break;
    }
    case "change": {
      const unit = unitFor(spec.measure, spec.unit);
      addMeasure(spec.measure, unit, spec.measure);
      const p = resolve(spec.place);
      if (!p) return { kind: "unmapped", reason: "the place did not resolve" };
      places = [p];
      periodValue = { kind: "absolute", from: `${spec.earlier}-01`, to: `${spec.later}-12` };
      const stat: Statistic = spec.statistic === "rate" ? { kind: "rate", as: "rate", measure: spec.measure, per: 100000 } : { kind: "count", as: "count", measure: spec.measure };
      statistics.push(stat);
      transforms.push({ kind: "period_comparison", of: [stat.as], earlier: { kind: "absolute", from: `${spec.earlier}-01`, to: `${spec.earlier}-12` }, later: { kind: "absolute", from: `${spec.later}-01`, to: `${spec.later}-12` }, outputs: ["earlier", "later", "change", "pct_change"] });
      break;
    }
  }

  const plan: NibrsPlan = {
    version: PLAN_VERSION, semanticVersion: deps.semanticVersion, question: ledger.question,
    geography: { places, combine: "separate" }, period: periodValue!,
    // Group B arrests have no incident: they are placed in time by arrest date.
    timeBasis: measures.some((m) => m.unit === "group_b_arrest") ? "arrest_date" : "incident_date",
    measures, filters, groupings, statistics, transforms, coverage: ALL, defaults, bindings: [],
  };

  // Request accounting: every meaningful clause-0 part, bound to the path that applies it.
  // The parts today's reader requires applied (matchNibrsType's final gate): explain requests, a stray "unspecified"
  // measure beside a named one, and "county"/"agency" entity words outside a ranking are not obligations.
  const named = ledger.parts.some((p) => p.concept === "measure" && p.value !== "unspecified");
  const parts: PartRef[] = ledger.parts
    .filter((p) => p.clause === 0 && p.state !== "context" && p.concept !== "explain")
    .filter((p) => !(p.concept === "measure" && p.value === "unspecified" && named))
    .filter((p) => !(p.concept === "entity" && spec.type !== "rank" && (p.value === "county" || p.value === "agency")))
    .map((p) => ({ concept: p.concept, value: p.value, text: p.text, span: p.span as [number, number], clause: p.clause, inherited: !!p.inherited }));
  const gi = (pred: (g: Grouping) => boolean) => plan.groupings.findIndex(pred);
  const si = (pred: (s: Statistic) => boolean) => plan.statistics.findIndex(pred);
  const ti = (kind: Transform["kind"]) => plan.transforms.findIndex((t) => t.kind === kind);
  const placeValues = spec.type === "series" ? spec.places : spec.type === "rank" ? [] : [spec.place];
  const pathFor = (p: PartRef): string | null => {
    const v = p.value ?? "";
    switch (p.concept) {
      case "measure": return measurePath.get(v) ?? (v === "unspecified" ? null : null);
      case "unit": return "measures[0].unit";
      case "place": {
        if (spec.type === "rank") return plan.geography.places[0].kind === "agency_set" ? "geography.places[0].within" : "geography.places[0]";
        const i = placeValues.findIndex((q) => (q.kind === "national" ? v === "national" : q.kind === "state" ? v === `state:${q.name}` : v.startsWith(`${q.agencyKind}:${q.name}:`)));
        return i >= 0 ? `geography.places[${i}]` : null;
      }
      case "period": return "period";
      case "combine": return "period";
      case "grain": { const i = gi((g) => g.dimension === (v === "month" ? "time.month" : "time.year")); return i >= 0 ? `groupings[${i}]` : null; }
      case "rolling": { const i = ti("rolling"); return i >= 0 ? `transforms[${i}]` : null; }
      case "filter": case "clearance-reason": return filterPath.get(v) ?? null;
      case "breakdown": { const i = gi((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo.")); return i >= 0 ? `groupings[${i}]` : null; }
      case "statistic": {
        const want = ["rate", "per100k", "percapita"].includes(v) ? "rate" : v === "average_value" ? "ratio" : "count";
        const i = si((s) => s.kind === want);
        return i >= 0 ? `statistics[${i}]` : null;
      }
      case "share": { const i = si((s) => s.kind === "share" || s.kind === "ratio"); return i >= 0 ? `statistics[${i}]` : null; }
      case "clearance": {
        if (v === "rate") { const i = si((s) => s.kind === "ratio"); return i >= 0 ? `statistics[${i}]` : null; }
        const i = plan.measures.findIndex((m) => /cleared/.test(m.id));
        if (i >= 0) return `measures[${i}]`;
        const g = gi((x) => x.dimension === "offense.clearance_type" || x.dimension === "offense.clearance_method");
        return g >= 0 ? `groupings[${g}]` : null;
      }
      case "rank": { const i = ti("rank"); return i >= 0 ? `transforms[${i}]` : null; }
      case "threshold": return "geography.places[0]";
      case "entity": case "list": { const i = gi((g) => g.dimension.startsWith("geo.")); return i >= 0 ? `groupings[${i}]` : "geography.places[0]"; }
      case "change": { const i = ti("period_comparison"); return i >= 0 ? `transforms[${i}]` : null; }
      default: return null;
    }
  };
  const bindings: PartBinding[] = [];
  for (const p of parts) {
    const path = pathFor(p);
    if (path) bindings.push({ part: p, path });
  }
  plan.bindings = bindings;
  return { kind: "plan", plan, parts };
}
