/**
 * Validation of a whole reader outcome (contract additions, answer evaluation part 3). A plan is checked as before.
 * A clarifying question's options and every offered alternative are checked the same way, because each must run
 * exactly as offered:
 *   O1  a clarifying option's plan fails a rule (shape, semantic layer or release);
 *   O2  an offered alternative's plan fails a rule; an alternative is offered, never run in place of the question;
 *   O3  two options share a label or lead to the same plan (asking is only for readings that differ).
 * Request accounting (A rules) applies to the plan that answers the question, not to alternatives: an alternative
 * deliberately answers a nearby question, which its label names.
 */
import type { NibrsPlan, ReaderOutcome } from "./plan";
import { parseReaderOutcome } from "./plan";
import { validateResolved, type GeographyResolver, type ReleaseInfo } from "./resolve";
import type { SemanticLayer } from "./semantic";
import { validatePlanSemantics, validatePlanShape, type PlanProblem } from "./validate";

function planProblems(plan: NibrsPlan, layer: SemanticLayer, release: ReleaseInfo, geo: GeographyResolver): PlanProblem[] {
  const before = [...validatePlanShape(plan), ...validatePlanSemantics(plan, layer)];
  // Resolution needs a structurally valid plan.
  return before.length ? before : validateResolved(plan, release, layer, geo).problems;
}

export function validateOutcome(json: unknown, layer: SemanticLayer, release: ReleaseInfo, geo: GeographyResolver): PlanProblem[] {
  const parsed = parseReaderOutcome(json);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ rule: "P0", path: i.path.join("."), message: i.message }));
  const o: ReaderOutcome = parsed.data;
  const out: PlanProblem[] = [];
  const nested = (rule: string, path: string, plan: NibrsPlan) => {
    for (const p of planProblems(plan, layer, release, geo)) out.push({ rule, path: `${path}: ${p.rule} ${p.path}`, message: p.message });
  };
  if (o.kind === "plan") return planProblems(o.plan, layer, release, geo);
  if (o.kind === "limitation") {
    if (o.alternative) nested("O2", "alternative.plan", o.alternative.plan);
    return out;
  }
  const labels = new Set<string>();
  const plans = new Set<string>();
  o.options.forEach((opt, i) => {
    if (labels.has(opt.label)) out.push({ rule: "O3", path: `options[${i}].label`, message: `"${opt.label}" is offered twice` });
    labels.add(opt.label);
    if ("plan" in opt) {
      const key = JSON.stringify({ ...opt.plan, question: "", bindings: [] });
      if (plans.has(key)) out.push({ rule: "O3", path: `options[${i}].plan`, message: "two options lead to the same plan" });
      plans.add(key);
      nested("O1", `options[${i}].plan`, opt.plan);
    } else if (opt.limitation.alternative) {
      nested("O2", `options[${i}].limitation.alternative.plan`, opt.limitation.alternative.plan);
    }
  });
  return out;
}
