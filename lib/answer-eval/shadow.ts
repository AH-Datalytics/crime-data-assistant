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
import { ANSWER_STATEMENTS, type AnswerStatement } from "../nibrs-plan/result";
import { periodWords } from "../nibrs-shadow/deliver";
import type { Case, Meaning } from "./case";
import { compareMeaning, planToMeaning, type Diff, type Release } from "./compare";
import { outcomeOf, type ActualAction, type CaseResult, type Outcome } from "./gates";

/** The slice: its designed group, the replay cases inside it, and replay cases next to it (action and reason only). */
export const SLICE_REPLAY = ["LS-151", "LS-140"];
export const SLICE_NEAR = ["LS-124", "LS-135", "LS-146", "LS-156", "LS-043", "LS-150", "LS-160", "LS-141", "LS-012", "LS-020", "LS-005", "LS-009"];
export function sliceGroup(c: Case): "designed" | "replay" | "near" | null {
  if (c.group.startsWith("designed:slice-") || c.group.startsWith("designed:reader-")) return "designed";
  if (SLICE_REPLAY.includes(c.id)) return "replay";
  if (SLICE_NEAR.includes(c.id)) return "near";
  return null;
}

/**
 * Independent expected cells for one delivered answer, keyed by period ("2024-03", "2024") or "" for a total, with the
 * cell's status. The map's keys: a case id ("LS-219"), a case and one of its options ("LS-231|Kansas City, Missouri"),
 * or a case's alternative ("LS-236|alternative").
 */
export type ExpectedCell = { key: string; value: number | null; status: string };
export type ExpectedValues = Map<string, ExpectedCell[]>;

/**
 * Reads nibrs-model's slice values (correctness/slice/V*.json on its main branch, read with `git show`, never from a work
 * tree) into expected cells. Each file names the cases it serves in `nibrsai_cases`: `LS-230, LS-233 "This year so
 * far", LS-236 alternative`. A file with more than one measure keys its total cells by measure.
 */
export function sliceValues(files: { name: string; json: string }[]): ExpectedValues {
  const out: ExpectedValues = new Map();
  for (const f of files) {
    const v = JSON.parse(f.json) as { nibrsai_cases: string; grouping: string; measures: Record<string, string>; totals: Record<string, { status: string; value: number | null }>;
      rows: ({ month?: string; year?: string } & Record<string, unknown>)[] | null };
    const measures = Object.keys(v.measures);
    const cell = (x: unknown) => x as { status: string; value: number | null };
    const cells: ExpectedCell[] = v.grouping === "total"
      ? measures.map((m) => ({ key: measures.length > 1 ? m : "", ...pick(v.totals[m]) }))
      : (v.rows ?? []).map((r) => ({ key: String(r.month ?? r.year), ...pick(cell(r[measures[0]])) }));
    for (const m of v.nibrsai_cases.matchAll(/(LS-\d{3})(?:\s+"([^"]+)"|\s+(alternative))?/g)) {
      const k = m[3] ? `${m[1]}|alternative` : m[2] ? `${m[1]}|${m[2]}` : m[1];
      out.set(P28_VALUE_KEYS[k] ?? k, cells);
    }
  }
  return out;
}
const pick = (c: { status: string; value: number | null }) => ({ value: c.value, status: c.status });
/**
 * Values requested before a label changed: P28 made these questions ask city or county first, so the city's values serve
 * the city button; P06's button now names its year. (nibrs-model's files name the cases as they were requested.)
 */
export const P28_VALUE_KEYS: Record<string, string> = { "LS-151": "LS-151|Baltimore city, Maryland", "LS-223": "LS-223|Baltimore city, Maryland", "LS-224": "LS-224|St. Louis city, Missouri",
  // P06 names the latest complete year on its button (Codex slice review 1).
  "LS-233|The latest complete year": "LS-233|The latest complete year (2025)",
  // LS-140 asks the city or county first; the years are asked behind the city button.
  "LS-140|Every year available": "LS-140|St. Louis city, Missouri|Every year available" };

const normLabel = (s: string) => s.toLowerCase().replace(/^the /, "").replace(/[^a-z0-9]+/g, " ").trim();
const LABEL_REASON: [RegExp, string][] = [
  [/agency level|zip code|neighborhood/i, "below_agency_level"], [/court|conviction|prosecution|defendant/i, "court_outcome"],
  [/cannot predict|predict/i, "forecast"], [/is not in the data/i, "outside_release_coverage"], [/cause/i, "explanation_requested"],
];
const reasonClass = (s: string) => LABEL_REASON.find(([re]) => re.test(s))?.[1] ?? null;
const viewOf = (plan: NibrsPlan, p: { from: string; to: string }) => planToMeaning(plan, { kind: "absolute", ...p });

/** The label's agency name as the words an answer must carry (its city), e.g. "St. Louis". */
function agencyWords(name: string): string {
  return name.replace(/\b(Metropolitan|Police|Department|Bureau|Division of|Sheriff'?s?|Office|County)\b/g, " ").replace(/\s+/g, " ").trim();
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
    else if (s === "names any months with no data as missing, not zero") ok = !blank || /No report is known for|Not every month of|were recorded for|does not establish/.test(all);
    else if (s === "names the months covered") ok = all.includes(periodWords(o.period.from, o.period.to));
    else if (/^says drug crimes include/.test(s)) ok = /drug equipment/i.test(all);
    if (ok === null) out.push({ field: "statement", expected: s, actual: "(no check defined)", kind: "unverified" });
    else if (!ok) out.push({ field: "statement", expected: s, actual: text.join(" / ").slice(0, 200), kind: "material" });
  }
  return out;
}

type Values = "match" | "mismatch" | "not measured";
/** Delivered cells (value and status) against independent expected cells; none given is NOT MEASURED, never a match. */
function valueDiffs(prefix: string, o: Extract<ShadowOutcome, { kind: "answer" }>, expected: ExpectedCell[] | undefined): { diffs: Diff[]; values: Values } {
  if (!expected) return { values: "not measured", diffs: [{ field: `${prefix}values`, expected: "independent expected values", actual: "none given: NOT MEASURED", kind: "unverified" }] };
  const rows = o.delivered.table.rows;
  const got = new Map(rows.map((r, i) => [r.length > 1 ? String(r[0]) : "", { value: r[r.length - 1] as number | null, status: o.delivered.evidence.find((e) => e.row === i)?.status ?? "?" }]));
  const diffs: Diff[] = [];
  if (got.size !== expected.length) diffs.push({ field: `${prefix}values`, expected: `${expected.length} cells`, actual: `${got.size} cells`, kind: "material" });
  for (const x of expected) {
    const g = got.get(x.key);
    if (!g || g.value !== x.value || g.status !== x.status) diffs.push({ field: `${prefix}value ${x.key || "total"}`, expected: `${x.value} ${x.status}`, actual: g ? `${g.value} ${g.status}` : "missing", kind: "material" });
  }
  return { diffs, values: diffs.length ? "mismatch" : "match" };
}
const worst = (vs: Values[]): Values | undefined => (vs.includes("mismatch") ? "mismatch" : vs.includes("not measured") ? "not measured" : vs.length ? "match" : undefined);
const sameAbout = (a: string, b: string) => normLabel(a) === normLabel(b);

/** What checking one delivered outcome found: its diffs, its value verdicts, and whether it delivered a wrong number. */
type Check = { diffs: Diff[]; values: Values[]; wrong: boolean; unverifiedAnswers: number };
const none = (): Check => ({ diffs: [], values: [], wrong: false, unverifiedAnswers: 0 });
const merge = (a: Check, b: Check): Check => ({ diffs: [...a.diffs, ...b.diffs], values: [...a.values, ...b.values], wrong: a.wrong || b.wrong, unverifiedAnswers: a.unverifiedAnswers + b.unverifiedAnswers });

/**
 * A delivered answer behind a button or an offered alternative, checked as a direct answer is: the meaning it should
 * have (when the label gives one), its values under `key`, the answer contract, and the text every answer must carry
 * (the agency named, months with no data named, the source last). A wrong meaning, value or contract is a wrong
 * answer; anything that cannot be checked leaves the answer unverified.
 */
function deliveredCheck(prefix: string, key: string, c: Extract<ShadowOutcome, { kind: "answer" }>, want: Meaning | null, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  ctx.checked.add(c);
  const meaning = want ? compareMeaning(want, viewOf(c.plan, c.period), r).map((x) => ({ ...x, field: `${prefix}${x.field}` }))
    : [{ field: `${prefix}meaning`, expected: "(the label gives no meaning past this button)", actual: `${c.plan.measures[0].id} ${c.period.from}..${c.period.to}`, kind: "unverified" as const }];
  const v = valueDiffs(prefix, c, ev?.get(key));
  const contract: Diff[] = c.delivered.contractProblems.length ? [{ field: `${prefix}answer contract`, expected: "no problems", actual: c.delivered.contractProblems.join("; "), kind: "material" }] : [];
  const place = want?.places[0];
  const required = [...(place && place.kind !== "national" && place.kind !== "state" ? [`names the agency (${place.name})`] : []), "names any months with no data as missing, not zero", "names its source at the end"];
  const text = [...statementDiffs({ statements: required } as never, c), ...fixedStatementDiffs(ctx.question, c)].map((x) => ({ ...x, field: `${prefix}${x.field}` }));
  const diffs = [...meaning, ...v.diffs, ...contract, ...text];
  const wrong = [...meaning, ...v.diffs, ...contract].some((x) => x.kind === "material");
  return { diffs, values: [v.values], wrong, unverifiedAnswers: !wrong && diffs.some((x) => x.kind === "unverified") ? 1 : 0 };
}

/** The question and the answers already checked against a label, shared by one case's checks. */
type Walk = { question: string; checked: Set<object> };

/**
 * The fixed sentences an answer must carry where they apply (result.ts ANSWER_STATEMENTS), checked on its text:
 * property_counted_by_offense when the question asks for victims and the answer counts offenses (P11);
 * property_not_attributed for an incident-level property filter; reported_nibrs_counts for the nation.
 */
function fixedStatementDiffs(question: string, c: Extract<ShadowOutcome, { kind: "answer" }>): Diff[] {
  const plan = c.plan;
  const want: AnswerStatement[] = [];
  if (/\bvictims?\b/i.test(question) && plan.measures.every((m) => m.unit === "offense")) want.push("property_counted_by_offense");
  if ([...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "property")) want.push("property_not_attributed");
  if (plan.geography.places.some((p) => p.kind === "national")) want.push("reported_nibrs_counts");
  return want.filter((s) => !c.delivered.text.includes(ANSWER_STATEMENTS[s]))
    .map((s) => ({ field: "statement", expected: ANSWER_STATEMENTS[s], actual: c.delivered.text.join(" / ").slice(0, 200), kind: "material" as const }));
}

/**
 * Every answer the outcome delivers, wherever it sits (the answer itself, any button however deep, any offered
 * alternative, expected by the label or not), visited once. One not already checked against the label is checked
 * without a meaning: its values where given, its contract and its text, and it stays unverified.
 */
function walkAnswers(prefix: string, key: string, o: ShadowOutcome, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  if (o.kind === "answer") return ctx.checked.has(o) ? none() : deliveredCheck(prefix, key, o, null, r, ev, ctx);
  if (o.kind === "clarify") return o.options.reduce((acc, x) => (x.continuation ? merge(acc, walkAnswers(`${prefix}option "${x.label}" `, `${key}|${x.label}`, x.continuation, r, ev, ctx)) : acc), none());
  return o.alternative?.continuation ? walkAnswers(`${prefix}alternative `, `${key}|alternative`, o.alternative.continuation, r, ev, ctx) : none();
}

/**
 * An option's or alternative's continuation against what it should reach: the label's meaning and everything a
 * delivered answer must satisfy (deliveredCheck). An option that asks the next part must ask the part the label names,
 * and the answers behind that next question are checked too.
 */
function continuationCheck(prefix: string, key: string, want: Meaning | null, wantLeads: string, nextAbout: string | undefined, got: ShadowOption, r: Release, ev: ExpectedValues | undefined, ctx: Walk): Check {
  const d = (field: string, e: string, a: string, kind: Diff["kind"]): Diff => ({ field: `${prefix}${field}`, expected: e, actual: a, kind });
  const one = (x: Diff): Check => ({ ...none(), diffs: [x] });
  if (wantLeads === "clarify") {
    const asked = got.entry ?? (got.continuation?.kind === "clarify" ? got.continuation.about : null);
    if (asked === null) return one(d("", `asks ${nextAbout ?? "the next part"}`, got.continuation?.kind ?? got.otherSource ?? "?", "material"));
    return { ...none(), diffs: nextAbout && !sameAbout(asked, nextAbout) ? [d("next part", nextAbout, asked, "material")] : [] };
  }
  if (got.entry) return one(d("", wantLeads, `opens an entry (${got.entry})`, "material"));
  if (got.otherSource) return one(want && want.source === got.otherSource ? d("", `${want.source} answer`, `routed to ${got.otherSource}: not run by this NIBRS shadow`, "unverified") : d("source", want?.source ?? wantLeads, got.otherSource, "material"));
  const c = got.continuation!;
  if (c.kind === "decline" && c.notBuilt) return one(d("", wantLeads, "refused: this build does not hold the months (not built)", "unverified"));
  if (c.kind === "decline" && /^Not in the slice yet/.test(c.explanation)) return one(d("", wantLeads, c.explanation, "unverified"));
  if (wantLeads === "answer") {
    if (c.kind !== "answer") return one(d("", "answer", `${c.kind}: ${c.kind === "decline" ? c.explanation.slice(0, 160) : c.about}`, "material"));
    return deliveredCheck(prefix, key, c, want, r, ev, ctx);
  }
  return { ...none(), diffs: c.kind === wantLeads ? [] : [d("", wantLeads, c.kind, "material")] };
}

export type ShadowScore = { result: CaseResult | null; excluded?: string };

export function scoreShadow(c: Case, o: ShadowOutcome, r: Release, ctx: { capability: string; era: string }, expectedValues?: ExpectedValues): ShadowScore {
  const e = c.expected!;
  const actual: ActualAction = o.kind;
  const notes: string[] = [];
  let diffs: Diff[] = [];
  const vals: Values[] = [];
  let wrongBehindButton = false, unverifiedAnswers = 0;
  const take = (k: Check) => { diffs.push(...k.diffs); vals.push(...k.values); wrongBehindButton ||= k.wrong; unverifiedAnswers += k.unverifiedAnswers; };
  const walk: Walk = { question: c.question, checked: new Set() };
  if (o.kind === "decline" && o.notBuilt) return { result: null, excluded: `refused as not built: ${o.explanation}` };
  if (o.kind === "decline") notes.push(`declined (${o.reason}): ${o.explanation.slice(0, 200)}`);
  if (o.kind === "clarify") notes.push(`asked ${o.about}: ${o.options.map((x) => x.label).join(" | ")}`);
  let structured = true, alternativeMissing = false;
  if (e.action === "answer" && o.kind === "answer") {
    walk.checked.add(o);
    diffs = [...compareMeaning(e.meaning, viewOf(o.plan, o.period), r), ...statementDiffs(e, o), ...fixedStatementDiffs(c.question, o)];
    const v = valueDiffs("", o, expectedValues?.get(c.id));
    diffs.push(...v.diffs); vals.push(v.values);
    if (v.diffs.some((x) => x.kind === "unverified")) unverifiedAnswers++;
    if (o.delivered.contractProblems.length) diffs.push({ field: "answer contract", expected: "no problems", actual: o.delivered.contractProblems.join("; "), kind: "material" });
    notes.push(`delivered: ${o.delivered.text.join(" / ").slice(0, 240)}`);
  }
  if (e.action === "clarify" && o.kind === "clarify") {
    for (const want of e.options) {
      const got = o.options.find((x) => normLabel(x.label) === normLabel(want.label));
      if (!got) { diffs.push({ field: `option "${want.label}"`, expected: "offered", actual: "missing", kind: "material" }); continue; }
      take(continuationCheck(`option "${want.label}" `, `${c.id}|${want.label}`, want.meaning, want.leads_to, want.next_about, got, r, expectedValues, walk));
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
      else {
        take(continuationCheck("alternative ", `${c.id}|alternative`, e.alternative, "answer", undefined, o.alternative, r, expectedValues, walk));
      }
    }
    structured = !diffs.some((x) => x.kind === "unverified");
  }
  // Then every other answer the outcome delivers, whatever the label expected.
  const rest = walkAnswers("", c.id, o, r, expectedValues, walk);
  take(rest);
  if (rest.diffs.length) structured = false;
  const material = diffs.filter((x) => x.kind === "material").length;
  const unverified = diffs.filter((x) => x.kind === "unverified").length;
  let outcome: Outcome = outcomeOf(e.action, actual, { material, unverified, structured, alternativeMissing });
  // The right action that carries the wrong options, reason or alternative is incomplete, never correct.
  if (e.action !== "answer" && actual === e.action && material) outcome = "incomplete";
  // A wrong number delivered anywhere, directly or behind a button or an offered alternative, is a wrong answer.
  // So is a number for a different question behind a button (a wrong meaning or contract).
  const values = worst(vals);
  if (values === "mismatch" || wrongBehindButton) outcome = "wrong_answer";
  return { result: { id: c.id, split: c.split, expected: e.action, actual, outcome, diffs, notes, capability: ctx.capability, era: ctx.era, ...(values ? { values } : {}),
    ...(unverifiedAnswers ? { unverifiedAnswers } : {}) } };
}
