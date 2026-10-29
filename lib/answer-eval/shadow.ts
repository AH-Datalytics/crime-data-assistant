/**
 * Scoring the shadow slice (lib/nibrs-shadow) against the labeled set, at every level the slice delivers:
 *   action          answer, clarify or decline (gates.ts outcomes);
 *   interpretation  the answered plan against the label's meaning (compare.ts);
 *   statements      each sentence the label requires, checked on the delivered text where a check is defined;
 *   values          delivered cells against independent expected values (NOT MEASURED until they are given);
 *   clarifications  every option the label lists is offered, leads where it should, and its continuation (the original
 *                   question with that choice filled in) is the label's meaning for that option;
 *   declines        the reason is the label's reason class, and the alternative, when the label expects one, runs to the
 *                   label's alternative meaning.
 * A refusal because this build does not hold the months (`notBuilt`) is not scored: it is listed apart.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import type { ShadowOption, ShadowOutcome } from "../nibrs-shadow/answer";
import { periodWords } from "../nibrs-shadow/deliver";
import type { Case, Meaning } from "./case";
import { compareMeaning, planToMeaning, type Diff, type Release } from "./compare";
import { outcomeOf, type ActualAction, type CaseResult, type Outcome } from "./gates";

/** The slice: its designed group, the replay cases inside it, and replay cases next to it (action and reason only). */
export const SLICE_REPLAY = ["LS-151", "LS-140"];
export const SLICE_NEAR = ["LS-124", "LS-135", "LS-146", "LS-156", "LS-043", "LS-150", "LS-160", "LS-141", "LS-012", "LS-020", "LS-005", "LS-009"];
export function sliceGroup(c: Case): "designed" | "replay" | "near" | null {
  if (c.group.startsWith("designed:slice-")) return "designed";
  if (SLICE_REPLAY.includes(c.id)) return "replay";
  if (SLICE_NEAR.includes(c.id)) return "near";
  return null;
}

/** Expected cells for one answer: keyed by period ("2024-03", "2024") or "" for a total. */
export type ExpectedValues = Map<string, { key: string; value: number | null }[]>;

const normLabel = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();
const LABEL_REASON: [RegExp, string][] = [
  [/agency level|zip code|neighborhood/i, "below_agency_level"], [/court|conviction|prosecution|defendant/i, "court_outcome"],
  [/cannot predict|predict/i, "forecast"], [/is not in the data/i, "outside_release_coverage"], [/cause/i, "explanation_requested"],
];
const reasonClass = (s: string) => LABEL_REASON.find(([re]) => re.test(s))?.[1] ?? null;
const viewOf = (plan: NibrsPlan, p: { from: string; to: string }) => planToMeaning(plan, { kind: "absolute", ...p });

/** The label's agency name as the words an answer must carry (its city), e.g. "St. Louis". */
function agencyWords(name: string): string {
  return name.replace(/\b(Metropolitan|Police|Department|Division of|Sheriff'?s?|Office|County)\b/g, " ").replace(/\s+/g, " ").trim();
}

function statementDiffs(e: Extract<NonNullable<Case["expected"]>, { action: "answer" }>, o: Extract<ShadowOutcome, { kind: "answer" }>): Diff[] {
  const out: Diff[] = [];
  const text = o.delivered.text;
  const all = text.join(" ");
  const blank = o.delivered.evidence.some((x) => x.status !== "VALUE" && x.status !== "REPORTED_ZERO");
  for (const s of e.statements) {
    let ok: boolean | null = null;
    const ag = /^names the agency \((.+)\)$/.exec(s);
    if (ag) ok = all.toLowerCase().includes(agencyWords(ag[1]).toLowerCase());
    else if (s === "names its source at the end") ok = /^Source: /.test(text[text.length - 1]) && text.filter((t) => /^Source: /.test(t)).length === 1;
    else if (/^[A-Z].*\.$/.test(s) && !/^(names|says|states|labels)\b/.test(s)) ok = text.includes(s);   // a fixed sentence
    else if (s === "names any months with no data as missing, not zero") ok = !blank || /No data for|recorded for/.test(all);
    else if (s === "names the months covered") ok = all.includes(periodWords(o.period.from, o.period.to));
    else if (/^says drug crimes include/.test(s)) ok = /drug equipment/i.test(all);
    if (ok === null) out.push({ field: "statement", expected: s, actual: "(no check defined)", kind: "unverified" });
    else if (!ok) out.push({ field: "statement", expected: s, actual: text.join(" / ").slice(0, 200), kind: "material" });
  }
  return out;
}

function valueDiffs(o: Extract<ShadowOutcome, { kind: "answer" }>, expected: { key: string; value: number | null }[] | undefined): { diffs: Diff[]; values: "match" | "mismatch" | "not measured" } {
  if (!expected) return { values: "not measured", diffs: [{ field: "values", expected: "independent expected values", actual: "none given yet: NOT MEASURED", kind: "unverified" }] };
  const rows = o.delivered.table.rows;
  const got = new Map(rows.map((r) => [r.length > 1 ? String(r[0]) : "", r[r.length - 1] as number | null]));
  const diffs: Diff[] = [];
  if (got.size !== expected.length) diffs.push({ field: "values", expected: `${expected.length} cells`, actual: `${got.size} cells`, kind: "material" });
  for (const x of expected) if (!got.has(x.key) || got.get(x.key) !== x.value) diffs.push({ field: `value ${x.key || "total"}`, expected: String(x.value), actual: String(got.get(x.key)), kind: "material" });
  return { diffs, values: diffs.length ? "mismatch" : "match" };
}

/** An option's or alternative's continuation against the meaning it should reach. */
function continuationDiffs(prefix: string, want: Meaning | null, wantLeads: string, got: ShadowOption, r: Release): Diff[] {
  const d = (field: string, expected: string, actual: string, kind: Diff["kind"]): Diff => ({ field: `${prefix}${field}`, expected, actual, kind });
  if (wantLeads === "clarify") return got.entry ? [] : [d("", "opens an entry", got.continuation?.kind ?? got.otherSource ?? "?", "material")];
  if (got.entry) return [d("", wantLeads, "opens an entry", "material")];
  if (got.otherSource) return want && want.source === got.otherSource ? [d("", `${want.source} answer`, `routed to ${got.otherSource}: not run by this NIBRS shadow`, "unverified")] : [d("source", want?.source ?? wantLeads, got.otherSource, "material")];
  const c = got.continuation!;
  if (c.kind === "decline" && c.notBuilt) return [d("", wantLeads, "refused: this build does not hold the months (not built)", "unverified")];
  if (c.kind === "decline" && /^Not in the slice yet/.test(c.explanation)) return [d("", wantLeads, c.explanation, "unverified")];
  if (wantLeads === "answer") {
    if (c.kind !== "answer") return [d("", "answer", `${c.kind}: ${c.kind === "decline" ? c.explanation.slice(0, 160) : c.about}`, "material")];
    return compareMeaning(want!, viewOf(c.plan, c.period), r).map((x) => ({ ...x, field: `${prefix}${x.field}` }));
  }
  return c.kind === wantLeads ? [] : [d("", wantLeads, c.kind, "material")];
}

export type ShadowScore = { result: CaseResult | null; excluded?: string };

export function scoreShadow(c: Case, o: ShadowOutcome, r: Release, ctx: { capability: string; era: string }, expectedValues?: ExpectedValues): ShadowScore {
  const e = c.expected!;
  const actual: ActualAction = o.kind;
  const notes: string[] = [];
  let diffs: Diff[] = [];
  let values: CaseResult["values"];
  if (o.kind === "decline" && o.notBuilt) return { result: null, excluded: `refused as not built: ${o.explanation}` };
  if (o.kind === "decline") notes.push(`declined (${o.reason}): ${o.explanation.slice(0, 200)}`);
  if (o.kind === "clarify") notes.push(`asked ${o.about}: ${o.options.map((x) => x.label).join(" | ")}`);
  let structured = true, alternativeMissing = false;
  if (e.action === "answer" && o.kind === "answer") {
    diffs = [...compareMeaning(e.meaning, viewOf(o.plan, o.period), r), ...statementDiffs(e, o)];
    const v = valueDiffs(o, expectedValues?.get(c.id));
    diffs.push(...v.diffs); values = v.values;
    if (o.delivered.contractProblems.length) diffs.push({ field: "answer contract", expected: "no problems", actual: o.delivered.contractProblems.join("; "), kind: "material" });
    notes.push(`delivered: ${o.delivered.text.join(" / ").slice(0, 240)}`);
  }
  if (e.action === "clarify" && o.kind === "clarify") {
    for (const want of e.options) {
      const got = o.options.find((x) => normLabel(x.label) === normLabel(want.label));
      if (!got) { diffs.push({ field: `option "${want.label}"`, expected: "offered", actual: "missing", kind: "material" }); continue; }
      diffs.push(...continuationDiffs(`option "${want.label}" `, want.meaning, want.leads_to, got, r));
    }
    for (const got of o.options) if (!e.options.some((w) => normLabel(w.label) === normLabel(got.label))) diffs.push({ field: `option "${got.label}"`, expected: "not offered", actual: "offered", kind: "material" });
    structured = !diffs.some((x) => x.kind === "unverified");
  }
  if (e.action === "decline" && o.kind === "decline") {
    const want = reasonClass(e.reason);
    if (!want) diffs.push({ field: "reason", expected: e.reason, actual: o.reason, kind: "unverified" });
    else if (want !== o.reason) diffs.push({ field: "reason", expected: `${want}: ${e.reason}`, actual: `${o.reason}: ${o.explanation.slice(0, 160)}`, kind: "material" });
    if (e.alternative) {
      if (!o.alternative) alternativeMissing = true;
      else diffs.push(...continuationDiffs("alternative ", e.alternative, "answer", o.alternative, r));
    }
    structured = !diffs.some((x) => x.kind === "unverified");
  }
  const material = diffs.filter((x) => x.kind === "material").length;
  const unverified = diffs.filter((x) => x.kind === "unverified").length;
  let outcome: Outcome = outcomeOf(e.action, actual, { material, unverified, structured, alternativeMissing });
  // The right action that carries the wrong options, reason or alternative is incomplete, never correct.
  if (e.action !== "answer" && actual === e.action && material) outcome = "incomplete";
  return { result: { id: c.id, split: c.split, expected: e.action, actual, outcome, diffs, notes, capability: ctx.capability, era: ctx.era, ...(values ? { values } : {}) } };
}
