/**
 * The shadow slice, question to delivered answer, for single-agency NIBRS counts on a pinned canonical build. SHADOW
 * ONLY: no route imports it, nothing here is deployed, and it reads the canonical parquet files read-only.
 *
 *   typed question -> today's request accounting and reader (unchanged) -> the plan adapter -> the slice's policy
 *   steps -> plan validation (shape, semantic layer, bindings, release) -> the compiler -> DuckDB -> deliver.ts
 *
 * Outcomes follow the plan contract (plan.ts ReaderOutcome): an answer from a validated plan; a clarifying question
 * whose options are the original question with one choice filled in (P22, run here as continuations); or a limitation
 * with its reason and, where policy offers one, an alternative. Options that only open an entry ("Another year", "A
 * state") have no fixed question; ReaderOutcome has no form for them yet, so the slice carries them as `entry`.
 *
 * The slice's policy steps, each from a decided row:
 *   D31/P05/P06/P12/D09  a question missing its crime, place or period is asked about, one part at a time;
 *   P28                  a place name with several real candidates (cities in two states, a city and a county, a
 *                        state) is asked about, a button per candidate (places.ts);
 *   P16                  a city means its principal police agency (places.ts);
 *   P11                  victims of a property crime are answered with offenses, with the fixed sentence;
 *   D18                  carjacking is counted by offense;
 *   P24/D04              a period after the data says where the data ends and offers this year so far; a period
 *                        before this build's first month is refused as not built (`notBuilt`).
 */
import type { Part, RequestLedger } from "../request-accounting";
import { accountNibrsRequest } from "../nibrs-request-accounting";
import { matchNibrsType, MEASURE_CODES } from "../nibrs-question-types";
import { planFromSpec } from "../nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../nibrs-plan/draft-layer";
import { compilePlan, type CompileTarget } from "../nibrs-plan/compile";
import { validateOutcome } from "../nibrs-plan/outcome";
import type { LimitationReason, NibrsPlan, Place } from "../nibrs-plan/plan";
import { resolvePeriod, type ReleaseInfo } from "../nibrs-plan/resolve";
import { validateBindings } from "../nibrs-plan/validate";
import type { AnswerStatement } from "../nibrs-plan/result";
import { deliver, monthName, periodWords, type Delivered } from "./deliver";
import { agencyLabel, candidateLabel, resolvePlace, type Candidate, type PlaceIndex, type PlaceResolution } from "./places";

export type ShadowDeps = {
  places: PlaceIndex;
  release: ReleaseInfo & { id: string; asOf: string };
  target: CompileTarget;
  /** Runs one SQL statement read-only and returns its rows. */
  execute(sql: string): unknown[][];
};

export type ShadowOption = {
  label: string;
  /** A fixed question: its continuation. An entry ("Another year"): what it asks next. */
  continuation?: ShadowOutcome;
  entry?: string;
  /** A reading answered by another source (P01): this NIBRS shadow does not run it. */
  otherSource?: string;
};
export type ShadowOutcome =
  | { kind: "answer"; plan: NibrsPlan; period: { from: string; to: string }; sql: string; delivered: Delivered }
  | { kind: "clarify"; about: string; question: string; options: ShadowOption[] }
  | { kind: "decline"; reason: LimitationReason | "reader"; explanation: string; alternative: ShadowOption | null; notBuilt?: boolean };

/** NIBRS Group A offenses whose crime-against category is property (robbery, and so carjacking, included). */
const CRIMES_AGAINST_PROPERTY = new Set(["120", "200", "210", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240", "250",
  "26A", "26B", "26C", "26D", "26E", "26F", "26G", "26H", "270", "280", "290", "510"]);

const decline = (reason: LimitationReason | "reader", explanation: string, extra: { alternative?: ShadowOption | null; notBuilt?: boolean } = {}): ShadowOutcome =>
  ({ kind: "decline", reason, explanation, alternative: extra.alternative ?? null, ...(extra.notBuilt ? { notBuilt: true } : {}) });

/** A ledger with its parts replaced (the reader and the adapter read `parts` and `question`). */
function withParts(ledger: RequestLedger, parts: Part[]): RequestLedger {
  return Object.assign(Object.create(Object.getPrototypeOf(ledger)), ledger, { parts });
}
/** A choice filled in by a button: a part appended to the question's clause 0 (P22: nothing else changes). */
function filled(ledger: RequestLedger, concept: string, value: string, text: string): RequestLedger {
  const n = ledger.question.length;
  const part = { concept, value, span: [n, n], text, explains: [[n, n]], clause: 0, rule: "shadow:button", state: "recognized", explanation: null } as unknown as Part;
  return withParts(ledger, [...ledger.parts.filter((p) => !(p.clause === 0 && p.concept === concept)), part]);
}

/** The reason a reader decline gives, as a limitation reason; "reader" when its words name none of them. */
function readerReason(explanation: string): LimitationReason | "reader" {
  if (/below the level of an agency/.test(explanation)) return "below_agency_level";
  if (/court outcomes/.test(explanation)) return "court_outcome";
  if (/can't explain causes/.test(explanation)) return "explanation_requested";
  if (/couldn't resolve that place/.test(explanation)) return "unresolved_place";
  return "reader";
}

export function shadowAnswer(question: string, deps: ShadowDeps): ShadowOutcome {
  return fromLedger(accountNibrsRequest(question), deps);
}

/** `pins`: places already chosen by a button, by the place part's start (P22: a choice made is not asked again). */
function fromLedger(ledger0: RequestLedger, deps: ShadowDeps, pins = new Map<number, Candidate>()): ShadowOutcome {
  const { release } = deps;
  const clause0 = (c: string) => ledger0.parts.filter((p) => p.clause === 0 && p.concept === c && p.state !== "context");

  // A part the data does not record (a ZIP code, a conviction) is declined first: asking which place, period or crime
  // is meant in a question that cannot be answered would be an unnecessary question (D28).
  const unrecorded = ledger0.parts.filter((p) => p.clause === 0 && p.state === "not-recorded");
  if (unrecorded.length) {
    const why = unrecorded.map((p) => p.explanation ?? `"${p.text}" is not recorded.`).join(" ");
    return decline(readerReason(why), why);
  }

  // Places next (P16, P28): resolve each city or county through the build's agencies; the reader then sees a resolved
  // value. A name with several real candidates is asked about.
  const resolved = new Map<string, Place>();
  let ask: { part: Part; name: string; candidates: Candidate[] } | null = null;
  const parts = ledger0.parts.map((p) => {
    if (p.clause !== 0 || p.concept !== "place" || !p.value || !/^(city|county|ambiguous):/.test(p.value)) return p;
    const pin = pins.get(p.span[0]);
    const r: PlaceResolution = pin ? (pin.kind === "state" ? { kind: "unresolved", why: "state" } : { kind: "agency", place: { kind: "agency", ori: pin.agency.ori, label: agencyLabel(pin.agency) }, agency: pin.agency }) : resolvePlace(deps.places, p.value, p.text);
    if (pin?.kind === "state") return { ...p, value: `state:${pin.name}` };
    if (r.kind === "unresolved") return p;
    if (r.kind === "ask") { ask ??= { part: p, name: r.name, candidates: r.candidates }; return p; }
    const value = `${r.agency.kind}:${r.agency.name}:${r.agency.state}`;
    resolved.set(value, r.place);
    return { ...p, value };
  });
  const ledger = withParts(ledger0, parts);
  if (ask) {
    const a: { part: Part; name: string; candidates: Candidate[] } = ask;
    const options = a.candidates.map((c) => ({ label: candidateLabel(c, a.candidates), continuation: fromLedger(ledger0, deps, new Map(pins).set(a.part.span[0], c)) }));
    // A question no choice could answer is declined, not asked about (D28): when no button leads to an answer or a
    // further question, the most likely reading's refusal is given.
    if (options.every((o) => o.continuation.kind === "decline")) return options[0].continuation;
    const named = a.candidates.find((c) => c.kind === "agency");
    return { kind: "clarify", about: `which ${named?.kind === "agency" ? named.agency.name.replace(/ County$/, "") : a.name}`, question: ledger0.question, options };
  }

  // D31: ask for a missing crime, place or period, one at a time, before any default is applied.
  const named = clause0("measure").some((p) => p.value !== "unspecified");
  if (!named && clause0("measure").length) {
    return { kind: "clarify", about: "which kind of crime", question: ledger0.question, options: [
      { label: "Violent crime", otherSource: "historical" }, { label: "Property crime", otherSource: "historical" }, { label: "Both", otherSource: "historical" }] };
  }
  if (!clause0("place").length) {
    return { kind: "clarify", about: "which place", question: ledger0.question, options: [
      { label: "The United States", continuation: fromLedger(filled(ledger, "place", "national", "the United States"), deps, pins) },
      { label: "A state", entry: "which state" }, { label: "A city or agency", entry: "which city or agency" }] };
  }
  const d = matchNibrsType(ledger);
  if (d.kind === "none") return decline("reader", "The question could not be read: no typed reading.");
  if (d.kind === "decline") return decline(readerReason(d.explanation), d.explanation);
  if (d.kind === "clarify") return decline("reader", `The reader asked in text only: ${d.explanation}`);
  // The plan.
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace: (v) => resolved.get(v) ?? null });
  if (a.kind === "unmapped") return decline("unsupported_capability", `No plan form for this reading: ${a.reason}`);
  const plan = a.plan;
  // The slice is one agency: states and the nation need status evidence across agencies (D6) and come later.
  if (plan.geography.places.some((p) => p.kind !== "agency")) return decline("unsupported_capability", "Not in the slice yet: state and national totals come later.");
  let parts2 = a.parts;
  const statements: AnswerStatement[] = [];
  const m = plan.measures[0];
  const name = m.id.replace(/^[a-z_]+\./, "");
  // D19: "drug crimes" are drug/narcotic plus drug equipment violations. Today's reader reads them as drug possession
  // alone, and the slice compiles one measure, so it declines rather than answer a narrower count.
  if (name === "drug_possession" && clause0("measure").some((p) => p.value === "drug_possession" && !/possess/i.test(p.text)))
    return decline("unsupported_capability", "Not in the slice yet: drug crimes are drug/narcotic violations plus drug equipment violations (D19), two measures.");
  // D18: carjacking by offense.
  if (m.id === "incidents.carjacking" && !clause0("unit").length) plan.measures[0] = { ...m, id: "offenses.carjacking", unit: "offense" };
  // P11: victims of a property crime -> offenses, with the fixed sentence. The unit part is answered differently by
  // decided policy and disclosed by that sentence, so it is not held to the victim unit.
  const codes = MEASURE_CODES[name];
  const property = name === "carjacking" || (!!codes && codes.every((c) => CRIMES_AGAINST_PROPERTY.has(c)));
  if (m.id.startsWith("victims.") && property) {
    plan.measures[0] = { ...m, id: `offenses.${name}`, unit: "offense" };
    plan.defaults.push({ path: "measures[0].unit", value: "offense", reason: "P11: property crimes are counted by offense, not by victim" });
    const unitPart = parts2.filter((p) => p.concept === "unit");
    parts2 = parts2.filter((p) => p.concept !== "unit");
    plan.bindings = plan.bindings.filter((b) => !unitPart.some((u) => u.span[0] === b.part.span[0] && u.concept === b.part.concept));
    statements.push("property_counted_by_offense");
  }

  // The slice delivers one count, as a total or by month or year. Breakdowns by category, shares and rates are not
  // delivered yet, so they are declined before anything is asked or run.
  if (plan.groupings.some((g) => !g.dimension.startsWith("time.")) || plan.statistics.length !== 1 || plan.statistics[0].kind !== "count")
    return decline("unsupported_capability", "Not in the slice yet: breakdowns by category, shares and rates.");

  // D31/P06: a missing period is asked about, for any reader form, once the question is known to be in the slice.
  const spec = d.spec as { period?: { form: string }; grain?: string };
  if (spec.period?.form === "none") {
    const lcy = Number(release.lastMonth.slice(0, 4)) - (release.lastMonth.endsWith("-12") ? 0 : 1);
    const thisYear = Number(release.lastMonth.slice(0, 4));
    const trend = !!spec.grain && spec.grain !== "total";
    const opts: ShadowOption[] = trend
      ? [{ label: "The last 10 complete years", continuation: fromLedger(filled(ledger, "period", "last:10", "the last 10 complete years"), deps, pins) },
         { label: "Every year available", continuation: fromLedger(filled(ledger, "period", `since:${release.firstMonth.slice(0, 4)}`, "every year available"), deps, pins) },
         { label: "Another range", entry: "which range of years" }]
      : [{ label: `The latest complete year (${lcy})`, continuation: fromLedger(filled(ledger, "period", `year:${lcy}`, `in ${lcy}`), deps, pins) },
         { label: "This year so far", continuation: fromLedger(filled(ledger, "period", `year:${thisYear}`, "this year so far"), deps, pins) },
         { label: "Another year", entry: "which year" }];
    return { kind: "clarify", about: trend ? "which range of years" : "which period", question: ledger0.question, options: opts };
  }

  // Release: the effective months. After the data: P24. Before this build: not built.
  let period: { from: string; to: string };
  try { const r = resolvePeriod(plan.period, release); if (r.kind !== "absolute") return decline("unsupported_capability", "Separate years are not in the slice."); period = { from: r.from, to: r.to }; }
  catch (e) { return decline("unsupported_capability", String(e)); }
  if (period.from > release.lastMonth) {
    const y = release.lastMonth.slice(0, 4);
    return decline("outside_release_coverage", `${periodWords(period.from, period.to)} is not in the data; the latest month available is ${monthName(release.lastMonth)}.`,
      { alternative: { label: `This year so far (${periodWordsShort(`${y}-01`, release.lastMonth)})`, continuation: fromLedger(filled(ledger, "period", `year:${y}`, "this year so far"), deps, pins) } });
  }
  if (period.from < release.firstMonth) {
    return decline("outside_release_coverage", `This build holds ${monthName(release.firstMonth)} through ${monthName(release.lastMonth)}, so it does not cover ${periodWords(period.from, period.to)}.`, { notBuilt: true });
  }
  const requestedTo = period.to;
  // A year still in progress runs through the release's last month (D06: the answer names the months covered). The
  // release rules check that clipped period; the question's own period part is checked against what it asked for.
  if (period.to > release.lastMonth) period = { from: period.from, to: release.lastMonth };
  const checked: NibrsPlan = period.to === requestedTo ? plan : { ...plan, period: { kind: "absolute", ...period } };

  // Validation, as any reader outcome: shape, semantic layer, release; then every part of the question applied.
  const geo = { members: (p: Place) => (p.kind === "agency" ? [p.ori] : []) };
  const authority = (v: string) => { const p = resolved.get(v); return p && p.kind === "agency" ? { oris: [p.ori] } : null; };
  const problems = [...validateOutcome({ kind: "plan", plan: checked }, DRAFT_LAYER, release, geo), ...validateBindings(plan, parts2, authority)];
  if (problems.length) return decline("unsupported_capability", `The plan did not validate: ${problems.map((p) => `${p.rule} ${p.path}: ${p.message}`).join("; ")}`);

  const c = compilePlan(checked, { kind: "absolute", ...period }, deps.target);
  if (c.kind === "unsupported") return decline("unsupported_capability", `Not in the slice yet: ${c.reason}`);
  const rows = deps.execute(c.query.sql);
  const refused = rows.filter((r) => c.query.columns.some((col, i) => col.endsWith("_status") && c.query.refuseOn.includes(String(r[i]))));
  if (refused.length) return decline("unsupported_capability", "The records for this agency and period conflict with its monthly reporting status, so no number is given.");
  const delivered = deliver(checked, period, requestedTo, c.query.columns, rows, [...c.query.statements, ...statements], release.id);
  if (delivered.contractProblems.length) return decline("unsupported_capability", `Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
  return { kind: "answer", plan: checked, period, sql: c.query.sql, delivered };
}

const periodWordsShort = (from: string, to: string) => (from === to ? monthName(to) : `${monthName(from).split(" ")[0]} to ${monthName(to)}`);
