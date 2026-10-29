/**
 * Scoring one candidate run against the labeled set, and the release gates (answer evaluation part 5).
 *
 * Each scored case gets one outcome:
 *   correct             the right action, fully verified (an answer whose every field matches)
 *   unverified          the right action, but the comparison cannot confirm it (an unknown word, a share's roles, a
 *                       decline whose reason no judge has checked, a clarification whose options are not structured)
 *   wrong_answer        a number where the label asks or declines, or a number for a different question
 *   avoidable_decline   no answer (declined, or no reading) where the label answers
 *   unnecessary_clarify asked where the label answers
 *   wrong_action        asked where the label declines, declined where it asks, or no reading where it asks
 *   incomplete          the right action without what it must carry: a decline with no reason (no reading) or without
 *                       the alternative the label expects
 * The observed action is always kept: "no reading" is never counted as a decline (Codex runner review r1, item 1).
 *
 * Gates, per split, capability and era. Each mandatory category is pass, fail or NOT MEASURED; a group passes only
 * when every category is measured and passes:
 *   wrong answers        zero
 *   clarifications       every expected clarification correct (options and continuations verified)
 *   declines             every expected decline correct (a truthful reason, verified; the alternative when expected)
 *   initial action       95% or more with the expected action
 *   direct answers       95% or more of answerable cases correct (unverified ones are not counted as correct)
 *   numeric fixtures     every verified value matches (not measured until the compiler exists)
 * The severity score (100 / 20 / 5 / 1) is for trends only, never a gate.
 */
import type { Case } from "./case";
import type { Diff } from "./compare";

export type ActualAction = "answer" | "clarify" | "decline" | "no_reading";
export type ExpectedAction = NonNullable<Case["expected"]>["action"];
export type Outcome = "correct" | "unverified" | "wrong_answer" | "avoidable_decline" | "unnecessary_clarify" | "wrong_action" | "incomplete";
export type CaseResult = {
  id: string; split: Case["split"]; expected: ExpectedAction; actual: ActualAction; outcome: Outcome;
  diffs: Diff[]; notes: string[]; capability: string; era: string;
};

/**
 * `material` / `unverified`: the answer's field verdicts. `structured`: whether the candidate's clarification or decline
 * can be checked (options listed, reason judged). `alternativeMissing`: the label expects an alternative and none came.
 */
export function outcomeOf(expected: ExpectedAction, actual: ActualAction, o: { material?: number; unverified?: number; structured?: boolean; alternativeMissing?: boolean } = {}): Outcome {
  if (expected === "answer") {
    if (actual === "answer") return o.material ? "wrong_answer" : o.unverified ? "unverified" : "correct";
    return actual === "clarify" ? "unnecessary_clarify" : "avoidable_decline";
  }
  if (actual === "answer") return "wrong_answer";
  if (expected === "decline") {
    if (actual === "no_reading") return "incomplete";
    if (actual !== "decline") return "wrong_action";
    if (o.alternativeMissing) return "incomplete";
    return o.structured ? "correct" : "unverified";
  }
  if (actual !== "clarify") return "wrong_action";
  return o.structured ? "correct" : "unverified";
}

const SEVERITY: Record<Outcome, number> = { correct: 0, unverified: 0, wrong_answer: 100, avoidable_decline: 20, unnecessary_clarify: 5, wrong_action: 5, incomplete: 1 };

export type Category = { name: string; status: "pass" | "fail" | "not measured"; detail: string };
export type GateRow = { split: string; capability: string; era: string; cases: number; categories: Category[]; status: "pass" | "fail" | "not measured" };

export const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "n/a");

export function gates(results: CaseResult[]): GateRow[] {
  const by = new Map<string, CaseResult[]>();
  for (const r of results) { const k = `${r.split}|${r.capability}|${r.era}`; by.set(k, [...(by.get(k) ?? []), r]); }
  return [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => {
    const [split, capability, era] = k.split("|");
    const cat = (name: string, applies: CaseResult[], ok: (r: CaseResult) => boolean): Category => {
      if (!applies.length) return { name, status: "pass", detail: "no cases" };
      const bad = applies.filter((r) => !ok(r) && r.outcome !== "unverified").length;
      const unv = applies.filter((r) => r.outcome === "unverified").length;
      return { name, status: bad ? "fail" : unv ? "not measured" : "pass", detail: `${applies.length - bad - unv}/${applies.length} verified correct${unv ? `, ${unv} unverified` : ""}${bad ? `, ${bad} failing` : ""}` };
    };
    const wrong = rs.filter((r) => r.outcome === "wrong_answer").length;
    const action = rs.filter((r) => r.actual === r.expected).length;
    const answerable = rs.filter((r) => r.expected === "answer");
    const direct = answerable.filter((r) => r.outcome === "correct").length;
    const directUnv = answerable.filter((r) => r.outcome === "unverified").length;
    const categories: Category[] = [
      { name: "wrong answers", status: wrong ? "fail" : "pass", detail: `${wrong}` },
      cat("clarifications", rs.filter((r) => r.expected === "clarify"), (r) => r.outcome === "correct"),
      cat("declines", rs.filter((r) => r.expected === "decline"), (r) => r.outcome === "correct"),
      { name: "initial action", status: action / rs.length >= 0.95 ? "pass" : "fail", detail: `${pct(action, rs.length)} (${action}/${rs.length})` },
      !answerable.length ? { name: "direct answers", status: "pass", detail: "no answerable cases" }
        : direct / answerable.length >= 0.95 ? { name: "direct answers", status: "pass", detail: `${pct(direct, answerable.length)}` }
          : (direct + directUnv) / answerable.length >= 0.95 ? { name: "direct answers", status: "not measured", detail: `${pct(direct, answerable.length)} verified, ${directUnv} unverified` }
            : { name: "direct answers", status: "fail", detail: `${pct(direct, answerable.length)} (${directUnv} unverified)` },
      { name: "numeric fixtures", status: "not measured", detail: "no compiler yet" },
    ];
    const status = categories.some((c) => c.status === "fail") ? "fail" : categories.some((c) => c.status === "not measured") ? "not measured" : "pass";
    return { split, capability, era, cases: rs.length, categories, status };
  });
}

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
