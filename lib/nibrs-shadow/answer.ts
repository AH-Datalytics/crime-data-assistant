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
import { NOT_YET, plainReaderExplanation } from "./wording";
import { DEMOGRAPHIC_RATE, negatedBefore, WHERE_MOST_ONCE } from "../nibrs-request-accounting";
import type { Part, RequestLedger } from "../request-accounting";
import { ALL_CITIES_N, COUNTYWIDE_RE, COURT_TEXT, FORECAST_TEXT, GANG, readQuestion, readingSentence, restoreAgeWords, SHR_WORDS, type Flags } from "./reading";
import { deterministicRewriter, JUDGEMENT, JUDGEMENT_SENTENCE, judgementOffer, pointsBack, standsAlone, type FollowUpRewriter, type Rewrite } from "./follow-up";
import { matchNibrsType, MEASURE_CODES, MEASURE_LABEL, PERSON_CODES, periodOf, placeOf, type MatchOptions, type NPeriod, type NPlace } from "../nibrs-question-types";
import { answerAgencyList, answerPopulation, type PopulationPlace } from "./population";
import { answerStaffing, STAFF_MIXED_TEXT, staffingBesideWords, type StaffKind } from "./staffing";
/** The shadow reads the monthly build: breakdowns by month are answered (coordinator 2026-11-02). */
const SHADOW_MATCH: MatchOptions = { monthlyBreakdowns: true };
import { AGE_BINS, planFromSpec } from "../nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../nibrs-plan/draft-layer";
import { agencyPopulationSql, compilePlan, type CompileTarget } from "../nibrs-plan/compile";
import { splitShadow, withoutShadowComment } from "../nibrs-plan/cube";
import { compare, rankAgencies, rolling, windowMonths, type MonthCell } from "../nibrs-plan/transforms";
import { validateOutcome } from "../nibrs-plan/outcome";
import type { Filter, LimitationReason, NibrsPlan, Place } from "../nibrs-plan/plan";
import { resolvePeriod, type ReleaseInfo } from "../nibrs-plan/resolve";
import { validateBindings } from "../nibrs-plan/validate";
import { clearanceDims, type AnswerStatement } from "../nibrs-plan/result";
import { CATEGORY, deliver, deliverComparison, filterWords, LOSS_CODES, MARIJUANA_LINE, MARIJUANA_WORDS, NIGHT_LINE, ALL_HOMICIDES_LINE, DOMESTIC_VIOLENCE_LINE, DOMESTIC_VIOLENCE_INCIDENTS_LINE, DOMESTIC_VIOLENCE_OFFENSES_LINE, DOMESTIC_VIOLENCE_ARRESTS_LINE, OFFENSES_NOT_VICTIMS_LINE, PERSON_CRIMES_LINE, PROPERTY_AGE_LINE, TIME_OF_DAY_LINE, measureWords, monthName, periodWords, PROPERTY_CODES, type Combined, type Delivered } from "./deliver";
import { agencyInState, agencyLabel, agencyName, candidateLabel, nearestPlaceName, reportedBy, resolvePlace, stateCodeOf, stateName, STATE_NAMES, type Agency, type Candidate, type PlaceIndex, type PlaceResolution } from "./places";
import { answerPlaces } from "./places-answer";
import { answerSrs, answerSrsPeak, answerSrsSeveral, isSrsMeasure, SRS_YEARS, type SrsAnswer, type SrsPlace } from "./srs";
import { missingGroupings } from "./named-groupings";
import type { OfferRole, SourceId } from "../answer-contract/contract";
import { HISTORICAL_MEASURE, answerBeside, answerCountywide, answerHistorical, answerHistoricalPosition, answerHistoricalRanking, answerHistoricalRegion, answerHistoricalSet, answerHistoricalStatesByYear, COUNTYWIDE_FIRST_YEAR, type BesidePlace, historicalCounts, historicalUnitFits, isHistoricalMeasure, type HistoricalAnswer, type HistoricalBuild } from "./historical";
import { answerStateMulti } from "./state-multi";
import { agencyHeaderSql, answerStateSum, universeStates, type StateSumMeta } from "./state-sum";
import { answerStateSet } from "./state-set";
import { answerCurrentClearance, answerStateClearanceRanking, answerStateClearanceSeries } from "./clearance-current";
import { answerClearanceShare } from "./clearance-share";
import { answerClearanceTypePlaces } from "./clearance-places";
import { COMPOSITE_PARTS, composeCrimeOverTime } from "./crime-over-time";
import { buildScorecard, type ScorecardPlace } from "./scorecard";
import { detectAgencyScorecardQuestion } from "../scorecard-format";
import { shiftMonth, answerCurrentRolling, firstFullJanuary, answerCurrent, answerCurrentChange, answerCurrentSeveral, answerCurrentRanking, CURRENT_MEASURE, REGIONS, type CurrentAnswer, type CurrentBuild, type CurrentPlace } from "./current";
import { answerHate, combineHatePlaces, HATE_FIRST_YEAR, hateQuestionOf, notIncluded, type HateAnswer, type HateBuild, type HateQuestion } from "./hate";
import { answerCoverage, readCoverage, type CoverageAnswer } from "./coverage";
import { seriesTitle } from "./headline";
import { titleCase } from "./titles";
import { answerShr, answerShrRanking, SHR_FIRST_YEAR, shrQuestionOf, type ShrAnswer, type ShrBuild, type ShrFilter, type ShrQuestion } from "./shr";

export type ShadowDeps = {
  places: PlaceIndex;
  release: ReleaseInfo & { id: string; asOf: string };
  target: CompileTarget;
  /** Runs one SQL statement read-only and returns its rows. */
  execute(sql: string): unknown[][];
  /** The Crime Index build (scripts/build-crimeindex.py): with it, agencies' Part I questions are Historical's answers; without it, routed. */
  historical?: HistoricalBuild;
  /** The Crime Index build's Current Trends tables (current.ts): with them, Part I questions by month are Current Trends' answers. */
  current?: CurrentBuild;
  /** The SHR release (shr.ts): with it, murder details are Homicide Reports' answers (Jeff S1, 2026-11-11); without it, routed. */
  shr?: ShrBuild;
  /** The hate crime export (hate.ts): with it, hate crime questions are answered from it; without it they are declined. Never NIBRS. */
  hate?: HateBuild;
  /** Set while a ranking of cities by a clearance share is answered (cityClearanceShare): the minimum offenses (null: the 250,000+ floor), the cut and the direction. */
  cityShare?: { minOffenses: number | null; limit: number | null; direction: "top" | "bottom"; all?: boolean; note?: string };
  /** The question as the user asked it, set while it is answered (the county-wide decline offers it without the county-wide words). */
  asked?: string;
  /** The question as typed asked for shares of the clearance types (the reader rewrites the question and loses the percentage words). */
  shareAsked?: boolean;
  /** Set while checking that an offered question answers (offerable): its own declines get no next step of their own. */
  checkingOffer?: boolean;
  /** The places already chosen from a button, by the place's own words (lower case): the same-months years ask each year's question without asking the place again (P22). */
  placePins?: Map<string, Candidate>;
  /** Set by the tests of the asks themselves: no default (P180 to P182) fills a missing place, period or kind of crime; the question is asked as before. */
  noDefaults?: boolean;
  /** Set while a follow-up is answered from a rewrite or as its own question: the words the user typed and the previous question, which the
   *  default guards read too (a rewrite drops "compare with"; "Durham and population" leans on a NIBRS-only question before it). */
  guardText?: string;
  /** Set on a question the bare-assault or shootings rewrite made: it is not rewritten again. */
  rewritten?: boolean;
  /** Set while a bare-assault question goes on as asked: the bare-assault rule steps aside. */
  assaultAsked?: boolean;
  /** How many buttons in a row were rebuilt from the user's words: past three, a button's own buttons are left as built. */
  rebuilt?: number;
  /** A statement longer than this many characters is a heavy national statement (default 250,000, HEAVY_STATEMENT: a national inline list of ~20,000 agencies is over 1,000,000); see deferHeavy. */
  deferChars?: number;
};

export type ShadowOption = {
  label: string;
  /** A fixed question: its continuation. An entry ("Another year"): what it asks next. */
  continuation?: ShadowOutcome;
  entry?: string;
  /** A reading answered by another source (P01): this NIBRS shadow does not run it. */
  otherSource?: string;
  /** P74: a complete question, shown on the button and run as a new question only when chosen (never before). */
  question?: string;
  /**
   * The answer contract (lib/answer-contract): what the button is for, and the source it runs on, when its creator
   * knows them; otherwise taken from its shape and its continuation (presentation.ts).
   */
  role?: OfferRole;
  targetSource?: SourceId;
};

/**
 * P74: the question without the parts the reader couldn't use, offered as "Ask instead: <question>" when the reader
 * reads all of it as a complete question. Only the reader decides (no data is read); the exact spans are removed; the
 * revised question is shown whole on the button and runs only when chosen (Codex plain-wording design check 2).
 */
const BELOW_AGENCY_WORD = /\b(?:districts?|neighbou?rhoods?|wards?|beats?|precincts?|zip\s*codes?|subdivisions?|blocks?)\b/i;
const MONTH_NAMES = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DATE_AFTER = new RegExp(`^\\s*(?:in|on|at|for|during)?\\s*${MONTH_NAMES}\\.?\\s+(?:\\d{1,2},?\\s+)?(?:19|20)\\d\\d\\b`, "i");
function askInstead(question: string, parts: Part[], year: number): ShadowOption | null {
  const spans = parts.filter((p) => p.span && p.span[1] > p.span[0] && question.slice(p.span[0], p.span[1]).trim() === p.text.trim()).map((p) => p.span).sort((a, b) => b[0] - a[0]);
  if (!spans.length || spans.length !== parts.length) return null;
  // Words that name a place smaller than an agency ("garden district") are not filler: without them the question is about another place.
  if (spans.some(([a, b]) => BELOW_AGENCY_WORD.test(question.slice(a, b)))) return null;
  let t = question;
  // A linking word the unread words ended with stays ("rolling over 12 months in" leaves "in": "murders in Detroit").
  for (const [a, b] of spans) {
    // "with an annotation in May 2020": the date belongs to the words cut ("with ..."), so it goes with them (not a period asked).
    const dated = /^(?:with|plus|including)\b/i.test(question.slice(a, b).trim()) ? DATE_AFTER.exec(question.slice(b)) : null;
    t = `${t.slice(0, a)} ${/\b(in|for|of|from|during)\s*$/i.exec(question.slice(a, b))?.[1] ?? ""} ${t.slice(b + (dated ? dated[0].length : 0))}`;
  }
  t = t.replace(/\s+([,?.!])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
  // A joining word left dangling by the removal goes too ("in 2024 and in 2025" without "in 2025").
  t = t.replace(/\s+(?:and|or)(?=\s*[?.!]?$)/i, "").replace(/\s+(?:and|or)\s+(?:and|or)\s+/gi, " and ")
    .replace(/\b(of|in|for|from|during)\s+(?:and|or)\s+/gi, "$1 ").trim();
  if (!t || t.toLowerCase() === question.trim().toLowerCase()) return null;
  const r = readQuestion(t, year);
  if (r.ledger.parts.some((p) => p.concept === "unrecognized" || p.state === "not-recorded") || matchNibrsType(r.ledger, SHADOW_MATCH).kind !== "spec") return null;
  return { label: `Ask instead: "${t}"`, question: t };
}
/** A question the reader reads completely, every word, as a complete question (no data is read). */
function readsWhole(t: string, year: number): boolean {
  const r = readQuestion(t, year);
  return !r.ledger.parts.some((p) => p.concept === "unrecognized" || p.state === "not-recorded") && matchNibrsType(r.ledger, SHADOW_MATCH).kind === "spec";
}
const tidy = (t: string) => t.replace(/\s+([,?.!])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
/** The conditions the reader sets aside from its text (clearance, people, property...): a button must keep them. */
const CONDITIONS = ["clearance", "people", "property", "arrestsThrough", "consistent", "offenders", "composite", "quarter", "combined",
  "largeCities", "allCities", "largestSet", "countywide", "last12", "nibrsAsked", "shrAsked", "shrDetail", "court", "forecast", "undefinedTerm"] as const;
/**
 * A button's question that reads whole and keeps every condition of the question asked, but the ones the step changes
 * on purpose (Codex decline review 01: a period button that dropped "that were cleared").
 */
function keeps(t: string, asked: string, year: number, except: (typeof CONDITIONS)[number][] = []): boolean {
  if (!readsWhole(t, year)) return false;
  const a = readQuestion(asked, year), b = readQuestion(t, year);
  return CONDITIONS.every((k) => except.includes(k) || JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null));
}
/** A plain example of a question that works, for a decline with no button (Jeff's rule: every decline a next step). */
export const EXAMPLE = "For example: \"robberies in Denver in 2024\".";
/** Asks outside the data (Historical step one, cause 7), first match wins: [words, only when no crime is named, the limit said plainly]. */
/** Asks about how the data is built or what it holds that no table answers (Jeff 2026-11-23): one plain sentence, whatever crime is named. */
const DATA_ABSENT = /\buse\s+of\s+force\b|\bnibrs[\s-]+compliant\b|\bunweighted\b|\bhierarchy\s+rule\b|\bwhy\b[^?]*\bdata\b[^?]*\b(?:go|goes|start|starts|begin|begins)\s+back\b/i;
const DATA_ABSENT_TEXT = "That data is not available.";
/** Jeff 2026-11-24: misdemeanor/felony arrests (NIBRS does not record the class of an arrest) and a national overall/violent rate by month (national rates are annual, from Historical). */
const MISDEMEANOR_ARREST = /\b(?:misdemeanou?rs?|felony|felonies)\s+arrests?\b|\barrests?\s+(?:for|of|as)\s+(?:a\s+)?(?:misdemeanou?rs?|felony|felonies)\b/i;
const DAILY_WORDS = /\bper\s+day\b|\beach\s+day\b|\bby\s+(?:the\s+)?day\b|\bday[-\s]by[-\s]day\b|\bdaily\b/i;
const MISDEMEANOR_TEXT ="That data is not available. NIBRS does not record whether an arrest was a felony or a misdemeanor.";
const NATIONAL_MONTHLY_RATE = /\b(?:national|nationwide|united\s+states|u\.?s\.?)\b[^?]*\bcrime\s+rates?\b[^?]*\b(?:monthly|by\s+month|each\s+month|per\s+month)\b|\bcrime\s+rates?\b[^?]*\b(?:in|for|across|of)\s+(?:the\s+)?(?:united\s+states|u\.?s\.?a?\.?|nation|country)\b[^?]*\b(?:monthly|by\s+month|each\s+month|per\s+month)\b|\b(?:monthly|by\s+month|each\s+month|per\s+month)\b[^?]*\b(?:national|nationwide)\b[^?]*\bcrime\s+rates?\b|\b(?:monthly|by\s+month|each\s+month|per\s+month)\b[^?]*\bcrime\s+rates?\b[^?]*\b(?:in|for|across|of)\s+(?:the\s+)?(?:united\s+states|u\.?s\.?a?\.?|nation|country)\b/i;
const OUTSIDE: [RegExp, boolean, string][] = [
  [/\bon\s+a\s+map\b|\bmaps?\s+of\b/i, false, "Maps aren't available here; answers come as tables and charts."],
  [/\bcampus(?:es)?\b/i, false, "College and university police agencies aren't among the places here."],
  [/\bcyber\s*-?\s*crimes?\b/i, false, "Cybercrime isn't one category in this data: hacking/computer invasion and several kinds of fraud are separate crimes in NIBRS."],
  [/\b(?:list|lists)\s+of\b[^?]*\bagencies\b|\bagency\s+coverage\b|\bwhich\s+agencies\s+report/i, true, "A list of agencies, or of the years an agency reported, isn't available here."],
  // Item 11: population on its own is answered for agencies, states and the nation, by year; anything more is said.
  [/\bpopulations?\b/i, true, "Population is answered on its own for an agency, a state or the nation, a year or by year, as Crime Index publishes it; this question asks for more than that."],
  [/\bdata\s*-?\s*sets?\b|\braw\s+data\b|\bdownload\b/i, false, "A whole data set isn't available here; ask for one crime in one place at a time."],
  // Jeff 2026-11-23 (declines owner, Group 2): how the data is built, or what it holds that no table answers, gets one plain sentence.
  [DATA_ABSENT, false, DATA_ABSENT_TEXT],
];

/**
 * Jeff's rule (coordinator, 2026-11-01): every decline offers a concrete next step, a button where one is possible and
 * otherwise an example that works. Applied to a decline that has no button yet, in this order; each button's question
 * is read completely by the reader first (no data is read) and runs only when chosen:
 *   - two periods ("in 2024 and in 2025"): a question back, one button per period, each the question with that period;
 *   - a ranking by a change ("the biggest increase in"): the ranking by the numbers ("the most");
 *   - otherwise the simplest form of the question: its crime, its place and its period (or the latest complete year);
 *   - and when no button reads, an example in the text.
 */
function withNextStep(o: ShadowOutcome, ledger: RequestLedger, deps: ShadowDeps, asked: string): ShadowOutcome {
  // A decline outside the data with no button of its own still gets the nearest question (coordinator 2026-11-02).
  if (o.kind !== "decline" || (o.notBuilt && o.alternative) || deps.checkingOffer) return o;
  // Officers killed and assaulted: Jeff's plain decline, no extra notes (2026-11-05).
  if (o.explanation.startsWith("We don't have LEOKA data")) return { ...o, alternative: null };
  const year = Number(deps.release.lastMonth.slice(0, 4));
  // Jeff (2026-11-01): an offered question must actually answer, and keep every place and crime the user named
  // ("chicago vs memphis carjackings per year since 2022" was offered "chicago memphis carjackings ..."). It is run
  // (its own declines get no next step), and its places and crimes compared with the question's; otherwise no button,
  // the example only.
  const named = (q: string) => {
    const parts = readQuestion(q, year).ledger.parts.filter((p) => p.clause === 0 && p.state === "recognized" && (p.concept === "place" || p.concept === "measure"));
    return new Set(parts.map((p) => `${p.concept}:${String(p.value ?? p.text).toLowerCase()}`));
  };
  const asks = named(asked);
  // A condition read out of the words (a circumstance, a region) is kept too (Codex circumstance review 01.1: the offered
  // question had dropped "gang-related" and counted 12,890 victims for 14).
  const kept = (q: string) => { const r = readQuestion(q, year); return JSON.stringify([r.circumstance, r.region]); };
  const offerable = (q: string | undefined) => {
    if (!q) return true;
    const got = named(q);
    if (![...asks].every((x) => got.has(x))) return false;
    if (kept(q) !== kept(asked)) return false;
    const r = shadowAnswer(q, { ...deps, checkingOffer: true });
    return r.kind === "answer" || r.kind === "historical" || r.kind === "srs" || r.kind === "current" || r.kind === "shr" || r.kind === "hate" || r.kind === "coverage";
  };
  const question = ledger.question;
  const own = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const periods = own.filter((p) => p.concept === "period" && p.span);
  // Each button is built from the words asked (the reader's text has set aside conditions such as "that were cleared").
  const said = asked.trim();
  const at = periods.map((p) => ({ p, i: said.toLowerCase().indexOf(p.text.trim().toLowerCase()), n: p.text.trim().length }));
  if (periods.length > 1 && /would be a second one/.test(o.explanation) && at.every((x) => x.i >= 0)) {
    const options = at.map((keep) => {
      let t = said;
      // Each other period goes with the "and"/"or" that joined it, on whichever side.
      for (const x of at.filter((y) => y !== keep).sort((a, b) => b.i - a.i)) {
        const left = t.slice(0, x.i), right = t.slice(x.i + x.n);
        t = /,?\s(?:and|or)\s*$/i.test(left) ? `${left.replace(/,?\s(?:and|or)\s*$/i, " ")}${right}` : `${left} ${right.replace(/^\s*,?\s*(?:and|or)\b/i, "")}`;
      }
      t = tidy(t);
      return keeps(t, said, year) ? { label: `"${t}"`, question: t } : null;
    });
    if (options.every(Boolean)) return { kind: "clarify", about: "which period", question, options: options as ShadowOption[] };
  }
  // P83 (Jeff 2026-11-01): gun violence stays declined (P31), with the same question as gun crime offered, every
  // condition kept (Codex coverage review 01.1: a cohort, "that were cleared", "by quarter").
  if (o.explanation === UNDEFINED_TERM["gun violence"]) {
    const gun = tidy(said.replace(/\bgun\s+violence\b/i, (m) => (/^G/.test(m) ? "Gun crime" : "gun crime")).replace(/[?.!]+$/, ""));
    if (gun !== tidy(said.replace(/[?.!]+$/, "")) && keeps(gun, said, year, ["undefinedTerm", "composite"]) && offerable(gun)) return { ...o, alternative: { label: `Ask instead: "${gun}"`, question: gun } };
  }
  // P38 (Jeff 2026-11-09): gang wording is declined and the reason said. The next step is the same question without the
  // gang words, only where they qualify a crime named ("gang-related murders" -> murders) and it answers; otherwise the
  // usual example below (every decline a next step).
  if (o.explanation === UNDEFINED_TERM.gang) {
    const plain = tidy(said.replace(/\b(?:gang[-\s]?(?:related|involved|motivated)|gangland|gang)\s+(?=(?:murder|homicide|killing|aggravated|assault|robber))/gi, "").replace(/[?.!]+$/, ""));
    const ok = !/\bgang/i.test(plain) && [...asks].some((x) => x.startsWith("measure:")) && keeps(plain, said, year, ["undefinedTerm"]) && offerable(plain);
    if (ok) return { ...o, alternative: { label: `Ask instead: "${plain}"`, question: plain } };
  }
  const level = said.replace(/\b(?:the\s+)?(?:biggest|largest|greatest|highest|most|steepest|sharpest)\s+(?:increases?|decreases?|rises?|drops?|declines?|changes?|jumps?|growth|falls?)\s+in\b/i, "the most");
  if (level !== said && keeps(level, said, year) && offerable(tidy(level))) return { ...o, alternative: { label: `Ask instead: "${tidy(level)}"`, question: tidy(level) } };
  // The nearest question that works (coordinator, 2026-11-01), the user's breakdown kept:
  //   - "cleared" read into the crime's name ("homicide victims cleared in Memphis"): the same question "that were cleared";
  //   - victims by weapon (a weapon is recorded for each offense): the same question about offenses.
  const nearest = (alt: string, explanation: string, except: (typeof CONDITIONS)[number][] = []) =>
    keeps(alt, said, year, except) && offerable(alt) ? { ...o, explanation, alternative: { label: `Ask instead: "${alt}"`, question: alt } } : null;
  const cleared = /_cleared" has no executable definition|does not apply "victims"/.test(o.detail ?? "") && /\bcleared\b/i.test(said)
    && !/\bwere cleared\b/i.test(said)
    ? nearest(tidy(`${said.replace(/\s+cleared\b/i, "").replace(/[?.!]+$/, "")} that were cleared`), "I couldn't read \"cleared\" there. Put \"that were cleared\" at the end instead.", ["clearance"]) : null;
  if (cleared) return cleared;
  const byWeapon = /group victim by offense_weapon/.test(o.detail ?? "") && /\bvictims?\b/i.test(said)
    ? nearest(tidy(said.replace(/\bvictim(s?)\b/i, (_m, s: string) => `offense${s}`)), "Weapons are recorded for each offense, not for each victim, so victims can't be counted by weapon. Offenses can be.")
    : null;
  if (byWeapon) return byWeapon;
  // The two specific steps above come first; a button the decline already has (the question without the words the
  // reader couldn't use) is kept over the generic ones below.
  if (o.alternative && offerable(o.alternative.question)) return o;
  if (o.alternative) o = { ...o, alternative: null };
  const text =(c: string) => own.find((p) => p.concept === c && p.state === "recognized")?.text.trim();
  // The nation in words a question can take after "in": "nationwide", "the whole country" (Historical step one: an
  // example read "robberies in nationwide in 2025").
  const placePart = own.find((p) => p.concept === "place" && p.state === "recognized");
  const measure = text("measure"), place = placePart?.value === "national" ? "the United States" : placePart?.text.trim();
  // The simple forms below are built from the crime and the place only. When the crime is only the one the unit implies ("nationwide
  // arrests": every crime), dropping the unit changes the question: "All crime in the United States by year" (crimes, not arrests)
  // was offered once crime over time answered it.
  const unitOnly = !!text("unit") && /^(?:all_crime|unspecified)$/.test(String(own.find((p) => p.concept === "measure" && p.state === "recognized")?.value ?? ""));
  if (measure && place && !unitOnly) {
    const period = text("period") ?? `in ${Number(deps.release.lastMonth.slice(0, 4)) - (deps.release.lastMonth.endsWith("-12") ? 0 : 1)}`;
    // The nearest question for the same place and crime (coordinator 2026-11-02): as asked with only its period, then
    // the place's whole series by year, then from the first year the data holds (a period before it, asked of NIBRS).
    // Compared with what the user typed (the reader's text may have dropped words).
    const candidates = [tidy(`${measure} in ${place} ${/^(?:in|from|since|during)\b/i.test(period) ? period : `in ${period}`}`), tidy(`${measure} in ${place} by year`),
      tidy(`${measure} in ${place} since ${deps.release.firstMonth.slice(0, 4)}`)];
    for (const simple of candidates)
      if (simple.toLowerCase() !== asked.trim().replace(/[?.!]+$/, "").toLowerCase() && readsWhole(simple, year) && offerable(simple))
        return { ...o, alternative: { label: `Ask instead: "${simple}"`, question: simple } };
  }
  // No question that runs keeps both: an example that works for what the question did name (its place, else its crime),
  // never an unrelated one; the generic example only when it named neither (Jeff's rule: every decline a next step).
  if (/\bfor example\b/i.test(o.explanation) || o.explanation === DATA_ABSENT_TEXT) return o;
  const lastYear = Number(deps.release.lastMonth.slice(0, 4)) - (deps.release.lastMonth.endsWith("-12") ? 0 : 1);
  const answers = (q: string) => { const r = shadowAnswer(q, { ...deps, checkingOffer: true }); return r.kind === "answer" || r.kind === "historical" || r.kind === "srs" || r.kind === "current" || r.kind === "shr" || r.kind === "hate" || r.kind === "coverage"; };
  const related = [...(place ? [`robberies in ${place} in ${lastYear}`] : []), ...(measure ? [`${measure} in Denver in ${lastYear}`] : [])]
    .map(tidy).find((q) => readsWhole(q, year) && answers(q));
  return { ...o, explanation: `${o.explanation} ${related ? `For example: "${related}".` : EXAMPLE}` };
}
export type ShadowOutcome =
  /** `buttons`: continuations offered beside the answer (P61's consistent-reporters view). */
  | { kind: "answer"; plan: NibrsPlan; period: { from: string; to: string }; sql: string; delivered: Delivered; buttons?: ShadowOption[];
    /** A state or national sum (P61): agencies counted, coverage and the every-month view, per year (state-sum.ts). */
    stateSum?: StateSumMeta;
    /** Several crimes in one table (P271): each crime's own record, in column order (its agencies and coverage differ). `stateSum` is set only when they are all the same. */
    stateSums?: StateSumMeta[] }
  /** A Part I figure for a state or the nation, read from the historical file (P53; srs.ts). */
  | SrsAnswer
  /** A Part I figure for one or several agencies, read from the Crime Index build (Historical, P75-P79; historical.ts). */
  | HistoricalAnswer
  /** A Part I figure by month for an agency, a state, a region or the nation, from Current Trends (current.ts). */
  | CurrentAnswer
  /** Murder by a detail (weapon, relationship, circumstance, a person's sex, race, ethnicity or age) from Homicide Reports (shr.ts). */
  | ShrAnswer
  /** Hate crime incidents from the hate crime data (hate.ts), never from NIBRS. */
  | HateAnswer
  /** A question about the data itself: agencies reporting, states with no data, years covered, sources, definitions (coverage.ts). */
  | CoverageAnswer
  /** A question another source answers (P53): the route is named; this NIBRS shadow does not run it. */
  | { kind: "route"; source: "rtci" | "shr" | "historical"; explanation: string }
  | { kind: "clarify"; about: string; question: string; options: ShadowOption[]; /** Said with the ask (what the choices leave out). */ note?: string }
  /** `detail`: an internal diagnostic (a compiler or validation reason) for logs; never shown (P74). */
  | { kind: "decline"; reason: LimitationReason | "reader"; explanation: string; alternative: ShadowOption | null; notBuilt?: boolean; detail?: string;
    /** Further buttons after `alternative` (a monthly rate: the rate for the whole period, then the counts by month). */
    more?: ShadowOption[] };

/** NIBRS Group A offenses whose crime-against category is property (robbery, and so carjacking, included). */
const CRIMES_AGAINST_PROPERTY = new Set(["120", "200", "210", "220", "23A", "23B", "23C", "23D", "23E", "23F", "23G", "23H", "240", "250",
  "26A", "26B", "26C", "26D", "26E", "26F", "26G", "26H", "270", "280", "290", "510"]);

const decline = (reason: LimitationReason | "reader", explanation: string, extra: { alternative?: ShadowOption | null; notBuilt?: boolean; detail?: string } = {}): ShadowOutcome =>
  ({ kind: "decline", reason, explanation, alternative: extra.alternative ?? null, ...(extra.notBuilt ? { notBuilt: true } : {}), ...(extra.detail ? { detail: extra.detail } : {}) });
const notYet = (detail: string) => decline("unsupported_capability", NOT_YET, { detail });

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

/** Several parts of one concept filled by one button ("Both": violent and property crime). */
function filledAll(ledger: RequestLedger, concept: string, values: string[][]): RequestLedger {
  return values.reduce<RequestLedger>((l, [value, text], i) => {
    const n = l.question.length + 1 + l.parts.filter((p) => p.rule === "shadow:button").length;
    const part = { concept, value, span: [n, n], text, explains: [[n, n]], clause: 0, rule: "shadow:button", state: "recognized", explanation: null } as unknown as Part;
    return withParts(l, [...l.parts.filter((p) => !(p.clause === 0 && p.concept === concept && (i === 0 || p.rule !== "shadow:button"))), part]);
  }, ledger);
}
/**
 * A national breakdown by a person's attribute over several years that takes minutes to count (runner, 2026-11-16): declined up front.
 * Jeff 2026-11-16: decline, no pointer elsewhere ("We should decline and try to make it work later"); the question stays a feature
 * to build (offenders by age group from the first NIBRS year to the latest), kept with the logged ones in
 * docs/reports/heavy-national-backlog.md. The wording is the older guards' pattern.
 */
export const heavyNationalSentence = (crime: string, by: string, lastYear: string | number): string =>
  `This isn't available: ${crime} in the United States broken down by ${by} over several years takes too long to count here. Ask for one year, for example "nationwide ${crime} by ${by} in ${lastYear}", or for one state.`;
/** A button's continuation that runs now: not a decline, and not a route to a source not loaded here (Current Trends). */
const runsNow = (o: ShadowOutcome) => o.kind !== "decline" && o.kind !== "route";

/**
 * Heavy national continuations are built when chosen, not before (coordinator 2026-11-17, speed plan option C). An ask's options each carry
 * their answer so that no button is dead (P22), but a national statement takes minutes (QL-shr-349398af53: 300 s of statements before its
 * "which place" ask was shown). The option is built once against a probe whose executor refuses a heavy statement: reaching one proves the plan
 * got through reading, validation and every guard (a guard-declined plan never reaches SQL, so it is dropped as a dead button as before); then
 * the button keeps a lazy `continuation` that builds the real answer on first read and remembers it. Nothing else changes: every answer, ask and
 * decline is the same; only when the heavy statements run.
 */
/**
 * A statement is heavy past this many characters. The size is almost all agency literals (about 52 characters each, 6,000 of fixed text): the
 * biggest single state listed is Pennsylvania with 2,001 agencies (about 110,000 characters), and all of Texas (1,847 listed) sat within 0-3% of
 * the old 100,000 limit, so a state could tip over it on one more agency. A national statement lists about 20,000 agencies (over 1,000,000
 * characters). 250,000 clears every single state by more than double and still defers every national statement by four times.
 */
export const HEAVY_STATEMENT = 250_000;
const DEFERRED = new WeakSet<object>();
/** A button whose answer is built when first read (the walkers that only decide whether a button runs must not read it). */
export const isDeferred = (x: ShadowOption): boolean => DEFERRED.has(x);
class HeavyStatement extends Error {}
/**
 * The size a statement is judged by. A shadow-mode statement is the cube's SQL and the raw SQL stuck together (cube.ts shadowSql), but the
 * executor runs them one after the other, so the biggest one that runs is the longer part, not their sum. Judged by the sum, a long agency
 * list (all of Texas) crossed the limit in shadow mode only and "DUI arrests by race in Texas" asked "which period" there while it answered
 * with the cube on (QL-nibrs-72eb2ad905). A plain statement is measured as before.
 */
export const statementChars = (sql: string): number => { const s = splitShadow(sql); return s ? Math.max(s.raw.length, s.cube.length) : withoutShadowComment(sql).length; };
function deferHeavy(label: string, build: (d: ShadowDeps) => ShadowOutcome, deps: ShadowDeps, extra: Partial<ShadowOption> = {}): ShadowOption {
  let heavy = false;
  const limit = deps.deferChars ?? HEAVY_STATEMENT;
  const probe: ShadowDeps = { ...deps, execute: (sql: string) => { if (statementChars(sql) > limit) { heavy = true; throw new HeavyStatement(); } return deps.execute(sql); } };
  let first: ShadowOutcome | null = null;
  try { first = build(probe); } catch (e) { if (!(e instanceof HeavyStatement)) throw e; }
  if (!heavy) return { label, continuation: first!, ...extra };
  // Something between the executor and here swallowed the refusal and made an outcome of it: not a plan that reached its statement; built for real.
  if (first) return { label, continuation: build(deps), ...extra };
  let memo: ShadowOutcome | null = null;
  const option = { label, targetSource: "nibrs" as const, ...extra } as ShadowOption;
  // Not enumerable: serializing an outcome (JSON.stringify, a spread) must not build it; the walkers that copy options go through mapOption.
  Object.defineProperty(option, "continuation", { enumerable: false, configurable: true, get: () => {
    if (memo) return memo;
    // Never throws: whoever reads it (a clicked button, or a walker that visits every property) gets an outcome; a failure is a plain decline.
    try { memo = build(deps); } catch (e) { memo = decline("reader", NOT_YET, { detail: `deferred answer failed: ${e instanceof Error ? e.message : String(e)}` }); }
    return memo;
  } });
  DEFERRED.add(option);
  return option;
}
/**
 * An option with its continuation passed through `f`; a deferred one stays deferred (`f` runs when its answer is first read), so a check or
 * rewrite that every option goes through (everyBreakdown, the bare-assault rebuild) does not build the heavy answer early. Its other fields
 * are copied by name: spreading it would read the lazy answer.
 */
function mapOption(x: ShadowOption, f: (c: ShadowOutcome) => ShadowOutcome): ShadowOption {
  if (!isDeferred(x)) return x.continuation ? { ...x, continuation: f(x.continuation) } : x;
  let memo: ShadowOutcome | null = null;
  const copy: Record<string, unknown> = {};
  for (const k of Object.keys(x)) if (k !== "continuation") copy[k] = (x as unknown as Record<string, unknown>)[k];
  const option = copy as unknown as ShadowOption;
  Object.defineProperty(option, "continuation", { enumerable: false, configurable: true, get: () => (memo ??= f(x.continuation!)) });
  DEFERRED.add(option);
  return option;
}
/** An option that runs: a deferred one (it reached its heavy statement), or one whose continuation runs. */
const optionRuns = (o: ShadowOption) => isDeferred(o) || (!!o.continuation && runsNow(o.continuation));
/**
 * P170 to P172 (Jeff 2026-11-21): a missing place, period or kind of crime is filled with its default, said, with buttons to change it. The
 * option's answer is used only when it exists now (a heavy national statement is deferred, a decline is not an answer): otherwise null, and the
 * question is asked as before. The note goes right after the title or sentence.
 */
/** Why a default could not answer (a measurement for the census, never read by the engine): the ask site and the reason. */
export const DEFAULT_MISSES: { site: string; why: string }[] = [];
function withDefault(o: ShadowOption, note: string, buttons: ShadowOption[], site = ""): ShadowOutcome | null {
  if (isDeferred(o) || !o.continuation) { DEFAULT_MISSES.push({ site, why: "heavy" }); return null; }
  const r = o.continuation;
  if (!["answer", "srs", "historical", "current", "shr", "hate"].includes(r.kind)) {
    DEFAULT_MISSES.push({ site, why: `${r.kind}:${"reason" in r ? r.reason : "about" in r ? r.about : ""}` });
    return null;
  }
  const x = r as ShadowOutcome & { delivered: { text: string[] }; buttons?: ShadowOption[] };
  const text = [x.delivered.text[0], ...(note ? [note] : []), ...x.delivered.text.slice(1)];
  return { ...x, delivered: { ...x.delivered, text }, buttons: [...(x.buttons ?? []), ...buttons] } as ShadowOutcome;
}
/** Jeff 2026-11-14: the shootings ask, as the user reads it. */
const SHOOTING_ASK = "We don't track non-fatal shootings. You can choose firearm murders or aggravated assault involving a firearm (NIBRS).";
/**
 * The outcome kept to Homicide Reports (Jeff 2026-11-14: a button named SHR never answers from another source): an SHR answer as it
 * is; a question whose choices lead to one, with the choices that lead elsewhere taken out (a typed entry stays); otherwise none.
 */
const onlyHomicideReports = (o: ShadowOutcome, depth = 0): ShadowOutcome | null => {
  if (o.kind === "shr") return o;
  if (o.kind !== "clarify" || depth >= 3) return null;
  const options = o.options.flatMap((x) => {
    // A deferred choice is a heavy NIBRS statement: never Homicide Reports', so it goes, unbuilt.
    if (isDeferred(x)) return [];
    if (!x.continuation) return [x];
    const kept = onlyHomicideReports(x.continuation, depth + 1);
    return kept ? [{ ...x, continuation: kept }] : [];
  });
  return options.some((x) => x.continuation) ? { ...o, options } : null;
};
/**
 * A whole-years version of a question finer than years, run now (its button never dead-ends). Never nested: a
 * question still finer than years once by year (rolling windows) gets no alternative (Codex routing review 01.1).
 */
let inByYear = false;
function byYearInstead(ledger: RequestLedger, deps: ShadowDeps, pins: Map<number, Candidate>): ShadowOption | null {
  if (inByYear) return null;
  inByYear = true;
  try {
    const o = fromLedger(filled(ledger, "grain", "year", "by year"), deps, pins);
    return runsNow(o) ? { label: "By year instead", continuation: o, role: "by_year" } : null;
  } finally { inByYear = false; }
}

/**
 * A monthly question for one agency that reaches back before any monthly source (Jeff 2026-11-14, "Kansas City robberies per
 * month since 1960"): no single source has monthly figures back that far, so the choices that exist for that agency are
 * offered, yearly first: yearly from the start year (Crime Index), monthly from Current Trends' first month (when the
 * agency is in Current Trends), monthly from the agency's first NIBRS month. Each runs the same question on that source.
 * One choice left answers with it and says why. Null when none runs (the plain decline stands).
 */
let inSpanChoices = false;
function spanChoices(a: { ledger: RequestLedger; deps: ShadowDeps; pins: Map<number, Candidate>; agency: string; ori: string; startYear: number; startMonth: string; endMonth: string; ct?: { first: string; last: string } }): ShadowOutcome | null {
  if (inSpanChoices) return null;
  inSpanChoices = true;
  try {
    const { ledger, deps, pins, agency, ori, startYear } = a;
    const hb = deps.historical, rel = deps.release;
    type Choice = { label: string; kind: "yearly" | "hr" | "current" | "nibrs"; from: string; out: ShadowOutcome };
    const sourceName = (k: Choice["kind"]) => (k === "hr" ? "Homicide Reports" : k === "current" ? "Current Trends" : k === "nibrs" ? "NIBRS" : "Crime Index");
    const choices: Choice[] = [];
    // The yearly choice: the same question over the whole years it covers, the asked end year kept (Codex span review 06.2-3).
    const yFrom = Math.max(startYear, hb?.firstYear ?? startYear), yTo = Math.min(Number(a.endMonth.slice(0, 4)), hb?.lastYear ?? Number(a.endMonth.slice(0, 4)));
    if (hb && yTo >= yFrom) {
      const out = fromLedger(filled(filled(ledger, "grain", "year", "by year"), "period", yFrom === yTo ? `year:${yFrom}` : `range:${yFrom}:${yTo}`, yFrom === yTo ? `in ${yFrom}` : `from ${yFrom} to ${yTo}`), deps, pins);
      // Only a Crime Index answer counts: a NIBRS by-year run clipped to its first year (R14) is not a Crime Index series.
      if (out.kind !== "decline" && out.kind !== "route" && out.kind !== "clarify" && out.kind !== "answer")
        choices.push({ label: `Yearly, ${yFrom} to ${yTo} (Crime Index)`, kind: "yearly", from: String(yFrom), out });
    }
    // A monthly source is offered only when the asked period reaches into its months ("in 1999" has none).
    // The asked end is kept, never widened to the source's latest month.
    const ctEnd = a.ct && a.endMonth < a.ct.last ? a.endMonth : a.ct?.last ?? a.endMonth;
    if (a.ct && a.endMonth >= a.ct.first) {
      const out = fromLedger(filled(ledger, "period", `monthrange:${a.ct.first}:${ctEnd}`, `from ${monthName(a.ct.first)}`), deps, pins);
      if (out.kind === "current") choices.push({ label: `Monthly, ${monthName(a.ct.first)} to ${monthName(ctEnd)} (Current Trends)`, kind: "current", from: a.ct.first, out });
    }
    // The agency's first reported NIBRS month, never before the release's first.
    let nFirst: string | null = rel.firstMonth;
    try {
      const r = deps.execute(`SELECT min(data_year * 100 + month) FROM read_parquet('${deps.target.root.replace(/'/g, "''")}/agency_month_status/data_year=*/data.parquet', hive_partitioning = true) WHERE ori = '${ori.replace(/'/g, "''")}' AND status IN ('REPORTED_CRIMES', 'REPORTED_ZERO')`)[0]?.[0];
      const n = Number(r);
      // No reported month at all: the agency has no monthly NIBRS figures to offer (Codex span review 06.4).
      if (r === null || r === undefined) nFirst = null;
      else if (Number.isFinite(n) && n > 190000) { const m = `${Math.floor(n / 100)}-${String(n % 100).padStart(2, "0")}`; if (m > nFirst) nFirst = m; }
    } catch { /* the query could not say: the release's first month stands */ }
    const nEnd = a.endMonth < rel.lastMonth ? a.endMonth : rel.lastMonth;
    if (nFirst && a.endMonth >= nFirst) {
      const l = Object.assign(filled(ledger, "period", `monthrange:${nFirst}:${nEnd}`, `from ${monthName(nFirst)}`), { nibrsAsked: true });
      const out = fromLedger(l, deps, pins);
      if (out.kind === "answer") choices.push({ label: `Monthly, ${monthName(nFirst)} to ${monthName(nEnd)} (NIBRS)`, kind: "nibrs", from: nFirst, out });
    }
    if (!choices.length) return null;
    const yearlyChoice = choices.find((c) => c.kind === "yearly");
    const yearlyFrom = yearlyChoice ? yearlyChoice.from : String(startYear);
    if (choices.length === 1) {
      const only = choices[0];
      const said = only.kind === "yearly"
        ? `No monthly figures for ${agency} go back to ${startYear}; yearly figures go back to ${yearlyFrom} in Crime Index. Showing yearly figures from ${yearlyFrom}.`
        : `Monthly figures for ${agency} start in ${monthName(only.from)} (${sourceName(only.kind)})${yearlyChoice ? `; yearly figures go back to ${yearlyFrom} in Crime Index` : ""}. Showing ${sourceName(only.kind)} monthly figures from ${monthName(only.from)}.`;
      const d = (only.out as unknown as { delivered?: { text: string[] } }).delivered;
      if (d) d.text.splice(1, 0, said);
      // Said on purpose: the yearly figures stand in for the months asked (not a breakdown dropped by mistake).
      return Object.assign(only.out, { spanChoice: true });
    }
    return { kind: "clarify", about: "which would you like", question: ledger.question, note: `No single source has monthly figures for ${agency} back to ${startYear}.`,
      options: choices.map((c) => ({ label: c.label, continuation: c.out, ...(c.kind === "yearly" ? { role: "by_year" as const } : {}) })) };
  } finally { inSpanChoices = false; }
}

/** The reason a reader decline gives, as a limitation reason; "reader" when its words name none of them. */
function readerReason(explanation: string): LimitationReason | "reader" {
  if (/below the level of an agency/.test(explanation)) return "below_agency_level";
  if (/court outcomes/.test(explanation)) return "court_outcome";
  if (/can't explain causes/.test(explanation)) return "explanation_requested";
  if (/couldn't resolve that place/.test(explanation)) return "unresolved_place";
  return "reader";
}

/** "LA" for a place (not after a place it qualifies, "Shreveport, LA"): Los Angeles or Louisiana, asked. */
const LA = /(?<![A-Z][a-z]+,?\s)(?<![(,]\s?)(?:\bL\.A\.|\bLA\b(?!\s+[A-Z][A-Za-z])|(?<=^|\s)la(?=\s+(?:murders?|homicides?|crimes?|robber\w*|violent|property|have|has|had|and|vs|versus|or|in|since|by|per|from|right|now)\b|\s*[?.!]?\s*$))/;
/**
 * P143: phrases with one plain meaning, said again in the words the reader knows. "until January 2026" (a month series with no
 * start) runs from the data's first month through that month, inclusive; "raw numbers, not rates" asks for counts; a state
 * name run into "crime" ("coloradocrime") is two words.
 */
const MONTH_WORD = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
export function plainMeanings(q: string, firstMonth: string): string {
  let out = q;
  const until = new RegExp(String.raw`\b(?:until|up\s+to)\s+(${MONTH_WORD}\s+\d{4})\b`, "i").exec(out);
  if (until && (out.match(/\b(?:19|20)\d\d\b/g) ?? []).length === 1 && /\b(?:per|by|each)\s+months?\b|\bmonthly\b/i.test(out)
    && !/\b(?:since|from|starting|beginning|between|back\s+to|through|thru)\b/i.test(out))
    out = out.replace(until[0], `from ${monthName(firstMonth)} through ${until[1]}`);
  out = out.replace(/\b(?:the\s+)?raw\s+(?:numbers?|counts?|figures?)\s*,?\s*(?:and\s+)?not\s+(?:the\s+)?(?:rates?|per\s+capita)\b/gi, "counts")
    .replace(/\b(numbers?|counts?)\s*,?\s*not\s+(?:the\s+)?rates?\b/gi, "$1");
  const states = Object.values(STATE_NAMES).map((n) => n.toLowerCase().replace(/\s+/g, "\\s*")).join("|");
  return out.replace(new RegExp(String.raw`\b(${states})(crimes?)\b`, "gi"), "$1 $2");
}

/**
 * P141: "LA" and "SF" as a city when listed with other cities ("Chicago vs. LA, NYC, Houston"). Not when the list is of
 * states ("CA, LA, TX") or the token qualifies a city ("Baton Rouge, LA"; "Baton Rouge, LA and Houston, TX").
 */
const NICKNAMES: Record<string, string> = { LA: "Los Angeles", SF: "San Francisco" };
const LIST_SEP = String.raw`(?:,|&|\band\b|\bvs\.?|\bversus\b)`;
export function listedNicknames(q: string): string {
  let out = "", at = 0;
  for (const m of q.matchAll(/\b(LA|SF)\b/g)) {
    const i = m.index!, before = q.slice(0, i), after = q.slice(i + 2);
    const next = new RegExp(String.raw`^\s*${LIST_SEP}\s*([A-Za-z][\w.'-]*)(\s*,\s*[A-Z]{2}\b)?`).exec(after);
    const stateNext = next !== null && (/^[A-Z]{2}$/.test(next[1]) || next[2] !== undefined);
    const afterSep = /(?:\bvs\.?|\bversus\b|\band\b|&)\s*$/i.test(before);
    const afterComma = /,\s*$/.test(before);
    const firstOfList = /(?:^|\b(?:for|in|of|compare|between)\s+)$/i.test(before);
    const city = !stateNext && (afterSep || (next !== null && firstOfList)
      || (afterComma && ((before.match(/,/g) ?? []).length >= 2 || (next !== null && /\b(?:vs\.?|versus|and|&)\b/i.test(before)))));
    if (!city) continue;
    out += q.slice(at, i) + NICKNAMES[m[1]]; at = i + 2;
  }
  return out + q.slice(at);
}

/**
 * The question with one of its words replaced, in the user's own words: the reader's text has circumstance and other
 * words taken out ("gangland"), so its offsets would drop them (Codex ties/P75 review 01.1). The word is found in the
 * original by its text, or by the misspelling the reader corrected ("assualts"); when neither is there, null, and the
 * question isn't rewritten (Codex ties/P75 review 02): the reader's text can't be used, it has words taken out.
 */
function inOriginal(question: string, ledger: RequestLedger, part: Part, to: string, qualified?: RegExp): string | null {
  const word = part.text.trim();
  const misspelt = (flags(ledger).readings ?? []).filter((r) => r.kind === "spelling" && r.to.toLowerCase() === word.toLowerCase()).map((r) => r.from);
  for (const w of [word, ...misspelt]) {
    // The occurrence the reader read bare: one already qualified ("felony assaults", "aggravated assault") is another
    // crime, and rewriting it would leave the bare one to be rewritten again (scorecard 2026-11-06: no end).
    for (const m of question.matchAll(new RegExp(String.raw`(?<![A-Za-z])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`, "gi"))) {
      if (qualified?.test(question.slice(0, m.index))) continue;
      return question.slice(0, m.index) + to + question.slice(m.index! + m[0].length);
    }
  }
  return null;
}
/** An "assault" with a kind before it: the reader's bare-assault rule leaves these to their own measures. */
const ASSAULT_QUALIFIED = /\b(?:aggravated|simple|sexual|sex|agg\.?|felony)[\s-]+$/i;

/**
 * Ask instead of decline (Jeff 2026-11-10, bad-declines plan clusters 1, 11, 12 and 16). Only a reader's own decline
 * ("I didn't understand ...") is reconsidered, never an answer or a decline about the data:
 * - The words the reader left unread are all vague or comparison filler ("scorecard", "tell me more about", "is crime
 *   up in", "an overview for", "vs national average"): the question without them is read again, and its ask is given
 *   when it asks (which kind of crime, which period, which place). Its answer is never given: the user's question had
 *   words the reader set aside, so an answer could be to another question. A word that isn't filler ("VA" after
 *   "Arlington", read as Arlington, Texas; a crime the reader doesn't know) keeps the decline.
 * - A year that can't be read ("since 20210", "to 202", "back to 1`980", "in2p2t"): the years are asked.
 */
const FILLER_WORDS = new Set(("a an the my me i we you your our more about tell give show see get let us please can could would will wanna gimme lemme " +
  "what what's whats how is are was has have had does do did been being look looks looking like in on of for to at with from by " +
  "overview overviews scorecard scorecards score card cards report reports snapshot summary profile picture situation " +
  "statistics stats data info information numbers figures general overall major prevalent most trend trends trending " +
  "highlight highlights up down gone going rising falling increasing decreasing improving worsening dropping doing lately " +
  "recently recent current currently last past few several couple years year " +
  "average averages statewide nationwide level levels terms side-by-side side compared compare comparison versus vs vs. " +
  "relative rest same specifically or and any way so").split(/\s+/));
/**
 * Pure filler (Jeff 2026-11-11, "rules first then gemini"): words that ask for nothing ("plot me the", "report", "do you
 * have", "please"). When the reader leaves only these unread, the question without them is answered as asked, not just
 * asked about: the rest of the question was read in full. Never a place, crime, time or comparison word.
 */
const PURE_FILLER = new Set(("a an the my me i we you your our please can could would will wanna gimme lemme tell give show see get let us plot chart graph draw " +
  "display make list provide pull find calculate compute report reports data info information stats statistics numbers figures any have has do does what " +
  "what's whats how is are was hi hey hello just also kind sort some").split(/\s+/));
// "More about", "look like in", "in the last few years" on a place-only question (P148): the phrases ask for nothing beyond the composite.
const PURE_PHRASES = /\b(?:more\s+about|(?:look|looks)\s+like(?:\s+in)?|in\s+the\s+(?:last|past)\s+(?:few|several|couple\s+of)\s+years)\b/gi;
const FEW_YEARS_WINDOW = /\b(?:last|past)\s+(?:few|several|couple\s+of)\s+years\b/i;
const pureFillerOnly = (text: string) => {
  const words = wordsOf(text.replace(PURE_PHRASES, " "));
  if (words.length === 0 && text.trim()) return true;
  return words.length > 0 && words.every((w) => PURE_FILLER.has(w));
};
/** A question about what data there is ("Do you have any data for NYC?", "does Olathe report NIBRS data?"): never an ask. */
const COVERAGE_QUESTION = /^\s*(?:do|does)\s+(?:you|we|they|i|this\s+(?:site|tool|app))\s+have\b|\b(?:any|what)\s+data\b|\breports?\s+(?:to\s+)?(?:nibrs|the\s+fbi|data)\b|\bdata\s+(?:do|does)\s+you\b/i;
const wordsOf = (text: string) => text.toLowerCase().replace(/[“”"’'?!.,;:()]/g, " ").split(/\s+/).filter(Boolean);
const fillerOnly = (text: string) => {
  const words = wordsOf(text);
  return words.length > 0 && words.every((w) => FILLER_WORDS.has(w));
};
/**
 * Filler words that still mean something: a change, an average, a comparison, a time (Codex ask-instead review 01.2).
 * The ask that leaves them out says so; the shootings ask never leaves them out.
 */
const MEANING_WORDS = new Set(("average averages up down gone going rising falling increasing decreasing improving worsening dropping " +
  "trend trends trending compared compare comparison versus vs vs. relative side-by-side side rest same level levels statewide " +
  "nationwide current currently recent recently lately last past few several couple years year most prevalent major overall").split(/\s+/));
const meaningful = (text: string) => wordsOf(text).some((w) => MEANING_WORDS.has(w));
/**
 * The reader's own text is the question's, so its spans cut the question as written (Codex review 01.1: the reader
 * rewrites some words, "Midwest" to "United States" with the region kept apart, "gun crimes" to three crimes, and its
 * text read again would lose them). Its one rewrite allowed: a comparison's "vs" or "compared to" as "and".
 */
const sameText = (question: string, read: string, ledger?: RequestLedger) =>
  read === question || question.replace(/\s+(?:vs\.?|versus|compared\s+to)\s+/gi, " and ") === read
  // The comparison wording's own rewrites ("compare X to Y" as "X and Y") keep everything in the text: only a reading
  // kept beside the text (a region, a composite, a comparison of periods...) stops the ask (job CW1: four asks lost).
  || (!!ledger && textOnly(ledger));
const TEXT_ONLY_FLAGS = ["combined", "comparison", "circumstance", "region", "composite", "people", "largeCities", "allCities", "largestSet", "countywide", "consistent", "property", "clearance",
  "arrestsThrough", "quarter", "column", "shrDetail", "nibrsAsked", "shrAsked"];
function textOnly(ledger: RequestLedger): boolean {
  const f = ledger as unknown as Record<string, unknown>;
  return !TEXT_ONLY_FLAGS.some((k) => { const v = f[k]; return !!v && !(Array.isArray(v) && !v.length); });
}
/** A year the reader couldn't read: digits run too short or too long, or broken by a stray character. */
const garbledYear = (text: string) => {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const last = words[words.length - 1] ?? "";
  // The words before it are period words ("since", "back to"), and it has digits but isn't a year.
  if (!words.slice(0, -1).every((w) => /^(?:since|from|to|through|thru|until|back|in|before|after)$/.test(w))) return false;
  const tok = last.replace(/^(?:in|to)(?=\d)/, "").replace(/[?.!,]+$/, "");
  return /\d/.test(tok) && !/^(?:19|20)\d\d$/.test(tok) && tok.length >= 3 && tok.length <= 6 && /^[12]/.test(tok);
};
/** For tests: the filler and garbled-year checks of the ask-instead rule. */
const cut = (text: string, parts: Part[]) => {
  let t = text;
  for (const p of [...parts].sort((a, b) => b.span[0] - a.span[0])) t = t.slice(0, p.span[0]) + " " + t.slice(p.span[1]);
  return t.replace(/\s+/g, " ").trim();
};
/**
 * A reader's decline whose unread words are all filler: the question without them, and the ones left out that mean
 * something of their own ("up in", "average"), to be said with the ask. Null when a word isn't filler or the reader
 * rewrote the question's text.
 */
function fillerRewrite(question: string, ledger: RequestLedger): { rest: string; left: string[] } | null {
  const unread = ledger.parts.filter((p) => p.state === "not-interpreted");
  if (!unread.length || !unread.every((p) => fillerOnly(p.text)) || !sameText(question, ledger.question, ledger)) return null;
  // Something of the question was read: a place or a crime (a bare "crime" counts).
  if (!ledger.parts.some((p) => p.clause === 0 && p.state === "recognized" && (p.concept === "place" || p.concept === "measure"))) return null;
  return { rest: cut(ledger.question, unread), left: unread.filter((p) => meaningful(p.text)).map((p) => p.text.trim()) };
}
/** "So far this year", "year to date", "YTD": the reader keeps only the year, so the words are looked for here. */
const YEAR_TO_DATE = /\bso\s+far\b|\byear[-\s]to[-\s]date\b|\bytd\b/i;
/** The reader rewrites "so far in 2025" to "in 2025" and keeps the words as a reading: both are looked at. */
const saysToDate = (ledger0: RequestLedger) => YEAR_TO_DATE.test(ledger0.question) || (flags(ledger0).readings ?? []).some((r) => YEAR_TO_DATE.test(r.from));
/**
 * A year's months in Current Trends for a ranking past Crime Index (decision 4): the current year's January through the
 * latest month; with "so far", any year Current Trends holds, January through its latest month that year. Null otherwise.
 */
function currentYearSpan(year: number, cur: CurrentBuild, toDate: boolean): [string, string] | null {
  const last = Number(cur.lastMonth.slice(0, 4));
  if (year === last) return [`${year}-01`, cur.lastMonth];
  if (toDate && `${year}-01` >= cur.firstMonth && year < last) return [`${year}-01`, `${year}-12`];
  return null;
}
/** For tests: the ask-instead rule's checks and rewrites, which read no data. */
export const askInsteadChecks = {
  fillerOnly: (t: string) => fillerOnly(t), pureFillerOnly: (t: string) => pureFillerOnly(t), garbledYear: (t: string) => garbledYear(t), covers: (q: string) => COVERAGE_QUESTION.test(q),
  fillerRewrite: (q: string) => fillerRewrite(q, readQuestion(q, 2026, "2026-09").ledger),
  /** The P74 question without the unread words, or null when it isn't offered. */
  stripped: (q: string) => { const l = readQuestion(q, 2026, "2026-09").ledger; return askInstead(l.question, l.parts.filter((p) => p.state === "not-interpreted"), 2026)?.question ?? null; },
};
/**
 * A reader's decline turned into an ask only when the ask covers the WHOLE question (Jeff 2026-11-21, through the Coordinator: a
 * question asking for something the engine cannot do and something it can is declined, or asked what makes all of it
 * answerable; never answered in part, with or without a line saying what was dropped). So peers ("compared to similar
 * cities") keep the reader's decline, which asks for the agencies to compare.
 */
function clarifyInstead(question: string, o: ShadowOutcome, deps: ShadowDeps): ShadowOutcome | null {
  if (o.kind !== "decline" || COVERAGE_QUESTION.test(question)) return null;
  const ledger = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
  if (ledger.parts.some((p) => p.clause === 0 && p.concept === "peer")) return null;
  if (o.reason !== "reader") return null;
  const unread = ledger.parts.filter((p) => p.state === "not-interpreted");
  if (unread.some((p) => garbledYear(p.text)) && unread.every((p) => garbledYear(p.text) || fillerOnly(p.text))
    && ledger.parts.some((p) => p.clause === 0 && p.state === "recognized" && (p.concept === "place" || p.concept === "measure")))
    return { kind: "clarify", about: "which years", question, options: [{ label: "Name the years", entry: "which years" }] };
  const fr = fillerRewrite(question, ledger);
  const again = fr ? answerAsked(fr.rest, { ...deps, rewritten: true }) : null;
  // Only pure filler left unread: the rest was read in full, so its answer is the question's (Jeff 2026-11-11).
  // "in the last few years" beside a named crime is a window, not filler: dropping it would answer every year (Codex 449).
  const windowDropped = unread.some((p) => FEW_YEARS_WINDOW.test(p.text)) && ledger.parts.some((p) => p.clause === 0 && p.state === "recognized" && p.concept === "measure" && p.value !== "unspecified" && p.value !== "all_crime");
  if (fr && again && !windowDropped && unread.every((p) => pureFillerOnly(p.text)) && ["answer", "historical", "srs", "current", "shr", "hate", "coverage"].includes(again.kind)) return again;
  if (!fr || again?.kind !== "clarify") return null;
  // Words with a meaning of their own left out ("up in", "average"): said, so a button's answer is never taken for
  // the change or the average asked (Codex review 01.2). Whether this ask is itself a partial answer under the rule above is
  // an open question for the owner (2026-11-21); it is unchanged here.
  return { ...again, question, ...(fr.left.length ? { note: `The choices below answer without ${fr.left.map((t) => `"${t}"`).join(" and ")}.` } : {}) };
}

/**
 * "Violent crime per capita in NC over time and how it compares to other states" (Jeff 2026-11-11): the state beside
 * the United States, by the question's own period, saying that "other states" was read as the country as a whole and
 * naming the question that ranks every state for a year (decision 5). Null when no single state and crime are read.
 */
const OTHER_STATES = /,?\s*\b(?:and\s+)?(?:how\s+(?:it|they|this|that)\s+)?compares?\s+(?:to|with)\s+(?:the\s+)?other\s+states\b\.?/i;
function otherStates(question: string, deps: ShadowDeps): ShadowOutcome | null {
  if (!OTHER_STATES.test(question)) return null;
  const base = question.replace(OTHER_STATES, " ").replace(/\s+/g, " ").trim();
  const l = readQuestion(base, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
  const states = l.parts.filter((p) => p.clause === 0 && p.concept === "place" && /^state:/.test(String(p.value)));
  const measure = l.parts.find((p) => p.clause === 0 && p.concept === "measure" && p.value !== "unspecified");
  if (states.length !== 1 || !measure || l.parts.some((p) => p.state === "not-interpreted")) return null;
  // Only a question the reader's text says in full: a comparison of periods, a circumstance, a region, a composite or
  // another reading kept beside the text would be lost when the text is asked again (Codex comparison confirmation 01).
  const f = l as unknown as Record<string, unknown>;
  if (["comparison", "circumstance", "region", "composite", "people", "largeCities", "allCities", "largestSet", "countywide", "consistent", "property", "clearance", "arrestsThrough", "quarter", "column", "shrDetail", "nibrsAsked"]
    .some((k) => { const v = f[k]; return !!v && !(Array.isArray(v) && !v.length); })) return null;
  const st = states[0];
  // The reader's spans are in its own text (Codex comparison review 01.2), so the place is added there.
  const lq = l.question;
  const beside = answerAsked(`${lq.slice(0, st.span[1])} and the United States${lq.slice(st.span[1])}`, { ...deps, rewritten: true });
  if (beside.kind !== "historical" && beside.kind !== "srs") return null;
  const year = Number(deps.release.lastMonth.slice(0, 4)) - 1;
  const rate = /\b(?:per\s+capita|rates?)\b/i.test(question);
  const note = `"Other states" is read as the United States as a whole. Every state ranked is answered one year at a time, for example "states ranked by ${measure.text.trim().toLowerCase()}${rate ? " rate" : ""} in ${year}".`;
  return { ...beside, delivered: { ...beside.delivered, text: [...beside.delivered.text.slice(0, -1), note, ...beside.delivered.text.slice(-1)] } } as ShadowOutcome;
}

/**
 * Never a button that leads to a decline (the engine's standing rule; Jeff 2026-11-14: "no note when hidden"). Every
 * button whose continuation cannot run is dropped, at any depth, with no note; an ask left with no button that runs
 * becomes the decline its buttons ended in, with its real reason. A button that asks for typed words (an entry) or is
 * answered by another source has no continuation to check and stays. The continuations are built through
 * shadowAnswer, so a nested ask is already pruned when its parent sees it; this walks them again so an ask built
 * elsewhere is held to the same rule.
 */
export function withoutDeadButtons(o: ShadowOutcome): ShadowOutcome {
  if (o.kind === "decline") {
    // The buttons beside a decline, and the choices an answer offers, hold asks of their own (a forecast's "which New
    // York"): a button whose ask is left with no choice that runs is not shown.
    const alternative = o.alternative ? pruneAsk(o.alternative) : null, more = o.more?.flatMap((x) => pruneAsk(x) ?? []);
    return alternative === o.alternative && (!o.more || more!.length === o.more.length && more!.every((x, i) => x === o.more![i]))
      ? o : { ...o, alternative, ...(o.more ? { more } : {}) };
  }
  if (o.kind === "answer" && o.buttons?.length) {
    const buttons = o.buttons.flatMap((x) => pruneAsk(x) ?? []);
    return buttons.length === o.buttons.length && buttons.every((x, i) => x === o.buttons![i]) ? o : { ...o, buttons };
  }
  if (o.kind !== "clarify") return o;
  const options: ShadowOption[] = [], dead: ShadowOutcome[] = [];
  let changed = false;
  for (const x of o.options) {
    // A deferred button reached its heavy statement (deferHeavy): it runs, and reading its answer here would build it.
    if (isDeferred(x) || !x.continuation) { options.push(x); continue; }
    const c = withoutDeadButtons(x.continuation);
    if (!runsNow(c)) { dead.push(c); changed = true; continue; }
    if (c !== x.continuation) changed = true;
    options.push(c === x.continuation ? x : { ...x, continuation: c });
  }
  if (!options.length) return dead[0] ?? o;
  return changed ? { ...o, options } : o;
}

/** A button that holds an ask: the ask pruned, or the button gone when no choice in it runs. Any other button is as it was. */
function pruneAsk(x: ShadowOption): ShadowOption | null {
  if (isDeferred(x) || x.continuation?.kind !== "clarify") return x;
  const c = withoutDeadButtons(x.continuation);
  return !runsNow(c) ? null : c === x.continuation ? x : { ...x, continuation: c };
}

/**
 * P147 (Jeff 2026-11-18): a monthly count series with every month blank (NIBRS carjackings for New Orleans, a place that does
 * not report NIBRS) is not an answer: it is declined in one sentence, with no timeframe. A series with only some places or months
 * blank keeps its table and its gap sentences.
 */
export function allBlankMonthly(o: ShadowOutcome): ShadowOutcome | null {
  const listed = (xs: string[]) => (xs.length > 2 ? `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}` : xs.join(" and "));
  if (o.kind !== "answer" && o.kind !== "current") return null;
  const table = o.delivered.table;
  const stats = table.columns.map((c, i) => (c.binding.kind === "statistic" ? i : -1)).filter((i) => i >= 0);
  const monthly = table.columns.some((c) => c.binding.kind === "grouping" && c.binding.dimension === "time.month");
  if (!monthly || !stats.length || table.rows.length < 2 || !table.rows.every((r) => stats.every((i) => r[i] === null))) return null;
  if (o.kind === "answer") {
    if (!o.plan.statistics.length || o.plan.statistics.some((s) => s.kind !== "count") || !o.plan.measures.length) return null;
    // Agencies only: a state's or the nation's month is blank when any agency counted lacks it, and its own notes say so.
    if (!o.plan.geography.places.length || o.plan.geography.places.some((p) => p.kind !== "agency")) return null;
    const places = o.plan.geography.places.map((p) => (p.kind === "agency" ? p.label : ""));
    return decline("outside_release_coverage", `No data is available for ${listed(o.plan.measures.map((m) => measureWords(o.plan, m)).filter((w, i, all) => all.indexOf(w) === i))} in ${listed(places)}.`);
  }
  const q = o.question, hm = HISTORICAL_MEASURE[q.measure];
  if (!hm || q.statistic === "rate" || q.form !== "months" || q.place.kind !== "agency") return null;
  return decline("outside_release_coverage", `No data is available for ${hm.words} in ${listed([q.place.label, ...(q.agencies ?? []).map((a) => a.label)])}.`);
}

/**
 * P151 (Jeff 2026-11-19): under the all-blank decline of one agency's Part I crime, the yearly Crime Index answer is offered when it has a
 * figure ("Ask instead: murders in Oakland in 2021"; by year when the months spanned more than one year).
 */
export function withYearlyOffer(decl: ShadowOutcome, o: ShadowOutcome, deps: ShadowDeps, run: (question: string) => ShadowOutcome = (q) => shadowAnswer(q, deps)): ShadowOutcome {
  if (decl.kind !== "decline" || (o.kind !== "answer" && o.kind !== "current")) return decl;
  let name: string | null = null, label: string | null = null;
  if (o.kind === "current") { name = o.question.measure; label = o.question.agencies?.length ? null : o.question.place.label; }
  else if (o.plan.measures.length === 1 && o.plan.geography.places.length === 1 && o.plan.geography.places[0].kind === "agency") {
    name = o.plan.measures[0].id.replace(/^[a-z_]+\./, ""); label = o.plan.geography.places[0].label;
  }
  const hm = name ? HISTORICAL_MEASURE[name] : undefined;
  if (!hm || !label) return decl;
  const when = o.period.from.slice(0, 4) === o.period.to.slice(0, 4) ? `in ${o.period.from.slice(0, 4)}` : "by year";
  const question = `${hm.words} in ${label} ${when}`;
  let yearly: ShadowOutcome;
  try { yearly = run(question); } catch { return decl; }
  if (yearly.kind !== "historical" && yearly.kind !== "srs") return decl;
  const rows = yearly.delivered.table.rows;
  // One year asked gives a one-cell row with no Year column ([[127]]); several years give Year first.
  const dated = yearly.delivered.table.columns.length > 1;
  if (!rows.flatMap((r) => (dated ? r.slice(1) : r)).some((c) => typeof c === "number")) return decl;
  // The table opened from this button ends at its last year with a figure (Jeff 2026-11-19), the years after it named; no trailing blank rows.
  let last = rows.length - 1;
  while (dated && last >= 0 && rows[last].slice(1).every((c) => c === null)) last--;
  let opened: ShadowOutcome = yearly;
  if (last >= 0 && last < rows.length - 1) {
    const gone = rows.length - 1 - last, from = String(rows[last + 1][0]), to = String(rows[rows.length - 1][0]);
    const note = `Crime Index has no ${hm.name} figure${gone > 1 ? "s" : ""} for ${label} ${gone > 1 ? `from ${from} to ${to}` : `in ${to}`}, so the chart and table end in ${rows[last][0]}.`;
    const text = [yearly.delivered.text[0], note, ...yearly.delivered.text.slice(1)];
    opened = { ...yearly, period: { from: `${rows[0][0]}-01`, to: `${rows[last][0]}-12` }, delivered: { ...yearly.delivered, table: { ...yearly.delivered.table, rows: rows.slice(0, last + 1) }, text } } as never;
  }
  return { ...decl, alternative: { label: `Ask instead: "${question}"`, continuation: opened } };
}

/** Words asking a breakdown or a person detail that a Crime Index (or hate crime) figure cannot give: a default that lands on such a source would answer without it. */
/** A clearance question (P182's exception): a clearance rate, offenses cleared, clearances by type, cleared by arrest or exception. */
const CLEARANCE_WORDS = /\bclear(?:ance|ances|ed|ing)?\b/i;
/**
 * QL-nibrs-9aed2136c4 (Jeff 2026-11-22): "What percentage of murders are cleared by arrest vs exceptional" is asked for shares of the clearance types.
 * Narrow on purpose: a percentage word, a clearance word, and both "arrest" and "exceptional". Only such a question defaults a missing year to the
 * latest complete year, gets the share column in place of counts, and is exempt from the heavy-statement deferral (the national one runs in seconds).
 */
const clearanceTypeShareAsked = (q: string): boolean => /\b(?:percent(?:age)?s?|shares?|proportions?)\b/i.test(q) && CLEARANCE_WORDS.test(q) && /\barrest/i.test(q) && /\bexceptional/i.test(q);
/** NIBRS named, or an offense only NIBRS holds: a default never answers these from the Crime Index or Current Trends. */
const NIBRS_ONLY = /\bnibrs\b|\bfrom (?:a )?motor vehicles?\b|\bcarjack\w*|\bshoplift\w*|\bsimple assaults?\b|\bintimidation\b|\bdrugs?\b|\bnarcotic\w*|\bdui\b|\bdwi\b|\barrest\w*|\bkidnap\w*|\bfraud\w*|\bvandal\w*|\bprostitut\w*|\btrafficking\b/i;
/** A question that points back at an answer that isn't there: never answered in part by a default. */
const POINTS_BACK = /\bother\s+(?:large\s+|big\s+|similar\s+|comparable\s+)?(?:cities|agencies|places|states|counties|departments)\b|^\s*(?:compare[ds]?|comparison)\s+(?:it\s+|that\s+|this\s+)?(?:to|with|against)\b|^\s*(?:vs\.?|versus)\b/i;
const CRIME_INDEX_BLIND = /\b(?:by|per)\s+(?:the\s+)?(?:offender|victim|arrestee|age|race|sex|gender|weapon|location|relationship|circumstance|ethnicity|hour|time\s+of\s+day)|\b(?:offenders?|victims?|arrestees?|juvenile|teen\w*|firearms?|guns?|knife|knives|handguns?|rifles?|shotguns?|domestic|intimate)\b/i;
const ANSWER_KINDS = ["answer", "srs", "historical", "current", "shr", "hate"];
let defaultDepth = 0;
/**
 * P180 to P182 (Jeff 2026-11-21), at every ask site at once: a question asked back about its place, its period or its kind of crime is answered
 * with the default instead, when the option that carries it answers now (not a heavy statement deferred, not a decline), and the chain of asks
 * (a place, then a period, then a kind of crime) ends in an answer. The notes say each default, after the title; buttons let the user change the
 * place or the year. Otherwise the ask stays as before (a ranking with no period, a heavy national shape, a question the reader cannot place).
 */
export function applyDefaults(question: string, o0: ShadowOutcome, deps: ShadowDeps): ShadowOutcome {
  if (deps.checkingOffer || deps.noDefaults || defaultDepth > 1 || o0.kind !== "clarify") return o0;
  const notes: string[] = [];
  const buttons: ShadowOption[] = [];
  let cur: ShadowOutcome = o0;
  let years = false;
  for (let i = 0; i < 4 && cur.kind === "clarify"; i++) {
    const c = cur as Extract<ShadowOutcome, { kind: "clarify" }>;
    const find = (re: RegExp): ShadowOption | undefined => c.options.find((x: ShadowOption) => re.test(x.label));
    let option: ShadowOption | undefined;
    let note = "";
    let byStateRows = false;
    const more: ShadowOption[] = [];
    if (c.about === "which place") {
      option = find(/^The United States$/);
      // "By state" names the nation's states as the rows (Engine 2.0, 2026-11-22): no note and no place buttons beside a table of every state.
      byStateRows = /\b(?:by|per|each|every|for\s+each)\s+state\b/i.test(question);
      note = byStateRows ? "" : "No place was named, so the United States is shown.";
      if (!byStateRows) more.push({ label: "A state", entry: "which state" }, { label: "A city or agency", entry: "which city or agency" });
    } else if (/^which (?:period|range of years|years)$/.test(c.about)) {
      option = find(/^Every year available$/);
      // No every-year button: the same question asked by year, as the user would type it (not for a ranking, which has one year).
      if (!option && !deps.shareAsked && !/\b(?:top|bottom|highest|lowest|most|fewest|rank\w*|worst|best)\b/i.test(c.question)) {
        defaultDepth++;
        try {
          // Built against the heavy-statement probe: a national series that takes minutes is not run as a default (the ask stays).
          const o = deferHeavy("Every year available", (d) => shadowAnswer(`${c.question.replace(/[?.!\s]+$/, "")} by year`, d), deps);
          if (!isDeferred(o) && o.continuation && ANSWER_KINDS.includes(o.continuation.kind)) option = o;
        } finally { defaultDepth--; }
      }
      // A ranking has one year (Jeff 2026-11-21): the latest complete year, said, with a button for another year.
      if (!option) {
        const latest = find(/^The latest complete year \((\d{4})\)$/);
        if (latest) { option = latest; note = `No year was given, so the latest complete year, ${/\((\d{4})\)/.exec(latest.label)![1]}, is shown.`; }
      }
      years = true;
      more.push({ label: "Another year", entry: "which year" });
    } else if (c.about === "which kind of crime") {
      // P182's exception (Jeff 2026-11-21): a clearance question with no crime named keeps the ask (no violent-plus-property default).
      option = CLEARANCE_WORDS.test(question) ? undefined : find(/^Both$/);
      note = "No kind of crime was named, so violent crime and property crime are shown.";
      more.push(...c.options.filter((x: ShadowOption) => x.label !== "Both"));
    }
    if (!option || isDeferred(option) || !option.continuation) { DEFAULT_MISSES.push({ site: c.about, why: !option ? "no default option" : "heavy" }); return o0; }
    if (!byStateRows) notes.push(note);
    buttons.push(...more);
    cur = option.continuation;
  }
  if (cur === o0 || !ANSWER_KINDS.includes(cur.kind)) { DEFAULT_MISSES.push({ site: "chain", why: cur.kind }); return o0; }
  const typed = deps.guardText ? `${question}\n${deps.guardText}` : question;
  // A Crime Index (or hate crime) figure has no breakdown by a person's age, race, sex or by weapon: a default that lands there for a question that asks
  // one would answer without it, which is a wrong answer, so such a question stays an ask.
  if (["srs", "historical", "current", "hate"].includes(cur.kind) && CRIME_INDEX_BLIND.test(typed)) {
    DEFAULT_MISSES.push({ site: "chain", why: "breakdown not in this source" });
    return o0;
  }
  // 284's final gate: a question that names NIBRS or a NIBRS-only offense ("in NIBRS", "larceny from motor vehicle") is never answered from the Crime
  // Index or Current Trends by a default (the every-year reading can route there), and a question that points back at an answer that isn't there
  // ("Compare to Tulsa murders", "Other large cities and violent crime", "compare with statewide ...") is never answered in part.
  if (["srs", "historical", "current"].includes(cur.kind) && NIBRS_ONLY.test(typed)) {
    DEFAULT_MISSES.push({ site: "chain", why: "NIBRS named or NIBRS-only offense" });
    return o0;
  }
  if (POINTS_BACK.test(question) || (deps.guardText && deps.guardText.split("\n").some((t) => POINTS_BACK.test(t)))) { DEFAULT_MISSES.push({ site: "chain", why: "points back" }); return o0; }
  const x = cur as ShadowOutcome & { delivered: { text: string[]; table: { rows: unknown[][] } }; buttons?: ShadowOption[] };
  const rows = x.delivered.table?.rows ?? [];
  const first = String(rows[0]?.[0] ?? ""), last = String(rows[rows.length - 1]?.[0] ?? "");
  const span = /^\d{4}/.test(first) && /^\d{4}/.test(last) && first !== last ? `: ${first.slice(0, 4)} through ${last.slice(0, 4)}` : "";
  // A latest-year default ("No year was given, so the latest complete year, 2025, is shown.") means the answer is one year, so an earlier every-year default in the same chain is not said.
  const latestYear = [...notes, ...x.delivered.text].some((n) => /^No year was given, so the latest complete year/.test(n));
  const say = notes.filter((n) => n || !latestYear).map((n) => (n ? n : `No years were given, so every year in the data is shown${span}.`));
  // A sentence the answer already carries is not said twice (a series built "by year" says its own "No years were given").
  const text = [x.delivered.text[0], ...say.filter((s) => !x.delivered.text.some((t) => t === s || (/^No years were given/.test(s) && /^No years were given/.test(t)))), ...x.delivered.text.slice(1).filter((t) => !(latestYear && /^No years were given/.test(t)))];
  void years;
  return { ...x, delivered: { ...x.delivered, text }, buttons: [...(x.buttons ?? []), ...buttons] } as ShadowOutcome;
}
/**
 * P188 (Jeff 2026-11-21): a loose word read as the meaning he decided ("current" is the latest complete year, "up" is the trend over five
 * years) is said in the answer: one note line for each, just before the source line, whichever source answered.
 */
function withMeaningNotes(question: string, o: ShadowOutcome, deps: ShadowDeps): ShadowOutcome {
  const del = (o as { delivered?: { text?: unknown } }).delivered;
  if (!del || !Array.isArray(del.text)) return o;
  const said = [...new Set((readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).readings ?? []).filter((r) => r.kind === "meaning").map(readingSentence))];
  if (!said.length) return o;
  const text = del.text as string[];
  const at = text.length && /^Source/.test(text[text.length - 1]) ? text.length - 1 : text.length;
  return { ...o, delivered: { ...del, text: [...text.slice(0, at), ...said.filter((s) => !text.includes(s)), ...text.slice(at)] } } as ShadowOutcome;
}
/**
 * Jeff 2026-11-23 (declines owner, Group 1): an open-ended ask names no kind of crime or measure to count, so it asks what to show
 * instead of choosing for the user. Only these wordings; P182's violent-plus-property default stays for "crime in X" asks.
 * "tell me more about", "what's going on in", "a time line of", "major/top crime trends" with no year, "how many crime incidents
 * ... since YEAR", "is X's murder rate ... considered high", "what Part 1 data do you have".
 */
const OPEN_ENDED_ANY = /\btell\s+me\s+more\s+about\b|\bwhat(?:(?:'|’)?s|\s+is)\s+(?:going\s+on|happening)\s+in\b|\btime\s*line\s+of\b/i;
const OPEN_ENDED_ALWAYS = /\bconsidered\s+high\b|\bpart\s+(?:1|i)\s+data\s+do\s+you\s+have\b/i;
const OPEN_ENDED_NO_YEAR = /\b(?:major|top)\s+(?:nationwide\s+)?crime\s+trends\b/i;
const OPEN_ENDED_SINCE = /\bhow\s+many\s+crime\s+incidents\b[^?]*\bsince\s+(?:19|20)\d\d\b/i;
export function isOpenEnded(question: string, year = 2026): boolean {
  // Only when no crime or measure is named (Codex 434: "time line of robberies in Denver ..." is a plain question) and not a chart edit.
  if (isChartEdit(question)) return false;
  if (OPEN_ENDED_ALWAYS.test(question)) return true;
  if (readQuestion(question, year).ledger.parts.some((p) => p.concept === "measure" && p.state === "recognized" && p.value !== "unspecified")) return false;
  // Jeff 2026-11-24 card: a place named with "crime" ("tell me more about crime in DC") answers P148's composite; the opener yields.
  if (OPEN_ENDED_ANY.test(question) && !OPEN_ENDED_SINCE.test(question) && !/\btime\s*line\s+of\b/i.test(question) && /\b(?:tell\s+me\s+more\s+about|going\s+on\s+in|happening\s+in)\s+(?:the\s+)?crime\s+(?:in|for|of)\s+\S/i.test(question)) return false;
  return OPEN_ENDED_ANY.test(question) || OPEN_ENDED_SINCE.test(question) || (OPEN_ENDED_NO_YEAR.test(question) && !/\b(?:19|20)\d\d\b/.test(question));
}
/** "When was violent crime the highest?" / "peak year for murder": the nation's peak year of a Crime Index rate, no place named. */
const PEAK_ASK = /\b(?:when\s+(?:was|were|did|has|have)\b.*\b(?:highest|worst|peak(?:ed)?|most)\b|(?:what|which)\s+year\b.*\b(?:highest|worst|peak|most)\b|peak\s+year\b)/i;
const PEAK_MEASURE: [RegExp, string][] = [
  [/\bviolent\s+crimes?\b/i, "violent_crime"], [/\bproperty\s+crimes?\b/i, "property_crime"], [/\bmurders?\b|\bhomicides?\b/i, "murder"],
  [/\brapes?\b/i, "rape"], [/\brobber(?:y|ies)\b/i, "robbery"], [/\baggravated\s+assaults?\b/i, "aggravated_assault"],
  [/\bburglar(?:y|ies)\b/i, "burglary"], [/\b(?:larceny|theft)s?\b/i, "theft"], [/\bmotor\s+vehicle\s+thefts?\b|\bauto\s+thefts?\b/i, "motor_vehicle_theft"],
];
/** Every word a plain "peak year of the national rate" question may carry. A word outside this list (a place, "intimate", "firearm", "victims", "reports", an age, a sex) means a different question: it falls through to the old route. */
const PEAK_WORDS = new Set(("when was were did has have been is are the a an what which year years peak peaked highest worst most ever recorded history overall all time "
  + "national nationally nationwide nation country america us u.s. usa united states in of for at on across rate rates per 100,000 100000 crime crimes "
  + "violent property murder murders homicide homicides rape rapes robbery robberies aggravated assault assaults burglary burglaries larceny larcenies theft thefts motor vehicle auto").split(/\s+/));
function peakMeasure(question: string): string | null {
  if (!PEAK_ASK.test(question)) return null;
  const words = question.toLowerCase().replace(/[?!.,;:]+(?=\s|$)/g, "").split(/\s+/).filter(Boolean);
  if (words.some((w) => !PEAK_WORDS.has(w))) return null;
  const hit = PEAK_MEASURE.filter(([re]) => re.test(question));
  return hit.length === 1 ? hit[0][1] : null;
}

const ARRESTS_NOT_CRIMES = "Arrests do not equal crimes.";
/** Jeff 2026-11-24: "juvenile crime" with no crime, victim or offender named is juvenile arrests (NIBRS, under 18) per year, the answer saying arrests are not crimes. */
const JUVENILE_CRIME = /\bjuvenile\s+crimes?\b(?!\s+(?:victims?|offenders?|arrests?|rates?|trends?|levels?|numbers?|statistics?))/i; // "trend", "levels", "numbers" and "statistics" are P293's (the reader's rewrite, reading.ts)
/** Kings County is a county in both New York and California (Jeff 2026-11-24): with no state named it is asked about, before anything else reads the question. */
const KINGS_COUNTY = /\bkings\s+county\b(?!\s*,?\s*(?:new\s+york|ny|n\.y\.|california|ca|calif\.?)(?![a-z]))(?!\s+(?:sheriff|police|pd|so)\b)/i;
function kingsCountyAsk(question: string): ShadowOutcome | null {
  const m = KINGS_COUNTY.exec(question);
  if (!m) return null;
  const withState = (state: string) => question.slice(0, m.index) + m[0] + ", " + state + question.slice(m.index + m[0].length);
  return { kind: "clarify", about: "which Kings County", question: "Which Kings County: New York or California?", options: [{ label: "Kings County, New York", question: withState("New York") }, { label: "Kings County, California", question: withState("California") }] };
}
/** P295 (Jeff 2026-11-24, QL-shr-bcdb4c61db): "share of murders where the victim was black" is a table by year: all the murder victims, those of that race, and the share. */
const RACE_WORDS = String.raw`(black|white|asian|african[-\s]american|american\s+indian|native\s+american|alaska\s+native|pacific\s+islander|native\s+hawaiian)`;
const SHARE_OF_RACE = new RegExp(String.raw`\b(?:what\s+|how\s+much\s+)?(?:share|percent(?:age)?|proportion)\s+of\s+(murder|homicide)s?(?:\s+where\s+(?:the\s+)?victims?\s+(?:was|were|is|are)\s+|\s+victims(?:\s+in\s+([a-z.' ,-]+?))?\s+(?:was|were|are|is)\s+)${RACE_WORDS}\b`, "i");
const RACE_LABEL = (w: string) => /black|african/i.test(w) ? "Black" : /^white/i.test(w) ? "White" : /asian/i.test(w) ? "Asian" : /hawaiian|pacific/i.test(w) ? "Native Hawaiian or Pacific Islander" : "American Indian or Alaska Native";
function shareOfRaceByYear(question: string, depsIn: ShadowDeps): ShadowOutcome | null {
  const m = SHARE_OF_RACE.exec(question);
  if (!m) return null;
  const crime = m[1].toLowerCase();
  const label = RACE_LABEL(m[3]);
  const o = shadowAnswer(question.replace(m[0], `${crime} victims by race by year${m[2] ? ` in ${m[2].trim()}` : ""}`), depsIn);
  const t = (o.kind === "shr" ? o.delivered.table : undefined) as { columns: { binding: unknown; header: string }[]; rows: (string | number | null)[][] } | undefined;
  if (o.kind !== "shr" || !t || t.columns.length !== 4 || t.columns[1].header !== "Victim's race" || !t.rows.length) return o;
  const years = [...new Set(t.rows.map((r) => String(r[0])))];
  const rows = years.map((y) => {
    const mine = t.rows.filter((r) => String(r[0]) === y);
    const total = mine.reduce((s, r) => s + (typeof r[2] === "number" ? r[2] : 0), 0);
    const n = mine.filter((r) => r[1] === label).reduce((s, r) => s + (typeof r[2] === "number" ? r[2] : 0), 0);
    return [y, total, n, total ? Math.round((n * 1000) / total) / 10 : null] as (string | number | null)[];
  });
  const noun = crime === "murder" ? "Murder" : "Homicide";
  const columns = [t.columns[0], { binding: { kind: "statistic" as const, as: "count" }, header: `${noun} victims` }, { binding: { kind: "statistic" as const, as: "count_race" }, header: `${label} victims` }, { binding: { kind: "statistic" as const, as: "share" }, header: "Share (%)" }];
  const first = o.delivered.text[0];
  const tm = first.match(/^(.*?) (?:Murder|Homicide) Victims by Year and the Victims' Race, (.*)$/);
  const title = tm ? `${tm[1]} Share of ${noun} Victims Who Were ${label}, ${tm[2].replace(/(\d{4})-(\d{4})/, "$1 to $2")}` : first;
  const evidence = rows.flatMap((r, ri) => [1, 2, 3].map((ci) => ({ row: ri, statistic: (columns[ci].binding as { as: string }).as, status: typeof r[ci] === "number" ? "VALUE" : "UNKNOWN" }))) as unknown as Delivered["evidence"];
  o.delivered = { ...o.delivered, table: { columns, rows }, evidence, chart: null, text: [title, ...o.delivered.text.slice(1)] } as typeof o.delivered;
  return o;
}
/** Jeff 2026-11-24 (QL-nibrs-00bfb752b5): "violent crime arrests by offense type" is the four violent offenses' arrests, offense type down the side, a column for each year. */
const VIOLENT_ARRESTS_BY_TYPE = /\bviolent\s+crime\s+arrests?(?:\s+trend)?\s+by\s+(?:offense|crime)\s+type\b/i;
export function shadowAnswer(question: string, depsIn: ShadowDeps): ShadowOutcome {
  if (VIOLENT_ARRESTS_BY_TYPE.test(question)) {
    const o = shadowAnswer(question.replace(VIOLENT_ARRESTS_BY_TYPE, "arrests for murder, rape, robbery and aggravated assault by year"), depsIn);
    const t = (o.kind === "answer" ? o.delivered.table : undefined) as { columns: { binding: unknown; header: string }[]; rows: (string | number | null)[][] } | undefined;
    if (o.kind === "answer" && t && t.columns.length === 5 && t.rows.length > 1) {
      const names = ["Murder", "Rape", "Robbery", "Aggravated assault"];
      const stat = t.columns[1].binding;
      const columns = [{ binding: { kind: "grouping" as const, dimension: "offense.category" }, header: "Offense type" }, ...t.rows.map((r) => ({ binding: stat, header: String(r[0]) }))];
      const rows = names.map((n, i) => [n, ...t.rows.map((r) => r[i + 1])]);
      const first = o.delivered.text[0];
      const m = first.match(/^(.*?) Murder Arrests Per Year, (.*)$/);
      const rest = o.delivered.text.filter((x) => !/^.* (?:Murder|Rape|Robbery|Aggravated Assault) Arrests Per Year, /.test(x));
      const title = m ? `${m[1]} Violent Crime Arrests by Offense Type Per Year, ${m[2]}` : first;
      const evidence = rows.flatMap((r, ri) => r.slice(1).map((v) => ({ row: ri, statistic: (t.columns[ri + 1].binding as { as?: string }).as ?? "count", status: typeof v === "number" ? "VALUE" : "UNKNOWN" }))) as unknown as Delivered["evidence"];
      o.delivered = { ...o.delivered, table: { columns, rows }, evidence, chart: null, text: [title, ...rest] } as typeof o.delivered;
    }
    return o;
  }
  { const sr = shareOfRaceByYear(question, depsIn); if (sr) return sr; }
  { const kc = kingsCountyAsk(question); if (kc) return kc; }
  if (JUVENILE_CRIME.test(question) && !/\b(?:victims?|offenders?|arrest\w*|murders?|homicides?|robbery|robberies|assaults?|burglar\w*|thefts?|rapes?|larcen\w*|shootings?|arsons?)\b/i.test(question) && !/\brates?\b/i.test(question)) { // a rates ask is never rewritten to arrests (P293)
    let q = question.replace(JUVENILE_CRIME, "juvenile arrests");
    // "trend of juvenile crime" asks for the years in a row, not for a crime to be named.
    if (/\btrends?\s+(?:of|in)\b/i.test(q)) q = q.replace(/\b(?:the\s+)?trends?\s+(?:of|in)\s+/i, "").replace(/\s*\?*\s*$/, /\b(?:per|by)\s+(?:year|month)\b/i.test(q) ? "" : " per year");
    const o = shadowAnswer(q, depsIn);
    if (o.kind === "answer" && !o.delivered.text.includes(ARRESTS_NOT_CRIMES)) {
      o.delivered.text.splice(1, 0, ARRESTS_NOT_CRIMES);
      // House form "Arrests of Arrestees Under 18" kept (Coordinator 2026-11-24: a global rewording is a separate card).
    }
    return o;
  }
  // Data the release does not hold: one plain sentence, before any other route can answer, clarify or add an example.
  if (DATA_ABSENT.test(question)) return decline("unsupported_capability", DATA_ABSENT_TEXT);
  if (MISDEMEANOR_ARREST.test(question)) return decline("unsupported_capability", MISDEMEANOR_TEXT);
  if (NATIONAL_MONTHLY_RATE.test(question)) return decline("unsupported_capability", DATA_ABSENT_TEXT);
  if (!depsIn.rewritten && !depsIn.checkingOffer && !DATA_ABSENT.test(question) && isOpenEnded(question, Number(depsIn.release.lastMonth.slice(0, 4))))
    return { kind: "clarify", about: "which part to show", question, options: [{ label: "Name a crime", entry: "which crime" }, { label: "Name a place", entry: "which city or agency" }, { label: "Name the years", entry: "which years" }] };
  { const pm = peakMeasure(question); if (pm && depsIn.historical) { const r = answerSrsPeak(pm); if (r.kind === "srs") return r as ShadowOutcome; } }
  // "Where do most robberies occur" asks for the nation-wide split by location: the statement is long, but it is what was asked, so it runs (as for a share) rather than waiting behind a button.
  const deps: ShadowDeps = depsIn.shareAsked === undefined ? { ...depsIn, shareAsked: clearanceTypeShareAsked(question) || WHERE_MOST_ONCE.test(question) } : depsIn;
  const o = withMeaningNotes(question, applyDefaults(question, withoutDeadButtons(shadowAnswerWithDeadButtons(question, deps)), deps), deps);
  const blank = allBlankMonthly(o);
  if (blank) return blank.kind === "decline" ? withYearlyOffer(blank, o, deps) : blank;
  // A question asked back is the user's own: the age words the reader took out ("teen offenders", "a kid offender") go back in.
  if (o.kind === "clarify" && typeof o.question === "string") {
    const restored = restoreAgeWords(o.question, readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).people);
    if (restored !== o.question) return { ...o, question: restored };
    // The source words ("in homicide reports") go back in too: the question asked back is the user's, with its source named.
    const squash = (t: string) => t.replace(/[?.!\s]+$/, "").replace(/\s+/g, " ").trim();
    if (SHR_WORDS.test(question) && squash(question.replace(SHR_WORDS, "")) === squash(o.question)) return { ...o, question: squash(question) };
  }
  return o;
}
/** The answer before dead buttons are dropped: for a caller that repairs a button's continuation first (the kind of assault). */
/**
 * P164 (Jeff 2026-11-19): "murder victims by race and sex" (also "victim race and gender", "victim age and sex") is one table of Homicide
 * Reports, the first detail down the side and the second across. Each detail alone is read as usual (the reader gives one breakdown per
 * answer); the two single answers must both reach Homicide Reports for the same place, period and conditions, and then the two-way
 * question is asked of the release. Anything else is left to the usual path (which declines a second breakdown).
 */
const TWO_DIM = String.raw`(race|sex|gender|ethnicity|age)`;
const TWO_WAY = new RegExp(String.raw`\bby\s+(?:the\s+)?${TWO_DIM}(?:\s+groups?)?\s*(?:,|and|&|\/)\s*(?:and\s+)?${TWO_DIM}(?:\s+groups?)?\b(?:\s+breakdown)?`, "i");
const TWO_NOUN = new RegExp(String.raw`\b(victim|offender)s?(?:'s|s')?\s+${TWO_DIM}\s+(?:and|&|\/)\s+${TWO_DIM}\b(?:\s+breakdown)?`, "i");
function shrTwoWay(question: string, deps: ShadowDeps): ShadowOutcome | null {
  if (!deps.shr || deps.checkingOffer) return null;
  const q = question.replace(TWO_NOUN, (_m, who: string, a: string, b: string) => `${who}s by ${a} and ${b}`);
  const m = TWO_WAY.exec(q);
  if (!m) return null;
  const attr = (w: string) => (/^gender$/i.test(w) ? "sex" : w.toLowerCase());
  const [a, b] = [attr(m[1]), attr(m[2])];
  if (a === b) return null;
  const one = (x: string) => shadowAnswer(q.replace(m[0], ` by ${x} `).replace(/\s+/g, " ").replace(/\s+([?.!,])/g, "$1").trim(), { ...deps, checkingOffer: true });
  const [o1, o2] = [one(a), one(b)];
  if (o1.kind !== "shr" || o2.kind !== "shr") return null;
  const [s1, s2] = [o1.question, o2.question];
  const person = (d: string | undefined) => !!d && /^(?:victim|offender)\./.test(d);
  if (!s1.breakdown || !s2.breakdown || !person(s1.breakdown.dim) || !person(s2.breakdown.dim) || s1.breakdown.dim === s2.breakdown.dim || s1.unit !== s2.unit) return null;
  const { breakdown2: _b2, ...rest } = s1;
  const sq: ShrQuestion = { ...rest, share: false, breakdown2: { dim: s2.breakdown.dim, ...(s2.breakdown.bins ? { bins: s2.breakdown.bins } : {}) } };
  const r = answerShr(sq, deps.shr, deps.execute, deps.historical);
  return r.kind === "shr" ? r : null;
}
/**
 * P215 (Jeff 2026-11-22): "Tulsa scorecard", "Ohio crime scorecard", "national crime scorecard" is the crime scorecard of lib/nibrs-shadow/scorecard.ts: nine rows,
 * Type | Offenses | Change from <prior year> | Rate per 100k | Clearance Rate (an agency only), from the Crime Index build. Only the place, "crime" and the word
 * itself: anything else keeps its path. A county scorecard is declined in one sentence until the county crosswalk lands; a city name that names several agencies
 * asks which, each choice the card of that agency.
 */
function scorecardOf(question: string, deps: ShadowDeps): ShadowOutcome | null {
  if (!deps.historical || !detectAgencyScorecardQuestion(question)) return null;
  const read = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth);
  const own = read.ledger.parts.filter((p) => p.clause === 0);
  const places = own.filter((p) => p.concept === "place");
  const word = (p: Part) => /^score[ \t-]*cards?$/i.test(p.text.trim());
  const other = own.filter((p) => p.concept !== "place" && p.state !== "context" && !(p.concept === "measure" && p.value === "unspecified") && !(p.state === "not-interpreted" && word(p)));
  if (places.length > 1 || other.length || flags(read.ledger).comparison) return null;
  const hb = deps.historical;
  const value = places.length ? String(places[0].value ?? "") : "national";
  const noPlace = !places.length;
  if (noPlace && deps.noDefaults) return null;   // P180: with the defaults off the ask stays an ask
  const run = (place: ScorecardPlace, label: string, scope: "agency" | "state" | "national", agency?: Agency): ShadowOutcome => {
    const r = buildScorecard(hb, deps.execute, place);
    if (r.kind === "none") return decline("outside_release_coverage", r.explanation);
    const periodYear = { from: `${r.year}-01`, to: `${r.year}-12` };
    const who = agency ? { ori: agency.ori, label, name: agency.name, state: agency.state } : null;
    return { kind: "historical", period: periodYear,
      question: { measure: "violent_crime", agencies: who ? [who] : [], from: r.year, to: r.year, byYear: false, statistic: "count", comparison: null, notes: r.text.slice(1) },
      meaning: { source: "historical", places: who ? [{ kind: "agency", ori: who.ori }] : [{ kind: scope }], filters: [], period: periodYear, measures: [{ name: "crime scorecard", unit: "offense" }], groupings: ["offense"], statistic: "count" },
      delivered: { table: r.table, text: [r.text[0], ...(noPlace ? ["No place was named, so the United States is shown."] : []), ...r.text.slice(1), "Source: Crime Index."] },
      read: { table: scope === "agency" ? "agency_crime" : scope === "state" ? "state_crime" : "nation_crime", column: "scorecard", release: hb.release } } as unknown as ShadowOutcome;
  };
  const cardLabel = (a: Agency) => `${a.name}, ${a.state}`;
  if (value === "national") return run({ kind: "national" }, "United States", "national");
  const st = /^state:(.+)$/.exec(value);
  if (st) {
    const code = Object.entries(STATE_NAMES).find(([, n]) => n.toLowerCase() === st[1].toLowerCase())?.[0];
    return code ? run({ kind: "state", code, name: stateName(code) }, stateName(code), "state") : null;
  }
  if (/^county:/.test(value)) return decline("unsupported_capability", "This isn't available: a county scorecard. Ask for the county's sheriff or police department.");
  if (!/^(?:city|ambiguous):/.test(value)) return null;
  const r = resolvePlace(deps.places, value, places[0].text);
  if (r.kind === "agency") return r.agency.kind === "county" && /\bcounty\b/i.test(places[0].text) && !/\b(?:sheriff|police)\b/i.test(places[0].text)
    ? decline("unsupported_capability", "This isn't available: a county scorecard. Ask for the county's sheriff or police department.")
    : run({ kind: "agency", ori: r.agency.ori, label: cardLabel(r.agency) }, cardLabel(r.agency), "agency", r.agency);
  if (r.kind === "ask") {
    const agencies = r.candidates.flatMap((c) => (c.kind === "agency" ? [c.agency] : []));
    if (!agencies.length) return null;
    const options: ShadowOption[] = r.candidates.map((c): ShadowOption => c.kind === "agency"
      ? { label: candidateLabel(c, r.candidates, deps.places), continuation: run({ kind: "agency", ori: c.agency.ori, label: cardLabel(c.agency) }, cardLabel(c.agency), "agency", c.agency) }
      : { label: candidateLabel(c, r.candidates, deps.places), continuation: run({ kind: "state", code: c.code, name: c.name }, c.name, "state") });
    return { kind: "clarify", about: `which ${r.name}`, question, options };
  }
  return null;
}
function shadowAnswerWithDeadButtons(question: string, deps: ShadowDeps): ShadowOutcome {
  const two = deps.rewritten ? null : shrTwoWay(question, deps);
  if (two) return two;
  // P215: the crime scorecard.
  const card = deps.rewritten ? null : scorecardOf(question, deps);
  if (card) return card;
  const os = deps.rewritten ? null : otherStates(question, deps);
  if (os) return os;
  const o = answerAsked(question, deps);
  return deps.rewritten ? o : clarifyInstead(question, o, deps) ?? o;
}

/** A question about the data itself (coverage.ts), answered; null when the question is something else. */
function coverageOf(question: string, deps: ShadowDeps): CoverageAnswer | null {
  const ledger = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
  const own = ledger.parts.filter((p) => p.clause === 0 && p.state === "recognized");
  const hasMeasure = own.some((p) => p.concept === "measure");
  const hasPlace = own.some((p) => p.concept === "place" && !/^state:|^national/.test(String(p.value)));
  const cq = readCoverage(question, hasMeasure, hasPlace);
  if (!cq) return null;
  return answerCoverage(cq, { root: deps.target.root, release: deps.release, execute: deps.execute,
    crimeIndexYears: deps.historical ? { first: deps.historical.firstYear, last: deps.historical.lastYear } : null });
}

/** P153 (Jeff 2026-11-18): a line, an annotation or a marker at a date on a chart ("with a line at August 2025", "add some kind of marker to show May 2020"). */
export const CHART_MARKER = new RegExp(String.raw`\b(?:with\s+(?:an?\s+|some\s+)?(?:vertical\s+|dotted\s+|dashed\s+)?(?:line|annotation|marker|label|note|flag)s?\s+(?:at|in|on|for|to\s+show)\b|(?:add|put|draw|mark|show|include)\s+(?:in\s+)?(?:an?\s+|some\s+(?:kind\s+of\s+)?)?(?:vertical\s+|dotted\s+|dashed\s+)?(?:line|annotation|marker|label|flag)s?\b[^.?!]*\b(?:(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}|\d{4})\b|(?:mark|highlight|annotate)\s+(?:the\s+)?(?:month\s+of\s+)?(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4})`, "i");
/**
 * P157 (Jeff 2026-11-19): any request to change a chart is declined with one sentence, whatever the change (a date marker, a trend or regression line,
 * axes, a reference line, shading, a title, and the chart type, labels, legend, gridlines, colors or sort that "presentation" edits used to answer with the
 * previous answer unchanged). The only real control named is the table's column-heading sort.
 */
export const CHART_MARKER_SENTENCE = "Changing a chart this way isn't available here. The table can be sorted by clicking a column heading.";
/** An instruction to change a chart beyond a date marker: a trend or regression line, axes, a reference line, shading, a chart title, fonts. */
export const CHART_EDIT = new RegExp([
  String.raw`\b(?:add|show|draw|fit|plot|include|with)\s+(?:an?\s+|some\s+)?(?:linear\s+)?(?:trend\s*-?\s*lines?|regression(?:\s+lines?)?)\b|\blinear\s+regression\b|\blines?\s+of\s+best\s+fit\b|\bbest[-\s]fit\b`,
  String.raw`\b(?:make|set|put|flip|swap|switch|start|change|use|map|move)\b[^.?!]*\b(?:(?:left|right|primary|secondary|second|dual|twin|y|x)[-\s]*axis|axes)\b|\b(?:max|min)(?:imum)?\b[^.?!]*\by[-\s]*axis\b|\by[-\s]*axis\b[^.?!]*\b(?:max|min|should)\b|\bdual[-\s]axis\b|\baxis\s+(?:scale|range|title|limits?|break)\b|\blog(?:arithmic)?\s+scale\b`,
  String.raw`\b(?:add|draw|put|show|include)\s+(?:in\s+)?(?:an?\s+|some\s+)?(?:horizontal\s+|reference\s+|benchmark\s+|average\s+|target\s+|vertical\s+|dotted\s+|dashed\s+)?lines?\b(?!\s+(?:chart|graph|for\s+the\s+(?:national|state)))`,
  String.raw`\b(?:shade|highlight|circle|call\s*out)\b[^.?!]*\b(?:bar|column|point|region|area)s?\b|\bchart\s+title\b|\bfonts?\b`,
  String.raw`\b(?:with|add|put|draw|mark|include)\s+(?:an?\s+|some\s+)?(?:annotation|marker|flag)s?\b`,
].join("|"), "i");
/** A request to change a chart (a date marker or any other change the page cannot make). */
export const isChartEdit = (turn: string) => CHART_MARKER.test(turn) || CHART_EDIT.test(turn);

/**
 * Cities ranked by the share of a crime cleared one way ("What 10 cities with at least 30 murders in 2025 had the highest share of murders cleared by
 * exception?", QL-nibrs-cff5d76134): read as the by-state share question of the same crime, clearance and year, answered per city agency (clearance-share.ts)
 * with the question's own bound: the cities with at least N of the crime reported that year, else the cities of 250,000 or more (P128; Jeff 2026-11-22).
 * One crime, one clearance (arrest or exception), one year, no place; anything else keeps its own path.
 */
export function cityClearanceShare(question: string, deps: ShadowDeps): { rewritten: string; cityShare: NonNullable<ShadowDeps["cityShare"]> } | null {
  const q = question.replace(/\s+/g, " ");
  if (!/\b(?:cities|agenc(?:y|ies))\b/i.test(q) || !/\bshares?\b|\bpercent(?:age)?\b|%/i.test(q)) return null;
  if (/\b(?:rates?|per\s+100,?000|by\s+(?:state|month|year|type)|each\s+(?:month|year|state)|compar\w+|vs\.?|versus|firearm|weapon|felony|misdemeanou?rs?|big|large\w*|major)\b/i.test(q)) return null;
  const clearance = /\bcleared\s+by\s+(exception(?:al)?(?:\s+means)?|arrest)\b/i.exec(q);
  const crime = /\b(murders?|homicides?|rapes?|robber(?:y|ies)|aggravated\s+assaults?|burglar(?:y|ies)|larcen(?:y|ies)(?:-theft)?s?|motor\s+vehicle\s+thefts?|arsons?)\b/i.exec(q);
  const years = [...q.matchAll(/\b(20\d{2}|19\d{2})\b/g)].map((m) => Number(m[1]));
  // One year, "since 2021", or "from 2021 to 2024" (several years are a ranking for each year, stacked, never pooled: P203/P173).
  const since = /\bsince\s+(?:the\s+year\s+)?(\d{4})\b/i.exec(q);
  const lastYear = Number(deps.release.lastMonth.slice(0, 4)), lastComplete = deps.release.lastMonth.endsWith("-12") ? lastYear : lastYear - 1;
  // "Since 2021" is the whole years through the last complete one (part of a year is not ranked), said in a note.
  const when = since ? (Number(since[1]) < lastComplete ? `from ${since[1]} to ${lastComplete}` : `in ${lastComplete}`) : years.length === 1 ? `in ${years[0]}` : years.length === 2 && /\b(?:to|through|thru|-|–|and)\b/i.test(q) ? `from ${Math.min(...years)} to ${Math.max(...years)}` : null;
  if (!clearance || !crime || !when) return null;
  const allAgencies = !/\bcities\b/i.test(q);
  const min = /\b(?:at\s+least|min(?:imum)?\.?\s+(?:of\s+)?)\s*(\d+)\s+(?:murders?|homicides?|rapes?|robber\w*|assaults?|burglar\w*|larcen\w*|thefts?|arsons?|offen[cs]es?)\b/i.exec(q);
  const limit = /\b(?:top|what|which|the)\s+(\d+)\s+cities\b/i.exec(q);
  const places = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger.parts.filter((p) => p.clause === 0 && p.concept === "place");
  if (places.length) return null;
  const how = /exception/i.test(clearance[1]) ? "by exception" : "by arrest";
  return { rewritten: `what share of ${crime[1]} were cleared ${how} ${when} in the United States by state`,
    cityShare: { ...(allAgencies ? { all: true } : {}), ...(since ? { note: `Since ${since[1]} is read as the whole years ${since[1]} to ${lastComplete}: the ${lastYear} data is not a whole year.` } : {}), minOffenses: min ? Number(min[1]) : null, limit: limit ? Number(limit[1]) : null, direction: /\b(?:lowest|fewest|bottom)\b|(?<!\bat\s)\bleast\b/i.test(q) ? "bottom" : "top" } };
}
function answerAsked(question: string, deps: ShadowDeps): ShadowOutcome {
  const cov = coverageOf(question, deps);
  if (cov) return cov;
  // A change to a chart is declined with one sentence, before any place or crime is asked (P157).
  if (isChartEdit(question)) return decline("unsupported_capability", CHART_MARKER_SENTENCE);
  // Cities ranked by a clearance share, answered per city agency (clearance-share.ts).
  const cityClear = deps.cityShare ? null : cityClearanceShare(question, deps);
  if (cityClear) return shadowAnswer(cityClear.rewritten, { ...deps, cityShare: cityClear.cityShare, rewritten: true });
  // With an SHR release, "murders by victim-offender relationship" is the relationship breakdown: the two words the
  // reader would read as two counting units are taken out of the question as asked, before it is read, so every other
  // part (a clearance, a year past the data) is read as usual (Codex SHR-A confirmations 01.7, 01.8).
  if (deps.shr && /\b(?:murders?|homicides?|killings?)\b/i.test(question) && /\bvictim[-\s]offender\s+relationships?\b/i.test(question))
    question = question.replace(/\bvictim[-\s]offender\s+(relationships?)\b/gi, "$1");
  // P38 (Jeff 2026-11-09): gang wording is declined first, before any place is asked or a forecast declined (Codex
  // review 19.2), with its reason; the next step never keeps the gang words.
  if (GANG.test(question)) {
    const ledger = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
    return withNextStep(decline("not_recorded_in_nibrs", UNDEFINED_TERM.gang), ledger, deps, question);
  }
  // P143 (Jeff 2026-11-18): "until January 2026" is through January 2026; "raw numbers, not rates" is counts; "coloradocrime" is "colorado crime".
  const plain = plainMeanings(question, deps.release.firstMonth);
  if (plain !== question) return shadowAnswer(plain, deps);
  // P141 (Jeff 2026-11-18): "LA" and "SF" listed with other cities are the cities, not asked and never the state.
  const listed = listedNicknames(question);
  if (listed !== question) return shadowAnswer(listed, deps);
  // "LA" (coordinator 2026-11-03): the city or the state, asked; each choice is the question with the place named.
  if (LA.test(question)) {
    const as = (name: string) => question.replace(LA, name);
    return { kind: "clarify", about: "which LA", question, options: [
      { label: "Los Angeles", continuation: shadowAnswer(as("Los Angeles"), deps) }, { label: "Louisiana", continuation: shadowAnswer(as("Louisiana"), deps) }] };
  }
  // The District of Columbia is Washington, D.C.: its police (the Metropolitan Police Department) cover the whole
  // District, and the state file has no row for it ("murders in the District of Columbia in 2024" said there were none:
  // bad-decline audit, 2026-11-06). "the District" in capitals is the same place.
  const asDC = question.replace(/\b(?:the\s+)?district\s+of\s+columbia\b/gi, "Washington, D.C.").replace(/\bthe\s+District\b(?!\s+of\b)/g, "Washington, D.C.");
  if (asDC !== question) return shadowAnswer(asDC, deps);
  const ledger = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
  // D14 (decided 2026-09-06): "Shootings in Chicago" asks fatal or non-fatal, each choice the question with the nearest
  // measure that exists: murders with a firearm, aggravated assaults with a firearm. Never when the words already say
  // which ("fatal", "killed", "homicide"); a choice that would only be declined is not offered (bad-decline audit root
  // cause 2, 2026-11-06).
  const shooting = ledger.parts.find((p) => p.clause === 0 && p.concept === "shooting");
  // Only bare "shooting(s)" beside nothing but a place, a period, a grain or a statistic: "shooting incidents" would
  // become victims, "police shootings" and "shootings of sheriffs" would lose who was shot (Codex root-causes reviews
  // 01.1-2, 02.1).
  // Also a total or a change ("total shootings per year", "the change in shootings"), and filler the reader left unread
  // ("I wanna see shootings nationwide"), which the choices leave out (ask instead of decline, Jeff 2026-11-10).
  const ALONE = new Set(["shooting", "place", "period", "grain", "statistic", "combine", "change"]);
  const fillerUnread = ledger.question === question && !COVERAGE_QUESTION.test(question)
    // Filler with no meaning of its own: "average" or "up" left out would change what the choices answer (Codex 01.2).
    ? ledger.parts.filter((p) => p.clause === 0 && p.state === "not-interpreted" && fillerOnly(p.text) && !meaningful(p.text)) : [];
  // Also "shooting incidents" and "people shot" (Jeff 2026-11-14, D14): the choices name what they count (aggravated assaults
  // with a firearm, murders with a firearm), so the words they replace lose nothing.
  const bareShooting = !!shooting && /^(?:shootings?|shooting\s+incidents?|people\s+(?:who\s+(?:were|got)\s+)?shot)$/i.test(shooting.text.trim())
    && !/\b(?:police|officers?|cops?|sheriffs?|deput(?:y|ies)|troopers?|law\s+enforcement)\b/i.test(question)
    && ledger.parts.every((p) => p.clause !== 0 || p.state === "context" || ALONE.has(p.concept) || fillerUnread.includes(p));
  if (shooting && bareShooting && !deps.rewritten && inOriginal(question, ledger, shooting, "") !== null && !/\b(?:fatal|non[-\s]?fatal|killed|killings?|homicides?|murders?|deadly|deaths?|died|wounded|injur(?:ed|ies|y)|mass)\b/i.test(question)) {
    let base = question;
    for (const p of [...fillerUnread].sort((a, b) => b.span[0] - a.span[0])) base = base.slice(0, p.span[0]) + " " + base.slice(p.span[1]);
    base = base.replace(/\s+/g, " ").trim();
    const as = (to: string) => inOriginal(base, ledger, shooting, to)!;
    // Jeff (2026-11-10): "Ask if fatal shootings in SHR or agg assaults with a firearm in NIBRS are okay", the two named
    // as such. Until Homicide Reports answer here, the fatal choice points to them (Jeff: "A is fine for now"), the one
    // button that doesn't run; the NIBRS choice runs, and the ask is made only when it does.
    const assaults = shadowAnswer(as("aggravated assaults with a firearm"), { ...deps, rewritten: true });
    // Jeff 2026-11-14 ("If somebody asks for shootings it says we don't track non-fatal shootings but they can choose firearm
    // murders (SHR) or aggravated assault involving a firearm (NIBRS)"): the sentence is the ask, the two choices named with
    // their sources. Each choice that runs is offered, the one that can't is left out and said (never a dead button); the
    // SHR choice only when the answer really comes from Homicide Reports; the ask is made when at least one runs.
    const fatal = shadowAnswer(as("murders with a firearm"), { ...deps, rewritten: true });
    const fatalShr = runsNow(fatal) ? onlyHomicideReports(fatal) : null;
    const assaultsRun = runsNow(assaults), fatalRuns = !!fatalShr;
    if (assaultsRun || fatalRuns) {
      const options: ShadowOption[] = [];
      if (fatalShr) options.push({ label: "Firearm murders", continuation: fatalShr });
      if (assaultsRun) options.push({ label: "Aggravated assault involving a firearm (NIBRS)", continuation: assaults });
      const gone = !assaultsRun ? { what: "Aggravated assault involving a firearm (NIBRS)", why: (assaults as { explanation?: string }).explanation ?? "" }
        : !fatalRuns ? { what: "Firearm murders", why: (fatal as { explanation?: string }).explanation ?? "Homicide Reports don't answer it for the periods offered here." } : null;
      return { kind: "clarify", about: SHOOTING_ASK, question, options, ...(gone ? { note: `${gone.what} isn't available for this question: ${gone.why}`.trim() } : {}) };
    }
  }
  // A bare "assault" (coordinator 2026-11-06, "San Francisco assaults per month"): Crime Index and Current Trends hold
  // aggravated assault only, so their answer is given, named as aggravated assaults; asking would offer one choice.
  // Where NIBRS answers, which kind is asked, offering only the kinds that run.
  const assault = ledger.parts.find((p) => p.clause === 0 && p.concept === "measure" && p.value === "assault");
  if (assault && !deps.assaultAsked) {
    // Never a rewrite that could lose the user's words: said plainly instead (Codex ties/P75 review 02).
    // Once only: a rewritten question that still reads a bare assault is declined, never rewritten again.
    if (deps.rewritten || inOriginal(question, ledger, assault, "", ASSAULT_QUALIFIED) === null)
      return decline("reader", "I couldn't tell which assaults this asks about. Name the kind, for example \"aggravated assaults in Houston in 2024\".");
    const as = (to: string) => inOriginal(question, ledger, assault, to, ASSAULT_QUALIFIED)!;
    const plural = /s$/i.test(assault.text.trim());
    const again = { ...deps, rewritten: true };
    const aggravated = shadowAnswer(as(plural ? "aggravated assaults" : "aggravated assault"), again);
    if (aggravated.kind === "historical" || aggravated.kind === "srs" || aggravated.kind === "current") return aggravated;
    // Something else is missing first (which place, which period, which New York): the question goes on as asked, so
    // that is asked first; the kind of assault is asked once the rest is known (scorecard 2026-11-06).
    if (aggravated.kind !== "clarify") {
      const options = [["Aggravated assault", "aggravated assaults"], ["Simple assault", "simple assaults"], ["Intimidation", "intimidation"],
        ["All assaults (aggravated, simple and intimidation)", "all assaults"]]
        .map(([label, to]) => ({ label, continuation: to === "aggravated assaults" && plural ? aggravated : shadowAnswer(as(to), again) })).filter((o) => runsNow(o.continuation));
      if (options.length > 1) return { kind: "clarify", about: "which assaults", question, options };
      if (options.length === 1) return options[0].continuation;
    }
    // Nothing runs, or something else is missing first: the question goes on as asked, so a decline and its buttons are
    // of the user's words, never the rewritten question's (scorecard 2026-11-06: "the count of and aggravated
    // assaults"). A button that names a period or the nation is the user's question with it, so the kind of assault is
    // still settled by the rule above once the rest is known.
    const asked = shadowAnswerWithDeadButtons(question, { ...deps, assaultAsked: true });
    // Declined as asked, but asked something else once the kind is named ("which New York"): that question, whose
    // answers name aggravated assaults plainly, rather than a decline.
    if (asked.kind === "decline" && aggravated.kind === "clarify" && aggravated.options.some(optionRuns))
      return { ...aggravated, question };
    // Up to three choices in a row ("assaults" -> the United States -> a year: Codex ties review 03), never more.
    if (asked.kind !== "clarify" || (deps.rebuilt ?? 0) >= 3) return asked;
    const base = question.replace(/[?.!\s]+$/, "");
    const suffix = (label: string) => {
      const y = /^The latest complete year \((\d{4})\)$/.exec(label);
      return y ? ` in ${y[1]}` : label === "This year so far" ? " this year" : label === "Every year available" ? " by year"
        : label === "The last 10 complete years" ? " over the last 10 years" : label === "The United States" ? " in the United States" : null;
    };
    return { ...asked, options: asked.options.map((o) => {
      const s = isDeferred(o) || o.continuation ? suffix(o.label) : null;
      if (s && isDeferred(o)) {
        // A heavy choice stays unbuilt: its rebuilt question is built when it is chosen (and the old answer stands if that one does not run).
        const rest: Record<string, unknown> = {};
        for (const k of Object.keys(o)) if (k !== "continuation" && k !== "label") rest[k] = (o as unknown as Record<string, unknown>)[k];
        return deferHeavy(o.label, (d) => { const c = shadowAnswer(base + s, { ...d, rebuilt: (deps.rebuilt ?? 0) + 1 }); return runsNow(c) ? c : o.continuation!; }, deps, rest as Partial<ShadowOption>);
      }
      const c = s ? shadowAnswer(base + s, { ...deps, rebuilt: (deps.rebuilt ?? 0) + 1 }) : null;
      return c && runsNow(c) ? { ...o, continuation: c } : o;
    }) };
  }
  // A misspelled large place (coordinator 2026-11-03: "batlimore", "phialdelphia"): the question with the place's name,
  // when exactly one large place is that close and the words aren't a place the index has.
  for (const p of ledger.parts) {
    if (p.clause !== 0 || p.concept !== "place" || !/^(city|ambiguous):/.test(p.value ?? "")) continue;
    if (resolvePlace(deps.places, p.value!, p.text).kind !== "unresolved") continue;
    const word = p.text.trim().replace(/[?.!,]+$/, "");
    const near = nearestPlaceName(deps.places, word);
    if (near && question.includes(word)) return shadowAnswer(question.replace(word, near), deps);
  }
  // An unread word the geo resolver didn't try ("Philadlephia murders 2024": a place first, no "in" before it;
  // coordinator 2026-11-05): the whole unread phrase, then each word in it, as a misspelled large place. Never in
  // silence: an ordinary word can be one letter from a city ("fontina", "Concorde": Codex spelling review 03), so the
  // place is offered first when the question asks which place, and nothing changes otherwise. Only when the question
  // names no place of its own: "bolder robberies in Philadelphia" is not Boulder too (Codex spelling review 01).
  const ownPlace = ledger.parts.some((p) => p.clause === 0 && p.concept === "place" && p.state === "recognized");
  let offer: ShadowOption | null = null;
  for (const p of ownPlace ? [] : ledger.parts) {
    if (offer || p.clause !== 0 || p.concept !== "unrecognized" || p.state !== "not-interpreted") continue;
    const phrase = p.text.trim().replace(/[?.!,]+$/, "");
    for (const word of [phrase, ...phrase.split(/\s+/)].filter((w, i, all) => w.length >= 4 && all.indexOf(w) === i)) {
      const near = nearestPlaceName(deps.places, word, true);
      const at = new RegExp(String.raw`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z])`);
      if (!near || !at.test(question)) continue;
      const continuation = shadowAnswer(question.replace(at, near), deps);
      if (runsNow(continuation)) { offer = { label: near, continuation }; break; }
    }
  }
  const base = withNextStep(everyBreakdown(question, nibrsHasNoReports(fromLedger(ledger, { ...deps, asked: deps.asked ?? question }), ledger, deps)), ledger, deps, question);
  return offer && base.kind === "clarify" && base.about === "which place" ? { ...base, options: [offer, ...base.options] } : base;
}

/**
 * NIBRS asked for by name where an agency has no NIBRS reports (Jeff 2026-11-15, approved wording): the question is
 * declined, naming the agencies, and Crime Index offered as the one option (the question without the NIBRS words runs
 * from Crime Index, the default). Only where every month shown is unknown for the agency (no reports at all).
 */
function nibrsHasNoReports(o: ShadowOutcome, ledger0: RequestLedger, deps: ShadowDeps): ShadowOutcome {
  if (o.kind !== "answer" || !flags(ledger0).nibrsAsked) return o;
  const places = o.plan.geography.places.filter((p) => p.kind === "agency") as { kind: "agency"; ori: string; label: string }[];
  if (!places.length || places.length !== o.plan.geography.places.length) return o;
  const evidence = o.delivered.evidence;
  if (!evidence.length) return o;
  const rows = o.delivered.table.rows;
  let bad: typeof places;
  if (places.length === 1) bad = evidence.every((e) => e.status === "UNKNOWN") ? places : [];
  else {
    // Several agencies: the table's first column names each (by month); the agency's rows all unknown.
    const gi = o.delivered.table.columns.findIndex((c) => c.binding.kind === "grouping" && c.binding.dimension.startsWith("geo."));
    if (gi < 0) return o;
    bad = places.filter((p) => {
      const mine = rows.map((r, i) => (r[gi] === agencyName(deps.places, p.ori) ? i : -1)).filter((i) => i >= 0);
      return mine.length > 0 && mine.every((i) => evidence.find((e) => e.row === i)?.status === "UNKNOWN");
    });
  }
  if (!bad.length) return o;
  const named = places.length === 1 ? `the ${agencyName(deps.places, bad[0].ori)}` : (() => { const n = bad.map((p) => p.label.split(",")[0]); return n.length > 2 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : n.join(" and "); })();
  const question = ledger0.question.replace(/[?.!\s]+$/, "");
  return decline("not_recorded_in_nibrs", `NIBRS has no data from ${named} in this period.`,
    { alternative: { label: `Ask instead: "${question}"`, question, role: "other_source", targetSource: "historical" } });
}

/** The groupings an answer has, as dimensions (Historical's and the historical file's: by year or not). */
export function answerDimensions(o: ShadowOutcome): string[] | null {
  // The same months of each year: a table of years, whatever the source's own grouping of the months.
  if ((o as { sameMonths?: boolean }).sameMonths) return ["time.year"];
  if (o.kind === "answer") return o.plan.groupings.map((g) => g.dimension);
  if (o.kind === "historical" || o.kind === "srs") return o.question.byYear ? ["time.year"] : [];
  if (o.kind === "current") return o.question.form === "months" ? ["time.month"] : [];
  return null;
}
/**
 * A requested breakdown is never silently dropped (coordinator 2026-11-02): every breakdown the question names
 * (named-groupings.ts) is a grouping of the answer, or the question is declined. A clarify's choices are checked the
 * same way, since each answers this question.
 */
function everyBreakdown(question: string, o: ShadowOutcome, yearlyStandsIn = false): ShadowOutcome {
  // A yearly choice offered on purpose beside monthly ones (span choices, Jeff 2026-11-14) replaces the months asked, and
  // only the months: any other breakdown the question names is still checked (Codex span review 07).
  if (o.kind === "clarify") return { ...o, options: o.options.map((x) => mapOption(x, (c) => everyBreakdown(question, c, x.role === "by_year"))) };
  const dims = answerDimensions(o);
  if (!dims) return o;
  const stands = yearlyStandsIn || !!(o as { spanChoice?: boolean }).spanChoice;
  const missing = missingGroupings(question, dims).filter((m) => !(stands && m === "month"));
  return missing.length ? decline("unsupported_capability", `This isn't available: this answer by ${missing.join(" and ")} together with the rest of the question.`,
    { detail: `breakdown dropped: ${missing.join(", ")}` }) : o;
}

/**
 * Increment 7b (P69): a follow-up's outcome, with the standalone question it was rewritten to (shown above the answer,
 * editable) or null when the app asks instead. `presentation`: a chart-only edit; the data question is unchanged and the
 * page's controls change the chart.
 */
/**
 * P69 amendment (Jeff 2026-10-31): a model's rewrite, proposed as "Did you mean: <proposed>?" with Run and Edit. Nothing
 * is read, compiled or run for it: no plan, no SQL, no continuation; Run asks the proposed question as a new one.
 */
export type ProposalOutcome = { kind: "proposal"; question: string; proposed: string; how: string; rewrite: string; rewriteKind: "propose" };
export type FollowUpOutcome = (ShadowOutcome & { rewrite: string | null; rewriteKind: Exclude<Rewrite["kind"], "propose">; presentation?: true }) | ProposalOutcome;
export function shadowFollowUp(previous: string, followUp: string, deps: ShadowDeps, rewriter: FollowUpRewriter = deterministicRewriter): FollowUpOutcome {
  // P38: a follow-up in gang words ("only gang-related", "what about gangs?") is declined as a first question would be,
  // with no follow-up reading offered (Codex review 19.2, 19.3).
  if (GANG.test(followUp)) return { ...shadowAnswer(followUp, deps), rewrite: followUp, rewriteKind: "new" };
  // P157: a request to change a chart (a marker, a line, axes) is declined with the one chart sentence, not asked about the last question.
  if (isChartEdit(followUp)) return { ...decline("unsupported_capability", CHART_MARKER_SENTENCE), rewrite: followUp, rewriteKind: "new" } as FollowUpOutcome;
  // The same question sent again (follow-ups #5, coordinator 2026-11-21: 77 real turns) is a first question: the same answer or ask as before,
  // never "what does this change".
  const same = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (same(followUp) && same(followUp) === same(previous)) return { ...shadowAnswer(followUp, deps), rewrite: followUp, rewriteKind: "new" };
  // "Is it getting better?" (Jeff 2026-11-18): a verdict is not given; the decline says so and offers a comparison built from the previous
  // question, the latest complete year against the year before.
  if (JUDGEMENT.test(followUp)) {
    const lastY = Number(deps.release.lastMonth.slice(0, 4)) - (deps.release.lastMonth.endsWith("-12") ? 0 : 1);
    const offered = judgementOffer(previous, lastY, deps.historical?.firstYear ?? 2017);
    const out = decline("unsupported_capability", JUDGEMENT_SENTENCE);
    const runs = !!offered && !deps.checkingOffer && ["answer", "historical", "srs", "current", "shr", "hate", "coverage"].includes(shadowAnswer(offered, { ...deps, checkingOffer: true }).kind);
    return { ...(runs ? { ...out, alternative: { label: `Ask instead: "${offered}"`, question: offered! } } : out), rewrite: followUp, rewriteKind: "new" } as FollowUpOutcome;
  }
  // A question about the data itself ("Sources?", "what states are not represented?") is answered on its own, whatever came before.
  const about = coverageOf(followUp, deps);
  if (about) return { ...about, rewrite: followUp, rewriteKind: "new" };
  // Follow-up #4 (coordinator 2026-11-22): a short reply to the app's own ask ("mass" after "which Springfield", "2", "for the us", "murder
  // trends" after "which kind of crime") is that button pressed, or the asked-for part filled in.
  if (!standsAlone(followUp)) {
    const replied = replyToAsk(previous, followUp, deps);
    if (replied) return replied;
  }
  // A turn that stands on its own (its own crime and place, nothing pointing back) is a new question: answered as a
  // first question would be, the previous turn ignored (Jeff 2026-11-01). When the rules would have read it as a
  // follow-up meaning something else, that reading is offered as a button, run only when chosen.
  if (standsAlone(followUp)) {
    const o = shadowAnswer(followUp, deps);
    const r0 = deterministicRewriter.rewrite(previous, followUp);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    // A new question with no period of its own, after a question with one (real turns: "murder count in richmond" after "richmond virginia
    // murders 2020-2025"): follow-up #1 (Jeff 2026-11-21) carries the period over, says so, and offers the question as typed. Before, it was
    // only offered.
    const year = Number(deps.release.lastMonth.slice(0, 4));
    const prevPeriod = carryablePeriod(previous, followUp, year);
    const ownPeriod = readQuestion(followUp, year).ledger.parts.some((p) => p.clause === 0 && p.concept === "period" && p.state === "recognized");
    const withPeriod = !ownPeriod && prevPeriod ? `${followUp.trim().replace(/[?.!]+$/, "")} ${prevPeriod}` : null;
    const other = r0.kind === "rewrite" && norm(r0.question) !== norm(followUp) ? r0.question : withPeriod;
    if (withPeriod && other === withPeriod && !deps.checkingOffer) {
      const carried = shadowAnswer(withPeriod, deps);
      if (ANSWER_KINDS.includes(carried.kind)) return { ...carriedOver(carried, ["period"], followUp), rewrite: withPeriod, rewriteKind: "new" };
    }
    const offer: ShadowOption | null = other ? { label: `Did you mean a follow-up to your last question? "${other}"`, question: other } : null;
    const withOffer = !offer ? o : o.kind === "answer" ? { ...o, buttons: [...(o.buttons ?? []), offer] }
      : o.kind === "clarify" ? { ...o, options: [offer, ...o.options] } : o.kind === "decline" && !o.alternative ? { ...o, alternative: offer } : o;
    return { ...withOffer, rewrite: followUp, rewriteKind: "new" };
  }
  const r = rewriter.rewrite(previous, followUp);
  // 284's re-gate: a follow-up answered from a rewrite or as its own question leans on what was typed and asked before, so the default guards
  // read both ("compare with statewide ..." rewrites to the state alone; "Durham, North Carolina and population" after a larceny-from-motor-vehicle
  // question). Either would otherwise be answered in part by a default.
  const guarded: ShadowDeps = { ...deps, guardText: `${followUp}\n${previous}` };
  // P157: a presentation-only edit (chart type, labels, legend, gridlines, colors, sort, "as a table", "hide the chart") used to return the previous
  // answer unchanged with nothing said; the page has no control for it, so it is declined with the one chart sentence.
  if ((r.kind as string) === "presentation") return { ...decline("unsupported_capability", CHART_MARKER_SENTENCE), rewrite: followUp, rewriteKind: "new" } as FollowUpOutcome;
  // A proposal returns before anything runs.
  if (r.kind === "propose") return { kind: "proposal", question: followUp, proposed: r.question, how: r.how, rewrite: r.question, rewriteKind: "propose" };
  // PR1 (follow-up failures, Jeff 2026-11-19): a turn the rules find no edit in, that points back at nothing, is read as a question of its own
  // ("show me robberies and murders in the southwest" asked what it changes in the last question). Its first-turn answer or ask is given; when
  // that would be a decline (words unread, a combination not offered) the question back about the last turn stays, as before.
  if (r.kind === "ask" && !pointsBack(followUp) && followUp.trim().split(/\s+/).length >= 3) {
    // Follow-up #1 (Jeff 2026-11-21): a place or period it leaves out comes from the previous question when that named one, before any
    // default (P180, P181); the answer says what was carried.
    const carried = carryOver(previous, followUp, guarded);
    if (carried) return carried;
    const own = shadowAnswer(followUp, guarded);
    if (own.kind !== "decline") return { ...own, rewrite: followUp, rewriteKind: "new" };
  }
  if (r.kind === "ask") {
    // P69: uncertain, so ask; each option is a complete question, run as a new one. With none, the user rephrases. An
    // option is offered only when the reader reads it whole (Codex decline review 01: "...victims with a female offender"
    // is two counting units).
    const offered = r.options.filter((o) => readsWhole(o.question, Number(deps.release.lastMonth.slice(0, 4))));
    const options: ShadowOption[] = offered.length ? offered.map((o) => ({ label: o.label, continuation: shadowAnswer(o.question, deps) }))
      : [{ label: "Ask the full question", entry: "the full question" }, { label: "Start over", entry: "a new question" }];
    const asked = withoutDeadButtons({ kind: "clarify", about: r.why, question: followUp, options });
    return { ...asked, rewrite: null, rewriteKind: "ask" };
  }
  return { ...shadowAnswer(r.question, guarded), rewrite: r.question, rewriteKind: r.kind, ...(r.kind === "presentation" ? { presentation: true as const } : {}) };
}

const RANKING_WORDS = /\b(?:top|bottom|highest|lowest|most|fewest|rank\w*|worst|best|largest|biggest|smallest)\b/i;
// "knife murders nationally" names the nation in words the reader doesn't take as a place (PR 312 gate); the previous place is not carried.
const NATIONAL_WORDS = /\b(?:national(?:ly)?|nation\s*wide|united states|usa|(?:in|across) the (?:country|nation))\b|\bu\.s\./i;
const YEAR_SERIES =/\b(?:per|by|each|every)\s+year\b|\byearly\b|\bannual(?:ly)?\b|\byear[- ](?:by|over)[- ]year\b|\btrend\b/i;
/**
 * The previous question's period, when follow-up #1 may carry it (PR 312 gate): the previous turn must be a data question (its own crime;
 * not "remove 2025 as it has missing data" or "why does county only exist ... around the 60s and 70s"), and one year is not carried into
 * a turn asking for years ("murders per year in Kansas City" after "... cities of 250k or more in 2025").
 */
function carryablePeriod(previous: string, followUp: string, year: number): string | null {
  const parts = readQuestion(previous, year).ledger.parts.filter((p) => p.clause === 0 && p.state === "recognized");
  if (!parts.some((p) => p.concept === "measure")) return null;
  const t = parts.find((p) => p.concept === "period")?.text.trim();
  if (!t) return null;
  const oneYear = (t.match(/\b\d{4}\b/g) ?? []).length === 1 && !/\b(?:since|from|past|last|through|to|until|after)\b|[-–]/i.test(t);
  return oneYear && YEAR_SERIES.test(followUp) ? null : t;
}
/**
 * Follow-up #1 (Jeff 2026-11-21): a follow-up read as its own question, with its own crime, that leaves out the place or the period gets them
 * from the previous question when that one named them. A follow-up across places (a ranking, "cities", "agencies") keeps its own reading: the
 * previous place would narrow it. Only an answer is taken; otherwise the follow-up goes on as before.
 */
function carryOver(previous: string, followUp: string, deps: ShadowDeps): FollowUpOutcome | null {
  if (deps.checkingOffer) return null;
  const year = Number(deps.release.lastMonth.slice(0, 4));
  const read = (q: string) => readQuestion(q, year).ledger.parts.filter((p) => p.clause === 0 && p.state === "recognized");
  const mine = read(followUp), prev = read(previous);
  const has = (c: string) => mine.some((p) => p.concept === c);
  if (!has("measure") || !prev.some((p) => p.concept === "measure")) return null;
  const add: string[] = [], what: ("place" | "period")[] = [];
  const place = prev.find((p) => p.concept === "place"), period = carryablePeriod(previous, followUp, year) ? prev.find((p) => p.concept === "period") : undefined;
  if (place && !has("place") && !has("entity") && !RANKING_WORDS.test(followUp) && !NATIONAL_WORDS.test(followUp)) {
    const t = place.text.trim();
    add.push(/^(?:in|for|across)\b/i.test(t) ? t : `in ${t}`);
    what.push("place");
  }
  if (period && !has("period")) { add.push(period.text.trim()); what.push("period"); }
  if (!add.length) return null;
  const q = `${followUp.trim().replace(/[?.!]+$/, "")} ${add.join(" ")}`;
  const o = shadowAnswer(q, deps);
  if (!ANSWER_KINDS.includes(o.kind)) return null;
  return { ...carriedOver(o, what, followUp), rewrite: q, rewriteKind: "new" };
}
const REPLY_FILLER = /\b(?:please|pls|thanks?|thank you|great|ok(?:ay)?|yes|yeah|sure|is good|is fine|works|the|one|option|number|choice|i want|i meant?|just|go with|lets do|let's do)\b/g;
const ORDINALS = ["first", "second", "third", "fourth", "fifth"];
/**
 * Follow-up #4 (coordinator 2026-11-22, 153 real turns typed after an ask): when the previous turn was the app's ask, a short reply is read
 * as the answer to it. A choice named or numbered ("Massachusetts", "violent", "2", "the first one") is that button pressed. Otherwise the
 * part that was asked for is filled in from the reply: a place ("In Tucson Arizona", "for the us"), a period ("2024 is good"), or a crime
 * ("murder trends" after "Tacoma"). A reply that adds anything else, or leads nowhere new, goes on as before.
 */
function replyToAsk(previous: string, followUp: string, deps: ShadowDeps): FollowUpOutcome | null {
  if (deps.checkingOffer || followUp.trim().split(/\s+/).length > 6) return null;
  // Whether the previous turn was an ask needs no data: read it with an executor that returns nothing, so an answered previous
  // question is not run again just to find that out.
  let asked: ReturnType<typeof shadowAnswer>;
  try { asked = shadowAnswer(previous, { ...deps, execute: () => [] }); } catch { return null; }
  if (asked.kind !== "clarify" || !asked.question.trim()) return null;
  // It was an ask: read it again with the real executor, since its buttons carry the continuations that the data builds.
  asked = shadowAnswer(previous, deps);
  if (asked.kind !== "clarify" || !asked.question.trim()) return null;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(REPLY_FILLER, " ").replace(/\s+/g, " ").trim();
  const t = norm(followUp);
  const pressable = asked.options.filter((o) => !o.entry && !o.otherSource && (o.question || "continuation" in o));
  const press = (o: ShadowOption): FollowUpOutcome => {
    // Which of two places of one name ("which Springfield"): the place chosen stands where the name was typed.
    const base = asked.question.trim().replace(/[?.!]+$/, "");
    const name = /^which /.test(asked.about) ? asked.about.slice(6) : "";
    const at = name && o.label.toLowerCase().startsWith(name.toLowerCase()) ? new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i") : null;
    const q = o.question ?? (at && at.test(base) ? base.replace(at, o.label) : `${base}, ${o.label}`);
    // Typed as a question, the choice gets the defaults a first question gets (P180-P182); a button built inside the ask doesn't, so it is
    // the fallback.
    const typed = shadowAnswer(q, deps);
    const out = o.question || ANSWER_KINDS.includes(typed.kind) ? typed : o.continuation!;
    return { ...out, rewrite: q, rewriteKind: "new" } as FollowUpOutcome;
  };
  // A choice by number or order.
  const n = /^#?(\d)$/.test(t) ? Number(t.replace("#", "")) : ORDINALS.indexOf(t.replace(/^(\d)(?:st|nd|rd|th)$/, (_, d) => ORDINALS[Number(d) - 1] ?? "")) + 1;
  if (n >= 1 && n <= asked.options.length) { const o = asked.options[n - 1]; return pressable.includes(o) ? press(o) : null; }
  // A choice by name: every word typed starts a word of exactly one button's label.
  const words = t.split(" ").filter((w) => w.length >= 2);
  if (words.length) {
    const hits = pressable.filter((o) => { const lw = norm(o.label).split(" "); return words.every((w) => lw.some((l) => l === w || (w.length >= 3 && l.startsWith(w)))); });
    if (hits.length === 1) return press(hits[0]);
    if (hits.length > 1) return null;
  }
  // The part asked for, filled in from the reply; never a reply that points back or compares ("Compare this to Raleigh", "Now give me Dallas").
  const reply = followUp.replace(/^\s*(?:what|how)\s+about\s+/i, "");
  if (pointsBack(reply) || /\b(?:compar\w*|vs\.?|versus|against|now|instead)\b/i.test(reply)) return null;
  const year = Number(deps.release.lastMonth.slice(0, 4));
  const read = (q: string) => readQuestion(q, year).ledger.parts.filter((p) => p.clause === 0 && p.state === "recognized");
  const mine = read(followUp), has = (c: string) => mine.some((p) => p.concept === c);
  const base = asked.question.trim().replace(/[?.!]+$/, "");
  const bare = (s: string) => s.trim().replace(/^(?:in|for|across|from|during)\s+/i, "");
  let q: string | null = null;
  if (asked.about === "which place" && !has("measure")) {
    const place = mine.find((p) => p.concept === "place");
    q = NATIONAL_WORDS.test(followUp) || /\b(?:the (?:us|whole country|country)|america)\b/i.test(followUp) ? `${base} nationally` : place ? `${base} in ${bare(place.text)}` : null;
  } else if (asked.about === "which period" && !has("measure")) {
    const period = mine.find((p) => p.concept === "period");
    q = period ? `${base} ${period.text.trim()}` : null;
  } else if (asked.about === "which kind of crime" && has("measure") && !has("place")) {
    const place = read(asked.question).find((p) => p.concept === "place");
    q = place ? `${followUp.trim().replace(/[?.!]+$/, "")} in ${bare(place.text)}` : null;
  }
  if (!q) return null;
  const o = shadowAnswer(q, deps);
  if (o.kind === "decline" || (o.kind === "clarify" && o.about === asked.about)) return null;
  return { ...o, rewrite: q, rewriteKind: "new" };
}
/** The answer with a note after its title saying what came from the last question, and a button for the question as typed. */
function carriedOver(o: ShadowOutcome, what: ("place" | "period")[], typed: string): ShadowOutcome {
  const x = o as ShadowOutcome & { delivered: { text: string[] }; buttons?: ShadowOption[] };
  const note = `The ${what.join(" and ")} ${what.length > 1 ? "are" : "is"} from your last question.`;
  const text = [x.delivered.text[0], note, ...x.delivered.text.slice(1)];
  return { ...x, delivered: { ...x.delivered, text }, buttons: [...(x.buttons ?? []), { label: `As typed: "${typed}"`, question: typed }] } as ShadowOutcome;
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
const COURT_SENTENCE = "NIBRS covers crimes reported to police, arrests and clearances. It doesn't include charges or court outcomes (prosecutions, trials, convictions, sentences or defendants).";
const UNDEFINED_TERM: Record<string, string> = {
  shooters: "The data lists offenders and the weapons used, not who fired a gun, so \"shooters\" can't be counted.",
  "gun violence": "The data has no counts of non-fatal shootings, so gun violence cannot be counted. It can count gun crime: murders, robberies and aggravated assaults with a firearm.",
  gang: "Gang involvement is loosely defined and inconsistently reported to the FBI, so counts of gang-related crime would be misleading.",
};
/** P31's weapons, as the reader writes them. */
const WEAPON_CODES: Record<string, string[]> = { firearm: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"], knife: ["20"] };
/** P29/P49: "by men and women" (both sexes) names the offenders' sexes. */
const BY_SEXES = /\bby\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/i;
/** Homicide Reports' (FBI SHR) first year. */
/**
 * A murder detail answered from Homicide Reports (Jeff S1, 2026-11-11), or null when there is no SHR build or the plan
 * asks for something SHR doesn't record the same way (the caller keeps its own path). Periods resolve against the SHR
 * release's latest month; a span starting before 1985 is answered from 1985 and says so (J1, option A).
 */
/** A hate crime question from the hate crime data (hate.ts), or null when there is no build or it is asked in a way this source does not answer. */
function hateOutcome(plan: NibrsPlan, deps: ShadowDeps, ledger0: RequestLedger): ShadowOutcome | null {
  if (!deps.hate || flags(ledger0).consistent || flags(ledger0).quarter) return null;
  // What this count is not: a supporting column, a person's detail, a clearance, a property or composite count, or a unit other than incidents
  // ("hate crime victims"): declined, never answered as the plain count (Codex review 04, 05).
  const f = flags(ledger0);
  if (f.column || f.people || f.clearance || f.property || f.composite || f.combined || f.arrestsThrough || ledger0.parts.some((p) => p.clause === 0 && p.concept === "unit" && p.value !== "incidents")) return null;
  let period: { from: string; to: string };
  // No range named for a series: every year the hate crime data have, said (Jeff 2026-11-11, "All years by default").
  const allYears = plan.defaults.some((x) => x.path === "period");
  try {
    const r = resolvePeriod(plan.period, { ...deps.release, lastMonth: deps.hate.latestMonth });
    if (allYears) period = { from: `${HATE_FIRST_YEAR}-01`, to: deps.hate.latestMonth };
    else if (r.kind === "years") {
      const ys = [...r.years].sort((a, b) => a - b);
      if (ys.some((y, i) => i > 0 && y !== ys[i - 1] + 1)) return null;
      period = { from: `${ys[0]}-01`, to: `${ys[ys.length - 1]}-12` };
    } else period = { from: r.from, to: r.to };
  } catch { return null; }
  // Several places (B3, approved): each place asked on its own, put in one table with a Place column (never added together).
  if (plan.geography.places.length > 1) {
    const idOf = (p: NibrsPlan["geography"]["places"][number]) => JSON.stringify(p);
    const places = plan.geography.places.filter((p, i, all) => all.findIndex((q) => idOf(q) === idOf(p)) === i);
    if (places.length < 2 || places.length > 6) return null;
    const hqs: HateQuestion[] = [];
    for (const p of places) {
      const one = hateQuestionOf({ ...plan, geography: { ...plan.geography, places: [p] }, groupings: plan.groupings.filter((g) => g.dimension !== "geo.place") }, period, deps.hate, allYears);
      if ("why" in one) return null;
      hqs.push(one);
    }
    const multi = combineHatePlaces(hqs, deps.hate, deps.execute);
    return multi.kind === "hate" ? multi : decline("outside_release_coverage", multi.explanation);
  }
  const hq0 = hateQuestionOf(plan, period, deps.hate, allYears);
  // Several biases: the columns in the order the question names them (the plan's filters are in code order).
  const at = (code: string) => ledger0.parts.find((p) => p.clause === 0 && p.concept === "filter" && p.value === `bias:${code}`)?.span?.[0] ?? Infinity;
  const hq = !("why" in hq0) && hq0.biases ? { ...hq0, biases: [...hq0.biases].sort((a, b) => at(a.code) - at(b.code)) } : hq0;
  if ("why" in hq) {
    // A span wholly outside the data says where the data are (coverage), as every source does.
    if (hq.why === "before the data start") return decline("outside_release_coverage", `Hate crime data here start in ${HATE_FIRST_YEAR}, so ${notIncluded(Number(period.from.slice(0, 4)), Number(period.to.slice(0, 4)))}.`);
    if (hq.why === "after the latest month") return decline("outside_release_coverage", `${periodWords(period.from, period.to)} is not in the hate crime data; the latest complete month available is ${monthName(deps.hate.latestMonth)}.`);
    return null;
  }
  const direction = /\b(?:getting|gotten|got)\s+(?:worse|better)\b|\bgoing\s+(?:up|down)\b|\b(?:rising|falling|increasing|decreasing)\b|\bup\s+or\s+down\b/i.test([ledger0.question ?? "", ...(flags(ledger0).readings ?? []).map((r) => r.from)].join(" "));
  const a = answerHate({ ...hq, ...(allYears ? { allYears: true } : {}), ...(direction ? { direction: true } : {}) }, deps.hate, deps.execute);
  return a.kind === "hate" ? a : decline("outside_release_coverage", a.explanation);
}
function shrOutcome(plan: NibrsPlan, deps: ShadowDeps, ledger0: RequestLedger): ShadowOutcome | null {
  // Only agencies that reported every month, or quarters: NIBRS's own paths keep them (Codex SHR-A review 01.4, 01.5).
  if (!deps.shr || flags(ledger0).consistent || flags(ledger0).quarter) return null;
  // No period named: the period is asked, as on NIBRS's path, never a default year answered (job SA1: "firearm murders
  // in Philadelphia" is labelled to ask which period).
  // Not so when Homicide Reports is named and a series by year or month is asked: it runs over every year the source holds (P152).
  const everyYear0 = plan.defaults.some((d) => d.path === "period") && flags(ledger0).shrAsked && plan.groupings.some((g) => g.dimension === "time.year" || g.dimension === "time.month");
  // P161 (Jeff 2026-11-19): a victim's or offender's detail broken down with no period ("Murder victim race in Houston") is every year by
  // year from Homicide Reports' first year, with the sentence that no years were given.
  const detailEveryYear = !everyYear0 && plan.defaults.some((d) => d.path === "period") && !plan.groupings.some((g) => g.dimension.startsWith("time."))
    && plan.groupings.length === 1 && /^(?:victim|offender)\./.test(plan.groupings[0].dimension);
  if (detailEveryYear) plan = { ...plan, groupings: [{ dimension: "time.year", unknown: "visible", absent: "show" }, ...plan.groupings] };
  const everyYear = everyYear0 || detailEveryYear;
  if (plan.defaults.some((d) => d.path === "period") && !everyYear) return null;
  let period: { from: string; to: string };
  if (everyYear) period = { from: `${SHR_FIRST_YEAR}-01`, to: deps.shr.latestMonth };
  else try {
    const r = resolvePeriod(plan.period, { ...deps.release, lastMonth: deps.shr.latestMonth });
    if (r.kind === "years") {
      const ys = [...r.years].sort((a, b) => a - b);
      // Only whole runs of years: "2019 and 2024" stays on its own path.
      if (ys.some((y, i) => i > 0 && y !== ys[i - 1] + 1)) return null;
      period = { from: `${ys[0]}-01`, to: `${ys[ys.length - 1]}-12` };
    } else period = { from: r.from, to: r.to };
  } catch { return null; }
  const compare = ledger0.parts.some((p) => p.clause === 0 && p.concept === "versus") || /\bcompar/i.test(ledger0.question)
    // The reader rewrites a comparison's "vs" as "and"; the question as asked keeps it ("female vs male murder victims per year").
    || /\s(?:vs\.?|versus)\s/i.test(deps.asked ?? "");
  const sq = shrQuestionOf(plan, period, deps.shr, { compare, other: /\bother\b/i.test(deps.asked ?? ledger0.question), percent: /%|\bpercent|\bshare\b|\bproportion/i.test(deps.asked ?? "") });
  if ("why" in sq) return null;
  // P163 (Jeff 2026-11-19): justifiable homicides are shown for both kinds together; "police" in the question alone is the felons killed by
  // police (code 81), "civilians" or "private citizens" alone the felons killed by a private citizen (80). Both words ask for the two side by side.
  if (sq.measure === "justifiable" && !sq.breakdown && !sq.filters.some((f) => f.dim === "circumstance")) {
    const said = [ledger0.question, ...(flags(ledger0).readings ?? []).filter((r) => r.kind === "phrase").map((r) => r.from)].join(" ");
    const police = /\b(?:police|officers?|law\s+enforcement)\b/i.test(said), civilian = /\b(?:civilians?|private\s+citizens?|citizens?)\b/i.test(said);
    if (police !== civilian) sq.filters.push({ dim: "circumstance", codes: [police ? "81" : "80"] });
  }
  const a = answerShr(sq, deps.shr, deps.execute, deps.historical);
  if (a.kind === "shr" && detailEveryYear)
    return { ...a, delivered: { ...a.delivered, text: [a.delivered.text[0], `No years were given, so every year in the data is shown: ${SHR_FIRST_YEAR} through ${deps.shr.latestMonth.slice(0, 4)}.`, ...a.delivered.text.slice(1)] } };
  return a.kind === "shr" ? a : decline("outside_release_coverage", a.explanation);
}
/**
 * Big cities ranked by a murder detail from Homicide Reports (SHR-B, Jeff 2026-11-11 order): "big cities with the highest
 * share of murders by firearm in 2024", "... the most homicides by knife", "... the highest share of teenage homicide
 * victims". Null when the question is anything else (the caller keeps its own path). Only the words read here are
 * answered: a detail it doesn't recognise, a period shape other than one year or a range, or a floor other than "big"
 * (250,000) leaves the question to the old route. With no period the period is asked, as every ranking asks.
 */
function shrCityRanking(ledger: RequestLedger, ledger0: RequestLedger, deps: ShadowDeps, rerun: (l: RequestLedger) => ShadowOutcome): ShadowOutcome | null {
  if (!deps.shr || !deps.historical || !flags(ledger0).largeCities) return null;
  const f = flags(ledger0);
  if (f.consistent || f.quarter || f.nibrsAsked || f.clearance || f.property || f.composite || f.combined || f.region || f.column || f.forecast || f.court || f.offenders
    || f.undefinedTerm || f.comparison || f.last12 || f.countywide || f.circumstance || f.shrDetail || f.arrestsThrough) return null;
  const c0 = ledger0.parts.filter((p) => p.clause === 0);
  // Only these parts are answered; a rate, a month grain, a change, a comparison or any other reading is not dropped but left to the old route.
  const READ = new Set(["period", "share", "filter", "rank", "measure", "entity", "filler", "opener", "which", "unrecognized", "punctuation", "unit", "statistic"]);
  if (c0.some((p) => !READ.has(p.concept) || (p.concept === "statistic" && p.value !== "count") || (p.concept === "punctuation" && p.text.trim() !== "%" && p.state !== "context"))) return null;
  const crimes = [...new Set(c0.filter((p) => p.concept === "measure").map((p) => String(p.value)))];
  if (crimes.length !== 1 || !["murder", "homicide", "homicide_all"].includes(crimes[0])) return null;
  const rank = c0.find((p) => p.concept === "rank");
  const rankVal = /^(top|bottom):(\d*)$/.exec(String(rank?.value ?? ""));
  if (!rankVal || !c0.some((p) => p.concept === "entity" && p.value === "city")) return null;
  // A unit other than victims, or a place, isn't read here.
  if (c0.some((p) => (p.concept === "unit" && p.value !== "victims") || p.concept === "place" || p.concept === "clearance" || p.concept === "clearance-reason" || p.concept === "breakdown" || p.concept === "threshold")) return null;
  // Details: a weapon the question names, and teenage victims (13 to 19, or the range written beside it).
  const filters: ShrFilter[] = [];
  for (const p of c0.filter((x) => x.concept === "filter")) {
    const w = /^weapon:(firearm|20)$/.exec(String(p.value));
    if (!w) return null;
    filters.push({ dim: "weapon", codes: w[1] === "firearm" ? ["11", "12", "13", "14", "15"] : ["20"] });
  }
  const teen = !!f.people?.teen;
  if (teen) filters.push({ dim: "victim.age", ages: [13, 19] });
  if (!filters.length) return null;
  // Words the reader couldn't place are only ones that change nothing here.
  // "or sharp object" is the knife code's own name, only with a knife and no other weapon; "(13-19)" is the teen range.
  const knifeOnly = filters.length === 1 && filters[0].codes?.join() === "20";
  const harmless = new RegExp(`^(?:via|by|with${knifeOnly ? "|or sharp object" : ""}${teen ? "|\\(\\s*13\\s*(?:-|to|–)\\s*19\\s*\\)" : ""})$`, "i");
  const periods = c0.filter((p) => p.concept === "period");
  if (c0.some((p) => p.state === "not-interpreted" && !harmless.test(p.text.trim()) && !(p.concept === "period"))) return null;
  // The people wording the reader took out ("teenage") must be only that.
  if (f.people && (f.people.by || f.people.ask || f.people.unsupported || !teen || f.people.where.length !== 1 || f.people.where.some((w) => w.who !== "victim" || w.attr !== "age"))) return null;
  const share = c0.some((p) => p.concept === "share" || (p.concept === "punctuation" && p.text.trim() === "%"));
  const latest = deps.shr.latestMonth;
  const lastComplete = Number(latest.slice(0, 4)) - (latest.endsWith("-12") ? 0 : 1);
  if (!periods.length) {
    return { kind: "clarify", about: "which period", question: ledger0.question, options: [
      { label: `${lastComplete}`, continuation: rerun(filled(ledger, "period", `year:${lastComplete}`, `in ${lastComplete}`)) },
      { label: "Other years", entry: "which years" }] };
  }
  const pv = /^(?:(year):(\d{4})|(range):(\d{4}):(\d{4}))$/.exec(String(periods[0].value ?? ""));
  if (periods.length !== 1 || !pv) return null;
  const fromY = Number(pv[2] ?? pv[4]), toY = Number(pv[2] ?? pv[5]);
  if (fromY < SHR_FIRST_YEAR || fromY > toY) return null;
  if (fromY > Number(latest.slice(0, 4)))
    return decline("outside_release_coverage", `Homicide Reports in the data run through ${latest.slice(0, 4)}, so ${fromY} is outside them.`);
  const to = toY >= Number(latest.slice(0, 4)) ? latest : `${toY}-12`;
  const a = answerShrRanking({ measure: crimes[0] as "murder" | "homicide" | "homicide_all", filters, share, from: `${fromY}-01`, to, direction: rankVal[1] === "bottom" ? "bottom" : "top",
    limit: rankVal[2] ? Number(rankVal[2]) : 20, minPopulation: 250000 }, deps.shr, deps.historical, deps.execute);
  return a.kind === "shr" ? a : decline("outside_release_coverage", a.explanation);
}

/**
 * Several named agencies' murder details from Homicide Reports (Jeff 2026-11-15, source rule: details are Homicide
 * Reports', never NIBRS by default): each agency answered as one place, then one table Agency | ... with the agencies
 * side by side, a blank where an agency filed nothing. Null when any one can't be answered as asked (the caller keeps its
 * path); a decline from Homicide Reports (nothing filed anywhere) is the decline.
 */
function shrSeveral(plan: NibrsPlan, deps: ShadowDeps, ledger0: RequestLedger): ShadowOutcome | null {
  const places = plan.geography.places;
  if (places.length < 2 || !places.every((p) => p.kind === "agency") || plan.geography.combine === "combined") return null;
  const answers: ShrAnswer[] = [];
  for (const p of places) {
    const one = { ...plan, geography: { ...plan.geography, places: [p] }, groupings: plan.groupings.filter((g) => !g.dimension.startsWith("geo.")) } as NibrsPlan;
    const o = shrOutcome(one, deps, ledger0);
    if (!o || o.kind !== "shr") return o && o.kind === "decline" ? o : null;
    answers.push(o);
  }
  const first = answers[0];
  const agencyOf = (a: ShrAnswer) => (a.question.place.kind === "agency" ? a.question.place : null)!;
  const names = answers.map((a) => agencyOf(a).label);
  const listed = names.length > 2 ? `${names.slice(0, -1).join("; ")} and ${names[names.length - 1]}` : names.join(" and ");
  const columns = [{ binding: { kind: "grouping" as const, dimension: "geo.agency" }, header: "Agency" }, ...first.delivered.table.columns];
  const rows = answers.flatMap((a) => a.delivered.table.rows.map((r) => [shortAgency(agencyOf(a).label), ...r]));
  // The lines: the first title with every agency named, then each answer's other lines once (its own agency lines kept).
  // The first title with every agency named: a title now begins with its place (Jeff 2026-11-21); a sentence ("Chicago had 12 murders in 2024.") becomes the title of the agencies' table.
  const t0 = first.delivered.text[0], label0 = agencyOf(first).label;
  const sentence = /^.+? had ([\d.,]+) (.+) in (.+)\.$/.exec(t0);
  const title = t0.startsWith(`${label0} `) ? `${listed}${t0.slice(label0.length)}` : t0.endsWith(`, ${label0}`) ? `${t0.slice(0, t0.length - label0.length)}${listed}`
    : sentence ? seriesTitle(sentence[3], sentence[2].replace(/ per 100,000 people$/, ""), "Agency", listed) : t0;
  const rest: string[] = [];
  for (const a of answers) for (const t of a.delivered.text.slice(1)) if (!rest.includes(t) && !/^Source: /.test(t)) rest.push(t);
  const text = [title, ...rest, first.delivered.text[first.delivered.text.length - 1]];
  return { ...first, question: { ...first.question, places: answers.slice(1).map((a) => a.question.place) },
    meaning: { ...first.meaning, places: answers.map((a) => a.question.place), groupings: ["agency", ...first.meaning.groupings] },
    delivered: { table: { columns, rows }, text } };
}
/** "Dallas, Texas" is "Dallas" in a table's agency column. */
const shortAgency = (label: string) => label.split(",")[0];

const FORECAST_SENTENCE = "The data records past crime and cannot predict the future.";

/** P01: crimes whose completed years are Historical's and whose current year is Current Trends'; NIBRS answers their details. */
const PART_ONE = new Set(["murder", "homicide", "homicide_all", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft", "arson", "violent_crime", "property_crime"]);

/**
 * Crime Index totals with no NIBRS measure: a month, quarter or part-year question about them has no source yet (the
 * Crime Index builds are annual). Every other Part I crime asked by month goes to NIBRS, whose grain is monthly
 * (coordinator 2026-11-02: route by the sources' grain; never an annual-only source for months).
 */
const ANNUAL_ONLY = new Set(["violent_crime", "property_crime"]);
const wholeYear = (s: { from: string; to: string }) => s.from.endsWith("-01") && s.to.endsWith("-12");
/**
 * The current year's clearance rate of a Part I offense (P57, Jeff 2026-11-16): computed from NIBRS for an agency, a state or the nation,
 * in the months of the year the data holds. The completed years' rate is Crime Index's (the FBI annual method), and stays so.
 */
const currentClearance = (sp: { statistic: string; measures: string[]; filters: unknown[]; grain: string; period: NPeriod; unit: string | null }, thisYear: number) =>
  sp.statistic === "clearance_rate" && sp.measures.length === 1 && isSrsMeasure(sp.measures[0]) && !sp.filters.length && sp.grain === "total"
  && sp.period.form === "year" && sp.period.year === thisYear && (sp.unit === null || sp.unit === "offenses");
/**
 * A completed year's clearance rate for one state (P172, Jeff 2026-11-21, reversing P18): the cleared offenses over the offenses of every agency that
 * reported, from NIBRS. The nation's completed years stay Crime Index's.
 */
const completedStateClearance = (sp: { statistic: string; measures: string[]; filters: unknown[]; grain: string; period: NPeriod; unit: string | null; places: { kind: string }[] },
  thisYear: number, firstYear: number): { years: number[]; note: string | null } | null => {
  if (!(sp.statistic === "clearance_rate" && sp.measures.length === 1 && isSrsMeasure(sp.measures[0]) && !sp.filters.length && (sp.grain === "total" || sp.grain === "year")
    && (sp.unit === null || sp.unit === "offenses") && sp.places.length === 1 && sp.places[0].kind === "state")) return null;
  const span = yearSpan(sp, thisYear, firstYear);
  // The current year is the Consistent Reporting Agencies' rate (P57), and a span reaching it is not decided here.
  if (!span || span[1] >= thisYear || span[1] < firstYear || span[0] > span[1]) return null;
  const from = Math.max(span[0], firstYear);
  const years = Array.from({ length: span[1] - from + 1 }, (_, i) => from + i);
  return { years, note: from > span[0] ? `NIBRS state figures start in ${firstYear}; ${span[0]}${from - 1 > span[0] ? ` through ${from - 1}` : ""} ${from - 1 > span[0] ? "are" : "is"} outside them.` : null };
};
/** A question finer than whole years: a month or quarter grain, or a comparison of part years. */
const partYear = (sp: { grain: string }, cmp: { earlier: { from: string; to: string }; later: { from: string; to: string } } | null | undefined) =>
  (sp.grain !== "total" && sp.grain !== "year") || (!!cmp && !(wholeYear(cmp.earlier) && wholeYear(cmp.later)));

/**
 * The years a Crime Index question covers (coordinator 2026-11-02, Jeff's "Memphis murders since 1930"): one year, a
 * range, "since YEAR" through the latest complete year, "the past N years" ending there, "last year", and a series by
 * year with no range: every year the source has. Null for a form these annual sources do not answer.
 */
function yearSpan(sp: { period: NPeriod; grain: string }, thisYear: number, firstYear: number): [number, number] | null {
  const lastComplete = thisYear - 1, p = sp.period;
  if (p.form === "year") return [p.year, p.year];
  if (p.form === "range") return [p.from, p.to];
  if (p.form === "since") return [p.from, lastComplete];
  if (p.form === "last") return [lastComplete - p.n + 1, lastComplete];
  if (p.form === "lastyear") return [lastComplete, lastComplete];
  // Years named one by one with none missing between them ("2020, 2021, 2022") are the range between the first and the last (Fairfax, QL-ct-fe39e34290).
  if (p.form === "years" && p.list.length > 1 && p.list.every((y, i) => i === 0 || y === p.list[i - 1] + 1)) return [p.list[0], p.list[p.list.length - 1]];
  if (p.form === "none" && sp.grain === "year") return [firstYear, lastComplete];
  return null;
}
/**
 * The months a Current Trends question covers (design note, section 3): a month, a range of months, a year or years by
 * month, "since YEAR" by month through the build's last month, or "by month" alone (the months current_crime holds).
 * Null for a form that isn't monthly.
 */
function monthSpan(sp: { period: NPeriod; grain: string }, b: CurrentBuild): [string, string] | null {
  const p = sp.period, mm = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}`;
  if (p.form === "month") return [mm(p.year, p.month), mm(p.year, p.month)];
  if (p.form === "monthrange") return [mm(...p.from), mm(...p.to)];
  if (sp.grain !== "month") return null;
  if (p.form === "year") return [mm(p.year, 1), mm(p.year, 12)];
  if (p.form === "range") return [mm(p.from, 1), mm(p.to, 12)];
  if (p.form === "since") return [mm(p.from, 1), b.lastMonth];
  if (p.form === "none") return [b.firstMonth, b.lastMonth];
  return null;
}
/** A span asked as open words ("since 1990", "the past 10 years", "by year" alone) is shown year by year. */
const openSpan = (sp: { period: NPeriod }) => sp.period.form === "since" || (sp.period.form === "last" && sp.period.n > 1) || sp.period.form === "none";

/** Police staffing in words: officers, sworn or civilian employees, staffing, headcount (Crime Index's staffing tables). */
const STAFFING = /\b(?:staffing|staff levels?|cops?|(?:police )?officers?(?: per (?:capita|1,?000|100,?000))?|sworn|civilian employees|police employees|headcount|police force size)\b/i;

/**
 * A county asked by name and answered from its sheriff's office (coordinator 2026-11-05: "Tarrant County, Texas murders
 * 2024" gave the sheriff's 2 murders, not the county's): said plainly. A sheriff named in the question needs no note.
 */
function sheriffNote(deps: ShadowDeps, oris: string[], question: string): string {
  if (/\bsheriff/i.test(question)) return "";
  const sheriffs = oris.filter((o) => /\bsheriff/i.test(deps.places.names.get(o) ?? ""));
  if (!sheriffs.length) return "";
  // Alone: "These are the sheriff's office's own figures"; beside other agencies, the sheriff's office is named.
  const whose = oris.length === 1 ? "These are the sheriff's office's own figures"
    : sheriffs.length === 1 ? `The ${deps.places.names.get(sheriffs[0])}'s figures are its own` : "Each sheriff's office's figures are its own";
  return `${whose}, not the whole county's: cities in the county with their own police report separately.`;
}

/** P13's sentence, as Current Trends and Historical say it. */
const SAFEST_SENTENCE = "There's no agreed definition of safest or most dangerous; ask for a specific offense and a count or rate.";
const MONTH_NAME = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/**
 * The same months of each year (Jeff 2026-11-16, Q1): "Murders through April from 2017 to 2025", "homicides in the first 6 months of each
 * year". One year is that year's month range, asked as such; several years are the table Year | figure, each year counting the same months,
 * every figure the engine's own answer for that year (so its sources, limits and blanks apply), titled with the months. Never the whole
 * year in place of the months, and never a clarify whose buttons would forget the months.
 */
function answerSameMonths(ledger0: RequestLedger, part: Part, deps: ShadowDeps): ShadowOutcome | null {
  const NO = () => decline("unsupported_capability", "I can't answer this combination. Try a simpler version, for example one crime in one place for one year.");
  const n = Number(String(part.value).slice(7));
  if (!(n >= 1 && n <= 12)) return NO();
  const parts0 = ledger0.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const periods = parts0.filter((p) => p.concept === "period"), grains = parts0.filter((p) => p.concept === "grain");
  if (periods.length > 1 || grains.some((g) => g.value !== "year") || parts0.some((p) => p.concept === "rolling" || p.concept === "months-through" && p !== part)) return NO();
  const lastComplete = Number(deps.release.lastMonth.slice(0, 4)) - (deps.release.lastMonth.endsWith("-12") ? 0 : 1);
  const pv = periods.length ? /^(?:year:(\d{4})|range:(\d{4}):(\d{4})|since:(\d{4}))$/.exec(periods[0].value ?? "") : null;
  if (periods.length && !pv) return NO();
  const years: [number, number] = !pv ? [Number(deps.release.firstMonth.slice(0, 4)), lastComplete]
    : pv[1] ? [Number(pv[1]), Number(pv[1])] : pv[2] ? [Number(pv[2]), Number(pv[3])] : [Number(pv[4]), lastComplete];
  if (years[0] > years[1] || years[1] - years[0] > 100) return NO();
  let base = ledger0.question;
  for (const [s, e] of [part, ...periods, ...grains].map((p) => p.span).sort((a, b) => b[0] - a[0])) base = `${base.slice(0, s)} ${base.slice(e)}`;
  base = base.replace(/\s+/g, " ").replace(/\s+([,?.!])/g, "$1").replace(/[?.!\s]+$/, "").replace(/(?:\s+(?:in|for|of|from|during|by|each|every))+$/i, "").trim();
  const month = MONTH_NAME[n - 1];
  const sub = (y: number) => (n === 1 ? `${base} in January ${y}` : `${base} from January ${y} through ${month} ${y}`);  type Delivering = Extract<ShadowOutcome, { delivered: unknown }>;
  const results = [] as { y: number; o: ShadowOutcome }[];
  for (let y = years[0]; y <= years[1]; y++) {
    const o = shadowAnswer(sub(y), deps);
    // The first year's ask or decline stands for the question (a place asked, a limit): never buttons that forget the months.
    // A place to choose (several agencies of that name) is the ordinary place question; its buttons keep the months. Any other ask is declined.
    if (y === years[0] && o.kind === "clarify") return /^which /.test(o.about) ? null : NO();
    results.push({ y, o });
  }
  // The year's figure: the sum of its months (the engine's own month rows), blank when any month is not known (never a partial sum as the
  // year's); or the one total an answer already is.
  const value = (o: ShadowOutcome): number | null | undefined => {
    const d = (o as Partial<Delivering>).delivered as { table?: { columns: { binding: { kind: string; dimension?: string } }[]; rows: unknown[][] } } | undefined;
    if (!d?.table) return undefined;
    const monthly = d.table.columns[0]?.binding.kind === "grouping" && d.table.columns[0].binding.dimension === "time.month";
    const cells = d.table.rows.map((r) => r[r.length - 1]);
    if (!monthly) return d.table.rows.length === 1 && (typeof cells[0] === "number" || cells[0] === null) ? (cells[0] as number | null) : undefined;
    if (cells.length !== n || cells.some((c) => c !== null && typeof c !== "number")) return undefined;
    return cells.some((c) => c === null) ? null : (cells as number[]).reduce((a, b) => a + b, 0);
  };
  const first = results.find((r) => value(r.o) !== undefined);
  if (!first) return results[0].o.kind === "decline" ? results[0].o : NO();
  // One source for the whole table (P53, no splicing; found by the blind check of QL-shr-035f230d4f, NYPD murders through April 2000 to
  // 2022): when the first year with a figure is Homicide Reports', every year is Homicide Reports' (a later year that would otherwise come
  // from Current Trends is asked of Homicide Reports, and is blank where no report was filed), never one source for some years and another
  // for the rest.
  if (first.o.kind === "shr" && !SHR_WORDS.test(base))
    for (const r of results) if (r.o.kind !== "shr" && r.o.kind !== "decline") r.o = shadowAnswer(`${sub(r.y)} in Homicide Reports`, deps);
  const firstOut = first.o as Delivering;
  // Homicide Reports (Jeff 2026-11-17: "Start the table in 1985"): the years before the source starts are not shown as blanks; the table
  // starts in the first year the source has, and the source's own sentence says where it starts.
  const dropped = firstOut.kind === "shr" ? results.findIndex((r) => r.o.kind !== "decline") : 0;
  const before = dropped > 0 ? results.splice(0, dropped) : [];
  const y0 = results[0].y;
  const lastCol = firstOut.delivered.table.columns[firstOut.delivered.table.columns.length - 1];
  const blank = results.filter((r) => !(typeof value(r.o) === "number")).map((r) => r.y);
  // The title: the years, what is counted and the months, by year, and the place (an agency by its label, a state by its name).
  const firstPlace = (firstOut as { plan?: { geography: { places: { kind: string; label?: string; code?: string }[] } }; question?: { place?: { kind: string; label?: string; code?: string } } });
  const pl0 = firstPlace.plan?.geography.places[0] ?? firstPlace.question?.place;
  const placeText = pl0 ? (pl0.kind === "agency" ? pl0.label : pl0.kind === "state" ? stateName(pl0.code ?? "") : "United States") : null;
  const sameWhat = `${lastCol.header.toLowerCase()} ${n === 1 ? "in January" : `January through ${month}`}`;
  const sameYears = y0 === years[1] ? String(y0) : `${y0} to ${years[1]}`;
  const title = placeText ? seriesTitle(sameYears, sameWhat, "Year", placeText) : `${sameYears} ${titleCase(sameWhat)} by Year`;
  // Lines every year says alike (the source, who reported) stay; a line that differs by year is that year's own.
  const common = firstOut.delivered.text.slice(1).filter((t) => results.every((r) => (r.o as Partial<Delivering>).delivered === undefined || (r.o as Delivering).delivered.text.includes(t)));
  // A blank year says why in the engine's own words (the month with no report); otherwise that it has no figure.
  const why = results.filter((r) => blank.includes(r.y)).flatMap((r) => ((r.o as Partial<Delivering>).delivered?.text ?? []).filter((t) => /^No (?:data|figure) is available for/.test(t)));
  // The blank years as runs ("1935 to 1984 and 2024"), so fifty years before the source starts are one phrase, not a list.
  const runsOf = (ys: number[]) => {
    const out: string[] = [];
    for (let i = 0; i < ys.length;) { let j = i; while (j + 1 < ys.length && ys[j + 1] === ys[j] + 1) j++; out.push(j > i ? `${ys[i]} to ${ys[j]}` : `${ys[i]}`); i = j + 1; }
    return out.length > 2 ? `${out.slice(0, -1).join(", ")} and ${out[out.length - 1]}` : out.join(" and ");
  };
  const noFigure = blank.length ? `No figure is available for ${runsOf(blank)}: shown blank, not zero.` : null;
  const text = [title, `Each year counts the same months: January through ${month}.`, ...(!pv ? [`No years were given, so every year in the data is shown: ${y0} through ${years[1]}.`] : []),
    ...(before.length ? [`Homicide Reports here start in ${y0}, so ${before[0].y} through ${y0 - 1} aren't included.`] : []),
    ...(noFigure ? [noFigure] : []), ...why.filter((t) => !common.includes(t)), ...common];
  const asName = (lastCol.binding as { as?: string }).as ?? "count";
  const table = { columns: [{ binding: { kind: "grouping" as const, dimension: "time.year" }, header: "Year" }, { ...lastCol }], rows: results.map((r) => [String(r.y), typeof value(r.o) === "number" ? value(r.o) as number : null]) };
  const evidence = results.map((r, i) => ({ row: i, statistic: asName, status: typeof value(r.o) === "number" ? "VALUE" : "UNKNOWN" })) as unknown as Delivered["evidence"];
  const chart = results.length > 1 ? { kind: "bar" as const, x: "Year", y: [lastCol.header] } : null;
  // Every period field says what the table shows, the whole span (the first year's own window is not the answer's), and the answer is
  // grouped by year: the first year's sub-answer is by month, but this answer's rows are years.
  const span = { from: `${y0}-01`, to: `${years[1]}-${String(n).padStart(2, "0")}` };
  const fo = firstOut as unknown as { meaning?: Record<string, unknown>; plan?: Record<string, unknown>; question?: Record<string, unknown> };
  return { ...firstOut, sameMonths: true, ...("period" in firstOut ? { period: span } : {}),
    ...(fo.meaning && "period" in fo.meaning ? { meaning: { ...fo.meaning, period: span, groupings: ["year"] } } : {}),
    ...(fo.plan ? { plan: { ...fo.plan, period: { kind: "absolute", ...span }, groupings: [{ dimension: "time.year", unknown: "visible", absent: "show" }] } } : {}),
    ...(firstOut.kind === "shr" && fo.question ? { question: { ...fo.question, from: span.from, to: span.to, grain: "year" } } : {}),
    delivered: { ...firstOut.delivered, table, evidence, chart, text, ...((firstOut.delivered as Partial<Delivered>).headline ? { headline: title } : {}) } } as unknown as ShadowOutcome;
}
/** `pins`: places already chosen by a button, by the place part's start (P22: a choice made is not asked again). */
/**
 * "City, State" is checked against the place index (coordinator 2026-11-22: "burglaries in Westlake, Florida" answered Westlake, Ohio plus the state
 * of Florida, and "Deltona, Florida" was not understood, because the reader's own city list lacks cities the index has). A name followed by a state
 * is that state's agency of the name: one merged place; and if the index has none there, a decline. Never the same name in another state.
 */
function reconcileCityState(ledger: RequestLedger, deps: ShadowDeps): { ledger: RequestLedger; decline?: ShadowOutcome } {
  if (!deps.places) return { ledger };
  const parts = [...ledger.parts].sort((a, b) => a.span[0] - b.span[0]);
  const out: Part[] = [];
  const drop = new Set<Part>();
  // The commas and fillers between a name and its state are parts of their own; the next part that means something is the state.
  const meaningful = parts.filter((x) => x.state !== "context");
  for (let i = 0; i < meaningful.length - 1; i++) {
    const p = meaningful[i], s = meaningful[i + 1];
    // A two-word name the reader split ("Litchfield" read as a place, "Park," not understood, then the state): the words together, kept only
    // when the index has the whole name in that state.
    const st3 = meaningful[i + 2];
    if (p.clause === 0 && p.concept === "place" && /^(?:city|county|ambiguous):/.test(p.value ?? "") && s.concept === "unrecognized" && /^[A-Z][A-Za-z.'-]*,?$/.test(s.text.trim())
      && st3 && st3.concept === "place" && /^state:/.test(st3.value ?? "") && /^\s*,?\s*$/.test(ledger.question.slice(s.span[1], st3.span[0]))) {
      const code3 = stateCodeOf(String(st3.value).slice("state:".length));
      const name3 = `${p.text.trim()} ${s.text.trim().replace(/,$/, "")}`;
      const a3 = code3 ? agencyInState(deps.places, name3, code3) : null;
      if (a3) {
        out.push({ ...p, concept: "place", value: `${a3.kind}:${a3.name}:${a3.state}`, text: `${name3}, ${stateName(code3!)}`, span: [p.span[0], st3.span[1]], explains: [[p.span[0], st3.span[1]]],
          rule: "shadow:city-state", state: "recognized", explanation: null } as unknown as Part);
        drop.add(p); drop.add(s); drop.add(st3);
        i += 2;
        continue;
      }
    }
    if (p.clause !== 0 || s.clause !== 0 || s.concept !== "place" || !/^state:/.test(s.value ?? "")) continue;
    if (!/^[\s,]+$/.test(ledger.question.slice(p.span[1], s.span[0]).replace(/[()]/g, "")) && !/^\s*,\s*$/.test(ledger.question.slice(p.span[1], s.span[0]))) continue;
    // A name read as a city or county, or text the reader did not understand that ends in a capitalized name ("in Deltona,").
    let name: string | null = null;
    if (p.concept === "place" && /^(?:city|county|ambiguous):/.test(p.value ?? "") && !/,\s*[A-Za-z .]+$/.test(p.text.trim())) name = p.text.trim();
    else if (p.concept === "unrecognized") name = /(?:^|\s)(?:in|for|of|at|near)\s+((?:[A-Z][A-Za-z.'-]*)(?:\s+[A-Z][A-Za-z.'-]*){0,3}),?\s*$/.exec(p.text.trim())?.[1] ?? null;
    if (!name) continue;
    const code = stateCodeOf(String(s.value).slice("state:".length));
    if (!code) continue;
    const full = `${name}, ${stateName(code)}`;
    const a = agencyInState(deps.places, name, code);
    if (!a) return { ledger, decline: decline("unresolved_place", `I couldn't find "${full}" among the city and county police agencies, states and the nation here.`) };
    const merged = { ...p, concept: "place", value: `${a.kind}:${a.name}:${a.state}`, text: full, span: [p.concept === "unrecognized" ? p.span[1] - name.length - (/,\s*$/.test(p.text) ? 1 : 0) : p.span[0], s.span[1]],
      explains: [[p.span[0], s.span[1]]], rule: "shadow:city-state", state: "recognized", explanation: null } as unknown as Part;
    drop.add(p); drop.add(s); out.push(merged);
  }
  if (!out.length) return { ledger };
  return { ledger: withParts(ledger, [...parts.filter((x) => !drop.has(x)), ...out]) };
}
/** P280: a person crime already asked as offenses, broken down by location or hour of day, carries the same sentence as the converted ones. */
function personOffensesByPlaceOrHour(plan: NibrsPlan): boolean {
  const isPlaceOrHour = (d: string) => d === "offense.location_type" || d === "incident.hour";
  const victimFilter = plan.filters.some((f) => (f.kind === "attribute" && /^(?:victim|offender|relationship)\./.test(f.dimension)) || (f.kind === "exists" && f.scope !== "offense" && f.scope !== "incident"));
  return plan.measures.length > 0 && !victimFilter && plan.groupings.some((g) => isPlaceOrHour(g.dimension))
    && plan.groupings.every((g) => isPlaceOrHour(g.dimension) || g.dimension.startsWith("time."))
    && plan.measures.every((m) => {
      const name = m.id.replace(/^offenses\./, "");
      const codes = m.id.startsWith("offenses.") ? MEASURE_CODES[name] : undefined;
      return !!codes && codes.every((c) => PERSON_CODES.has(c)) && !["violent_crime", "property_crime", "against_property"].includes(name);
    });
}
function fromLedger(ledgerIn: RequestLedger, deps: ShadowDeps, pins = new Map<number, Candidate>()): ShadowOutcome {
  const reconciled = reconcileCityState(ledgerIn, deps);
  if (reconciled.decline) return reconciled.decline;
  const ledger0 = reconciled.ledger;
  const { release } = deps;
  const clause0 = (c: string) => ledger0.parts.filter((p) => p.clause === 0 && p.concept === c && p.state !== "context");
  // The same months of each year (Q1): answered by its own function, or declined; the months are never dropped.
  // With no place named, the place is asked first as before (its buttons run the whole question, months and all, and come back here).
  const sameMonths = clause0("months-through");
  if (sameMonths.length && clause0("place").length) {
    // A place pinned from a button is carried into each year's question by its words. A place that must still be asked goes on to the
    // ordinary place question, whose buttons come back here with the place chosen and the months kept.
    const byWords = new Map(deps.placePins ?? []);
    for (const p of clause0("place")) { const c = pins.get(p.span[0]); if (c) byWords.set(p.text.trim().toLowerCase(), c); }
    const r = answerSameMonths(ledger0, sameMonths[0], byWords.size ? { ...deps, placePins: byWords } : deps);
    if (r) return r;
  }

  // "By state" (Jeff 2026-11-16, Q2): the 50 states from Crime Index for one Part I crime. One year is the table State | figure (the
  // ranking of all 50); years named, or a trend with none, is the long table State | Year | figure, no chart. No year and no trend asks the
  // year (P06). Anything else in the question (a breakdown, a clearance, a detail only NIBRS has) keeps the old handling.
  if (deps.historical && clause0("list").some((p) => p.value === "list:state") && !clause0("place").length) {
    const hb = deps.historical;
    const measures = clause0("measure"), stats = clause0("statistic").map((p) => p.value ?? "");
    const quiet = ledger0.parts.every((p) => p.clause !== 0 || p.state === "context" || ["measure", "list", "period", "statistic", "grain"].includes(p.concept)
      || (p.state === "not-interpreted" && (pureFillerOnly(p.text) || /^(?:a\s+)?(?:spreadsheet|table)\b/i.test(p.text.trim()))))
      && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance
      && !flags(ledger0).people && !flags(ledger0).composite && !flags(ledger0).combined && !flags(ledger0).column && !flags(ledger0).region && !flags(ledger0).largeCities;
    const grains = clause0("grain").map((p) => p.value ?? "");
    if (quiet && measures.length === 1 && isHistoricalMeasure(measures[0].value ?? "") && stats.every((s) => /^(?:count|rate|per100k|percapita)$/.test(s)) && grains.every((g) => g === "year")) {
      const measure = measures[0].value!;
      const statistic = stats.some((s) => s !== "count") ? "rate" as const : "count" as const;
      const per = clause0("period");
      const pv = per.length === 1 ? /^(?:(year):(\d{4})|(range):(\d{4}):(\d{4})|(since):(\d{4}))$/.exec(per[0].value ?? "") : null;
      if (per.length === 0 && !grains.length) {
        const y = hb.lastYear;
        return { kind: "clarify", about: "which period", question: ledger0.question, options: [
          { label: `${y}`, continuation: fromLedger(filled(ledger0, "period", `year:${y}`, `in ${y}`), deps, pins) }, { label: "Other years", entry: "which years" }] };
      }
      const years: [number, number] | null = per.length === 0 ? [1960, hb.lastYear] : pv ? (pv[1] ? [Number(pv[2]), Number(pv[2])] : pv[3] ? [Number(pv[4]), Number(pv[5])] : [Number(pv[7]), hb.lastYear]) : null;
      if (years && years[0] <= years[1]) {
        const r = years[0] === years[1] && !grains.length
          ? answerHistoricalRanking({ measure, state: "US", year: years[0], statistic, direction: "top", limit: 50, minPopulation: null, entity: "state" }, hb, deps.execute)
          : answerHistoricalStatesByYear({ measure, statistic, from: years[0], to: years[1] }, hb, deps.execute);
        if (r.kind === "historical") return r;
        return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
    }
  }

  // A question about the future, or about court outcomes, is declined first, with the nearest question the data answers
  // (P20, D01); its leftover words are not reasons. So is any other part the data does not record (a ZIP code): asking
  // which place, period or crime is meant in a question that cannot be answered would be an unnecessary question (D28).
  // P152: "Homicide Reports" in the words asks for that source, which holds murders and homicides only: any other crime is said so
  // before a place or a period is asked.
  if (flags(ledger0).shrAsked) {
    const crimes = ledger0.parts.filter((p) => p.clause === 0 && p.concept === "measure");
    if (crimes.length && crimes.some((p) => !/^(?:murder|homicide|homicide_all)$/.test(String(p.value))))
      return decline("unsupported_capability", "Homicide Reports hold murders and homicides only.");
  }
  const unrecorded = ledger0.parts.filter((p) => p.clause === 0 && p.state === "not-recorded");
  // Officers killed and assaulted: Jeff's sentence alone, before any other limit (Codex officer review 05: a ZIP code's
  // limit had been appended to it).
  const leoka = ledger0.parts.find((p) => p.concept === "officer-victims");
  if (leoka) return decline(readerReason(leoka.explanation!), plainReaderExplanation(leoka.explanation!), { detail: leoka.explanation! });
  if (flags(ledger0).forecast) return decline("forecast", FORECAST_SENTENCE, { alternative: trendAlternative(ledger0, deps) });
  if (flags(ledger0).court || unrecorded.some((p) => p.concept === "court")) return decline("court_outcome", COURT_SENTENCE, { alternative: arrestsAlternative(ledger0, deps) });
  // A "why", an effect or a cause, "safest" or "most dangerous", and a state's clearance rate are declined before a place, period or crime is
  // asked (policy P13, P18 and the explanation rule, scorecard 2026-11-16): asking first made the user answer a question that had no answer.
  // Only a question about crime ("why can't you tell me which states are not represented?" is about the data, not a cause).
  if (ledger0.parts.some((p) => p.clause === 0 && p.concept === "explain") && ledger0.parts.some((p) => p.clause === 0 && p.concept === "measure"))
    return decline("explanation_requested", "The data shows how many crimes were reported; it can't say why they rose or fell.", { detail: "I report what NIBRS records; I can't explain causes." });
  if (/\b(?:safest|most\s+dangerous|least\s+safe|most\s+unsafe)\b/i.test(ledger0.question)) return decline("unsupported_capability", SAFEST_SENTENCE);
  const term = flags(ledger0).undefinedTerm;
  if (term) {
    // P83: gun crime is offered in withNextStep, from the words asked (the reader's text has set conditions aside).
    return decline("not_recorded_in_nibrs", UNDEFINED_TERM[term]);
  }
  // P29: "by <group>" asks about offenders. "By men and women" is answered by the offenders' sexes (P49, below); any
  // other group (one sex, juveniles) is declined, never answered as victims.
  const bySexes = !!flags(ledger0).offenders && BY_SEXES.test(ledger0.question);
  if (flags(ledger0).offenders && !bySexes) return decline("unsupported_capability", "\"By\" a group of people means the offenders. Only \"by men and women\" (the offenders' sexes) is available.");
  // Engine 2, rule 1 (D03, Jeff 2026-11-12): a rate for a group of people the reader took out as people ("by race of offender",
  // an age range) is declined like the other group rates, before any place or crime is asked.
  const pplRate = flags(ledger0).people;
  if (pplRate && (pplRate.by || pplRate.where.some((w) => w.attr === "age"))
    && ledger0.parts.some((p) => p.clause === 0 && p.concept === "statistic" && /^(?:rate|per100k|percapita|scale:)/.test(p.value ?? "") && !negatedBefore(ledger0.question, p.span[0]))) {
    const why = DEMOGRAPHIC_RATE("a rate for a group of people");
    return decline(readerReason(why), plainReaderExplanation(why), { detail: why });
  }
  if (unrecorded.length) {
    const why = unrecorded.map((p) => p.explanation ?? `"${p.text}" is not recorded.`).join(" ");
    // P74: in plain words, with the question without those words when it can be answered.
    return decline(readerReason(why), plainReaderExplanation(why), { alternative: askInstead(ledger0.question, unrecorded, Number(deps.release.lastMonth.slice(0, 4))), detail: why });
  }
  // Increment 7: words policy asks about, a button per reading (P30 "young adults", P44 "attackers"), the rest of the
  // question kept (P22).
  const ppl0 = flags(ledger0).people;
  if (ppl0?.unsupported) return decline("unsupported_capability", / for offenders$/.test(ppl0.unsupported)
    ? `This isn't available: ${ppl0.unsupported}. I haven't answered with the offenders' own instead.`
    : `This isn't available: ${ppl0.unsupported} (an arrest lists the person arrested, not the victim). I haven't answered with the arrestees' instead.`);
  if (ppl0?.ask === "young adults") {
    const ages = (lo: number, hi: number): ShadowOption => ({ label: `${lo} to ${hi}`,
      continuation: fromLedger(Object.assign(withParts(ledger0, ledger0.parts), { people: { ...ppl0, ask: null, where: [...ppl0.where, { who: "offender", attr: "age", range: [lo, hi], paired: false }] } }), deps, pins) });
    return { kind: "clarify", about: "which ages \"young adults\" means", question: ledger0.question, options: [ages(18, 24), ages(18, 29)] };
  }
  if (ppl0?.ask === "victims or offenders") {
    // A button each, the same reading with the person named: everything else the question set (its conditions, such as
    // "unsolved" or "gang-related", and its place pins) is kept (Codex review 02). Victims: the breakdown as read (the
    // counted victims' own attribute). Offenders: that breakdown becomes the offenders' attribute. When neither can be
    // answered, the victims' refusal is given, not a question (D28).
    const ATTRS = ["race", "sex", "ethnicity", "age"] as const;
    const part = ledger0.parts.find((p) => p.clause === 0 && p.concept === "breakdown" && ATTRS.includes(p.value as (typeof ATTRS)[number]));
    const attr = (part?.value ?? "race") as (typeof ATTRS)[number];
    const victims = fromLedger(Object.assign(withParts(ledger0, ledger0.parts), { people: { ...ppl0, ask: null } }), deps, pins);
    const offenders = part
      ? fromLedger(Object.assign(withParts(ledger0, ledger0.parts.filter((p) => p !== part)), { people: { ...ppl0, ask: null, by: { who: "offender" as const, attr, paired: false } } }), deps, pins)
      : victims;
    if (victims.kind === "decline" && offenders.kind === "decline") return victims;
    // "Violent crime" by age: Jeff's words, "Offender" and "Victim" (2026-11-15; this question only).
    if (attr === "age" && /\bviolent\s+crimes?\b/i.test(ledger0.question))
      return { kind: "clarify", about: `victim or offender ${attr}`, question: ledger0.question, options: [
        { label: "Offender", continuation: offenders }, { label: "Victim", continuation: victims }] };
    return { kind: "clarify", about: `victim or offender ${attr}`, question: ledger0.question, options: [
      { label: "Victims", continuation: victims }, { label: "Offenders", continuation: offenders }] };
  }
  if (ppl0?.ask === "attackers") {
    const rest = ledger0.question.replace(/^\s*how\s+many\s+attackers\s+(?:were\s+there\s+)?(?:in|for)\s+/i, "").replace(/\?\s*$/, "");
    if (rest === ledger0.question.replace(/\?\s*$/, "")) return decline("reader", "\"Attackers\" can mean offenders or people arrested; ask for offenders or arrests.");
    return { kind: "clarify", about: "what \"attackers\" means", question: ledger0.question, options: [
      { label: "Offenders", continuation: shadowAnswer(`Offenders in ${rest}`, deps) },
      { label: "People arrested", continuation: shadowAnswer(`Arrests for ${rest}`, deps) }] };
  }

  // Places next (P16, P28): resolve each city or county through the build's agencies; the reader then sees a resolved
  // value. A name with several real candidates is asked about.
  const resolved = new Map<string, Place>();
  let ask: { part: Part; name: string; candidates: Candidate[]; more?: boolean } | null = null;
  let unfound: Part | null = null;
  // Two or more cities or counties named together: a city beside other places is the city (P196, Jeff 2026-11-22).
  const inList = ledger0.parts.filter((p) => p.clause === 0 && p.concept === "place" && !!p.value && /^(city|county|ambiguous):/.test(p.value)).length >= 2;
  const cityQualifiers = new Set<Part>();
  const parts = ledger0.parts.map((p) => {
    if (p.clause !== 0 || p.concept !== "place" || !p.value || !/^(city|county|ambiguous):/.test(p.value)) return p;
    const city = ledger0.parts.find((c) => c.clause === 0 && c.concept === "entity" && c.value === "city" && /^city$/i.test(c.text.trim())
      && c.span[0] >= p.span[1] && /^\s*$/.test(ledger0.question.slice(p.span[1], c.span[0])) && /^(city|ambiguous):/.test(p.value!));
    const pin = pins.get(p.span[0]) ?? deps.placePins?.get(p.text.trim().toLowerCase());
    const r: PlaceResolution = pin ? (pin.kind === "state" ? { kind: "unresolved", why: "state" } : { kind: "agency", place: { kind: "agency", ori: pin.agency.ori, label: agencyLabel(pin.agency) }, agency: pin.agency }) : resolvePlace(deps.places, p.value, city ? `${p.text} city` : p.text, inList);
    if (pin?.kind === "state") return { ...p, value: `state:${pin.name}` };
    if (r.kind === "unresolved") { if (r.named) unfound ??= p; return p; }
    if (r.kind === "ask") { ask ??= { part: p, name: r.name, candidates: r.candidates, more: r.more }; return p; }
    const value = `${r.agency.kind}:${r.agency.name}:${r.agency.state}`;
    if (city && r.agency.kind === "city") cityQualifiers.add(city);
    resolved.set(value, r.place);
    return { ...p, value };
  });
  const ledger = withParts(ledger0, parts.filter((p) => !cityQualifiers.has(p)));
  if (ask) {
    const a: { part: Part; name: string; candidates: Candidate[]; more?: boolean } = ask;
    const options: ShadowOption[] = a.candidates.map((c) => ({ label: candidateLabel(c, a.candidates, deps.places), continuation: fromLedger(ledger0, deps, new Map(pins).set(a.part.span[0], c)) }));
    // A question no choice could answer is declined, not asked about (D28): when no button leads to an answer or a
    // further question, the most likely reading's refusal is given.
    if (options.every((o) => o.continuation!.kind === "decline")) return options[0].continuation!;
    // Same-name towns: the rest of them are one typed place away (the place with its state).
    if (a.more) options.push({ label: `Another ${a.name}`, entry: "which city or agency" });
    const named = a.candidates.find((c) => c.kind === "agency");
    return { kind: "clarify", about: `which ${named?.kind === "agency" ? named.agency.name.replace(/ County$/, "") : a.name}`, question: ledger0.question, options };
  }

  // A place the index doesn't have says so, whatever else the question asks (coordinator 2026-11-03, Historical step
  // one): never P01's "figures don't answer this question", which named the wrong limit. Only a place named as one (with
  // its state, or as a county): a word the reader took for a place ("index", "summer") or a misspelling goes on as before.
  if (unfound) {
    const u: Part = unfound;
    // A county-wide sum asked for a county with no agency of its own in the file (P70, Jeff 2026-11-18): the one sentence, no offer.
    if (flags(ledger0).countywide && /\b(?:county|parish)\b/i.test(u.text))
      return decline("unresolved_place", `County-wide sums aren't given, and Crime Index has no agency for ${u.text.trim().replace(/[?.!,]+$/, "").replace(/,\s*[A-Za-z .]+$/, "")}.`);
    return decline("unresolved_place", `I couldn't find "${u.text.trim().replace(/[?.!,]+$/, "")}" among the city and county police agencies, states and the nation here.`);
  }

  // D31 for the Crime Index's annual figures (query-log step one, 2026-11-02: "murders in Philadelphia"): every year it
  // has, by year; the latest complete year; or another year.
  function askCrimeIndexPeriod(): ShadowOutcome {
    const lcy = Number(release.lastMonth.slice(0, 4)) - 1;
    return { kind: "clarify", about: "which period", question: ledger0.question, options: [
      { label: "Every year available", continuation: fromLedger(filled(ledger, "grain", "year", "by year"), deps, pins) },
      { label: `The latest complete year (${lcy})`, continuation: fromLedger(filled(ledger, "period", `year:${lcy}`, `in ${lcy}`), deps, pins) },
      { label: "Another year", entry: "which year" }] };
  }
  // P148 (Jeff 2026-11-18), widened (crime in a place over time, Coordinator 2026-11-21): "crime", "overall crime", "all crimes" or a
  // crime trend, by year (Crime Index) or by month (Current Trends), for one place or several, is violent and property crime beside
  // their sum and the seven Part I offenses (crime-over-time.ts), not asked and not NIBRS's every offense. Only when all nine series
  // answer as one source's series for the same places; otherwise the question keeps the path below.
  {
    const ms = clause0("measure"), grains = clause0("grain").map((g) => g.value);
    const partI = (p: Part) => p.state === "not-interpreted" && /^part\s+(?:1|i|one)(?:\s+ucr)?$/i.test(p.text.trim());
    const hasPartI = ledger0.parts.some((p) => p.clause === 0 && partI(p));
    // Nothing else asked: offenses is allowed, but no arrests, victims, breakdown, cohort, filter or source named.
    const onlyCrimeOverTime = ledger0.parts.every((p) => p.clause !== 0 || p.state === "context" || ["measure", "place", "period", "grain", "statistic"].includes(p.concept)
      || (p.concept === "unit" && p.value === "offenses") || partI(p) || (p.state === "not-interpreted" && pureFillerOnly(p.text)))
      && clause0("statistic").every((p) => /^(?:count|rate|per100k|percapita)$/.test(String(p.value ?? "")));
    const f0 = flags(ledger0);
    if (onlyCrimeOverTime && ((ms.length === 0 && (hasPartI || clause0("place").length >= 1)) || (ms.length === 1 && (ms[0].value === "unspecified" || ms[0].value === "all_crime"))) && grains.length <= 1 && (grains.length === 0 ? !deps.noDefaults && !/\bscore\s*cards?\b|\breport\s+cards?\b/i.test(deps.asked ?? ledger0.question) && !ledger0.parts.some((p) => p.clause === 0 && p.state === "not-interpreted" && !partI(p)) : grains[0] === "month" || grains[0] === "year")
      && clause0("place").length >= 1 && !f0.comparison && !f0.combined && !f0.nibrsAsked && !f0.shrAsked && !f0.consistent && !f0.people && !f0.clearance && !f0.region) {
      // No grain named (a bare place, "crime in Memphis over the last 10 years", "crime trends in X"): P181 every-year default, by year (the
      // Crime Index), said with P182 kind-of-crime default, instead of asking which kind of crime (Engine 2.0 2026-11-24, wrong clarifies).
      const noGrain = grains.length === 0;
      const compositeLedger = withParts(ledger, ledger.parts.filter((p) => !(p.clause === 0 && (partI(p) || (p.concept === "unit" && p.value === "offenses")))));
      const base = noGrain ? filled(compositeLedger, "grain", "year", "by year") : compositeLedger;
      const parts = COMPOSITE_PARTS.map((p) => fromLedger(filledAll(base, "measure", [[p.measure, p.words]]), deps, pins));
      const rate = clause0("statistic").some((p) => /^(?:rate|per100k|percapita)$/.test(String(p.value ?? "")));
      const merged = parts.every((o) => o.kind === "current" || o.kind === "historical" || o.kind === "srs") ? composeCrimeOverTime(parts as never, rate) : null;
      if (merged && merged.kind === "none") return decline("outside_release_coverage", `No data is available for crime in ${merged.label}.`);
      if (merged && noGrain && merged.kind === "historical") {
        const m = merged as unknown as { delivered: { text: string[]; table: { rows: unknown[][] } } };
        const rows = m.delivered.table.rows, first = String(rows[0]?.[0] ?? ""), last = String(rows[rows.length - 1]?.[0] ?? "");
        const hasPeriod = clause0("period").length > 0;
        const say = ["No kind of crime was named, so violent crime and property crime are shown.",
          ...(hasPeriod || first === last || !/^\d{4}/.test(first) ? [] : [`No years were given, so every year in the data is shown: ${first.slice(0, 4)} through ${last.slice(0, 4)}.`])];
        return { ...m, delivered: { ...m.delivered, text: [m.delivered.text[0], ...say, ...m.delivered.text.slice(1)] } } as unknown as ShadowOutcome;
      }
      if (merged) return merged as ShadowOutcome;
      // Violent and property crime both answered with every cell blank (an agency Current Trends lists with no figures), the
      // composite not built because an offense's answer is a decline: no data, as P148 said, not the ask of the kind.
      const allBlank = (o: ShadowOutcome) => (o.kind === "current" || o.kind === "historical" || o.kind === "srs") && o.delivered.table.rows.every((r) => r.every((x) => typeof x !== "number"));
      if (allBlank(parts[0]) && allBlank(parts[1])) {
        const pq = (parts[0] as { question?: { place?: { label?: string }; agencies?: { label: string }[] } }).question;
        return decline("outside_release_coverage", `No data is available for crime in ${pq?.place?.label ?? pq?.agencies?.[0]?.label ?? "this place"}.`);
      }
    }
  }
  // D31: ask for a missing crime, place or period, one at a time, before any default is applied.
  const named = clause0("measure").some((p) => p.value !== "unspecified");
  // A place and no crime at all ("minneapolis", "philadelphia murders" misread aside: bad-decline audit root cause 1,
  // 2026-11-06) asks which crime too, when every other word was read; never a staffing question or an ask outside the
  // data, which have their own declines below.
  const noCrime = !clause0("measure").length && clause0("place").length > 0
    && !ledger0.parts.some((p) => p.clause === 0 && (p.state === "not-interpreted" || p.state === "not-recorded"))
    && !STAFFING.test(ledger0.question) && !OUTSIDE.some(([re]) => re.test(ledger0.question))
    // A state's agencies asked for ("which agencies are in Tennessee in 2023") are listed (item 11b), not a crime asked.
    && !(clause0("entity").some((p) => p.value === "agency") && clause0("place").length === 1 && /^state:/.test(String(clause0("place")[0].value)));
  // Jeff 2026-11-14: when both the crime and the place are missing, the place is asked first (the crime ask follows once
  // a place is chosen): "Crimes Against Property" asks which place, then which crime.
  // Not when an unrecognized phrase looks like a place that was named but not found ("st augustian fl crime": it ends in a state
  // abbreviation): a place was named, so the crime is asked first. Other unread words don't stop the place being asked first.
  const STATE_END = /\s(?:al|ak|az|ar|ca|co|ct|de|fl|ga|ia|il|ks|ky|md|mi|mn|mo|ms|mt|nc|nd|ne|nh|nj|nm|nv|ny|ri|sc|sd|tn|tx|ut|va|vt|wa|wi|wv|wy|dc)\.?$/i;
  const placeFirst = !clause0("place").length && !ledger0.parts.some((p) => p.clause === 0 && p.concept === "unrecognized" && STATE_END.test(p.text.trim()));
  if (!named && !placeFirst && (clause0("measure").length || noCrime)) {
    // Each button runs now (coordinator 2026-11-02: never a button that can't run). A choice that would only be declined
    // is not offered; when none would answer, the first choice's decline is given, with its nearest question.
    const kinds = [{ label: "Violent crime", measures: [["violent_crime", "violent crime"]] }, { label: "Property crime", measures: [["property_crime", "property crime"]] },
      { label: "Both", measures: [["violent_crime", "violent crime"], ["property_crime", "property crime"]] }];
    const options = kinds.map((k) => deferHeavy(k.label, (d) => fromLedger(filledAll(ledger, "measure", k.measures), d, pins), deps));
    const runnable = options.filter(optionRuns);
    if (!runnable.length) {
      const d0 = options[0].continuation!;
      return partYear({ grain: clause0("grain")[0]?.value ?? "total" }, flags(ledger0).comparison)
        ? decline("unsupported_capability", "Violent and property crime totals are whole years only.", { alternative: byYearInstead(ledger, deps, pins) })
        : d0;
    }
    // "Another crime" (Jeff 2026-11-15): a victim-age question without a crime may name its own ("Which crime?").
    const ageAsked = ledger0.parts.some((p) => p.clause === 0 && p.concept === "breakdown" && /age/.test(String(p.value)));
    // P182 (no kind of crime named) is applied once, at the top (applyDefaults picks the "Both" button): never here, where this ask is also built
    // inside other asks' buttons and a default would run its statements for every button (the gate found a 1 s question taking 218 s).
    return { kind: "clarify", about: "which kind of crime", question: ledger0.question, options: ageAsked ? [...runnable, { label: "Another crime", entry: "which crime" }] : runnable };
  }
  // D09 beside another crime ("homicide and crime rates", "murder and crime"): the bare word is asked about too, never
  // dropped (query-log scorecard 2026-11-04). Each button keeps the crimes named and adds the kind chosen.
  // Only a "crime" joined to them ("and", ",", "plus"): in "drug crimes" the word is part of the crime's own name.
  const others = clause0("measure").filter((p) => p.value !== "unspecified");
  // Either order ("homicide and crime rates", "crime and murder rates": Codex P32 review 01.1); never a named category
  // ("crimes against persons", 01.3).
  const before = (p: Part) => ledger0.question.slice(Math.max(0, p.span[0] - 16), p.span[0]);
  const after = (p: Part) => ledger0.question.slice(p.span[1], p.span[1] + 24);
  // A "crimes" right after a crime named is that crime's own word ("drug crimes and shoplifting", "gun crimes").
  const owned = (p: Part) => clause0("measure").some((o) => o !== p && o.value !== "unspecified" && o.span[1] <= p.span[0] && /^[\s-]*$/.test(ledger0.question.slice(o.span[1], p.span[0])));
  const joined = (p: Part) => !owned(p) && !/^\s*against\b/i.test(after(p))
    && (/(?:\band|&|,|\bplus)\s+(?:overall\s+|total\s+|general\s+)?$/i.test(before(p))
      // After it: "and" a crime the reader named ("crime and murder rates", "crime and drug possession", "crime rates and
      // aggravated assault rates": Codex P32 re-check 01), never a list of columns ("Part 1 Crimes, Total Rate").
      || clause0("measure").some((o) => o.value !== "unspecified" && o.span[0] >= p.span[1]
        && /^\s*(?:rates?\s+)?(?:and|&|plus)\s+(?:the\s+)?$/i.test(ledger0.question.slice(p.span[1], o.span[0]))));
  const bare = clause0("measure").filter((p) => p.value === "unspecified" && joined(p));
  if (named && bare.length) {
    const keep = others.map((p) => [String(p.value), p.text.trim()]);
    const said = others.map((p) => p.text.trim().replace(/\s+rates?$/i, "")).join(" and ");
    const kinds = [{ label: `${said} and violent crime`, add: [["violent_crime", "violent crime"]] }, { label: `${said} and property crime`, add: [["property_crime", "property crime"]] },
      { label: `${said}, violent and property crime`, add: [["violent_crime", "violent crime"], ["property_crime", "property crime"]] }];
    const options = kinds.map((k) => deferHeavy(k.label[0].toUpperCase() + k.label.slice(1), (d) => fromLedger(filledAll(ledger, "measure", [...keep, ...k.add]), d, pins), deps));
    const runnable = options.filter(optionRuns);
    if (runnable.length) return { kind: "clarify", about: "which kind of crime", question: ledger0.question, options: runnable };
    // No combination runs here yet (several crimes in one answer): said plainly, with the crimes named on their own offered.
    const alone = fromLedger(filledAll(ledger, "measure", keep), deps, pins);
    return decline("unsupported_capability", `"Crime" alone isn't one category, and ${said} beside violent or property crime in one answer isn't available. Ask for each on its own.`,
      { alternative: runsNow(alone) ? { label: `${said[0].toUpperCase()}${said.slice(1)} on its own`, continuation: alone } : null });
  }
  // P32 (Jeff 2026-10-29): "sex offenses", "sex crimes", "sexual assaults" name no one offense. Ask which, with buttons
  // (rape; all sex offenses), rather than choose a definition. "All sex offenses" (or "forcible") names it.
  // Not when the words leave them out ("violent crimes, excluding sexual offenses").
  const sexPart = clause0("measure").find((p) => p.value === "sex_offense"
    && !/\b(?:excluding|exclude|except|without|not including|other than|minus|but not)\s+(?:the\s+)?$/i.test(ledger0.question.slice(Math.max(0, p.span[0] - 24), p.span[0])));
  // "Forcible sex offenses" (11A-11D) is not a measure yet, so it is asked about too, never answered as all six codes.
  if (sexPart && sexPart.rule !== "shadow:button" && !(/\b(?:all|every|total)\b/i.test(sexPart.text) && !/\bforcible\b/i.test(sexPart.text))) {
    const keep = clause0("measure").filter((p) => p !== sexPart).map((p) => [String(p.value), p.text.trim()]);
    const options = [{ label: "Rape", add: [["rape", "rape"]] }, { label: "All sex offenses", add: [["sex_offense", "all sex offenses"]] }]
      .map((k) => deferHeavy(k.label, (d) => fromLedger(filledAll(ledger, "measure", [...keep, ...k.add]), d, pins), deps));
    const runnable = options.filter(optionRuns);
    if (runnable.length) return { kind: "clarify", about: "which sex offenses", question: ledger0.question, options: runnable };
  }
  // "The current murder trend" (Jeff 2026-11-05: Current Trends'): by month from January of last year through the
  // latest month, unless a period is named. Current Trends answers it where it has the place; NIBRS otherwise.
  if (clause0("recent").length) {
    const rest = withParts(ledger, ledger.parts.filter((p) => !(p.clause === 0 && p.concept === "recent")));
    if (clause0("period").length) return fromLedger(rest, deps, pins);
    const from = Number(deps.release.lastMonth.slice(0, 4)) - 1;
    return fromLedger(filled(filled(rest, "period", `since:${from}`, `since ${from}`), "grain", "month", "by month"), deps, pins);
  }
  // A rolling window with no length named ("rolling average", "rolling sum"): asked (Jeff 2026-11-05: "Ask which
  // length"), with buttons for 3, 6 and 12 months that each run the whole question, never a length chosen here.
  const noLength = clause0("rolling").find((p) => /:\?$/.test(String(p.value)));
  if (noLength) {
    const avg = String(noLength.value).startsWith("rolling-avg");
    const options = [3, 6, 12].map((n) => deferHeavy(`${n} months`,
      (d) => fromLedger(filled(ledger, "rolling", avg ? `rolling-avg:${n}` : n === 12 ? "rolling12" : `rolling:${n}`, `rolling ${n}-month ${avg ? "average" : "total"}`), d, pins), deps));
    const runnable = options.filter(optionRuns);
    if (runnable.length) return { kind: "clarify", about: "which rolling window", question: ledger0.question, options: [...runnable, { label: "Another length", entry: "how many months" }] };
    return options[0].continuation!;
  }
  if (!clause0("place").length) {
    // "Big cities" or "the N largest cities" with no place named are the whole country's, said (Jeff 2026-11-11: "yes",
    // with the answer saying so), when that answers; anything else is asked as before, never a decline in place of the
    // ask (job S: 36 questions that asked the place declined instead).
    // The whole country's answer, or what it still asks (the period: job S2, the labels Jeff's decision moved); a
    // decline keeps the place asked, as before.
    if (flags(ledger0).largeCities || flags(ledger0).largestSet) {
      const ranked = shrCityRanking(ledger, ledger0, deps, (l) => fromLedger(l, deps, pins));
      if (ranked) return ranked;
      // "Big cities" that rank nothing ("Other large cities and violent crime"): the leftover "cities" and "other" aren't
      // a question of their own, so the whole country's is read without them (job S4).
      const ranks = ledger.parts.some((p) => p.clause === 0 && p.concept === "rank");
      const leftover = (p: Part) => p.clause === 0 && !ranks && ((p.concept === "entity" && p.value === "city") || /^(?:other|the\s+other)$/i.test(p.text.trim()));
      const nation = fromLedger(filled(withParts(ledger, ledger.parts.filter((p) => !leftover(p))), "place", "national", "the United States"), deps, pins);
      if (["historical", "current", "srs", "answer"].includes(nation.kind)) {
        const said = nation as unknown as { delivered?: { text: string[] } };
        said.delivered?.text.splice(1, 0, "No place was named, so these are cities across the United States.");
        return nation;
      }
      if (nation.kind === "clarify") return { ...nation, question: ledger0.question, note: "No place was named, so these are cities across the United States." };
      // Another source's question (Homicide Reports details) is routed there, never asked about a place.
      if (nation.kind === "route") return nation;
      // A set never turns a capability decline into a place ask (coordinator 2026-11-11: "Chart domestic violence calls
      // over time in the four largest cities"): a topic the data doesn't record, or crimes named of which none is one the
      // sets answer (Part I), keep the decline. Words the reader left unread don't: before this PR the place was asked
      // first (job S4: "homicide totals in top 15 cities" declined instead of asking).
      const measures0 = ledger0.parts.filter((p) => p.clause === 0 && p.concept === "measure" && p.value !== "unspecified");
      // Police staffing is answered for agencies, never sets of cities (QL-hist-07bf6d2063).
      const capability = ledger0.parts.some((p) => p.clause === 0 && p.state === "not-recorded") || STAFFING.test(ledger0.question)
        || (measures0.length > 0 && !measures0.some((p) => isHistoricalMeasure(String(p.value))));
      if (nation.kind === "decline" && capability) return nation;
      // Big cities ranked by a Homicide Reports detail (a weapon, a share, a victim's age, race or sex, a relationship or
      // circumstance): Homicide Reports' question, routed until they answer here (coordinator 2026-11-11).
      const murderish = measures0.length > 0 && measures0.every((p) => ["murder", "homicide", "homicide_all"].includes(String(p.value)));
      const detail = ledger0.parts.some((p) => p.clause === 0 && ((p.concept === "filter" && /^weapon:/.test(String(p.value))) || p.concept === "share"))
        || /\b(?:teen\w*|juvenile|age|race|sex|gender|relationship|circumstance)\b/i.test(ledger0.question)
        // The reader sets people ("teenage victims") and circumstances aside from its words.
        || !!flags(ledger0).people || !!flags(ledger0).shrDetail || !!flags(ledger0).circumstance;
      // Never a clearance ("the share of murders cleared": Codex review 13.1), which isn't a Homicide Reports detail.
      const cleared = !!flags(ledger0).clearance || ledger0.parts.some((p) => p.clause === 0 && (p.concept === "clearance" || p.concept === "clearance-reason"));
      if (nation.kind === "decline" && murderish && detail && !cleared)
        return { kind: "route", source: "shr", explanation: "Cities ranked by a homicide detail (a weapon, a share, the victims' age, race or sex) come from Homicide Reports. Homicide Reports aren't available here; the Homicide Reports tab has them." };
    }
    // States ranked are the nation's states (Jeff 2026-11-10, ranking decision 5): no place to ask.
    if (clause0("rank").length && clause0("entity").some((p) => p.value === "state")) return fromLedger(filled(ledger, "place", "national", "the United States"), deps, pins);
    // P170 (Jeff 2026-11-21): no place named is the United States, said, with buttons to pick a place; asked as before only when that cannot answer now.
    // The national clearance share by type is exempt from the heavy-statement deferral (coordinator 2026-11-22, Jeff's P122: decline while too slow,
    // make it work later): the runner timed it at 5.5 s with the cube on (6.3 s off), under the threshold. Narrow: only a share of a clearance type.
    const nationalClearanceShare = (ledger0.parts.some((p) => p.clause === 0 && p.concept === "share") && CLEARANCE_WORDS.test(ledger0.question)) || !!deps.shareAsked;
    const nationOption = deferHeavy("The United States", (d) => fromLedger(filled(ledger, "place", "national", "the United States"), d, pins),
      nationalClearanceShare ? { ...deps, deferChars: Number.MAX_SAFE_INTEGER } : deps);
    const placeButtons: ShadowOption[] = [{ label: "A state", entry: "which state" }, { label: "A city or agency", entry: "which city or agency" }];
    // "By state" has the nation's states as its rows (Engine 2.0, 2026-11-22): no note and no place buttons beside a table of every state.
    const byStateRows = /\b(?:by|per|each|every|for\s+each)\s+state\b/i.test(ledger0.question);
    const nationDefault = deps.noDefaults ? null : withDefault(nationOption, byStateRows ? "" : "No place was named, so the United States is shown.", byStateRows ? [] : placeButtons, "place");
    if (nationDefault) return nationDefault;
    // P187 (no partial answers, Jeff 2026-11-21): peer or similar cities with no place named ("murders compared to peer cities") get the peer
    // decline, as with a place named, never an ask for a place that would answer without the peers.
    if (!isDeferred(nationOption) && nationOption.continuation?.kind === "decline" && ledger0.parts.some((p) => p.clause === 0 && p.concept === "peer"))
      return nationOption.continuation;
    return { kind: "clarify", about: "which place", question: ledger0.question, options: [nationOption, ...placeButtons] };
  }
  // P53: murders by a Homicide Report detail for a state or the nation are Homicide Reports' (named, not run here).
  const geoOnly = (ps: Part[]) => ps.length > 0 && ps.every((p) => p.value === "national" || /^state:/.test(p.value ?? ""));
  if (flags(ledger0).shrDetail && geoOnly(clause0("place")) && !flags(ledger0).nibrsAsked && !deps.shr)
    return { kind: "route", source: "shr", explanation: "Murders by victim-offender relationship come from Homicide Reports, which count the homicides agencies reported to the FBI, not a complete national estimate. Homicide Reports aren't available here." };
  // Item 11 (bad-decline audit 2026-11-06): population on its own, for agencies, states or the nation.
  const list = agencyListQuestion(ledger, ledger0, deps);
  // A list is for one year: the year is asked with buttons that run (Codex population review 02.3: "Every year
  // available" was offered and declined).
  if (list === "ask period") {
    const y = deps.historical!.lastYear;
    return { kind: "clarify", about: "which year", question: ledger0.question, options: [
      { label: `The latest year (${y})`, continuation: fromLedger(filled(ledger, "period", `year:${y}`, `in ${y}`), deps, pins) },
      { label: "Another year", entry: "which year" }] };
  }
  if (list) return list;
  const pop = populationQuestion(ledger, ledger0, deps, resolved);
  if (pop) return pop === "ask period" ? askCrimeIndexPeriod() : pop;
  const d = matchNibrsType(ledger, SHADOW_MATCH);
  // "The N largest cities" (Jeff 2026-11-10, ranking decisions 1-2): the N city agencies with the most residents, in a
  // state or the nation, and one Part I figure for each, from Crime Index. Anything else with the set is declined, never
  // answered as if the set weren't there.
  // Before every other route: a national or state total must never stand in for the set.
  const setN = flags(ledger0).largestSet;
  // Staffing with a crime is one dataset at a time (Jeff 2026-11-11), also for a set of cities.
  if (setN && staffingBesideWords(ledger0.question) && ledger0.parts.some((p) => p.clause === 0 && p.concept === "measure")) return decline("unsupported_capability", STAFF_MIXED_TEXT);
  // The set ranked ("ranked by their murder rate"): the rank word has no places of its own to rank (the set's words were
  // taken out), so the question is matched without it and the set is ordered by the figure.
  const setRank = setN ? ledger.parts.find((p) => p.clause === 0 && p.concept === "rank") : undefined;
  const dSet = setN && setRank && d.kind !== "spec" ? matchNibrsType(withParts(ledger, ledger.parts.filter((p) => p !== setRank)), SHADOW_MATCH) : d;
  // All the cities (Jeff 2026-11-16): the cities of 250,000 or more, ranked by the figure, every one shown; said in the title (the floor, how many).
  const allCities = setN === ALL_CITIES_N && !!flags(ledger0).allCities;
  const setWords = allCities ? "cities of 250,000 or more" : `${setN} largest cities`;
  if (setN && dSet.kind !== "spec") return decline("unsupported_capability", `This isn't available: the ${setWords} with this question.`);
  if (setN && dSet.kind === "spec") {
    const sp0 = dSet.spec;
    const rankDir: "top" | "bottom" | null = allCities ? "top" : setRank ? (/^bottom/.test(String(setRank.value)) ? "bottom" : "top") : null;
    // A series of the set, or the set ranked ("the 20 most populous cities ranked by their murder rate"): one crime, a
    // count or a rate, the nation or a state; a ranking orders the set by the figure, highest first.
    const one = sp0.type === "series" ? (sp0.measures.length === 1 && !sp0.filters.length && !sp0.window && sp0.places.length === 1
        ? { measure: sp0.measures[0], unit: sp0.unit, statistic: sp0.statistic, place: sp0.places[0], period: sp0.period, ordered: rankDir as null | "top" | "bottom" } : null)
      : sp0.type === "rank" && !sp0.min && sp0.entity !== "state" ? { measure: sp0.measure, unit: null, statistic: sp0.statistic, place: sp0.scope, period: sp0.period, ordered: sp0.rank?.dir ?? "top" } : null;
    // The unit asked must be the one Crime Index counts ("robbery victims" isn't; Codex rankings review 01.1); a region,
    // "combined" or a supporting column is never dropped (01.2).
    const fits = !!deps.historical && !!one && isHistoricalMeasure(one.measure) && (one.statistic === "count" || one.statistic === "rate")
      && historicalUnitFits(one.measure, one.unit) && !flags(ledger0).region && !flags(ledger0).combined && !flags(ledger0).column
      && (one.place.kind === "national" || one.place.kind === "state")
      && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance
      && !flags(ledger0).people && !flags(ledger0).composite && !flags(ledger0).arrestsThrough && !flags(ledger0).largeCities
      && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
    if (fits && one) {
      const hb = deps.historical!;
      if (one.period.form === "none") {
        const y = hb.lastYear;
        return { kind: "clarify", about: "which period", question: ledger0.question, options: [
          { label: `${y}`, continuation: fromLedger(filled(ledger, "period", `year:${y}`, `in ${y}`), deps, pins) }, { label: "Other years", entry: "which years" }] };
      }
      const yrs = yearSpan({ period: one.period, grain: "total" }, Number(release.lastMonth.slice(0, 4)), hb.firstYear);
      const state = one.place.kind === "state" ? one.place.code.toUpperCase() : "US";
      // "So far in 2025": the year's months to date, from Current Trends (decision 4), never Crime Index's full year (01.3).
      const toDate = saysToDate(ledger0);
      const statistic = one.statistic === "rate" ? "rate" as const : "count" as const;
      // The set ranked: one year only, ordered by the figure (blanks last), said; "top N cities" with no "by ..." read as
      // the N largest is said too (Jeff 2026-11-10: "Top 100 cities in that case I guess could be the 100 biggest").
      const order = <T extends { delivered: { table: { rows: unknown[][] }; text: string[] } }>(r: T): T => {
        const top = flags(ledger0).topAsLargest;
        if (top) r.delivered.text.splice(1, 0, `"${top}" is read as the ${setN} largest cities by population; ask "by" a crime to rank by it instead.`);
        if (!one.ordered || !yrs || yrs[0] !== yrs[1]) return r;
        const v = (row: unknown[]) => row[row.length - 1] as number | null;
        r.delivered.table.rows.sort((a, b) => (v(a) === null ? 1 : v(b) === null ? -1 : one.ordered === "top" ? v(b)! - v(a)! : v(a)! - v(b)!) || String(a[0]).localeCompare(String(b[0])));
        for (let i = 0; i < r.delivered.text.length; i++) r.delivered.text[i] = r.delivered.text[i].replace(", largest first;", ";");
        r.delivered.text.splice(1, 0, `Ordered by the ${statistic === "rate" ? "rate" : "count"}, ${one.ordered === "top" ? "highest" : "lowest"} first.`);
        return r;
      };
      if (one.ordered && yrs && yrs[0] !== yrs[1]) return decline("unsupported_capability", allCities ? "This isn't available: the cities of 250,000 or more over several years. Ask for one year." : "This isn't available: the largest cities ranked over several years. Ask for one year.");
      if (yrs && yrs[1] <= hb.lastYear && !toDate) {
        const r = allCities
          ? answerHistoricalRanking({ measure: one.measure, state, year: yrs[0], statistic, direction: "top", limit: ALL_CITIES_N, minPopulation: 250000, floorAsked: true, entity: "city" }, hb, deps.execute)
          : answerHistoricalSet({ measure: one.measure, state, from: yrs[0], to: yrs[1], statistic, n: setN }, hb, deps.execute);
        if (r.kind === "historical") return allCities ? r : order(r);
        return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
      // Past Crime Index's last year (2026): Current Trends' sample cities, January through its latest month (decision 4).
      const cur = deps.current;
      const ctSpan = yrs && yrs[0] === yrs[1] && cur ? currentYearSpan(yrs[0], cur, toDate) : null;
      if (ctSpan && cur) {
        const r = answerCurrentRanking({ measure: one.measure, state, from: ctSpan[0], to: ctSpan[1], statistic,
          pick: allCities ? { kind: "rank", direction: "top", limit: ALL_CITIES_N } : { kind: "largest", n: setN },
          minPopulation: allCities ? 250000 : null, floorAsked: allCities, entity: "city" }, cur, hb.root, deps.execute, rankAgencies);
        if (r.kind === "current") return allCities ? r : order(r);
        return decline("unsupported_capability", r.explanation);
      }
      if (yrs) return decline("outside_release_coverage", `The largest cities' yearly figures in Crime Index run through ${hb.lastYear}; ${yrs[1]} isn't in them.`);
    }
    return decline("unsupported_capability", `This isn't available: the ${setWords} with this question. They can be asked for one Part I crime, a count or a rate, by year through ${deps.historical?.lastYear ?? 2025}.`);
  }
  // P70 (Jeff 2026-11-18, overriding 2026-10-30): a county-wide sum is never given. The decline says whose figures the county's are (its own
  // agency, the sheriff or county police: P25) and offers the question for that agency, the question as asked without the county-wide words.
  if (flags(ledger0).countywide) {
    const counties = ledger.parts.filter((p) => p.clause === 0 && p.concept === "place" && /^county:/.test(String(p.value)))
      .flatMap((p) => { const pl = resolved.get(String(p.value)); return pl?.kind === "agency" ? [{ name: String(p.value).split(":")[1] ?? p.text.trim(), ori: pl.ori }] : []; });
    const theAgency = (ori: string) => reportedBy([agencyName(deps.places, ori)]).replace(/^Reported by /, "").replace(/\.$/, "");
    const sentence = counties.length === 1
      ? `County-wide sums aren't given; the figures for ${counties[0].name} are those of ${theAgency(counties[0].ori)}.`
      : counties.length > 1 ? "County-wide sums aren't given; the figures for each county are those of its own agency."
      : "County-wide sums aren't given; the figures for a county are those of its own agency.";
    const offered = tidy((deps.asked ?? ledger0.question).replace(COUNTYWIDE_RE, " "));
    const out = decline("unsupported_capability", sentence);
    // The offer must run: an answer, or an ask for the next part (never a button that leads to a decline).
    const runs = counties.length > 0 && !!offered && !deps.checkingOffer && ["answer", "historical", "srs", "current", "shr", "hate", "coverage", "clarify"]
      .includes(shadowAnswer(offered, { ...deps, checkingOffer: true, asked: undefined }).kind);
    return runs ? { ...out, alternative: { label: `Ask instead: "${offered}"`, question: offered } } as ShadowOutcome : out;
  }
  // "Where does Durham rank in murder rate in 2024?" (Jeff 2026-11-10, ranking decision 4): with no scope named, asked
  // (among the state's cities, or among U.S. cities of its size); "nationally" is the size group, "in the state" or the
  // city's own state named is the state. Only with one Part I crime and one year named; otherwise the usual asks.
  {
    const c0 = ledger.parts.filter((p) => p.clause === 0);
    const rankWord = c0.find((p) => p.concept === "rank" && p.value === "rank:");
    const cities = c0.filter((p) => p.concept === "place" && /^city:/.test(String(p.value)));
    const measures = c0.filter((p) => p.concept === "measure");
    const periods = c0.filter((p) => p.concept === "period" && /^year:\d{4}$/.test(String(p.value)));
    // "In the state" is read as an entity "state": it is the scope here (Codex rankings-B review 01.5).
    const inStateWords = /\bin\s+(?:the|their|its)\s+state\b/i.test(ledger0.question);
    const others = c0.filter((p) => p.state !== "context" && !["rank", "place", "measure", "period", "statistic"].includes(p.concept)
      && !(p.state === "not-interpreted" && /^(?:where|how)\s+does$/i.test(p.text.trim())) && !(inStateWords && p.concept === "entity" && p.value === "state"));
    // A count or a rate per 100,000 only ("per 1,000" keeps the matcher's decline), never the year to date (01.3).
    const statOk = c0.filter((p) => p.concept === "statistic").every((p) => ["rate", "per100k", "percapita", "count"].includes(String(p.value)));
    const geo = c0.filter((p) => p.concept === "place" && !/^city:/.test(String(p.value)));
    const hb = deps.historical;
    if (rankWord && hb && cities.length === 1 && measures.length === 1 && isHistoricalMeasure(String(measures[0].value)) && periods.length === 1 && !others.length
      && statOk && !saysToDate(ledger0) && geo.length <= 1 && !qualified(ledger0)) {
      const [, cityName, cityState] = String(cities[0].value).split(":");
      const a = resolved.get(`city:${cityName}:${cityState}`);
      const year = Number(String(periods[0].value).slice(5));
      const statistic = c0.some((p) => p.concept === "statistic" && ["rate", "per100k", "percapita"].includes(String(p.value))) ? "rate" as const : "count" as const;
      if (a?.kind === "agency") {
        const g = geo[0];
        const inState = inStateWords || (g && /^state:/.test(String(g.value)) && placeOf(g)?.kind === "state" && (placeOf(g) as { code: string }).code.toUpperCase() === cityState.toUpperCase());
        const nationally = g?.value === "national";
        const run = (scope: "state" | "size") => {
          const r = answerHistoricalPosition({ measure: String(measures[0].value), ori: a.ori, label: a.label, state: cityState.toUpperCase(), year, statistic, scope }, hb, deps.execute);
          return r.kind === "historical" ? r : decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
        };
        if (g && !inState && !nationally) return decline("unsupported_capability", `${a.label} is ranked among its own state's cities or among U.S. cities of its size.`);
        if (inState) return run("state");
        if (nationally) return run("size");
        // Always asked (Jeff): a choice that can't run is left out and said, never chosen silently (01.5).
        const all = [{ label: `Among ${stateName(cityState.toUpperCase())} cities`, continuation: run("state") }, { label: "Among U.S. cities of similar size", continuation: run("size") }];
        const options = all.filter((o) => runsNow(o.continuation));
        if (!options.length) return all[0].continuation;
        const gone = all.find((o) => !runsNow(o.continuation));
        return { kind: "clarify", about: "which cities to rank against", question: ledger0.question, options,
          ...(gone ? { note: `${gone.label} isn't available: ${(gone.continuation as { explanation?: string }).explanation ?? ""}`.trim() } : {}) };
      }
    }
  }
  // Police staffing (Crime Index's staffing tables: officers and civilian employees) isn't built here yet: said plainly,
  // never "couldn't tell what this asks" (query-log step one, 2026-11-02: 1 in 8 of the Historical tab's first questions).
  // "Assaults on officers" is not staffing; "the number of police officers" is.
  if (STAFFING.test(ledger0.question) && !/(?<!\b(?:number|numbers|count|counts|total|rate|rates|ratio|level|levels|size|percentage)\s)\b(?:on|against|of)\s+(?:police\s+)?officers\b/i.test(ledger0.question) && (!ledger0.parts.some((p) => p.concept === "measure" && p.state === "recognized") || staffingBesideWords(ledger0.question))) {
    // Item 1: an agency's staffing, from the Crime Index build; anything it can't answer keeps a plain decline.
    const staff = staffingQuestion(ledger, ledger0, deps, resolved);
    if (staff === "ask period") return askCrimeIndexPeriod();
    if (staff) return staff;
    return decline("unsupported_capability", "Police staffing is answered for agencies, by year: sworn officers, civilian employees or all employees, as counts or per 100,000 people. This question asks for something else.");
  }
  // Asks outside the data, each with its own limit (coordinator 2026-11-03, Historical step one cause 7), never "I couldn't
  // tell what this asks". The measure-less ones only when no crime was recognized.
  const noMeasure = !ledger0.parts.some((p) => p.concept === "measure" && p.state === "recognized");
  const outside = OUTSIDE.find(([re, needsNoMeasure]) => re.test(ledger0.question) && (!needsNoMeasure || noMeasure));
  if (outside) return decline("unsupported_capability", outside[2]);
  if (d.kind === "none") return decline("reader", "I couldn't tell what this question asks for. Try naming a crime, a place and a year, for example \"robberies in Denver in 2024\".");
  // A rate month by month (coordinator 2026-11-05): the rate for the months together and the counts by month, each
  // offered when it runs. Whether to give monthly rates at all is Jeff's (the Current Trends design note's scope choice).
  if (d.kind === "decline" && /not for single months/.test(d.explanation)) {
    const own = (c: string, v?: string) => (p: Part) => p.clause === 0 && p.concept === c && (v === undefined || p.value === v);
    // Only when a part is taken out: a month or a rate from other words ("in May 2025", "clearance rate") would ask again.
    const without = (drop: (p: Part) => boolean): ShadowOutcome | null =>
      ledger.parts.some(drop) ? fromLedger(withParts(ledger, ledger.parts.filter((p) => !drop(p))), deps, pins) : null;
    const together = without(own("grain", "month")) ?? decline("reader", "");
    const counts = without(own("statistic")) ?? decline("reader", "");
    const offers: ShadowOption[] = [
      ...(runsNow(together) && together.kind !== "clarify" ? [{ label: answerDimensions(together)?.includes("time.year") ? "The rate by year" : "The rate for the whole period", continuation: together }] : []),
      ...(runsNow(counts) && counts.kind !== "clarify" ? [{ label: ledger.parts.some(own("grain", "month")) ? "The counts by month" : "The count instead", continuation: counts }] : []),
    ];
    const o = decline(readerReason(d.explanation), plainReaderExplanation(d.explanation), { alternative: offers[0] ?? null, detail: d.explanation });
    return offers.length > 1 ? { ...o, more: offers.slice(1) } as ShadowOutcome : o;
  }
  // P74: the reader's refusal in plain words, with the question without the words it couldn't use when that reads.
  if (d.kind === "decline") return decline(readerReason(d.explanation), plainReaderExplanation(d.explanation),
    { alternative: askInstead(ledger.question, d.parts, Number(deps.release.lastMonth.slice(0, 4))), detail: d.explanation });
  if (d.kind === "clarify") return decline("reader", d.explanation);
  // P53 (increment 5): a Part I offense for a state or the nation is the historical file's in a completed year
  // (FBI SRS), Current Trends' this year; unless NIBRS is asked for in words (P01). Its clearance rate is the
  // historical clearances' for the nation (P57) and declined for a state (P18).
  // An every-month cohort (P61's button, typed) keeps the question in NIBRS: the historical file has no cohorts.
  // Current Trends (design note 2026-11-03, section 4): a Part I offense by month for a Current Trends agency, a state,
  // a region or the nation, unless another source is named (P01) or a detail is asked (NIBRS's or SHR's). Counts only
  // for now. An agency Current Trends doesn't have goes on to NIBRS (P01's fallback).
  if (deps.current && d.spec.type === "series" && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !(ledger0 as { skipCurrent?: boolean }).skipCurrent && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance
    && !flags(ledger0).people && !flags(ledger0).arrestsThrough && !flags(ledger0).composite && (d.spec.statistic === "count" || d.spec.statistic === "rate") && d.spec.measures.length === 1
    && d.spec.measures[0] in CURRENT_MEASURE && historicalUnitFits(d.spec.measures[0], d.spec.unit) && !d.spec.filters.length && d.spec.places.length >= 1
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept))) {
    const sp = d.spec, cur = deps.current, pl = sp.places[0];
    // The form asked: the rolling 12 months through the latest month; this year as one total is its year to date; a
    // range of months is each month when asked by month, otherwise one total (design note, section 3).
    const ctYear = Number(cur.lastMonth.slice(0, 4));
    let form: "months" | "ytd" | "rolling" | "total" | null = null, span: [string, string] | null = null;
    // "the last 12 months" is the 12 months through Current Trends' own latest month, not NIBRS's (the reader's).
    // P154 (Jeff 2026-11-19): "murders rolling over 12 months" is a series of rolling totals by month (not "the last 12 months", which stays one
    // total): from the first January with a full window (none named), or from the January of the year named; counts, Current Trends' months.
    const rollW = sp.window?.months ?? 12;
    const rollingSeries = sp.grain === "rolling" && !flags(ledger0).last12 && !sp.window?.average && sp.statistic === "count" && rollW >= 2
      && (sp.period.form === "none" || sp.period.form === "since" || sp.period.form === "range" || sp.period.form === "year");
    if (rollingSeries) {
      const pf = sp.period;
      const earliest = firstFullJanuary(cur.finalFirstMonth, rollW);
      const cap = (m: string) => (m > cur.lastMonth ? cur.lastMonth : m);
      let from = pf.form === "since" ? `${pf.from}-01` : pf.form === "range" ? `${pf.from}-01` : pf.form === "year" ? `${pf.year}-01` : earliest;
      const to = pf.form === "range" ? cap(`${pf.to}-12`) : pf.form === "year" ? cap(`${pf.year}-12`) : cur.lastMonth;
      let outside: string | undefined;
      if (from < earliest) {
        const gone = [from, shiftMonth(cur.finalFirstMonth, -1)];
        outside = `Current Trends figures in the data cover ${monthName(cur.finalFirstMonth)} through ${monthName(cur.lastMonth)}; ${monthName(gone[0])} through ${monthName(gone[1])} ${gone[0] === gone[1] ? "is" : "are"} outside them.`;
        from = earliest;
      }
      const region = flags(ledger0).region;
      const rp: (CurrentPlace | null)[] = sp.places.map((p) => {
        if (p.kind === "national") return region ? { kind: "group", states: REGIONS[region].states, label: REGIONS[region].name.replace(/^the/, "The") } : { kind: "group", states: null, label: "The United States" };
        if (p.kind === "state") return { kind: "group", states: [p.code], label: stateName(p.code) };
        const a = resolved.get(`${p.agencyKind}:${p.name}:${p.state}`);
        return a?.kind === "agency" ? { kind: "agency", ori: a.ori, label: a.label, name: p.name, state: p.state } : null;
      });
      const several = rp.length > 1;
      if (rp.every((p): p is CurrentPlace => p !== null) && (!several || rp.every((p) => p.kind === "agency")) && !flags(ledger0).combined && !flags(ledger0).comparison && !flags(ledger0).column) {
        const agencyIds = rp.flatMap((p) => (p.kind === "agency" ? [p.ori] : []));
        const r = answerCurrentRolling({ measure: sp.measures[0], places: rp as CurrentPlace[], from, to, window: rollW, ...(outside ? { outside } : {}),
          ...(agencyIds.length ? { agencyLine: reportedBy(agencyIds.map((o) => agencyName(deps.places, o))).replace(/^Reported by /, "Figures for ") } : {}) }, cur, deps.execute);
        if (r.kind === "current") return r;
        return decline(/outside them|not all in them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
    }
    if ((sp.grain === "rolling" && sp.period.form === "none" && !rollingSeries) || flags(ledger0).last12) { form = "rolling"; span = [cur.lastMonth, cur.lastMonth]; }
    // A rolling window ending in one month named ("rolling 3-month average in July 2026": Codex P94 review 01.1): that
    // window, through that month. A rolling series over a longer span is NIBRS's below, never Current Trends' months.
    else if (sp.grain === "rolling") {
      const one = sp.period.form === "month" ? `${sp.period.year}-${String(sp.period.month).padStart(2, "0")}` : null;
      if (one) { form = "rolling"; span = [one, one]; }
    }
    else if (sp.grain === "total" && sp.period.form === "year" && sp.period.year === ctYear) { form = "ytd"; span = [`${ctYear}-01`, cur.lastMonth]; }
    else if ((span = monthSpan(sp, cur))) form = sp.grain === "month" || span[0] === span[1] ? "months" : "total";
    // Several named agencies by month (Jeff 2026-11-15: Crime Index by default, one source for the whole table): one table from
    // Current Trends, an agency with no figure blank, never another source for part of it. No years named: every month it holds.
    if (sp.places.length > 1) {
      const ok = sp.places.every((p) => p.kind === "agency") && sp.grain === "month" && (sp.statistic === "count" || sp.statistic === "rate") && !flags(ledger0).combined && !flags(ledger0).comparison
        && !flags(ledger0).region && !flags(ledger0).column && !clause0("combine").length;
      const every = sp.period.form === "none";
      if (ok && (span || every)) {
        const list = sp.places.map((p) => (p.kind === "agency" ? resolved.get(`${p.agencyKind}:${p.name}:${p.state}`) : undefined));
        if (list.every((a) => a?.kind === "agency")) {
          const r = answerCurrentSeveral({ measure: sp.measures[0], statistic: sp.statistic === "rate" ? "rate" : "count", from: every ? cur.finalFirstMonth : span![0], to: every ? cur.lastMonth : span![1],
            places: list.map((a, i) => { const pp = sp.places[i] as Extract<typeof sp.places[number], { kind: "agency" }>; const ag = a as Extract<NonNullable<typeof a>, { kind: "agency" }>;
              return { kind: "agency" as const, ori: ag.ori, label: ag.label, name: pp.name, state: pp.state }; }),
            agencyLine: reportedBy(list.map((a) => agencyName(deps.places, (a as { ori: string }).ori))).replace(/^Reported by /, "Figures for ") }, cur, deps.execute);
          if (r.kind === "current") {
            if (every) r.delivered.text.splice(1, 0, `No years were given, so every month in the data is shown: ${monthName(r.period.from)} through ${monthName(r.period.to)}.`);
            return r;
          }
          return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
        }
      }
      span = null;
    }
    let place: CurrentPlace | null = null;
    const region = flags(ledger0).region;
    if (pl.kind === "national") place = region ? { kind: "group", states: REGIONS[region].states, label: REGIONS[region].name.replace(/^the/, "The") } : { kind: "group", states: null, label: "The United States" };
    else if (pl.kind === "state") place = { kind: "group", states: [pl.code], label: stateName(pl.code) };
    else if (pl.kind === "agency") {
      const a = resolved.get(`${pl.agencyKind}:${pl.name}:${pl.state}`);
      // An agency Current Trends has no rows for is answered from Current Trends with its months blank, never from another
      // source without saying so (Jeff 2026-11-15: Crime Index by default; NIBRS only when asked by name).
      // Murder and homicide are the exception: for an agency Current Trends lacks, a plain murder count by month is Homicide
      // Reports' from 1985 (D37, Jeff 2026-11-14), which the path below gives.
      const murderOnly = ["murder", "homicide", "homicide_all"].includes(sp.measures[0]);
      const has = a?.kind === "agency" && Number(deps.execute(`SELECT count(*) FROM read_parquet('${cur.root}/current_crime.parquet') WHERE ori = '${a.ori.replace(/'/g, "''")}'`)[0]?.[0] ?? 0) > 0;
      if (a?.kind === "agency" && (has || !murderOnly)) place = { kind: "agency", ori: a.ori, label: a.label, name: pl.name, state: pl.state };
    }
    // Availability last (design note section 4): a span that starts after Current Trends' latest month goes on to NIBRS
    // (Codex review 01.3: "September 2026"); one that crosses it keeps the months Current Trends has, the rest named.
    // A span that starts after Current Trends' latest month is declined with the months it holds, and NIBRS offered by name
    // (it may hold the latest month); it no longer falls to NIBRS by itself (Jeff 2026-11-15).
    const afterCurrent = !!span && span[0] > cur.lastMonth && form !== "rolling" && form !== "ytd";
    // Two spans compared (Codex review 01.4): both inside Current Trends' months, else it goes on.
    const cmp = flags(ledger0).comparison;
    // Whole completed years compared stay Historical's (Codex confirmation 01: "2025 compared with 2024"); part years and
    // this year's months are Current Trends'.
    if (cmp && place && sp.statistic === "count" && !(wholeYear(cmp.earlier) && wholeYear(cmp.later))) {
      const ym = (s: string) => s.slice(0, 7);
      const e: [string, string] = [ym(cmp.earlier.from), ym(cmp.earlier.to)], l: [string, string] = [ym(cmp.later.from), ym(cmp.later.to)];
      const first = place.kind === "group" ? cur.firstMonth : cur.finalFirstMonth;
      if (e[0] >= first && l[1] <= cur.lastMonth) {
        const r = answerCurrentChange({ measure: sp.measures[0], place, from: l[0], to: l[1], form: "total",
          ...(place.kind === "agency" ? { agencyLine: reportedBy([agencyName(deps.places, place.ori)]).replace(/^Reported by /, "Figures for "), ...(sheriffNote(deps, [place.ori], ledger0.question) ? { agencyNote: sheriffNote(deps, [place.ori], ledger0.question) } : {}) } : {}) }, e, l, cur, deps.execute);
        if (r.kind === "current") return r;
        return decline("unsupported_capability", r.explanation);
      }
      span = null;
    }
    // A supporting column (P72) isn't built for Current Trends: said, never dropped (Codex monthly-rates review 02).
    if (span && form && place && flags(ledger0).column)
      return decline("unsupported_capability", `This isn't available: a ${flags(ledger0).column === "population" ? "population" : "supporting"} column beside Current Trends figures. Ask without the column.`);
    // Murder and homicide by month for one agency, the span starting before Current Trends' first month: Homicide Reports'
    // answer, no ask (Jeff 2026-11-14: "just give the SHR data since that's the only source that covers that"; only when
    // the monthly span reaches outside Current Trends). It shows its own span; nothing is joined to Current Trends' months.
    const murderish = ["murder", "homicide", "homicide_all"].includes(sp.measures[0]);
    if (span && (form === "months" || form === "total") && place && place.kind === "agency" && span[0] < cur.finalFirstMonth && !flags(ledger0).nibrsAsked && sp.statistic === "count" && murderish && deps.shr) {
      const hrFirst = span[0] > `${SHR_FIRST_YEAR}-01` ? span[0] : `${SHR_FIRST_YEAR}-01`;
      // Never past the asked end: a span ending at Current Trends' latest month must not count Homicide Reports' later months (Codex 449).
      const hrEnd = span[1] > deps.shr.latestMonth ? deps.shr.latestMonth : span[1];
      if (hrEnd >= hrFirst) {
        const out = fromLedger(Object.assign(filled(ledger, "period", `monthrange:${hrFirst}:${hrEnd}`, `from ${monthName(hrFirst)}`), { skipCurrent: true }), deps, pins);
        if (out.kind === "shr") return out;
      }
    }
    // Monthly for one agency that reaches back before Current Trends' first month: the choices first, not the clipped
    // months (Jeff 2026-11-14; Codex span review 06.1). Counts only; murder and homicide are Homicide Reports' above.
    if (span && form === "months" && place && place.kind === "agency" && span[0] < cur.finalFirstMonth && !flags(ledger0).nibrsAsked && sp.statistic === "count" && !murderish) {
      const ch = spanChoices({ ledger, deps, pins, agency: place.label, ori: place.ori, startYear: Number(span[0].slice(0, 4)), startMonth: span[0], endMonth: span[1], ct: { first: cur.finalFirstMonth, last: cur.lastMonth } });
      if (ch) return ch;
    }
    if (span && form && place) {
      const r = answerCurrent({ measure: sp.measures[0], place, from: span[0], to: span[1], form, statistic: sp.statistic === "rate" ? "rate" : "count",
        ...(form === "rolling" && sp.window?.months ? { window: { months: sp.window.months, average: sp.window.average } } : {}),
        ...(place.kind === "agency" ? { agencyLine: reportedBy([agencyName(deps.places, place.ori)]).replace(/^Reported by /, "Figures for "), ...(sheriffNote(deps, [place.ori], ledger0.question) ? { agencyNote: sheriffNote(deps, [place.ori], ledger0.question) } : {}) } : {}) }, cur, deps.execute);
      if (r.kind === "current") return r;
      const withNibrs = `${ledger0.question.replace(/[?.!\s]+$/, "")} according to NIBRS`;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation,
        afterCurrent && !flags(ledger0).nibrsAsked ? { alternative: { label: `Ask instead: "${withNibrs}"`, question: withNibrs, role: "other_source", targetSource: "nibrs" } } : undefined);
    }
  }
  // A Census region from Crime Index (bad-declines plan item 8): its cities ranked (Jeff's ranking rules: complete data,
  // 100,000+ for a rate with no population named, Current Trends' sample past 2025), or its yearly total, the sum of its
  // states. Anything else asked of a region keeps the decline below.
  const regionKey = flags(ledger0).region;
  const plain = !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance
    && !flags(ledger0).people && !flags(ledger0).composite && !flags(ledger0).arrestsThrough && !flags(ledger0).combined && !flags(ledger0).column
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  if (regionKey && deps.historical && plain) {
    const region = { name: REGIONS[regionKey].name, states: REGIONS[regionKey].states };
    const hb = deps.historical;
    const sp = d.spec;
    const toDate = saysToDate(ledger0);
    if (sp.type === "rank" && (sp.entity === "city" || sp.entity === "agency") && sp.scope.kind === "national" && isHistoricalMeasure(sp.measure)
      && (sp.statistic === "count" || sp.statistic === "rate")) {
      const named = sp.min ? (sp.min.op === ">" ? sp.min.amount + 1 : sp.min.amount) : flags(ledger0).largeCities ? 250000 : null;
      const defaultFloor = sp.statistic === "rate" && named === null ? 100000 : null;
      const said = <T extends { delivered: { text: string[] } }>(r: T): T => {
        if (defaultFloor) r.delivered.text.splice(1, 0, "No population was given, so rates are ranked among agencies of 100,000 or more.");
        return r;
      };
      const yrs = yearSpan({ period: sp.period, grain: "total" }, Number(release.lastMonth.slice(0, 4)), hb.firstYear);
      const base = { measure: sp.measure, statistic: sp.statistic === "rate" ? "rate" as const : "count" as const, minPopulation: named ?? defaultFloor, floorAsked: named !== null };
      if (yrs && yrs[0] === yrs[1] && yrs[0] <= hb.lastYear && !toDate) {
        const r = answerHistoricalRanking({ ...base, state: "US", year: yrs[0], direction: sp.rank?.dir ?? "top", limit: sp.rank?.n ?? 20, entity: sp.entity, region }, hb, deps.execute);
        if (r.kind === "historical") return said(r);
        return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
      const cur = deps.current;
      const ctSpan = yrs && yrs[0] === yrs[1] && cur ? currentYearSpan(yrs[0], cur, toDate) : null;
      if (ctSpan && cur) {
        const r = answerCurrentRanking({ ...base, state: "US", from: ctSpan[0], to: ctSpan[1], pick: { kind: "rank", direction: sp.rank?.dir ?? "top", limit: sp.rank?.n ?? 20 },
          entity: sp.entity === "agency" ? "agency" : "city", region }, cur, hb.root, deps.execute, rankAgencies);
        if (r.kind === "current") return said(r);
        return decline("unsupported_capability", r.explanation);
      }
    }
    if (sp.type === "series" && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0]) && (sp.statistic === "count" || sp.statistic === "rate")
      && sp.places.length === 1 && sp.places[0].kind === "national" && !sp.filters.length && !sp.window && (sp.grain === "year" || sp.grain === "total")
      && historicalUnitFits(sp.measures[0], sp.unit) && !toDate) {
      const yrs = yearSpan({ period: sp.period, grain: sp.grain }, Number(release.lastMonth.slice(0, 4)), hb.firstYear);
      if (yrs && yrs[1] <= hb.lastYear) {
        const r = answerHistoricalRegion({ measure: sp.measures[0], region, from: yrs[0], to: yrs[1], statistic: sp.statistic === "rate" ? "rate" : "count", byYear: sp.grain === "year" }, hb, deps.execute);
        if (r.kind === "historical") return r;
        return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
    }
  }
  // A Census region is a Current Trends group only: anything else asked of one is said plainly, never answered for the nation.
  if (flags(ledger0).region)
    return decline("unsupported_capability", `Census regions (${Object.values(REGIONS).map((r) => r.name.replace(/^the /, "")).join(", ")}) are answered from Current Trends only: a Part I crime by month, the year to date or the past 12 months, from January 2025.`);
  if (d.spec.type === "series" && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).people) {
    const sp = d.spec;
    const geo = sp.places.length === 1 && (sp.places[0].kind === "state" || sp.places[0].kind === "national") ? sp.places[0] : null;
    // Several states, or states and the nation, side by side (bad-decline audit root cause 3, 2026-11-06).
    // Never when the places are to be combined, or one is asked as a count and another as a rate (Codex root-causes
    // review 01.3-4): those keep the decline.
    const mixedStatistic = clause0("statistic").length > 0 && /\b(?:counts?|numbers?|totals?|how\s+many)\b/i.test(ledger0.question);
    const geos = sp.places.length >= 2 && sp.places.every((p) => p.kind === "state" || p.kind === "national") && !clause0("combine").length && !flags(ledger0).combined && !mixedStatistic ? sp.places : null;
    const details = ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept))
      || (sp.statistic !== "clearance_rate" && ledger.parts.some((p) => p.clause === 0 && p.concept === "clearance"));
    // A Crime Index question with no period asks which (D31), never P01's decline (query-log step one, 2026-11-02).
    if ((geo || geos) && sp.period.form === "none" && sp.grain === "total" && sp.measures.length === 1 && isSrsMeasure(sp.measures[0]) && !details) return askCrimeIndexPeriod();
    const yrs = yearSpan(sp, Number(release.lastMonth.slice(0, 4)), 1960);
    // The file's own unit only (offenses; victims for murder, rape, assault): incidents are another quantity (Codex
    // increment-5 review 2.3) and stay with P01's decline.
    if ((geo || geos) && yrs && sp.measures.length === 1 && isSrsMeasure(sp.measures[0]) && !sp.filters.length && !details && (sp.unit === null || ["offenses", "victims"].includes(sp.unit))
      && !currentClearance(sp, Number(release.lastMonth.slice(0, 4)))
      && !completedStateClearance(sp, Number(release.lastMonth.slice(0, 4)), Number(release.firstMonth.slice(0, 4)))
      && (sp.statistic === "count" || sp.statistic === "rate" || sp.statistic === "clearance_rate") && !flags(ledger0).composite
      && !(partYear(sp, flags(ledger0).comparison) && !ANNUAL_ONLY.has(sp.measures[0]))) {
      // The file has whole years only: a month, part of a year or a part-year comparison is declined, never answered
      // as whole years (review 2.1).
      const cmp = flags(ledger0).comparison;
      if (partYear(sp, cmp))
        return decline("unsupported_capability", `${sp.measures[0] === "violent_crime" ? "Violent" : "Property"} crime totals are whole years only.`, { alternative: byYearInstead(ledger, deps, pins) });
      const thisYear = Number(release.lastMonth.slice(0, 4));
      if (yrs[0] > thisYear) return decline("outside_release_coverage", `${yrs[0]} is not in the data; the latest year is ${thisYear}.`);
      // The whole span is checked before any route: a year after this one is not in the data (Codex review 03.2).
      if (yrs[1] > thisYear) return decline("outside_release_coverage", `${yrs[1]} is not in the data; the latest year is ${thisYear}.`);
      if (yrs[0] === thisYear && sp.statistic !== "clearance_rate")
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measures[0].replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here.` };
      // A span reaching this year: its completed years from the file, this year named as Current Trends' (P14: never
      // spliced in; review 2.6).
      const reachesNow = yrs[1] === thisYear && sp.statistic !== "clearance_rate";
      const srsPlace = (p: (typeof sp.places)[number]): SrsPlace => (p.kind === "state" ? { kind: "state", code: p.code } : { kind: "national" });
      const srsQ = { measure: sp.measures[0], from: yrs[0], to: reachesNow ? thisYear - 1 : yrs[1],
        byYear: sp.grain === "year" || openSpan(sp), statistic: sp.statistic,
        comparison: cmp ? { earlier: Number(cmp.earlier.from.slice(0, 4)), later: Number(cmp.later.from.slice(0, 4)), ...(cmp.change ? { change: true as const } : {}) } : null,
        notes: reachesNow ? [`${thisYear} is this year: its figures come from Current Trends (Crime Index) and are not included here.`] : [] };
      const r = geos ? answerSrsSeveral(srsQ, geos.map(srsPlace)) : answerSrs({ ...srsQ, place: srsPlace(geo!) });
      if (r.kind === "srs") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : /state clearance rate for several years/.test(r.explanation) ? "not_recorded_in_nibrs" : "unsupported_capability", r.explanation);
    }
  }
  // Item 3 (coordinator 2026-11-07): an agency beside its state or the nation ("Memphis and Tennessee murder rate in
  // 2023", "Iowa City vs national aggravated assault rate since 2018"): each place's own Crime Index figures side by
  // side, under the rules of both answers it joins (the agencies' above, the states' and nation's below). Never when the
  // places are to be combined or one is asked as a count and another as a rate.
  if (deps.historical && d.spec.type === "series" && d.spec.places.length >= 2 && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property
    && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).arrestsThrough && !flags(ledger0).composite) {
    const sp = d.spec;
    const each = sp.places.map((p) => (p.kind === "agency" ? resolved.get(`${p.agencyKind}:${p.name}:${p.state}`) : p.kind === "state" || p.kind === "national" ? p : undefined));
    // A state written right after its own agency ("Fairfax County Police Department in Virginia", "Arlington, Texas")
    // is that agency's state, not a second place (PR #129's scorecard: QL-nibrs-6900e4157e had answered Virginia too).
    // The parts as resolved: an agency's value ends with its state's code ("county:Fairfax County:VA").
    const placeParts = ledger.parts.filter((p) => p.clause === 0 && p.concept === "place" && p.state !== "context");
    const codeOf = new Map(sp.places.flatMap((p) => (p.kind === "state" ? [[p.name, p.code] as const] : [])));
    const ownState = placeParts.some((st) => /^state:/.test(String(st.value)) && placeParts.some((ag) => /^(?:city|county):/.test(String(ag.value)) && ag.span[1] <= st.span[0]
      && String(ag.value).endsWith(`:${codeOf.get(String(st.value).slice(6))}`)
      && /^[\s,]*(?:(?:police\s+department|police\s+dept\.?|pd|sheriff'?s?\s+(?:office|department)|police)\s*)?(?:\bin\b|\bof\b)?[\s,]*$/i.test(ledger0.question.slice(ag.span[1], st.span[0]))));
    const mixed = !ownState && each.some((x) => x?.kind === "agency") && each.some((x) => x?.kind === "state" || x?.kind === "national")
      && each.every((x) => x?.kind === "agency" || x?.kind === "state" || x?.kind === "national");
    // One statistic for every place, or none (Codex beside reviews 01.1, 02.1-2: "Murder victims in Memphis and murder
    // rate in Tennessee" and "Murders in Memphis and Tennessee's rate" were two rates). A statistic is every place's
    // only when every statistic named is the same one ("rate", "per 100,000" and "per capita" are one) and the crime,
    // each time it is named, is said in one phrase with one of them ("murder rate", "murders per capita", "rate of
    // murders"; "Memphis murder rate vs Tennessee murder rate"). Anything else is said of some places only, and is
    // declined (Codex beside review 03.1-2). No statistic: counts for all.
    const stats = clause0("statistic"), named = clause0("measure");
    const between = (a: { span: [number, number] }, b: { span: [number, number] }) =>
      ledger0.question.slice(Math.min(a.span[1], b.span[1]), Math.max(a.span[0], b.span[0]));
    const onePhrase = (st: (typeof stats)[number], me: (typeof named)[number]) =>
      /^[\s-]*(?:(?:of|the|for)\s+)*(?:(?:victims?|offen[cs]es?|incidents?)[\s-]*)?$/i.test(between(st, me));
    const kind = (v: string | null) => (v === "rate" || v === "per100k" || v === "percapita" ? "rate" : String(v));
    const alike = stats.every((x) => kind(x.value) === kind(stats[0].value));
    const scoped = stats.length > 0 && !(alike && named.length > 0 && named.every((me) => stats.some((st) => onePhrase(st, me))));
    const mixedStatistic = scoped || (clause0("statistic").length > 0 && /\b(?:counts?|numbers?|totals?|how\s+many)\b/i.test(ledger0.question));
    const details = ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share", "clearance"].includes(p.concept));
    if (mixed && scoped)
      return decline("unsupported_capability", "Ask for the same figure for every place: a count for each, or a rate for each.");
    if (mixed && !clause0("combine").length && !flags(ledger0).combined && !mixedStatistic && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0])
      && isSrsMeasure(sp.measures[0]) && !sp.filters.length && !details && historicalUnitFits(sp.measures[0], sp.unit) && (sp.unit === null || ["offenses", "victims"].includes(sp.unit))
      && (sp.statistic === "count" || sp.statistic === "rate")) {
      if (sp.period.form === "none" && sp.grain === "total") return askCrimeIndexPeriod();
      const cmp = flags(ledger0).comparison;
      // Owner rule (Jeff 2026-11-23): an agency beside the nation with no period starts at the earliest national year, 1960,
      // not 1930 with blank national cells. An agency beside a state, or any stated period, is unchanged.
      const nationAsked = each.some((x) => x?.kind === "national");
      const yrs = yearSpan(sp, Number(release.lastMonth.slice(0, 4)), nationAsked && sp.period.form === "none" ? Math.max(1960, deps.historical.firstYear) : deps.historical.firstYear);
      if (yrs) {
        if (partYear(sp, cmp)) return decline("unsupported_capability", "Crime Index figures for an agency beside a state or the nation are whole years only.", { alternative: byYearInstead(ledger, deps, pins) });
        const thisYear = Number(release.lastMonth.slice(0, 4));
        if (yrs[0] > thisYear) return decline("outside_release_coverage", `${yrs[0]} is not in the data; the latest year is ${thisYear}.`);
        if (yrs[1] > thisYear) return decline("outside_release_coverage", `${yrs[1]} is not in the data; the latest year is ${thisYear}.`);
        if (yrs[0] === thisYear)
          return { kind: "route", source: "rtci", explanation: `This year's ${sp.measures[0].replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here.` };
        const reachesNow = yrs[1] === thisYear;
        const places0: BesidePlace[] = each.map((x, i) => (x!.kind === "agency"
          ? { agency: { ori: x!.ori, label: x!.label, name: (sp.places[i] as { name: string }).name, state: (sp.places[i] as { state: string }).state } }
          : { geo: x!.kind === "state" ? { kind: "state" as const, code: (x as { code: string }).code } : { kind: "national" as const } }));
        // In the order the question names them (Codex beside reviews 01.2, 02.3: the nation is read last wherever it
        // is; a place a choice settled, "Washington" the state, was read as another kind). Each place takes the first
        // unused place in the question with its name (the nation: the national part), every exact name first, then a
        // name that starts the other ("Washington County, Oregon" never takes "Washington": Codex beside review 03.3);
        // if any has none, the order read.
        const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
        const parts = clause0("place").map((p) => ({ national: p.value === "national", text: norm(String(p.text ?? "")), at: p.span[0] })).sort((x, y) => x.at - y.at);
        const used = new Set<number>();
        const at = places0.map(() => -1);
        for (const exact of [true, false]) places0.forEach((b, i) => {
          if (at[i] >= 0) return;
          const names = "agency" in b ? [norm((sp.places[i] as { name: string }).name)] : b.geo.kind === "state" ? [norm(stateName(b.geo.code)), norm(b.geo.code)] : [];
          const k = parts.findIndex((p, j) => !used.has(j) && ("geo" in b && b.geo.kind === "national" ? p.national
            : !p.national && names.some((n) => !!n && (p.text === n || (!exact && (p.text.startsWith(`${n} `) || n.startsWith(`${p.text} `)))))));
          if (k >= 0) { used.add(k); at[i] = parts[k].at; }
        });
        const places = at.some((x) => x < 0) ? places0 : places0.map((b, i) => ({ b, at: at[i] })).sort((x, y) => x.at - y.at).map((x) => x.b);
        const oris = places.flatMap((p) => ("agency" in p ? [p.agency.ori] : []));
        const note = sheriffNote(deps, oris, ledger0.question);
        const r = answerBeside({ measure: sp.measures[0], agencies: [], from: yrs[0], to: reachesNow ? thisYear - 1 : yrs[1], byYear: sp.grain === "year" || openSpan(sp),
          statistic: sp.statistic, comparison: cmp ? { earlier: Number(cmp.earlier.from.slice(0, 4)), later: Number(cmp.later.from.slice(0, 4)), ...(cmp.change ? { change: true as const } : {}) } : null,
          notes: reachesNow ? [`${thisYear} is this year: its figures come from Current Trends (Crime Index) and are not included here.`] : [],
          agencyLine: reportedBy(oris.map((o) => agencyName(deps.places, o))).replace(/^Reported by /, "Figures for "), ...(note ? { agencyNote: note } : {}) }, places, deps.historical, deps.execute);
        if (r.kind === "historical") return r;
        return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
      }
    }
  }
  // Historical (P75-P79): a Part I offense for one or several named agencies in completed years is the Crime Index
  // build's: its count, its published rate (P75) or its published clearance percentage (P57), by year or a change;
  // unless NIBRS is asked for in words (P01). Only the plain figure: a restriction the file cannot apply (a property
  // condition, a cohort, people, a breakdown or filter) keeps the question with NIBRS's limits, never dropped.
  if (deps.historical && d.spec.type === "series" && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).circumstance
    && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).arrestsThrough && !flags(ledger0).composite) {
    const sp = d.spec;
    const agencies = sp.places.map((p) => (p.kind === "agency" ? resolved.get(`${p.agencyKind}:${p.name}:${p.state}`) : undefined));
    const details = ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept))
      || (sp.statistic !== "clearance_rate" && ledger.parts.some((p) => p.clause === 0 && p.concept === "clearance"));
    if (agencies.length && agencies.every((a) => a?.kind === "agency") && sp.period.form === "none" && sp.grain === "total" && sp.measures.length === 1
      && isHistoricalMeasure(sp.measures[0]) && !sp.filters.length && !details) return askCrimeIndexPeriod();
    // An open span starts at the first year the figure asked for exists (clearances from 1960: item 7).
    const yrs = yearSpan(sp, Number(release.lastMonth.slice(0, 4)), sp.statistic === "clearance_rate" ? deps.historical.clearanceFirstYear : deps.historical.firstYear);
    const historicalShape = agencies.length && agencies.every((a) => a?.kind === "agency") && yrs && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0]) && !sp.filters.length && !details
      && (sp.statistic === "count" || sp.statistic === "rate");
    // The crime counted in the other of its two units ("robbery victims"): said plainly, with NIBRS's count of that unit
    // offered. Arrests, offenders and incidents are NIBRS's own counts and go on to it.
    if (historicalShape && (sp.unit === "victims" || sp.unit === "offenses") && !historicalUnitFits(sp.measures[0], sp.unit)) {
      const withNibrs = `${ledger0.question.replace(/[?.!\s]+$/, "")} according to NIBRS`;
      return decline("unsupported_capability", `Historical counts ${historicalCounts(sp.measures[0])}, not ${sp.unit}. NIBRS counts ${sp.unit} for the agencies that report to it.`,
        { alternative: { label: `Ask instead: "${withNibrs}"`, question: withNibrs, role: "other_source", targetSource: "nibrs" } });
    }
    if (agencies.length && agencies.every((a) => a?.kind === "agency") && yrs && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0]) && !sp.filters.length && !details
      && historicalUnitFits(sp.measures[0], sp.unit) && (sp.statistic === "count" || sp.statistic === "rate" || sp.statistic === "clearance_rate")
      && !currentClearance(sp, Number(release.lastMonth.slice(0, 4)))
      && !(partYear(sp, flags(ledger0).comparison) && !ANNUAL_ONLY.has(sp.measures[0]))) {
      // Codex review 01.2: the file has no cohort to combine agencies with (design note 2): asked, it is declined.
      if (flags(ledger0).combined && agencies.length > 1) {
        const apart = ledger0.question.replace(/\s*,?\s*\b(?:combined|together|as one total)\b/i, "").replace(/[?.!\s]+$/, "");
        return decline("unsupported_capability", "Historical figures can't be combined across agencies. Ask for each agency; they are shown side by side.",
          { alternative: { label: `Ask instead: "${apart}"`, question: apart, role: "ask_instead", targetSource: "historical" } });
      }
      const cmp = flags(ledger0).comparison;
      if (partYear(sp, cmp))
        return decline("unsupported_capability", `${sp.measures[0] === "violent_crime" ? "Violent" : "Property"} crime totals are whole years only.`, { alternative: byYearInstead(ledger, deps, pins) });
      const thisYear = Number(release.lastMonth.slice(0, 4));
      if (yrs[1] > thisYear) return decline("outside_release_coverage", `${yrs[1]} is not in the data; the latest year is ${thisYear}.`);
      if (yrs[0] === thisYear && sp.statistic !== "clearance_rate")
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measures[0].replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here.` };
      // A span reaching this year: its completed years from the build, this year named as Current Trends' (P14).
      const reachesNow = yrs[1] === thisYear && sp.statistic !== "clearance_rate";
      const list = agencies as Extract<Place, { kind: "agency" }>[];
      const r = answerHistorical({ measure: sp.measures[0], agencies: list.map((a, i) => ({ ori: a.ori, label: a.label, name: (sp.places[i] as { name: string }).name, state: (sp.places[i] as { state: string }).state })),
        from: yrs[0], to: reachesNow ? thisYear - 1 : yrs[1], byYear: sp.grain === "year" || openSpan(sp), statistic: sp.statistic,
        comparison: cmp ? { earlier: Number(cmp.earlier.from.slice(0, 4)), later: Number(cmp.later.from.slice(0, 4)), ...(cmp.change ? { change: true as const } : {}) } : null,
        notes: reachesNow ? [`${thisYear} is this year: its figures come from Current Trends (Crime Index) and are not included here.`] : [],
        agencyLine: reportedBy(list.map((a) => agencyName(deps.places, a.ori))).replace(/^Reported by /, "Figures for "), ...(sheriffNote(deps, list.map((a) => a.ori), ledger0.question) ? { agencyNote: sheriffNote(deps, list.map((a) => a.ori), ledger0.question) } : {}) }, deps.historical, deps.execute);
      if (r.kind === "historical") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
    }
  }
  // Part I rankings from Crime Index for one year (Jeff 2026-11-10: option A, "any year from 1930 to 2025, counts and
  // rates"; ranking decision 3, "Part I city rankings in NIBRS years come from Crime Index", which every reporting city
  // is in; decision 5, states 1960-2025 without DC): a state's cities or the nation's, or the states. A population floor
  // is "large" (P08: 250,000) or one named; a clearance or a detail stays on its own path (NIBRS ranks NIBRS-only detail).
  const floorOf = (sp: Extract<typeof d.spec, { type: "rank" }>) => (sp.min ? (sp.min.op === ">" ? sp.min.amount + 1 : sp.min.amount) : flags(ledger0).largeCities ? 250000 : null);
  if (deps.historical && d.spec.type === "rank" && (d.spec.entity === "city" || d.spec.entity === "state" || d.spec.entity === "agency" || d.spec.entity === "county")
    && (d.spec.scope.kind === "state" ? d.spec.entity !== "state" : d.spec.scope.kind === "national") && isHistoricalMeasure(d.spec.measure)
    && (d.spec.statistic === "count" || d.spec.statistic === "rate") && !(d.spec.entity === "state" && (d.spec.min || flags(ledger0).largeCities))
    && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent
    && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).composite
    && !flags(ledger0).arrestsThrough && !flags(ledger0).region && !flags(ledger0).combined && !flags(ledger0).column
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept))) {
    const sp = d.spec;
    // Jeff 2026-11-10 ("Agreed when no pop request is given"): a rate ranking with no population named ranks agencies of
    // 100,000 or more, said; a population or size named overrides it (replaces D05 for rate rankings). States: none.
    const defaultFloor = sp.statistic === "rate" && sp.entity !== "state" && floorOf(sp) === null ? 100000 : null;
    const minPopulation = floorOf(sp) ?? defaultFloor;
    const saidFloor = <T extends { delivered: { text: string[] } }>(r: T): T => {
      if (defaultFloor) r.delivered.text.splice(1, 0, "No population was given, so rates are ranked among agencies of 100,000 or more.");
      return r;
    };
    // No period (D31/P05): asked before anything else, also for the nation, whose plan would otherwise be declined as "a state or the
    // nation together with other places" for want of a year (scorecard 2026-11-16: "what city has the highest murder rate in the us?").
    if (sp.period.form === "none") {
      const lcy = Number(release.lastMonth.slice(0, 4)) - (release.lastMonth.endsWith("-12") ? 0 : 1);
      const thisYear = Number(release.lastMonth.slice(0, 4));
      return { kind: "clarify", about: "which period", question: ledger0.question, options: [
        { label: `The latest complete year (${lcy})`, continuation: fromLedger(filled(ledger, "period", `year:${lcy}`, `in ${lcy}`), deps, pins) },
        { label: "This year so far", continuation: fromLedger(filled(ledger, "period", `year:${thisYear}`, "this year so far"), deps, pins) },
        { label: "Another year", entry: "which year" }] };
    }
    const yrs = yearSpan({ period: sp.period, grain: "total" }, Number(release.lastMonth.slice(0, 4)), deps.historical.firstYear);
    // "So far in 2025" is the year's months to date, from Current Trends (decision 4), never Crime Index's full year
    // (Codex rankings review 01.3).
    const toDate = saysToDate(ledger0);
    // A year past Crime Index's last (2026) is Current Trends' (decision 4), on its own path.
    if (yrs && yrs[0] === yrs[1] && yrs[0] <= deps.historical.lastYear && !toDate) {
      const r = answerHistoricalRanking({ measure: sp.measure, state: sp.scope.kind === "state" ? sp.scope.code.toUpperCase() : "US", year: yrs[0],
        statistic: sp.statistic === "rate" ? "rate" : "count", direction: sp.rank?.dir ?? "top", limit: sp.rank?.n ?? 20, minPopulation, floorAsked: floorOf(sp) !== null,
        entity: sp.entity }, deps.historical, deps.execute);
      if (r.kind === "historical") return saidFloor(r);
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
    }
    // Past Crime Index's last year (2026): Current Trends' sample agencies, January through its latest month (Jeff
    // 2026-11-10, ranking decision 4), said; states aren't ranked from its sample.
    const cur = deps.current;
    const ctSpan = yrs && yrs[0] === yrs[1] && cur ? currentYearSpan(yrs[0], cur, toDate) : null;
    if (toDate && !ctSpan) return decline("outside_release_coverage", "Year-to-date rankings come from Current Trends, which covers 2025 and 2026.");
    if (ctSpan && cur && sp.entity !== "state") {
      const r = answerCurrentRanking({ measure: sp.measure, state: sp.scope.kind === "state" ? sp.scope.code.toUpperCase() : "US", from: ctSpan[0], to: ctSpan[1],
        statistic: sp.statistic === "rate" ? "rate" : "count", pick: { kind: "rank", direction: sp.rank?.dir ?? "top", limit: sp.rank?.n ?? 20 }, minPopulation, floorAsked: floorOf(sp) !== null,
        entity: sp.entity === "agency" ? "agency" : sp.entity === "county" ? "county" : "city" }, cur, deps.historical.root, deps.execute, rankAgencies);
      if (r.kind === "current") return saidFloor(r);
      return decline("unsupported_capability", r.explanation);
    }
  }
  // Counties ranked are Crime Index's county agencies (above) or nothing: never another path's reading (rankings PR B).
  if (d.spec.type === "rank" && d.spec.entity === "county")
    return decline("unsupported_capability", "Counties are ranked by their own agency (the sheriff or county police) from Crime Index, for one year through 2025, or from Current Trends' sample in 2026, by count or rate of a Part I crime. This question asks for something else.");
  // The reader's own change form ("how did burglaries in Memphis change from 2010 to 2020") for one agency: the same
  // Historical answer as "<crime> in <agency>, <earlier> against <later>" (P54, P55).
  if (deps.historical && d.spec.type === "change" && d.spec.statistic === "count" && !flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent
    && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).composite && d.spec.place.kind === "agency"
    && isHistoricalMeasure(d.spec.measure) && historicalUnitFits(d.spec.measure, d.spec.unit)
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept))) {
    const sp = d.spec, pl = sp.place as Extract<typeof sp.place, { kind: "agency" }>;
    const a = resolved.get(`${pl.agencyKind}:${pl.name}:${pl.state}`);
    const thisYear = Number(release.lastMonth.slice(0, 4));
    if (a?.kind === "agency") {
      if (sp.later > thisYear) return decline("outside_release_coverage", `${sp.later} is not in the data; the latest year is ${thisYear}.`);
      if (sp.later === thisYear)
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measure.replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here.` };
      const r = answerHistorical({ measure: sp.measure, agencies: [{ ori: a.ori, label: a.label, name: pl.name, state: pl.state }], from: sp.earlier, to: sp.later, byYear: false,
        statistic: "count", comparison: { earlier: sp.earlier, later: sp.later },
        agencyLine: reportedBy([agencyName(deps.places, a.ori)]).replace(/^Reported by /, "Figures for "), ...(sheriffNote(deps, [a.ori], ledger0.question) ? { agencyNote: sheriffNote(deps, [a.ori], ledger0.question) } : {}) }, deps.historical, deps.execute);
      if (r.kind === "historical") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
    }
  }
  // P57 (increment 6): a Part I offense's clearance rate for an agency in a completed year is the historical
  // clearances' (FBI SRS, Return A), not computed from NIBRS. Without the Crime Index build, the route is named.
  // Only the plain rate: a restriction the historical figures cannot apply (a property condition, a cohort, a
  // breakdown or filter) is never dropped by the route (Codex increment-6 review 02.1).
  const plainRate = !flags(ledger0).people && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).arrestsThrough && !flags(ledger0).consistent && !flags(ledger0).composite
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  if (d.spec.type === "series" && d.spec.statistic === "clearance_rate" && !flags(ledger0).nibrsAsked && d.spec.places.length === 1 && d.spec.places[0].kind === "agency"
    && d.spec.measures.length === 1 && isSrsMeasure(d.spec.measures[0]) && !d.spec.filters.length && plainRate) {
    const p = d.spec.period, last = p.form === "year" ? p.year : p.form === "range" ? p.to : null;
    if (last !== null && last < Number(release.lastMonth.slice(0, 4)))
      return { kind: "route", source: "historical", explanation: `The ${d.spec.measures[0].replace(/_/g, " ")} clearance rate of an agency for a completed year comes from Historical (the FBI's SRS clearances, as the agency reported them), not computed from NIBRS. Historical isn't available here.` };
  }
  // A clearance rate for a state or the nation that is not a Part I offense's (P57): a state has none (P18); the method
  // for a NIBRS-only offense is not decided (P57).
  if (d.spec.type === "series" && d.spec.statistic === "clearance_rate" && d.spec.places.length === 1 && (d.spec.places[0].kind === "state" || d.spec.places[0].kind === "national")
    && !(plainRate && (currentClearance(d.spec, Number(release.lastMonth.slice(0, 4)))
      || completedStateClearance(d.spec, Number(release.lastMonth.slice(0, 4)), Number(release.firstMonth.slice(0, 4))))))
    return decline("not_recorded_in_nibrs", d.spec.places[0].kind === "state"
      ? "How to compute a state clearance rate for a NIBRS-only offense, or for several years at once, is not decided."
      : "How to compute a national clearance rate for a NIBRS-only offense is not decided.");
  // P01: a standard (Part I) crime's count is Historical's (completed years) or Current Trends' (this year), not this
  // NIBRS shadow's; it is declined rather than answered from the wrong source.
  // Only a plain count of the crime: its details (a weapon, arrests, clearances, a breakdown) are NIBRS's, and go on to
  // the slice's own limits.
  // The reader's own change form ("did X increase from 2022 to 2023") is a plain count compared, under the same rule.
  const plainUnit = (u: string | null) => u === null || ["offenses", "victims", "incidents"].includes(u);
  const noDetail = !flags(ledger0).people && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  const asked = flags(ledger0).composite || !noDetail ? []
    : d.spec.type === "series" && !d.spec.filters.length && plainUnit(d.spec.unit) ? d.spec.measures
    : d.spec.type === "change" && d.spec.statistic === "count" && plainUnit(d.spec.unit) ? [d.spec.measure] : [];
  // P01, in plain words (P74): the official counts are Historical's and Current Trends'; NIBRS has them when asked by name.
  // A month, quarter or part-year question goes to NIBRS, the source with monthly grain (coordinator 2026-11-02); the
  // Crime Index builds are annual. (Current Trends, monthly too, is settled with Jeff when it is built.)
  const months = d.spec.type === "series" && partYear(d.spec, flags(ledger0).comparison);
  if (!flags(ledger0).nibrsAsked && !flags(ledger0).shrAsked && !flags(ledger0).consistent && !months && asked.some((x) => PART_ONE.has(x))) {
    const withNibrs = `${ledger0.question.replace(/[?.!\s]+$/, "")} according to NIBRS`;
    // Plain words, and no source that isn't loaded (coordinator 2026-11-02, after Jeff's "Memphis murders since 1930"):
    // with the Crime Index build, its figures don't answer this question as asked; without it, only NIBRS is here. The
    // button is the nearest question that runs for the same place and crime (withNextStep's nearest, then NIBRS's).
    return decline("unsupported_capability", deps.historical
      ? "Crime Index's figures for this crime don't answer this question as it's asked. NIBRS has its own counts, from the agencies that report to it."
      : "This isn't available here.",
      { alternative: { label: `Ask instead: "${withNibrs}"`, question: withNibrs, role: "other_source", targetSource: "nibrs" } });
  }

  // The plan.
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace: (v) => resolved.get(v) ?? null });
  if (a.kind === "unmapped") return notYet(`no plan form: ${a.reason}`);
  const plan = a.plan;
  // Increment 6: "where a firearm was stolen": the incident has one property segment with that description and loss
  // type (one segment, so a stolen television and a recovered firearm never match; incident-level, N2).
  // Element 31 (coordinator 2026-11-04): a circumstance named is a filter on the counted victims of a murder or an
  // aggravated assault, the only crimes it is recorded for here.
  const circ = flags(ledger0).circumstance;
  if (circ) {
    if (plan.measures.length !== 1 || plan.measures[0].unit !== "victim" || !/\.(?:murder|homicide_all|homicide|aggravated_assault)$/.test(plan.measures[0].id))
      return decline("unsupported_capability", "Circumstances (such as an argument or another felony) are recorded for murder and aggravated assault victims; ask for those.");
    plan.filters.push({ kind: "exists", scope: "victim", entity: "victim_circumstance", where: [{ kind: "attribute", dimension: "victim_circumstance.circumstance", op: "in", values: circ }] });
  }
  const prop = flags(ledger0).property;
  if (prop) {
    const d = PROPERTY_CODES[prop.what], loss = LOSS_CODES[prop.loss];
    if (!d || !loss) return decline("unsupported_capability", `This isn't available: this property condition (${prop.what} ${prop.loss}).`);
    plan.filters.push({ kind: "exists", scope: "incident", entity: "property", attribution: "incident_level_only",
      where: [{ kind: "attribute", dimension: "property.loss_type", op: "in", values: [loss] }, { kind: "attribute", dimension: "property.description", op: "in", values: d.codes }] });
  }
  // Increment 6: arrests reached through the incident (P50, P68): every arrest on an incident with the condition (a
  // property selection, or an offense of the incident), whatever its arrest offense; never all arrests.
  const thr = flags(ledger0).arrestsThrough;
  if (thr) {
    if (plan.measures.length !== 1 || plan.measures[0].id !== "arrests.all_crime") return decline("unsupported_capability", "This isn't available: arrests for incidents of this kind.");
    if (thr.offense) {
      const codes = MEASURE_CODES[thr.offense];
      if (!codes) return decline("unsupported_capability", `This isn't available: arrests for incidents with ${thr.offense.replace(/_/g, " ")}.`);
      plan.filters.push({ kind: "exists", scope: "incident", entity: "offense", where: [{ kind: "attribute", dimension: "offense.offense", op: "in", values: codes }] });
    }
    if (!plan.filters.some((f) => f.kind === "exists")) return decline("unsupported_capability", "This isn't available: arrests for incidents with no condition.");
  }
  // Increment 6: clearance (P64, P66, P67), each unit taking its incident's status as of the file: a breakdown by
  // status or type, or a selection.
  const clr = flags(ledger0).clearance;
  if (clr) {
    if (clr.by) plan.groupings.push({ dimension: clr.by === "type" ? "offense.clearance_type" : "offense.clearance_status", unknown: "visible", absent: "show" });
    if (clr.only) plan.filters.push({ kind: "attribute", op: "in",
      dimension: clr.only === "arrest" || clr.only === "exceptional" ? "offense.clearance_method" : "offense.clearance_status",
      values: [clr.only === "cleared" ? "cleared" : clr.only === "uncleared" ? "none" : clr.only] });
  }
  // Increment 7: people (P29, P30, P44, P49, P65): conditions on a person, then a breakdown by an offender's or
  // arrestee's attribute. Each applies only to the unit it is about; anything else is declined, never answered as
  // another unit.
  const ppl = flags(ledger0).people;
  if (ppl && (ppl.by || ppl.where.length)) {
    if (plan.measures.length !== 1) return decline("unsupported_capability", "This isn't available: a person's attributes for several crimes.");
    // "Violent crime" by a victim's or offender's age counts NIBRS crimes against persons for that person, not the FBI's four-crime
    // violent crime (Jeff 2026-11-15); a firearm selected is the victim's offense weapon (offenders' is not built).
    if (ppl.by && !ppl.by.paired && ppl.by.who === "offender" && ppl.by.attr === "age" && ["violent_crime.ucr", "offenders.violent_crime"].includes(plan.measures[0].id)) {
      plan.measures[0] = { ...plan.measures[0], id: "offenders.person_crimes", unit: "offender" };
      plan.filters = plan.filters.map((f): Filter => (f.kind === "exists" && f.entity === "offense_weapon" && f.scope === "incident" ? { ...f, scope: "offender" } : f));
    }
    const unit = plan.measures[0].unit;
    const between = (dimension: string, r: [number, number]) => ({ kind: "attribute" as const, dimension, op: "between" as const, values: r });
    for (const w of ppl.where) {
      if (w.attr === "relationship") {
        if (unit !== "offender") return decline("unsupported_capability", "This isn't available: a relationship to the victim, for anything but offenders.");
        plan.filters.push({ kind: "exists", scope: "offender", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: w.values }] });
      } else if (w.who === "victim") {
        // P120 (Jeff 2026-11-16): a question that says victims and gives their age counts the crime's victims (robbery victims
        // under 18), the unit a victim's age belongs to; a crime counted by offense with no victim word stays declined.
        if (unit === "offense" && /^offenses\.[a-z_]+$/.test(plan.measures[0].id) && /\bvictims?\b/i.test(ledger0.question)) plan.measures[0] = { ...plan.measures[0], id: plan.measures[0].id.replace(/^offenses\./, "victims."), unit: "victim" };
        if (plan.measures[0].unit !== "victim") return decline("unsupported_capability", "This isn't available: a victim's age for crimes counted by offense.");
        plan.filters.push(between("victim.age", w.range));
      } else if (w.who === "arrestee") {
        if (unit !== "arrest" && unit !== "group_b_arrest") return decline("unsupported_capability", "This isn't available: an arrestee's age for anything but arrests.");
        plan.filters.push(between(unit === "group_b_arrest" ? "group_b_arrest.age" : "arrestee.age", w.range));
      } else if (w.paired) {
        if (unit !== "victim") return decline("unsupported_capability", "This isn't available: a linked offender's age for anything but victims.");
        plan.filters.push({ kind: "exists", scope: "victim", entity: "victim_offender", where: [between("victim_offender.offender_age", w.range)] });
      } else if (unit === "offender") plan.filters.push(between("offender.age", w.range));
      else if (unit === "victim" || unit === "offense") plan.filters.push({ kind: "exists", scope: "incident", entity: "offender", where: [between("offender.age", w.range)] });
      else return decline("unsupported_capability", "This isn't available: an offender's age for this kind of count.");
    }
    if (ppl.by) {
      const b = ppl.by;
      if (b.who === "arrestee" && unit !== "arrest" && unit !== "group_b_arrest") return decline("unsupported_capability", "This isn't available: an arrestee's attributes for anything but arrests.");
      if (b.paired && unit !== "victim") return decline("unsupported_capability", "This isn't available: the linked offenders' attributes for anything but victims.");
      if (b.who === "offender" && (unit === "arrest" || unit === "group_b_arrest")) return decline("unsupported_capability", "This isn't available: offenders' attributes for arrests.");
      if (plan.groupings.some((g) => !g.dimension.startsWith("time."))) return decline("unsupported_capability", "This isn't available: a person's attribute beside another breakdown.");
      const dimension = b.paired ? `victim_offender.offender_${b.attr}` : b.who === "arrestee" && unit === "group_b_arrest" ? `group_b_arrest.${b.attr}` : `${b.who}.${b.attr}`;
      const multi = b.paired || (b.who === "offender" && unit !== "offender");
      plan.groupings.push({ dimension, unknown: "visible", absent: "show", ...(multi ? { multiValue: "each_value" as const } : {}), ...(b.attr === "age" ? { bins: AGE_BINS } : {}) });
      const m0 = plan.measures[0];
      plan.statistics = [{ kind: "count", as: plan.statistics[0].as, measure: m0.as }, { kind: "share", as: "share_of_period", measure: m0.as, within: plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension) }];
    }
  }
  // P82: domestic violence has its own definition (unchanged here); NIBRS_DV_WIDE=on lets the runner time several places.
  // Coordinator 2026-11-24: the state/national gate is removed (the definition is unchanged); several agencies or places still decline.
  if (plan.measures.some((m) => /\.domestic_violence$/.test(m.id)) && !plan.geography.places.every((p) => p.kind === "agency" || p.kind === "state" || p.kind === "national") && process.env.NIBRS_DV_WIDE !== "on")
    return decline("unsupported_capability", "This isn't available: domestic violence for several places. Ask for one city, agency, state or the nation.");
  // Places (increment 4): named agencies, separate or combined, and a state's city agencies for a ranking. State and
  // national totals are increment 5.
  const citySet = (p: Place) => p.kind === "agency_set" && p.within.kind === "state"
    && p.where.every((w) => (w.field === "agency.type" && JSON.stringify(w.value) === '["city"]') || w.field === "agency.population");
  // Increment 5: one state or the nation, summed over the agencies that reported (P61).
  const geoPlace = (p: Place) => p.kind === "state" || p.kind === "national";
  // P270: several states, or a state and the nation, are separate rows (answerStateSet); beside agencies or city sets they stay declined.
  // Hate crimes of several places, whatever they are, are put side by side by hateOutcome (a Place column), not by NIBRS's own sets.
  const hateSeveral = plan.geography.places.length > 1 && (plan.measures.some((m) => /\.hate_crime$/.test(m.id)) || plan.filters.some((f) => f.kind === "exists" && f.entity === "offense_bias"));
  if (!hateSeveral && (plan.geography.places.some((p) => p.kind !== "agency" && !citySet(p) && !geoPlace(p)) || ((plan.geography.places.some(citySet) || plan.geography.places.some(geoPlace)) && plan.geography.places.length > 1
    && !plan.geography.places.every(geoPlace))))
    return decline("unsupported_capability", "This isn't available: a state or the nation together with other places.");
  // The same agency named twice is one member (never counted twice).
  const namedPlaces = plan.geography.places.filter((p): p is Extract<Place, { kind: "agency" }> => p.kind === "agency");
  if (!hateSeveral && namedPlaces.length > 1) {
    const kept = namedPlaces.filter((p, i) => namedPlaces.findIndex((q) => q.ori === p.ori) === i);
    // A part bound to a dropped duplicate is bound to the place kept for that agency.
    const moved = new Map(namedPlaces.map((p, i) => [`geography.places[${i}]`, `geography.places[${kept.findIndex((q) => q.ori === p.ori)}]`]));
    plan.bindings = plan.bindings.map((b) => (moved.has(b.path) ? { ...b, path: moved.get(b.path)! } : b));
    plan.geography.places = kept;
  }
  // "Combined": one total of the agencies; one agency needs no agency column. "Combined" of anything else (several
  // crimes) is not answered as separate numbers (Codex 02.4).
  // Several names of one agency, combined, are that agency once (Codex 02 re-check B).
  if (flags(ledger0).combined && plan.geography.places.length > 1) plan.geography.combine = "combined";
  else if (flags(ledger0).combined && !flags(ledger0).composite && (namedPlaces.length <= 1 || plan.measures.length > 1))
    return decline("unsupported_capability", "I can combine the counts of several agencies, but not the counts of several crimes. Ask for each crime on its own, or for one crime in several places combined.");
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
    if (set0.kind !== "agency_set") return decline("unsupported_capability", "This isn't available: large cities outside a ranking of a state's cities.");
    set0.where.push({ field: "agency.population", op: ">=", value: 250000 });
    plan.defaults.push({ path: "geography.places[0].where", value: "250000", reason: "P08: large cities have a population of 250,000 or more" });
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
  const drugAny = clause0("measure").find((p) => p.value === "drug_possession");
  const drugPart = drugAny && !/possess/i.test(drugAny.text) ? drugAny : undefined;
  // Drug crimes beside other crimes would need a total inside a list: declined (Codex review 02).
  if (drugPart && plan.measures.length > 1) return decline("unsupported_capability", "This isn't available: drug crimes (drug and narcotic offenses plus drug equipment violations) beside other crimes.");
  const drugStatePlace = plan.geography.places[0]?.kind === "state" || plan.geography.places[0]?.kind === "national";
  // Jeff 2026-11-24: for a state or the nation, "drug possession" counts both 35A and 35B too (agencies keep "drug possession" as one measure).
  if (drugAny && drugStatePlace && plan.measures.length === 1 && plan.measures[0].id === "offenses.drug_possession") {
    // Coordinator 2026-11-24: a state or national sum counts the one composite measure (35A + 35B), so it is a single column.
    plan.measures[0] = { ...plan.measures[0], id: "offenses.drug_crimes" };
    combined = { label: "drug crimes", definition: "Drug crimes are drug/narcotic violations plus drug equipment violations." };
  } else if (drugPart && plan.measures.length === 1 && plan.measures[0].id === "offenses.drug_possession") {
    plan.measures.push({ id: "offenses.drug_equipment", unit: "offense", as: "drug_equipment_offenses" });
    plan.statistics.push({ kind: "count", as: "drug_equipment_offenses_count", measure: "drug_equipment_offenses" });
    combined = { label: "drug crimes", definition: "Drug crimes are drug/narcotic violations plus drug equipment violations." };
    // By period the total is a third column, "Drug crimes together" (Jeff 2026-11-15): counted as its own measure over both codes
    // (the two offenses never overlap), so it carries its own evidence and is blank when either part is not established.
    if (plan.groupings.some((g) => g.dimension.startsWith("time."))) {
      plan.measures.push({ id: "offenses.drug_crimes", unit: "offense", as: "drug_crimes_together" });
      plan.statistics.push({ kind: "count", as: "drug_crimes_together_count", measure: "drug_crimes_together" });
    }
  }
  // P167 (Jeff 2026-11-19): "violent crime with a firearm" is NIBRS crimes against persons with the weapon on the victim's offense, and the answer
  // says which crimes are counted (it is not the four crimes of the FBI's violent crime).
  if (plan.measures.length === 1 && plan.measures[0].id === "violent_crime.ucr" && plan.filters.some((f) => f.kind === "exists" && f.entity === "offense_weapon")) {
    plan.measures[0] = { ...plan.measures[0], id: "victims.person_crimes", unit: "victim" };
    plan.filters = plan.filters.map((f): Filter => (f.kind === "exists" && f.entity === "offense_weapon" ? { ...f, scope: "victim" } : f));
    plan.defaults.push({ path: "measures[0]", value: "victims.person_crimes", reason: "P167: violent crime with a weapon is counted as crimes against persons" });
  }
  plan.measures.forEach((m, i) => {
    const name = m.id.replace(/^[a-z_]+\./, "");
    // D18: carjacking by offense; an offense has one location.
    if (m.id === "incidents.carjacking" && !clause0("unit").length) {
      plan.measures[i] = { ...m, id: "offenses.carjacking", unit: "offense" };
      // A weapon selected was scoped to the incident (the unit the measure had); counted by offense it is the offense's own weapon
      // ("firearm carjackings per month in Houston").
      const toOffense = (f: Filter): Filter => (f.kind === "exists" && f.entity === "offense_weapon" && f.scope === "incident" ? { ...f, scope: "offense" } : f);
      plan.filters = plan.filters.map(toOffense);
      plan.measures[i] = { ...plan.measures[i], ...(m.filters ? { filters: m.filters.map(toOffense) } : {}) };
      plan.groupings = plan.groupings.map(({ multiValue, ...g }) => (g.dimension === "offense.location_type" ? g : { ...g, ...(multiValue ? { multiValue } : {}) }));
    }
    // P11: victims of a property crime -> offenses, with the fixed sentence. The unit part is answered differently by
    // decided policy and disclosed by that sentence, so it is not held to the victim unit.
    const codes = MEASURE_CODES[name];
    const property = name !== "against_property" && (name === "carjacking" || (!!codes && codes.every((c) => CRIMES_AGAINST_PROPERTY.has(c))));
    // P120 (Jeff 2026-11-16): victims of a property crime with an age ("juvenile robbery victims") are counted by victim.
    const victimAge = plan.filters.some((f) => f.kind === "attribute" && f.dimension === "victim.age");
    if (m.id.startsWith("victims.") && property && !victimAge) {
      plan.measures[i] = { ...m, id: `offenses.${name}`, unit: "offense" };
      plan.defaults.push({ path: `measures[${i}].unit`, value: "offense", reason: "P11: property crimes are counted by offense, not by victim" });
      unbind((p) => p.concept === "unit");
      if (!statements.includes("property_counted_by_offense")) statements.push("property_counted_by_offense");
    }
    // P166 (Jeff 2026-11-19): a crime counted by victim, broken down by weapon, is counted by offense (the weapon belongs to the offense), and
    // the answer says so: "Counts are aggravated assault offenses by weapon, not victims."
    if (m.id.startsWith("victims.") && plan.measures[i].id === m.id && plan.groupings.some((g) => g.dimension === "offense_weapon.weapon")
      && !!MEASURE_CODES[name] && !["violent_crime", "property_crime", "person_crimes", "against_property", "homicide", "homicide_all", "murder"].includes(name)) {
      const toOffense = (f: Filter): Filter => (f.kind === "exists" && f.entity === "offense_weapon" ? { ...f, scope: "offense" } : f);
      plan.measures[i] = { ...m, id: `offenses.${name}`, unit: "offense", ...(m.filters ? { filters: m.filters.map(toOffense) } : {}) };
      plan.filters = plan.filters.map(toOffense);
      plan.defaults.push({ path: `measures[${i}].unit`, value: "offense", reason: "P166: a breakdown by weapon counts the offenses, not the victims" });
      unbind((p) => p.concept === "unit");
    }
    // P280 (Jeff 2026-11-23, "Offenses with a note"): a crime against a person broken down by location or by hour of day is counted by
    // offense (NIBRS keeps location and time of day on the offense and the incident, not the victim), and the answer says so. Only when the
    // breakdown is by location and/or hour (a victim's age, sex or relationship keeps the victim unit; weapon stays victims, P166).
    const pCodes = MEASURE_CODES[name];
    const byPlaceOrHour = plan.groupings.some((g) => g.dimension === "offense.location_type" || g.dimension === "incident.hour");
    const onlyPlaceOrHour = plan.groupings.every((g) => g.dimension === "offense.location_type" || g.dimension === "incident.hour" || g.dimension.startsWith("time."));
    const victimFilter = [...plan.filters, ...(m.filters ?? [])].some((f) => (f.kind === "attribute" && /^(?:victim|offender|relationship)\./.test(f.dimension)) || (f.kind === "exists" && f.scope !== "offense" && f.scope !== "incident"));
    if (m.id.startsWith("victims.") && plan.measures[i].id === m.id && !!pCodes && pCodes.every((c) => PERSON_CODES.has(c)) && byPlaceOrHour && onlyPlaceOrHour && !victimFilter
      && !["violent_crime", "property_crime", "against_property"].includes(name)) {
      plan.measures[i] = { ...m, id: `offenses.${name}`, unit: "offense" };
      plan.groupings = plan.groupings.map(({ multiValue, ...g }) => (g.dimension === "offense.location_type" ? g : { ...g, ...(multiValue ? { multiValue } : {}) }));
      plan.defaults.push({ path: `measures[${i}].unit`, value: "offense", reason: "P280: a crime against a person by location or hour is counted by offense, not by victim" });
      unbind((p) => p.concept === "unit");
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
      return decline("unsupported_capability", "This isn't available: gun crime or stabbings beside other crimes, or in this form.");
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
    if (shared) return decline("unsupported_capability", "This isn't available: victims restricted by sex beside the offenders' sexes.");
    const kept = plan.filters.map((_, k) => k).filter((k) => !gone.has(k));
    plan.filters = kept.map((k) => plan.filters[k]);
    unbind((p) => sexParts.includes(p));
    // Bindings to the filters that stay follow them to their new places.
    plan.bindings = plan.bindings.map((b) => { const k = /^filters\[(\d+)\]/.exec(b.path); return k ? { ...b, path: b.path.replace(/^filters\[\d+\]/, `filters[${kept.indexOf(Number(k[1]))}]`) } : b; });
    if (plan.measures.length !== 1 || plan.groupings.some((g) => !g.dimension.startsWith("time."))) return decline("unsupported_capability", "This isn't available: offenders' sexes beside another breakdown or measure.");
    plan.groupings.push({ dimension: "offender.sex", unknown: "visible", absent: "show", multiValue: "each_value" });
    const m0 = plan.measures[0];
    plan.statistics = [{ kind: "count", as: plan.statistics[0].as, measure: m0.as }, { kind: "share", as: "share_of_period", measure: m0.as, within: plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension) }];
  }
  // P50: arrests are placed by arrest date; arrests beside other measures would mix time bases (refused).
  const arrests = plan.measures.filter((m) => /^(?:arrests|group_b_arrests)\./.test(m.id));
  if (arrests.some((m) => m.id.startsWith("group_b_arrests.")) && plan.measures.length > 1)
    return decline("unsupported_capability", "This isn't available: arrests for DUI, disorderly conduct or another minor offense beside another crime or condition.");
  if (arrests.length && arrests.length !== plan.measures.length) return decline("unsupported_capability", "This isn't available: arrests beside other crimes (arrests are dated by the arrest, crimes by the incident).");
  if (arrests.length) {
    plan.timeBasis = "arrest_date";
    plan.defaults.push({ path: "timeBasis", value: "arrest_date", reason: "P50: arrests are counted by arrest date" });
  }

  // Time (increment 3). A comparison the reading recorded becomes the plan's period_comparison over the whole span;
  // "the last 12 months" is one total (P56). Either replaces the reader's time grouping.
  const cmpFlag = flags(ledger0).comparison ?? null;
  if (cmpFlag || flags(ledger0).last12) {
    if (plan.transforms.length) return decline("unsupported_capability", "This isn't available: this combination of time forms.");
    plan.groupings = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  }
  if (cmpFlag) {
    const st = plan.statistics[0];
    if (plan.measures.length !== 1 || plan.groupings.length || plan.statistics.length !== 1 || st.kind !== "count")
      return decline("unsupported_capability", "This isn't available: a change of several crimes, of a breakdown, or of a rate.");
    // The plan's period is the comparison's whole years, as the question's period part reads; the compared periods
    // carry any months (R2: they lie inside it).
    plan.period = { kind: "absolute", from: `${cmpFlag.earlier.from.slice(0, 4)}-01`, to: `${cmpFlag.later.to.slice(0, 4)}-12` };
    plan.transforms = [{ kind: "period_comparison", of: [st.as], earlier: { kind: "absolute", ...cmpFlag.earlier }, later: { kind: "absolute", ...cmpFlag.later }, outputs: ["earlier", "later", "change", "pct_change"] }];
  }
  const rollingT = plan.transforms.find((t) => t.kind === "rolling");
  if (rollingT && (plan.measures.length !== 1 || plan.transforms.length !== 1 || plan.statistics.length !== 1 || plan.statistics[0].kind !== "count"
    || plan.groupings.length !== 1 || plan.groupings[0].dimension !== "time.month"))
    return decline("unsupported_capability", "This isn't available: rolling windows of a rate, a breakdown, or several crimes.");
  // P173 (Jeff 2026-11-21): every state ranked by its clearance rate for one year, the offenses and agencies reporting beside each rate.
  if (plan.transforms.length === 1 && plan.transforms[0].kind === "rank" && plan.transforms[0].by === "clearance_rate" && plan.geography.places[0].kind === "national"
    && plan.groupings.length === 1 && plan.groupings[0].dimension === "geo.state" && plan.measures.length === 2)
    return answerStateClearanceRanking(plan, plan.measures[0].id.split(".")[1], deps, statements, [], (why, detail) => decline("unsupported_capability", why, detail ? { detail } : undefined));
  if (plan.transforms.some((t) => t.kind !== "rolling" && t.kind !== "period_comparison" && !(t.kind === "rank" && plan.geography.places[0].kind === "agency_set") && !(t.kind === "rank" && t.by === "share" && d.spec.type === "share" && d.spec.byState === true)))
    return decline("unsupported_capability", "This isn't available: rankings.");
  // Increment 7b (P71): quarters are the sums of one agency's monthly counts of one crime; by category too (coordinator
  // 2026-11-02), each category's quarter compiled as the sum of its months with its share of the quarter.
  // Hate crimes come only from the hate crime data (Jeff 2026-11-15: "hate crimes should only come from hate crimes data"): before
  // NIBRS's own checks (its data start, its state and national limits do not apply to them), a plan for a hate crime or a bias is answered there or declined plainly,
  // never run on NIBRS and never shown the weapon-or-relationship sentence.
  // A hate crime count with no period named and no series asked is asked about first, as every count is (D31/P06: the "which period"
  // ask below); a series (by year, by month, rolling) with no range is every year the data have (Jeff 2026-11-11, "All years by default").
  const hateSpec = d.spec as { period?: { form: string }; grain?: string };
  const hateAsksPeriod = hateSpec.period?.form === "none" && (!hateSpec.grain || hateSpec.grain === "total");
  if (!hateAsksPeriod && (plan.measures.some((m) => /\.hate_crime$/.test(m.id)) || [...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "offense_bias")))
    return hateOutcome(plan, deps, ledger0) ?? notYet("hate crimes are answered from the hate crime data only, never from NIBRS offense records");
  const quarterly = !!flags(ledger0).quarter;
  const quarterCats = quarterly && plan.groupings.length === 2 && plan.groupings[0].dimension === "time.month" && !plan.groupings[1].dimension.startsWith("time.");
  if (quarterly && (plan.measures.length !== 1 || plan.transforms.length || plan.geography.places.length !== 1 || plan.geography.places[0].kind !== "agency"
    || plan.groupings[0]?.dimension !== "time.month" || (quarterCats ? plan.statistics.some((s) => s.kind !== "count" && s.kind !== "share")
      : plan.statistics.length !== 1 || plan.statistics[0].kind !== "count" || plan.groupings.length !== 1)))
    return decline("unsupported_capability", "This isn't available: quarters of a rate, a breakdown, several crimes or several places.");

  // The slice delivers counts, as totals or by month or year: one measure optionally broken down by ONE delivered
  // category with each category's share of its period (compiler increments 1 and 2), or several measures side by side
  // (with their combined total, as totals only, for D19 and P31). Two-way breakdowns, rates and other shares are
  // declined before anything is asked or run.
  const timeG = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const catG = plan.groupings.filter((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo."));
  // Several agencies, rates and rankings take the places path (increment 4).
  const stateMode = plan.geography.places[0].kind === "state" || plan.geography.places[0].kind === "national";
  // The current year's clearance rate (P57, Jeff 2026-11-16): cleared offenses over offenses in the months the data holds, from NIBRS.
  const plainRateNow = !flags(ledger0).people && !flags(ledger0).property && !flags(ledger0).circumstance && !flags(ledger0).clearance && !flags(ledger0).arrestsThrough && !flags(ledger0).composite
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  if (d.spec.type === "series" && plainRateNow && currentClearance(d.spec, Number(release.lastMonth.slice(0, 4))) && d.spec.places.length === 1)
    return answerCurrentClearance(plan, { from: `${release.lastMonth.slice(0, 4)}-01`, to: release.lastMonth }, d.spec.measures[0], deps, statements, [],
      (why, detail) => decline("unsupported_capability", why, detail ? { detail } : undefined));
  // A completed year's clearance rate for one state (P172): every agency that reported, said so.
  const seriesSpec = d.spec.type === "series" ? d.spec : null;
  const stateRate = seriesSpec && plainRateNow ? completedStateClearance(seriesSpec, Number(release.lastMonth.slice(0, 4)), Number(release.firstMonth.slice(0, 4))) : null;
  if (seriesSpec && stateRate) {
    const fail = (why: string, detail?: string) => decline("unsupported_capability", why, detail ? { detail } : undefined);
    return stateRate.years.length === 1
      ? answerCurrentClearance(plan, { from: `${stateRate.years[0]}-01`, to: `${stateRate.years[0]}-12` }, seriesSpec.measures[0], deps, statements, [], fail, true)
      : answerStateClearanceSeries(plan, stateRate.years, seriesSpec.measures[0], deps, statements, [], fail, stateRate.note);
  }
  // Offender and arrestee breakdowns for a state or the nation are summed like victims' (coordinator 2026-11-04; P29's
  // words, by/against, still decide whose attribute is grouped).
  // A state or national sum by one category (coordinator 2026-11-04): its count and each category's share, never a rate
  // (D03: no population by group).
  // P53: murder broken down by a Homicide Report detail (victim or offender age, sex, race, relationship, weapon,
  // circumstance) for a state or the nation is Homicide Reports', unless NIBRS is named (Codex state-categories review 01.2).
  // Only a Homicide Report detail: a person's attributes, the relationship, the weapon, the circumstance; never a
  // clearance or a location (query-log rerun 2026-11-04: "Virginia murder clearances by type" had been routed).
  const shrDetailDim = (d: string) => /^(?:victim|offender|victim_offender|offense_weapon|victim_circumstance)\./.test(d);
  // A detail selected counts as one broken down (query-log scorecard 2026-11-04: "murders of females in MN in 2023" and
  // "murders with handguns versus rifles nationally" had been NIBRS sums).
  // Only when every filter is such a detail (Codex P53 review 01.1: a clearance or location beside it keeps its own
  // path), and only for victims, the unit Homicide Reports count (01.2: murder offenders stay NIBRS's).
  const filterDims = plan.filters.map((f) => (f.kind === "attribute" ? [f.dimension] : f.kind === "exists" ? f.where.map((w) => (w.kind === "attribute" ? w.dimension : "")) : [""]));
  const detailSelected = filterDims.length > 0 && filterDims.every((ds) => ds.length > 0 && ds.every(shrDetailDim))
    && plan.measures.every((m) => /^victims\.(?:murder|homicide_all|homicide)/.test(m.id));
  // Jeff S1 (2026-11-11, "NIBRS years included"): a murder detail for one agency is Homicide Reports' when a release is
  // loaded, whatever the years; NIBRS when it is named, or for a clearance, a location, property or arrests (which SHR
  // doesn't record: shrQuestionOf leaves those, and any code SHR records differently, on this path).
  // Any person's detail selected, offenders' included (Codex SHR-A review 01.6).
  const detailSelectedAny = filterDims.length > 0 && filterDims.every((ds) => ds.length > 0 && ds.every(shrDetailDim));
  // P152 (Jeff 2026-11-19): "Homicide Reports" in the words asks for that source: murders and homicides only, said plainly otherwise.
  if (flags(ledger0).shrAsked && !plan.measures.every((m) => /^(?:victims|offenders|offenses)\.(?:murder|homicide_all|homicide|justifiable_homicide)(?![a-z_])/.test(m.id)))
    return decline("unsupported_capability", "Homicide Reports hold murders and homicides only.");
  // P163 (Jeff 2026-11-19): justifiable homicide is Homicide Reports' (a felon killed by a private citizen or by police), whatever the years.
  const justifiable = plan.measures.length > 0 && plan.measures.every((m) => /^(?:victims|offenders|offenses)\.justifiable_homicide$/.test(m.id));
  const murderDetail = (catG.some((g) => shrDetailDim(g.dimension)) || detailSelectedAny || flags(ledger0).shrAsked || justifiable)
    && plan.measures.every((m) => /^(?:victims|offenders|offenses)\.(?:murder|homicide_all|homicide|justifiable_homicide)(?![a-z_])/.test(m.id))
    && !flags(ledger0).nibrsAsked && !flags(ledger0).clearance && !flags(ledger0).property && !flags(ledger0).arrestsThrough;
  if (!stateMode && murderDetail) {
    const s = plan.geography.places.length > 1 ? shrSeveral(plan, deps, ledger0) : shrOutcome(plan, deps, ledger0);
    if (s) return s;
    if (flags(ledger0).shrAsked) {
      const where = plan.geography.places.map((p) => (p.kind === "agency" ? p.label : "")).filter(Boolean);
      return decline("outside_release_coverage", `No data is available for ${measureWords(plan)}${where.length ? ` in ${where.length > 2 ? `${where.slice(0, -1).join(", ")} and ${where[where.length - 1]}` : where.join(" and ")}` : ""} from Homicide Reports.`);
    }
  }
  // With a release, a state or national detail SHR can't answer as asked (a location beside it, a rate) goes on to
  // NIBRS's own path (Codex SHR-A review 01.8); without one, it is routed, as before.
  // P270: Homicide Reports and the clearance share read one place; several states or the nation with others wait.
  if (stateMode && plan.geography.places.length > 1 && (murderDetail || (d.spec.type === "share" && flags(ledger0).clearance)))
    return decline("unsupported_capability", "This isn't available: Homicide Reports details or a clearance share for several states or the nation together. Ask for one place.");
  if (stateMode && deps.shr && murderDetail) {
    const s = shrOutcome(plan, deps, ledger0);
    if (s) return s;
    // A Homicide Reports question SHR-A can't answer yet (a rolling window, two weapons compared) is routed, as before
    // (job SA1); a NIBRS-only detail beside it (a location), no period named, or NIBRS's own views go on to NIBRS's path.
    if (catG.every((g) => shrDetailDim(g.dimension)) && filterDims.every((ds) => ds.every(shrDetailDim)) && !plan.defaults.some((d) => d.path === "period") && !flags(ledger0).consistent && !flags(ledger0).quarter)
      return { kind: "route", source: "shr", explanation: "Murder by the victims' or offenders' details for a state or the nation comes from Homicide Reports; this form of the question isn't available here." };
  } else if (stateMode && !deps.shr && (catG.some((g) => shrDetailDim(g.dimension)) || detailSelected || flags(ledger0).circumstance) && plan.measures.some((m) => /^victims\.(?:murder|homicide_all|homicide)|\.murder$/.test(m.id)) && !flags(ledger0).nibrsAsked)
    return { kind: "route", source: "shr", explanation: "Murder by the victims' or offenders' details (broken down or selected) for a state or the nation comes from Homicide Reports, which count the homicides agencies reported to the FBI. Homicide Reports aren't available here. NIBRS has its own counts when asked for by name." };
  // P203 (Jeff 2026-11-21): what share of a crime's clearances (or offenses) were of one clearance type, for a state or the nation.
  const clearanceShare = d.spec.type === "share" && stateMode && plan.geography.places.length === 1 && d.spec.population.length === 0 && d.spec.subset.length === 1
    && d.spec.subset[0].startsWith("clearance:") && (plan.transforms.length === 0 || (!!d.spec.rank && d.spec.byState === true && plan.transforms.every((t) => t.kind === "rank"))) && !plan.defaults.some((x) => x.path === "unit");
  const stateBreakdown = stateMode && catG.length === 1 && plan.measures.length === 1 && !plan.transforms.length
    && plan.statistics.every((x) => x.kind === "count" || x.kind === "share") && plan.statistics.some((x) => x.kind === "count");
  // P271: several crimes for one state or the nation, a column each (count or rate, no breakdown but a year, no change).
  const stateMulti = stateMode && plan.geography.places.length === 1 && plan.measures.length > 1 && !catG.length && !plan.transforms.length && !combined
    && plan.statistics.length === plan.measures.length && plan.statistics.every((x) => x.kind === "count" || x.kind === "rate")
    && plan.groupings.every((g) => g.dimension === "time.year");
  if (stateMode && !stateBreakdown && !clearanceShare && !stateMulti && (plan.measures.length > 1 || catG.length || plan.transforms.length || plan.statistics.length > 1 || !(plan.statistics[0].kind === "count" || plan.statistics[0].kind === "rate")))
    return decline("unsupported_capability", "This isn't available: a state or national sum of several crimes, a breakdown, a change or a ranking.");
  const placesMode = !stateMode && (plan.geography.places.length > 1 || plan.geography.places[0].kind === "agency_set" || plan.statistics.some((x) => x.kind === "rate"));
  // P194 (Jeff 2026-11-21): several named agencies' clearance by type is a row for each, never summed.
  const multiClearance = placesMode && catG.length === 1 && catG[0].dimension === "offense.clearance_type" && plan.measures.length === 1
    && plan.geography.places.length > 1 && plan.geography.places.every((p) => p.kind === "agency") && !plan.transforms.length && plan.geography.combine !== "combined";
  if (placesMode && !multiClearance && (plan.measures.length > 1 || catG.length || plan.transforms.some((t) => t.kind !== "rank")))
    return decline("unsupported_capability", "This isn't available: several agencies or rates with several crimes, a breakdown, a change or rolling windows.");
  // 9aed2136c4: the clearance types asked as percentages carry the share of the period beside the count (the incidents column is dropped below).
  const typeShares = !!deps.shareAsked && catG.length === 1 && catG[0].dimension === "offense.clearance_type" && plan.statistics.length === 1 && plan.statistics[0].kind === "count";
  if (typeShares) plan.statistics.push({ kind: "share", as: "share_of_period", measure: plan.measures[0].as, within: timeG.map((g) => g.dimension) });
  const [first, second, ...more] = plan.statistics;
  const counts =plan.statistics.every((s) => s.kind === "count") && plan.measures.every((m) => plan.statistics.filter((s) => "measure" in s && s.measure === m.as).length === 1);
  const several = plan.measures.length > 1;
  const shareOk = !second || several || (second.kind === "share" && first.kind === "count" && catG.length === 1 && second.measure === first.measure && !second.denominator
    && JSON.stringify(second.within) === JSON.stringify(timeG.map((g) => g.dimension)));
  if (!clearanceShare && (catG.length > 1 || catG.some((g) => !CATEGORY[g.dimension]) || (first.kind !== "count" && !((placesMode || stateMode) && first.kind === "rate")) || (!several && more.length) || !shareOk
    || (several && !stateMulti && (catG.length || !counts)) || (combined && timeG.length && combined.label !== "drug crimes")))
    return decline("unsupported_capability", "This isn't available: this breakdown (by two things at once, several crimes broken down, or a combined total by period), or this rate or share.");

  // P66 (Jeff 2026-10-30): a clearance answer gives the number of incidents beside its count: the crime's incidents,
  // with the same groupings and filters, as a second count. One agency only for now.
  if (!clearanceShare && !typeShares && clearanceDims(plan).length && plan.measures[0].unit !== "incident") {
    // P171 (Jeff 2026-11-21): clearance by type for a state is the reporting agencies' sum (one clearance grouping); the nation
    // and the nation too (the runner timed it: 4.3 s for the nation in 2024).
    const stateClearance = stateMode && stateBreakdown && catG.some((g) => g.dimension.startsWith("offense.clearance_"))
      && (plan.geography.places[0].kind === "state" || plan.geography.places[0].kind === "national");
    if ((stateMode && !stateClearance) || (placesMode && !multiClearance) || cmpFlag || rollingT || several)
      return decline("unsupported_capability", "This isn't available: clearance for a state, the nation or several agencies, for several crimes, or as a change or rolling windows.");
    plan.statistics.splice(1, 0, { kind: "incidents", as: `${plan.measures[0].as}_incidents`, measure: plan.measures[0].as });
  }
  // Increment 6: the share cleared (P64, P66): the cleared units (with their incidents) over all units of the period,
  // each counted independently, for one total.
  if (clr?.share) {
    if (timeG.length || catG.length || clr.by) return decline("unsupported_capability", "This isn't available: the share cleared by period or by category; ask for one period.");
    const m = plan.measures[0], i = plan.filters.findIndex((f) => f.kind === "attribute" && f.dimension === "offense.clearance_status");
    const cleared = { ...m, as: `${m.as}_cleared`, filters: [...(m.filters ?? []), plan.filters[i]] };
    plan.filters.splice(i, 1);
    plan.measures = [cleared, m];
    plan.statistics = [{ kind: "count", as: `${cleared.as}_count`, measure: cleared.as }, { kind: "incidents", as: `${cleared.as}_incidents`, measure: cleared.as },
      { kind: "count", as: `${m.as}_count`, measure: m.as }, { kind: "ratio", as: "share_cleared", numerator: cleared.as, denominator: m.as }];
  }

  // D31/P06: a missing period is asked about, for any reader form, once the question is known to be in the slice.
  const spec = d.spec as { period?: { form: string }; grain?: string };
  if (spec.period?.form === "none") {
    const lcy = Number(release.lastMonth.slice(0, 4)) - (release.lastMonth.endsWith("-12") ? 0 : 1);
    const thisYear = Number(release.lastMonth.slice(0, 4));
    // A clearance share "by year" with no years named (Jeff 2026-11-22: a row for each year) is a series too, asked for the range of years.
    const yearlyShare = d.spec.type === "share" && stateMode && d.spec.subset.some((f) => f.startsWith("clearance:"))
      && ledger0.parts.some((p) => p.clause === 0 && p.concept === "grain" && p.value === "year");
    const trend = (!!spec.grain && spec.grain !== "total") || yearlyShare;
    // Jeff 2026-11-11, "All years by default": "by year", "per month", "over time" with no range is every year the source
    // has, said, never asked. By year (or quarter): NIBRS's first year through the latest complete year; by month or a
    // rolling window: every month through the latest. Only when that answers; otherwise the question is asked as before.
    // P171 (Jeff 2026-11-21): the same for every question: no period named is every year by year, for a single figure or a breakdown too
    // (a series by year of it). Tried only when it answers now; otherwise the question is asked as before.
    // A single figure or a breakdown with no period (P181) is made a series only at the top (applyDefaults), never here: this ask is also built
    // inside other asks' buttons, where a series would run its statements for every button.
    if (trend) {
      const base = trend ? ledger : filled(ledger, "grain", "year", "by year");
      const firstY = release.firstMonth.slice(0, 4);
      const monthly = (spec.grain === "month" || !!(spec as { window?: unknown }).window) && !flags(ledger0).quarter;
      // Murder detail is Homicide Reports' from its own first year; everything else NIBRS's.
      // Homicide Reports' span first (from 1985) for a murder DETAIL (a weapon, a victim's or offender's trait, a relationship:
      // a filter or a category), and for a plain murder count BY MONTH (Jeff 2026-11-14: "SHR by month would be preferred,
      // NIBRS gives far fewer years"). A plain yearly count stays with NIBRS and Crime Index (D3, reported counts).
      const murderMeasure = plan.measures.length > 0 && plan.measures.every((m) => /^(?:victims|offenses)\.(?:murder|homicide_all|homicide)(?![a-z_])/.test(m.id));
      const murderOnly = murderMeasure && (plan.filters.length > 0 || plan.groupings.some((g) => !g.dimension.startsWith("time.")) || monthly);
      const starts = murderOnly ? [String(SHR_FIRST_YEAR), firstY] : [firstY];
      for (const start of starts) {
        const everyYear = (d: ShadowDeps) => fromLedger(filled(base, "period", monthly ? `since:${start}` : `range:${start}:${lcy}`, "every year available"), d, pins);
        // A single figure or breakdown made a series: its statements may be heavy (a national one takes minutes), so only an answer that exists now is used.
        let all: ShadowOutcome;
        if (trend) all = everyYear(deps);
        else { const o = deferHeavy("every", everyYear, deps); if (isDeferred(o) || !o.continuation) { DEFAULT_MISSES.push({ site: "period", why: "heavy" }); continue; } all = o.continuation; }
        if (all.kind === "shr") return all;
        if (["answer", "srs", "historical", "current", "hate"].includes(all.kind) && !(["srs", "historical", "current", "hate"].includes(all.kind) && CRIME_INDEX_BLIND.test(ledger0.question))) {
          const span = monthly ? `${monthName(`${start}-01`)} through ${monthName(release.lastMonth)}` : `${start} through ${lcy}`;
          const x = all as ShadowOutcome & { delivered: { text: string[] }; buttons?: ShadowOption[] };
          const justYear = deferHeavy(`Just ${lcy}`, (d2) => fromLedger(filled(ledger, "period", `year:${lcy}`, `in ${lcy}`), d2, pins), deps);
          return { ...x, delivered: { ...x.delivered, text: [x.delivered.text[0], `No years were given, so every year in the data is shown: ${span}.`, ...x.delivered.text.slice(1)] },
            buttons: [...(x.buttons ?? []), ...(trend ? [] : [justYear, { label: "Another year", entry: "which year" } as ShadowOption])] } as ShadowOutcome;
        }
        DEFAULT_MISSES.push({ site: "period", why: `${all.kind}:${"reason" in all ? all.reason : "about" in all ? all.about : ""}` });
        // Another question first ("which New York"): asked, its answers already for every year.
        if (all.kind === "clarify" && all.about !== "which period" && all.about !== "which range of years") return all;
      }
    }
    const opts: ShadowOption[] = trend
      ? [deferHeavy("The last 10 complete years", (d) => fromLedger(filled(ledger, "period", "last:10", "the last 10 complete years"), d, pins), deps),
         deferHeavy("Every year available", (d) => fromLedger(filled(ledger, "period", `since:${release.firstMonth.slice(0, 4)}`, "every year available"), d, pins), deps),
         { label: "Another range", entry: "which range of years" }]
      : [deferHeavy(`The latest complete year (${lcy})`, (d) => fromLedger(filled(ledger, "period", `year:${lcy}`, `in ${lcy}`), d, pins),
           deps.shareAsked ? { ...deps, deferChars: Number.MAX_SAFE_INTEGER } : deps),
         deferHeavy("This year so far", (d) => fromLedger(filled(ledger, "period", `year:${thisYear}`, "this year so far"), d, pins), deps),
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
  } catch (e) { return notYet(String(e)); }
  if (period.from > release.lastMonth) {
    const y = release.lastMonth.slice(0, 4);
    return decline("outside_release_coverage", `${periodWords(period.from, period.to)} is not in the data; the latest month available is ${monthName(release.lastMonth)}.`,
      { alternative: { label: `This year so far (${periodWordsShort(`${y}-01`, release.lastMonth)})`, continuation: fromLedger(filled(ledger, "period", `year:${y}`, "this year so far"), deps, pins) } });
  }
  if (period.from < release.firstMonth) {
    // The nearest question that runs (coordinator 2026-11-02): the same one from the data's first year, when the period
    // reaches into the data (a button, run when chosen); otherwise none.
    // The asked end kept to the month (Codex period review 01.1), never widened; a set of years gets none.
    const firstY = release.firstMonth.slice(0, 4), to = period.to > release.lastMonth ? release.lastMonth : period.to;
    const value = to.endsWith("-12") ? (firstY === to.slice(0, 4) ? `year:${firstY}` : `range:${firstY}:${to.slice(0, 4)}`) : `monthrange:${release.firstMonth}:${to}`;
    const covered = period.to >= release.firstMonth && !yearSet ? fromLedger(filled(ledger, "period", value, `from ${firstY}`), deps, pins) : null;
    // Murder before NIBRS's years is Homicide Reports' (FBI SHR, from 1976: by month, weapon, victim and offender), never
    // "not in the data" (Jeff 2026-11-09: "oakland murders per month in 1996", "firearm murders in Louisville in 2003").
    // Only what Homicide Reports count (homicide victims and offenses, never offenders or arrests) and only its own
    // details (the victims, offenders, relationship, weapon, circumstance): a location or a clearance stays NIBRS's
    // (Codex coverage review 1).
    const shrDims = plan.filters.map((f) => (f.kind === "attribute" ? [f.dimension] : f.kind === "exists" ? f.where.map((w) => (w.kind === "attribute" ? w.dimension : "")) : [""]));
    const shrFits = plan.measures.length > 0 && plan.measures.every((m) => /^(?:victims|offenses)\.(?:murder|homicide_all|homicide|justifiable_homicide)(?![a-z_])/.test(m.id))
      && shrDims.every((ds) => ds.length > 0 && ds.every((d) => shrDetailDim(d))) && catG.every((g) => shrDetailDim(g.dimension))
      && !flags(ledger0).clearance && !flags(ledger0).property && !flags(ledger0).arrestsThrough;
    if (period.to >= `${SHR_FIRST_YEAR}-01` && !flags(ledger0).nibrsAsked && shrFits)
      return shrOutcome(plan, deps, ledger0) ?? { kind: "route", source: "shr", explanation: `Murders before ${firstY} come from Homicide Reports, which hold the homicides agencies reported from ${SHR_FIRST_YEAR} on. Homicide Reports aren't available here.` };
    // Never "the data" for NIBRS's years alone: Crime Index has yearly figures for cities and counties back to its first
    // year (1930), offered by year when the question runs that way (Jeff 2026-11-09: "THE HISTORICAL DATA STARTS AT 1930").
    // Arrests (Jeff 2026-11-11): answered from NIBRS's first year, saying the earlier years aren't in this data, until a
    // summary-arrest source exists. Crime Index has no arrests, so there is no other answer to offer.
    // The same for any NIBRS-only figure no other source holds (labels R14, 2026-11-24: "drug offenses in Salem since 2000",
    // "carjacking rates in Atlanta for the past ten years"): answered from the first year, the earlier years named, when
    // Crime Index has no yearly figure for it (by year does not run).
    const arrestsOnly = plan.measures.every((m) => /^(?:arrests|group_b_arrests)\./.test(m.id));
    const clipNote = (who: string) => {
      const missing = periodWords(period.from, `${String(Number(firstY) - 1)}-12`);
      const note = `${who} come from NIBRS, which starts in ${firstY}, so ${missing} ${/ (?:through|and|to) /.test(missing) ? "aren't" : "isn't"} included.`;
      const c = covered as Extract<ShadowOutcome, { kind: "answer" }>;
      return { ...c, delivered: { ...c.delivered, text: [c.delivered.text[0], note, ...c.delivered.text.slice(1)] } };
    };
    if (covered?.kind === "answer" && arrestsOnly) return clipNote("Arrests here");
    // The covered years themselves can't be answered (every national arrest by age over several years: job AR6): that
    // reason is the true one, not the years outside the data.
    if (covered?.kind === "decline" && covered.reason === "unsupported_capability" && plan.measures.every((m) => /^(?:arrests|group_b_arrests)\./.test(m.id))) return covered;
    // Monthly for one agency back before NIBRS starts: the choices that exist for it (Jeff 2026-11-14).
    const onePlace = plan.geography.places.length === 1 ? plan.geography.places[0] : null;
    if (onePlace && onePlace.kind === "agency" && !yearSet && !flags(ledger0).nibrsAsked && plan.groupings.some((g) => g.dimension === "time.month") && plan.statistics.every((st) => st.kind === "count")
      && !plan.measures.some((m) => /^(?:victims|offenses|incidents)\.(?:murder|homicide_all|homicide)(?![a-z_])/.test(m.id))) {
      const ch = spanChoices({ ledger, deps, pins, agency: onePlace.label, ori: onePlace.ori, startYear: Number(period.from.slice(0, 4)), startMonth: period.from, endMonth: period.to });
      if (ch) return ch;
    }
    // Any other NIBRS-only figure no other source holds: answered from the first year, the earlier years named, instead of a
    // button (labels R14, 2026-11-24). Only when Crime Index has no yearly figure for it.
    // A by-year run that is itself NIBRS (kind "answer", clipped the same way) is no other source.
    // Not for a monthly question about one agency, rates included: P285 leaves its span choices (Codex 449).
    const monthlyOneAgency = !!onePlace && onePlace.kind === "agency" && plan.groupings.some((g) => g.dimension === "time.month");
    if (covered?.kind === "answer" && !yearSet && !monthlyOneAgency) {
      const by = byYearInstead(ledger, deps, pins);
      if (!by || by.continuation?.kind === "answer") return clipNote("These figures");
    }
    const byYear = covered && runsNow(covered) ? null : byYearInstead(ledger, deps, pins);
    return decline("outside_release_coverage", `NIBRS figures here cover ${monthName(release.firstMonth)} through ${monthName(release.lastMonth)}, so they don't include ${periodWords(period.from, period.to)}.${byYear ? ` Crime Index has yearly figures: cities and counties from ${deps.historical?.firstYear ?? 1930}, states and the nation from 1960.` : ""}`,
      { notBuilt: true, alternative: covered && runsNow(covered) ? { label: `From ${firstY}, the first year in the data`, continuation: covered, role: "nearest_question" } : byYear });
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

  // P72 (Jeff 2026-10-31: "Show it"): a supporting column beside the answer, never a change to its numbers.
  const column = flags(ledger0).column;
  if (column === "both") return decline("unsupported_capability", "This isn't available: the population and the agencies reporting together; ask for one of them.");
  if (column === "population") {
    const r = checked.statistics.find((s) => s.kind === "rate");
    if (!r) return decline("unsupported_capability", "A population column goes with a rate; this answer has no rate.");
    checked = { ...checked, statistics: [...checked.statistics, { kind: "population", as: "population", of: r.as }] };
  } else if (column === "agencies") {
    const s0 = checked.statistics[0];
    if (!stateMode || !("measure" in s0)) return decline("unsupported_capability", "The number of agencies reporting goes with a state or national total.");
    checked = { ...checked, statistics: [...checked.statistics, { kind: "agencies", as: "agencies", measure: s0.measure }] };
  }

  // Hate crimes come only from the hate crime data (Jeff 2026-11-15: "hate crimes should only come from hate crimes data"): a
  // NIBRS plan for a hate crime or a bias is never run, and never shows the weapon-or-relationship sentence.
  if (checked.measures.some((m) => /\.hate_crime$/.test(m.id)) || [...checked.filters, ...checked.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "offense_bias"))
    return hateOutcome(checked, deps, ledger0) ?? notYet("hate crimes are answered from the hate crime data only, never from NIBRS offense records");
  // Validation, as any reader outcome: shape, semantic layer, release; then every part of the question applied.
  // A state's city agencies (a ranking) are the release's agencies with a population for that year, as answered.
  const cityMembers = new Map<string, string[]>();
  const geo = { members: (p: Place, y: number) => {
    if (p.kind === "agency") return [p.ori];
    // A state or the nation: the agencies with a header for that year (P61).
    if (p.kind === "state" || p.kind === "national") {
      const key = `${p.kind === "state" ? p.code : "US"}|${y}`;
      if (!cityMembers.has(key)) cityMembers.set(key, deps.execute(agencyHeaderSql(deps.target.root, universeStates(p), [y])).map((r) => String(r[0])));
      return cityMembers.get(key)!;
    }
    if (p.kind !== "agency_set" || p.within.kind !== "state") return [];
    const min = p.where.find((w) => w.field === "agency.population");
    const key = `${p.within.code}|${y}|${min ? min.value : ""}`;
    if (!cityMembers.has(key)) cityMembers.set(key, deps.execute(agencyPopulationSql(deps.target.root, { state: p.within.code, city: true }, [y]))
      .filter((r) => !min || (r[2] !== null && Number(r[2]) >= Number(min.value))).map((r) => String(r[0])));
    return cityMembers.get(key)!;
  } };
  const authority = (v: string) => { const p = resolved.get(v); return p && p.kind === "agency" ? { oris: [p.ori] } : null; };
  const problems = [...validateOutcome({ kind: "plan", plan: checked }, DRAFT_LAYER, release, geo), ...validateBindings(plan, parts2, authority)];
  if (problems.length) return notYet(`plan did not validate: ${problems.map((p) => `${p.rule} ${p.path}: ${p.message}`).join("; ")}`);

  // A weapon or relationship restriction the answer cannot name is declined: a restricted count must say what restricts it.
  const unnamed = [...checked.filters, ...checked.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity !== "property" && !filterWords(f));
  if (unnamed) return decline("unsupported_capability", "This isn't available: this weapon or relationship selection.");
  const notes0 = [...(flags(ledger0).readings ?? []).filter((x) => x.kind === "spelling").map(readingSentence),
    // P291 (Jeff 2026-11-24): "per day" answers by month, and says so.
    ...((flags(ledger0).readings ?? []).some((x) => x.kind === "phrase" && x.to === "by month" && DAILY_WORDS.test(x.from)) ? ["Per day is not available, so monthly figures are shown."] : []),
    // P293 (Jeff 2026-11-24): "juvenile crime trend" is read as juvenile arrests; arrests are not crimes.
    ...((flags(ledger0).readings ?? []).some((x) => x.kind === "phrase" && /^juveniles?\s+arrests\s+in\s+the\s+united\s+states\s+by\s+year$/i.test(x.to)) ? ["Arrests do not equal crimes."] : []),
    // P84 (Jeff 2026-11-01): how the phrase was read.
    ...(/\b(?:car|vehicle|auto|automobile|truck)\s+break[-\s]?ins?\b/i.test(ledger0.question) ? ["Car break-ins are counted as theft from motor vehicles."] : []),
    // Marijuana (Jeff 2026-11-15): one line under the answer says what is counted.
    ...(plan.filters.some((f) => filterWords(f) === MARIJUANA_WORDS) ? [MARIJUANA_LINE] : []),
    // "Drug possession arrests": NIBRS records an arrest by the drug/narcotic violation, with no split between possessing and selling, so the whole
    // violation is counted and the answer says so (wording drafted by the Engine session, awaiting Jeff's yes).
    ...(/\bpossess/i.test(ledger0.question) && plan.measures.length === 1 && plan.measures[0].id === "arrests.drug_possession" && !plan.filters.some((f) => filterWords(f) === MARIJUANA_WORDS)
      ? ["NIBRS records an arrest by the drug/narcotic violation and does not separate possession from sale, so all drug/narcotic violation arrests are counted."] : []),
    // P168: a person counted by a weapon of the incident's crime (the data does not link a person to one offense), one agency.
    ...([...plan.filters, ...plan.measures.flatMap((m) => m.filters ?? [])].some((f) => f.kind === "exists" && f.entity === "offense_weapon" && (f.scope === "offender" || f.scope === "arrestee"))
      ? ["A person is counted when the incident's crime involved the weapon; the data does not link a person to one offense."] : []),
    // Violent crime by age (Jeff 2026-11-15): what is counted, one line.
    ...(plan.measures.some((m) => /\.person_crimes$/.test(m.id)) ? [PERSON_CRIMES_LINE] : []),
    ...(plan.measures.some((m) => /\.against_property$/.test(m.id)) ? [PROPERTY_AGE_LINE] : []),
    // P10 (Jeff 2026-11-16): all homicides add justifiable homicide; the answer says what it counted.
    ...(plan.measures.some((m) => /\.homicide_all$/.test(m.id)) ? [ALL_HOMICIDES_LINE] : []),
    // P166 (Jeff 2026-11-19): a victim crime broken down by weapon is counted by offense, and says so.
    ...(plan.defaults.some((d) => d.reason.startsWith("P166")) ? [`Counts are ${MEASURE_LABEL[plan.measures[0].id.split(".")[1]] ?? "crime"} offenses by weapon, not victims.`] : []),
    // P280 (Jeff 2026-11-23): a person crime by location or hour is counted by offense, and says so.
    // Also when "offenses" was asked outright: the unit is already offenses, so no default was made, but the figure is the same.
    ...(plan.defaults.some((d) => d.reason.startsWith("P280")) || personOffensesByPlaceOrHour(plan) ? [OFFENSES_NOT_VICTIMS_LINE] : []),
    // P82: what domestic violence counts, one plain note.
    ...(plan.measures.some((m) => /^victims\.domestic_violence$/.test(m.id)) ? [DOMESTIC_VIOLENCE_LINE] : []),
    ...(plan.measures.some((m) => /^incidents\.domestic_violence$/.test(m.id)) ? [DOMESTIC_VIOLENCE_LINE, DOMESTIC_VIOLENCE_INCIDENTS_LINE] : []),
    ...(plan.measures.some((m) => /^offenses\.domestic_violence$/.test(m.id)) ? [DOMESTIC_VIOLENCE_LINE, DOMESTIC_VIOLENCE_OFFENSES_LINE] : []),
    ...(plan.measures.some((m) => /^arrests\.domestic_violence$/.test(m.id)) ? [DOMESTIC_VIOLENCE_LINE, DOMESTIC_VIOLENCE_ARRESTS_LINE] : []),
    // Time of day (Jeff 2026-11-15): the buckets, one line under the table.
    ...(plan.groupings.some((g) => g.dimension === "incident.hour") ? [TIME_OF_DAY_LINE, NIGHT_LINE] : [])];
  // Every arrest in the nation broken down by a person's attribute over more than one year is too large to count here
  // in time (job AR6: 2021-2025 by age took 8 minutes, 2017-2025 more than 15). Declined, with one year offered in
  // words (never run in advance, which would cost as much) until the national arrest query is made faster (Jeff
  // 2026-11-12, "Yes, B then A"). One year, a state, a crime, or no breakdown still answer.
  const nationalEveryArrestBreakdown = stateMode && checked.geography.places.some((p) => p.kind === "national")
    && checked.measures.some((m) => m.id === "arrests.all_crime") && checked.groupings.some((g) => !g.dimension.startsWith("time."));
  if (nationalEveryArrestBreakdown && period.from.slice(0, 4) !== period.to.slice(0, 4))
    return decline("unsupported_capability", `This isn't available: every arrest in the United States broken down by ${checked.groupings.filter((g) => !g.dimension.startsWith("time.")).map((g) => g.dimension.split(".")[1]).join(" and ")} over several years takes too long to count here. Ask for one year, for example "nationwide arrests by age in ${release.lastMonth.slice(5) === "12" ? release.lastMonth.slice(0, 4) : Number(release.lastMonth.slice(0, 4)) - 1}", or for one crime or one state.`);
  // Property crime by a victim's age nationally takes about a minute and the whole memory limit for one year (runner, 2026-11-15), so it is
  // declined for any period (Jeff 2026-11-15: "Drop yet. We can either figure out how to do that or not."); a state or an agency answers.
  if (stateMode && checked.geography.places.some((p) => p.kind === "national") && checked.measures.some((m) => /\.against_property$/.test(m.id))
    && checked.groupings.some((g) => !g.dimension.startsWith("time.")))
    return decline("unsupported_capability", `This isn't available: property crime in the United States broken down by victim age takes too long to count here. Ask for one state, for example "property crimes by victim age in Texas in 2024", or for one agency.`);
  // The same for violent crime by a person's age, nationally over several years (BD3: 2017-2025 by victim age ran DuckDB out of
  // memory): the arrest sentence's pattern, one year offered in words, never run in advance.
  if (stateMode && checked.geography.places.some((p) => p.kind === "national") && checked.measures.some((m) => /\.person_crimes$/.test(m.id))
    && checked.groupings.some((g) => !g.dimension.startsWith("time.")) && period.from.slice(0, 4) !== period.to.slice(0, 4)) {
    const lastYear = release.lastMonth.slice(5) === "12" ? release.lastMonth.slice(0, 4) : Number(release.lastMonth.slice(0, 4)) - 1;
    const who = checked.measures[0].unit === "offender" ? "offender" : "victim";
    return decline("unsupported_capability", `This isn't available: violent crime in the United States broken down by ${who} age over several years takes too long to count here. Ask for one year, for example "nationwide violent crimes by ${who} age in ${lastYear}", or for one state.`);
  }
  // The same for property crime nationally by a person's attribute (offender, victim, arrestee) over several years: the national statements for
  // 2017-2025 took about 5 minutes on the runner (2026-11-16, QL-shr-349398af53: computed before the place question was even asked, then timed
  // out). Declined up front; one year, a state, an agency or one crime still answer.
  if (stateMode && checked.geography.places.some((p) => p.kind === "national") && checked.measures.some((m) => /\.property_crime$/.test(m.id) && m.unit !== "offense")
    && checked.groupings.some((g) => !g.dimension.startsWith("time.")) && period.from.slice(0, 4) !== period.to.slice(0, 4)) {
    const lastYear = release.lastMonth.slice(5) === "12" ? release.lastMonth.slice(0, 4) : Number(release.lastMonth.slice(0, 4)) - 1;
    const by = checked.groupings.filter((g) => !g.dimension.startsWith("time.")).map((g) => { const [who, attr] = g.dimension.split("."); return who === "offender" || who === "victim" || who === "arrestee" ? `${who} ${attr.replace(/_/g, " ")}` : attr.replace(/_/g, " "); }).join(" and ");
    return decline("unsupported_capability", heavyNationalSentence("property crime", by, lastYear));
  }
  if (clearanceShare && d.spec.type === "share") return answerClearanceShare(checked, d.spec, period, yearSet, deps, statements, notes0, (why, detail) => decline("unsupported_capability", why, { detail }));
  if (stateMode && stateMulti) return answerStateMulti(checked, period, yearSet, deps, statements, notes0, !!flags(ledger0).consistent, (why, detail) => decline("unsupported_capability", why, { detail }));
  if (stateMode && checked.geography.places.length > 1) return answerStateSet(checked, period, yearSet, deps, statements, notes0, !!flags(ledger0).consistent, (why, detail) => decline("unsupported_capability", why, { detail }));
  if (stateMode) return answerStateSum(checked, period, yearSet, deps, statements, notes0, !!flags(ledger0).consistent, (why, detail) => decline("unsupported_capability", why, { detail }));
  // Several agencies: the sheriff's-office note too, when one of them is a county asked by name (Codex homicide review 01).
  const placesNote = sheriffNote(deps, checked.geography.places.flatMap((p) => (p.kind === "agency" ? [p.ori] : [])), ledger0.question);
  if (multiClearance) return answerClearanceTypePlaces(checked, period, deps, statements, notes0, (why, detail) => decline("unsupported_capability", why, { detail }));
  if (placesMode) return answerPlaces(checked, period, deps, statements, [...notes0, ...(placesNote ? [placesNote] : [])], (why, detail) => decline("unsupported_capability", why, { detail }));
  // The place is the title; the next line names who reported the figures by the FBI's name (Jeff 2026-10-30).
  const reported = (d: Delivered): Delivered => {
    const p = checked.geography.places[0];
    if (p.kind !== "agency") return d;
    // After the headline (a definition may come before it): the sentence or title that names the place.
    const hl = d.headline !== undefined ? d.text.indexOf(d.headline) : -1;
    const at = (hl >= 0 ? hl : d.text.findIndex((t) => t.includes(p.label) || t.startsWith(p.label.split(",")[0]))) + 1 || 1;
    return { ...d, text: [...d.text.slice(0, at), reportedBy([agencyName(deps.places, p.ori)]), ...(sheriffNote(deps, [p.ori], ledger0.question) ? [sheriffNote(deps, [p.ori], ledger0.question)] : []), ...d.text.slice(at)] };
  };
  // P71 (Jeff 2026-10-31: "Add up months"): each quarter the sum of its three months; a quarter in which the agency did
  // not report all three months (or that runs past the data) is marked incomplete, never shown as a whole quarter.
  if (quarterly) {
    // Only whole quarters of one continuous period: a set of years, or a period starting or ending inside a quarter,
    // would be widened to months not asked for (Codex 7b-04.3).
    const qEdge = (ym: string, end: boolean) => (Number(ym.slice(5, 7)) - (end ? 0 : 1)) % 3 === 0;
    if (yearSet || !qEdge(period.from, false) || !qEdge(requestedTo, true))
      return decline("unsupported_capability", "This isn't available: quarters of a set of years, or of a period that starts or ends inside a quarter; ask for whole quarters or whole years.");
    const qStart = (ym: string) => `${ym.slice(0, 4)}-${String(Math.floor((Number(ym.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}`;
    const from = qStart(period.from), toQ = addMonths(qStart(period.to), 2);
    const to = toQ > release.lastMonth ? release.lastMonth : toQ;
    if (quarterCats) {
      // The compiler's quarter grain: each category's quarter known only when all three months are (D6), its share of
      // that quarter's units; a quarter past the data is incomplete, never a shorter sum.
      // Read only through the release's last month (Codex month review 01.1): a quarter running past it is incomplete,
      // blank, never a sum of the months before the cutoff or of months the release does not cover.
      const qPlan: NibrsPlan = { ...checked, period: { kind: "absolute", from, to },
        groupings: [{ ...checked.groupings[0], dimension: "time.quarter" }, checked.groupings[1]],
        statistics: checked.statistics.map((s) => (s.kind === "share" ? { ...s, within: ["time.quarter"] } : s)) };
      const c = compilePlan(qPlan, { kind: "absolute", from, to }, deps.target);
      if (c.kind === "unsupported") return notYet(c.reason);
      const qEnd = (k: string) => `${k.slice(0, 4)}-${String(Number(k.slice(6)) * 3).padStart(2, "0")}`;
      const pi = c.query.columns.indexOf("period");
      const got = deps.execute(c.query.sql).map((r) => (qEnd(String(r[pi])) <= release.lastMonth ? r
        : c.query.columns.map((col, i) => (i === pi || checked.groupings.some((g) => g.dimension === col) ? r[i] : col.endsWith("_status") ? "UNKNOWN" : null))));
      if (got.some((r) => c.query.columns.some((col, i) => col.endsWith("_status") && c.query.refuseOn.includes(String(r[i])))))
        return decline("unsupported_capability", "This agency's reports for this period disagree with its record of which months it reported, so no number is given.");
      for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
      const delivered = deliver(qPlan, { from, to }, requestedTo, c.query.columns, got, statements, release.id, notes0, null);
      if (delivered.contractProblems.length) return notYet(`answer contract: ${delivered.contractProblems.join("; ")}`);
      return { kind: "answer", plan: qPlan, period, sql: c.query.sql, delivered: reported(delivered) };
    }
    const sub: NibrsPlan = { ...checked, period: { kind: "absolute", from, to } };
    const c = compilePlan(sub, { kind: "absolute", from, to }, deps.target);
    if (c.kind === "unsupported") return notYet(c.reason);
    const got = deps.execute(c.query.sql);
    if (got.some((r) => String(r[2]) === "EVIDENCE_CONFLICT")) return decline("unsupported_capability", "This agency's reports for this period disagree with its record of which months it reported, so no number is given.");
    for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
    const cell = new Map(got.map((r) => [String(r[0]), { value: r[1] === null || r[1] === undefined ? null : Number(r[1]), status: String(r[2]) }]));
    const known = (s: string) => s === "VALUE" || s === "REPORTED_ZERO";
    const rows: unknown[][] = [], incomplete: string[] = [];
    for (let q = from; q <= qStart(period.to); q = addMonths(q, 3)) {
      const ms = [q, addMonths(q, 1), addMonths(q, 2)].map((m) => cell.get(m));
      const key = `${q.slice(0, 4)}-Q${Math.floor((Number(q.slice(5, 7)) - 1) / 3) + 1}`;
      if (ms.every((x) => x && known(x.status))) rows.push([key, ms.reduce((a, x) => a + (x!.value ?? 0), 0), ms.every((x) => x!.status === "REPORTED_ZERO") ? "REPORTED_ZERO" : "VALUE"]);
      else { rows.push([key, null, "UNKNOWN"]); incomplete.push(key); }
    }
    const qPlan: NibrsPlan = { ...checked, groupings: [{ dimension: "time.quarter", unknown: "visible", absent: "show" }] };
    const as = checked.statistics[0].as;
    const delivered = deliver(qPlan, period, requestedTo, ["period", as, `${as}_status`], rows, statements, release.id, notes0, null, { quarters: { incomplete } });
    if (delivered.contractProblems.length) return notYet(`answer contract: ${delivered.contractProblems.join("; ")}`);
    return { kind: "answer", plan: qPlan, period, sql: c.query.sql, delivered: reported(delivered) };
  }
  // Changes and rolling windows: one monthly query of the measure over every month they reach; the transforms roll it.
  if (cmpPeriods || rollingT) {
    const m = checked.measures[0];
    const months = rollingT && rollingT.kind === "rolling" ? rollingT.months : 0;
    const span = cmpPeriods ? { from: cmpPeriods.earlier.from, to: cmpPeriods.later.to } : { from: windowMonths(period.from, months)[0], to: period.to };
    const sub: NibrsPlan = { ...checked, measures: [{ ...m, filters: undefined }], filters: [...checked.filters, ...(m.filters ?? [])], transforms: [],
      groupings: [{ dimension: "time.month", unknown: "visible", absent: "show" }], period: { kind: "absolute", ...span } };
    const c = compilePlan(sub, { kind: "absolute", ...span }, deps.target);
    if (c.kind === "unsupported") return notYet(c.reason);
    const got = deps.execute(c.query.sql);
    const cells: MonthCell[] = got.map((r) => ({ ym: String(r[0]), value: r[1] === null || r[1] === undefined ? null : Number(r[1]), status: String(r[2]) }));
    for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
    const inSpan = (p: { from: string; to: string }) => cells.filter((x) => x.ym >= p.from && x.ym <= p.to);
    // A conflict in any month the answer uses refuses the whole answer, as for every count.
    const used = cmpPeriods ? [...inSpan(cmpPeriods.earlier), ...inSpan(cmpPeriods.later)] : cells;
    if (used.some((x) => x.status === "EVIDENCE_CONFLICT")) return decline("unsupported_capability", "This agency's reports for this period disagree with its record of which months it reported, so no number is given.");
    if (cmpPeriods) {
      const delivered = deliverComparison(checked, cmpPeriods, compare(inSpan(cmpPeriods.earlier), inSpan(cmpPeriods.later)), statements, release.id, notes0);
      if (delivered.contractProblems.length) return notYet(`answer contract: ${delivered.contractProblems.join("; ")}`);
      return { kind: "answer", plan: checked, period: { from: cmpPeriods.earlier.from, to: cmpPeriods.later.to }, sql: c.query.sql, delivered: reported(delivered) };
    }
    const displayed = cells.filter((x) => x.ym >= period.from && x.ym <= period.to).map((x) => x.ym);
    const windows = rolling(cells, months, displayed);
    const as = checked.statistics[0].as;
    // A rolling average (Jeff 2026-11-05: "Answer the average"): each window's total over its months, said as an average.
    const average = ledger0.parts.some((p) => p.concept === "rolling" && String(p.value).startsWith("rolling-avg"));
    const shown = windows.map((w) => [w.ym, average && w.value !== null ? Math.round((10 * w.value) / months) / 10 : w.value, w.status]);
    const delivered = deliver(checked, period, requestedTo, ["period", as, `${as}_status`], shown, statements, release.id, notes0, null,
      { rolling: { months, average, missing: cells.filter((x) => x.status !== "VALUE" && x.status !== "REPORTED_ZERO" && x.status !== "NOT_REPORTED").map((x) => x.ym),
        leftOut: cells.filter((x) => x.status === "NOT_REPORTED" && x.ym >= windowMonths(period.from, months)[0] && x.ym <= period.to).map((x) => x.ym) } });
    if (delivered.contractProblems.length) return notYet(`answer contract: ${delivered.contractProblems.join("; ")}`);
    return { kind: "answer", plan: checked, period, sql: c.query.sql, delivered: reported(delivered) };
  }
  // One compiled query per measure (its own filters as the query's), its rows joined on the period key.
  const sqls: string[] = [];
  let columns: string[] = [];
  let rows: unknown[][] = [];
  for (const m of checked.measures) {
    const sub: NibrsPlan = { ...checked, measures: [{ ...m, filters: undefined }], filters: [...checked.filters, ...(m.filters ?? [])], statistics: checked.statistics.filter((s) => "measure" in s && s.measure === m.as) };
    const c = compilePlan(sub, yearSet ? { kind: "years", years: yearSet, ...(period.to < `${yearSet[yearSet.length - 1]}-12` ? { through: period.to } : {}) } : { kind: "absolute", ...period }, deps.target);
    if (c.kind === "unsupported") return notYet(c.reason);
    const got = deps.execute(c.query.sql);
    if (got.some((r) => c.query.columns.some((col, i) => col.endsWith("_status") && c.query.refuseOn.includes(String(r[i])))))
      return decline("unsupported_capability", "This agency's reports for this period disagree with its record of which months it reported, so no number is given.");
    for (const st of c.query.statements) if (!statements.includes(st)) statements.push(st);
    sqls.push(c.query.sql);
    if (!columns.length) { columns = c.query.columns; rows = got; continue; }
    // Each row by its period and categories (one total row has none): the same keys for every measure. Several
    // measures have no categories; the incidents beside a clearance count (P66) have the count's.
    const keyCols = (cols: string[]) => cols.map((col, i) => (col === "period" || checked.groupings.some((g) => g.dimension === col) ? i : -1)).filter((i) => i >= 0);
    const keyOf = (r: unknown[], idx: number[]) => idx.map((i) => String(r[i])).join("|");
    const kGot = keyCols(c.query.columns), kRows = keyCols(columns);
    const byKey = new Map(got.map((r) => [keyOf(r, kGot), r]));
    if (got.length !== rows.length || byKey.size !== got.length || rows.some((r) => !byKey.has(keyOf(r, kRows)))) return decline("unsupported_capability", "This isn't available: measures whose periods or categories do not line up.");
    const stat = c.query.columns.map((col, i) => (kGot.includes(i) || col === "left_out" ? -1 : i)).filter((i) => i >= 0);
    columns = [...columns, ...stat.map((i) => c.query.columns[i])];
    rows = rows.map((r) => [...r, ...stat.map((i) => byKey.get(keyOf(r, kRows))![i])]);
  }
  const delivered = deliver(checked, period, requestedTo, columns, rows, statements, release.id, notes0, combined, yearSet ? { years: yearSet } : {});
  if (delivered.contractProblems.length) return notYet(`answer contract: ${delivered.contractProblems.join("; ")}`);
  return { kind: "answer", plan: checked, period, sql: sqls.join(";\n"), delivered: reported(delivered) };
}

const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
const monthsBetween = (from: string, to: string) => monthIndex(to) - monthIndex(from);
const addMonths = (ym: string, n: number) => { const k = monthIndex(ym) + n; return `${Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, "0")}`; };
const periodWordsShort = (from: string, to: string) => (from === to ? monthName(to) : `${monthName(from).split(" ")[0]} to ${monthName(to)}`);

/**
 * Item 11: a question that asks for population alone ("US population per year since 1960", "what is the current
 * population of Minneapolis, MN?", "population of Memphis and Tennessee in 2023"): every word is a place, a period, a
 * grain or population words, and every place is a resolved agency, a state or the nation. Anything else (a crime, a
 * statistic, combined, a breakdown, an unresolved place) goes on as before. No period: "current" and its like are the
 * latest year; otherwise the period is asked.
 */
const POPULATION_WORD = /\bpopulations?\b/i;
const POPULATION_ONLY = /^(?:\s|[,.?!:'’]|\b(?:populations?|current(?:ly)?|latest|most\s+recent|now|today|total|estimated?|estimates?|resident|served|covered|policed|the|of|for|in|and|what|is|was|were|are|show|me|give|list|tell|by|per|year|years|each|every|annual|yearly|over|time|vs\.?|versus|compared?|with|to)\b)*$/i;
function populationQuestion(ledger: RequestLedger, ledger0: RequestLedger, deps: ShadowDeps, resolved: Map<string, Place>): ShadowOutcome | "ask period" | null {
  if (!deps.historical || !POPULATION_WORD.test(ledger0.question)) return null;
  // Places to be combined are never shown side by side as if answered; any other qualifier the reader kept aside (a
  // region read as the nation, a change, NIBRS asked by name) is never dropped (Codex population review 01.1).
  if (qualified(ledger0) || /\b(?:combined|together|altogether)\b/i.test(ledger0.question)) return null;
  const own = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  if (!own.every((p) => ["place", "period", "grain", "unrecognized"].includes(p.concept))) return null;
  if (!own.filter((p) => p.concept === "unrecognized").every((p) => POPULATION_ONLY.test(p.text))) return null;
  if (!own.some((p) => p.concept === "unrecognized" && POPULATION_WORD.test(p.text))) return null;
  const grains = own.filter((p) => p.concept === "grain"), periods = own.filter((p) => p.concept === "period");
  if (grains.some((p) => p.value !== "year") || periods.length > 1) return null;
  const places: PopulationPlace[] = [];
  for (const part of own.filter((p) => p.concept === "place")) {
    const np = placeOf(part);
    if (!np) return null;
    if (np.kind === "agency") {
      const r = resolved.get(String(part.value));
      if (r?.kind !== "agency") return null;
      places.push({ agency: { ori: r.ori, label: r.label, name: np.name, state: np.state } });
    } else places.push({ geo: np.kind === "state" ? { kind: "state", code: np.code } : { kind: "national" } });
  }
  if (!places.length) return null;
  const build = deps.historical, thisYear = Number(deps.release.lastMonth.slice(0, 4));
  const lastYear = Math.min(...places.map((p) => ("agency" in p ? build.lastYear : SRS_YEARS.last)));
  const byYearAsked = grains.length > 0;
  let from: number, to: number;
  const period = periods.length ? periodOf(periods[0]) : null;
  if (periods.length && !period) return null;
  if (!period) {
    if (/\b(?:current(?:ly)?|latest|most\s+recent|now|today)\b/i.test(ledger0.question)) [from, to] = [lastYear, lastYear];
    else if (byYearAsked) [from, to] = [build.firstYear, lastYear];
    else return "ask period";
  } else if (period.form === "year") [from, to] = [period.year, period.year];
  else if (period.form === "range") [from, to] = [period.from, period.to];
  else if (period.form === "since") [from, to] = [period.from, Math.max(lastYear, period.from)];
  else if (period.form === "last") [from, to] = [lastYear - period.n + 1, lastYear];
  else if (period.form === "lastyear") [from, to] = [thisYear - 1, thisYear - 1];
  else if (period.form === "latest") [from, to] = [lastYear, lastYear];
  else return decline("unsupported_capability", "Population figures are by year; ask for a year or a span of years.");
  // The year right after the latest completed one is answered with that year's population (population-carry.ts, Jeff 2026-11-14).
  if (to > lastYear + 1) return decline("outside_release_coverage", `Population figures in the data run through ${lastYear + 1}; ${to > from ? `${lastYear + 2} through ${to} are` : `${to} is`} not in them.`);
  const oris = places.flatMap((p) => ("agency" in p ? [p.agency.ori] : []));
  const r = answerPopulation(places, from, to, byYearAsked || to > from, build, deps.execute,
    oris.length ? { agencyLine: reportedBy(oris.map((o) => agencyName(deps.places, o))).replace(/^Reported by /, "Figures for ") } : {});
  if (r.kind === "historical") return r;
  return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
}

/**
 * Item 11b (coordinator 2026-11-07): a state's agencies listed with their populations ("Can you give me a list of
 * Hawaii law enforcement agencies ordered by population covered in 2024?"). Only "agencies" with one state and a
 * year, and list or population words: a county's agencies, NIBRS reporting, types or anything else go on as before.
 */
const LIST_ONLY = /^(?:\s|[,.?!:'’]|\b(?:law\s+enforcement|police|all|the|of|a|list|lists|listing|show|me|give|can|could|you|please|which|what|are|is|were|in|for|with|their|its|and|by|ordered|sorted|ranked|ranking|order|population|populations|covered|served|policed|largest|biggest|first|current(?:ly)?|latest|now|today)\b)*$/i;
function agencyListQuestion(ledger: RequestLedger, ledger0: RequestLedger, deps: ShadowDeps): ShadowOutcome | "ask period" | null {
  if (!deps.historical || qualified(ledger0)) return null;
  const own = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  if (!own.some((p) => p.concept === "entity" && p.value === "agency")) return null;
  if (!own.every((p) => ["entity", "place", "period", "unrecognized"].includes(p.concept))) return null;
  if (!own.filter((p) => p.concept === "unrecognized").every((p) => LIST_ONLY.test(p.text))) return null;
  const placeParts = own.filter((p) => p.concept === "place"), periods = own.filter((p) => p.concept === "period");
  const np = placeParts.length === 1 ? placeOf(placeParts[0]) : null;
  if (np?.kind !== "state" || periods.length > 1 || own.filter((p) => p.concept === "entity").length !== 1) return null;
  const build = deps.historical;
  const period = periods.length ? periodOf(periods[0]) : null;
  let year: number;
  if (!period) {
    if (!/\b(?:current(?:ly)?|latest|now|today)\b/i.test(ledger0.question)) return "ask period";
    year = build.lastYear;
  } else if (period.form === "year") year = period.year;
  else if (period.form === "lastyear") year = Number(deps.release.lastMonth.slice(0, 4)) - 1;
  else if (period.form === "latest") year = build.lastYear;
  else return decline("unsupported_capability", "A list of agencies is for one year; ask for a year.");
  const byOri = new Map([...deps.places.byName.values()].flat().map((a) => [a.ori, a]));
  // An index entry with no name gives way to the build's own name (Codex population review 02.2: ", Illinois").
  const r = answerAgencyList(np.code, year, build, deps.execute, (ori) => { const a = byOri.get(ori); return a?.name?.trim() ? agencyLabel(a) : null; });
  if (r.kind === "historical") return r;
  return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
}

/** Whether the reader kept any qualifier aside as a flag: population and agency lists take none. */
const QUALIFIERS: (keyof Flags)[] = ["forecast", "court", "offenders", "composite", "undefinedTerm", "comparison", "last12", "combined", "largeCities", "largestSet", "countywide", "region",
  "circumstance", "nibrsAsked", "shrAsked", "consistent", "shrDetail", "property", "arrestsThrough", "clearance", "people", "quarter", "column"];
function qualified(ledger0: RequestLedger): boolean {
  const f = flags(ledger0);
  return QUALIFIERS.some((k) => { const v = f[k]; return !!v && !(Array.isArray(v) && !v.length); });
}

/**
 * Item 1 (query-log step one, 2026-11-02): police staffing for agencies ("Show me the number of police officers in New
 * York City from 1980 to 2024", "officers per 1,000 population in Salem, Oregon since 1960"). Every word is a place, a
 * period, by year, a count or a rate, or staffing words; every place a resolved agency. Crime Index publishes staffing
 * per 100,000 people: another scale is answered per 100,000 and said, never converted. States and the nation have none.
 */
/** The staff counted, a count or a rate, and the rate's base, from a question's words (an agency's staffing and a set of cities' share it). */
type StaffTerms = { kind: StaffKind; rate: boolean; per: number };
function staffTerms(q: string, own: Part[]): { decline: ShadowOutcome } | StaffTerms | null {
  const no = (reason: LimitationReason, why: string) => ({ decline: decline(reason, why) });
  const officers = /\b(?:officers?|sworn|cops?)\b/i.test(q), civilians = /\bcivilians?\b/i.test(q);
  // All employees named apart from civilian employees ("police employees", "personnel"); "staffing" alone names none.
  const everyone = /(?<!\bcivilian\s)\b(?:employees?|personnel|headcount)\b/i.test(q);
  // "Per" only as a rate per people or "per year": a ratio between staff ("employees per officer") is never answered
  // as a count (Codex staffing review 01.2).
  const perOk = [...q.matchAll(/\bper\b/gi)].every((m) => /^per[\s-]+(?:capita|population|residents?|persons?|people|inhabitants|year|years|annum|eyar|yera|yaer|yr|yrs)\b|^per[\s-]+(?:\d[\d,]*(?:\s*k)?|thousand|million|ten\s+thousand|one\s+million)(?![\d,])(?=\s*(?:people|population|residents?|persons?|inhabitants|citizens|capita)\b|[\s,.?!]*(?:$|in\b|for\b|since\b|from\b|by\b|per\b|each\b|every\b|yearly\b|annual\w*|during\b|between\b|over\b|across\b|at\b|and\b|vs\.?\b|versus\b|to\b|compared\b|\d))/i.test(q.slice(m.index)));
  if (!perOk) return no("unsupported_capability", "Staffing is answered as counts or per 100,000 people; a ratio between kinds of staff isn't available.");
  // More than one kind named ("officers and civilian employees", "officers and police employees"): which one is asked,
  // never one of them answered for both (01.1).
  if ([officers, civilians, everyone].filter(Boolean).length > 1) return no("unsupported_capability", "Ask for one: sworn officers, civilian employees or all employees (officers and civilians together).");
  const kind: StaffKind = civilians ? "civilians" : officers ? "officers" : "employees";
  const stats = own.filter((p) => p.concept === "statistic");
  const rateLike = (v: string | null) => v === "rate" || v === "per100k" || v === "percapita" || /^scale:/.test(String(v));
  // "In 1,000" for "per 1,000" ("sworn officers in 1,000 in Salem").
  const inBase = /\b(?:officers?|sworn|cops?|staff\w*|employees?)\b[^,.?]*?\bin\s+(1,?000|10,?000|100,?000)\b(?!\s*(?:\d|police|officers?))/i.exec(q);
  const rate = stats.some((p) => rateLike(p.value)) || /\bper\s+(?:capita|population|resident|person|people)\b/i.test(q) || !!inBase;
  // A count asked beside a rate ("What is the count of ... and the rate per capita": 01.3): the same figure is asked
  // for. "The number of officers per capita" and "how many officers per capita" are the rate: the opener's count words
  // name what is counted, not a second figure.
  if (rate && (/\bcounts?\b/i.test(q) || (/\b(?:numbers?|totals?)\b/i.test(q) && (/\brates?\b/i.test(q) || /\b(?:and|plus|&|with|versus|vs\.?)\s+(?:the\s+)?per\b/i.test(q)))))
    return no("unsupported_capability", "Ask for the same figure throughout: a count, or a rate per 100,000 people.");
  if (stats.some((p) => !rateLike(p.value) && p.value !== "count")) return null;
  // P97 (Jeff 2026-11-07: "Convert to per 1,000"): a rate asked at another base is given at that base.
  const scale = stats.find((p) => /^scale:/.test(String(p.value)));
  // Two different bases ("per 1,000 residents and per 100,000 residents"): one is asked for, never the first answered.
  const askedBases = new Set([...stats.filter((p) => /^scale:/.test(String(p.value))).map((p) => baseOf(String(p.value).slice(6))),
    ...[...q.matchAll(/\bper\s+(\d[\d,]*(?:\s*k)?|thousand|ten\s+thousand|(?:one\s+)?million)\b/gi)].map((m) => baseOf(m[1]))].filter((b) => b !== null));
  if (askedBases.size > 1) return no("unsupported_capability", "Ask for one rate base: per 1,000, per 100,000 or another, not several.");
  const per = inBase ? baseOf(inBase[1]) : !scale ? 100_000 : baseOf(String(scale.value).slice(6));
  if (per === null) return no("unsupported_capability", "Staffing rates are given per a whole number of people, such as per 1,000 or 100,000.");
  return { kind, rate, per };
}
const STAFF_ONLY = /^(?:\s|[,.?!:'’()-]|\b(?:police|officers?|sworn|law\s+enforcement|cops?|civilians?|employees?|employed|staff|staffing|staffed|personnel|headcount|force|size|levels?|full[-\s]?time|total|number|numbers|count|counts|of|the|in|at|for|did|does|do|have|has|had|how|many|what|was|is|were|are|show|me|give|tell|list|by|per|year|years|each|every|annual|yearly|over|time|department|departments|dept|agency|agencies|compared?|vs\.?|versus|with|and|to|a|its|their|current(?:ly)?|latest|now|today|until|across|information|info|data|population|capita|residents?|people|persons?|inhabitants|1,?000|10,?000|100,?000)\b)*$/i;
/** A misspelled "year" ("per eyar"): the grain asked, never an unread word. */
const YEAR_TYPO = /\b(?:eyar|yera|yaer|yr|yrs)\b/gi;
function staffingQuestion(ledger: RequestLedger, ledger0: RequestLedger, deps: ShadowDeps, resolved: Map<string, Place>): ShadowOutcome | "ask period" | null {
  if (!deps.historical) return null;
  const own = ledger.parts.filter((p) => p.clause === 0 && p.state !== "context");
  const q = ledger0.question;
  // Staffing with a crime in one question (Jeff 2026-11-11: "it should do one dataset at a time, not mix"): said plainly,
  // never answered as either one. Only when the words name staff, never a crime's victims ("officers killed").
  if (own.some((p) => p.concept === "measure")) return staffingBesideWords(q) ? decline("unsupported_capability", STAFF_MIXED_TEXT) : null;
  if (qualifiedStaffing(ledger0)) return null;
  if (!own.every((p) => ["place", "period", "grain", "statistic", "unrecognized", "change", "combine", "entity"].includes(p.concept))) return null;
  // "How has staffing changed" (a neutral change) is the series by year; a percent or other change is not built.
  if (own.some((p) => p.concept === "change" && p.value !== "change:neutral")) return null;
  if (own.some((p) => p.concept === "combine" && p.value !== "combine")) return null;
  if (own.some((p) => p.concept === "entity" && p.value !== "agency")) return null;
  const trend = own.some((p) => p.concept === "change");
  // Staffing is a year's figure: a year to date ("so far in 2023") is never answered with the whole year.
  if (saysToDate(ledger0)) return decline("unsupported_capability", "Staffing figures are for full years; a year to date isn't available here. Ask for a full year.");
  if (!own.filter((p) => p.concept === "unrecognized").every((p) => STAFF_ONLY.test(p.text.replace(YEAR_TYPO, "year")))) return null;
  const terms = staffTerms(q, own);
  if (!terms) return null;
  if ("decline" in terms) return terms.decline;
  const { kind, rate, per } = terms;
  const grains = own.filter((p) => p.concept === "grain");
  const typoYear = YEAR_TYPO.test(own.filter((p) => p.concept === "unrecognized").map((p) => p.text).join(" ")) ? 1 : 0;
  YEAR_TYPO.lastIndex = 0;
  const periods = own.filter((p) => p.concept === "period");
  if (grains.some((p) => p.value !== "year")) return null;
  const places = own.filter((p) => p.concept === "place");
  if (!places.length) return null;
  const agencies: { ori: string; label: string; name: string; state: string }[] = [];
  for (const part of places) {
    const np = placeOf(part);
    if (np?.kind === "state" || np?.kind === "national") return decline("unsupported_capability", "Staffing is reported by individual agencies; there is no state or national staffing total. Ask for an agency.");
    if (np?.kind !== "agency") return null;
    const r = resolved.get(String(part.value));
    if (r?.kind !== "agency") return null;
    agencies.push({ ori: r.ori, label: r.label, name: np.name, state: np.state });
  }
  const build = deps.historical, thisYear = Number(deps.release.lastMonth.slice(0, 4));
  // "Since 1980 until 2025": a span, the two years the reader took for a "since" and a year.
  const sinceUntil = periods.length === 2 ? (() => {
    const [a, b] = periods.map(periodOf);
    return a?.form === "since" && b?.form === "year" && b.year >= a.from && /\b(?:until|through|thru|to)\b/i.test(q) ? { form: "range" as const, from: a.from, to: b.year } : null;
  })() : null;
  if (periods.length > 1 && !sinceUntil) return null;
  const period = sinceUntil ?? (periods.length === 1 ? periodOf(periods[0]) : null);
  if ((periods.length === 1 || sinceUntil) && !period) return null;
  let from: number, to: number;
  if (!period) {
    if (/\b(?:current(?:ly)?|latest|now|today)\b/i.test(q)) [from, to] = [build.lastYear, build.lastYear];
    else if (grains.length || trend || typoYear) [from, to] = [build.firstYear, build.lastYear];
    else return "ask period";
  } else if (period.form === "year") [from, to] = [period.year, period.year];
  else if (period.form === "range") [from, to] = [period.from, period.to];
  else if (period.form === "since") [from, to] = [period.from, build.lastYear];
  else if (period.form === "last") [from, to] = [build.lastYear - period.n + 1, build.lastYear];
  else if (period.form === "lastyear") [from, to] = [thisYear - 1, thisYear - 1];
  else if (period.form === "latest") [from, to] = [build.lastYear, build.lastYear];
  else return decline("unsupported_capability", "Staffing figures are by year; ask for a year or a span of years.");
  const agencyLine = reportedBy(agencies.map((a) => agencyName(deps.places, a.ori))).replace(/^Reported by /, "Figures for ");
  const r = answerStaffing(kind, rate ? "rate" : "count", agencies, from, to, grains.length > 0 || trend || typoYear > 0 || to > from, build, deps.execute, { agencyLine, per });
  if (r.kind === "historical") return r;
  return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
}
/** The base a "per N" names ("1,000", "10k", "ten thousand", "million"): a power of ten from 1 to 1,000,000, else null. */
function baseOf(v: string): number | null {
  const t = v.toLowerCase().replace(/,/g, "").trim();
  const n = /^\d+$/.test(t) ? Number(t) : /^\d+\s*k$/.test(t) ? Number(t.replace(/\s*k$/, "")) * 1000
    : t === "thousand" ? 1000 : /^ten\s+thousand$/.test(t) ? 10_000 : /^(?:one\s+)?million$/.test(t) ? 1_000_000 : NaN;
  return [1, 10, 100, 1000, 10_000, 100_000, 1_000_000].includes(n) ? n : null;
}
/** Any qualifier the reader kept aside (combined, a change, a region, NIBRS asked by name): staffing takes none. */
function qualifiedStaffing(ledger0: RequestLedger): boolean {
  const f = flags(ledger0);
  return (["forecast", "court", "offenders", "composite", "undefinedTerm", "comparison", "last12", "combined", "largeCities", "largestSet", "countywide", "region", "circumstance", "nibrsAsked", "shrAsked",
    "consistent", "shrDetail", "property", "arrestsThrough", "clearance", "people", "quarter", "column"] as (keyof Flags)[]).some((k) => { const v = f[k]; return !!v && !(Array.isArray(v) && !v.length); });
}
