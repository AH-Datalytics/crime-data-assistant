/**
 * Validation of a whole reader outcome (contract additions, answer evaluation part 3). A plan is checked as before.
 * A clarifying question's options and every offered alternative are checked the same way, because each must run
 * exactly as offered:
 *   O1  a clarifying option's plan fails a rule (shape, semantic layer or release);
 *   O2  an offered alternative's plan fails a rule; an alternative is offered, never run in place of the question;
 *   O3  two options share a label or lead to the same executable plan (labels, wording and provenance aside);
 *   O4  an alternative drops or changes a part of the question that it does not declare in `changes`.
 * Request accounting applies to alternatives part by part: a part whose concept the alternative declares as changed
 * may differ (its label says so); every other part must be bound and applied exactly as in the question.
 */
import type { Alternative, NibrsPlan, PartRef, ReaderOutcome } from "./plan";
import { parseReaderOutcome } from "./plan";
import { validateResolved, type GeographyResolver, type ReleaseInfo } from "./resolve";
import type { SemanticLayer } from "./semantic";
import { validateBindings, validatePlanSemantics, validatePlanShape, type PlaceAuthority, type PlanProblem } from "./validate";

/** The question's parts and the place authority. Required whenever the outcome offers an alternative (O4). */
export type RequestContext = { parts: PartRef[]; places: PlaceAuthority };

/** What a plan computes, without its descriptive metadata: wording, provenance, place labels, default reasons. */
function executable(plan: NibrsPlan): string {
  const { question: _q, bindings: _b, defaults: _d, ...rest } = plan;
  return JSON.stringify({ ...rest, geography: { ...rest.geography, places: rest.geography.places.map((p) => ("label" in p ? { ...p, label: "" } : p)) } });
}

function planProblems(plan: NibrsPlan, layer: SemanticLayer, release: ReleaseInfo, geo: GeographyResolver): PlanProblem[] {
  const before = [...validatePlanShape(plan), ...validatePlanSemantics(plan, layer)];
  // Resolution needs a structurally valid plan.
  return before.length ? before : validateResolved(plan, release, layer, geo).problems;
}

export function validateOutcome(json: unknown, layer: SemanticLayer, release: ReleaseInfo, geo: GeographyResolver, request?: RequestContext): PlanProblem[] {
  const parsed = parseReaderOutcome(json);
  if (!parsed.success) return parsed.error.issues.map((i) => ({ rule: "P0", path: i.path.join("."), message: i.message }));
  const o: ReaderOutcome = parsed.data;
  const out: PlanProblem[] = [];
  const nested = (rule: string, path: string, plan: NibrsPlan) => {
    for (const p of planProblems(plan, layer, release, geo)) out.push({ rule, path: `${path}: ${p.rule} ${p.path}`, message: p.message });
  };
  const alternative = (path: string, alt: Alternative) => {
    nested("O2", `${path}.plan`, alt.plan);
    // An offered alternative cannot be proven to keep the question's parts without them.
    if (!request) { out.push({ rule: "O4", path, message: "an alternative is validated against the question's parts; none were given" }); return; }
    // Every part not declared as changed, checked together (a measure's reading can depend on another part).
    const kept = request.parts.filter((part) => !alt.changes.includes(part.concept));
    for (const p of validateBindings(alt.plan, kept, request.places)) out.push({ rule: "O4", path: `${path}: ${p.rule} ${p.path}`, message: `${p.message} (not declared in changes)` });
  };
  if (o.kind === "plan") return planProblems(o.plan, layer, release, geo);
  if (o.kind === "limitation") {
    if (o.alternative) alternative("alternative", o.alternative);
    return out;
  }
  const labels = new Set<string>();
  const plans = new Set<string>();
  o.options.forEach((opt, i) => {
    if (labels.has(opt.label)) out.push({ rule: "O3", path: `options[${i}].label`, message: `"${opt.label}" is offered twice` });
    labels.add(opt.label);
    if ("plan" in opt) {
      const key = executable(opt.plan);
      if (plans.has(key)) out.push({ rule: "O3", path: `options[${i}].plan`, message: "two options lead to the same plan" });
      plans.add(key);
      nested("O1", `options[${i}].plan`, opt.plan);
    } else if (opt.limitation.alternative) {
      alternative(`options[${i}].limitation.alternative`, opt.limitation.alternative);
    }
  });
  return out;
}
