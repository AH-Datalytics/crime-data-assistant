/**
 * Several states, or a state and the nation, asked together (P270): each place is its own state sum (answerStateSum),
 * and the answer is one table with a Place column. Places are never added together, each keeps its own coverage and
 * evidence, and a rate is never summed across places. Anything one place's sum declines, the whole question declines.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { checkEnvelope, type AnswerStatement, type CellEvidence, type ResultColumn, type ResultTable } from "../nibrs-plan/result";
import type { Delivered } from "./deliver";
import { stateName } from "./places";
import { answerStateSum } from "./state-sum";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (why: string, detail?: string) => ShadowOutcome;
type Place = NibrsPlan["geography"]["places"][number];

const placeLabel = (p: Place): string => (p.kind === "national" ? "United States" : stateName((p as { code: string }).code));

export function answerStateSet(plan: NibrsPlan, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], consistent: boolean, decline: Decline): ShadowOutcome {
  // The same place named twice is one place (never counted twice).
  const places = plan.geography.places.filter((p, i, all) => all.findIndex((q) => placeLabel(q) === placeLabel(p)) === i);
  if (places.length < 2 || places.some((p) => p.kind !== "state" && p.kind !== "national"))
    return decline("This isn't available: a state or the nation together with other places.");
  if (consistent) return decline("This isn't available: Consistent Reporting Agencies for several places at once. Ask for one place.");
  const geoAt = plan.groupings.findIndex((g) => g.dimension === "geo.place");
  const outs: Extract<ShadowOutcome, { kind: "answer" }>[] = [];
  for (const p of places) {
    const sub: NibrsPlan = { ...plan, geography: { ...plan.geography, places: [p] }, groupings: plan.groupings.filter((g) => g.dimension !== "geo.place") };
    const o = answerStateSum(sub, period, yearSet, deps, statements, readings, false, decline);
    if (o.kind !== "answer") return o;
    outs.push(o);
  }
  // Every place's table must have the same columns (the same question asked of each).
  const shape = (d: Delivered) => d.table.columns.map((c) => `${c.binding.kind}:${c.binding.kind === "grouping" ? c.binding.dimension : c.binding.as}|${c.header}`).join(",");
  if (outs.some((o) => shape(o.delivered) !== shape(outs[0].delivered))) return decline("This isn't available: these places' tables differ, so they cannot be set side by side.");
  const cols0 = outs[0].delivered.table.columns;
  const nGroup = cols0.filter((c) => c.binding.kind === "grouping").length;
  const at = geoAt < 0 ? 0 : Math.min(geoAt, nGroup);
  const placeCol: ResultColumn = { binding: { kind: "grouping", dimension: "geo.place" }, header: "Place" };
  const columns: ResultColumn[] = [...cols0.slice(0, at), placeCol, ...cols0.slice(at)];
  const rows: ResultTable["rows"] = [];
  const evidence: CellEvidence[] = [];
  outs.forEach((o, i) => {
    const base = rows.length;
    for (const r of o.delivered.table.rows) rows.push([...r.slice(0, at), placeLabel(places[i]), ...r.slice(at)]);
    for (const e of o.delivered.evidence) evidence.push({ ...e, row: e.row + base });
  });
  const table: ResultTable = { columns, rows };
  const merged: NibrsPlan = { ...plan, geography: { ...plan.geography, places }, statistics: outs[0].plan.statistics, coverage: outs[0].plan.coverage };
  const labels: Record<string, string> = {};
  for (const c of columns) labels[c.binding.kind === "grouping" ? `grouping:${c.binding.dimension}` : `statistic:${c.binding.as}`] = c.header;
  const text = [...new Set(outs.flatMap((o) => o.delivered.text))];
  const answerStatements = [...new Set(outs.flatMap((o) => o.delivered.answerStatements))];
  const contractProblems = checkEnvelope({ plan: merged, table, evidence, answerStatements }, labels);
  if (contractProblems.length) return decline("This isn't available: several places in one table.", `answer contract: ${contractProblems.join("; ")}`);
  const delivered: Delivered = { table, evidence, chart: null, text, headline: text[0], answerStatements, contractProblems };
  const metas = outs.map((o) => o.stateSum);
  // One record per place: each place's agencies, coverage and years are its own, so they are kept apart, in row order.
  if (metas.some((m) => !m)) return decline("This isn't available: several places in one table.", "a place's sum has no coverage record");
  const sameMeta = metas.every((m) => JSON.stringify(m) === JSON.stringify(metas[0]));
  return { kind: "answer", plan: merged, period, sql: [...new Set(outs.map((o) => o.sql))].join(";\n"), delivered,
    // No buttons, so no Consistent Reporting Agencies offer; the lead still says the figures are summed across the agencies that reported.
    stateSums: metas as NonNullable<typeof metas[number]>[], ...(sameMeta ? { stateSum: metas[0] } : {}) };
}
