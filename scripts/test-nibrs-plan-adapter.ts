/**
 * The adapter from today's reader to the plan language (lib/nibrs-plan/from-spec.ts): today's typed spec and request
 * ledger become a valid plan with every part bound, or a named refusal. Offline: no database, no model, no network.
 * Places resolve through a stand-in authority; the route's resolver supplies ORIs at run time.
 */
import assert from "node:assert/strict";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { matchNibrsType } from "../lib/nibrs-question-types";
import { planFromSpec, type AdapterResult } from "../lib/nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../lib/nibrs-plan/draft-layer";
import * as X from "../lib/nibrs-plan/examples";
import { checkLayer } from "../lib/nibrs-plan/semantic";
import { parsePlan, type NibrsPlan, type Place } from "../lib/nibrs-plan/plan";
import { validateResolved } from "../lib/nibrs-plan/resolve";
import { validateBindings, validatePlanSemantics, validatePlanShape } from "../lib/nibrs-plan/validate";

const ORIS: Record<string, [string, string]> = {
  "city:Memphis:TN": ["TNMPD0000", "Memphis Police Department, TN"], "city:Fort Worth:TX": ["TX2201200", "Fort Worth Police Department, TX"],
  "city:Allentown:PA": ["PA0390100", "Allentown Police Department, PA"], "city:Houston:TX": ["TXHPD0000", "Houston Police Department, TX"],
  "city:Chicago:IL": ["ILCPD0000", "Chicago Police Department, IL"],
};
const deps = { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace: (v: string): Place | null => (ORIS[v] ? { kind: "agency", ori: ORIS[v][0], label: ORIS[v][1] } : null) };
const authority = (v: string) => (ORIS[v] ? { oris: [ORIS[v][0]] } : null);
const release = { id: "test", firstMonth: "1991-01", lastMonth: "2026-10", asOf: "2026-10-28" };
const geo = { members: (p: Place) => (p.kind === "agency" ? [p.ori] : ["(any)"]) };

function adapt(q: string): AdapterResult {
  const ledger = accountNibrsRequest(q);
  const d = matchNibrsType(ledger);
  assert.equal(d.kind, "spec", `${q}: today's reader reads it`);
  return planFromSpec((d as Extract<typeof d, { kind: "spec" }>).spec, ledger, deps);
}
function problems(r: AdapterResult): string[] {
  assert.equal(r.kind, "plan");
  const { plan, parts } = r as Extract<AdapterResult, { kind: "plan" }>;
  return [...parsePlan(plan).problems, ...validatePlanShape(plan), ...validatePlanSemantics(plan, DRAFT_LAYER), ...validateBindings(plan, parts, authority),
    ...validateResolved(plan, release, DRAFT_LAYER, geo).problems].map((p) => `${p.rule} ${p.path}: ${p.message}`);
}
const planOf = (q: string): NibrsPlan => {
  const r = adapt(q);
  assert.deepEqual(problems(r), [], q);
  return (r as Extract<AdapterResult, { kind: "plan" }>).plan;
};
const shape = (p: NibrsPlan) => ({ measures: p.measures.map((m) => [m.id, m.unit]), period: p.period, groupings: p.groupings.map((g) => g.dimension), statistics: p.statistics.map((s) => s.kind) });

// The draft layer is consistent.
assert.deepEqual(checkLayer(DRAFT_LAYER), []);

// ---- the frozen release questions read to the plans of the correctness set ----
const H = [["carjacking per month in Memphis", X.H1], ["carjackings in Memphis in 2025", X.H2], ["carjackings per year in Memphis from 2020 to 2025", X.H3]] as const;
for (const [q, want] of H) {
  const p = planOf(q);
  assert.deepEqual(shape(p), shape(want), q);
  assert.deepEqual(p.geography.places, want.geography.places, q);
}
assert.equal(planOf("carjacking per month in Memphis").defaults[0]?.path, "period", "H1's default period is declared");

// ---- forms ----
// A share of offenders: population and subset measures, the subset's filter exactly "under 18".
const share = planOf("what share of robbery offenders in Fort Worth, Texas were under 18 in 2025?");
assert.deepEqual(share.measures.map((m) => [m.id, m.unit, m.as]), [["offenders.robbery", "offender", "population"], ["offenders.robbery", "offender", "subset"]]);
assert.deepEqual(share.measures[1].filters, [{ kind: "attribute", dimension: "offender.age", op: "between", values: [1, 17] }]);
assert.equal(share.statistics[0].kind, "ratio");
// A rate over a year still in progress: valid, clipped to the release's last month at resolution.
const rate = planOf("Allentown murder rate 2026");
assert.equal(validateResolved(rate, release, DRAFT_LAYER, geo).clippedTo, "2026-10");
// A clearance rate counts offenses and cleared offenses.
assert.deepEqual(planOf("murder clearance rate in Memphis in 2024").measures.map((m) => m.id), ["offenses.murder", "offenses.murder_cleared"]);
// "were cleared": the cleared offenses, a part today's typed spec does not carry.
assert.deepEqual(planOf("How many rapes were cleared in 2025").measures.map((m) => m.id), ["offenses.rape_cleared"]);

// Average value: terminates, and divides by the same property's segments.
const avg = planOf("average value of stolen property in Texas in 2025");
assert.deepEqual(avg.measures.map((m) => m.id), ["property.property_value", "property.property_value_segments"]);
// DUI is Group B: Group B arrests, placed in time by arrest date.
const dui = planOf("DUI arrests by age group nationally");
assert.deepEqual([dui.measures[0].id, dui.measures[0].unit, dui.timeBasis, dui.groupings[0].dimension], ["group_b_arrests.dui", "group_b_arrest", "arrest_date", "group_b_arrest.age"]);
// "last year" is the calendar year before the request, as today's reader reads it, whatever the release holds.
const ly = planOf("burglaries in Texas last year");
assert.deepEqual(ly.period, { kind: "previous_calendar_year" });
assert.deepEqual(validateResolved(ly, { ...release, lastMonth: "2026-12" }, DRAFT_LAYER, geo).period, { kind: "absolute", from: "2025-01", to: "2025-12" });
// A clipped period is returned clipped.
assert.deepEqual(validateResolved({ ...rate, period: { kind: "absolute", from: "2025-01", to: "2026-12" } }, release, DRAFT_LAYER, geo).period, { kind: "absolute", from: "2025-01", to: "2026-10" });
// A cleared-offense measure applies the offense only when the question asks about clearances.
{
  const ledger = accountNibrsRequest("How many burglary offenses in Texas in 2025");
  const d = matchNibrsType(ledger);
  assert(d.kind === "spec");
  const r = planFromSpec(d.spec, ledger, deps);
  assert(r.kind === "plan");
  const swapped = { ...r.plan, measures: [{ ...r.plan.measures[0], id: "offenses.burglary_cleared" }] };
  assert.ok(validateBindings(swapped, r.parts, authority).some((p) => p.rule === "A4"), "an unrequested clearance subset is refused");
}
// A compared period must lie entirely inside the release.
{
  const cmp = { ...X.SEPARATE_YEARS, period: { kind: "years" as const, years: [2024, 2026] }, transforms: [{ kind: "period_comparison" as const, of: ["count"], earlier: { kind: "absolute" as const, from: "2024-11", to: "2024-12" }, later: { kind: "absolute" as const, from: "2026-11", to: "2026-12" }, outputs: ["change" as const] }] };
  assert.ok(validateResolved(cmp, release, DRAFT_LAYER, { members: () => ["TXHPD0000"] }).problems.some((p) => p.rule === "R2"));
}

// Clearance breakdowns count every offense, with "not cleared" a category (today's rule); "by exception by type" narrows
// to the exceptional clearances.
const byType = planOf("chicago murder clearances by clearance type in 2025");
assert.deepEqual([byType.measures[0].id, byType.groupings[0].dimension, byType.filters.length], ["offenses.murder", "offense.clearance_type", 0]);
const exc = planOf("virginia murder clearances by exception by type in 2025");
assert.deepEqual([exc.measures[0].id, exc.groupings[0].dimension, JSON.stringify(exc.filters)], ["offenses.murder", "offense.clearance_type", JSON.stringify([{ kind: "attribute", dimension: "offense.clearance_method", op: "in", values: ["exceptional"] }])]);

// ---- refusals ----
// Today's typed breakdown drops "rate"; the plan refuses rather than answering counts (the live route declines these
// earlier, so no wrong answer has been delivered).
const dropped = problems(adapt("show the shoplifting rate since 2010 by race of offender"));
assert.ok(dropped.some((p) => p.startsWith("A1") && p.includes("rate")), dropped.join("; "));
// A mixed-unit composite has no single person to break down.
assert.equal(adapt("please show the violent crime rate by race").kind, "unmapped");
// An unresolved place is never guessed.
assert.equal(adapt("What is the auto theft clearance rate in Omaha by year?").kind, "unmapped");

console.log("nibrs plan adapter: frozen questions, forms and refusals as expected");
