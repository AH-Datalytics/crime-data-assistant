/**
 * Several crimes asked together for one state or the nation (P271): each crime is its own state sum (answerStateSum), and
 * the answer is one table with a column for each crime beside the same Year column (or a single row). Crimes are never
 * added together, each keeps its own coverage and evidence, and a rate is never summed. Anything one crime's sum declines,
 * the whole question declines.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { checkEnvelope, type AnswerStatement, type CellEvidence, type ResultColumn, type ResultTable } from "../nibrs-plan/result";
import type { Delivered } from "./deliver";
import { answerStateSum } from "./state-sum";
import type { ShadowDeps, ShadowOutcome } from "./answer";

type Decline = (why: string, detail?: string) => ShadowOutcome;

export function answerStateMulti(plan: NibrsPlan, period: { from: string; to: string }, yearSet: number[] | null, deps: ShadowDeps, statements: AnswerStatement[],
  readings: string[], consistent: boolean, decline: Decline): ShadowOutcome {
  const counted = plan.statistics.every((s) => s.kind === "count" || s.kind === "rate");
  if (plan.measures.length < 2 || plan.geography.places.length !== 1 || !counted || plan.statistics.length !== plan.measures.length || plan.transforms.length
    || plan.groupings.some((g) => g.dimension !== "time.year"))
    return decline("This isn't available: a state or national sum of several crimes, a breakdown, a change or a ranking.");
  if (consistent) return decline("This isn't available: Consistent Reporting Agencies for several crimes at once. Ask for one crime.");
  // The same crime named twice is one crime (never counted twice).
  const measures = plan.measures.filter((m, i, all) => all.findIndex((q) => q.id === m.id && JSON.stringify(q.filters ?? null) === JSON.stringify(m.filters ?? null)) === i);
  if (measures.length < 2) return decline("This isn't available: a state or national sum of several crimes, a breakdown, a change or a ranking.");
  const outs: Extract<ShadowOutcome, { kind: "answer" }>[] = [];
  for (const m of measures) {
    const stat = plan.statistics.find((s) => "measure" in s && s.measure === m.as);
    if (!stat) return decline("This isn't available: a state or national sum of several crimes, a breakdown, a change or a ranking.");
    const sub: NibrsPlan = { ...plan, measures: [m], statistics: [stat] };
    const o = answerStateSum(sub, period, yearSet, deps, statements, readings, false, decline);
    if (o.kind !== "answer") return o;
    outs.push(o);
  }
  const nGroup = (d: Delivered) => d.table.columns.filter((c) => c.binding.kind === "grouping").length;
  const g0 = nGroup(outs[0].delivered);
  const first = outs[0].delivered.table;
  // Every crime's table: the same grouping columns and the same rows (the same years), one number column each.
  for (const o of outs) {
    const t = o.delivered.table;
    if (nGroup(o.delivered) !== g0 || t.columns.length !== g0 + 1 || t.rows.length !== first.rows.length
      || t.rows.some((r, i) => r.slice(0, g0).some((v, j) => v !== first.rows[i][j])))
      return decline("This isn't available: these crimes' tables differ, so they cannot be set side by side.");
  }
  const columns: ResultColumn[] = [...first.columns.slice(0, g0), ...outs.map((o) => o.delivered.table.columns[g0])];
  const rows: ResultTable["rows"] = first.rows.map((r, i) => [...r.slice(0, g0), ...outs.map((o) => o.delivered.table.rows[i][g0])]);
  const evidence: CellEvidence[] = outs.flatMap((o) => o.delivered.evidence);
  const table: ResultTable = { columns, rows };
  const merged: NibrsPlan = { ...plan, measures, statistics: outs.flatMap((o) => o.plan.statistics), coverage: outs[0].plan.coverage };
  const labels: Record<string, string> = {};
  for (const c of columns) labels[c.binding.kind === "grouping" ? `grouping:${c.binding.dimension}` : `statistic:${c.binding.as}`] = c.header;
  // Each crime's own sentence first, in column order, then the notes they share.
  const heads = outs.map((o) => o.delivered.headline ?? o.delivered.text[0]);
  const text = [...new Set([...heads, ...outs.flatMap((o) => o.delivered.text)])];
  const answerStatements = [...new Set(outs.flatMap((o) => o.delivered.answerStatements))];
  const contractProblems = checkEnvelope({ plan: merged, table, evidence, answerStatements }, labels);
  if (contractProblems.length) return decline("This isn't available: several crimes in one table.", `answer contract: ${contractProblems.join("; ")}`);
  const delivered: Delivered = { table, evidence, chart: null, text, headline: heads[0], answerStatements, contractProblems };
  const metas = outs.map((o) => o.stateSum);
  // One record per crime: each crime's agencies, coverage and years are its own, so they are kept apart, never taken from the first.
  if (metas.some((m) => !m)) return decline("This isn't available: several crimes in one table.", "a crime's sum has no coverage record");
  const sameMeta = metas.every((m) => JSON.stringify(m) === JSON.stringify(metas[0]));
  return { kind: "answer", plan: merged, period, sql: [...new Set(outs.map((o) => o.sql))].join(";\n"), delivered,
    // No buttons, so no Consistent Reporting Agencies offer; the lead still says the figures are summed across the agencies that reported.
    stateSums: metas as NonNullable<typeof metas[number]>[], ...(sameMeta ? { stateSum: metas[0] } : {}) };
}
