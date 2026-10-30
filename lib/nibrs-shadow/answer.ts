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
 *   D19                  drug crimes are drug/narcotic plus drug equipment violations: both, and their total;
 *   P31                  gun crime (murder victims, robbery offenses, aggravated assault victims with a firearm) and
 *                        stabbings (murder and aggravated assault victims with a knife): each part and the total; "gun
 *                        violence" and "shooters" (P45) are declined;
 *   P29/P49              "by men and women" names the offenders: the crimes by the sexes of their incidents' offenders;
 *   P50                  arrests are placed by arrest date;
 *   time (increment 3)   a set of years; a change between two periods (any wording reading.ts reads), the later
 *                        period clipped to the release with the earlier clipped to the same months (D06, D17), no
 *                        change from an unknown period (D17), no percent change from a zero base (P55); rolling
 *                        windows, each known only when all its months are; the last 12 months as one total (P56);
 *   P24/D04              a period after the data says where the data ends and offers this year so far; a period
 *                        before this build's first month is refused as not built (`notBuilt`).
 */
import type { Part, RequestLedger } from "../request-accounting";
import { COURT_TEXT, FORECAST_TEXT, readQuestion, readingSentence, type Flags } from "./reading";
import { matchNibrsType, MEASURE_CODES } from "../nibrs-question-types";
import { planFromSpec } from "../nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../nibrs-plan/draft-layer";
import { agencyPopulationSql, compilePlan, type CompileTarget } from "../nibrs-plan/compile";
import { compare, rolling, windowMonths, type MonthCell } from "../nibrs-plan/transforms";
import { validateOutcome } from "../nibrs-plan/outcome";
import type { Filter, LimitationReason, NibrsPlan, Place } from "../nibrs-plan/plan";
import { resolvePeriod, type ReleaseInfo } from "../nibrs-plan/resolve";
import { validateBindings } from "../nibrs-plan/validate";
import type { AnswerStatement } from "../nibrs-plan/result";
import { CATEGORY, deliver, deliverComparison, filterWords, monthName, periodWords, type Combined, type Delivered } from "./deliver";
import { agencyLabel, agencyName, candidateLabel, reportedBy, resolvePlace, type Candidate, type PlaceIndex, type PlaceResolution } from "./places";
import { answerPlaces } from "./places-answer";

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
/**
 * A choice filled in by a button: a part appended to the question's clause 0 (P22: nothing else changes). Each filled
 * part gets its own span past the question's end, so two filled parts never share a binding identity.
 */
function filled(ledger: RequestLedger, concept: string, value: string, text: string): RequestLedger {
  const n = ledger.question.length + 1 + ledger.parts.filter((p) => p.rule === "shadow:button").length;
  const part = { concept, value, span: [n, n], text, explains: [[n, n]], clause: 0, rule: "shadow:button", state: "recognized", explanation: null } as unknown as Part;
  const next = withParts(ledger, [...ledger.parts.filter((p) => !(p.clause === 0 && p.concept === concept)), part]);
  // A period or grain chosen by a button replaces the question's own time intent: a comparison or "the last 12 months"
  // read from the words no longer applies (Codex increment-3 review: else a future comparison's alternative recurs).
  return concept === "period" || concept === "grain" ? Object.assign(next, { comparison: null, last12: false }) : next;
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
  return fromLedger(readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger, deps);
}

/** What the reading pre-pass found, carried on the ledger (reading.ts). Alternatives built from a ledger clear the flags. */
const flags = (l: RequestLedger) => l as RequestLedger & Partial<Flags>;
const unflagged = (l: RequestLedger) => Object.assign(l, { forecast: false, court: false });

/** P20: the same place and crime over the last 10 complete years, by year (the question's own period and words dropped). */
function trendAlternative(ledger: RequestLedger, deps: ShadowDeps): ShadowOption {
  // Only the forecast's own words go: its verb ("rise", "go up": a change word, or unread forecast wording) and its period
  // ("next year", "2027"). Anything else the question asked keeps its part, and the alternative answers it or declines.
  const keep = ledger.parts.filter((p) => !(p.clause === 0 && ((p.state === "not-interpreted" && FORECAST_TEXT.test(p.text)) || ["period", "grain", "change"].includes(p.concept))));
  const l = filled(filled(unflagged(withParts(ledger, keep)), "grain", "year", "by year"), "period", "last:10", "the last 10 complete years");
  return { label: "The last 10 complete years, by year", continuation: fromLedger(l, deps) };
}
/** D01: the arrests for the same crime, place and period, which the data does record. */
function arrestsAlternative(ledger: RequestLedger, deps: ShadowDeps): ShadowOption {
  // Only the court outcome's own words go ("convictions", "led to", "went to trial"); anything else keeps its part.
  const keep = ledger.parts.filter((p) => !(p.clause === 0 && ((p.state === "not-recorded" && p.concept === "court") || (p.state === "not-interpreted" && COURT_TEXT.test(p.text))
    || p.concept === "unit" || (p.concept === "measure" && p.value === "unspecified"))));
  return { label: "Arrests for the same crime, place and period", continuation: fromLedger(filled(unflagged(withParts(ledger, keep)), "unit", "arrests", "arrests"), deps) };
}
const COURT_SENTENCE = "NIBRS doesn't record charges or court outcomes (prosecutions, trials, convictions, sentences or defendants); it records crimes reported to police, arrests and clearances.";
const UNDEFINED_TERM: Record<string, string> = {
  shooters: "\"Shooters\" is not a term the data defines: it records offenders and the weapons used, not who fired a gun.",
  "gun violence": "The data has no counts of non-fatal shootings, so gun violence cannot be counted. It can count gun crime: murders, robberies and aggravated assaults with a firearm.",
};
/** P31's weapons, as the reader writes them. */
const WEAPON_CODES: Record<string, string[]> = { firearm: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"], knife: ["20"] };
/** P29/P49: "by men and women" (both sexes) names the offenders' sexes. */
const BY_SEXES = /\bby\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/i;
const FORECAST_SENTENCE = "The data records past crime and cannot predict the future.";

/** P01: crimes whose completed years are Historical's and whose current year is Current Trends'; NIBRS answers their details. */
const PART_ONE = new Set(["murder", "homicide", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft", "arson", "violent_crime", "property_crime"]);

/** `pins`: places already chosen by a button, by the place part's start (P22: a choice made is not asked again). */
function fromLedger(ledger0: RequestLedger, deps: ShadowDeps, pins = new Map<number, Candidate>()): ShadowOutcome {
  const { release } = deps;
  const clause0 = (c: string) => ledger0.parts.filter((p) => p.clause === 0 && p.concept === c && p.state !== "context");

  // A question about the future, or about court outcomes, is declined first, with the nearest question the data answers
  // (P20, D01); its leftover words are not reasons. So is any other part the data does not record (a ZIP code): asking
  // which place, period or crime is meant in a question that cannot be answered would be an unnecessary question (D28).
  const unrecorded = ledger0.parts.filter((p) => p.clause === 0 && p.state === "not-recorded");
  if (flags(ledger0).forecast) return decline("forecast", FORECAST_SENTENCE, { alternative: trendAlternative(ledger0, deps) });
  if (flags(ledger0).court || unrecorded.some((p) => p.concept === "court")) return decline("court_outcome", COURT_SENTENCE, { alternative: arrestsAlternative(ledger0, deps) });
  const term = flags(ledger0).undefinedTerm;
  if (term) return decline("not_recorded_in_nibrs", UNDEFINED_TERM[term]);
  // P29: "by <group>" asks about offenders. "By men and women" is answered by the offenders' sexes (P49, below); any
  // other group (one sex, juveniles) is declined, never answered as victims.
  const bySexes = !!flags(ledger0).offenders && BY_SEXES.test(ledger0.question);
  if (flags(ledger0).offenders && !bySexes) return decline("unsupported_capability", "Not in the slice yet: \"by\" a group names the offenders (P29); only \"by men and women\" (the offenders' sexes) is built.");
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
  // P01: a standard (Part I) crime's count is Historical's (completed years) or Current Trends' (this year), not this
  // NIBRS shadow's; it is declined rather than answered from the wrong source.
  // Only a plain count of the crime: its details (a weapon, arrests, clearances, a breakdown) are NIBRS's, and go on to
  // the slice's own limits.
  // The reader's own change form ("did X increase from 2022 to 2023") is a plain count compared, under the same rule.
  const plainUnit = (u: string | null) => u === null || ["offenses", "victims", "incidents"].includes(u);
  const noDetail = !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  const asked = flags(ledger0).composite || !noDetail ? []
    : d.spec.type === "series" && !d.spec.filters.length && plainUnit(d.spec.unit) ? d.spec.measures
    : d.spec.type === "change" && d.spec.statistic === "count" && plainUnit(d.spec.unit) ? [d.spec.measure] : [];
  if (asked.some((x) => PART_ONE.has(x))) return decline("unsupported_capability", "Not in the slice yet: counts of this crime come from Historical or Current Trends (P01), which this NIBRS shadow does not run.");

  // The plan.
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace: (v) => resolved.get(v) ?? null });
  if (a.kind === "unmapped") return decline("unsupported_capability", `No plan form for this reading: ${a.reason}`);
  const plan = a.plan;
  // Places (increment 4): named agencies, separate or combined, and a state's city agencies for a ranking. State and
  // national totals are increment 5.
  const citySet = (p: Place) => p.kind === "agency_set" && p.within.kind === "state"
    && p.where.every((w) => (w.field === "agency.type" && JSON.stringify(w.value) === '["city"]') || w.field === "agency.population");
  if (plan.geography.places.some((p) => p.kind !== "agency" && !citySet(p)) || (plan.geography.places.some(citySet) && plan.geography.places.length > 1))
    return decline("unsupported_capability", "Not in the slice yet: state and national totals come later.");
  // The same agency named twice is one member (never counted twice).
  const namedPlaces = plan.geography.places.filter((p): p is Extract<Place, { kind: "agency" }> => p.kind === "agency");
  if (namedPlaces.length > 1) {
    const kept = namedPlaces.filter((p, i) => namedPlaces.findIndex((q) => q.ori === p.ori) === i);
    // A part bound to a dropped duplicate is bound to the place kept for that agency.
    const moved = new Map(namedPlaces.map((p, i) => [`geography.places[${i}]`, `geography.places[${kept.findIndex((q) => q.ori === p.ori)}]`]));
    plan.bindings = plan.bindings.map((b) => (moved.has(b.path) ? { ...b, path: moved.get(b.path)! } : b));
    plan.geography.places = kept;
  }
  // "Combined": one total of the agencies; one agency needs no agency column. "Combined" of anything else (several
  // crimes) is not answered as separate numbers (Codex 02.4).
  if (flags(ledger0).combined && plan.geography.places.length > 1) plan.geography.combine = "combined";
  else if (flags(ledger0).combined && !flags(ledger0).composite)
    return decline("unsupported_capability", `Not in the slice yet: "combined" applies to several agencies here; a combined total of several crimes comes later. I haven't answered with separate numbers.`);
  if (plan.geography.combine === "combined" || (plan.geography.places.length === 1 && plan.geography.places[0].kind === "agency")) {
    // Dropping the agency grouping renumbers the groupings after it: their bindings follow (Codex 02.3); a part bound
    // to the dropped grouping is bound to the places.
    const before = plan.groupings;
    plan.groupings = before.filter((g) => g.dimension !== "geo.place");
    const to = (i: number) => (before[i].dimension === "geo.place" ? "geography.places[0]" : `groupings[${plan.groupings.indexOf(before[i])}]`);
    plan.bindings = plan.bindings.map((b) => {
      const m = /^groupings\[(\d+)\](.*)$/.exec(b.path);
      return m && Number(m[1]) < before.length ? { ...b, path: `${to(Number(m[1]))}${before[Number(m[1])].dimension === "geo.place" ? "" : m[2]}` } : b;
    });
  }
  // P08: "large" cities are 250,000 residents or more.
  const set0 = plan.geography.places[0];
  if (flags(ledger0).largeCities) {
    if (set0.kind !== "agency_set") return decline("unsupported_capability", "Not in the slice yet: large cities outside a ranking of a state's cities.");
    set0.where.push({ field: "agency.population", op: ">=", value: 250000 });
    plan.defaults.push({ path: "geography.places[0].where", value: "250000", reason: "P08: large cities are 250,000 residents or more" });
  }
  // D05: a ranking with no number shows 20 rows.
  plan.transforms = plan.transforms.map((t) => (t.kind === "rank" && t.limit === null ? { ...t, limit: 20 } : t));
  let parts2 = a.parts;
  const statements: AnswerStatement[] = [];
  const unbind = (drop: (p: (typeof parts2)[number]) => boolean) => {
    const gone = parts2.filter(drop);
    parts2 = parts2.filter((p) => !drop(p));
    plan.bindings = plan.bindings.filter((b) => !gone.some((u) => u.span[0] === b.part.span[0] && u.concept === b.part.concept));
  };
  let combined: Combined | null = null;
  // D19: "drug crimes" are drug/narcotic plus drug equipment violations: both measures, and their total. Today's reader
  // reads them as drug possession alone ("drug possession" itself stays one measure).
  const drugPart = clause0("measure").find((p) => p.value === "drug_possession" && !/possess/i.test(p.text));
  // Drug crimes beside other crimes would need a total inside a list: declined (Codex review 02).
  if (drugPart && plan.measures.length > 1) return decline("unsupported_capability", "Not in the slice yet: drug crimes (drug/narcotic plus drug equipment violations, D19) beside other crimes.");
  if (drugPart && plan.measures.length === 1 && plan.measures[0].id === "offenses.drug_possession") {
    plan.measures.push({ id: "offenses.drug_equipment", unit: "offense", as: "drug_equipment_offenses" });
    plan.statistics.push({ kind: "count", as: "drug_equipment_offenses_count", measure: "drug_equipment_offenses" });
    combined = { label: "drug crimes", definition: "Drug crimes are drug/narcotic violations plus drug equipment violations." };
  }
  plan.measures.forEach((m, i) => {
    const name = m.id.replace(/^[a-z_]+\./, "");
    // D18: carjacking by offense; an offense has one location.
    if (m.id === "incidents.carjacking" && !clause0("unit").length) {
      plan.measures[i] = { ...m, id: "offenses.carjacking", unit: "offense" };
      plan.groupings = plan.groupings.map(({ multiValue, ...g }) => (g.dimension === "offense.location_type" ? g : { ...g, ...(multiValue ? { multiValue } : {}) }));
    }
    // P11: victims of a property crime -> offenses, with the fixed sentence. The unit part is answered differently by
    // decided policy and disclosed by that sentence, so it is not held to the victim unit.
    const codes = MEASURE_CODES[name];
    const property = name === "carjacking" || (!!codes && codes.every((c) => CRIMES_AGAINST_PROPERTY.has(c)));
    if (m.id.startsWith("victims.") && property) {
      plan.measures[i] = { ...m, id: `offenses.${name}`, unit: "offense" };
      plan.defaults.push({ path: `measures[${i}].unit`, value: "offense", reason: "P11: property crimes are counted by offense, not by victim" });
      unbind((p) => p.concept === "unit");
      if (!statements.includes("property_counted_by_offense")) statements.push("property_counted_by_offense");
    }
  });
  // P31: a composite's crimes, each in its own unit (FBI standard), with the composite's weapon on the offense that
  // connects a victim, or on the robbery offense itself.
  const composite = flags(ledger0).composite;
  if (composite) {
    const want = composite === "firearm" ? ["victims.murder", "offenses.robbery", "victims.aggravated_assault"] : ["victims.murder", "victims.aggravated_assault"];
    // Only the composite's own crimes: a crime asked beside it ("gun crimes and murders") would be absorbed into the
    // composite's weapon-filtered part, so that form is declined (Codex review 02).
    if (JSON.stringify(plan.measures.map((m) => m.id)) !== JSON.stringify(want) || clause0("measure").length !== want.length)
      return decline("unsupported_capability", "Not in the slice yet: gun crime or stabbings beside other crimes, or in this form.");
    plan.measures = plan.measures.map((m) => ({ ...m, filters: [{ kind: "exists", scope: m.unit === "victim" ? "victim" : "offense", entity: "offense_weapon",
      where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: WEAPON_CODES[composite] }] } as Filter] }));
    combined = composite === "firearm"
      ? { label: "gun crimes", definition: "Gun crime here is murder victims, robbery offenses and aggravated assault victims with a firearm." }
      : { label: "stabbings", definition: "Stabbings here are murder victims and aggravated assault victims with a knife or cutting instrument." };
  }
  // P29/P49: "by men and women" -> the crimes by the sexes of their incidents' offenders (each crime once under each sex
  // present), with each category's share. Only the victim-sex filters the reader made from those words are dropped and
  // unbound; any other restriction stays (and is declined later if it cannot be compiled) (Codex review 02).
  if (bySexes) {
    const at = BY_SEXES.exec(ledger0.question)!;
    const [from, to] = [at.index, at.index + at[0].length];
    const sexParts = parts2.filter((p) => p.concept === "filter" && /^sex:/.test(p.value ?? "") && p.span[0] >= from && p.span[1] <= to);
    const gone = new Set(plan.bindings.filter((b) => sexParts.some((p) => p.span[0] === b.part.span[0] && p.concept === b.part.concept))
      .map((b) => Number(/^filters\[(\d+)\]$/.exec(b.path)?.[1] ?? -1)));
    // A filter those words share with another part ("Female ... by men and women": one F filter) is that part's too.
    const shared = plan.bindings.some((b) => !sexParts.some((p) => p.span[0] === b.part.span[0] && p.concept === b.part.concept) && gone.has(Number(/^filters\[(\d+)\]$/.exec(b.path)?.[1] ?? -1)));
    if (shared) return decline("unsupported_capability", "Not in the slice yet: victims restricted by sex beside the offenders' sexes.");
    const kept = plan.filters.map((_, k) => k).filter((k) => !gone.has(k));
    plan.filters = kept.map((k) => plan.filters[k]);
    unbind((p) => sexParts.includes(p));
    // Bindings to the filters that stay follow them to their new places.
    plan.bindings = plan.bindings.map((b) => { const k = /^filters\[(\d+)\]/.exec(b.path); return k ? { ...b, path: b.path.replace(/^filters\[\d+\]/, `filters[${kept.indexOf(Number(k[1]))}]`) } : b; });
    if (plan.measures.length !== 1 || plan.groupings.some((g) => !g.dimension.startsWith("time."))) return decline("unsupported_capability", "Not in the slice yet: offenders' sexes beside another breakdown or measure.");
    plan.groupings.push({ dimension: "offender.sex", unknown: "visible", absent: "show", multiValue: "each_value" });
    const m0 = plan.measures[0];
    plan.statistics = [{ kind: "count", as: plan.statistics[0].as, measure: m0.as }, { kind: "share", as: "share_of_period", measure: m0.as, within: plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension) }];
  }
  // P50: arrests are placed by arrest date; arrests beside other measures would mix time bases (refused).
  const arrests = plan.measures.filter((m) => m.id.startsWith("arrests."));
  if (arrests.length && arrests.length !== plan.measures.length) return decline("unsupported_capability", "Not in the slice yet: arrests beside other measures (two time bases).");
  if (arrests.length) {
    plan.timeBasis = "arrest_date";
    plan.defaults.push({ path: "timeBasis", value: "arrest_date", reason: "P50: arrests are counted by arrest date" });
  }

  // Time (increment 3). A comparison the reading recorded becomes the plan's period_comparison over the whole span;
  // "the last 12 months" is one total (P56). Either replaces the reader's time grouping.
  const cmpFlag = flags(ledger0).comparison ?? null;
  if (cmpFlag || flags(ledger0).last12) {
    if (plan.transforms.length) return decline("unsupported_capability", "Not in the slice yet: this combination of time forms.");
    plan.groupings = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  }
  if (cmpFlag) {
    const st = plan.statistics[0];
    if (plan.measures.length !== 1 || plan.groupings.length || plan.statistics.length !== 1 || st.kind !== "count")
      return decline("unsupported_capability", "Not in the slice yet: a change of several crimes, of a breakdown, or of a rate.");
    // The plan's period is the comparison's whole years, as the question's period part reads; the compared periods
    // carry any months (R2: they lie inside it).
    plan.period = { kind: "absolute", from: `${cmpFlag.earlier.from.slice(0, 4)}-01`, to: `${cmpFlag.later.to.slice(0, 4)}-12` };
    plan.transforms = [{ kind: "period_comparison", of: [st.as], earlier: { kind: "absolute", ...cmpFlag.earlier }, later: { kind: "absolute", ...cmpFlag.later }, outputs: ["earlier", "later", "change", "pct_change"] }];
  }
  const rollingT = plan.transforms.find((t) => t.kind === "rolling");
  if (rollingT && (plan.measures.length !== 1 || plan.transforms.length !== 1 || plan.statistics.length !== 1 || plan.statistics[0].kind !== "count"
    || plan.groupings.length !== 1 || plan.groupings[0].dimension !== "time.month"))
    return decline("unsupported_capability", "Not in the slice yet: rolling windows of a rate, a breakdown, or several crimes.");
  if (plan.transforms.some((t) => t.kind !== "rolling" && t.kind !== "period_comparison" && !(t.kind === "rank" && plan.geography.places[0].kind === "agency_set")))
    return decline("unsupported_capability", "Not in the slice yet: rankings.");

  // The slice delivers counts, as totals or by month or year: one measure optionally broken down by ONE delivered
  // category with each category's share of its period (compiler increments 1 and 2), or several measures side by side
  // (with their combined total, as totals only, for D19 and P31). Two-way breakdowns, rates and other shares are
  // declined before anything is asked or run.
  const timeG = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const catG = plan.groupings.filter((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo."));
  // Several agencies, rates and rankings take the places path (increment 4).
  const placesMode = plan.geography.places.length > 1 || plan.geography.places[0].kind === "agency_set" || plan.statistics.some((x) => x.kind === "rate");
  if (placesMode && (plan.measures.length > 1 || catG.length || plan.transforms.some((t) => t.kind !== "rank")))
    return decline("unsupported_capability", "Not in the slice yet: several agencies or rates with several crimes, a breakdown, a change or rolling windows.");
  const [first, second, ...more] = plan.statistics;
  const counts = plan.statistics.every((s) => s.kind === "count") && plan.measures.every((m) => plan.statistics.filter((s) => "measure" in s && s.measure === m.as).length === 1);
  const several = plan.measures.length > 1;
  const shareOk = !second || several || (second.kind === "share" && first.kind === "count" && catG.length === 1 && second.measure === first.measure && !second.denominator
    && JSON.stringify(second.within) === JSON.stringify(timeG.map((g) => g.dimension)));
  if (catG.length > 1 || catG.some((g) => !CATEGORY[g.dimension]) || (first.kind !== "count" && !(placesMode && first.kind === "rate")) || (!several && more.length) || !shareOk
    || (several && (catG.length || !counts)) || (combined && timeG.length))
    return decline("unsupported_capability", "Not in the slice yet: this breakdown (two-way breakdowns, several measures broken down, a combined total by period), rates and other shares.");

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
  // A set of years ("in 2019 and 2024"): the span is for the release checks; the compiler counts only those years.
  let yearSet: number[] | null = null;
  try {
    const r = resolvePeriod(plan.period, release);
    if (r.kind === "years") { yearSet = [...r.years].sort((a, b) => a - b); period = { from: `${yearSet[0]}-01`, to: `${yearSet[yearSet.length - 1]}-12` }; }
    else period = { from: r.from, to: r.to };
  } catch (e) { return decline("unsupported_capability", String(e)); }
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
  let checked: NibrsPlan = period.to === requestedTo || yearSet ? plan : { ...plan, period: { kind: "absolute", ...period } };
  // A comparison whose later period runs past the data compares the same months of both (D06, D17); a later period
  // wholly after the data is P24's.
  const cmpT = checked.transforms.find((t) => t.kind === "period_comparison");
  let cmpPeriods: { earlier: { from: string; to: string }; later: { from: string; to: string } } | null = null;
  if (cmpT && cmpT.kind === "period_comparison") {
    const later = { from: cmpT.later.from, to: cmpT.later.to }, earlier = { from: cmpT.earlier.from, to: cmpT.earlier.to };
    if (later.from > release.lastMonth) return decline("outside_release_coverage", `${periodWords(later.from, later.to)} is not in the data; the latest month available is ${monthName(release.lastMonth)}.`);
    if (later.to > release.lastMonth) { later.to = release.lastMonth; earlier.to = addMonths(earlier.from, monthsBetween(later.from, later.to)); }
    cmpPeriods = { earlier, later };
    checked = { ...checked, period: { kind: "absolute", from: earlier.from, to: later.to },
      transforms: [{ ...cmpT, earlier: { kind: "absolute", ...earlier }, later: { kind: "absolute", ...later } }] };
  }

  // Validation, as any reader outcome: shape, semantic layer, release; then every part of the question applied.
  // A state's city agencies (a ranking) are the release's agencies with a population for that year, as answered.
  const cityMembers = new Map<string, string[]>();
  const geo = { members: (p: Place, y: number) => {
    if (p.kind === "agency") return [p.ori];
    if (p.kind !== "agency_set" || p.within.kind !== "state") return [];
    const min = p.where.find((w) => w.field === "agency.population");
    const key = `${p.within.code}|${y}|${min ? min.value : ""}`;
    if (!cityMembers.has(key)) cityMembers.set(key, deps.execute(agencyPopulationSql(deps.target.root, { state: p.within.code, city: true }, [y]))
      .filter((r) => !min || (r[2] !== null && Number(r[2]) >= Number(min.value))).map((r) => String(r[0])));
    return cityMembers.get(key)!;
  } };
  const authority = (v: string) => { const p = resolved.get(v); return p && p.kind === "agency" ? { oris: [p.ori] } : null; };
  const problems = [...validateOutcome({ kind: "plan", plan: checked }, DRAFT_LAYER, release, geo), ...validateBindings(plan, parts2, authority)];
  if (problems.length) return decline("unsupported_capability", `The plan did not validate: ${problems.map((p) => `${p.rule} ${p.path}: ${p.message}`).join("; ")}`);

  // A weapon or relationship restriction the answer cannot name is declined: a restricted count must say what restricts it.
  const unnamed = [...checked.filters, ...checked.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity !== "property" && !filterWords(f));
  if (unnamed) return decline("unsupported_capability", "Not in the slice yet: this weapon or relationship selection.");
  const notes0 = (flags(ledger0).readings ?? []).filter((x) => x.kind === "spelling").map(readingSentence);
  if (placesMode) return answerPlaces(checked, period, deps, statements, notes0, (why) => decline("unsupported_capability", why));
  // The place is the title; the next line names who reported the figures by the FBI's name (Jeff 2026-10-30).
  const reported = (d: Delivered): Delivered => {
    const p = checked.geography.places[0];
    if (p.kind !== "agency") return d;
    // After the title: the first line naming the place (a definition may come before it).
    const at = d.text.findIndex((t) => t.startsWith(p.label)) + 1 || 1;
    return { ...d, text: [...d.text.slice(0, at), reportedBy([agencyName(deps.places, p.ori)]), ...d.text.slice(at)] };
  };
  // Changes and rolling windows: one monthly query of the measure over every month they reach; the transforms roll it.
  if (cmpPeriods || rollingT) {
    const m = checked.measures[0];
    const months = rollingT && rollingT.kind === "rolling" ? rollingT.months : 0;
    const span = cmpPeriods ? { from: cmpPeriods.earlier.from, to: cmpPeriods.later.to } : { from: windowMonths(period.from, months)[0], to: period.to };
    const sub: NibrsPlan = { ...checked, measures: [{ ...m, filters: undefined }], filters: [...checked.filters, ...(m.filters ?? [])], transforms: [],
      groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }], period: { kind: "absolute", ...span } };
    const c = compilePlan(sub, { kind: "absolute", ...span }, deps.target);
    if (c.kind === "unsupported") return decline("unsupported_capability", `Not in the slice yet: ${c.reason}`);
    const got = deps.execute(c.query.sql);
    const cells: MonthCell[] = got.map((r) => ({ ym: String(r[0]), value: r[1] === null || r[1] === undefined ? null : Number(r[1]), status: String(r[2]) }));
    for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
    const inSpan = (p: { from: string; to: string }) => cells.filter((x) => x.ym >= p.from && x.ym <= p.to);
    // A conflict in any month the answer uses refuses the whole answer, as for every count.
    const used = cmpPeriods ? [...inSpan(cmpPeriods.earlier), ...inSpan(cmpPeriods.later)] : cells;
    if (used.some((x) => x.status === "EVIDENCE_CONFLICT")) return decline("unsupported_capability", "The records for this agency and period conflict with its monthly reporting status, so no number is given.");
    if (cmpPeriods) {
      const delivered = deliverComparison(checked, cmpPeriods, compare(inSpan(cmpPeriods.earlier), inSpan(cmpPeriods.later)), statements, release.id, notes0);
      if (delivered.contractProblems.length) return decline("unsupported_capability", `Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
      return { kind: "answer", plan: checked, period: { from: cmpPeriods.earlier.from, to: cmpPeriods.later.to }, sql: c.query.sql, delivered: reported(delivered) };
    }
    const displayed = cells.filter((x) => x.ym >= period.from && x.ym <= period.to).map((x) => x.ym);
    const windows = rolling(cells, months, displayed);
    const as = checked.statistics[0].as;
    const delivered = deliver(checked, period, requestedTo, ["period", as, `${as}_status`], windows.map((w) => [w.ym, w.value, w.status]), statements, release.id, notes0, null,
      { rolling: { months, missing: cells.filter((x) => x.status !== "VALUE" && x.status !== "REPORTED_ZERO").map((x) => x.ym) } });
    if (delivered.contractProblems.length) return decline("unsupported_capability", `Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
    return { kind: "answer", plan: checked, period, sql: c.query.sql, delivered: reported(delivered) };
  }
  // One compiled query per measure (its own filters as the query's), its rows joined on the period key.
  const sqls: string[] = [];
  let columns: string[] = [];
  let rows: unknown[][] = [];
  for (const m of checked.measures) {
    const sub: NibrsPlan = { ...checked, measures: [{ ...m, filters: undefined }], filters: [...checked.filters, ...(m.filters ?? [])], statistics: checked.statistics.filter((s) => "measure" in s && s.measure === m.as) };
    const c = compilePlan(sub, yearSet ? { kind: "years", years: yearSet, ...(period.to < `${yearSet[yearSet.length - 1]}-12` ? { through: period.to } : {}) } : { kind: "absolute", ...period }, deps.target);
    if (c.kind === "unsupported") return decline("unsupported_capability", `Not in the slice yet: ${c.reason}`);
    const got = deps.execute(c.query.sql);
    if (got.some((r) => c.query.columns.some((col, i) => col.endsWith("_status") && c.query.refuseOn.includes(String(r[i])))))
      return decline("unsupported_capability", "The records for this agency and period conflict with its monthly reporting status, so no number is given.");
    for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
    sqls.push(c.query.sql);
    if (!columns.length) { columns = c.query.columns; rows = got; continue; }
    // Several measures have no categories: the same period keys (or one total row) in the same order.
    const ip = c.query.columns.indexOf("period");
    const keys = (rs: unknown[][], i: number) => rs.map((r) => (i >= 0 ? String(r[i]) : "")).join(",");
    if (got.length !== rows.length || keys(got, ip) !== keys(rows, columns.indexOf("period"))) return decline("unsupported_capability", "Not in the slice yet: measures whose periods do not line up.");
    const stat = c.query.columns.map((col, i) => (col === "period" ? -1 : i)).filter((i) => i >= 0);
    columns = [...columns, ...stat.map((i) => c.query.columns[i])];
    rows = rows.map((r, k) => [...r, ...stat.map((i) => got[k][i])]);
  }
  const delivered = deliver(checked, period, requestedTo, columns, rows, statements, release.id, notes0, combined, yearSet ? { years: yearSet } : {});
  if (delivered.contractProblems.length) return decline("unsupported_capability", `Not in the slice yet: the answer would not meet the answer contract (${delivered.contractProblems.join("; ")}).`);
  return { kind: "answer", plan: checked, period, sql: sqls.join(";\n"), delivered: reported(delivered) };
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthsBetween = (from: string, to: string) => monthIndex(to) - monthIndex(from);
const addMonths = (ym: string, n: number) => { const k = monthIndex(ym) + n; return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; };
const periodWordsShort = (from: string, to: string) => (from === to ? monthName(to) : `${monthName(from).split(" ")[0]} to ${monthName(to)}`);
