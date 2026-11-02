/**
 * Every outcome's presentation (lib/answer-contract): the structured fields the page builds the title, lead, notes,
 * chart options and exports from, with the shared builders. Built here from what the engine computed (the plan, the
 * answered question, the table and the statements), never from its sentences; the only text read is the engine's own
 * lines that need no field (a month with no report, a blank named), kept as note lines in order.
 */
import type { NibrsPlan } from "../nibrs-plan/plan";
import { ANSWER_STATEMENTS, SHOWN, type AnswerStatement, type ResultTable } from "../nibrs-plan/result";
import { CAVEAT_ORDER, chartOptionsOf, NOTE_TEXT, PROFILES, type ChoicePresentation, type Lead, type NoteKey, type Offer,
  type Presentation, type SourceId, type TitleParts } from "../answer-contract/contract";
import type { ShadowOption, ShadowOutcome } from "./answer";
import { CATEGORY, fmt, measureWords, monthName, periodWords } from "./deliver";
import { HISTORICAL_MEASURE, type HistoricalAnswer } from "./historical";
import { agencyName, reportedBy, STATE_NAMES, type PlaceIndex } from "./places";
import { SRS_MEASURE, type SrsAnswer } from "./srs";
import type { StateSumMeta } from "./state-sum";

/** A rate or percentage to one decimal, with thousands separators ("1,655.1"). */
const one = (x: number) => x.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const CODE_BY_STATE = Object.fromEntries(Object.entries(STATE_NAMES).map(([c, n]) => [n, c]));
const and = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const dash = (s: string) => s.replace(/ (?:to|through) /g, "–");
/** "Memphis, Tennessee" -> "Memphis, TN" (Savant's place form). */
const shortLabel = (label: string) => { const m = /^(.*), ([A-Za-z .]+)$/.exec(label); return m && CODE_BY_STATE[m[2]] ? `${m[1]}, ${CODE_BY_STATE[m[2]]}` : label; };
/** "the Memphis Police Department", as reportedBy names it, without "Reported by". */
const reporter = (places: PlaceIndex, oris: string[]) => reportedBy(oris.map((o) => agencyName(places, o))).replace(/^Reported by /, "").replace(/\.$/, "");

/** The headers of grouping columns in natural order (time; age groups, Unknown last). */
const orderedOf = (t: ResultTable) => t.columns.flatMap((c) => (c.binding.kind === "grouping" && "ordered" in c && c.ordered ? [c.header] : []));

/** The source an outcome comes from. A clarify or decline is the engine's, whose live source here is NIBRS. */
export function sourceOf(o: ShadowOutcome): SourceId {
  return o.kind === "historical" || o.kind === "srs" ? "historical" : o.kind === "route" ? o.source : "nibrs";
}

/** When, for the lead: "each year from 2021 to 2025", "in 2024", "each month from January 2024 to June 2025". */
function whenWords(period: { from: string; to: string }, each: string | null, years?: number[]): string {
  const pre = each ? `each ${each} ` : "";
  if (years && years.length > 1) return `${pre}in ${and(years.map(String))}`;
  const whole = period.from.endsWith("-01") && period.to.endsWith("-12");
  const [fy, ty] = [period.from.slice(0, 4), period.to.slice(0, 4)];
  if (whole) return fy === ty ? `${pre}in ${fy}` : `${pre}from ${fy} to ${ty}`;
  return period.from === period.to ? `${pre}in ${monthName(period.from)}` : `${pre}from ${monthName(period.from)} to ${monthName(period.to)}`;
}
/** The title's period: years as "2021–2025", else months ("January–June 2024"). */
function titlePeriod(period: { from: string; to: string }, yearly: boolean, years?: number[]): string {
  if (years && years.length > 1) return and(years.map(String));
  if (yearly) return period.from.slice(0, 4) === period.to.slice(0, 4) ? period.from.slice(0, 4) : `${period.from.slice(0, 4)}–${period.to.slice(0, 4)}`;
  return dash(periodWords(period.from, period.to));
}
const partialOf = (period: { from: string; to: string }, yearly: boolean) =>
  yearly && !period.to.endsWith("-12") ? `${period.to.slice(0, 4)} (Partial): ${dash(periodWords(`${period.to.slice(0, 4)}-01`, period.to))}` : null;

/** Notes and the one caveat, from the statements shown (SHOWN) and the profile's list; the rest of the text as lines. */
function notesFrom(source: SourceId, statements: readonly AnswerStatement[], text: string[], known: Set<string>): Pick<Presentation, "caveat" | "notes"> {
  const allowed = new Set(PROFILES[source]!.caveats);
  const keys: NoteKey[] = statements.filter((s) => SHOWN.has(s) && allowed.has(s as NoteKey)) as NoteKey[];
  if (allowed.has("car_break_ins") && text.includes(NOTE_TEXT.car_break_ins)) keys.push("car_break_ins");
  const caveat = CAVEAT_ORDER.find((k) => keys.includes(k)) ?? null;
  const skip = new Set([...known, ...Object.values(ANSWER_STATEMENTS), NOTE_TEXT.car_break_ins, PROFILES[source]!.name.sourceLine]);
  return { caveat, notes: { keys: keys.filter((k) => k !== caveat), lines: text.slice(1).filter((t) => !skip.has(t)) } };
}

/**
 * P88 (proposed, 2026-11-02): the inline offer of the Consistent Reporting Agencies is shown when a sum covers two or
 * more years and the number of agencies reporting in some year differs from the first year's by 5% or more.
 */
export const PARTICIPATION_CHANGE = 0.05;
export function participationChanged(meta: StateSumMeta): boolean {
  if (meta.years.length < 2) return false;
  const first = meta.years[0].agencies;
  return first > 0 && meta.years.some((y) => Math.abs(y.agencies - first) / first >= PARTICIPATION_CHANGE);
}

/** A button's role and source: as its creator set them, else from its shape and what it runs. */
function offerOf(o: ShadowOption, from: SourceId, inClarify: boolean): Offer {
  const role = o.role ?? (o.entry ? "entry" : o.question ? "ask_instead" : inClarify ? "choice" : "nearest_question");
  const targetSource = o.targetSource ?? (o.continuation ? sourceOf(o.continuation) : from);
  return { role, targetSource, label: o.label, text: null };
}

/** NIBRS: the plan names everything the title and lead say. */
function nibrsPresentation(o: Extract<ShadowOutcome, { kind: "answer" }>, places: PlaceIndex): Presentation {
  const plan: NibrsPlan = o.plan;
  const units = new Set<string>(plan.measures.map((m) => m.unit));
  const groupWord = (d: string) => {
    if (d.startsWith("time.")) return d.slice(5);
    const h = CATEGORY[d]?.header ?? d.split(".").pop()!.replace(/_/g, " ");
    const who = /^(Victim|Offender|Arrestee) (.+)$/.exec(h);
    // A grouping's own person is dropped when the measure names it ("Murder Victims by Race").
    return (who && (units.has(who[1].toLowerCase()) || (who[1] === "Arrestee" && (units.has("arrest") || units.has("arrestee")))) ? who[2] : h).toLowerCase();
  };
  const timeG = plan.groupings.find((g) => g.dimension.startsWith("time."));
  const cats = plan.groupings.filter((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo."));
  const yearly = timeG?.dimension === "time.year";
  const years = plan.period.kind === "years" ? plan.period.years : undefined;
  const rate = plan.statistics.find((s) => s.kind === "rate");
  const rolling = plan.transforms.find((t) => t.kind === "rolling");
  const cmp = plan.transforms.find((t) => t.kind === "period_comparison");
  const placeTitle = plan.geography.places.map((p) => p.kind === "national" ? "United States" : p.kind === "state" ? STATE_NAMES[p.code] ?? p.code
    : p.kind === "agency" || p.kind === "county" ? shortLabel(p.label) : p.within.kind === "state" ? STATE_NAMES[p.within.code] ?? p.within.code : "United States");
  const measure = and(plan.measures.map((m) => measureWords(plan, m)));
  const titleParts: TitleParts = {
    places: placeTitle, measure, ratePer: rate && rate.kind === "rate" ? rate.per : null,
    groupings: [...(timeG ? [groupWord(timeG.dimension)] : []), ...cats.map((g) => groupWord(g.dimension))],
    period: cmp && cmp.kind === "period_comparison" ? `${dash(periodWords(cmp.earlier.from, cmp.earlier.to))} & ${dash(periodWords(cmp.later.from, cmp.later.to))}` : titlePeriod(o.period, yearly, years),
    partialLastYear: partialOf(o.period, yearly), rollingMonths: rolling && rolling.kind === "rolling" ? rolling.months : null,
  };
  const agencies = plan.geography.places.flatMap((p) => (p.kind === "agency" ? [p.ori] : []));
  const who = plan.geography.places.length === agencies.length && agencies.length ? reporter(places, agencies)
    : and(plan.geography.places.map((p) => p.kind === "national" ? "law enforcement agencies across the United States"
      : p.kind === "state" ? `${STATE_NAMES[p.code] ?? p.code} law enforcement agencies`
      : p.kind === "agency" ? reporter(places, [p.ori]) : p.kind === "county" ? `the ${p.label} agencies`
      : `${p.within.kind === "state" ? STATE_NAMES[p.within.code] ?? p.within.code : "United States"} city agencies`));
  const every = plan.coverage.cohort === "same_agencies";
  const countedAs = rolling && rolling.kind === "rolling" ? `as rolling ${rolling.months}-month totals`
    : rate ? "as rates per 100,000 people"
    : o.stateSum && !every ? "added up across the agencies that reported" : null;
  const when = cmp && cmp.kind === "period_comparison" ? `in ${periodWords(cmp.earlier.from, cmp.earlier.to)} and ${periodWords(cmp.later.from, cmp.later.to)}, with the change between them`
    : whenWords(o.period, timeG ? timeG.dimension.slice(5) : null, years);
  // A single number: one row, no breakdown, one measure; the columns beside it (agencies reporting, population covered,
  // the population a rate divides by) don't make it a table (coordinator 2026-11-02).
  const valueAt = o.delivered.table.columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === plan.statistics[0].as);
  const support = new Set(["agencies", "coverage", "population"]);
  const values = plan.statistics.filter((s) => !support.has(s.kind));
  const single = o.delivered.table.rows.length === 1 && !plan.groupings.length && !cmp && values.length === 1 && valueAt >= 0 && typeof o.delivered.table.rows[0][valueAt] === "number";
  const v = single ? (o.delivered.table.rows[0][valueAt] as number) : null;
  const lead: Lead = single
    ? { kind: "single", who, quantity: rate ? `${measure} at a rate of ${one(v!)} per 100,000 people` : `${fmt(v!)} ${measure}`, when, countedAs: rate ? null : countedAs }
    : { kind: "described", what: measure, who, when, countedAs, brokenDownBy: cats.length ? and(cats.map((g) => groupWord(g.dimension))) : null };

  // Offers: the Consistent Reporting Agencies (P61, P80) in Jeff's words, past P88's threshold; the way back from it.
  // One period has no change to explain: neither the reporting-change caveat nor the consistent-agencies offer, in
  // either view (coordinator 2026-11-02); its button is not offered.
  const meta = o.stateSum;
  const oneYear = !!meta && meta.years.length < 2;
  const offers: Offer[] = (o.buttons ?? []).map((b) => offerOf(b, "nibrs", false)).filter((x) => !(oneYear && x.role === "consistent_agencies"));
  if (meta && !oneYear) {
    const from = monthName(o.period.from), to = monthName(o.period.to);
    if (every) offers.push({ role: "all_agencies", targetSource: "nibrs", label: "All reporting agencies",
      text: { before: `This counts only the ${fmt(meta.everyAgencies)} Consistent Reporting ${meta.everyAgencies === 1 ? "Agency" : "Agencies"} that reported every month. `, link: "See all reporting agencies instead", after: "." } });
    else {
      const i = offers.findIndex((x) => x.role === "consistent_agencies");
      if (i >= 0 && participationChanged(meta)) offers[i] = { ...offers[i], text: {
        before: "Not every agency reported in every year, so part of this change could come from agencies starting or stopping reporting. To compare the same agencies across years, ",
        link: "see only the Consistent Reporting Agencies", after: ` that reported every month from ${from} through ${to}.` } };
    }
  }
  const known = new Set<string>([o.delivered.text[0] ?? "", ...(agencies.length ? [reportedBy(agencies.map((x) => agencyName(places, x)))] : [])]);
  return {
    source: "nibrs", titleParts, lead, offers, ...notesFrom("nibrs", o.delivered.answerStatements, o.delivered.text, known),
    coverage: { requested: plan.statistics.some((s) => s.kind === "agencies") },
    chart: chartOptionsOf(o.delivered.table, orderedOf(o.delivered.table)), ordered: orderedOf(o.delivered.table),
  };
}

/** Historical: an agency's figures (Crime Index build) or a state's or the nation's (the historical file). */
function historicalPresentation(o: HistoricalAnswer | SrsAnswer, places: PlaceIndex): Presentation {
  const q = o.question;
  const agencies = o.kind === "historical" ? o.question.agencies : [];
  const srsPlace = o.kind === "srs" ? o.question.place : { kind: "national" as const };
  const m = (o.kind === "historical" ? HISTORICAL_MEASURE : SRS_MEASURE)[q.measure];
  const clearance = q.statistic === "clearance_rate";
  const placeTitle = o.kind === "historical" ? agencies.map((a) => shortLabel(a.label))
    : [srsPlace.kind === "national" ? "United States" : STATE_NAMES[srsPlace.code] ?? srsPlace.code];
  const what = clearance ? `${m.words} cleared` : m.words;
  const cmp = q.comparison;
  const yearly = q.byYear;
  const titleParts: TitleParts = {
    places: placeTitle, measure: clearance ? `${m.name} clearance rate` : m.words, ratePer: q.statistic === "rate" ? 100000 : null,
    groupings: yearly ? ["year"] : [], period: cmp ? `${cmp.earlier} & ${cmp.later}` : titlePeriod(o.period, yearly), partialLastYear: null, rollingMonths: null,
  };
  const who = o.kind === "historical" ? reporter(places, agencies.map((a) => a.ori))
    : srsPlace.kind === "national" ? "law enforcement agencies across the United States" : `${STATE_NAMES[srsPlace.code] ?? srsPlace.code} law enforcement agencies`;
  const when = cmp ? `in ${cmp.earlier} and ${cmp.later}, with the change between them` : whenWords(o.period, yearly ? "year" : null);
  const countedAs = q.statistic === "rate" ? "as rates per 100,000 people" : clearance ? "as the percentage cleared" : null;
  const table = o.delivered.table;
  const single = table.rows.length === 1 && table.columns.length === 1 && typeof table.rows[0][0] === "number";
  const v = single ? (table.rows[0][0] as number) : null;
  const lead: Lead = single
    ? { kind: "single", who, quantity: q.statistic === "count" ? `${fmt(v!)} ${what}` : clearance ? `${one(v!)}% of ${m.words} as cleared` : `${m.words} at a rate of ${one(v!)} per 100,000 people`, when, countedAs: null }
    : { kind: "described", what, who, when, countedAs, brokenDownBy: null };
  const lineFor = o.kind === "historical" ? o.question.agencyLine ?? null : null;
  const known = new Set<string>([o.delivered.text[0] ?? "", ...(lineFor ? [lineFor] : [])]);
  return {
    source: "historical", titleParts, lead, offers: [], ...notesFrom("historical", [], o.delivered.text, known),
    coverage: { requested: false }, chart: chartOptionsOf(table, orderedOf(table)), ordered: orderedOf(table),
  };
}

/** The presentation of an answer; a clarify's, decline's or route's buttons, each with its role and source. */
export function presentationOf(o: ShadowOutcome, places: PlaceIndex): Presentation | ChoicePresentation {
  if (o.kind === "answer") return nibrsPresentation(o, places);
  if (o.kind === "historical" || o.kind === "srs") return historicalPresentation(o, places);
  const source = sourceOf(o);
  if (o.kind === "clarify") return { source, buttons: o.options.map((x) => offerOf(x, source, true)) };
  if (o.kind === "decline") return { source, buttons: o.alternative ? [offerOf(o.alternative, source, false)] : [] };
  return { source, buttons: [] };
}
