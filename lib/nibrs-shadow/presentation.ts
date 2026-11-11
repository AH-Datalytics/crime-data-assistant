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
import { STAFF_MEASURE, type StaffKind } from "./staffing";
import type { CurrentAnswer } from "./current";
import type { ShrAnswer } from "./shr";
import { agencyName, reportedBy, STATE_NAMES, type PlaceIndex } from "./places";
import { CONSISTENT_WORDS, NIBRS_WORDS } from "./reading";
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

/**
 * A number of people in round words (P90): two significant figures, millions in words ("4.1 million", "12 million",
 * "850,000").
 */
export function aboutPeople(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000, digits = Math.floor(Math.log10(m)) + 1;
    const r = digits >= 2 ? Math.round(m / 10 ** (digits - 2)) * 10 ** (digits - 2) : Math.round(m * 10) / 10;
    return `${r.toLocaleString("en-US", { maximumFractionDigits: 1 })} million`;
  }
  if (n <= 0) return "0";
  const step = 10 ** (Math.floor(Math.log10(n)) - 1);
  return (Math.round(n / step) * step).toLocaleString("en-US");
}
/** Statistics shown in the table only, never charted. */
const TABLE_ONLY = new Set(["agencies", "coverage", "population", "incidents"]);
/** The headers of grouping columns in natural order (time; age groups, Unknown last). */
const orderedOf = (t: ResultTable) => t.columns.flatMap((c) => (c.binding.kind === "grouping" && "ordered" in c && c.ordered ? [c.header] : []));

/** The source an outcome comes from. A clarify or decline is the engine's, whose live source here is NIBRS. */
export function sourceOf(o: ShadowOutcome): SourceId {
  return o.kind === "historical" || o.kind === "srs" ? "historical" : o.kind === "current" ? "rtci" : o.kind === "shr" ? "shr" : o.kind === "route" ? o.source : "nibrs";
}

/** When, for the lead: "each year from 2021 to 2025", "in 2024", "each month from January 2024 to June 2025". */
function whenWords(period: { from: string; to: string }, each: string | null, years?: number[]): string {
  // "each month" only when there is more than one (a single month or year is just "in ...").
  const span = (Number(period.to.slice(0, 4)) - Number(period.from.slice(0, 4))) * 12 + Number(period.to.slice(5, 7)) - Number(period.from.slice(5, 7)) + 1;
  const pre = each && span > (each === "year" ? 12 : each === "quarter" ? 3 : 1) ? `each ${each} ` : "";
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
  return { caveat, notes: { keys: keys.filter((k) => k !== caveat), lines: unsaid(text, skip) } };
}
/**
 * A text line's sentences, split where a sentence ends ("St. Louis", "U.S.", "D.C." and initials are not ends).
 * Exported for the conformance test.
 */
export function sentencesOf(line: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (const m of line.matchAll(/[.!?](?=\s+["(]?[A-Z0-9])/g)) {
    const before = line.slice(from, m.index! + 1);
    if (/(?:^|[\s(])(?:St|Ste|Mt|Ft|No|Dept|Co|Twp|Jr|Sr|vs|[A-Z])\.$|\b(?:[A-Z]\.){2,}$/.test(before)) continue;
    out.push(before.trim());
    from = m.index! + 1;
  }
  const rest = line.slice(from).trim();
  if (rest) out.push(rest);
  return out;
}
/**
 * The lines the page shows as notes: a line goes only when every sentence in it is said already (the lead, the header,
 * the source line, a note key); otherwise its sentences not said already stay (coordinator 2026-11-06, the Memphis
 * monthly rate: "Figures for…" and "not annualized" went with the headline's line).
 */
export function unsaid(text: string[], said: Set<string>): string[] {
  return text.flatMap((t) => {
    if (said.has(t)) return [];
    const kept = sentencesOf(t).filter((s) => !said.has(s));
    return kept.length ? [kept.join(" ")] : [];
  });
}

/**
 * P88 (Jeff 2026-11-02: accepted): the inline offer of the Consistent Reporting Agencies is shown when a sum covers two or
 * more years and the number of agencies reporting in some year differs from the first year's by 5% or more.
 */
export const PARTICIPATION_CHANGE = 0.05;
export function participationChanged(meta: StateSumMeta): boolean {
  if (meta.years.length < 2) return false;
  const first = meta.years[0].agencies;
  return first > 0 && meta.years.some((y) => Math.abs(y.agencies - first) / first >= PARTICIPATION_CHANGE);
}

/** Where an outcome was reached: the question asked and the button labels followed from it. */
export type Reached = { question?: string; path?: string[] };
/** A button's role, source and what choosing it runs: as its creator set them, else from its shape. */
function offerOf(o: ShadowOption, from: SourceId, inClarify: boolean, at: Reached): Offer {
  const role = o.role ?? (o.entry ? "entry" : o.question ? "ask_instead" : inClarify ? "choice" : "nearest_question");
  const targetSource = o.targetSource ?? (o.continuation ? sourceOf(o.continuation) : from);
  return { role, targetSource, label: o.label, text: null, run: o.question ? { question: o.question } : o.entry && !o.continuation ? { input: o.entry } : { path: [...(at.path ?? []), o.label] } };
}
/**
 * The all-agencies question for a consistent view asked in words: the wording removed, and NIBRS kept as the source,
 * so the way back never lands on another source (Codex contract confirmation 01.2).
 */
export function allAgencies(question: string): string {
  const q = question.replace(CONSISTENT_WORDS, "").replace(/\s+/g, " ").trim().replace(/[?.!\s]+$/, "");
  return NIBRS_WORDS.test(q) ? q : `${q} according to NIBRS`;
}
/** The engine lines the title and lead restate (the headline, when the table holds a number; the reporter line). */
function restated(d: { table: ResultTable; text: string[]; headline?: string }, extra: string[], valueAs?: string): Set<string> {
  // Only the answer's own number counts: a column beside it (agencies reporting, population covered) never stands in
  // for a missing result, whose explanation is the headline (Codex contract confirmation 01.1).
  const at = valueAs === undefined ? 0 : d.table.columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === valueAs);
  const valueCols = valueAs === undefined ? d.table.columns.map((_, i) => i).filter((i) => d.table.columns[i].binding.kind === "statistic") : [at];
  const anyNumber = d.table.rows.some((r) => valueCols.some((i) => i >= 0 && typeof r[i] === "number"));
  // The lead says the headline's first sentence, not what follows it in the same line.
  const head = d.headline ?? d.text[0] ?? "";
  return new Set([...(anyNumber ? [sentencesOf(head)[0] ?? ""] : []), ...extra]);
}

/** NIBRS: the plan names everything the title and lead say. */
function nibrsPresentation(o: Extract<ShadowOutcome, { kind: "answer" }>, places: PlaceIndex, at: Reached): Presentation {
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
  // The share cleared (a ratio of two counts of one crime): "share of shoplifting offenses cleared". A combined total:
  // its name ("drug crimes"). Otherwise each measure.
  const ratio = plan.statistics.find((s) => s.kind === "ratio");
  const base = measureWords(plan, plan.measures[plan.measures.length - 1]);
  const measure = ratio ? `share of ${base} cleared` : o.delivered.combined ?? and(plan.measures.map((m) => measureWords(plan, m)));
  // A ranking: its set and direction ("cities of 250,000+ with the most"); the place is the set's state or the nation.
  const set = plan.geography.places.find((p) => p.kind === "agency_set");
  const rank = plan.transforms.find((t) => t.kind === "rank");
  const floor = set && set.kind === "agency_set" ? set.where.find((w) => w.field === "agency.population" && w.op === ">=") : undefined;
  const floorN = floor && typeof floor.value === "number" ? floor.value : null;
  const most = rank && rank.kind === "rank" ? (rank.direction === "top" ? (rate ? "the highest" : "the most") : (rate ? "the lowest" : "the fewest")) : null;
  const ranking = set && most ? `cities${floorN ? ` of ${fmt(floorN)}+` : ""} with ${most}` : null;
  const titleParts: TitleParts = {
    places: placeTitle, measure, ratePer: rate && rate.kind === "rate" ? rate.per : null, ranking,
    groupings: [...(timeG ? [groupWord(timeG.dimension)] : []), ...cats.map((g) => groupWord(g.dimension))],
    period: cmp && cmp.kind === "period_comparison" ? `${dash(periodWords(cmp.earlier.from, cmp.earlier.to))} & ${dash(periodWords(cmp.later.from, cmp.later.to))}` : titlePeriod(o.period, yearly, years),
    partialLastYear: partialOf(o.period, yearly), rollingMonths: rolling && rolling.kind === "rolling" ? rolling.months : null,
  };
  const agencies = plan.geography.places.flatMap((p) => (p.kind === "agency" ? [p.ori] : []));
  const who = plan.geography.places.length === agencies.length && agencies.length ? reporter(places, agencies)
    : and(plan.geography.places.map((p) => p.kind === "national" ? "law enforcement agencies across the United States"
      : p.kind === "state" ? `${STATE_NAMES[p.code] ?? p.code} law enforcement agencies`
      : p.kind === "agency" ? reporter(places, [p.ori]) : p.kind === "county" ? `the ${p.label} agencies`
      : `${p.within.kind === "state" ? STATE_NAMES[p.within.code] ?? p.within.code : "United States"} city agencies${floorN ? ` with a population of ${fmt(floorN)} or more` : ""}`));
  const every = plan.coverage.cohort === "same_agencies";
  const countedAs = rolling && rolling.kind === "rolling" ? `as rolling ${rolling.months}-month totals`
    : most ? `the ${fmt(o.delivered.table.rows.length)} with ${most}${rate ? " rates per 100,000 people" : ""}`
    : rate ? "as rates per 100,000 people"
    : o.stateSum && !every ? "added up across the agencies that reported" : null;
  const when = cmp && cmp.kind === "period_comparison" ? `in ${periodWords(cmp.earlier.from, cmp.earlier.to)} and ${periodWords(cmp.later.from, cmp.later.to)}, with the change between them`
    : whenWords(o.period, timeG ? timeG.dimension.slice(5) : null, years);
  // A single number: one row, no breakdown, one measure; the columns beside it (agencies reporting, population covered,
  // the population a rate divides by) don't make it a table (coordinator 2026-11-02).
  // The share cleared is one number too: its ratio, with the counts beside it.
  const valueStat = ratio ?? plan.statistics[0];
  const valueAt = o.delivered.table.columns.findIndex((c) => c.binding.kind === "statistic" && c.binding.as === valueStat.as);
  const support = new Set(["agencies", "coverage", "population", "incidents"]);
  const values = ratio ? [ratio] : plan.statistics.filter((s) => !support.has(s.kind));
  const single = o.delivered.table.rows.length === 1 && !plan.groupings.length && !cmp && !set && values.length === 1 && valueAt >= 0 && typeof o.delivered.table.rows[0][valueAt] === "number";
  const v = single ? (o.delivered.table.rows[0][valueAt] as number) : null;
  const lead: Lead = single
    ? { kind: "single", who, quantity: ratio ? `${one(v!)}% of ${base} as cleared` : rate ? `${measure} at a rate of ${one(v!)} per 100,000 people` : `${fmt(v!)} ${measure}`, when, countedAs: rate || ratio ? null : countedAs }
    : { kind: "described", what: measure, who, when, countedAs, brokenDownBy: cats.length ? and(cats.map((g) => groupWord(g.dimension))) : null };

  // Offers: the Consistent Reporting Agencies (P61, P80) in Jeff's words, past P88's threshold; the way back from it.
  // One period has no change to explain: neither the reporting-change caveat nor the consistent-agencies offer, in
  // either view (coordinator 2026-11-02); its button is not offered.
  const meta = o.stateSum;
  const oneYear = !!meta && meta.years.length < 2;
  const offers: Offer[] = (o.buttons ?? []).map((b) => offerOf(b, "nibrs", false, at)).filter((x) => !(oneYear && x.role === "consistent_agencies"));
  if (meta && !oneYear) {
    const from = monthName(o.period.from), to = monthName(o.period.to);
    // The way back: one button back when this view was reached by its button, else the question without its wording.
    const path = at.path ?? [];
    const back = path.length && path[path.length - 1] === "Consistent Reporting Agencies" ? { path: path.slice(0, -1) }
      : at.question ? { question: allAgencies(at.question) } : null;
    if (every && back) offers.push({ role: "all_agencies", targetSource: "nibrs", label: "All reporting agencies", run: back,
      // Jeff 2026-11-02: the agencies, the people they cover now (P90), and the span they reported every month of.
      text: { before: `This counts only the ${fmt(meta.everyAgencies)} Consistent Reporting ${meta.everyAgencies === 1 ? "Agency" : "Agencies"}, covering ${meta.everyCurrentPopulation.missing ? "at least" : "roughly"} ${aboutPeople(meta.everyCurrentPopulation.sum)} people, that reported every month from ${from} through ${to}. `, link: "See all reporting agencies instead", after: "." } });
    else {
      const i = offers.findIndex((x) => x.role === "consistent_agencies");
      if (i >= 0 && participationChanged(meta)) offers[i] = { ...offers[i], text: {
        before: "Not every agency reported in every year, so part of this change could come from agencies starting or stopping reporting. To compare the same agencies across years, ",
        link: "see only the Consistent Reporting Agencies", after: ` that reported every month from ${from} through ${to}.` } };
    }
  }
  const known = restated(o.delivered, agencies.length ? [reportedBy(agencies.map((x) => agencyName(places, x)))] : [], valueStat.as);
  return {
    source: "nibrs", titleParts, lead, offers, ...notesFrom("nibrs", o.delivered.answerStatements, o.delivered.text, known),
    coverage: { requested: plan.statistics.some((s) => s.kind === "agencies") },
    chart: chartOptionsOf(o.delivered.table, orderedOf(o.delivered.table), plan.statistics.filter((s) => TABLE_ONLY.has(s.kind)).map((s) => s.as)),
    ordered: orderedOf(o.delivered.table), series: {},
  };
}

/** Historical: an agency's figures (Crime Index build) or a state's or the nation's (the historical file). */
function historicalPresentation(o: HistoricalAnswer | SrsAnswer, places: PlaceIndex): Presentation {
  const q = o.question;
  const agencies = o.kind === "historical" ? o.question.agencies : [];
  // Several states or the nation side by side (answerSrsSeveral) are all named (Codex root-causes review 01.5).
  const srsPlaces = o.kind === "srs" ? o.question.places ?? [o.question.place] : [{ kind: "national" as const }];
  const srsName = (p: (typeof srsPlaces)[number]) => (p.kind === "national" ? "United States" : STATE_NAMES[p.code] ?? p.code);
  // Population on its own (population.ts) has no crime: its words are the measure's.
  // Police staffing (staffing.ts, item 1) has no crime: its words are the staff counted's.
  const m = q.measure === "population" ? { words: "population", name: "population" } : q.measure.startsWith("staffing:") ? STAFF_MEASURE[q.measure.slice(9) as StaffKind] : (o.kind === "historical" ? HISTORICAL_MEASURE : SRS_MEASURE)[q.measure];
  const clearance = q.statistic === "clearance_rate";
  // Agencies beside states or the nation (answerBeside, population.ts): every place, in the order asked.
  const beside = o.kind === "historical" ? o.question.beside ?? [] : [];
  const shown = o.kind === "historical" && o.question.shown ? o.question.shown.map(shortLabel) : null;
  const placeTitle = shown ?? (o.kind === "historical" ? agencies.map((a) => shortLabel(a.label)) : srsPlaces.map(srsName));
  const what = clearance ? `${m.words} cleared` : m.words;
  const cmp = q.comparison;
  const yearly = q.byYear;
  const titleParts: TitleParts = {
    places: placeTitle, measure: clearance ? `${m.name} clearance rate` : m.words, ratePer: q.statistic === "rate" ? 100000 : null,
    groupings: yearly ? ["year"] : [], period: cmp ? `${cmp.earlier} & ${cmp.later}` : titlePeriod(o.period, yearly), partialLastYear: null, rollingMonths: null, ranking: null,
  };
  const besideWho = beside.length ? `${agencies.length ? " and " : ""}law enforcement agencies in ${beside.map((p) => (p.kind === "national" ? "the United States" : srsName(p))).join(" and ")}` : "";
  const who = o.kind === "historical" ? `${agencies.length ? reporter(places, agencies.map((a) => a.ori)) : ""}${besideWho}`
    : srsPlaces.length > 1 ? `law enforcement agencies in ${srsPlaces.map((p) => (p.kind === "national" ? "the United States" : srsName(p))).join(" and ")}`
      : srsPlaces[0].kind === "national" ? "law enforcement agencies across the United States" : `${srsName(srsPlaces[0])} law enforcement agencies`;
  const when = cmp ? `in ${cmp.earlier} and ${cmp.later}, with the change between them` : whenWords(o.period, yearly ? "year" : null);
  const countedAs = q.statistic === "rate" ? "as rates per 100,000 people" : clearance ? "as the percentage cleared" : null;
  const table = o.delivered.table;
  const single = table.rows.length === 1 && table.columns.length === 1 && typeof table.rows[0][0] === "number";
  const v = single ? (table.rows[0][0] as number) : null;
  // Population on its own: whose population, by name (the places' own words: "the Memphis Police Department",
  // "Tennessee", "the United States").
  const popWho = (o.kind === "historical" ? o.question.shown ?? [] : []).map((n) => {
    const a = agencies.find((x) => x.label === n);
    return a ? reporter(places, [a.ori]) : n === "United States" ? "the United States" : n;
  });
  const lead: Lead = o.kind === "historical" && o.question.list
    ? { kind: "agencies", where: srsName({ kind: "state", code: o.question.list.state }), count: o.question.list.count, top: o.question.list.top, when }
    : q.measure === "population"
    ? { kind: "population", who: popWho.length > 2 ? `${popWho.slice(0, -1).join(", ")} and ${popWho[popWho.length - 1]}` : popWho.join(" and "), value: single ? v : null, when }
    : single
    ? { kind: "single", who, quantity: q.statistic === "count" ? `${fmt(v!)} ${what}` : clearance ? `${one(v!)}% of ${m.words} as cleared` : `${m.words} at a rate of ${one(v!)} per 100,000 people`, when, countedAs: null }
    // Clearance rates over years or agencies (item 7) are said as rates: "These are murder clearance rates the Chicago
    // Police Department reported ...", never "murders cleared the ... reported".
    : { kind: "described", what: clearance ? `${m.name} clearance rates` : what, who, when, countedAs: clearance ? null : countedAs, brokenDownBy: null };
  const lineFor = o.kind === "historical" ? o.question.agencyLine ?? null : null;
  const known = restated(o.delivered, lineFor ? [lineFor] : []);
  return {
    source: "historical", titleParts, lead, offers: [], ...notesFrom("historical", [], o.delivered.text, known),
    coverage: { requested: false }, chart: chartOptionsOf(table, orderedOf(table)), ordered: orderedOf(table),
    // Several agencies by year: one column each, labeled as the title names them.
    series: Object.fromEntries(table.columns.flatMap((c) => {
      const i = c.binding.kind === "statistic" ? /\.(\d+)$/.exec(c.binding.as) : null;
      if (i && o.kind === "srs" && srsPlaces.length > 1 && srsPlaces[Number(i[1])]) return [[c.header, srsName(srsPlaces[Number(i[1])])]];
      if (i && shown && shown[Number(i[1])]) return [[c.header, shown[Number(i[1])]]];
      return i && agencies[Number(i[1])] ? [[c.header, shortLabel(agencies[Number(i[1])].label)]] : [];
    })),
  };
}

/** Current Trends (current.ts): a place by month, or one total for the year to date or the rolling 12 months. */
function currentPresentation(o: CurrentAnswer, places: PlaceIndex): Presentation {
  const q = o.question, m = HISTORICAL_MEASURE[q.measure];
  const monthly = q.form === "months";
  const placeTitle = [q.place.kind === "agency" ? shortLabel(q.place.label) : q.place.label.replace(/^The /, "")];
  const rate = q.statistic === "rate";
  const titleParts: TitleParts = { places: placeTitle, measure: m.words, ratePer: rate ? 100000 : null, groupings: monthly ? ["month"] : [], period: titlePeriod(o.period, false),
    partialLastYear: null, rollingMonths: q.form === "rolling" ? 12 : null, ranking: null };
  const who = q.place.kind === "agency" ? reporter(places, [q.place.ori]) : `the Consistent Reporting Agencies of ${q.place.label.replace(/^The /, "the ")}`;
  const table = o.delivered.table;
  const single = table.rows.length === 1 && table.columns.length === 1 && typeof table.rows[0][0] === "number";
  const when = whenWords(o.period, monthly ? "month" : null);
  const v = single ? (table.rows[0][0] as number) : null;
  // A rolling average is said as one (Jeff 2026-11-05), never as the window's total.
  const average = q.form === "rolling" && q.window?.average;
  const lead: Lead = single ? { kind: "single", who, quantity: rate ? `${m.words} at a rate of ${one(v!)} per 100,000 people` : average ? `${one(v!)} ${m.words} a month on average` : `${fmt(v!)} ${m.words}`, when, countedAs: null }
    : { kind: "described", what: m.words, who, when, countedAs: rate ? "as rates per 100,000 people" : null, brokenDownBy: null };
  const known = restated(o.delivered, q.agencyLine ? [q.agencyLine] : []);
  return { source: "rtci", titleParts, lead, offers: [], ...notesFrom("rtci", [], o.delivered.text, known), coverage: { requested: false },
    chart: chartOptionsOf(table, orderedOf(table)), ordered: orderedOf(table), series: {} };
}

/** Homicide Reports (shr.ts): a place's murder victims or offenders, by year or month, with a detail. */
function shrPresentation(o: ShrAnswer, places: PlaceIndex): Presentation {
  const q = o.question;
  const what = o.delivered.table.columns.find((c) => c.binding.kind === "statistic")?.header.toLowerCase() ?? "murder victims";
  const placeTitle = [q.place.kind === "agency" ? shortLabel(q.place.label) : q.place.kind === "state" ? (STATE_NAMES[q.place.code] ?? q.place.code) : "United States"];
  const groupings = [...(q.grain !== "total" ? [q.grain] : []), ...(q.breakdown ? [q.breakdown.dim.replace(".", " ")] : [])];
  const titleParts: TitleParts = { places: placeTitle, measure: what, ratePer: null, groupings, period: titlePeriod(o.period, q.grain === "year"),
    partialLastYear: null, rollingMonths: null, ranking: null };
  const who = q.place.kind === "agency" ? reporter(places, [q.place.ori]) : `the agencies of ${q.place.kind === "state" ? (STATE_NAMES[q.place.code] ?? q.place.code) : "the United States"} that filed Homicide Reports`;
  const table = o.delivered.table;
  const single = table.rows.length === 1 && table.columns.length === 1 && typeof table.rows[0][0] === "number";
  const when = whenWords(o.period, q.grain === "total" ? null : q.grain);
  const lead: Lead = single ? { kind: "single", who, quantity: `${fmt(table.rows[0][0] as number)} ${what}`, when, countedAs: null }
    : { kind: "described", what, who, when, countedAs: null, brokenDownBy: q.breakdown ? q.breakdown.dim.replace(".", " ") : null };
  const known = restated(o.delivered, []);
  return { source: "shr", titleParts, lead, offers: [], ...notesFrom("shr", [], o.delivered.text, known), coverage: { requested: false },
    chart: chartOptionsOf(table, orderedOf(table)), ordered: orderedOf(table), series: {} };
}

/** The presentation of an answer; a clarify's, decline's or route's buttons, each with its role and source. */
export function presentationOf(o: ShadowOutcome, places: PlaceIndex, at: Reached = {}): Presentation | ChoicePresentation {
  if (o.kind === "answer") return nibrsPresentation(o, places, at);
  if (o.kind === "historical" || o.kind === "srs") return historicalPresentation(o, places);
  if (o.kind === "current") return currentPresentation(o, places);
  if (o.kind === "shr") return shrPresentation(o, places);
  const source = sourceOf(o);
  if (o.kind === "clarify") return { source, buttons: o.options.map((x) => offerOf(x, source, true, at)) };
  if (o.kind === "decline") return { source, buttons: [...(o.alternative ? [o.alternative] : []), ...(o.more ?? [])].map((x) => offerOf(x, source, false, at)) };
  return { source, buttons: [] };
}
