/**
 * Scoring one candidate run against the labeled set, and the release gates (answer evaluation part 5).
 *
 * Each scored case gets one outcome:
 *   correct            the right action, and for an answer no material meaning difference
 *   wrong_answer       a number given where the label says ask or decline, or a number for a different question
 *   avoidable_decline  declined (or no reading) where the label answers
 *   unnecessary_clarify asked where the label answers
 *   wrong_action       asked where the label declines, or declined where it asks
 *   incomplete         right action, but the clarification's options or the decline's alternative are missing or wrong
 * Gates, per capability (source and statistic) and era: zero wrong answers; every clarification and decline complete;
 * 95% or more correct initial actions; 95% or more correct direct answers among answerable questions; numeric
 * fixtures 100% once values exist. The severity score (100 / 20 / 5 / 1) is for trends only, never a gate.
 */
import type { Case } from "./case";
import type { Diff } from "./compare";

export type ActualAction = "answer" | "clarify" | "decline" | "no_reading";
export type Outcome = "correct" | "wrong_answer" | "avoidable_decline" | "unnecessary_clarify" | "wrong_action" | "incomplete";
export type CaseResult = {
  id: string; split: Case["split"]; expected: Case["expected"] extends infer E ? (E extends { action: infer A } ? A : never) : never;
  actual: ActualAction; outcome: Outcome; diffs: Diff[]; notes: string[]; capability: string; era: string;
};

export function outcomeOf(expected: "answer" | "clarify" | "decline", actual: ActualAction, materialDiffs: number, complete: boolean): Outcome {
  if (expected === "answer") {
    if (actual === "answer") return materialDiffs ? "wrong_answer" : "correct";
    return actual === "clarify" ? "unnecessary_clarify" : "avoidable_decline";
  }
  if (actual === "answer") return "wrong_answer";
  if (actual === expected) return complete ? "correct" : "incomplete";
  return "wrong_action";
}

const SEVERITY: Record<Outcome, number> = { correct: 0, wrong_answer: 100, avoidable_decline: 20, unnecessary_clarify: 5, wrong_action: 5, incomplete: 1 };

export type GateRow = { capability: string; era: string; cases: number; wrong: number; incomplete: number; action: number; answerable: number; direct: number; pass: boolean; why: string[] };

export function gates(results: CaseResult[]): GateRow[] {
  const by = new Map<string, CaseResult[]>();
  for (const r of results) by.set(`${r.capability}|${r.era}`, [...(by.get(`${r.capability}|${r.era}`) ?? []), r]);
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => {
    const [capability, era] = k.split("|");
    const wrong = rs.filter((r) => r.outcome === "wrong_answer").length;
    const incomplete = rs.filter((r) => r.outcome === "incomplete").length;
    const action = rs.filter((r) => r.actual === r.expected || (r.expected === "decline" && r.actual === "no_reading")).length;
    const answerable = rs.filter((r) => r.expected === "answer");
    const direct = answerable.filter((r) => r.outcome === "correct").length;
    const why: string[] = [];
    if (wrong) why.push(`${wrong} wrong answer(s)`);
    if (incomplete) why.push(`${incomplete} incomplete clarification(s) or decline(s)`);
    if (action / rs.length < 0.95) why.push(`initial action ${pct(action, rs.length)} < 95%`);
    if (answerable.length && direct / answerable.length < 0.95) why.push(`direct answers ${pct(direct, answerable.length)} < 95%`);
    return { capability, era, cases: rs.length, wrong, incomplete, action, answerable: answerable.length, direct, pass: why.length === 0, why };
  });
}

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");
export const severity = (results: CaseResult[]) => results.reduce((s, r) => s + SEVERITY[r.outcome], 0);

/** Expected (rows) by actual (columns) action counts. */
export function confusion(results: CaseResult[]): Record<string, Record<ActualAction, number>> {
  const out: Record<string, Record<ActualAction, number>> = {};
  for (const r of results) {
    out[r.expected] ??= { answer: 0, clarify: 0, decline: 0, no_reading: 0 };
    out[r.expected][r.actual]++;
  }
  return out;
}
