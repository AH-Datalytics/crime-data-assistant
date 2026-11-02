/**
 * The source-neutral answer contract (coordinator, 2026-11-02; Jeff: "be extra sure that things like the title problem
 * don't persist because they're NIBRS specific"; "unified as properly needed across the board while also treating
 * sources differently when the data types call for it").
 *
 * Two layers, with a clear line between them:
 *   shared       every source's answer carries the same structured `Presentation`, and one function each builds the
 *                title, the lead, the notes, the chart options and the exports from it. Nothing that shows an answer
 *                parses its text or branches on its source.
 *   per source   what differs because the data differs is declared once in a `SourceProfile` (PROFILES) that the
 *                builders read: units, grain, the coverage concept, the rate basis, breakdowns, caveats and names.
 *                Every field is required, with no defaults: a source with a missing field cannot be added (the
 *                conformance test, scripts/test-answer-conformance.ts).
 * Display names live in the profile; the page may keep its own short labels by `source`.
 */
import type { ResultTable } from "../nibrs-plan/result";

/** Every source the app answers from; only those in PROFILES are live in the engine. */
export type SourceId = "nibrs" | "historical" | "rtci" | "shr" | "hate_crime";

/** A note or caveat the app can show, by key (its words in NOTE_TEXT); a profile lists the keys its source may show. */
export type NoteKey = "property_not_attributed" | "property_counted_by_offense" | "categories_overlap" | "clearance_as_of_file"
  | "car_break_ins" | "blank_not_available";

export type SourceProfile = {
  /** What the source can count. */
  units: readonly string[];
  /** The finest time grain and how a period that isn't whole is named (D06: by its months). */
  grain: { finest: "month" | "year"; partial: "named_by_months" | "complete_years_only" };
  /** Whether the source's figures are shown as the source publishes them (P75), and its fixed-set view (P61, P80). */
  coverage: { published: boolean; cohortView: null | { label: "Consistent Reporting Agencies"; definition: string; levels: readonly ("state" | "national" | "agency")[] } };
  rateBasis: "published_or_computed" | "computed";
  /** Breakdowns, and whether each unit falls in one category (stacked charts only then). */
  breakdowns: readonly { dimension: string; exclusive: boolean; ordinal: boolean }[];
  /** The notes and caveats this source's answers may show. */
  caveats: readonly NoteKey[];
  /**
   * The source's own words (coordinator 2026-11-02): each crime it answers and the everyday names people use for it.
   * The shared reader reads them (conformance check 10b): a synonym listed here that doesn't read as its crime fails.
   * `not` lists words that must never read as that crime ("shootings" is not murder).
   */
  vocabulary: { terms: Readonly<Record<string, readonly string[]>>; not: Readonly<Record<string, readonly string[]>> };
  /** `reportedTo`: how the lead names where figures went; `asPublished`: added when the source publishes them. */
  name: { short: string; long: string; reportedToShort: string; reportedToLong: string; asPublished: string | null; sourceLine: string };
};

/** The live sources (NIBRS and Historical, which includes the historical file's state and national figures). */
export const PROFILES: Readonly<Partial<Record<SourceId, SourceProfile>>> = {
  nibrs: {
    units: ["offenses", "victims", "incidents", "offenders", "arrests"],
    grain: { finest: "month", partial: "named_by_months" },
    coverage: { published: false, cohortView: { label: "Consistent Reporting Agencies", definition: "agencies that reported every month of the whole period", levels: ["state", "national"] } },
    rateBasis: "computed",
    breakdowns: [
      { dimension: "victim.sex", exclusive: true, ordinal: false }, { dimension: "victim.race", exclusive: true, ordinal: false },
      { dimension: "victim.ethnicity", exclusive: true, ordinal: false }, { dimension: "victim.age", exclusive: true, ordinal: true },
      { dimension: "offense.clearance_type", exclusive: true, ordinal: false },
      { dimension: "offense_weapon.weapon", exclusive: false, ordinal: false }, { dimension: "offense.location_type", exclusive: false, ordinal: false },
      { dimension: "victim_offender.relationship", exclusive: false, ordinal: false },
      { dimension: "offender.sex", exclusive: false, ordinal: false }, { dimension: "offender.age", exclusive: false, ordinal: true },
    ],
    caveats: ["property_not_attributed", "property_counted_by_offense", "categories_overlap", "clearance_as_of_file", "car_break_ins"],
    vocabulary: {
      terms: { shoplifting: ["shoplifting"], carjacking: ["carjackings", "car jackings"], simple_assault: ["simple assaults"],
        theft_from_motor_vehicle: ["car break-ins", "thefts from cars"], murder: ["murders", "killings", "homicides"], motor_vehicle_theft: ["car theft", "stolen cars"] },
      not: { murder: ["shootings"] },
    },
    name: { short: "NIBRS", long: "the FBI's National Incident-Based Reporting System (NIBRS)", reportedToShort: "NIBRS",
      reportedToLong: "the FBI's National Incident-Based Reporting System (NIBRS)", asPublished: null, sourceLine: "Source: FBI NIBRS." },
  },
  historical: {
    units: ["offenses", "victims", "clearances"],
    grain: { finest: "year", partial: "complete_years_only" },
    coverage: { published: true, cohortView: null },
    rateBasis: "published_or_computed",
    breakdowns: [],
    caveats: ["blank_not_available"],
    // Crime Index's Part I offenses and the names people use (Jeff 2026-11-02: "Memphis homicides by year").
    vocabulary: {
      terms: { murder: ["murders", "homicides", "homicide", "killings"], rape: ["rapes"], robbery: ["robberies"], aggravated_assault: ["aggravated assaults"],
        burglary: ["burglaries", "break-ins"], theft: ["thefts", "larceny", "larceny-theft"], motor_vehicle_theft: ["motor vehicle thefts", "car theft", "auto theft", "stolen cars"],
        violent_crime: ["violent crime", "violent crimes"], property_crime: ["property crime", "property crimes"] },
      not: { murder: ["shootings"] },
    },
    name: { short: "Crime Index", long: "Crime Index's historical data", reportedToShort: "the FBI", reportedToLong: "the FBI",
      asPublished: "as published by Crime Index", sourceLine: "Source: Crime Index." },
  },
};

export const NOTE_TEXT: Record<Exclude<NoteKey, "blank_not_available">, string> = {
  property_not_attributed: "NIBRS lists property for the whole incident, not for each offense in it, so the property can't be tied to a single offense.",
  property_counted_by_offense: "Property crimes are counted by offense, not by victim.",
  categories_overlap: "A crime that falls in several of these categories is counted once in each, so the categories can add up to more than the total.",
  clearance_as_of_file: "A crime counts as cleared if it was cleared by the date of the data file, whenever that happened; the FBI's yearly tables instead count the clearances reported during the year, for crimes from any year.",
  car_break_ins: "Car break-ins are counted as theft from motor vehicles.",
};
/** The one caveat the lead carries, first of these present; the rest stay notes. */
export const CAVEAT_ORDER: readonly NoteKey[] = ["categories_overlap", "property_counted_by_offense", "car_break_ins", "clearance_as_of_file"];

/** What the title says (Savant format: place first, Title Case, "&", no colon, no period). */
export type TitleParts = {
  places: string[];        // "Memphis, TN", "Tennessee", "United States"
  measure: string;         // "shoplifting offenses", "robberies"
  ratePer: number | null;  // 100000 for a rate
  groupings: string[];     // "month", "victim sex"
  period: string;          // "2024", "2021–2025", "January–June 2024"
  partialLastYear: string | null;  // "2026 (Partial): January–September 2026"
  rollingMonths: number | null;
  /** A ranking's scope, between the place and the measure: "cities of 250,000+ with the most". */
  ranking: string | null;
};
/** The lead's first sentence, from parts (Jeff: "These are [what] [who] reported to [source], [when], [how]."). */
export type Lead =
  | { kind: "described"; what: string; who: string; when: string; countedAs: string | null; brokenDownBy: string | null }
  /** `quantity`: the number with what it counts ("10,149 shoplifting offenses", "robberies at a rate of 68.6 per 100,000 people"). */
  | { kind: "single"; who: string; quantity: string; when: string; countedAs: string | null };
export type OfferRole = "consistent_agencies" | "all_agencies" | "other_source" | "nearest_question" | "ask_instead" | "choice" | "entry" | "by_year";
/**
 * An offer or button: its role and the source it runs on; `text`: the lead's inline wording, the link in the middle;
 * `run`: what choosing it does, a path of button labels from the original question, or a new question.
 */
export type Offer = { role: OfferRole; targetSource: SourceId; label: string; text: { before: string; link: string; after: string } | null;
  run: { path: string[] } | { question: string } | { input: string } };
// `input`: the button asks the person for something first ("Another year" asks which year), then the whole question.
/**
 * The shared rule for zero categories (coordinator 2026-11-02), for every grouping and source: in a breakdown by period,
 * every category that occurs in any period of the answer is listed in every period, with 0 where that period's
 * reporting establishes none and blank where the period is unknown, so the periods line up row for row and line for
 * line. A category that occurs in no period is not listed. One period's breakdown lists the categories that occur.
 * (The engine's compiler does it: every category of the place and period in every month, compile.ts `cats`.)
 */
export const ZERO_CATEGORIES = "listed in every period once they occur in any" as const;

export type ChartKind = "line" | "bar" | "horizontal_bar" | "grouped_bar" | "stacked_bar" | "stacked_100";
export type ChartOptions = { allowed: ChartKind[]; default: ChartKind | null; exclusive: boolean | undefined; exclusiveByColumn: Record<string, boolean> | undefined };

export type Presentation = {
  source: SourceId;
  titleParts: TitleParts;
  lead: Lead;
  caveat: NoteKey | null;
  offers: Offer[];
  /** Notes by key (from the profile's list), then any lines naming this answer's own blanks or basis. */
  notes: { keys: NoteKey[]; lines: string[] };
  coverage: { requested: boolean };
  chart: ChartOptions;
  ordered: string[];
  /**
   * Each charted column's legend label, by header (coordinator 2026-11-02): places compared are named in the title's form
   * ("Memphis, TN"); a column not listed is labeled by its header.
   */
  series: Record<string, string>;
};
/** A clarify or decline: its source and its buttons. */
export type ChoicePresentation = { source: SourceId; buttons: Offer[] };

// ---------------------------------------------------------------------------------------------------------------------
// The shared builders: one each, for every source.

const SMALL = new Set(["a", "an", "the", "and", "or", "of", "by", "per", "in", "on", "at", "to", "for", "with", "from", "vs", "as", "into"]);
/** Title Case: every word capitalized except short ones (not first); "and" becomes "&"; capitals kept. */
export function titleCase(s: string): string {
  return s.split(/\s+/).filter(Boolean).map((w, i) => {
    const bare = w.toLowerCase();
    if (bare === "and") return "&";
    if (i > 0 && SMALL.has(bare)) return bare;
    return w.split(/([/-])/).map((p) => (/^[a-z]/.test(p) ? p[0].toUpperCase() + p.slice(1) : p)).join("");
  }).join(" ");
}
export const joinAmp = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} & ${xs[xs.length - 1]}`);
const joinAnd = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The chart title and subtitle (the subtitle only for a rolling window or a partial last year). */
export function titleOf(t: TitleParts): { title: string; subtitle: string | null } {
  const title = `${joinAmp(t.places)} ${t.ranking ? `${titleCase(t.ranking)} ` : ""}${titleCase(t.measure)}${t.ratePer ? ` per ${t.ratePer.toLocaleString("en-US")}` : ""}${t.groupings.length ? ` by ${titleCase(joinAnd(t.groupings))}` : ""}, ${titleCase(t.period)}`;
  const sub = [...(t.rollingMonths ? [`Rolling ${t.rollingMonths}-Month Totals`] : []), ...(t.partialLastYear ? [titleCase(t.partialLastYear)] : [])];
  return { title, subtitle: sub.length ? sub.join(", ") : null };
}

const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
/**
 * The lead (Jeff 2026-11-01): the factual first sentence (or the single number's sentence), at most one caveat, then
 * the inline offers. `firstMention`: spell the source out (the page tracks what it has already spelled out).
 */
export function leadOf(p: Presentation, opts: { firstMention: boolean } = { firstMention: true }): { sentences: string[]; offers: Offer[] } {
  const prof = PROFILES[p.source]!;
  const to = opts.firstMention ? prof.name.reportedToLong : prof.name.reportedToShort;
  const pub = prof.name.asPublished ? `, ${prof.name.asPublished},` : "";
  const l = p.lead;
  const first = l.kind === "single"
    ? `${cap(l.who)} reported ${l.quantity} to ${to}${pub} ${l.when}${l.countedAs ? `, ${l.countedAs}` : ""}.`
    : `These are ${l.what} ${l.who} reported to ${to}${pub} ${l.when}${l.countedAs ? `, ${l.countedAs}` : ""}${l.brokenDownBy ? `, broken down by ${l.brokenDownBy}` : ""}.`;
  const sentences = [first.replace(/,,/g, ","), ...(p.caveat && p.caveat !== "blank_not_available" ? [NOTE_TEXT[p.caveat]] : [])];
  return { sentences, offers: p.offers.filter((o) => o.text) };
}

/** The notes below the answer: its note keys' words, its own lines, then the source line last. */
export function notesOf(p: Presentation): string[] {
  return [...p.notes.keys.filter((k) => k !== "blank_not_available").map((k) => NOTE_TEXT[k as Exclude<NoteKey, "blank_not_available">]), ...p.notes.lines, PROFILES[p.source]!.name.sourceLine];
}

/**
 * The chart types a table allows (Jeff 2026-11-01: stacked and 100% only when honest), from its shape: a single number
 * has none; a line needs a time grouping; stacked needs every category column exclusive.
 */
export function chartOptionsOf(table: ResultTable, ordered: readonly string[] = [], tableOnly: readonly string[] = []): ChartOptions {
  // `tableOnly`: statistics shown in the table but never charted (the agencies reporting, the population covered or
  // divided by, the incidents beside a count): asking for them never changes the chart (coordinator 2026-11-02).
  const groups = table.columns.filter((c) => c.binding.kind === "grouping");
  const stats = table.columns.filter((c) => c.binding.kind === "statistic" && !tableOnly.includes(c.binding.as));
  const time = groups.some((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("time."));
  const cats = groups.filter((c) => c.binding.kind === "grouping" && !c.binding.dimension.startsWith("time.") && !c.binding.dimension.startsWith("geo."));
  const geo = groups.some((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("geo."));
  // Every category column must affirm it (Codex contract review 01.5): an unknown flag is not exclusive.
  const exclusive = cats.length ? cats.every((c) => c.exclusive === true) : undefined;
  const exclusiveByColumn = exclusive === undefined ? undefined : Object.fromEntries(stats.map((c) => [c.header, exclusive && (c.exclusive ?? true)]));
  const monthly = groups.some((c) => c.binding.kind === "grouping" && (c.binding.dimension === "time.month" || c.binding.dimension === "time.quarter"));
  let allowed: ChartKind[];
  if (table.rows.length <= 1 && !cats.length) allowed = [];
  else if (geo && !time) allowed = ["horizontal_bar"];
  else if (time && cats.length) allowed = ["line", "grouped_bar", ...(exclusive ? ["stacked_bar", "stacked_100"] as ChartKind[] : [])];
  else if (time) allowed = stats.length > 1 ? ["line", "grouped_bar"] : ["line", "bar"];
  else if (cats.length) allowed = ["horizontal_bar", "bar", ...(exclusive ? ["stacked_100"] as ChartKind[] : [])];
  else allowed = stats.length > 1 ? ["grouped_bar"] : [];
  // An ordinal breakdown (age groups) keeps its order left to right: an upright bar.
  const ordinal = cats.some((c) => ordered.includes(c.header));
  const def: ChartKind | null = !allowed.length ? null : time ? (monthly || stats.length > 1 || cats.length ? "line" : "bar") : ordinal && allowed.includes("bar") ? "bar" : allowed[0];
  return { allowed, default: def, exclusive, exclusiveByColumn };
}

/** A charted column's legend label. */
export const seriesLabel = (p: Presentation, header: string) => p.series[header] ?? header;

/** The table alone as CSV: its columns and rows exactly as shown; a blank for an unknown number. */
export function csvOf(table: ResultTable): string {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [table.columns.map((c) => q(c.header)).join(","), ...table.rows.map((r) => r.map((v) => (v === null || v === undefined ? "" : typeof v === "number" ? String(v) : q(String(v)))).join(","))].join("\n") + "\n";
}

/** What a PNG holds: the title (and subtitle), the chart, the table, and the source line last. */
export function pngSpecOf(p: Presentation, table: ResultTable): { title: string; subtitle: string | null; chart: ChartKind | null; columns: string[]; sourceLine: string } {
  return { ...titleOf(p.titleParts), chart: p.chart.default, columns: table.columns.map((c) => c.header), sourceLine: PROFILES[p.source]!.name.sourceLine };
}
