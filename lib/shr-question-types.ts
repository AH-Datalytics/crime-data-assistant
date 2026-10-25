/**
 * Request accounting, stage 1, plan r3.1 (Codex-accepted with clarification 2026-10-08): a CLOSED LIST of
 * supported Homicide Reports question types. Jeff's scope: docs/superpowers/2026-10-08-shr-supported-question-types-draft.md.
 *
 * WHY. r2 recognized parts independently and assumed any combination of them composed correctly. Codex's r2 review
 * showed the composition itself was wrong (a breakdown turned a share into a count, "before 2025" became 2025, a
 * cross-field OR became AND, offenders were counted as victims, the share denominator followed word position). Here
 * a request must fill the slots of exactly one question type, or the whole request is declined, naming each part
 * that does not fit. The compiler switches on the TYPE first, so a grouping can never replace a type's statistic.
 *
 *   T1 count            T2 count by one breakdown      T3 share (year grain only)
 *   T4 victim age       T5 top places by count         T6 one agency's rate per 100,000 (by year)
 *
 * Source semantics are the accepted GC-080 ones: ORI ranges clipped to the period, the credited county resolver,
 * one row per victim, and frozen issuance with execution authority. City/County membership comes only from the
 * accepted year-bound classification (`shr_agency_year_class`, SCA-1/SCA-2). The model writes nothing here.
 */
import type Database from "better-sqlite3";
import { resolveShrAgency } from "./shr-place-resolver";
import { shrCountyRequest } from "./shr-county-request";
import { resolveShrCountyScope, type ShrScopeBinding, type ShrCountyScopeResolution } from "./shr-county-scope";
import { STATE_NAME_TO_ABBR } from "./state-population";
import type { RequestLedger, Part } from "./request-accounting";
import { refusalSentences } from "./request-accounting";
import { recordWhyFacts } from "./why-scope";
import {
  cachedYearClassAvailability, unresolvedInScopes, unresolvedDisclosure, unresolvedLimitation,
  YEAR_CLASS_UNAVAILABLE_TEXT, SHR_YEAR_CLASS_TABLE, type ClassScope,
} from "./shr-agency-year-class";

/* ================================================================== *
 * The spec
 * ================================================================== */

type OriRange = { ori: string; startYear: number; endYear: number };

export type QGeo =
  | { kind: "national" }
  | { kind: "states"; states: { code: string; name: string }[] }
  | { kind: "agencies"; places: { display: string; ranges: OriRange[] }[] }
  | { kind: "county"; binding: ShrScopeBinding };

export type YearMonth = { year: number; month: number };

/** One condition: OR over its predicates (one field, possibly several columns), compiled from the value tables only. */
export type QPredicate = { table: "v" | "i"; column: string; kind: "in" | "like" | "range"; values: string[]; lo?: number; hi?: number };
export type QField = "sex" | "race" | "ethnicity" | "age" | "weapon" | "relationship" | "circumstance";
export type QFilter = { field: QField; predicates: QPredicate[]; label: string };

export type QDimension = "state" | "county" | "city" | "weapon" | "relationship" | "circumstance" | "race" | "sex" | "age-group";
export type QuestionType = "count" | "count-by" | "share" | "age" | "top" | "agency-rate";

export type ShrQuestionSpec = {
  type: QuestionType;
  geo: QGeo;
  /** A list of places: one stated combined total ("union"), or each place on its own row ("each"). */
  combine: "single" | "union" | "each";
  periods: YearMonth[];
  periodNote: string | null;
  /** The observed last month of the source (owner 2026-10-25: a title says "(Partial)" only where the SOURCE ends). */
  sourceEnd?: { year: number; month: number } | null;
  time: "year" | "month" | null;
  measure: "murder" | "homicide" | "manslaughter";
  unit: "victims" | "incidents";
  filters: QFilter[];
  agencyType: "City" | "County" | null;
  dimension: QDimension | null;
  /** T3: the one numerator condition. Every filter above is the denominator. */
  numerator: QFilter | null;
  /** T4. */
  age: "median" | "average" | null;
  /** T5. */
  rank: { n: number; direction: "desc" | "asc" } | null;
  /** T2 by place, T5: tested on each place's total over the WHOLE requested period. */
  threshold: { op: ">=" | ">" | "<=" | "<"; value: number; words: string } | null;
  /** T2/T5 by county: each ORI's county, mapped at plan time (one county per ORI, else unmapped). */
  countyMap: { ori: string; county: string }[] | null;
  /** T6: years the source's latest month cuts short; shown without a rate. */
  noRateYears: number[];
};

export type ShrQuestionDecision =
  | { kind: "spec"; spec: ShrQuestionSpec }
  | { kind: "decline"; parts: Part[]; explanation: string }
  | { kind: "county-exit"; resolution: Exclude<ShrCountyScopeResolution, { status: "resolved" }> };

/** The SHR cutoff as observed from the database being queried; `observed: false` when it could not be read. */
export type ShrCutoff = { year: number; month: number; observed: boolean; minYear: number };

export function observeShrCutoff(db: Database.Database): ShrCutoff {
  try {
    const r = db.prepare("SELECT MIN(year) AS lo, MAX(year) AS hi FROM incidents").get() as { lo: number | null; hi: number | null } | undefined;
    if (r?.hi == null || r.lo == null) return { year: 0, month: 0, observed: false, minYear: 0 };
    const m = (db.prepare("SELECT MAX(month) AS m FROM incidents WHERE year = ?").get(r.hi) as { m: number | null } | undefined)?.m;
    return { year: r.hi, month: m ?? 12, observed: m != null, minYear: r.lo };
  } catch {
    return { year: 0, month: 0, observed: false, minYear: 0 };
  }
}

/* ================================================================== *
 * Value tables (task 0 evidence: lib/shr-claude.ts value lists over the production-derived DDL; unchanged from r2)
 * ================================================================== */

const INTIMATE = ["Wife", "Husband", "Common-Law Wife", "Common-Law Husband", "Girlfriend", "Boyfriend", "Ex-Wife", "Ex-Husband", "Homosexual Relationship"];
const FAMILY = ["Wife", "Husband", "Common-Law Wife", "Common-Law Husband", "Mother", "Father", "Son", "Daughter", "Brother", "Sister", "In-Law", "Stepfather", "Stepmother", "Stepson", "Stepdaughter", "Other Family"];
const KNOWN = ["Neighbor", "Acquaintance", "Boyfriend", "Girlfriend", "Ex-Husband", "Ex-Wife", "Employee", "Employer", "Friend", "Homosexual Relationship", "Other Known"];

type ValueRule = { ask: RegExp; p: QPredicate; label: string };
const inc = (column: string, kind: QPredicate["kind"], values: string[]): QPredicate => ({ table: "i", column, kind, values });

const WEAPON_RULES: ValueRule[] = [
  { ask: /handgun|pistol|revolver/i, p: inc("weapon", "like", ["Handgun%"]), label: "handgun" },
  { ask: /rifle/i, p: inc("weapon", "like", ["Rifle%"]), label: "rifle" },
  { ask: /shotgun/i, p: inc("weapon", "like", ["Shotgun%"]), label: "shotgun" },
  { ask: /firearm|\bguns?\b|gunfire|gunshot/i, p: inc("weapon_group", "in", ["Firearm"]), label: "firearm" },
  { ask: /knife|knives|stab|cutting|blade/i, p: inc("weapon_group", "in", ["Knife/Cutting"]), label: "knife or cutting instrument" },
  { ask: /blunt|club|hammer|\bbats?\b/i, p: inc("weapon_group", "in", ["Blunt Object"]), label: "blunt object" },
  { ask: /hands|fist|feet|beat|personal/i, p: inc("weapon_group", "in", ["Personal Weapons"]), label: "personal weapons (hands, fists, feet)" },
  { ask: /strangl|chok/i, p: inc("weapon_group", "in", ["Strangulation"]), label: "strangulation" },
  { ask: /asphyx|suffocat|drown/i, p: inc("weapon_group", "in", ["Asphyxiation"]), label: "asphyxiation" },
  { ask: /\bfire\b|arson|burn/i, p: inc("weapon_group", "in", ["Fire"]), label: "fire" },
  { ask: /drug|narcotic/i, p: inc("weapon_group", "in", ["Narcotics/Drugs"]), label: "narcotics or drugs" },
  { ask: /poison/i, p: inc("weapon_group", "in", ["Poison"]), label: "poison" },
];

const RELATIONSHIP_RULES: ValueRule[] = [
  { ask: /stranger/i, p: inc("relationship", "in", ["Stranger"]), label: "killed by a stranger" },
  { ask: /homosexual|same[-\s]sex/i, p: inc("relationship", "in", ["Homosexual Relationship"]), label: "same-sex relationship" },
  { ask: /intimate|partner|spouse|romantic|dating/i, p: inc("relationship", "in", INTIMATE), label: "killed by an intimate partner" },
  { ask: /ex[-\s]?wi(?:fe|ves)/i, p: inc("relationship", "in", ["Ex-Wife"]), label: "victim was the offender's ex-wife" },
  { ask: /ex[-\s]?husband/i, p: inc("relationship", "in", ["Ex-Husband"]), label: "victim was the offender's ex-husband" },
  { ask: /\bwi(?:fe|ves)\b/i, p: inc("relationship", "in", ["Wife", "Common-Law Wife"]), label: "victim was the offender's wife" },
  { ask: /husband/i, p: inc("relationship", "in", ["Husband", "Common-Law Husband"]), label: "victim was the offender's husband" },
  { ask: /girlfriend/i, p: inc("relationship", "in", ["Girlfriend"]), label: "victim was the offender's girlfriend" },
  { ask: /boyfriend/i, p: inc("relationship", "in", ["Boyfriend"]), label: "victim was the offender's boyfriend" },
  { ask: /\bparents?\b/i, p: inc("relationship", "in", ["Father", "Mother"]), label: "victim was the offender's parent" },
  { ask: /\bsons?\b|\bdaughters?\b|\bchild(?:ren)?\b/i, p: inc("relationship", "in", ["Son", "Daughter"]), label: "victim was the offender's child" },
  { ask: /\bmothers?\b/i, p: inc("relationship", "in", ["Mother"]), label: "victim was the offender's mother" },
  { ask: /\bfathers?\b/i, p: inc("relationship", "in", ["Father"]), label: "victim was the offender's father" },
  { ask: /family|relative/i, p: inc("relationship", "in", FAMILY), label: "killed by a family member" },
  { ask: /acquaintance/i, p: inc("relationship", "in", ["Acquaintance"]), label: "killed by an acquaintance" },
  { ask: /friend/i, p: inc("relationship", "in", ["Friend"]), label: "killed by a friend" },
  { ask: /neighbou?r/i, p: inc("relationship", "in", ["Neighbor"]), label: "killed by a neighbor" },
  { ask: /employee/i, p: inc("relationship", "in", ["Employee"]), label: "victim was the offender's employee" },
  { ask: /employer|boss/i, p: inc("relationship", "in", ["Employer"]), label: "victim was the offender's employer" },
  { ask: /knew|known/i, p: inc("relationship", "in", [...new Set([...FAMILY, ...KNOWN])]), label: "killed by someone they knew" },
  { ask: /unknown relationship|relationship (?:is |was )?unknown/i, p: inc("relationship", "in", ["Unknown"]), label: "unknown relationship" },
];

/** Directional relationship values and their reverse (the victim's relationship to the offender, seen from the other side). */
const INVERSE: Record<string, string> = {
  Wife: "Husband", Husband: "Wife", "Common-Law Wife": "Common-Law Husband", "Common-Law Husband": "Common-Law Wife",
  Girlfriend: "Boyfriend", Boyfriend: "Girlfriend", "Ex-Wife": "Ex-Husband", "Ex-Husband": "Ex-Wife", Employee: "Employer", Employer: "Employee",
  // Parents and children invert as SETS ("killed by their parents" -> the victim was the offender's son or daughter); a single
  // parent ("killed by their mother") has no one-value inverse (son or daughter) and is declined by name.
  Father: "Son", Mother: "Daughter", Son: "Father", Daughter: "Mother",
};

const CIRCUMSTANCE_RULES: ValueRule[] = [
  { ask: /gang/i, p: inc("circumstance", "in", ["Gangland Killings", "Juvenile Gang Killings"]), label: "gang killings" },
  { ask: /killed\s+by\s+(?:police|(?:a\s+|an\s+)?officers?|law\s+enforcement)|police\s+(?:killings?|shootings?)/i, p: inc("circumstance", "in", ["Felon Killed by Police"]), label: "felon killed by police" },
  { ask: /private\s+citizen/i, p: inc("circumstance", "in", ["Felon Killed by Private Citizen"]), label: "felon killed by a private citizen" },
  { ask: /robber/i, p: inc("circumstance", "in", ["Robbery"]), label: "during a robbery" },
  { ask: /burglar/i, p: inc("circumstance", "in", ["Burglary"]), label: "during a burglary" },
  { ask: /larceny/i, p: inc("circumstance", "in", ["Larceny"]), label: "during a larceny" },
  { ask: /motor\s+vehicle/i, p: inc("circumstance", "in", ["Motor Vehicle Theft"]), label: "during a motor vehicle theft" },
  { ask: /\brapes?\b/i, p: inc("circumstance", "in", ["Rape"]), label: "during a rape" },
  { ask: /arson/i, p: inc("circumstance", "in", ["Arson"]), label: "during an arson" },
  { ask: /drug|narcotic/i, p: inc("circumstance", "in", ["Narcotic Drug Laws"]), label: "narcotic drug law circumstance" },
  { ask: /argument/i, p: inc("circumstance", "like", ["%Argument%"]), label: "during an argument" },
  { ask: /felon(?:y|ies)/i, p: inc("circumstance_group", "in", ["Felony Type"]), label: "felony-type circumstances" },
];

const RACE_RULES: { ask: RegExp; field: QField; p: QPredicate; label: string }[] = [
  { ask: /non[-\s]?hispanic/i, field: "ethnicity", p: { table: "v", column: "ethnicity", kind: "like", values: ["Not Hispanic%"] }, label: "non-Hispanic" },
  { ask: /hispanic|latin/i, field: "ethnicity", p: { table: "v", column: "ethnicity", kind: "like", values: ["Hispanic%"] }, label: "Hispanic" },
  { ask: /black|african/i, field: "race", p: { table: "v", column: "race", kind: "in", values: ["Black"] }, label: "Black" },
  { ask: /white/i, field: "race", p: { table: "v", column: "race", kind: "in", values: ["White"] }, label: "White" },
  { ask: /asian|pacific/i, field: "race", p: { table: "v", column: "race", kind: "in", values: ["Asian/Pacific Islander"] }, label: "Asian/Pacific Islander" },
  { ask: /indian|native|alaska/i, field: "race", p: { table: "v", column: "race", kind: "in", values: ["American Indian"] }, label: "American Indian" },
];

/* ================================================================== *
 * Reader-facing decline sentences (approved scope, 2026-10-08)
 * ================================================================== */

const WHY = {
  offender: "Questions about offenders (their number or characteristics) aren't a supported Homicide Reports question type yet.",
  cardinality: "SHR records whether an incident had multiple victims, not the exact number, so it can't count \"double\", \"triple\" or \"mass\" murders.",
  situation: "Questions about single- or multiple-victim incidents aren't a supported Homicide Reports question type yet.",
  size: "This data has no defined size for \"big\", \"large\", \"major\" or \"small\" agencies, so I can't pick them out.",
  stateRate: "Per-capita rates are available here only for a single agency. Homicide Reports don't include every agency, so state, county and national rates come from the Historical and Current Trends tabs.",
  subgroupRate: "A rate per 100,000 residents of one group needs a population for that group, which this data doesn't have.",
  partialRate: "Rates here use each agency's annual population, so they are given only for full calendar years.",
  change: "Changes between periods aren't a supported Homicide Reports question type yet; you can ask for the counts by year instead.",
  negation: "Excluding or negating a condition isn't supported here; ask for what you want included instead (for example, negligent manslaughter rather than \"homicides excluding murders\").",
  crossOr: "I can't tell which values \"or\" joins here; \"or\" works only between values of one condition (for example, \"firearm or knife\").",
  twoMeasures: "I can answer for one homicide type at a time (murder, all homicides, or negligent manslaughter).",
  justifiable: "Justifiable homicides aren't a supported Homicide Reports question type yet.",
  // Option 3 batch 1 (P170): the SHR codes killings by police and by private citizens as justifiable homicides, not murders.
  policeKillings: "Killings by police or by private citizens are recorded in the Homicide Reports as justifiable homicides, not murders, and justifiable homicides aren't a supported Homicide Reports question type yet.",
  shooting: "Fatal-shooting questions are answered only in the forms the fatal-shooting answer supports; this combination isn't one of them.",
  breakdown: "I can break a count down by only one of: state, county, city, weapon, relationship, circumstance, victim sex, race or age group (plus year or month).",
  shareGrouping: "Shares and victim ages can be broken down by year only.",
  shareFrame: "I couldn't tell which condition the share is of; ask, for example, \"what share of female murder victims were killed with a firearm\".",
  ageUnit: "Victim ages and rates are counted per victim, not per incident.",
  rankDimension: "Rankings here are of states, counties or cities by count.",
  countyRankScope: "Rankings and breakdowns by county need one state, for example \"which county had the most homicides in Alabama\".",
  threshold: "A minimum or maximum count applies only to results listed by place (states, counties or cities), and only to the homicides being counted.",
  agencyTypeScope: "\"Cities\" or \"sheriffs\" can be combined with a state or the nation, not with a named city or county.",
  rateScope: "A rate needs one agency, for example \"homicide rate in Houston by year\".",
  bigNumber: (token: string) => `I can't use the number "${token}" here; it's larger than I can count exactly, so I haven't answered with a different number in its place.`,
  rankMax: (n: string) => `I can rank up to 50 places; you asked for ${n}, so I haven't answered with a shorter list in its place.`,
  rankList: "Rankings here are of every state, county or city in the scope, not of a list of places; ask for each place's count instead.",
  oneStat: "I can give one kind of number per question -- a count, a share, a victim age, a ranking or a rate -- so I haven't answered with a number that leaves the other part out.",
  unconsumed: (t: string, what: string, inherited?: boolean) => `I can't use "${t}"${inherited ? " (from your earlier question)" : ""} in ${what}, so I haven't answered with a number that leaves it out.`,
  period: (t: string) => `I can't read "${t}" as a period I can apply (I can use years, ranges, since/after/before a year, months, quarters, halves, or "last N years").`,
  cutoff: "The latest month in the data can't be confirmed right now, so I can't resolve an open-ended period. Ask for specific years.",
  generic: (t: string, inherited?: boolean) => `I can't apply "${t}"${inherited ? " (from your earlier question)" : ""} to a Homicide Reports number yet, so I haven't answered with a number that leaves it out.`,
};

/* ================================================================== *
 * Ledger -> slots
 * ================================================================== */

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6, july: 7, jul: 7,
  august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = String.raw`(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);
const MONTH_END = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Requested age bounds (inclusive) for one age part; null when the wording is not a numeric bound. */
function ageRange(text: string): [number, number] | null {
  const t = text.toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /(?:between\s+)?(?:the\s+)?ages?\s+(?:of\s+)?(\d{1,3})\s*(?:-|to|and)\s*(\d{1,3})|aged?\s+(\d{1,3})\s*(?:-|to|through|and)\s*(\d{1,3})|(\d{1,3})\s*(?:-|to)\s*(\d{1,3})[-\s]year[-\s]olds?/.exec(t))) {
    return [+(m[1] ?? m[3] ?? m[5]), +(m[2] ?? m[4] ?? m[6])];
  }
  if ((m = /(?:under|below|younger than|less than)\s+(?:the\s+)?(?:age\s+(?:of\s+)?)?(\d{1,3})/.exec(t))) return [0, +m[1] - 1];
  if ((m = /(?:over|above|older than|more than)\s+(?:the\s+)?(?:age\s+(?:of\s+)?)?(\d{1,3})/.exec(t))) return [+m[1] + 1, 120];
  if ((m = /at least\s+(?:the\s+)?(?:age\s+(?:of\s+)?)?(\d{1,3})/.exec(t))) return [+m[1], 120];
  if ((m = /aged?\s+(\d{1,3})|(\d{1,3})[-\s]year[-\s]olds?/.exec(t))) { const n = +(m[1] ?? m[2]); return [n, n]; }
  if (/child|kids?|minors?|juvenile/.test(t)) return [0, 17];
  if (/teen|adolescent/.test(t)) return [13, 19];
  if (/elderly|seniors?|older/.test(t)) return [65, 120];
  if (/\badults?\b/.test(t) && !/young/.test(t)) return [18, 120];
  return null;
}
function ageLabel(lo: number, hi: number): string {
  if (lo === 0 && hi >= 120) return "of any age";
  if (lo === 0) return `under ${hi + 1}`;
  if (hi >= 120) return `aged ${lo} and older`;
  return lo === hi ? `aged ${lo}` : `aged ${lo}-${hi}`;
}

type Declined = { part: Part; why: string };

type PeriodRead = { pairs: YearMonth[]; grain: "year" | "month" | null; note: string | null; yearList: boolean; openEndYears: number[]; grainParts: { part: Part; grain: "year" | "month" }[] };

/**
 * The period grammar (plan r3.1 R2). `min` is the earliest year in the source, C the observed cutoff, L the last
 * complete year. Open-ended and relative forms, and yearless defaults, need an observed cutoff. Anything not in the
 * grammar is declined by name.
 */
export function readQuestionPeriods(parts: Part[], cutoff: ShrCutoff): PeriodRead | { declined: Declined } {
  const pairs: YearMonth[] = [];
  const yearTerms: number[] = [];
  let yearTermCount = 0;
  let monthsOnly: number[] | null = null;
  let eachYearMonths = false;
  let grain: "year" | "month" | null = null;
  let note: string | null = null;
  let yearList = false;
  const openEndYears: number[] = [];
  const grainParts: { part: Part; grain: "year" | "month" }[] = [];
  const L = cutoff.month === 12 ? cutoff.year : cutoff.year - 1;
  const throughC = (start: number) => range(start, cutoff.year).flatMap((year) => range(1, year === cutoff.year ? cutoff.month : 12).map((month) => ({ year, month })));
  const needCutoff = (part: Part): { declined: Declined } | null => (cutoff.observed ? null : { declined: { part, why: WHY.cutoff } });

  for (const part of parts) {
    const raw = part.text.toLowerCase().replace(/\s+/g, " ").trim();
    let t = raw.replace(/\b(?:the\s+)?(?:calendar\s+)?years?\s+(?=(?:19|20)\d{2})/g, "").replace(/^(?:in|for|during|over|across)\s+/, "").trim();
    // Grain words.
    if (/\b(?:monthly|by month|per month|each month|every month|month[- ]by[- ]month)\b/.test(t)) { grain = "month"; grainParts.push({ part, grain: "month" }); if (!/\d/.test(t)) continue; }
    if (/\b(?:by year|per year|each year|every year|yearly|annual(?:ly)?|year[- ]by[- ]year|over time)\b/.test(t) && !/of (?:each|every) year/.test(t)) { grain = grain ?? "year"; grainParts.push({ part, grain: "year" }); if (!/\d/.test(t)) continue; }
    if (/^(?:the\s+)?years?$/.test(t)) { grain = grain ?? "year"; grainParts.push({ part, grain: "year" }); continue; }
    if (/^(?:the\s+)?months?$/.test(t)) { grain = "month"; grainParts.push({ part, grain: "month" }); continue; }
    if (/of (?:each|every) year/.test(t)) { eachYearMonths = true; t = t.replace(/\s*of (?:each|every) year/, ""); }
    // "last N years": complete calendar years ending at L.
    let m: RegExpExecArray | null;
    if ((m = /^(?:the\s+)?(?:last|past|previous|prior|trailing)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:full\s+|calendar\s+|complete\s+)?years?$/.exec(t))) {
      const c = needCutoff(part); if (c) return c;
      const n = /\d/.test(m[1]) ? +m[1] : NUMBER_WORDS[m[1]];
      if (n < 1 || n > 60) return { declined: { part, why: WHY.period(part.text.trim()) } };
      yearTerms.push(...range(L - n + 1, L)); yearTermCount += 2;
      note = `the last ${n} complete years in the source, ${L - n + 1} through ${L}`;
      continue;
    }
    // Months named in the part.
    let months: number[] | null = null;
    const quarter = /\bq([1-4])\b|\b(first|second|third|fourth|1st|2nd|3rd|4th) quarter\b/.exec(t);
    const half = /\b(first|second|1st|2nd) half\b|\bh([12])\b/.exec(t);
    const firstN = /\bfirst (\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) months\b/.exec(t);
    const span = new RegExp(`${MONTH_RE}\\s*(?:-|–|to|through|thru)\\s*${MONTH_RE}`).exec(t);
    const through = new RegExp(`\\b(?:through|thru|until|till|as of)\\s+(?:the\\s+end\\s+of\\s+)?${MONTH_RE}(?!\\s*\\d{1,2}(?:st|nd|rd|th)?\\b)`).exec(t);
    const throughSlash = /\b(?:through|thru|until|till|as of)\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
    if (quarter) { const n = quarter[1] ? +quarter[1] : ["first", "second", "third", "fourth"].indexOf(quarter[2].replace(/^1st$/, "first").replace(/^2nd$/, "second").replace(/^3rd$/, "third").replace(/^4th$/, "fourth")) + 1; months = range(3 * n - 2, 3 * n); }
    else if (half) { const second = half[1] ? /second|2nd/.test(half[1]) : half[2] === "2"; months = second ? range(7, 12) : range(1, 6); }
    else if (firstN) { const n = /\d/.test(firstN[1]) ? +firstN[1] : NUMBER_WORDS[firstN[1]]; if (n < 1 || n > 12) return { declined: { part, why: WHY.period(part.text.trim()) } }; months = range(1, n); }
    else if (span) {
      // r5 §2: a month span that runs backwards ("July to January", "November through February") is declined by name;
      // it never yields an empty month set that could fall into the yearless default.
      if (MONTHS[span[1]] > MONTHS[span[2]]) return { declined: { part, why: `"${part.text.trim()}" ends before it starts, so it names no period; spans that cross a year boundary aren't supported -- ask for each year's months separately.` } };
      months = range(MONTHS[span[1]], MONTHS[span[2]]);
    }
    else if (throughSlash) {
      const mo = +throughSlash[1]; const d = +throughSlash[2];
      if (mo < 1 || mo > 12 || d !== MONTH_END[mo - 1] && !(mo === 2 && d === 28)) return { declined: { part, why: WHY.period(part.text.trim()) } };
      months = range(1, mo);
      if (throughSlash[3]) { const y = throughSlash[3].length === 2 ? 2000 + +throughSlash[3] : +throughSlash[3]; t = `${t} ${y}`; }
      t = t.replace(throughSlash[0], " ");
    } else if (through) months = range(1, MONTHS[through[1]]);
    else { const single = new RegExp(`\\b${MONTH_RE}(?!\\s*\\d{1,2}(?:st|nd|rd|th)?\\b(?!\\d))`).exec(t); if (single && MONTHS[single[1]]) months = [MONTHS[single[1]]]; }
    // Anything not in the grammar: declined by name.
    const leftover = t
      .replace(/\bq[1-4]\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th) quarter(?: of)?\b|\b(?:first|second|1st|2nd) half(?: of)?\b|\bh[12]\b|\bfirst (?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve) months(?: of)?\b/g, " ")
      .replace(new RegExp(MONTH_RE, "g"), " ")
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/\b(?:the|of|in|for|during|from|since|after|before|between|and|to|through|thru|until|till|as of|end of|starting|beginning|present|now|today|-|–|,)\b|[-–,]/g, " ")
      .trim();
    if (leftover.length > 0) return { declined: { part, why: WHY.period(part.text.trim()) } };
    // Years named in the part, with their operator.
    let years: number[] = [];
    const between = /\b(?:between|from)\s+((?:19|20)\d{2})\s*(?:-|–|and|to|through|thru|until)\s*((?:19|20)\d{2})\b/.exec(t)
      || /\b((?:19|20)\d{2})\s*(?:-|–|to|through|thru|until)\s*((?:19|20)\d{2})\b/.exec(t);
    const toPresent = /\b((?:19|20)\d{2})\s*(?:-|–|to|through|thru|until)\s*(?:present|now|today)\b/.exec(t);
    const since = /\b(?:since|starting(?: in)?|beginning(?: in)?|from)\s+((?:19|20)\d{2})\b/.exec(t);
    const after = /\bafter\s+((?:19|20)\d{2})\b/.exec(t);
    const before = /\bbefore\s+((?:19|20)\d{2})\b/.exec(t);
    if (between) {
      const a = +between[1]; const b = +between[2];
      // r4 §2: a reversed range is declined, never silently reordered.
      if (a > b) return { declined: { part, why: `"${part.text.trim()}" ends before it starts, so it names no period; ask, for example, for ${b} to ${a}.` } };
      years = range(a, b); yearTermCount += 2;
    }
    else if (toPresent || since || after) {
      const c = needCutoff(part); if (c) return c;
      const start = toPresent ? +toPresent[1] : since ? +since[1] : +after![1] + 1;
      // r4 §2: an open range that starts after the source's latest data is EMPTY -- declined by name, never "every year".
      if (start > cutoff.year) return { declined: { part, why: `The latest data in the source is ${MONTH_NAMES[cutoff.month - 1]} ${cutoff.year}, so there's nothing ${after ? `after ${after[1]}` : `since ${start}`} yet.` } };
      if (cutoff.month < 12) openEndYears.push(cutoff.year);
      if (months) { years = range(start, cutoff.year); }
      else { pairs.push(...throughC(start)); yearTermCount += 2; note = `${start} through ${cutoff.year === start ? `${MONTH_NAMES[cutoff.month - 1]} ${cutoff.year}` : `${cutoff.year}`}, the latest data in the source`; continue; }
      yearTermCount += 2;
      note = `${start} through ${cutoff.year}, the latest year in the source`;
    } else if (before) {
      const c = needCutoff(part); if (c) return c;
      const end = +before[1] - 1;
      if (end < cutoff.minYear) return { declined: { part, why: `The source starts in ${cutoff.minYear}, so there is nothing before ${before[1]}.` } };
      years = range(cutoff.minYear, end); yearTermCount += 2;
      note = `${cutoff.minYear}, the first year in the source, through ${end}`;
    } else {
      years = (t.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
      if (years.length > 1) yearList = true;
      yearTermCount += years.length;
    }
    if (years.length > 0 && months && !eachYearMonths) { for (const year of years) for (const month of months) pairs.push({ year, month }); continue; }
    if (years.length > 0 && months) { yearTerms.push(...years); monthsOnly = [...(monthsOnly ?? []), ...months]; continue; }
    if (years.length > 0) { yearTerms.push(...years); continue; }
    if (months) { monthsOnly = [...(monthsOnly ?? []), ...months]; continue; }
    return { declined: { part, why: WHY.period(part.text.trim()) } };
  }
  const monthSet = monthsOnly ? [...new Set(monthsOnly)].sort((a, b) => a - b) : null;
  for (const year of [...new Set(yearTerms)]) for (const month of monthSet ?? range(1, 12)) pairs.push({ year, month });
  if (monthSet && yearTerms.length === 0 && pairs.length > 0) {
    // Month-only wording beside explicit month-year periods ("January 2024 and February 2025 through July"): ambiguous.
    const monthOnly = parts.find((p) => !/\b(?:19|20)\d{2}\b/.test(p.text) && new RegExp(MONTH_RE, "i").test(p.text)) ?? parts[parts.length - 1];
    return { declined: { part: monthOnly, why: `I can't tell which of the named periods "${monthOnly.text.trim()}" applies to; ask for each period separately.` } };
  }
  // r5 §2 (generic guard): explicit YEAR or range wording that resolves to no (year, month) pair is declined by name. The
  // yearless default below is reserved for requests whose period parts are grain words or months with no year.
  if (pairs.length === 0 && yearTermCount > 0) {
    const anchor = parts.find((p) => /\b(?:19|20)\d{2}\b/.test(p.text)) ?? parts[0];
    return { declined: { part: anchor, why: `"${anchor.text.trim()}" names no months that exist in a year, so it names no period.` } };
  }
  if (pairs.length === 0) {
    // No year at all: every year from min to C (months as asked), year by year, stated -- only with an observed cutoff.
    if (!cutoff.observed) {
      const anchor = parts[0] ?? null;
      if (anchor) return { declined: { part: anchor, why: WHY.cutoff } };
      return { declined: { part: { concept: "period", value: null, span: [0, 0], text: "", explains: [], clause: 0, rule: "period:none", state: "recognized", explanation: WHY.cutoff }, why: WHY.cutoff } };
    }
    for (const year of range(cutoff.minYear, cutoff.year)) for (const month of monthSet ?? range(1, 12)) if (year < cutoff.year || month <= cutoff.month) pairs.push({ year, month });
    grain = grain ?? "year";
    note = `every year in the source, ${cutoff.minYear} through ${cutoff.year}${monthSet ? ` (${monthWords(monthSet)} of each year)` : ""}`;
  }
  void yearTermCount;
  const unique = [...new Map(pairs.map((p) => [`${p.year}-${p.month}`, p])).values()].sort((a, b) => a.year - b.year || a.month - b.month);
  return { pairs: unique, grain, note, yearList, openEndYears, grainParts };
}

function monthWords(ms: number[]): string {
  const contiguous = ms.every((m, i) => i === 0 || m === ms[i - 1] + 1);
  if (contiguous && ms.length > 1) return `${MONTH_NAMES[ms[0] - 1]}-${MONTH_NAMES[ms[ms.length - 1] - 1]}`;
  return ms.map((m) => MONTH_NAMES[m - 1]).join(", ");
}

type Slots = {
  declined: Declined[];
  measure: "murder" | "homicide" | "manslaughter" | null;
  unit: "victims" | "incidents";
  unitExplicit: boolean;
  filters: { filter: QFilter; parts: Part[] }[];
  dims: { d: QDimension; part: Part }[];
  share: Part | null;
  age: { stat: "median" | "average"; part: Part } | null;
  rank: { part: Part; n: number | null; direction: "desc" | "asc" } | null;
  rate: Part | null;
  /** Every rate-like statistic part (r4: a scale other than per 100,000 is declined by name). */
  rateParts: Part[];
  /** r4 one-statistic rule: a second, different age statistic. */
  ageConflict: Part[];
  threshold: { part: Part; op: ">=" | ">" | "<=" | "<"; value: number; words: string; unitWord?: "victims" | "incidents"; measureWord?: "murder" | "homicide" | "manslaughter"; wordPart?: Part } | null;
  /** r4 §1: the slot each part was read into; the chosen type decides which slots it consumes. */
  slot: Map<Part, string>;
  /** r5 §1: the semantic VALUE each singleton-slot part requested, recorded before any overwrite or normalization. */
  vals: Map<Part, string>;
  /** r5 §1: two different values for one singleton slot -- declined, naming both. */
  conflicts: Declined[];
  /** Every threshold occurrence (r5: more than one distinct threshold is declined). */
  thresholds: NonNullable<Slots["threshold"]>[];
  agencyType: { type: "City" | "County"; parts: Part[] } | null;
  placeParts: Part[];
  periodParts: Part[];
  combineWord: "each" | "union" | null;
  rankedEntity: { d: "state" | "county" | "city"; plural: boolean; part: Part } | null;
};

/** r6: the largest ranking size (a larger request is declined by name, never capped). */
const MAX_RANK = 50;
/**
 * r6.1: a count token converted only when the conversion is lossless -- digits (grouping commas removed, leading zeros
 * dropped) that parse to a safe integer whose decimal string equals the token. `key` is the exact token, used for every
 * recorded value and conflict key, so two different tokens can never collapse into one number.
 */
export function exactCount(raw: string): { ok: true; n: number; key: string } | { ok: false; token: string } {
  const digits = raw.replace(/,/g, "");
  if (!/^\d+$/.test(digits)) return { ok: false, token: raw };
  const key = digits.replace(/^0+(?=\d)/, "");
  const n = Number(key);
  return Number.isSafeInteger(n) && String(n) === key ? { ok: true, n, key } : { ok: false, token: raw };
}
/** T6 scales (r4 §2): "rate", "per capita", "per 100,000" / "per 100k" (optionally "... residents/people/population"). */
const RATE_SCALE_OK = /^(?:rates?|per\s+capita|per\s+100(?:,000|000|k)(?:\s+(?:people|residents|population|persons|inhabitants))?)$/i;
const BREAKDOWN_WORD = /\b(?:by|per|each|every|across|broken\s+down|split|separated|seperated|grouped|for\s+each)\b/i;
const RANK_WORD = /^(?:top|bottom)\s+\d+$|^(?:most|least|fewest|highest|lowest|largest|smallest|biggest|top|bottom|rank(?:ed|ing|ings|s)?)$/;

function readSlots(ledger: RequestLedger, question: string): Slots {
  const parts = ledger.parts.filter((p) => p.state !== "context");
  const s: Slots = {
    declined: [], measure: null, unit: "victims", unitExplicit: false, filters: [], dims: [], share: null, age: null, rank: null, rate: null,
    rateParts: [], ageConflict: [], slot: new Map(), vals: new Map(), conflicts: [], thresholds: [],
    threshold: null, agencyType: null, placeParts: [], periodParts: [], combineWord: null, rankedEntity: null,
  };
  const decline = (part: Part, why: string) => s.declined.push({ part, why });
  const addFilter = (field: QField, p: QPredicate, label: string, part: Part) => {
    s.filters.push({ filter: { field, predicates: [p], label }, parts: [part] }); s.slot.set(part, "filter");
  };
  const addDim = (d: QDimension, part: Part) => { s.dims.push({ d, part }); s.slot.set(part, `dim:${d}`); };
  const slot = (part: Part, name: string) => s.slot.set(part, name);
  const lastThreshold = () => s.thresholds[s.thresholds.length - 1];
  const afterThreshold = (part: Part) => !!lastThreshold() && !part.inherited && !lastThreshold().part.inherited && question.slice(lastThreshold().part.span[1], part.span[0]).trim() === "";
  /** Record a singleton value; a DIFFERENT value already requested for the same slot is a named conflict (r5 §1). */
  const single = (part: Part, name: string, value: string, compatible: (a: string, b: string) => boolean = (a, b) => a === b, label = name) => {
    for (const [other, v] of s.vals) if (s.slot.get(other) === name && !compatible(v, value)) { s.conflicts.push({ part, why: `"${other.text.trim()}" and "${part.text.trim()}" ask for two different ${label}; I can apply one, so I haven't answered with a number that drops the other.` }); }
    s.slot.set(part, name); s.vals.set(part, value);
  };
  const rankCompatible = (a: string, b: string) => { const [da, na] = a.split(":"); const [db, nb] = b.split(":"); return da === db && (na === "" || nb === "" || na === nb); };
  const setAgencyType = (type: "City" | "County", part: Part) => {
    if (s.agencyType && s.agencyType.type !== type) { decline(part, "I can answer for city agencies or for sheriffs and county agencies, not both in one number."); return; }
    s.agencyType = { type, parts: [...(s.agencyType?.parts ?? []), part] }; slot(part, "agencyType");
  };
  const ranked = parts.some((x) => x.concept === "statistic" && RANK_WORD.test(x.text.trim().toLowerCase()));
  const hasRate = parts.some((x) => x.concept === "statistic" && /^rates?$|per\s+capita|per\s+100|^per\s+\d/i.test(x.text.trim()));

  for (const part of [...parts].sort((a, b) => Number(Boolean(a.inherited)) - Number(Boolean(b.inherited)) || a.span[0] - b.span[0])) {
    const t = part.text.toLowerCase().trim();
    switch (part.concept) {
      case "place":
        if (part.rule === "place:unresolved-county" && /^(?:which|what)\b/.test(t)) { s.rankedEntity = { d: "county", plural: /ies$/.test(t), part }; slot(part, "rank"); break; }
        if (part.rule === "place:unresolved-county" && /^(?:by|per|each|every|for each|across)\s+(?:the\s+)?count(?:y|ies)$/.test(t)) { if (/each|every/.test(t)) s.combineWord = "each"; addDim("county", part); break; }
        s.placeParts.push(part); slot(part, "place"); break;
      case "national": s.placeParts.push(part); slot(part, "place"); break;
      case "reporting-agency":
        if (part.rule === "reported-by-agency-type") { slot(part, "agencyType"); break; } // "reported by" + the agency-type part that follows it
        s.placeParts.push(part); slot(part, "place"); break;
      case "agency-type":
        if (part.rule === "agency-after-place" || /countywide|county[-\s]wide/.test(t)) { s.placeParts.push(part); slot(part, "place"); break; }
        if (/sheriff|county\s+agenc/.test(t)) { setAgencyType("County", part); break; }
        if (/city\s+agenc/.test(t)) { setAgencyType("City", part); break; }
        decline(part, WHY.generic(part.text.trim(), part.inherited)); break;
      case "population-band": decline(part, WHY.size); break;
      case "period": s.periodParts.push(part); slot(part, "period"); break;
      case "measure":
        if (/justifiable/.test(t)) { decline(part, WHY.justifiable); break; }
        {
          const m: Slots["measure"] = /negligent\s+manslaughter/.test(t) && !/non[-\s]?negligent/.test(t) ? "manslaughter"
            : /murder|non[-\s]?negligent/.test(t) ? "murder" : "homicide";
          // "at least 8 murders": the measure word after a threshold belongs to the threshold (r4 §3).
          if (afterThreshold(part)) { lastThreshold().measureWord = m; lastThreshold().wordPart = part; slot(part, "threshold"); s.vals.set(part, `measure:${m}`); break; }
          if (s.measure && s.measure !== m) decline(part, WHY.twoMeasures); else { s.measure = m; slot(part, "measure"); s.vals.set(part, m!); }
        }
        break;
      case "unit":
        // "at least 8 incidents": the unit word after a threshold belongs to the threshold, never to the count (r4 §3).
        if (afterThreshold(part) && /incidents?|cases?|events?|victims?|people|persons?/.test(t)) { lastThreshold().unitWord = /incidents?|cases?|events?/.test(t) ? "incidents" : "victims"; lastThreshold().wordPart = part; slot(part, "threshold"); s.vals.set(part, `unit:${lastThreshold().unitWord}`); break; }
        if (/incidents?|cases?|events?/.test(t)) { s.unit = "incidents"; s.unitExplicit = true; single(part, "unit", "incidents", undefined, "counting units"); }
        else if (/people|persons?|individuals?/.test(t)) { s.unitExplicit = true; single(part, "unit", "victims", undefined, "counting units"); }
        else if (/residents?/.test(t)) { if (!hasRate) decline(part, WHY.generic(part.text.trim(), part.inherited)); else slot(part, "rate"); }
        else slot(part, "neutral");
        break; // counts, numbers, totals: the count itself
      case "role":
        if (part.value === "offender") decline(part, WHY.offender); else slot(part, "role");
        break;
      case "situation":
        decline(part, /double|triple|mass/.test(t) ? WHY.cardinality : WHY.situation); break;
      case "weapon": {
        if (/shoot|shot\b|gun violence/.test(t)) { decline(part, WHY.shooting); break; }
        if (BREAKDOWN_WORD.test(t) && /weapons?(?:\s+types?)?$|types?$|categor/.test(t)) { addDim("weapon", part); break; }
        const rule = WEAPON_RULES.find((r) => r.ask.test(t));
        if (!rule) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
        addFilter("weapon", rule.p, rule.label, part); break;
      }
      case "relationship": {
        if (BREAKDOWN_WORD.test(t) && /relationships?$/.test(t)) { addDim("relationship", part); break; }
        let rule = RELATIONSHIP_RULES.find((r) => r.ask.test(t));
        if (!rule) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
        // SHR records the VICTIM's relationship to the offender. "killed by their husbands" names the OFFENDER, so the
        // victim was the wife: directional values are inverted when the wording names the offender ("by ...").
        if (/\bby\b/.test(t) && rule.p.values.every((v) => v in INVERSE)) {
          const inverted = rule.p.values.map((v) => INVERSE[v]).sort().join("|");
          const twin = RELATIONSHIP_RULES.find((r) => [...r.p.values].sort().join("|") === inverted);
          if (!twin) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
          rule = twin;
        }
        addFilter("relationship", rule.p, rule.label, part); break;
      }
      case "circumstance": {
        if (BREAKDOWN_WORD.test(t) && /circumstances?$|motives?$/.test(t)) { addDim("circumstance", part); break; }
        // Option 3 batch 1 (P170): never a murder count filtered to killings by police or private citizens (those are justifiable
        // homicides; the filtered murder count is ~0 and mislabeled). Declined by name.
        if (/killed\s+by\s+(?:police|(?:a\s+|an\s+)?officers?|law\s+enforcement|(?:a\s+)?private\s+citizens?)|police\s+(?:killings?|shootings?)|private\s+citizen/.test(t)) { decline(part, WHY.policeKillings); break; }
        if (/domestic|justifiable|self[-\s]defen|negligen|accidental/.test(t)) { decline(part, /negligen|accidental/.test(t) ? WHY.generic(part.text.trim(), part.inherited) + " For negligent manslaughter, ask for it as the homicide type." : WHY.generic(part.text.trim(), part.inherited)); break; }
        const rule = CIRCUMSTANCE_RULES.find((r) => r.ask.test(t));
        if (!rule) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
        addFilter("circumstance", rule.p, rule.label, part); break;
      }
      case "sex": {
        if (/offender|killer|perpetrator|suspect|assailant|shooter|murderer/.test(t)) { decline(part, WHY.offender); break; }
        if (/to[-\s]/.test(t)) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; } // ratios: the owned count's
        if (/\b(?:sex|gender)\b/.test(t)) { addDim("sex", part); break; }
        const female = /fem|wom|girl/.test(t);
        addFilter("sex", { table: "v", column: "sex", kind: "in", values: [female ? "Female" : "Male"] }, female ? "female" : "male", part); break;
      }
      case "race": {
        if (/offender|killer|perpetrator|suspect|assailant|shooter|murderer/.test(t)) { decline(part, WHY.offender); break; }
        if (/\b(?:race|racial|races)\b/.test(t)) { addDim("race", part); break; }
        if (/ethnicit/.test(t)) { decline(part, WHY.breakdown); break; }
        const rule = RACE_RULES.find((r) => r.ask.test(t));
        if (!rule) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
        addFilter(rule.field, rule.p, rule.label, part); break;
      }
      case "age": {
        if (/offender|killer|perpetrator|suspect|assailant|shooter|murderer/.test(t)) { decline(part, WHY.offender); break; }
        if (/median|average|mean/.test(t)) {
          const stat = /median/.test(t) ? "median" : "average";
          if (s.age && s.age.stat !== stat) { s.ageConflict.push(part); slot(part, "age"); break; }
          s.age = { stat, part }; slot(part, "age"); break;
        }
        if (/\bages?\b|age\s+groups?/.test(t) && BREAKDOWN_WORD.test(t)) { addDim("age-group", part); break; }
        const r = ageRange(t);
        if (!r) { decline(part, WHY.generic(part.text.trim(), part.inherited)); break; }
        const existing = s.filters.find((f) => f.filter.field === "age");
        const orBetween = existing && parts.some((c) => c.concept === "connector" && /^(?:or|either)$/i.test(c.text.trim()) && c.span[0] > Math.min(...existing.parts.map((x) => x.span[0])) && c.span[1] < part.span[0]);
        if (existing && orBetween) { decline(part, "I can apply one age range at a time, so I can't combine age ranges with \"or\"."); break; }
        if (existing) {
          const p = existing.filter.predicates[0];
          p.lo = Math.max(p.lo!, r[0]); p.hi = Math.min(p.hi!, r[1]);
          existing.filter.label = ageLabel(p.lo, p.hi); existing.parts.push(part); slot(part, "filter");
          if (p.lo > p.hi) decline(part, `The age conditions here don't overlap, so no victim could match them.`);
        } else addFilter("age", { table: "v", column: "age_num", kind: "range", values: [], lo: r[0], hi: r[1] }, ageLabel(r[0], r[1]), part);
        break;
      }
      case "statistic": {
        if (/^(?:how many|how much|numbers?|totals?|counts?)$/.test(t)) { slot(part, "neutral"); break; }
        if (/percent|share|proportion|fraction|%/.test(t)) { s.share = part; slot(part, "share"); break; }
        // A bare "average"/"median" (not "average age", which is an age part) is not a supported statistic.
        if (/^rates?$|per\s+capita|per\s+100(?:,?000|k)|^per\s+\d/.test(t)) { s.rate = s.rate ?? part; s.rateParts.push(part); slot(part, "rate"); break; }
        // "victims ... were under 5": an age bound the recognizer read as a count threshold (it follows a copula and
        // no count noun follows it).
        if (!part.inherited && /^(?:under|over|below|above|younger\s+than|older\s+than)\s+\d{1,3}$/.test(t)
          && /\b(?:were|was|are|is|aged?)\s*$/.test(question.slice(Math.max(0, part.span[0] - 12), part.span[0]).toLowerCase())
          && !/^\s*(?:murders?|homicides?|victims?|incidents?|killings?|people|persons|residents|population|k\b|%|percent)/.test(question.slice(part.span[1], part.span[1] + 25).toLowerCase())) {
          const r = ageRange(t);
          if (r) { addFilter("age", { table: "v", column: "age_num", kind: "range", values: [], lo: r[0], hi: r[1] }, ageLabel(r[0], r[1]), part); break; }
        }
        const th = /^(?:(min(?:imum)?(?:\s+of)?|at\s+least|more\s+than|over|above)|(max(?:imum)?(?:\s+of)?|at\s+most|fewer\s+than|less\s+than|under|below))\s+(\d[\d,]*)$|^(\d[\d,]*)\+$|^([<>]\s*=?)\s*(\d[\d,]*)$/.exec(t);
        if (th) {
          // r6.1: the amount is kept as its exact token and converted only when the conversion is lossless.
          const amount = exactCount(th[3] ?? th[4] ?? th[6]);
          if (!amount.ok) { decline(part, WHY.bigNumber(amount.token)); break; }
          const value = amount.n;
          let op: ">=" | ">" | "<=" | "<";
          if (th[4]) op = ">=";
          else if (th[5]) op = th[5].replace(/\s/g, "") as ">=" | ">" | "<=" | "<";
          else if (th[1]) op = /more than|over|above/.test(th[1]) ? ">" : ">=";
          else op = /fewer than|less than|under|below/.test(th[2]) ? "<" : "<=";
          // The threshold must be about the homicides being counted: the next word names the measure or unit, or nothing.
          const after = question.slice(part.span[1], part.span[1] + 40).toLowerCase();
          if (/^\s*(?:people|residents|population|persons|k\b)/.test(after) || /k$/.test(t)) { decline(part, WHY.threshold); break; }
          const occurrence = { part, op, value, words: part.text.trim() };
          s.thresholds.push(occurrence); s.threshold = s.threshold ?? occurrence; slot(part, "threshold"); s.vals.set(part, `${op}${amount.key}`);
          break;
        }
        if (/^(?:top|bottom)\s+(\d+)$/.test(t) || RANK_WORD.test(t)) {
          const n = /(\d+)/.exec(t);
          // r6: the requested count is recorded RAW; above 50 is declined by name, never silently capped.
          const count = n ? exactCount(n[1]) : null;
          if (count && !count.ok) { decline(part, WHY.bigNumber(count.token)); break; }
          if (count && count.ok && count.n > MAX_RANK) { decline(part, WHY.rankMax(count.key)); break; }
          const rk = { part, n: count && count.ok ? count.n : null, direction: (/least|fewest|lowest|smallest|bottom/.test(t) ? "asc" : "desc") as "asc" | "desc" };
          single(part, "rank", `${rk.direction}:${count && count.ok ? count.key : ""}`, rankCompatible, "rankings");
          if (!s.rank || (s.rank.n === null && rk.n !== null)) s.rank = rk;
          break;
        }
        if (/change|increas|decreas|rise|rising|rose|fall|fell|drop|declin|grew|grow|spike|surge|higher|lower|difference|compar|versus|vs|year[-\s]?over|yoy|side by side/.test(t)) { decline(part, WHY.change); break; }
        decline(part, WHY.generic(part.text.trim(), part.inherited)); break;
      }
      case "breakdown": {
        if (/month|year/.test(t)) { s.periodParts.push(part); slot(part, "period"); break; }
        const d: QDimension | null = /state/.test(t) ? "state" : /count(?:y|ies)|parish/.test(t) ? "county" : /cit(?:y|ies)/.test(t) ? "city"
          : /weapon/.test(t) ? "weapon" : /relationship/.test(t) ? "relationship" : /circumstance|motive/.test(t) ? "circumstance"
          : /\brace\b/.test(t) ? "race" : /\bsex\b|gender/.test(t) ? "sex" : /\bage/.test(t) ? "age-group" : null;
        if (!d) { decline(part, WHY.breakdown); break; }
        if (/\b(?:each|every|for each)\b/.test(t)) s.combineWord = "each";
        addDim(d, part); break;
      }
      case "entity": {
        const d: "state" | "county" | "city" | null = /state/.test(t) ? "state" : /count(?:y|ies)|parish/.test(t) ? "county" : /cit(?:y|ies)|towns?/.test(t) ? "city" : null;
        const plural = /(?:ies|s)$/.test(t);
        if (d && (/^(?:which|what)\b|\d/.test(t) || ranked)) { s.rankedEntity = { d, plural, part }; slot(part, "rank"); const n = /(\d+)/.exec(t);
          if (n) {
            // r6: raw count, lossless conversion, above 50 declined by name.
            const count = exactCount(n[1]);
            if (!count.ok) { decline(part, WHY.bigNumber(count.token)); break; }
            if (count.n > MAX_RANK) { decline(part, WHY.rankMax(count.key)); break; }
            single(part, "rank", `desc:${count.key}`, rankCompatible, "rankings");
            if (!s.rank || s.rank.n === null) s.rank = { part, n: count.n, direction: s.rank?.direction ?? "desc" };
          }
          break; }
        if (d === "city" && plural && /^cities$/.test(t)) { setAgencyType("City", part); break; } // "murders in cities in Missouri" (Jeff, 2026-10-08)
        decline(part, WHY.generic(part.text.trim(), part.inherited)); break;
      }
      case "connector": {
        if (/^(?:not|excluding|except|except for|other than|without|apart from|aside from|but|neither|nor)$/.test(t)) { decline(part, WHY.negation); break; }
        if (/^(?:versus|vs\.?)$/.test(t)) { decline(part, WHY.change); break; }
        if (/^(?:separately|respectively)$/.test(t)) { s.combineWord = "each"; single(part, "combine", "each", undefined, "ways of combining the places"); break; }
        if (/^(?:combined|together|altogether|total|overall)$/.test(t)) { s.combineWord = s.combineWord ?? "union"; single(part, "combine", "union", undefined, "ways of combining the places"); break; }
        slot(part, "neutral"); break; // and, or (checked below), only, just, all, both, any, every, including, limited to, among, plus
      }
      default: decline(part, part.explanation ?? WHY.generic(part.text.trim(), part.inherited));
    }
  }

  // "or" joins two values of ONE field (or two places of one kind); anything else is ambiguous (Codex r2 #3).
  const ors = parts.filter((p) => p.concept === "connector" && /^(?:or|either)$/i.test(p.text.trim()));
  for (const or of ors) {
    const sameSrc = parts.filter((p) => Boolean(p.inherited) === Boolean(or.inherited) && !["connector", "filler", "punctuation", "opener"].includes(p.concept));
    const left = sameSrc.filter((p) => p.span[1] <= or.span[0]).sort((a, b) => b.span[1] - a.span[1])[0];
    const right = sameSrc.filter((p) => p.span[0] >= or.span[1]).sort((a, b) => a.span[0] - b.span[0])[0];
    const fieldOf = (p: Part | undefined) => p ? s.filters.find((f) => f.parts.includes(p))?.filter.field ?? (p.concept === "place" ? `place:${(p.value ?? "").split(":")[0]}` : null) : null;
    const lf = fieldOf(left); const rf = fieldOf(right);
    if (!lf || lf !== rf) s.declined.push({ part: or, why: WHY.crossOr });
  }

  // Round 1 Q11 (ROUND1-PLAN-r4 section 5): "male vs female" / "male and female" compare the two sexes, so they read as the
  // by-sex breakdown (Male, Female and Unknown each its own category), not one "male or female" total and not a change
  // between periods. Scope: the two victim-sex values only, joined directly by "and" / "vs" / "versus"; "or", an explicit
  // combined total ("combined", "together", "total") and share questions keep their current reading.
  const sexF = s.filters.filter((f) => f.filter.field === "sex");
  const sexValues = new Set(sexF.flatMap((f) => f.filter.predicates.flatMap((p) => p.values)));
  // Codex build review (Q11): an aggregate word anywhere ("total", "combined", "all" ...) keeps the combined reading,
  // whatever concept recognized it; the comparison applies only when no such word is present.
  const aggregateWord = parts.some((p) => /\b(?:total|totals|combined|overall|altogether|together|sum|all)\b/i.test(p.text));
  if (sexF.length === 2 && sexValues.has("Male") && sexValues.has("Female") && s.combineWord !== "union" && !s.share && !aggregateWord) {
    const [a, b] = [...sexF].sort((x, y) => x.parts[0].span[0] - y.parts[0].span[0]);
    const gapStart = Math.max(...a.parts.map((p) => p.span[1]));
    const gapEnd = Math.min(...b.parts.map((p) => p.span[0]));
    // "vs"/"versus" is recognized as a comparison statistic, "and" as a connector.
    const join = parts.find((p) => (p.concept === "connector" || p.concept === "statistic") && /^(?:and|vs\.?|versus)$/i.test(p.text.trim()) && p.span[0] >= gapStart && p.span[1] <= gapEnd);
    const onlyJoinBetween = join && !parts.some((p) => p !== join && !["filler", "punctuation"].includes(p.concept) && p.span[0] >= gapStart && p.span[1] <= gapEnd);
    if (join && onlyJoinBetween) {
      s.filters = s.filters.filter((f) => f !== a && f !== b);
      s.declined = s.declined.filter((d) => d.part !== join);
      s.dims.push({ d: "sex", part: a.parts[0] });
      for (const p of [...a.parts, ...b.parts, join]) s.slot.set(p, "dim:sex");
    }
  }
  return s;
}

/* ================================================================== *
 * Slots -> one question type (or a named decline)
 * ================================================================== */

export function planShrQuestion(ledger: RequestLedger, db: Database.Database, question: string, cutoff: ShrCutoff): ShrQuestionDecision {
  const s = readSlots(ledger, question);
  const declined = [...s.declined, ...s.conflicts];
  const decline = (part: Part, why: string) => declined.push({ part, why });

  // Merge same-field filters into one value list (OR); different fields AND.
  const filters: QFilter[] = [];
  const filterParts = new Map<QFilter, Part[]>();
  for (const { filter, parts } of s.filters) {
    const same = filters.find((f) => f.field === filter.field);
    // Two DIFFERENT values of one field form a list only when "and"/"or" joins them; otherwise the request is ambiguous.
    if (same && filter.field !== "age") {
      const sameValues = JSON.stringify(same.predicates) === JSON.stringify(filter.predicates);
      const prior = filterParts.get(same)!;
      const joined = ledger.parts.some((c) => c.concept === "connector" && /^(?:and|or|either)$/i.test(c.text.trim())
        && c.span[0] >= Math.max(...prior.map((p) => p.span[1])) && c.span[1] <= Math.min(...parts.map((p) => p.span[0])));
      if (!sameValues && !joined) { decline(parts[0], `I can apply one ${filter.field} condition here, or a list joined by "or"; "${prior[0].text.trim()}" and "${parts[0].text.trim()}" together are ambiguous.`); continue; }
    }
    if (same && filter.field !== "age") {
      for (const p of filter.predicates) {
        const twin = same.predicates.find((q) => q.table === p.table && q.column === p.column && q.kind === p.kind && q.kind !== "range");
        if (twin) twin.values = [...new Set([...twin.values, ...p.values])]; else same.predicates.push({ ...p, values: [...p.values] });
      }
      if (!same.label.split(" or ").includes(filter.label)) same.label = `${same.label} or ${filter.label}`;
      filterParts.get(same)!.push(...parts);
    } else if (!same) {
      const copy: QFilter = { field: filter.field, label: filter.label, predicates: filter.predicates.map((p) => ({ ...p, values: [...p.values] })) };
      filters.push(copy); filterParts.set(copy, [...parts]);
    }
  }

  // Periods.
  let periods: YearMonth[] = [];
  let time: ShrQuestionSpec["time"] = null;
  let periodNote: string | null = null;
  let yearList = false;
  let openEndYears: number[] = [];
  let grainParts: { part: Part; grain: "year" | "month" }[] = [];
  const pr = readQuestionPeriods(s.periodParts, cutoff);
  if ("declined" in pr) declined.push(pr.declined);
  else { periods = pr.pairs; time = pr.grain; periodNote = pr.note; yearList = pr.yearList; openEndYears = pr.openEndYears; grainParts = pr.grainParts; }

  // r4 §1: ONE kind of number per request. Two statistic families, or two different age statistics, decline by name.
  const families: { name: string; parts: Part[] }[] = [];
  if (s.share) families.push({ name: "share", parts: [s.share] });
  if (s.age) families.push({ name: "age", parts: [s.age.part] });
  if (s.rank || s.rankedEntity) families.push({ name: "rank", parts: [s.rank?.part, s.rankedEntity?.part].filter((p): p is Part => !!p) });
  if (s.rateParts.length) families.push({ name: "rate", parts: s.rateParts });
  if (families.length > 1) for (const fam of families.slice(1)) for (const p of fam.parts) decline(p, WHY.oneStat);
  for (const p of s.ageConflict) decline(p, WHY.oneStat);

  // Which type?
  const nonTimeDims = s.dims;
  let type: QuestionType;
  if (s.rate) type = "agency-rate";
  else if (s.share) type = "share";
  else if (s.age) type = "age";
  else if (s.rank || s.rankedEntity) type = "top";
  else type = nonTimeDims.length > 0 || time ? "count-by" : "count";

  let dimension: QDimension | null = null;
  let numerator: QFilter | null = null;
  let base = filters;
  let rank: ShrQuestionSpec["rank"] = null;
  const unit = s.unit;


  switch (type) {
    case "count": case "count-by":
      dimension = nonTimeDims[0]?.d ?? null; // any further, different breakdown is unconsumed -> the gate
      if (!dimension && !time && yearList) time = "year"; // "in 2020 and 2024": each year shown
      if (type === "count" && time) type = "count-by";
      if (dimension) type = "count-by";
      break;
    case "share": {
      if (time === "month") decline(s.periodParts.find((p) => /month/i.test(p.text)) ?? s.share!, WHY.shareGrouping);
      // T3 frame (plan r3 §2): the base is everything attached to the subject; the numerator is the ONE condition of the
      // final predicate. The predicate starts at the first "were/was/involved/involving/killed/who were ... were" AFTER the
      // subject noun; a restrictive relative clause ("victims who were female") stays with the subject when a second
      // predicate follows it.
      const share = s.share!;
      const after = (p: Part) => !p.inherited && p.span[0] >= share.span[1];
      const ordered = [...filters].filter((f) => filterParts.get(f)!.every(after)).sort((a, b) => filterParts.get(a)![0].span[0] - filterParts.get(b)![0].span[0]);
      const before = filters.filter((f) => !ordered.includes(f));
      const subjectEnd = ledger.parts.filter((p) => after(p) && (p.concept === "role" || p.concept === "unit" || p.concept === "measure")).sort((a, b) => a.span[0] - b.span[0]);
      if (subjectEnd.length === 0 || ordered.length === 0) { decline(share, WHY.shareFrame); break; }
      // Conditions written before the subject noun ("share of FEMALE murder victims") are the base.
      const nounStart = subjectEnd[0].span[0];
      const preNoun = ordered.filter((f) => filterParts.get(f)!.every((p) => p.span[1] <= nounStart));
      const postNoun = ordered.filter((f) => !preNoun.includes(f));
      if (postNoun.length === 0) { decline(share, WHY.shareFrame); break; }
      // Among post-noun conditions, the LAST predicate is the numerator; earlier ones are relative clauses on the subject.
      // Exactly one numerator condition; a predicate that can't be placed (two conditions in the last predicate) declines.
      const last = postNoun[postNoun.length - 1];
      const lastStart = filterParts.get(last)![0].span[0];
      const prevEnd = postNoun.length > 1 ? Math.max(...filterParts.get(postNoun[postNoun.length - 2])!.map((p) => p.span[1])) : nounStart;
      const between = question.slice(prevEnd, lastStart).toLowerCase();
      // Two conditions coordinated in ONE predicate ("were female and killed with a firearm") are two numerator
      // conditions: declined, never split into a base and a numerator.
      if (postNoun.length > 1 && (/^\s*(?:and|or|&|,)/.test(between) || !/\b(?:were|was|are|is|involved|involving|killed|died|had)\b/.test(between))) { decline(share, WHY.shareFrame); break; }
      numerator = last;
      base = [...before, ...preNoun, ...postNoun.slice(0, -1)];
      break;
    }
    case "age":
      if (time === "month") decline(s.periodParts.find((p) => /month/i.test(p.text)) ?? s.age!.part, WHY.shareGrouping);
      if (unit === "incidents") decline(ledger.parts.find((p) => p.concept === "unit") ?? s.age!.part, WHY.ageUnit);
      break;
    case "top": {
      const d = s.rankedEntity?.d ?? (nonTimeDims[0]?.d as QDimension | undefined) ?? null;
      if (!d || !["state", "county", "city"].includes(d)) { decline(s.rank?.part ?? s.rankedEntity!.part, WHY.rankDimension); break; }
      if (time) decline(s.periodParts.find((p) => /year|month/i.test(p.text)) ?? s.rank?.part ?? s.rankedEntity!.part, "A ranking here is over the whole period; ask for the counts by year instead.");
      dimension = d;
      const plural = s.rankedEntity ? s.rankedEntity.plural : true;
      rank = { n: s.rank?.n ?? (plural ? 10 : 1), direction: s.rank?.direction ?? "desc" };
      break;
    }
    case "agency-rate":
      if (unit === "incidents") decline(ledger.parts.find((p) => p.concept === "unit") ?? s.rate!, WHY.ageUnit);
      for (const f of filters) if (["sex", "race", "ethnicity", "age"].includes(f.field)) decline(filterParts.get(f)![0], WHY.subgroupRate);
      if (s.share || s.age || s.rank || s.rankedEntity) decline(s.rate!, WHY.rateScope);
      if (s.agencyType) decline(s.agencyType.parts[0], WHY.rateScope);
      // r4 §2: rates are by year and per 100,000 only; any other grain or scale is declined by name, never rewritten.
      for (const g of grainParts) if (g.grain === "month") decline(g.part, `Rates here are given year by year, so I can't give a rate "${g.part.text.trim()}".`);
      for (const p of s.rateParts) if (!RATE_SCALE_OK.test(p.text.trim())) decline(p, `Rates here are per 100,000 residents, so I can't give a rate "${p.text.trim()}".`);
      time = "year";
      break;
  }
  // r4 §3 / r5 §1: EVERY threshold occurrence counts the same measure and unit as the answer (never swap the unit), and
  // only ONE distinct threshold is supported: a second, different one is declined by name, never overwritten.
  // r6 §2: two thresholds are the same value when their operator, amount, RESOLVED unit and RESOLVED homicide type agree
  // (a stated word, or else the request's own unit and measure).
  const thKey = (th: NonNullable<Slots["threshold"]>) => `${th.op}${th.value}|${th.unitWord ?? unit}|${th.measureWord ?? (s.measure ?? "murder")}`;
  for (const th of s.thresholds) {
    const word = th.wordPart ? `${th.words} ${th.wordPart.text.trim()}` : th.words;
    if (th.unitWord && th.unitWord !== unit) decline(th.wordPart ?? th.part, `The minimum "${word}" counts ${th.unitWord}, but this answer counts ${unit}; ask for both in the same terms.`);
    if (th.measureWord && th.measureWord !== (s.measure ?? "murder")) decline(th.wordPart ?? th.part, `The minimum "${word}" is about a different homicide type than the one counted here; ask for both in the same terms.`);
  }
  const distinctThresholds = [...new Map(s.thresholds.map((th) => [thKey(th), th])).values()];
  if (distinctThresholds.length > 1) for (const th of distinctThresholds.slice(1)) decline(th.part, `I can apply one minimum or maximum here; "${distinctThresholds[0].words}" and "${th.words}" are two, so I haven't answered with a number that drops one of them.`);

  // Geography.
  if (type === "agency-rate" && s.placeParts.some((p) => p.concept === "place" && (p.value?.startsWith("county:") || p.rule === "place:unresolved-county"))) decline(s.rate!, WHY.stateRate);
  if (type === "agency-rate" && s.placeParts.some((p) => p.concept === "national" || p.value?.startsWith("state:") && p.rule !== "place:state-code")) decline(s.rate!, WHY.stateRate);
  // A request already declined by name is not sent to the county resolver's clarification.
  const geoRead = declined.length > 0 ? null : readGeography(s.placeParts, db, question, periods, declined);
  if (geoRead && "county-exit" in geoRead) return { kind: "county-exit", resolution: geoRead["county-exit"] };
  const geo: QGeo | null = geoRead && "geo" in geoRead ? geoRead.geo : (!geoRead && s.placeParts.length === 0) ? { kind: "national" } : null;

  // A city breakdown or ranking counts city agencies only: membership from the accepted classification (SCA-1).
  let agencyType: ShrQuestionSpec["agencyType"] = s.agencyType?.type ?? null;
  if (dimension === "city") {
    if (agencyType === "County") decline(s.agencyType!.parts[0], "A breakdown or ranking by city counts city agencies, so it can't also be limited to sheriffs.");
    agencyType = "City";
  }
  // T6: a year cut short by the source's latest month has no rate (stated); any other partial year declines (R1).
  const noRateYears: number[] = [];
  if (geo) {
    if (s.agencyType && (geo.kind === "agencies" || geo.kind === "county")) decline(s.agencyType.parts[0], WHY.agencyTypeScope);
    if (type === "agency-rate" && !(geo.kind === "agencies" && geo.places.length === 1)) decline(s.rate!, geo.kind === "agencies" ? WHY.rateScope : WHY.stateRate);
    if (type === "agency-rate") {
      for (const year of [...new Set(periods.map((p) => p.year))]) {
        const months = periods.filter((p) => p.year === year).map((p) => p.month);
        if (months.length === 12) continue;
        // Only an OPEN-ENDED range cut short by the source gets the no-rate year; an explicit partial year declines (r4 §2).
        const cutShort = openEndYears.includes(year) && year === cutoff.year && months.length === cutoff.month && months.every((m, i) => m === i + 1);
        if (cutShort) noRateYears.push(year); else { decline(s.periodParts[0] ?? s.rate!, WHY.partialRate); break; }
      }
    }
    if (dimension === "county" && !(geo.kind === "states" && geo.states.length === 1)) decline(s.rankedEntity?.part ?? s.dims.find((d) => d.d === "county")?.part ?? s.rank!.part, WHY.countyRankScope);
    if (type === "top" && geo.kind !== "national" && geo.kind !== "states") decline(s.rank?.part ?? s.rankedEntity!.part, WHY.rankDimension);
    // r5 §4: a ranking is of every state, county or city in the scope; a LIST of places is declined, never collapsed.
    if (type === "top" && geo.kind === "states" && geo.states.length > 1) decline(s.rank?.part ?? s.rankedEntity!.part, WHY.rankList);
  }
  if (agencyType && !declined.length) {
    const availability = cachedYearClassAvailability(db);
    if (!availability.available) decline(s.agencyType?.parts[0] ?? s.rankedEntity?.part ?? s.dims.find((d) => d.d === "city")!.part, YEAR_CLASS_UNAVAILABLE_TEXT);
  }
  let countyMap: ShrQuestionSpec["countyMap"] = null;
  if (dimension === "county" && geo?.kind === "states" && !declined.length) {
    countyMap = mapCounties(db, geo.states[0].code);
    if (!countyMap) decline(s.rankedEntity?.part ?? s.dims.find((d) => d.d === "county")!.part, "The agency-to-county mapping this needs isn't available, so I can't break this down by county.");
  }

  if (declined.length > 0) {
    const unique = [...new Map(declined.map((d) => [`${d.part.span[0]}:${d.part.span[1]}:${d.part.text}:${d.why}`, d])).values()];
    return {
      kind: "decline", parts: [...new Set(unique.map((d) => d.part))],
      explanation: refusalSentences(unique.map((d) => ({ ...d.part, explanation: d.why }))).join(" "),
    };
  }
  if (!geo) return { kind: "decline", parts: [], explanation: "Which place do you want: the nation, a state, a county or a city?" };

  // A list of places: each on its own row when asked (or when the breakdown is that kind of place), else one stated total.
  const listSize = geo.kind === "states" ? geo.states.length : geo.kind === "agencies" ? geo.places.length : 1;
  const combine: ShrQuestionSpec["combine"] = listSize <= 1 ? "single"
    : s.combineWord === "each" || (dimension === "state" && geo.kind === "states") || (dimension === "city" && geo.kind === "agencies") ? "each" : "union";
  // Place rows are a COUNT breakdown only (r5 §4): never applied to a ranking.
  const placeRows = (type === "count" || type === "count-by") && combine === "each" && (dimension === "state" || dimension === "city"); // the place rows ARE the breakdown
  const rowDim = dimension;
  if (placeRows) dimension = null;
  const finalType: QuestionType = type === "count-by" && !dimension && !time && combine !== "each" ? "count" : type === "count" && combine === "each" ? "count-by" : type;
  const thresholdApplied = !!s.threshold && (finalType === "top" || (finalType === "count-by" && (placeRows || (!!dimension && ["state", "county", "city"].includes(dimension)))));

  // r4 §1 -- THE GATE. Every non-context part must be consumed by a slot the CHOSEN type actually uses, after every
  // normalization above. A part read into a slot the type ignores (a rank under a share, a threshold the compiled branch
  // would not apply, a breakdown normalized away) declines the whole request, naming it. No per-type exceptions.
  const consumed = new Set<Part>();
  for (const [part, name] of s.slot) {
    const uses = name === "place" || name === "period" || name === "measure" || name === "unit" || name === "role" || name === "filter" || name === "neutral" || name === "combine"
      || (name === "agencyType" && agencyType !== null)
      || (name === "share" && finalType === "share") || (name === "age" && finalType === "age")
      || (name === "rank" && finalType === "top") || (name === "rate" && finalType === "agency-rate")
      || (name === "threshold" && thresholdApplied)
      || (name.startsWith("dim:") && (name.slice(4) === dimension || (placeRows && name.slice(4) === rowDim)));
    if (uses) consumed.add(part);
  }
  const spec: ShrQuestionSpec = {
    // r3.1 shared slots: murder is the default homicide type.
    type: finalType, geo, combine, periods, periodNote, sourceEnd: cutoff.observed ? { year: cutoff.year, month: cutoff.month } : null, time, measure: s.measure ?? "murder", unit,
    filters: base, agencyType, dimension, numerator, age: s.age?.stat ?? null, rank,
    threshold: thresholdApplied ? { op: s.threshold!.op, value: s.threshold!.value, words: s.threshold!.wordPart ? `${s.threshold!.words} ${s.threshold!.wordPart.text.trim()}` : s.threshold!.words } : null, countyMap, noRateYears,
  };
  // r5 §1 -- VALUE-LEVEL consumption: a singleton-slot part is consumed only if the value it REQUESTED is the value in the
  // issued spec (checked after every normalization). A slot that is used, but with someone else's value, does not count.
  const specValue = (name: string, v: string): boolean => {
    if (name === "threshold") {
      if (!spec.threshold) return false;
      if (v.startsWith("unit:")) return v.slice(5) === spec.unit;
      if (v.startsWith("measure:")) return v.slice(8) === spec.measure;
      return v === `${spec.threshold.op}${spec.threshold.value}`;
    }
    if (name === "rank") { if (!spec.rank) return false; const [d, n] = v.split(":"); return d === spec.rank.direction && (n === "" || Number(n) === spec.rank.n); }
    if (name === "combine") return v === "each" ? spec.combine === "each" || placeRows : spec.combine === "union" || spec.combine === "single";
    if (name === "unit") return v === spec.unit;
    if (name === "measure") return v === spec.measure;
    return true;
  };
  for (const [part, v] of s.vals) if (consumed.has(part) && !specValue(s.slot.get(part) ?? "", v)) consumed.delete(part);
  const what = { count: "a count", "count-by": "this breakdown", share: "a share", age: "a victim-age answer", top: "a ranking", "agency-rate": "an agency rate" }[finalType];
  const unconsumed = ledger.parts.filter((p) => p.state !== "context" && !consumed.has(p));
  const reason = (p: Part): string => {
    const name = s.slot.get(p) ?? "";
    if (name.startsWith("dim:")) return finalType === "share" || finalType === "age" ? WHY.shareGrouping : finalType === "agency-rate" ? WHY.rateScope : finalType === "top" ? WHY.rankDimension : WHY.breakdown;
    if (name === "threshold") return WHY.threshold;
    return WHY.unconsumed(p.text.trim(), what, p.inherited);
  };
  if (unconsumed.length > 0) {
    return { kind: "decline", parts: unconsumed, explanation: refusalSentences(unconsumed.map((p) => ({ ...p, explanation: reason(p) }))).join(" ") };
  }
  // r5 §4 -- the FINAL normalized spec is validated immediately before compilation: a spec its type can't compile is a
  // named decline, never a thrown error.
  const invalid = specProblem(spec);
  if (invalid) return { kind: "decline", parts: [], explanation: `I can't answer that combination yet (${invalid}), so I haven't answered with a number.` };
  return { kind: "spec", spec };
}

/** Why a spec can't be compiled for its type, or null (r5 §4). */
export function specProblem(spec: ShrQuestionSpec): string | null {
  if (spec.periods.length === 0) return "no period";
  if (spec.type === "top" && (!spec.dimension || !spec.rank)) return "a ranking needs places to rank";
  if (spec.type === "count-by" && !spec.dimension && !spec.time && spec.combine !== "each") return "a breakdown needs something to break down by";
  if (spec.type === "share" && !spec.numerator) return "a share needs one condition";
  if (spec.type === "age" && !spec.age) return "an age answer needs median or average";
  if (spec.type === "agency-rate" && !(spec.geo.kind === "agencies" && spec.geo.places.length === 1 && spec.time === "year")) return "a rate needs one agency, year by year";
  if (spec.dimension === "county" && !spec.countyMap) return "a county breakdown needs the county mapping";
  return null;
}

/** Each SHR ORI in a state -> its one county, from the accepted crosswalk matching (lib/shr-county-scope.ts identitiesFor). */
function mapCounties(db: Database.Database, state: string): { ori: string; county: string }[] | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agency_county_crosswalk'").get()) return null;
  const rows = db.prepare(
    "SELECT DISTINCT i.ori AS ori, x.county_name AS county FROM incidents i JOIN agency_county_crosswalk x " +
    "ON upper(x.state) = i.state AND x.county_fips IS NOT NULL AND (i.ori = x.ori OR i.ori = x.ori9 OR substr(i.ori, 1, 7) = x.ori) WHERE i.state = ?",
  ).all(state) as { ori: string; county: string | null }[];
  const byOri = new Map<string, Set<string>>();
  for (const r of rows) if (r.county) byOri.set(r.ori, new Set([...(byOri.get(r.ori) ?? []), r.county]));
  return [...byOri.entries()].filter(([, c]) => c.size === 1).map(([ori, c]) => ({ ori, county: `${[...c][0]}, ${state}` })).sort((a, b) => a.ori.localeCompare(b.ori));
}

function readGeography(placeParts: Part[], db: Database.Database, question: string, periods: YearMonth[], declined: Declined[]):
  { geo: QGeo } | { "county-exit": Exclude<ShrCountyScopeResolution, { status: "resolved" }> } | null {
  const own = placeParts.filter((p) => !p.inherited);
  const use = own.length > 0 ? own : placeParts;
  if (use.length === 0) return null;
  const decline = (part: Part, why?: string) => declined.push({ part, why: why ?? WHY.generic(part.text.trim(), part.inherited) });
  const years = periods.map((p) => p.year);
  const startYear = years.length ? Math.min(...years) : 1976;
  const endYear = years.length ? Math.max(...years) : new Date().getUTCFullYear();
  const county = use.find((p) => p.concept === "place" && (p.value?.startsWith("county:") || p.rule === "place:unresolved-county"));
  if (county) {
    const request = shrCountyRequest(county.inherited ? county.text : question);
    if (!request) { decline(county); return null; }
    const others = use.filter((p) => p !== county && p.concept !== "agency-type" && p.rule !== "place:state-code" && !p.value?.startsWith("state:"));
    if (others.length > 0) { for (const o of others) decline(o, "I can answer for one county at a time."); return null; }
    const res = resolveShrCountyScope(db, request);
    if (res.status !== "resolved") return { "county-exit": res };
    return { geo: { kind: "county", binding: res.binding } };
  }
  if (use.every((p) => p.concept === "national")) return { geo: { kind: "national" } };
  const agencies = use.filter((p) => p.concept === "place" && p.value?.startsWith("agency:"));
  const cities = use.filter((p) => p.concept === "place" && p.value?.startsWith("city:"));
  // A two-letter state code after a named agency or city ("Metro County Police Department, AL") qualifies that place.
  const qualifier = (p: Part) => p.rule === "place:state-code" && (agencies.length > 0 || cities.length > 0);
  const states = use.filter((p) => p.concept === "place" && p.value?.startsWith("state:") && !qualifier(p));
  const other = use.filter((p) => !agencies.includes(p) && !cities.includes(p) && !states.includes(p) && !qualifier(p) && !(p.concept === "reporting-agency" && p.value) && p.concept !== "agency-type");
  if (other.length > 0) { for (const o of other) decline(o, o.concept === "national" ? "I can answer for the nation or for named places, not both in one number." : undefined); return null; }
  if (agencies.length > 0 || cities.length > 0) {
    const cityStates = new Set(cities.map((c) => (c.value!.split(",")[1] ?? "").trim().toUpperCase()));
    const stray = states.filter((st) => !cityStates.has(stateCode(st.value!.slice(6).split(",")[0]) ?? ""));
    if (stray.length > 0 || (agencies.length > 0 && states.length > 0)) { for (const st of stray.length ? stray : states) decline(st, "I can't combine a state and a city in one number; ask for one kind of place."); return null; }
    const places: { display: string; ranges: OriRange[] }[] = [];
    for (const ag of agencies) {
      const name = ag.value!.slice(7);
      const key = name.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
      const sts = (db.prepare("SELECT DISTINCT state FROM shr_agency_alias WHERE alias_key = ?").all(key) as { state: string }[]).map((r) => r.state);
      if (sts.length !== 1) { decline(ag, `I couldn't identify "${name}" as one SHR reporting agency${sts.length > 1 ? " (it names agencies in more than one state)" : ""}.`); return null; }
      const resolved = resolveShrAgency(db, name, sts[0], { kind: "agency", startYear, endYear });
      if (resolved.status !== "resolved" || resolved.ranges.length === 0) { decline(ag, `I cannot safely identify ${name} in the SHR agency identity data for that period. I will not substitute or silently omit another agency.`); return null; }
      places.push({ display: resolved.label, ranges: resolved.ranges.map((r) => ({ ori: r.ori, startYear: r.startYear, endYear: r.endYear })) });
    }
    for (const c of cities) {
      const [name, st] = c.value!.slice(5).split(",").map((x) => x.trim());
      if (!st) { decline(c); return null; }
      const resolved = resolveShrAgency(db, name === "New York City" ? "New York" : name, st, { kind: "city", startYear, endYear });
      if (resolved.status !== "resolved" || resolved.ranges.length === 0) { decline(c, `I cannot safely identify ${name}, ${st.toUpperCase()} in the SHR agency identity data for that period. I will not substitute or silently omit another agency.`); return null; }
      const display = `${name}, ${st.toUpperCase()}`;
      if (!places.some((p) => p.display === display)) places.push({ display, ranges: resolved.ranges.map((r) => ({ ori: r.ori, startYear: r.startYear, endYear: r.endYear })) });
    }
    return { geo: { kind: "agencies", places } };
  }
  if (states.length > 0) {
    const list: { code: string; name: string }[] = [];
    for (const st of states) {
      const name = st.value!.slice(6).split(",")[0].trim();
      const code = stateCode(name);
      if (!code) { decline(st); return null; }
      if (!list.some((x) => x.code === code)) list.push({ code, name: nameOf(code) ?? name });
    }
    return { geo: { kind: "states", states: list } };
  }
  return null;
}

function stateCode(nameOrCode: string): string | null {
  const t = nameOrCode.trim();
  if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
  return (STATE_NAME_TO_ABBR as Record<string, string>)[t] ?? null;
}
function nameOf(code: string): string | null {
  return Object.entries(STATE_NAME_TO_ABBR as Record<string, string>).find(([, c]) => c === code)?.[0] ?? null;
}

/* ================================================================== *
 * Compiler: the TYPE decides the statement (Codex r2 #1)
 * ================================================================== */

export type CompiledShrQuestion = Readonly<{
  spec: ShrQuestionSpec;
  sql: string;
  /** Place x period record presence, with no measure, filter or agency-type restriction (Codex r2 #6). */
  coverageSql: string;
  columns: readonly string[];
  valueColumn: string;
  title: string;
  explanation: string;
  chartType: "bar" | "line" | "none";
  xAxis: string | null;
  yAxisLabel: string;
  /** Plain table headers for result columns whose names are technical (owner 2026-10-23: a share table read
   *  "numerator", "denominator", "share", "unknown"). Display only; the CSV keeps the column names. */
  columnLabels: Readonly<Record<string, string>>;
}>;

const ISSUED = new WeakSet<object>();
const lit = (value: string) => `'${value.replace(/'/g, "''")}'`;
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  }
  return value;
}

function orPredicate(ranges: OriRange[], from: number, to: number): string {
  const parts = ranges
    .map((r) => ({ ori: r.ori, a: Math.max(Math.trunc(r.startYear), from), b: Math.min(Math.trunc(r.endYear), to) }))
    .filter((r) => r.a <= r.b)
    .map((r) => (r.a === from && r.b === to ? `i.ori = ${lit(r.ori)}` : `(i.ori = ${lit(r.ori)} AND i.year BETWEEN ${r.a} AND ${r.b})`));
  return parts.length ? parts.join(" OR ") : "1 = 0";
}

function predicateSql(p: QPredicate): string {
  const col = `${p.table}.${p.column}`;
  if (p.kind === "range") return `${col} BETWEEN ${p.lo} AND ${p.hi}`;
  if (p.kind === "like") return `(${p.values.map((v) => `${col} LIKE ${lit(v)}`).join(" OR ")})`;
  return p.values.length === 1 ? `${col} = ${lit(p.values[0])}` : `${col} IN (${p.values.map(lit).join(", ")})`;
}
const filterSql = (f: QFilter) => (f.predicates.length === 1 ? predicateSql(f.predicates[0]) : `(${f.predicates.map(predicateSql).join(" OR ")})`);

function periodSql(periods: YearMonth[]): string {
  const byYear = new Map<number, number[]>();
  for (const p of periods) byYear.set(p.year, [...(byYear.get(p.year) ?? []), p.month]);
  const full = [...byYear.entries()].filter(([, ms]) => ms.length === 12).map(([y]) => y);
  const partial = [...byYear.entries()].filter(([, ms]) => ms.length < 12);
  const clauses: string[] = [];
  if (full.length) {
    const contiguous = full.every((y, i) => i === 0 || y === full[i - 1] + 1);
    clauses.push(full.length === 1 ? `i.year = ${full[0]}` : contiguous ? `i.year BETWEEN ${full[0]} AND ${full[full.length - 1]}` : `i.year IN (${full.join(", ")})`);
  }
  for (const [y, ms] of partial) clauses.push(`(i.year = ${y} AND i.month IN (${[...new Set(ms)].sort((a, b) => a - b).join(", ")}))`);
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(" OR ")})`;
}

const DIMENSION: Record<Exclude<QDimension, "county" | "city">, { expr: string; column: string; label: string }> = {
  state: { expr: "COALESCE(i.state_name, i.state)", column: "state", label: "state" },
  weapon: { expr: "COALESCE(i.weapon_group, 'Unknown')", column: "weapon_group", label: "weapon" },
  relationship: { expr: "COALESCE(i.relationship_group, 'Unknown')", column: "relationship_group", label: "relationship" },
  circumstance: { expr: "COALESCE(i.circumstance_group, 'Unknown')", column: "circumstance_group", label: "circumstance" },
  race: { expr: "COALESCE(v.race, 'Unknown')", column: "victim_race", label: "victim race" },
  sex: { expr: "COALESCE(v.sex, 'Unknown')", column: "victim_sex", label: "victim sex" },
  "age-group": { expr: "CASE WHEN v.age_num IS NULL THEN 'Unknown' WHEN v.age_num < 18 THEN '0-17' WHEN v.age_num < 25 THEN '18-24' WHEN v.age_num < 35 THEN '25-34' WHEN v.age_num < 50 THEN '35-49' WHEN v.age_num < 65 THEN '50-64' ELSE '65+' END", column: "victim_age_group", label: "victim age group" },
};
const UNMAPPED_COUNTY = "County not mapped";
function dimensionOf(spec: ShrQuestionSpec): { expr: string; column: string; label: string } | null {
  if (!spec.dimension) return null;
  if (spec.dimension === "county") return { expr: `COALESCE(oc.county, ${lit(UNMAPPED_COUNTY)})`, column: "county", label: "county" };
  if (spec.dimension === "city") return { expr: "COALESCE(sid.canonical_agency, i.agency) || ', ' || i.state", column: "city", label: "city agency" };
  return DIMENSION[spec.dimension];
}

/**
 * The answer's places (`expr`/`labels`) and, separately, the CONSTITUENT places (`cexpr`/`clabels`, r4 §4): for a combined
 * total they differ, and coverage is computed per constituent BEFORE combining, so one place's records never mask
 * another's missing period. `owner[i]` is the answer label constituent i rolls up into.
 */
function placeOf(spec: ShrQuestionSpec): { where: string; expr: string; labels: string[]; cexpr: string; clabels: string[]; owner: string[] } {
  const years = spec.periods.map((p) => p.year);
  const from = Math.min(...years);
  const to = Math.max(...years);
  const g = spec.geo;
  const union = (labels: string[]) => `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]} combined`;
  const same = (where: string, expr: string, labels: string[]) => ({ where, expr, labels, cexpr: expr, clabels: labels, owner: labels });
  if (g.kind === "national") return same("1 = 1", lit("United States"), ["United States"]);
  if (g.kind === "county") {
    const label = g.binding.kind === "sheriff" ? `${g.binding.label}, ${g.binding.state}` : g.binding.label;
    return same(orPredicate(g.binding.ranges, from, to), lit(label), [label]);
  }
  if (g.kind === "states") {
    const names = g.states.map((x) => x.name);
    const where = g.states.length === 1 ? `i.state = ${lit(g.states[0].code)}` : `i.state IN (${g.states.map((x) => lit(x.code)).join(", ")})`;
    const each = g.states.length === 1 ? lit(names[0]) : `CASE ${g.states.map((x) => `WHEN i.state = ${lit(x.code)} THEN ${lit(x.name)}`).join(" ")} END`;
    if (spec.combine === "union") { const l = union(names); return { where, expr: lit(l), labels: [l], cexpr: each, clabels: names, owner: names.map(() => l) }; }
    return same(where, each, names);
  }
  const names = g.places.map((p) => p.display);
  const where = g.places.map((p) => `(${orPredicate(p.ranges, from, to)})`).join(" OR ");
  const each = g.places.length === 1 ? lit(names[0]) : `CASE ${g.places.map((p, n) => `WHEN ${orPredicate(p.ranges, from, to)} THEN ${lit(names[n])}`).join(" ")} END`;
  if (spec.combine === "union") { const l = union(names); return { where, expr: lit(l), labels: [l], cexpr: each, clabels: names, owner: names.map(() => l) }; }
  return same(where, each, names);
}

function compileStatements(spec: ShrQuestionSpec): { sql: string; coverageSql: string; columns: string[]; valueColumn: string } {
  const place = placeOf(spec);
  const scope = `(${place.where}) AND ${periodSql(spec.periods)}`;
  const measure = spec.measure === "murder" ? " AND i.homicide_type = 'Murder'" : spec.measure === "manslaughter" ? " AND i.homicide_type LIKE 'Manslaughter%'" : "";
  const filters = spec.filters.map((f) => ` AND ${filterSql(f)}`).join("");
  const classJoin = spec.agencyType ? ` JOIN ${SHR_YEAR_CLASS_TABLE} c ON c.ori = i.ori AND c.state = i.state AND c.year = i.year` : "";
  const classWhere = spec.agencyType ? ` AND c.agency_type = ${lit(spec.agencyType)}` : "";
  const dim = dimensionOf(spec);
  const countyCte = spec.dimension === "county" ? `oc(ori, county) AS (VALUES ${(spec.countyMap!.length ? spec.countyMap! : [{ ori: "", county: UNMAPPED_COUNTY }]).map((r) => `(${lit(r.ori)}, ${lit(r.county)})`).join(", ")})` : null;
  const extraJoins = `${spec.dimension === "county" ? " LEFT JOIN oc ON oc.ori = i.ori" : ""}${spec.dimension === "city" ? " LEFT JOIN shr_agency_identity sid ON sid.ori = i.ori AND sid.state = i.state" : ""}`;
  const from = `FROM incidents i JOIN victims v ON v.incident_id = i.id${classJoin}${extraJoins}`;
  const where = `${scope}${measure}${classWhere}${filters}`;
  const unitCol = spec.unit === "incidents" ? "incidents" : "victims";
  const countExpr = spec.unit === "incidents" ? "COUNT(DISTINCT i.id)" : "COUNT(v.id)";
  const timeExpr = spec.time === "month" ? "printf('%04d-%02d', i.year, i.month)" : spec.time === "year" ? "i.year" : null;
  const timeCol = spec.time === "month" ? "month" : spec.time === "year" ? "year" : null;
  const cellKey = spec.time === "month" ? "printf('%04d-%02d', i.year, i.month)" : "i.year";
  const cellKeys = spec.time === "month"
    ? spec.periods.map((p) => `'${p.year}-${String(p.month).padStart(2, "0")}'`)
    : [...new Set(spec.periods.map((p) => p.year))].map(String);

  // Coverage (Codex r2 #6): any SHR record of any homicide type in the place and period cell. Never the measure, filters
  // or agency type, so a filtered absence where records exist is a recorded 0, never "no records".
  const placesCte = `places(place, ord) AS (VALUES ${place.labels.map((l, n) => `(${lit(l)}, ${n + 1})`).join(", ")})`;
  const periodsCte = `periods(period) AS (VALUES ${cellKeys.map((k) => `(${k})`).join(", ")})`;
  // r4 §4: per CONSTITUENT first, then rolled up to the answer's places.
  const constituentsCte = `constituents(c, place, cord) AS (VALUES ${place.clabels.map((l, n) => `(${lit(l)}, ${lit(place.owner[n])}, ${n + 1})`).join(", ")})`;
  const ccoverageCte = `ccoverage AS (SELECT ${place.cexpr} AS c, ${cellKey} AS period, COUNT(*) AS source_incidents FROM incidents i WHERE ${scope} GROUP BY 1, 2)`;
  const coverageCte = `${constituentsCte}, ${ccoverageCte}, coverage AS (SELECT cs.place AS place, cc.period AS period, SUM(cc.source_incidents) AS source_incidents FROM ccoverage cc JOIN constituents cs ON cs.c = cc.c GROUP BY 1, 2)`;
  const coverageSql = `WITH ${periodsCte}, ${constituentsCte}, ${ccoverageCte} SELECT cs.c AS place, pr.period AS period, CASE WHEN cc.source_incidents IS NULL THEN 0 ELSE 1 END AS has_records ` +
    `FROM constituents cs CROSS JOIN periods pr LEFT JOIN ccoverage cc ON cc.c = cs.c AND cc.period = pr.period ORDER BY cs.cord, pr.period`;
  const head = `WITH ${[countyCte, placesCte, periodsCte, coverageCte].filter(Boolean).join(", ")}`;
  const cells = "FROM places p CROSS JOIN periods pr LEFT JOIN coverage c ON c.place = p.place AND c.period = pr.period";
  const noData = "'no SHR records'";

  switch (spec.type) {
    case "count": {
      // One figure per place; cells with no records are not in the figure and are listed.
      const counts = `counts AS (SELECT ${place.expr} AS place, ${cellKey} AS period, ${countExpr} AS n ${from} WHERE ${where} GROUP BY 1, 2)`;
      const sql = `${head}, ${counts} SELECT p.place AS place, CASE WHEN SUM(c.source_incidents) IS NULL THEN NULL ELSE COALESCE(SUM(k.n), 0) END AS ${unitCol}, ` +
        `GROUP_CONCAT(CASE WHEN c.source_incidents IS NULL THEN pr.period END, ', ') AS periods_without_records ` +
        `${cells} LEFT JOIN counts k ON k.place = p.place AND k.period = pr.period GROUP BY p.place, p.ord ORDER BY p.ord LIMIT 1000`;
      return { sql, coverageSql, columns: ["place", unitCol, "periods_without_records"], valueColumn: unitCol };
    }
    case "count-by": {
      if (!dim) {
        // Time grain only (or each place on its own row): every place x period cell is listed; no records -> NULL.
        const counts = `counts AS (SELECT ${place.expr} AS place, ${cellKey} AS period, ${countExpr} AS n ${from} WHERE ${where} GROUP BY 1, 2)`;
        // r4 §3: place rows with a threshold keep only places whose total over the WHOLE period passes it.
        const th = spec.threshold;
        const ptotals = th ? `, ptotals AS (SELECT place, SUM(n) AS total FROM counts GROUP BY place)` : "";
        const pass = th ? ` WHERE p.place IN (SELECT place FROM ptotals WHERE total ${th.op} ${th.value})` : "";
        if (timeCol) {
          const sql = `${head}, ${counts}${ptotals} SELECT p.place AS place, pr.period AS ${timeCol}, CASE WHEN c.source_incidents IS NULL THEN NULL ELSE COALESCE(k.n, 0) END AS ${unitCol}, ` +
            `CASE WHEN c.source_incidents IS NULL THEN ${noData} ELSE 'recorded' END AS shr_records ` +
            `${cells} LEFT JOIN counts k ON k.place = p.place AND k.period = pr.period${pass} ORDER BY p.ord, pr.period LIMIT 1000`;
          return { sql, coverageSql, columns: ["place", timeCol, unitCol, "shr_records"], valueColumn: unitCol };
        }
        const sql = `${head}, ${counts}${ptotals} SELECT p.place AS place, CASE WHEN SUM(c.source_incidents) IS NULL THEN NULL ELSE COALESCE(SUM(k.n), 0) END AS ${unitCol}, ` +
          `GROUP_CONCAT(CASE WHEN c.source_incidents IS NULL THEN pr.period END, ', ') AS periods_without_records ` +
          `${cells} LEFT JOIN counts k ON k.place = p.place AND k.period = pr.period${pass} GROUP BY p.place, p.ord ORDER BY p.ord LIMIT 1000`;
        return { sql, coverageSql, columns: ["place", unitCol, "periods_without_records"], valueColumn: unitCol };
      }
      // One breakdown (plus an optional time grain): one row per value present in the counted rows.
      const grouped = `grouped AS (SELECT ${place.expr} AS place${timeExpr ? `, ${timeExpr} AS ${timeCol}` : ""}, ${dim.expr} AS grp, ${countExpr} AS n ${from} WHERE ${where} GROUP BY 1, 2${timeExpr ? ", 3" : ""})`;
      const th = spec.threshold;
      const totals = th ? `, totals AS (SELECT place, grp, SUM(n) AS total FROM grouped GROUP BY place, grp)` : "";
      const thWhere = th ? ` WHERE t.total ${th.op} ${th.value}` : "";
      const thJoin = th ? " JOIN totals t ON t.place = g.place AND t.grp = g.grp" : "";
      const placeDim = spec.dimension === "state" || spec.dimension === "county" || spec.dimension === "city";
      if (placeDim && timeCol) {
        // r4 §3: every requested period for each place that appears (and passes the whole-period threshold): a period in
        // which that place has no SHR record of ANY homicide type is NULL ("no SHR records"); otherwise the count, 0 included.
        const extraNoVictims = `${spec.dimension === "county" ? " LEFT JOIN oc ON oc.ori = i.ori" : ""}${spec.dimension === "city" ? " LEFT JOIN shr_agency_identity sid ON sid.ori = i.ori AND sid.state = i.state" : ""}`;
        const gcov = `gcov AS (SELECT ${dim.expr} AS grp, ${cellKey} AS period, COUNT(*) AS src FROM incidents i${classJoin}${extraNoVictims} WHERE ${scope}${classWhere} GROUP BY 1, 2)`;
        const passing = `passing AS (SELECT DISTINCT g.place AS place, g.grp AS grp FROM grouped g${thJoin}${thWhere})`;
        const sql = `${head}, ${grouped}${totals}, ${gcov}, ${passing} SELECT ps.place AS place, pr.period AS ${timeCol}, ps.grp AS ${dim.column}, ` +
          `CASE WHEN gc.src IS NULL THEN NULL ELSE COALESCE(g.n, 0) END AS ${unitCol}, CASE WHEN gc.src IS NULL THEN ${noData} ELSE 'recorded' END AS shr_records ` +
          `FROM passing ps CROSS JOIN periods pr LEFT JOIN grouped g ON g.place = ps.place AND g.grp = ps.grp AND g.${timeCol} = pr.period ` +
          `LEFT JOIN gcov gc ON gc.grp = ps.grp AND gc.period = pr.period ORDER BY ps.place, ps.grp, pr.period LIMIT 1000`;
        return { sql, coverageSql, columns: ["place", timeCol, dim.column, unitCol, "shr_records"], valueColumn: unitCol };
      }
      // A breakdown with no matching rows where the source HAS records is a recorded 0 (one "(none recorded)" row), never
      // an empty answer that reads as a decline (Codex r3 probe "coverage-dimension-zero").
      const zero = timeCol ? "" : ` UNION ALL SELECT p.place AS place, '(none recorded)' AS ${dim.column}, 0 AS ${unitCol} FROM places p WHERE NOT EXISTS (SELECT 1 FROM grouped) AND EXISTS (SELECT 1 FROM coverage)`;
      const sql = `${head}, ${grouped}${totals} SELECT * FROM (SELECT g.place AS place${timeCol ? `, g.${timeCol} AS ${timeCol}` : ""}, g.grp AS ${dim.column}, g.n AS ${unitCol} FROM grouped g${thJoin}${thWhere}${zero}) ` +
        `ORDER BY place${timeCol ? `, ${timeCol}` : ""}, ${unitCol} DESC, ${dim.column} LIMIT 1000`;
      return { sql, coverageSql, columns: ["place", ...(timeCol ? [timeCol] : []), dim.column, unitCol], valueColumn: unitCol };
    }
    case "share": {
      const num = filterSql(spec.numerator!);
      const cols = [...new Set(spec.numerator!.predicates.map((p) => `${p.table}.${p.column}`))];
      const unknown = cols.map((c) => `${c} IS NULL OR ${c} = 'Unknown'`).join(" OR ");
      const id = spec.unit === "incidents" ? "i.id" : "v.id";
      const d = spec.unit === "incidents" ? "DISTINCT " : "";
      const counts = `counts AS (SELECT ${place.expr} AS place, ${cellKey} AS period, COUNT(${d}${id}) AS den, COUNT(${d}CASE WHEN ${num} THEN ${id} END) AS num, ` +
        `COUNT(${d}CASE WHEN ${unknown} THEN ${id} END) AS unk ${from} WHERE ${where} GROUP BY 1, 2)`;
      const agg = (x: string) => (timeCol ? `k.${x}` : `SUM(k.${x})`);
      const has = timeCol ? "c.source_incidents IS NOT NULL" : "SUM(c.source_incidents) IS NOT NULL";
      const sql = `${head}, ${counts} SELECT p.place AS place${timeCol ? `, pr.period AS ${timeCol}` : ""}, ` +
        `CASE WHEN ${has} THEN COALESCE(${agg("num")}, 0) END AS numerator_${unitCol}, ` +
        `CASE WHEN ${has} THEN COALESCE(${agg("den")}, 0) END AS denominator_${unitCol}, ` +
        `CASE WHEN ${has} AND COALESCE(${agg("den")}, 0) > 0 THEN ROUND(100.0 * ${agg("num")} / ${agg("den")}, 1) END AS share_pct, ` +
        `COALESCE(${agg("unk")}, 0) AS unknown_value_${unitCol}, ` +
        (timeCol
          ? `CASE WHEN c.source_incidents IS NULL THEN ${noData} WHEN COALESCE(k.den, 0) = 0 THEN 'none in the base' ELSE 'recorded' END AS shr_records `
          : `GROUP_CONCAT(CASE WHEN c.source_incidents IS NULL THEN pr.period END, ', ') AS periods_without_records `) +
        `${cells} LEFT JOIN counts k ON k.place = p.place AND k.period = pr.period ${timeCol ? "" : "GROUP BY p.place, p.ord "}ORDER BY p.ord${timeCol ? ", pr.period" : ""} LIMIT 1000`;
      return { sql, coverageSql, columns: ["place", ...(timeCol ? [timeCol] : []), `numerator_${unitCol}`, `denominator_${unitCol}`, "share_pct", `unknown_value_${unitCol}`, timeCol ? "shr_records" : "periods_without_records"], valueColumn: "share_pct" };
    }
    case "age": {
      const key = timeCol ? cellKey : "0";
      const known = `known AS (SELECT ${place.expr} AS place, ${key} AS period, v.age_num AS age ${from} WHERE ${where} AND v.age_num IS NOT NULL)`;
      const unknownAges = `unknown AS (SELECT ${place.expr} AS place, ${key} AS period, COUNT(v.id) AS n ${from} WHERE ${where} AND v.age_num IS NULL GROUP BY 1, 2)`;
      const stat = spec.age === "average"
        ? `stat AS (SELECT place, period, ROUND(AVG(age), 1) AS value, COUNT(*) AS known_n FROM known GROUP BY place, period)`
        : `ranked AS (SELECT place, period, age, ROW_NUMBER() OVER (PARTITION BY place, period ORDER BY age) AS rn, COUNT(*) OVER (PARTITION BY place, period) AS n FROM known), ` +
          `stat AS (SELECT place, period, ROUND(AVG(age), 1) AS value, MAX(n) AS known_n FROM ranked WHERE rn IN ((n + 1) / 2, (n + 2) / 2) GROUP BY place, period)`;
      const col = spec.age === "average" ? "average_victim_age" : "median_victim_age";
      if (timeCol) {
        const sql = `${head}, ${known}, ${unknownAges}, ${stat} SELECT p.place AS place, pr.period AS ${timeCol}, st.value AS ${col}, COALESCE(st.known_n, 0) AS victims_with_known_age, ` +
          `COALESCE(u.n, 0) AS victims_age_unknown, CASE WHEN c.source_incidents IS NULL THEN ${noData} WHEN st.value IS NULL THEN 'no known ages' ELSE 'recorded' END AS shr_records ` +
          `${cells} LEFT JOIN stat st ON st.place = p.place AND st.period = pr.period LEFT JOIN unknown u ON u.place = p.place AND u.period = pr.period ORDER BY p.ord, pr.period LIMIT 1000`;
        return { sql, coverageSql, columns: ["place", timeCol, col, "victims_with_known_age", "victims_age_unknown", "shr_records"], valueColumn: col };
      }
      const missing = `missing AS (SELECT p.place AS place, GROUP_CONCAT(CASE WHEN c.source_incidents IS NULL THEN pr.period END, ', ') AS periods_without_records FROM places p CROSS JOIN periods pr LEFT JOIN coverage c ON c.place = p.place AND c.period = pr.period GROUP BY p.place)`;
      const sql = `${head}, ${known}, ${unknownAges}, ${stat}, ${missing} SELECT p.place AS place, st.value AS ${col}, COALESCE(st.known_n, 0) AS victims_with_known_age, COALESCE(u.n, 0) AS victims_age_unknown, m.periods_without_records AS periods_without_records ` +
        `FROM places p LEFT JOIN stat st ON st.place = p.place LEFT JOIN unknown u ON u.place = p.place LEFT JOIN missing m ON m.place = p.place ORDER BY p.ord LIMIT 1000`;
      return { sql, coverageSql, columns: ["place", col, "victims_with_known_age", "victims_age_unknown", "periods_without_records"], valueColumn: col };
    }
    case "top": {
      const th = spec.threshold;
      const r = spec.rank!;
      const excludeUnmapped = spec.dimension === "county" ? ` AND oc.county IS NOT NULL` : "";
      const grouped = `grouped AS (SELECT ${dim!.expr} AS grp, ${countExpr} AS n ${from} WHERE ${where}${excludeUnmapped} GROUP BY 1${th ? ` HAVING ${countExpr} ${th.op} ${th.value}` : ""})`;
      const rankedCte = `ranked AS (SELECT grp, n, RANK() OVER (ORDER BY n ${r.direction === "asc" ? "ASC" : "DESC"}) AS rnk FROM grouped)`;
      const sql = `${head}, ${grouped}, ${rankedCte} SELECT rnk AS rank, grp AS ${dim!.column}, n AS ${unitCol} FROM ranked WHERE rnk <= ${r.n} ORDER BY rnk, grp LIMIT 1000`;
      return { sql, coverageSql, columns: ["rank", dim!.column, unitCol], valueColumn: unitCol };
    }
    case "agency-rate": {
      // T6 (plan r3.1 R1): per year; population from the agency's own incident rows that year (GC-064's source),
      // valid only as exactly one distinct positive value.
      const counts = `counts AS (SELECT ${cellKey} AS period, COUNT(v.id) AS n ${from} WHERE ${where} GROUP BY 1)`;
      const pop = `pop AS (SELECT i.year AS period, COUNT(DISTINCT i.population) AS distinct_pop, MIN(i.population) AS pop FROM incidents i WHERE ${scope} AND i.population IS NOT NULL GROUP BY 1)`;
      const cut = spec.noRateYears.length ? ` WHEN pr.period IN (${spec.noRateYears.join(", ")}) THEN 'partial year in the source'` : "";
      // r4 §2: a year with no records for the agency has no population in this data: the agreed "no population recorded".
      const status = `CASE WHEN c.source_incidents IS NULL THEN 'no population recorded'${cut} WHEN po.distinct_pop IS NULL OR po.pop <= 0 THEN 'no population recorded' WHEN po.distinct_pop > 1 THEN 'conflicting population recorded' ELSE 'recorded' END`;
      const sql = `${head}, ${counts}, ${pop} SELECT p.place AS place, pr.period AS year, CASE WHEN c.source_incidents IS NULL THEN NULL ELSE COALESCE(k.n, 0) END AS victims, ` +
        `CASE WHEN ${status} = 'recorded' THEN po.pop END AS population, ` +
        `CASE WHEN ${status} = 'recorded' THEN ROUND(COALESCE(k.n, 0) * 100000.0 / po.pop, 2) END AS rate_per_100k, ${status} AS population_status ` +
        `${cells} LEFT JOIN counts k ON k.period = pr.period LEFT JOIN pop po ON po.period = pr.period ORDER BY pr.period LIMIT 1000`;
      return { sql, coverageSql, columns: ["place", "year", "victims", "population", "rate_per_100k", "population_status"], valueColumn: "rate_per_100k" };
    }
  }
}

/* ================================================================== *
 * Templates: every word from the issued spec (Codex r2 #3)
 * ================================================================== */

function periodWords(spec: ShrQuestionSpec): string {
  const byYear = new Map<number, number[]>();
  for (const p of spec.periods) byYear.set(p.year, [...(byYear.get(p.year) ?? []), p.month]);
  const years = [...byYear.keys()];
  const allFull = [...byYear.values()].every((ms) => ms.length === 12);
  const contiguousYears = years.every((y, i) => i === 0 || y === years[i - 1] + 1);
  if (allFull && years.length > 2 && contiguousYears) return `${years[0]}-${years[years.length - 1]}`;
  // Round 1 W1 (owner threshold 1): only the last year partial, from January on, is written as a range with its end.
  const lastMonths = [...(byYear.get(years[years.length - 1]) ?? [])].sort((a, b) => a - b);
  const leadingFull = years.slice(0, -1).every((y) => (byYear.get(y) ?? []).length === 12);
  if (!allFull && years.length > 2 && contiguousYears && leadingFull && lastMonths[0] === 1 && lastMonths.every((m, i) => m === i + 1)) {
    const lastYear = years[years.length - 1];
    return `${years[0]}-${lastYear} (${lastYear} ${lastMonths.length === 1 ? "January only" : `through ${monthWords([lastMonths[lastMonths.length - 1]])}`})`;
  }
  const monthSets = [...byYear.values()].map((ms) => [...ms].sort((a, b) => a - b).join(","));
  if (!allFull && years.length > 2 && contiguousYears && new Set(monthSets).size === 1) return `${monthWords([...byYear.values()][0].sort((a, b) => a - b))} of each year, ${years[0]}-${years[years.length - 1]}`;
  return [...byYear.entries()].map(([y, ms]) => (ms.length === 12 ? String(y) : `${monthWords([...ms].sort((a, b) => a - b))} ${y}`)).join(", ");
}

/**
 * The period for a TITLE (owner 2026-10-23: a title listed 51 years one by one). Contiguous full years read
 * "1976 to 2025"; when only the last year is partial and runs from January, "1976 to 2026 (2026 Partial)" (owner
 * 2026-10-25: no months in titles).
 * Anything else keeps periodWords (the explanation always keeps periodWords).
 */
/**
 * Owner 2026-10-25: a requested year that runs past the source's last month (a whole-year question for the current
 * year) is partial. Returns the source end when that applies, so the title says "(Partial)" and the explanation names
 * the months actually covered; null otherwise.
 */
function sourceCutsPeriod(spec: ShrQuestionSpec): { year: number; month: number } | null {
  const end = spec.sourceEnd;
  if (!end || end.month >= 12) return null;
  return spec.periods.some((p) => p.year === end.year && p.month > end.month) ? end : null;
}

function titlePeriodWords(spec: ShrQuestionSpec): string {
  const byYear = new Map<number, number[]>();
  const cut = sourceCutsPeriod(spec);
  for (const p of spec.periods) if (!(cut && p.year === cut.year && p.month > cut.month)) byYear.set(p.year, [...(byYear.get(p.year) ?? []), p.month]);
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (!years.length || !years.every((y, i) => i === 0 || y === years[i - 1] + 1)) return periodWords(spec);
  const full = (ms: number[]) => new Set(ms).size === 12;
  if (!years.slice(0, -1).every((y) => full(byYear.get(y)!))) return periodWords(spec);
  const last = years[years.length - 1];
  const lastMonths = [...new Set(byYear.get(last)!)].sort((a, b) => a - b);
  const span = years.length === 1 ? `${last}` : `${years[0]} to ${last}`;
  if (lastMonths.length === 12) return span;
  // Owner 2026-10-25: "(Partial)" never the months, but ONLY where the source itself ends (Codex PY-01/PY-02): the
  // last year runs January to the source's last month. A window the reader asked for keeps its months.
  const end = spec.sourceEnd;
  const sourceCut = !!end && last === end.year && lastMonths.length === end.month && lastMonths.every((m, i) => m === i + 1);
  if (!sourceCut) return periodWords(spec);
  return years.length === 1 ? `${last} (Partial)` : `${span} (${last} Partial)`;
}

function filterWords(f: QFilter): string { return f.label; }

function subjectWords(spec: ShrQuestionSpec): string {
  const victim = spec.filters.filter((f) => ["sex", "race", "ethnicity"].includes(f.field)).map(filterWords);
  const age = spec.filters.filter((f) => f.field === "age").map(filterWords);
  const weapon = spec.filters.filter((f) => f.field === "weapon").map(filterWords);
  const other = spec.filters.filter((f) => f.field === "relationship" || f.field === "circumstance").map(filterWords);
  const measure = spec.measure === "murder" ? "murder" : spec.measure === "manslaughter" ? "negligent manslaughter" : "homicide";
  const unit = spec.unit === "incidents" ? "incidents" : "victims";
  return [...victim, ...weapon, measure, unit, ...(age.length ? [age.join(", ")] : []), ...(other.length ? [`(${other.join("; ")})`] : [])].join(" ");
}

function describe(spec: ShrQuestionSpec, labels: string[]): { title: string; explanation: string; yAxisLabel: string; columnLabels: Record<string, string> } {
  const subject = subjectWords(spec);
  const where = labels.join(", ");
  const when = periodWords(spec);
  const tWhen = titlePeriodWords(spec);
  const columnLabels: Record<string, string> = {};
  const agency = spec.agencyType === "City" ? " reported by city agencies" : spec.agencyType === "County" ? " reported by sheriffs and county agencies" : "";
  const unit = spec.unit === "incidents" ? "incidents" : "victims";
  const per = spec.time === "month" ? ", month by month" : spec.time === "year" ? ", year by year" : "";
  const dim = dimensionOf(spec);
  const cap = (x: string) => x.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const scope = `${subject[0].toUpperCase()}${subject.slice(1)}${agency} recorded in SHR for ${where}, ${when}${spec.periodNote ? ` (${spec.periodNote})` : ""}`;
  const cut = sourceCutsPeriod(spec);
  // Codex PY-04: the covered months are the REQUESTED months of that year up to the source's last month.
  const asked = cut ? spec.periods.filter((p) => p.year === cut.year).map((p) => p.month).sort((a, c) => a - c) : [];
  const covered = asked.filter((m) => cut && m <= cut.month);
  const cutNote = !cut ? ""
    : !covered.length ? ` ${cut.year} runs through ${MONTH_NAMES[cut.month - 1]} in this source, so none of the requested ${cut.year} months are in it yet.`
      : ` ${cut.year} runs through ${MONTH_NAMES[cut.month - 1]} in this source, so ${cut.year} covers ${covered.length === 1 ? MONTH_NAMES[covered[0] - 1] : `${MONTH_NAMES[covered[0] - 1]} through ${MONTH_NAMES[covered[covered.length - 1] - 1]}`} only.`;
  const unitNote = `${spec.unit === "victims" ? "One incident can have multiple victims, so this counts victim records rather than incidents." : "Each incident is counted once, however many victims it had."}${cutNote}`;
  const union = spec.combine === "union" ? ` The places are combined into one total, as asked.` : "";
  const th = spec.threshold ? ` Only places with ${spec.threshold.words} ${spec.measure === "murder" ? "murder" : spec.measure === "manslaughter" ? "negligent manslaughter" : "homicide"} ${unit} over the whole period (${when}) are shown.` : "";
  let statistic: string; let title: string; let yAxisLabel: string;
  switch (spec.type) {
    case "count":
      statistic = `The count of ${unit}.`; title = `${cap(subject)}${agency ? cap(agency) : ""}, ${where}, ${tWhen}`; yAxisLabel = unit; break;
    case "count-by":
      statistic = dim ? `The count of ${unit} by ${dim.label}${per}. Only ${dim.label} values present in these records are shown.` : `The count of ${unit}${per}.`;
      title = `${cap(subject)}${agency ? cap(agency) : ""}${dim ? ` By ${cap(dim.label)}` : ""}${spec.time ? ` By ${cap(spec.time)}` : ""}, ${where}, ${tWhen}`; yAxisLabel = unit; break;
    case "share": {
      const n = spec.numerator!;
      const how = n.field === "weapon" ? `were killed with a ${n.label}` : n.field === "relationship" || n.field === "circumstance" ? `were in the category: ${n.label}` : `were ${n.label}`;
      statistic = `The share of these ${unit} that ${how}${per}: the number that ${how} divided by all of them. ${cap(unit.slice(0, 1))}${unit.slice(1)} whose value is unknown stay in the total.`;
      // Owner 2026-10-23: "Share Of Female Homicide Victims Killed With A Firearm, United States, 1976 to 2026 (...)".
      const what = n.field === "weapon" ? `Killed With A ${cap(n.label)}` : `That ${cap(how)}`;
      title = `Share Of ${cap(subject)} ${what}, ${where}, ${tWhen}`; yAxisLabel = "share (%)";
      columnLabels[`numerator_${unit}`] = n.field === "weapon" ? `Killed With A ${cap(n.label)}` : cap(how.replace(/^were /, ""));
      columnLabels[`denominator_${unit}`] = `All ${cap(subject)}`;
      columnLabels.share_pct = "Share (%)";
      // Round 1 Q3 (owner: "a weapon unknown column on the table that I didn't ask for"): the unknown count is not shown in
      // the grid unless the question is about unknowns; it stays in the denominator and in the CSV export. An empty label
      // means "not shown in the grid" (lib/table-display.ts).
      columnLabels[`unknown_value_${unit}`] = /unknown/i.test(n.label) ? `${cap(n.field)} Unknown` : "";
      break;
    }
    case "age":
      statistic = `The ${spec.age} age of these victims${per}, over victims with a recorded age; victims with no recorded age are counted separately.`;
      title = `${cap(spec.age!)} Age Of ${cap(subject)}, ${where}, ${tWhen}`; yAxisLabel = `${spec.age} victim age`; break;
    case "top":
      statistic = `The ${spec.rank!.n === 1 ? "" : `${spec.rank!.n} `}${dim!.label === "city agency" ? "city agencies" : dim!.label === "county" ? "counties" : "states"} with the ${spec.rank!.direction === "desc" ? "most" : "fewest"} ${subject}, ranked by the count of ${unit}. Ties at the cutoff are all shown.` +
        (spec.dimension === "county" ? " Agencies that can't be placed in exactly one county are not ranked." : "");
      title = `${spec.rank!.direction === "desc" ? "Most" : "Fewest"} ${cap(subject)} By ${cap(dim!.label)}, ${where}, ${tWhen}`; yAxisLabel = unit; break;
    case "agency-rate":
      statistic = `${cap(subject)} per 100,000 residents, year by year, using the population the agency recorded on its own homicide reports that year. A year has a rate only when its reports carry exactly one positive population; otherwise it says why there is no rate.`;
      title = `${cap(subject)} Per 100,000 Residents, ${where}, ${tWhen}`; yAxisLabel = "per 100,000 residents"; break;
  }
  return { title, explanation: `${scope}. ${statistic}${union}${th} ${unitNote}`, yAxisLabel, columnLabels };
}

/** Compile and ISSUE a spec. Only an issued, unaltered compilation may run. */
export function compileShrQuestion(input: ShrQuestionSpec): CompiledShrQuestion {
  const spec = deepFreeze(JSON.parse(JSON.stringify(input)) as ShrQuestionSpec);
  const { sql, coverageSql, columns, valueColumn } = compileStatements(spec);
  const labels = placeOf(spec).labels;
  const { title, explanation, yAxisLabel, columnLabels } = describe(spec, labels);
  const dim = dimensionOf(spec);
  // Round 1 D4: a breakdown over time (a dimension AND months or years) charts time across with one series per category;
  // the chart pivots the category into series (baseline P376: age group by month, previously a blank chart).
  const timeAxis = spec.time === "month" ? "month" : spec.time === "year" ? "year" : null;
  const chartType = spec.type === "top" ? "bar" : dim && timeAxis ? "line" : dim ? "bar" : spec.time ? "line" : "none";
  const xAxis = spec.type === "top" ? dim!.column : dim && timeAxis ? timeAxis : dim ? dim.column : timeAxis;
  const compiled = deepFreeze({ spec, sql, coverageSql, columns, valueColumn, title, explanation, chartType, xAxis, yAxisLabel, columnLabels }) as CompiledShrQuestion;
  ISSUED.add(compiled);
  return compiled;
}

export function compiledShrQuestionIssue(compiled: CompiledShrQuestion): string | null {
  if (!ISSUED.has(compiled)) return "not an issued question-type compilation";
  const again = compileStatements(compiled.spec);
  if (again.sql !== compiled.sql || again.coverageSql !== compiled.coverageSql) return "the statement is not what its spec compiles to";
  return null;
}

export function executeCompiledShrQuestion(db: Database.Database, compiled: CompiledShrQuestion): { rows: Record<string, unknown>[]; coverage: { place: string; period: string | number; has_records: number }[] } {
  const issue = compiledShrQuestionIssue(compiled);
  if (issue) throw new Error(`question type refused: ${issue}`);
  return {
    rows: db.prepare(compiled.sql).all() as Record<string, unknown>[],
    coverage: db.prepare(compiled.coverageSql).all() as { place: string; period: string | number; has_records: number }[],
  };
}

/**
 * Result-dependent wording (plan r3.1 R3), from the returned rows and coverage only. `withhold` replaces the answer
 * with a limitation: an agency-type answer whose only figures are zero while unclassified agencies exist.
 */
export function shrQuestionOutcome(db: Database.Database, compiled: CompiledShrQuestion, rows: Record<string, unknown>[], coverage: { place: string; period: string | number; has_records: number }[]):
  { disclosures: string[]; withhold: string | null } {
  const spec = compiled.spec;
  const out: string[] = [];
  const unit = spec.unit;
  const measureWords = spec.measure === "murder" ? "murder" : spec.measure === "manslaughter" ? "negligent manslaughter" : "homicide";
  // Missing constituent places and periods, by name.
  const missing = new Map<string, (string | number)[]>();
  for (const c of coverage) if (!c.has_records) missing.set(c.place, [...(missing.get(c.place) ?? []), c.period]);
  for (const [place, periods] of missing) {
    const list = periods.join(", ");
    out.push(`${place} has no SHR records of any homicide type for ${list}, so ${periods.length === 1 ? "that period is" : "those periods are"} unknown, not zero, and ${spec.type === "count" || (spec.type === "share" && !spec.time) || (spec.type === "age" && !spec.time) ? "not included in the figure" : "shown without a figure"}.`);
  }
  if (coverage.length > 0 && coverage.every((c) => !c.has_records)) out.push("SHR has no records for this place and period, so this is unknown, not zero.");
  if (spec.type === "share") {
    const unknown = rows.reduce((n, r) => n + (Number(r[`unknown_value_${unit}`]) || 0), 0);
    out.push(`${unknown.toLocaleString("en-US")} of the counted ${unit} have an unknown value for the condition, and stay in the total.`);
    if (rows.some((r) => r[`denominator_${unit}`] === 0)) out.push(`Where no ${subjectWords(spec)} are recorded, there is no share to give.`);
  }
  if (spec.type === "age") {
    const unknownAge = rows.reduce((n, r) => n + (Number(r.victims_age_unknown) || 0), 0);
    out.push(`${unknownAge.toLocaleString("en-US")} victim${unknownAge === 1 ? "" : "s"} with no recorded age ${unknownAge === 1 ? "is" : "are"} not included in the age figure.`);
    if (rows.some((r) => r[compiled.valueColumn] == null && (r.shr_records === "no known ages" || (r.shr_records === undefined && Number(r.victims_with_known_age) === 0)))) out.push("Where no victim has a recorded age, there is no age figure.");
  }
  if (spec.type === "agency-rate") {
    // Stage 3b r3 (R3.2'): victims / the one distinct positive population on the agency's own incident rows that year.
    recordWhyFacts({ kind: "rate", method: "shr-agency-annual", per: 100000, places: [...new Set(rows.map((r) => String(r.place ?? "")).filter(Boolean))] });
    const noPop = rows.filter((r) => r.population_status === "no population recorded").map((r) => r.year);
    const conflict = rows.filter((r) => r.population_status === "conflicting population recorded").map((r) => r.year);
    if (noPop.length) out.push(`No population is recorded for ${noPop.join(", ")}, so ${noPop.length === 1 ? "that year has" : "those years have"} no rate. A year with no homicide reports carries no population in this data, so it can't be given a rate of zero.`);
    const noReports = rows.filter((r) => r.population_status === "no population recorded" && r.victims == null).map((r) => r.year);
    if (noReports.length) out.push(`The agency has no homicide reports in this data for ${noReports.join(", ")}.`);
    if (spec.noRateYears.length) out.push(`${spec.noRateYears.join(", ")} is only partly in the source so far, so it has no rate.`);
    if (conflict.length) out.push(`The agency's reports carry more than one population for ${conflict.join(", ")}, so ${conflict.length === 1 ? "that year has" : "those years have"} no rate.`);
  }
  if (spec.type === "count-by" && spec.dimension === "county") out.push(`Agencies that can't be placed in exactly one county are shown as "${UNMAPPED_COUNTY}".`);
  if (spec.filters.some((f) => f.field === "circumstance" && f.predicates.some((p) => p.values.some((v) => /gang/i.test(v))))) out.push("Gang-related circumstances are recorded in SHR but significantly underreported; many agencies classify these as other or unknown.");
  let withhold: string | null = null;
  if (spec.agencyType) {
    const years = spec.periods.map((p) => p.year);
    const states = spec.geo.kind === "states" ? spec.geo.states.map((s) => s.code) : null;
    const scope: ClassScope = { years: [Math.min(...years), Math.max(...years)], states };
    const u = unresolvedInScopes(db, [scope]);
    if (u.agencies > 0) {
      const values = rows.map((r) => r[compiled.valueColumn]).filter((v) => v != null);
      if (spec.agencyType && values.length > 0 && values.every((v) => Number(v) === 0)) withhold = unresolvedLimitation(u, scope);
      else out.push(unresolvedDisclosure(u, scope));
    }
  }
  out.push(`Having SHR records doesn't mean an agency reported every ${measureWords}; not all agencies report SHR data every month or year, so reported counts can understate the actual number.`);
  return { disclosures: out, withhold };
}
