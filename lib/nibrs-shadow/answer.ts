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
import type { Part, RequestLedger } from "../request-accounting";
import { COURT_TEXT, FORECAST_TEXT, readQuestion, readingSentence, type Flags } from "./reading";
import { deterministicRewriter, standsAlone, type FollowUpRewriter, type Rewrite } from "./follow-up";
import { matchNibrsType, MEASURE_CODES } from "../nibrs-question-types";
import { AGE_BINS, planFromSpec } from "../nibrs-plan/from-spec";
import { DRAFT_LAYER, DRAFT_SEMANTIC_VERSION } from "../nibrs-plan/draft-layer";
import { agencyPopulationSql, compilePlan, type CompileTarget } from "../nibrs-plan/compile";
import { compare, rolling, windowMonths, type MonthCell } from "../nibrs-plan/transforms";
import { validateOutcome } from "../nibrs-plan/outcome";
import type { Filter, LimitationReason, NibrsPlan, Place } from "../nibrs-plan/plan";
import { resolvePeriod, type ReleaseInfo } from "../nibrs-plan/resolve";
import { validateBindings } from "../nibrs-plan/validate";
import { clearanceDims, type AnswerStatement } from "../nibrs-plan/result";
import { CATEGORY, deliver, deliverComparison, filterWords, LOSS_CODES, monthName, periodWords, PROPERTY_CODES, type Combined, type Delivered } from "./deliver";
import { agencyLabel, agencyName, candidateLabel, reportedBy, resolvePlace, type Candidate, type PlaceIndex, type PlaceResolution } from "./places";
import { answerPlaces } from "./places-answer";
import { answerSrs, isSrsMeasure, type SrsAnswer } from "./srs";
import { answerHistorical, historicalCounts, historicalUnitFits, isHistoricalMeasure, type HistoricalAnswer, type HistoricalBuild } from "./historical";
import { agencyHeaderSql, answerStateSum, universeStates, type StateSumMeta } from "./state-sum";

export type ShadowDeps = {
  places: PlaceIndex;
  release: ReleaseInfo & { id: string; asOf: string };
  target: CompileTarget;
  /** Runs one SQL statement read-only and returns its rows. */
  execute(sql: string): unknown[][];
  /** The Crime Index build (scripts/build-crimeindex.py): with it, agencies' Part I questions are Historical's answers; without it, routed. */
  historical?: HistoricalBuild;
  /** Set while checking that an offered question answers (offerable): its own declines get no next step of their own. */
  checkingOffer?: boolean;
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
};

/**
 * P74: the question without the parts the reader couldn't use, offered as "Ask instead: <question>" when the reader
 * reads all of it as a complete question. Only the reader decides (no data is read); the exact spans are removed; the
 * revised question is shown whole on the button and runs only when chosen (Codex plain-wording design check 2).
 */
function askInstead(question: string, parts: Part[], year: number): ShadowOption | null {
  const spans = parts.filter((p) => p.span && p.span[1] > p.span[0] && question.slice(p.span[0], p.span[1]).trim() === p.text.trim()).map((p) => p.span).sort((a, b) => b[0] - a[0]);
  if (!spans.length || spans.length !== parts.length) return null;
  let t = question;
  // A linking word the unread words ended with stays ("rolling over 12 months in" leaves "in": "murders in Detroit").
  for (const [a, b] of spans) t = `${t.slice(0, a)} ${/\b(in|for|of|from|during)\s*$/i.exec(question.slice(a, b))?.[1] ?? ""} ${t.slice(b)}`;
  t = t.replace(/\s+([,?.!])/g, "$1").replace(/,\s*,/g, ",").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
  // A joining word left dangling by the removal goes too ("in 2024 and in 2025" without "in 2025").
  t = t.replace(/\s+(?:and|or)(?=\s*[?.!]?$)/i, "").replace(/\s+(?:and|or)\s+(?:and|or)\s+/gi, " and ").trim();
  if (!t || t.toLowerCase() === question.trim().toLowerCase()) return null;
  const r = readQuestion(t, year);
  if (r.ledger.parts.some((p) => p.concept === "unrecognized" || p.state === "not-recorded") || matchNibrsType(r.ledger).kind !== "spec") return null;
  return { label: `Ask instead: "${t}"`, question: t };
}
/** A question the reader reads completely, every word, as a complete question (no data is read). */
function readsWhole(t: string, year: number): boolean {
  const r = readQuestion(t, year);
  return !r.ledger.parts.some((p) => p.concept === "unrecognized" || p.state === "not-recorded") && matchNibrsType(r.ledger).kind === "spec";
}
const tidy = (t: string) => t.replace(/\s+([,?.!])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,]+|[\s,]+$/g, "").trim();
/** The conditions the reader sets aside from its text (clearance, people, property...): a button must keep them. */
const CONDITIONS = ["clearance", "people", "property", "arrestsThrough", "consistent", "offenders", "composite", "quarter", "combined",
  "largeCities", "last12", "nibrsAsked", "shrDetail", "court", "forecast", "undefinedTerm"] as const;
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
  if (o.kind !== "decline" || o.notBuilt || deps.checkingOffer) return o;
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
  const offerable = (q: string | undefined) => {
    if (!q) return true;
    const got = named(q);
    if (![...asks].every((x) => got.has(x))) return false;
    const r = shadowAnswer(q, { ...deps, checkingOffer: true });
    return r.kind === "answer" || r.kind === "historical" || r.kind === "srs";
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
  const measure = text("measure"), place = text("place");
  if (measure && place) {
    const period = text("period") ?? `in ${Number(deps.release.lastMonth.slice(0, 4)) - (deps.release.lastMonth.endsWith("-12") ? 0 : 1)}`;
    const simple = tidy(`${measure} in ${place} ${/^(?:in|from|since|during)\b/i.test(period) ? period : `in ${period}`}`);
    // Compared with what the user typed (the reader's text may have dropped words it set aside, such as a column).
    if (simple.toLowerCase() !== asked.trim().replace(/[?.!]+$/, "").toLowerCase() && readsWhole(simple, year) && offerable(simple))
      return { ...o, alternative: { label: `Ask instead: "${simple}"`, question: simple } };
  }
  return /\bfor example\b/i.test(o.explanation) ? o : { ...o, explanation: `${o.explanation} ${EXAMPLE}` };
}
export type ShadowOutcome =
  /** `buttons`: continuations offered beside the answer (P61's consistent-reporters view). */
  | { kind: "answer"; plan: NibrsPlan; period: { from: string; to: string }; sql: string; delivered: Delivered; buttons?: ShadowOption[];
    /** A state or national sum (P61): agencies counted, coverage and the every-month view, per year (state-sum.ts). */
    stateSum?: StateSumMeta }
  /** A Part I figure for a state or the nation, read from the historical file (P53; srs.ts). */
  | SrsAnswer
  /** A Part I figure for one or several agencies, read from the Crime Index build (Historical, P75-P79; historical.ts). */
  | HistoricalAnswer
  /** A question another source answers (P53): the route is named; this NIBRS shadow does not run it. */
  | { kind: "route"; source: "rtci" | "shr" | "historical"; explanation: string }
  | { kind: "clarify"; about: string; question: string; options: ShadowOption[] }
  /** `detail`: an internal diagnostic (a compiler or validation reason) for logs; never shown (P74). */
  | { kind: "decline"; reason: LimitationReason | "reader"; explanation: string; alternative: ShadowOption | null; notBuilt?: boolean; detail?: string };

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
/** A whole-years version of a question finer than years, run now (its button never dead-ends). */
function byYearInstead(ledger: RequestLedger, deps: ShadowDeps, pins: Map<number, Candidate>): ShadowOption | null {
  const o = fromLedger(filled(ledger, "grain", "year", "by year"), deps, pins);
  return o.kind === "decline" ? null : { label: "By year instead", continuation: o };
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
  const ledger = readQuestion(question, Number(deps.release.lastMonth.slice(0, 4)), deps.release.lastMonth).ledger;
  return withNextStep(fromLedger(ledger, deps), ledger, deps, question);
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
  // A turn that stands on its own (its own crime and place, nothing pointing back) is a new question: answered as a
  // first question would be, the previous turn ignored (Jeff 2026-11-01). When the rules would have read it as a
  // follow-up meaning something else, that reading is offered as a button, run only when chosen.
  if (standsAlone(followUp)) {
    const o = shadowAnswer(followUp, deps);
    const r0 = deterministicRewriter.rewrite(previous, followUp);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    // A new question with no period of its own, after a question with one, may have meant that period (real turns:
    // "murder count in richmond" after "richmond virginia murders 2020-2025"): offered, never assumed.
    const year = Number(deps.release.lastMonth.slice(0, 4));
    const prevPeriod = readQuestion(previous, year).ledger.parts.find((p) => p.clause === 0 && p.concept === "period" && p.state === "recognized")?.text.trim();
    const ownPeriod = readQuestion(followUp, year).ledger.parts.some((p) => p.clause === 0 && p.concept === "period" && p.state === "recognized");
    const withPeriod = !ownPeriod && prevPeriod ? `${followUp.trim().replace(/[?.!]+$/, "")} ${prevPeriod}` : null;
    const other = r0.kind === "rewrite" && norm(r0.question) !== norm(followUp) ? r0.question : withPeriod;
    const offer: ShadowOption | null = other ? { label: `Did you mean a follow-up to your last question? "${other}"`, question: other } : null;
    const withOffer = !offer ? o : o.kind === "answer" ? { ...o, buttons: [...(o.buttons ?? []), offer] }
      : o.kind === "clarify" ? { ...o, options: [offer, ...o.options] } : o.kind === "decline" && !o.alternative ? { ...o, alternative: offer } : o;
    return { ...withOffer, rewrite: followUp, rewriteKind: "new" };
  }
  const r = rewriter.rewrite(previous, followUp);
  // A proposal returns before anything runs.
  if (r.kind === "propose") return { kind: "proposal", question: followUp, proposed: r.question, how: r.how, rewrite: r.question, rewriteKind: "propose" };
  if (r.kind === "ask") {
    // P69: uncertain, so ask; each option is a complete question, run as a new one. With none, the user rephrases. An
    // option is offered only when the reader reads it whole (Codex decline review 01: "...victims with a female offender"
    // is two counting units).
    const offered = r.options.filter((o) => readsWhole(o.question, Number(deps.release.lastMonth.slice(0, 4))));
    const options: ShadowOption[] = offered.length ? offered.map((o) => ({ label: o.label, continuation: shadowAnswer(o.question, deps) }))
      : [{ label: "Ask the full question", entry: "the full question" }, { label: "Start over", entry: "a new question" }];
    return { kind: "clarify", about: r.why, question: followUp, options, rewrite: null, rewriteKind: "ask" };
  }
  return { ...shadowAnswer(r.question, deps), rewrite: r.question, rewriteKind: r.kind, ...(r.kind === "presentation" ? { presentation: true as const } : {}) };
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
};
/** P31's weapons, as the reader writes them. */
const WEAPON_CODES: Record<string, string[]> = { firearm: ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"], knife: ["20"] };
/** P29/P49: "by men and women" (both sexes) names the offenders' sexes. */
const BY_SEXES = /\bby\s+(?:(?:males?|men)\s+(?:or|and|vs\.?|versus)\s+(?:females?|women)|(?:females?|women)\s+(?:or|and|vs\.?|versus)\s+(?:males?|men))\b/i;
const FORECAST_SENTENCE = "The data records past crime and cannot predict the future.";

/** P01: crimes whose completed years are Historical's and whose current year is Current Trends'; NIBRS answers their details. */
const PART_ONE = new Set(["murder", "homicide", "rape", "robbery", "aggravated_assault", "burglary", "theft", "motor_vehicle_theft", "arson", "violent_crime", "property_crime"]);

/**
 * Crime Index totals with no NIBRS measure: a month, quarter or part-year question about them has no source yet (the
 * Crime Index builds are annual). Every other Part I crime asked by month goes to NIBRS, whose grain is monthly
 * (coordinator 2026-11-02: route by the sources' grain; never an annual-only source for months).
 */
const ANNUAL_ONLY = new Set(["violent_crime", "property_crime"]);
const wholeYear = (s: { from: string; to: string }) => s.from.endsWith("-01") && s.to.endsWith("-12");
/** A question finer than whole years: a month or quarter grain, or a comparison of part years. */
const partYear = (sp: { grain: string }, cmp: { earlier: { from: string; to: string }; later: { from: string; to: string } } | null | undefined) =>
  (sp.grain !== "total" && sp.grain !== "year") || (!!cmp && !(wholeYear(cmp.earlier) && wholeYear(cmp.later)));

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
  if (term) {
    // P83: gun crime is offered in withNextStep, from the words asked (the reader's text has set conditions aside).
    return decline("not_recorded_in_nibrs", UNDEFINED_TERM[term]);
  }
  // P29: "by <group>" asks about offenders. "By men and women" is answered by the offenders' sexes (P49, below); any
  // other group (one sex, juveniles) is declined, never answered as victims.
  const bySexes = !!flags(ledger0).offenders && BY_SEXES.test(ledger0.question);
  if (flags(ledger0).offenders && !bySexes) return decline("unsupported_capability", "\"By\" a group of people means the offenders. Only \"by men and women\" (the offenders' sexes) is available yet.");
  if (unrecorded.length) {
    const why = unrecorded.map((p) => p.explanation ?? `"${p.text}" is not recorded.`).join(" ");
    // P74: in plain words, with the question without those words when it can be answered.
    return decline(readerReason(why), plainReaderExplanation(why), { alternative: askInstead(ledger0.question, unrecorded, Number(deps.release.lastMonth.slice(0, 4))), detail: why });
  }
  // Increment 7: words policy asks about, a button per reading (P30 "young adults", P44 "attackers"), the rest of the
  // question kept (P22).
  const ppl0 = flags(ledger0).people;
  if (ppl0?.unsupported) return decline("unsupported_capability", `This isn't available yet: ${ppl0.unsupported} (an arrest lists the person arrested, not the victim). I haven't answered with the arrestees' instead.`);
  if (ppl0?.ask === "young adults") {
    const ages = (lo: number, hi: number): ShadowOption => ({ label: `${lo} to ${hi}`,
      continuation: fromLedger(Object.assign(withParts(ledger0, ledger0.parts), { people: { ...ppl0, ask: null, where: [...ppl0.where, { who: "offender", attr: "age", range: [lo, hi], paired: false }] } }), deps, pins) });
    return { kind: "clarify", about: "which ages \"young adults\" means", question: ledger0.question, options: [ages(18, 24), ages(18, 29)] };
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
    // Each button runs now (coordinator 2026-11-02: never a button that can't run). A choice that would only be declined
    // is not offered; when none would answer, the first choice's decline is given, with its nearest question.
    const kinds = [{ label: "Violent crime", measures: [["violent_crime", "violent crime"]] }, { label: "Property crime", measures: [["property_crime", "property crime"]] },
      { label: "Both", measures: [["violent_crime", "violent crime"], ["property_crime", "property crime"]] }];
    const options = kinds.map((k) => ({ label: k.label, continuation: fromLedger(filledAll(ledger, "measure", k.measures), deps, pins) }));
    const runnable = options.filter((o) => o.continuation.kind !== "decline");
    if (!runnable.length) {
      const d0 = options[0].continuation;
      return partYear({ grain: clause0("grain")[0]?.value ?? "total" }, flags(ledger0).comparison)
        ? decline("unsupported_capability", "Violent and property crime totals are whole years only.", { alternative: byYearInstead(ledger, deps, pins) })
        : d0;
    }
    return { kind: "clarify", about: "which kind of crime", question: ledger0.question, options: runnable };
  }
  if (!clause0("place").length) {
    return { kind: "clarify", about: "which place", question: ledger0.question, options: [
      { label: "The United States", continuation: fromLedger(filled(ledger, "place", "national", "the United States"), deps, pins) },
      { label: "A state", entry: "which state" }, { label: "A city or agency", entry: "which city or agency" }] };
  }
  // P53: murders by a Homicide Report detail for a state or the nation are Homicide Reports' (named, not run here).
  const geoOnly = (ps: Part[]) => ps.length > 0 && ps.every((p) => p.value === "national" || /^state:/.test(p.value ?? ""));
  if (flags(ledger0).shrDetail && geoOnly(clause0("place")) && !flags(ledger0).nibrsAsked)
    return { kind: "route", source: "shr", explanation: "Murders by victim-offender relationship come from Homicide Reports (FBI SHR), which count the homicides agencies reported to the SHR, not a complete national estimate. Homicide Reports aren't available here yet." };
  const d = matchNibrsType(ledger);
  if (d.kind === "none") return decline("reader", "I couldn't tell what this question asks for. Try naming a crime, a place and a year, for example \"robberies in Denver in 2024\".");
  // P74: the reader's refusal in plain words, with the question without the words it couldn't use when that reads.
  if (d.kind === "decline") return decline(readerReason(d.explanation), plainReaderExplanation(d.explanation),
    { alternative: askInstead(ledger.question, d.parts, Number(deps.release.lastMonth.slice(0, 4))), detail: d.explanation });
  if (d.kind === "clarify") return decline("reader", d.explanation);
  // P53 (increment 5): a Part I offense for a state or the nation is the historical file's in a completed year
  // (FBI SRS), Current Trends' this year; unless NIBRS is asked for in words (P01). Its clearance rate is the
  // historical clearances' for the nation (P57) and declined for a state (P18).
  // An every-month cohort (P61's button, typed) keeps the question in NIBRS: the historical file has no cohorts.
  if (d.spec.type === "series" && !flags(ledger0).nibrsAsked && !flags(ledger0).consistent && !flags(ledger0).property && !flags(ledger0).clearance && !flags(ledger0).people) {
    const sp = d.spec;
    const geo = sp.places.length === 1 && (sp.places[0].kind === "state" || sp.places[0].kind === "national") ? sp.places[0] : null;
    const details = ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept))
      || (sp.statistic !== "clearance_rate" && ledger.parts.some((p) => p.clause === 0 && p.concept === "clearance"));
    const yrs = sp.period.form === "year" ? [sp.period.year, sp.period.year] : sp.period.form === "range" ? [sp.period.from, sp.period.to] : null;
    // The file's own unit only (offenses; victims for murder, rape, assault): incidents are another quantity (Codex
    // increment-5 review 2.3) and stay with P01's decline.
    if (geo && yrs && sp.measures.length === 1 && isSrsMeasure(sp.measures[0]) && !sp.filters.length && !details && (sp.unit === null || ["offenses", "victims"].includes(sp.unit))
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
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measures[0].replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here yet.` };
      // A span reaching this year: its completed years from the file, this year named as Current Trends' (P14: never
      // spliced in; review 2.6).
      const reachesNow = yrs[1] === thisYear && sp.statistic !== "clearance_rate";
      const r = answerSrs({ measure: sp.measures[0], place: geo.kind === "state" ? { kind: "state", code: geo.code } : { kind: "national" }, from: yrs[0], to: reachesNow ? thisYear - 1 : yrs[1],
        byYear: sp.grain === "year", statistic: sp.statistic,
        comparison: cmp ? { earlier: Number(cmp.earlier.from.slice(0, 4)), later: Number(cmp.later.from.slice(0, 4)) } : null,
        notes: reachesNow ? [`${thisYear} is this year: its figures come from Current Trends (Crime Index) and are not included here.`] : [] });
      if (r.kind === "srs") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : /no state clearance rate/.test(r.explanation) ? "not_recorded_in_nibrs" : "unsupported_capability", r.explanation);
    }
  }
  // Historical (P75-P79): a Part I offense for one or several named agencies in completed years is the Crime Index
  // build's: its count, its published rate (P75) or its published clearance percentage (P57), by year or a change;
  // unless NIBRS is asked for in words (P01). Only the plain figure: a restriction the file cannot apply (a property
  // condition, a cohort, people, a breakdown or filter) keeps the question with NIBRS's limits, never dropped.
  if (deps.historical && d.spec.type === "series" && !flags(ledger0).nibrsAsked && !flags(ledger0).consistent && !flags(ledger0).property
    && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).arrestsThrough && !flags(ledger0).composite) {
    const sp = d.spec;
    const agencies = sp.places.map((p) => (p.kind === "agency" ? resolved.get(`${p.agencyKind}:${p.name}:${p.state}`) : undefined));
    const details = ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept))
      || (sp.statistic !== "clearance_rate" && ledger.parts.some((p) => p.clause === 0 && p.concept === "clearance"));
    const yrs = sp.period.form === "year" ? [sp.period.year, sp.period.year] : sp.period.form === "range" ? [sp.period.from, sp.period.to] : null;
    const historicalShape = agencies.length && agencies.every((a) => a?.kind === "agency") && yrs && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0]) && !sp.filters.length && !details
      && (sp.statistic === "count" || sp.statistic === "rate");
    // The crime counted in the other of its two units ("robbery victims"): said plainly, with NIBRS's count of that unit
    // offered. Arrests, offenders and incidents are NIBRS's own counts and go on to it.
    if (historicalShape && (sp.unit === "victims" || sp.unit === "offenses") && !historicalUnitFits(sp.measures[0], sp.unit)) {
      const withNibrs = `${ledger0.question.replace(/[?.!\s]+$/, "")} according to NIBRS`;
      return decline("unsupported_capability", `Historical counts ${historicalCounts(sp.measures[0])}, not ${sp.unit}. NIBRS counts ${sp.unit} for the agencies that report to it.`,
        { alternative: { label: `Ask instead: "${withNibrs}"`, question: withNibrs } });
    }
    if (agencies.length && agencies.every((a) => a?.kind === "agency") && yrs && sp.measures.length === 1 && isHistoricalMeasure(sp.measures[0]) && !sp.filters.length && !details
      && historicalUnitFits(sp.measures[0], sp.unit) && (sp.statistic === "count" || sp.statistic === "rate" || sp.statistic === "clearance_rate")
      && !(partYear(sp, flags(ledger0).comparison) && !ANNUAL_ONLY.has(sp.measures[0]))) {
      // Codex review 01.2: the file has no cohort to combine agencies with (design note 2): asked, it is declined.
      if (flags(ledger0).combined && agencies.length > 1) {
        const apart = ledger0.question.replace(/\s*,?\s*\b(?:combined|together|as one total)\b/i, "").replace(/[?.!\s]+$/, "");
        return decline("unsupported_capability", "Historical figures can't be combined across agencies yet. Ask for each agency; they are shown side by side.",
          { alternative: { label: `Ask instead: "${apart}"`, question: apart } });
      }
      const cmp = flags(ledger0).comparison;
      if (partYear(sp, cmp))
        return decline("unsupported_capability", `${sp.measures[0] === "violent_crime" ? "Violent" : "Property"} crime totals are whole years only.`, { alternative: byYearInstead(ledger, deps, pins) });
      const thisYear = Number(release.lastMonth.slice(0, 4));
      if (yrs[1] > thisYear) return decline("outside_release_coverage", `${yrs[1]} is not in the data; the latest year is ${thisYear}.`);
      if (yrs[0] === thisYear && sp.statistic !== "clearance_rate")
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measures[0].replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here yet.` };
      // A span reaching this year: its completed years from the build, this year named as Current Trends' (P14).
      const reachesNow = yrs[1] === thisYear && sp.statistic !== "clearance_rate";
      const list = agencies as Extract<Place, { kind: "agency" }>[];
      const r = answerHistorical({ measure: sp.measures[0], agencies: list.map((a, i) => ({ ori: a.ori, label: a.label, name: (sp.places[i] as { name: string }).name, state: (sp.places[i] as { state: string }).state })),
        from: yrs[0], to: reachesNow ? thisYear - 1 : yrs[1], byYear: sp.grain === "year", statistic: sp.statistic,
        comparison: cmp ? { earlier: Number(cmp.earlier.from.slice(0, 4)), later: Number(cmp.later.from.slice(0, 4)) } : null,
        notes: reachesNow ? [`${thisYear} is this year: its figures come from Current Trends (Crime Index) and are not included here.`] : [],
        agencyLine: reportedBy(list.map((a) => agencyName(deps.places, a.ori))).replace(/^Reported by /, "Figures for ") }, deps.historical, deps.execute);
      if (r.kind === "historical") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
    }
  }
  // The reader's own change form ("how did burglaries in Memphis change from 2010 to 2020") for one agency: the same
  // Historical answer as "<crime> in <agency>, <earlier> against <later>" (P54, P55).
  if (deps.historical && d.spec.type === "change" && d.spec.statistic === "count" && !flags(ledger0).nibrsAsked && !flags(ledger0).consistent
    && !flags(ledger0).property && !flags(ledger0).clearance && !flags(ledger0).people && !flags(ledger0).composite && d.spec.place.kind === "agency"
    && isHistoricalMeasure(d.spec.measure) && historicalUnitFits(d.spec.measure, d.spec.unit)
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept))) {
    const sp = d.spec, pl = sp.place as Extract<typeof sp.place, { kind: "agency" }>;
    const a = resolved.get(`${pl.agencyKind}:${pl.name}:${pl.state}`);
    const thisYear = Number(release.lastMonth.slice(0, 4));
    if (a?.kind === "agency") {
      if (sp.later > thisYear) return decline("outside_release_coverage", `${sp.later} is not in the data; the latest year is ${thisYear}.`);
      if (sp.later === thisYear)
        return { kind: "route", source: "rtci", explanation: `This year's ${sp.measure.replace(/_/g, " ")} figures come from Current Trends (Crime Index), through the latest reported month, for the agencies it covers. Current Trends isn't available here yet.` };
      const r = answerHistorical({ measure: sp.measure, agencies: [{ ori: a.ori, label: a.label, name: pl.name, state: pl.state }], from: sp.earlier, to: sp.later, byYear: false,
        statistic: "count", comparison: { earlier: sp.earlier, later: sp.later },
        agencyLine: reportedBy([agencyName(deps.places, a.ori)]).replace(/^Reported by /, "Figures for ") }, deps.historical, deps.execute);
      if (r.kind === "historical") return r;
      return decline(/outside them/.test(r.explanation) ? "outside_release_coverage" : "unsupported_capability", r.explanation);
    }
  }
  // P57 (increment 6): a Part I offense's clearance rate for an agency in a completed year is the historical
  // clearances' (FBI SRS, Return A), not computed from NIBRS. Without the Crime Index build, the route is named.
  // Only the plain rate: a restriction the historical figures cannot apply (a property condition, a cohort, a
  // breakdown or filter) is never dropped by the route (Codex increment-6 review 02.1).
  const plainRate = !flags(ledger0).people && !flags(ledger0).property && !flags(ledger0).clearance && !flags(ledger0).arrestsThrough && !flags(ledger0).consistent && !flags(ledger0).composite
    && !ledger.parts.some((p) => p.clause === 0 && ["clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  if (d.spec.type === "series" && d.spec.statistic === "clearance_rate" && !flags(ledger0).nibrsAsked && d.spec.places.length === 1 && d.spec.places[0].kind === "agency"
    && d.spec.measures.length === 1 && isSrsMeasure(d.spec.measures[0]) && !d.spec.filters.length && plainRate) {
    const p = d.spec.period, last = p.form === "year" ? p.year : p.form === "range" ? p.to : null;
    if (last !== null && last < Number(release.lastMonth.slice(0, 4)))
      return { kind: "route", source: "historical", explanation: `The ${d.spec.measures[0].replace(/_/g, " ")} clearance rate of an agency for a completed year comes from Historical (the FBI's SRS clearances, as the agency reported them), not computed from NIBRS. Historical isn't available here yet.` };
  }
  // A clearance rate for a state or the nation that is not a Part I offense's (P57): a state has none (P18); the method
  // for a NIBRS-only offense is not decided (P57).
  if (d.spec.type === "series" && d.spec.statistic === "clearance_rate" && d.spec.places.length === 1 && (d.spec.places[0].kind === "state" || d.spec.places[0].kind === "national"))
    return decline("not_recorded_in_nibrs", d.spec.places[0].kind === "state"
      ? "There is no state clearance rate in the data (the FBI publishes clearance for agencies and the nation, not states), and how to compute a clearance rate for a NIBRS-only offense is not yet decided."
      : "How to compute a national clearance rate for a NIBRS-only offense is not yet decided.");
  // P01: a standard (Part I) crime's count is Historical's (completed years) or Current Trends' (this year), not this
  // NIBRS shadow's; it is declined rather than answered from the wrong source.
  // Only a plain count of the crime: its details (a weapon, arrests, clearances, a breakdown) are NIBRS's, and go on to
  // the slice's own limits.
  // The reader's own change form ("did X increase from 2022 to 2023") is a plain count compared, under the same rule.
  const plainUnit = (u: string | null) => u === null || ["offenses", "victims", "incidents"].includes(u);
  const noDetail = !flags(ledger0).people && !flags(ledger0).property && !flags(ledger0).clearance && !ledger.parts.some((p) => p.clause === 0 && ["clearance", "clearance-reason", "breakdown", "filter", "share"].includes(p.concept));
  const asked = flags(ledger0).composite || !noDetail ? []
    : d.spec.type === "series" && !d.spec.filters.length && plainUnit(d.spec.unit) ? d.spec.measures
    : d.spec.type === "change" && d.spec.statistic === "count" && plainUnit(d.spec.unit) ? [d.spec.measure] : [];
  // P01, in plain words (P74): the official counts are Historical's and Current Trends'; NIBRS has them when asked by name.
  // A month, quarter or part-year question goes to NIBRS, the source with monthly grain (coordinator 2026-11-02); the
  // Crime Index builds are annual. (Current Trends, monthly too, is settled with Jeff when it is built.)
  const months = d.spec.type === "series" && partYear(d.spec, flags(ledger0).comparison);
  if (!flags(ledger0).nibrsAsked && !flags(ledger0).consistent && !months && asked.some((x) => PART_ONE.has(x))) {
    const withNibrs = `${ledger0.question.replace(/[?.!\s]+$/, "")} according to NIBRS`;
    // With the Crime Index build, Historical answers the plain counts above; what reaches here is a form it doesn't
    // answer yet (coordinator, 2026-11-01: never "not available here" when it is).
    return decline("unsupported_capability", deps.historical
      ? "The official counts of this crime come from Crime Index's Historical and Current Trends data, which don't answer this form of the question yet. NIBRS has its own counts, from the agencies that report to it."
      : "The official counts of this crime come from the Historical and Current Trends data, which aren't available here yet. NIBRS has its own counts, from the agencies that report to it.",
      { alternative: { label: `Ask instead: "${withNibrs}"`, question: withNibrs } });
  }

  // The plan.
  const a = planFromSpec(d.spec, ledger, { semanticVersion: DRAFT_SEMANTIC_VERSION, resolvePlace: (v) => resolved.get(v) ?? null });
  if (a.kind === "unmapped") return notYet(`no plan form: ${a.reason}`);
  const plan = a.plan;
  // Increment 6: "where a firearm was stolen": the incident has one property segment with that description and loss
  // type (one segment, so a stolen television and a recovered firearm never match; incident-level, N2).
  const prop = flags(ledger0).property;
  if (prop) {
    const d = PROPERTY_CODES[prop.what], loss = LOSS_CODES[prop.loss];
    if (!d || !loss) return decline("unsupported_capability", `This isn't available yet: this property condition (${prop.what} ${prop.loss}).`);
    plan.filters.push({ kind: "exists", scope: "incident", entity: "property", attribution: "incident_level_only",
      where: [{ kind: "attribute", dimension: "property.loss_type", op: "in", values: [loss] }, { kind: "attribute", dimension: "property.description", op: "in", values: d.codes }] });
  }
  // Increment 6: arrests reached through the incident (P50, P68): every arrest on an incident with the condition (a
  // property selection, or an offense of the incident), whatever its arrest offense; never all arrests.
  const thr = flags(ledger0).arrestsThrough;
  if (thr) {
    if (plan.measures.length !== 1 || plan.measures[0].id !== "arrests.all_crime") return decline("unsupported_capability", "This isn't available yet: arrests for incidents of this kind.");
    if (thr.offense) {
      const codes = MEASURE_CODES[thr.offense];
      if (!codes) return decline("unsupported_capability", `This isn't available yet: arrests for incidents with ${thr.offense.replace(/_/g, " ")}.`);
      plan.filters.push({ kind: "exists", scope: "incident", entity: "offense", where: [{ kind: "attribute", dimension: "offense.offense", op: "in", values: codes }] });
    }
    if (!plan.filters.some((f) => f.kind === "exists")) return decline("unsupported_capability", "This isn't available yet: arrests for incidents with no condition.");
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
    if (plan.measures.length !== 1) return decline("unsupported_capability", "This isn't available yet: a person's attributes for several crimes.");
    const unit = plan.measures[0].unit;
    const between = (dimension: string, r: [number, number]) => ({ kind: "attribute" as const, dimension, op: "between" as const, values: r });
    for (const w of ppl.where) {
      if (w.attr === "relationship") {
        if (unit !== "offender") return decline("unsupported_capability", "This isn't available yet: a relationship to the victim, for anything but offenders.");
        plan.filters.push({ kind: "exists", scope: "offender", entity: "victim_offender", where: [{ kind: "attribute", dimension: "victim_offender.relationship", op: "in", values: w.values }] });
      } else if (w.who === "victim") {
        if (unit !== "victim") return decline("unsupported_capability", "This isn't available yet: a victim's age for crimes counted by offense.");
        plan.filters.push(between("victim.age", w.range));
      } else if (w.who === "arrestee") {
        if (unit !== "arrest") return decline("unsupported_capability", "This isn't available yet: an arrestee's age for anything but arrests.");
        plan.filters.push(between("arrestee.age", w.range));
      } else if (w.paired) {
        if (unit !== "victim") return decline("unsupported_capability", "This isn't available yet: a linked offender's age for anything but victims.");
        plan.filters.push({ kind: "exists", scope: "victim", entity: "victim_offender", where: [between("victim_offender.offender_age", w.range)] });
      } else if (unit === "offender") plan.filters.push(between("offender.age", w.range));
      else if (unit === "victim" || unit === "offense") plan.filters.push({ kind: "exists", scope: "incident", entity: "offender", where: [between("offender.age", w.range)] });
      else return decline("unsupported_capability", "This isn't available yet: an offender's age for this kind of count.");
    }
    if (ppl.by) {
      const b = ppl.by;
      if (b.who === "arrestee" && unit !== "arrest") return decline("unsupported_capability", "This isn't available yet: an arrestee's attributes for anything but arrests.");
      if (b.paired && unit !== "victim") return decline("unsupported_capability", "This isn't available yet: the linked offenders' attributes for anything but victims.");
      if (b.who === "offender" && unit === "arrest") return decline("unsupported_capability", "This isn't available yet: offenders' attributes for arrests.");
      if (plan.groupings.some((g) => !g.dimension.startsWith("time."))) return decline("unsupported_capability", "This isn't available yet: a person's attribute beside another breakdown.");
      const dimension = b.paired ? `victim_offender.offender_${b.attr}` : `${b.who}.${b.attr}`;
      const multi = b.paired || (b.who === "offender" && unit !== "offender");
      plan.groupings.push({ dimension, unknown: "visible", absent: "show", ...(multi ? { multiValue: "each_value" as const } : {}), ...(b.attr === "age" ? { bins: AGE_BINS } : {}) });
      const m0 = plan.measures[0];
      plan.statistics = [{ kind: "count", as: plan.statistics[0].as, measure: m0.as }, { kind: "share", as: "share_of_period", measure: m0.as, within: plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension) }];
    }
  }
  // Places (increment 4): named agencies, separate or combined, and a state's city agencies for a ranking. State and
  // national totals are increment 5.
  const citySet = (p: Place) => p.kind === "agency_set" && p.within.kind === "state"
    && p.where.every((w) => (w.field === "agency.type" && JSON.stringify(w.value) === '["city"]') || w.field === "agency.population");
  // Increment 5: one state or the nation, summed over the agencies that reported (P61).
  const geoPlace = (p: Place) => p.kind === "state" || p.kind === "national";
  if (plan.geography.places.some((p) => p.kind !== "agency" && !citySet(p) && !geoPlace(p)) || ((plan.geography.places.some(citySet) || plan.geography.places.some(geoPlace)) && plan.geography.places.length > 1))
    return decline("unsupported_capability", "This isn't available yet: a state or the nation together with other places.");
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
  // Several names of one agency, combined, are that agency once (Codex 02 re-check B).
  if (flags(ledger0).combined && plan.geography.places.length > 1) plan.geography.combine = "combined";
  else if (flags(ledger0).combined && !flags(ledger0).composite && (namedPlaces.length <= 1 || plan.measures.length > 1))
    return decline("unsupported_capability", "I can combine the counts of several agencies, but not yet the counts of several crimes. Ask for each crime on its own, or for one crime in several places combined.");
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
    if (set0.kind !== "agency_set") return decline("unsupported_capability", "This isn't available yet: large cities outside a ranking of a state's cities.");
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
  const drugPart = clause0("measure").find((p) => p.value === "drug_possession" && !/possess/i.test(p.text));
  // Drug crimes beside other crimes would need a total inside a list: declined (Codex review 02).
  if (drugPart && plan.measures.length > 1) return decline("unsupported_capability", "This isn't available yet: drug crimes (drug and narcotic offenses plus drug equipment violations) beside other crimes.");
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
      return decline("unsupported_capability", "This isn't available yet: gun crime or stabbings beside other crimes, or in this form.");
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
    if (shared) return decline("unsupported_capability", "This isn't available yet: victims restricted by sex beside the offenders' sexes.");
    const kept = plan.filters.map((_, k) => k).filter((k) => !gone.has(k));
    plan.filters = kept.map((k) => plan.filters[k]);
    unbind((p) => sexParts.includes(p));
    // Bindings to the filters that stay follow them to their new places.
    plan.bindings = plan.bindings.map((b) => { const k = /^filters\[(\d+)\]/.exec(b.path); return k ? { ...b, path: b.path.replace(/^filters\[\d+\]/, `filters[${kept.indexOf(Number(k[1]))}]`) } : b; });
    if (plan.measures.length !== 1 || plan.groupings.some((g) => !g.dimension.startsWith("time."))) return decline("unsupported_capability", "This isn't available yet: offenders' sexes beside another breakdown or measure.");
    plan.groupings.push({ dimension: "offender.sex", unknown: "visible", absent: "show", multiValue: "each_value" });
    const m0 = plan.measures[0];
    plan.statistics = [{ kind: "count", as: plan.statistics[0].as, measure: m0.as }, { kind: "share", as: "share_of_period", measure: m0.as, within: plan.groupings.filter((g) => g.dimension.startsWith("time.")).map((g) => g.dimension) }];
  }
  // P50: arrests are placed by arrest date; arrests beside other measures would mix time bases (refused).
  const arrests = plan.measures.filter((m) => m.id.startsWith("arrests."));
  if (arrests.length && arrests.length !== plan.measures.length) return decline("unsupported_capability", "This isn't available yet: arrests beside other crimes (arrests are dated by the arrest, crimes by the incident).");
  if (arrests.length) {
    plan.timeBasis = "arrest_date";
    plan.defaults.push({ path: "timeBasis", value: "arrest_date", reason: "P50: arrests are counted by arrest date" });
  }

  // Time (increment 3). A comparison the reading recorded becomes the plan's period_comparison over the whole span;
  // "the last 12 months" is one total (P56). Either replaces the reader's time grouping.
  const cmpFlag = flags(ledger0).comparison ?? null;
  if (cmpFlag || flags(ledger0).last12) {
    if (plan.transforms.length) return decline("unsupported_capability", "This isn't available yet: this combination of time forms.");
    plan.groupings = plan.groupings.filter((g) => !g.dimension.startsWith("time."));
  }
  if (cmpFlag) {
    const st = plan.statistics[0];
    if (plan.measures.length !== 1 || plan.groupings.length || plan.statistics.length !== 1 || st.kind !== "count")
      return decline("unsupported_capability", "This isn't available yet: a change of several crimes, of a breakdown, or of a rate.");
    // The plan's period is the comparison's whole years, as the question's period part reads; the compared periods
    // carry any months (R2: they lie inside it).
    plan.period = { kind: "absolute", from: `${cmpFlag.earlier.from.slice(0, 4)}-01`, to: `${cmpFlag.later.to.slice(0, 4)}-12` };
    plan.transforms = [{ kind: "period_comparison", of: [st.as], earlier: { kind: "absolute", ...cmpFlag.earlier }, later: { kind: "absolute", ...cmpFlag.later }, outputs: ["earlier", "later", "change", "pct_change"] }];
  }
  const rollingT = plan.transforms.find((t) => t.kind === "rolling");
  if (rollingT && (plan.measures.length !== 1 || plan.transforms.length !== 1 || plan.statistics.length !== 1 || plan.statistics[0].kind !== "count"
    || plan.groupings.length !== 1 || plan.groupings[0].dimension !== "time.month"))
    return decline("unsupported_capability", "This isn't available yet: rolling windows of a rate, a breakdown, or several crimes.");
  if (plan.transforms.some((t) => t.kind !== "rolling" && t.kind !== "period_comparison" && !(t.kind === "rank" && plan.geography.places[0].kind === "agency_set")))
    return decline("unsupported_capability", "This isn't available yet: rankings.");
  // Increment 7b (P71): quarters are the sums of one agency's monthly counts of one crime.
  const quarterly = !!flags(ledger0).quarter;
  if (quarterly && (plan.measures.length !== 1 || plan.transforms.length || plan.statistics.length !== 1 || plan.statistics[0].kind !== "count"
    || plan.groupings.length !== 1 || plan.groupings[0].dimension !== "time.month" || plan.geography.places.length !== 1 || plan.geography.places[0].kind !== "agency"))
    return decline("unsupported_capability", "This isn't available yet: quarters of a rate, a breakdown, several crimes or several places.");

  // The slice delivers counts, as totals or by month or year: one measure optionally broken down by ONE delivered
  // category with each category's share of its period (compiler increments 1 and 2), or several measures side by side
  // (with their combined total, as totals only, for D19 and P31). Two-way breakdowns, rates and other shares are
  // declined before anything is asked or run.
  const timeG = plan.groupings.filter((g) => g.dimension.startsWith("time."));
  const catG = plan.groupings.filter((g) => !g.dimension.startsWith("time.") && !g.dimension.startsWith("geo."));
  // Several agencies, rates and rankings take the places path (increment 4).
  const stateMode = plan.geography.places[0].kind === "state" || plan.geography.places[0].kind === "national";
  // P29: an offender or arrestee breakdown that is not built is declined with that reason, never answered as victims.
  if (stateMode && ppl?.by)
    return decline("unsupported_capability", `${ppl.by.who === "arrestee" ? "Arrestee" : "Offender"} breakdowns for a whole state or the nation aren't available yet; they are for one agency or several named agencies.`);
  if (stateMode && (plan.measures.length > 1 || catG.length || plan.transforms.length || plan.statistics.length > 1 || !(plan.statistics[0].kind === "count" || plan.statistics[0].kind === "rate")))
    return decline("unsupported_capability", "This isn't available yet: a state or national sum of several crimes, a breakdown, a change or a ranking.");
  const placesMode = !stateMode && (plan.geography.places.length > 1 || plan.geography.places[0].kind === "agency_set" || plan.statistics.some((x) => x.kind === "rate"));
  if (placesMode && (plan.measures.length > 1 || catG.length || plan.transforms.some((t) => t.kind !== "rank")))
    return decline("unsupported_capability", "This isn't available yet: several agencies or rates with several crimes, a breakdown, a change or rolling windows.");
  const [first, second, ...more] = plan.statistics;
  const counts = plan.statistics.every((s) => s.kind === "count") && plan.measures.every((m) => plan.statistics.filter((s) => "measure" in s && s.measure === m.as).length === 1);
  const several = plan.measures.length > 1;
  const shareOk = !second || several || (second.kind === "share" && first.kind === "count" && catG.length === 1 && second.measure === first.measure && !second.denominator
    && JSON.stringify(second.within) === JSON.stringify(timeG.map((g) => g.dimension)));
  if (catG.length > 1 || catG.some((g) => !CATEGORY[g.dimension]) || (first.kind !== "count" && !((placesMode || stateMode) && first.kind === "rate")) || (!several && more.length) || !shareOk
    || (several && (catG.length || !counts)) || (combined && timeG.length))
    return decline("unsupported_capability", "This isn't available yet: this breakdown (by two things at once, several crimes broken down, or a combined total by period), or this rate or share.");

  // P66 (Jeff 2026-10-30): a clearance answer gives the number of incidents beside its count: the crime's incidents,
  // with the same groupings and filters, as a second count. One agency only for now.
  if (clearanceDims(plan).length && plan.measures[0].unit !== "incident") {
    if (stateMode || placesMode || cmpFlag || rollingT || several)
      return decline("unsupported_capability", "This isn't available yet: clearance for a state, the nation or several agencies, for several crimes, or as a change or rolling windows.");
    plan.statistics.splice(1, 0, { kind: "incidents", as: `${plan.measures[0].as}_incidents`, measure: plan.measures[0].as });
  }
  // Increment 6: the share cleared (P64, P66): the cleared units (with their incidents) over all units of the period,
  // each counted independently, for one total.
  if (clr?.share) {
    if (timeG.length || catG.length || clr.by) return decline("unsupported_capability", "This isn't available yet: the share cleared by period or by category; ask for one period.");
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
  } catch (e) { return notYet(String(e)); }
  if (period.from > release.lastMonth) {
    const y = release.lastMonth.slice(0, 4);
    return decline("outside_release_coverage", `${periodWords(period.from, period.to)} is not in the data; the latest month available is ${monthName(release.lastMonth)}.`,
      { alternative: { label: `This year so far (${periodWordsShort(`${y}-01`, release.lastMonth)})`, continuation: fromLedger(filled(ledger, "period", `year:${y}`, "this year so far"), deps, pins) } });
  }
  if (period.from < release.firstMonth) {
    return decline("outside_release_coverage", `The data here covers ${monthName(release.firstMonth)} through ${monthName(release.lastMonth)}, so it doesn't include ${periodWords(period.from, period.to)}.`, { notBuilt: true });
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
  if (column === "both") return decline("unsupported_capability", "This isn't available yet: the population and the agencies reporting together; ask for one of them.");
  if (column === "population") {
    const r = checked.statistics.find((s) => s.kind === "rate");
    if (!r) return decline("unsupported_capability", "A population column goes with a rate; this answer has no rate.");
    checked = { ...checked, statistics: [...checked.statistics, { kind: "population", as: "population", of: r.as }] };
  } else if (column === "agencies") {
    const s0 = checked.statistics[0];
    if (!stateMode || !("measure" in s0)) return decline("unsupported_capability", "The number of agencies reporting goes with a state or national total.");
    checked = { ...checked, statistics: [...checked.statistics, { kind: "agencies", as: "agencies", measure: s0.measure }] };
  }

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
  if (unnamed) return decline("unsupported_capability", "This isn't available yet: this weapon or relationship selection.");
  const notes0 = [...(flags(ledger0).readings ?? []).filter((x) => x.kind === "spelling").map(readingSentence),
    // P84 (Jeff 2026-11-01): how the phrase was read.
    ...(/\b(?:car|vehicle|auto|automobile|truck)\s+break[-\s]?ins?\b/i.test(ledger0.question) ? ["Car break-ins are counted as theft from motor vehicles."] : [])];
  if (stateMode) return answerStateSum(checked, period, yearSet, deps, statements, notes0, !!flags(ledger0).consistent, (why, detail) => decline("unsupported_capability", why, { detail }));
  if (placesMode) return answerPlaces(checked, period, deps, statements, notes0, (why, detail) => decline("unsupported_capability", why, { detail }));
  // The place is the title; the next line names who reported the figures by the FBI's name (Jeff 2026-10-30).
  const reported = (d: Delivered): Delivered => {
    const p = checked.geography.places[0];
    if (p.kind !== "agency") return d;
    // After the title: the first line naming the place (a definition may come before it).
    const at = d.text.findIndex((t) => t.startsWith(p.label)) + 1 || 1;
    return { ...d, text: [...d.text.slice(0, at), reportedBy([agencyName(deps.places, p.ori)]), ...d.text.slice(at)] };
  };
  // P71 (Jeff 2026-10-31: "Add up months"): each quarter the sum of its three months; a quarter in which the agency did
  // not report all three months (or that runs past the data) is marked incomplete, never shown as a whole quarter.
  if (quarterly) {
    // Only whole quarters of one continuous period: a set of years, or a period starting or ending inside a quarter,
    // would be widened to months not asked for (Codex 7b-04.3).
    const qEdge = (ym: string, end: boolean) => (Number(ym.slice(5, 7)) - (end ? 0 : 1)) % 3 === 0;
    if (yearSet || !qEdge(period.from, false) || !qEdge(requestedTo, true))
      return decline("unsupported_capability", "This isn't available yet: quarters of a set of years, or of a period that starts or ends inside a quarter; ask for whole quarters or whole years.");
    const qStart = (ym: string) => `${ym.slice(0, 4)}-${String(Math.floor((Number(ym.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, "0")}`;
    const from = qStart(period.from), toQ = addMonths(qStart(period.to), 2);
    const to = toQ > release.lastMonth ? release.lastMonth : toQ;
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
    const delivered = deliver(checked, period, requestedTo, ["period", as, `${as}_status`], windows.map((w) => [w.ym, w.value, w.status]), statements, release.id, notes0, null,
      { rolling: { months, missing: cells.filter((x) => x.status !== "VALUE" && x.status !== "REPORTED_ZERO").map((x) => x.ym) } });
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
    if (got.length !== rows.length || byKey.size !== got.length || rows.some((r) => !byKey.has(keyOf(r, kRows)))) return decline("unsupported_capability", "This isn't available yet: measures whose periods or categories do not line up.");
    const stat = c.query.columns.map((_, i) => (kGot.includes(i) ? -1 : i)).filter((i) => i >= 0);
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
