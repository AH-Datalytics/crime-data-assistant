import {
  buildQueryContract,
  requestWindowGrain,
  type AmendedRequestState,
  type QueryContract,
  type QueryContractGeography,
  type RequestField,
  type RequestFieldOrigin,
  type RequestWindow,
} from "./query-contract";
import { OFFENSE_NOUN_RE } from "./query-bearing-followup";
import { detectCompletenessQuestion } from "./completeness-intent";
import { normalizeHistoryWithSource, type SourceTaggedMessage } from "./chat-history";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { detectRequestedGrain } from "./requested-grain";

/**
 * GC-070 — an explicit amendment, carried onto the request it amends, as a CONTRACT.
 *
 * THE CONVERSATION. A rolling-12 national murder series, then "show me by per capita", then a
 * place change, then "range", then two more place changes. Every one of those follow-ups was
 * `not_followup` with a null transform, so from the third turn the route handed the contract and
 * the guardrails a bare fragment and nothing could see the measure the reader had established.
 *
 * WHAT CHANGED FROM THE EARLIER VERSIONS. They composed a SENTENCE and let each consumer parse it
 * again. Text consumption and field construction were then two operations that could disagree:
 * both "counts" and "rates" were consumed while one unit was kept, and "by month and by year" became
 * monthly. This version builds the effective request as the existing `QueryContract`, field by
 * field, with where each field came from, and the route hands that object to the validator and to
 * proof finalization. A sentence is still rendered — for the model and for the route's text-only
 * guardrails — but it is rendered FROM the contract and must read back to the same fields, or this
 * path declines.
 *
 * THE RULES, PER FIELD (offense, unit, window, geography, period).
 *   - A turn REPLACES a field only when its own words state it. A parser default is not a
 *     statement: "now robberies" is parsed with unit `count`, and that must not undo "per capita".
 *   - Two values for one field in one turn is a competing value, and this single-output path
 *     declines rather than choosing one.
 *   - A turn that cannot be read — a year the parser cannot read, or a word with more than one
 *     plausible meaning — leaves an OPEN QUESTION. Each one is kept on its own until the reader
 *     answers it. An unreadable year is answered by a stated year. A turn like "range" does not say
 *     which field it is about, so it is not guessed to be one: it is answered only by the reader's
 *     reply to the question this path asked about it.
 *
 * WHAT IT WILL NOT DO.
 *   - It never reads a field out of the assistant's prose or SQL. It reads assistant turns for one
 *     thing only: whether this path's own question was put to the reader.
 *   - It never reaches past the history it was given, and a turn from another tab is a boundary.
 *   - It is a bounded Current-series path, not a conversation engine and not a session store.
 */

export type AmendmentField = RequestField;

/** An unresolved turn, kept until the reader answers it. */
export type OpenQuestion = {
  kind: "malformed-year" | "ambiguous-amendment";
  /** The turn that could not be resolved, quoted back to the reader. */
  turn: string;
};

export type AmendmentResolution =
  | {
      kind: "composed";
      /** The full user request the composition starts from, exactly as they wrote it. */
      anchor: string;
      applied: Array<{ turn: string; fields: AmendmentField[] }>;
      /** The effective request. Its `request` field says where each value came from. */
      contract: QueryContract & { request: AmendedRequestState };
      /** A rendering of `contract`, verified to read back to the same fields. */
      effectiveQuestion: string;
      transform: { name: "compose_current_amendment"; contextQuestion: string; instruction: string };
    }
  | {
      kind: "clarify";
      reason: OpenQuestion["kind"];
      /** The earliest open question's turn: the one this reply asks about. */
      unresolvedTurn: string;
      /** Every open question, in the order the reader created them. None is dropped. */
      openQuestions: OpenQuestion[];
      question: string;
    }
  | { kind: "none"; reason: string };

/**
 * The questions this path asks. Each quotes the turn and carries a phrase this module looks for
 * when deciding whether the reader's next turn is a reply to it.
 */
export const CURRENT_AMENDMENT_CLARIFICATIONS: Record<OpenQuestion["kind"], (turn: string) => string> = {
  "malformed-year": (turn) =>
    `I could not read a year in "${turn.trim()}". Which year did you mean? I would rather ask than `
    + `guess, because guessing one digit wrong changes the answer.`,
  "ambiguous-amendment": (turn) =>
    `"${turn.trim()}" could mean more than one thing here, and I do not want to pick for you. Did `
    + `you mean the years the data covers, or a change to the series we were looking at? Tell me `
    + `which and I will carry the rest of your request forward.`,
};
const CLARIFICATION_MARKERS = ["I would rather ask than guess", "I do not want to pick for you"];

function clarificationFor(open: OpenQuestion[]): string {
  const first = CURRENT_AMENDMENT_CLARIFICATIONS[open[0].kind](open[0].turn);
  if (open.length === 1) return first;
  const rest = open.length - 1;
  return `${first} After that I have ${rest === 1 ? "one more question" : `${rest} more questions`} `
    + `about something else you asked earlier, so I am not carrying your request forward yet.`;
}

/** Did this assistant turn put this path's question about `turn` to the reader? */
function askedAbout(assistantTurn: string | null, turn: string): boolean {
  if (!assistantTurn) return false;
  return assistantTurn.includes(`"${turn.trim()}"`)
    && CLARIFICATION_MARKERS.some((marker) => assistantTurn.includes(marker));
}

/**
 * The client retains a bounded conversation and sends it with the request. This reads that window
 * and nothing more: no store, no extra retention, and no reaching for a turn that has scrolled out.
 */
const HISTORY_WINDOW = 12;

/**
 * The window, read through the product's own source-preserving normalizer, which honours both
 * `source` and `tab` as the same tag.
 */
function windowOf(rawHistory: unknown): SourceTaggedMessage[] {
  return normalizeHistoryWithSource(rawHistory, HISTORY_WINDOW);
}

/* ── what one turn states ───────────────────────────────────────────────────────────── */

const ROLLING = /\brolling\s+(?:over\s+)?(?:12|twelve)[\s-]*months?\b|\b(?:12|twelve)[\s-]*month\s+rolling\b|\brolling\s+(?:12|twelve)\b/i;
const MONTHLY = /\bmonthly\b|\bby\s+month\b|\bper\s+month\b/i;
const ANNUAL = /\bannual(?:ly)?\b|\byearly\b|\bby\s+year\b/i;

/**
 * The series form a turn states, or a competing pair. "rolling 12 months by month" is a rolling
 * series shown month by month — the month is its display grain, not a second form. Any other pair
 * is two requested outputs, which this single-output path does not choose between.
 */
function windowOfTurn(question: string): { window: RequestWindow | null; competing: boolean } {
  const rolling = ROLLING.test(question);
  const monthly = MONTHLY.test(question);
  const annual = ANNUAL.test(question);
  if (rolling) return { window: "rolling_12", competing: annual };
  if (monthly && annual) return { window: null, competing: true };
  if (monthly) return { window: "monthly", competing: false };
  if (annual) return { window: "annual", competing: false };
  return { window: null, competing: false };
}

const STATES_RATE = /\bper\s*capita\b|\bper\s*100[,.]?000\b|\bper\s*100\s*k\b|\brates?\b/i;
/** An explicit count noun. "how many" is weaker and yields to a stated rate. */
const STATES_COUNT_NOUN = /\bcounts?\b|\btotals?\b|\bnumbers?\b/i;
const STATES_HOW_MANY = /\bhow\s+many\b/i;

/**
 * A unit is only AMENDED when the reader says so, and "counts and rates" is two units.
 */
function unitOfTurn(question: string): { unit: "count" | "rate_per_100k" | null; competing: boolean } {
  const rate = STATES_RATE.test(question);
  const countNoun = STATES_COUNT_NOUN.test(question);
  if (rate && countNoun) return { unit: null, competing: true };
  if (rate) return { unit: "rate_per_100k", competing: false };
  if (countNoun || STATES_HOW_MANY.test(question)) return { unit: "count", competing: false };
  return { unit: null, competing: false };
}

/**
 * The national scope in the words the contract parser does not model: it reads "nationwide" but
 * returns `kind: "unknown"` for "nationally" and "across the country".
 */
const STATES_NATIONAL = /\bnational(?:ly|wide)?\b|\bacross\s+the\s+(?:country|u\.?s\.?a?)\b|\bin\s+the\s+(?:u\.?s\.?a?|united\s+states)\b/i;
const NATIONAL_GEOGRAPHY: QueryContractGeography = {
  kind: "national", name: "United States", state: null, canonicalName: "United States",
  confidence: "high", needsClarification: [],
};

/**
 * WHOLE-FORM OWNERSHIP.
 *
 * A turn is owned only when the supported surfaces account for all of it. They are consumed as
 * SPANS — the offense, the window, the unit, the places the resolver matched, and the period as it
 * was written, including "2018 to present". What remains may only be framing. Anything else is a
 * clause this path does not model, and a clause it does not model is a reason to decline.
 */
const PERIOD_SURFACES: RegExp[] = [
  /\b(?:from\s+)?(?:19|20)\d{2}\s*(?:to|through|thru|-|–|until)\s*(?:present|today|date|now|(?:19|20)\d{2})/gi,
  /\b(?:since|from|in|for|during|of)\s+(?:19|20)\d{2}\b/gi,
  /\b(?:19|20)\d{2}\b/g,
];
const UNIT_SURFACES: RegExp[] = [
  /\bper\s*capita\b/gi, /\bper\s*100[,.]?000\b/gi, /\bper\s*100\s*k\b/gi,
  /\brates?\b/gi, /\bcounts?\b/gi, /\btotals?\b/gi, /\bnumbers?\b/gi,
];
const WINDOW_SURFACES: RegExp[] = [
  /\brolling\s+(?:over\s+)?(?:12|twelve)[\s-]*months?\b/gi,
  /\b(?:12|twelve)[\s-]*month\s+rolling\b/gi,
  /\brolling\s+(?:12|twelve)\b/gi,
  /\bby\s+month\b/gi, /\bmonthly\b/gi, /\bper\s+month\b/gi,
  /\bby\s+year\b/gi, /\bannual(?:ly)?\b/gi, /\byearly\b/gi,
];
const NATIONAL_SURFACE = /\bnational(?:ly|wide)?\b|\bacross\s+the\s+(?:country|u\.?s\.?a?)\b|\bin\s+the\s+(?:u\.?s\.?a?|united\s+states)\b/gi;

/** The words a person wraps a request in. Not fields, and never a clause of their own. */
const FRAME_WORDS = new Set([
  "can", "i", "see", "show", "me", "us", "you", "give", "let", "lets", "please", "how", "many",
  "much", "what", "is", "are", "was", "were", "there", "the", "a", "an", "of", "in", "for", "on",
  "at", "by", "to", "and", "do", "now", "try", "about", "instead", "only", "just", "same", "then",
  "that", "this", "it", "with", "over", "from", "since", "through", "during", "switch", "make",
  "want", "would", "like", "get", "up", "data", "meant", "use", "im", "ive",
]);

/** Everything the supported surfaces did not account for. */
function unaccountedWords(question: string, mentionTexts: string[], offenseSurface: string | null): string[] {
  let text = ` ${question} `;
  const cut = (pattern: RegExp) => { text = text.replace(pattern, " "); };
  for (const mention of mentionTexts) {
    if (!mention.trim()) continue;
    text = text.split(mention).join(" ");
    text = text.split(mention.toLowerCase()).join(" ");
  }
  cut(NATIONAL_SURFACE);
  for (const pattern of PERIOD_SURFACES) cut(pattern);
  for (const pattern of UNIT_SURFACES) cut(pattern);
  for (const pattern of WINDOW_SURFACES) cut(pattern);
  if (offenseSurface) cut(new RegExp(offenseSurface, "gi"));
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((word) => word && !FRAME_WORDS.has(word));
}

/** The reader is asking what the data covers, which is its own question and keeps its own path. */
function isMetadataRequest(question: string): boolean {
  if (detectCompletenessQuestion(question)) return true;
  return /\bhow\s+far\s+back\b|\bwhat\s+years?\b.*\bavailable\b|\byears?\s+(?:are\s+)?available\b|\bdata\s+coverage\b/i.test(question);
}

type Ownership = "owned" | "competing-value" | "unmodelled-clause" | "unreadable-year" | "nothing-stated";

interface TurnReading {
  turn: string;
  contract: QueryContract | null;
  /** The metric of a turn that names exactly one offense. */
  offense: QueryContract["metric"] | null;
  unit: "count" | "rate_per_100k" | null;
  window: RequestWindow | null;
  geography: QueryContractGeography | null;
  period: QueryContract["time"] | null;
  stated: AmendmentField[];
  competing: AmendmentField[];
  /**
   * The turn names a place the resolver cannot settle on its own — "Portland" is Maine or Oregon.
   * The parser still returns its first candidate, and carrying that would silently pick one.
   */
  ambiguousPlace: boolean;
  unaccounted: string[];
}

function readTurn(turn: string): TurnReading {
  const contract = buildQueryContract(turn, "current");
  const competing: AmendmentField[] = [];

  let offense: QueryContract["metric"] | null = null;
  if (contract && contract.metric.offenses.length > 1) competing.push("offense");
  else if (contract && contract.metric.offenses.length === 1) offense = contract.metric;

  const unit = unitOfTurn(turn);
  if (unit.competing) competing.push("unit");
  const window = windowOfTurn(turn);
  if (window.competing) competing.push("window");

  const mentions = resolveGeoPlaces(turn).mentions.map((mention) => mention.text);
  const statesNational = STATES_NATIONAL.test(turn) || contract?.geography.kind === "national";
  let geography: QueryContractGeography | null = null;
  let ambiguousPlace = false;
  const placeCount = mentions.length + (statesNational ? 1 : 0);
  if (placeCount > 1 || (contract && contract.geographies.length > 1)) competing.push("geography");
  else if (statesNational) geography = NATIONAL_GEOGRAPHY;
  else if (contract && contract.geography.needsClarification.length > 0) ambiguousPlace = true;
  else if (contract && contract.geography.kind !== "unknown" && contract.geography.name) geography = contract.geography;

  const period = contract && contract.time.startYear !== null ? contract.time : null;

  const stated: AmendmentField[] = [];
  if (offense) stated.push("offense");
  if (unit.unit) stated.push("unit");
  if (window.window) stated.push("window");
  if (geography) stated.push("geography");
  if (period) stated.push("period");

  const offenseSurface = OFFENSE_NOUN_RE.exec(turn)?.[0] ?? null;
  return {
    turn, contract, offense, unit: unit.unit, window: window.window, geography, period,
    stated, competing, ambiguousPlace, unaccounted: unaccountedWords(turn, mentions, offenseSurface),
  };
}

/**
 * A form this path can carry in full, or the reason it cannot. The order matters: a leftover that
 * is only a five-digit number is a year the parser could not read, a leftover with no field beside
 * it is a turn like "range", and anything else is a clause this path does not model.
 */
function ownershipOf(reading: TurnReading): Ownership {
  if (reading.competing.length > 0) return "competing-value";
  // An ambiguous place is still a place the reader named; it is accounted for, just not carried.
  const statesSomething = reading.stated.length > 0 || reading.ambiguousPlace;
  const unreadableYears = reading.unaccounted.filter((word) => /^\d{5,}$/.test(word));
  const otherClauses = reading.unaccounted.filter((word) => !/^\d{5,}$/.test(word));
  if (otherClauses.length > 0) return statesSomething ? "unmodelled-clause" : "nothing-stated";
  if (unreadableYears.length > 0 && !reading.period) return "unreadable-year";
  if (!statesSomething) return "nothing-stated";
  return "owned";
}

/**
 * A turn that stands on its own: it says what is being measured, and where or when. "now robberies"
 * names an offense and nothing else, so it is an amendment, not a new request.
 */
function isAnchor(reading: TurnReading): boolean {
  return Boolean(reading.contract && reading.contract.metric.topic !== "unknown"
    && (reading.geography || reading.ambiguousPlace || reading.period));
}

/* ── the effective request ──────────────────────────────────────────────────────────── */

type FieldValue<T> = { value: T; origin: RequestFieldOrigin };

interface EffectiveFields {
  offense: FieldValue<QueryContract["metric"] | null>;
  unit: FieldValue<"count" | "rate_per_100k" | null>;
  window: FieldValue<RequestWindow | null>;
  geography: FieldValue<QueryContractGeography | null>;
  period: FieldValue<QueryContract["time"] | null>;
}

const absent = <T>(value: T): FieldValue<T> => ({ value, origin: { origin: "absent", turn: null, inherited: false } });
const statedBy = <T>(value: T, turn: string): FieldValue<T> => ({ value, origin: { origin: "stated", turn, inherited: false } });

function fieldsOfAnchor(anchor: TurnReading): EffectiveFields {
  const fields: EffectiveFields = {
    offense: anchor.offense ? statedBy(anchor.offense, anchor.turn) : absent(null),
    unit: anchor.unit ? statedBy(anchor.unit, anchor.turn) : absent(null),
    window: anchor.window ? statedBy(anchor.window, anchor.turn) : absent(null),
    geography: anchor.geography ? statedBy(anchor.geography, anchor.turn) : absent(null),
    period: anchor.period ? statedBy(anchor.period, anchor.turn) : absent(null),
  };
  // The parser defaults a named offense to `count`. Record that as a default, never as a statement,
  // so a later explicit unit replaces it and a later offense turn cannot reinstate it.
  if (!anchor.unit && anchor.contract?.metric.unit === "count") {
    fields.unit = { value: "count", origin: { origin: "defaulted", turn: anchor.turn, inherited: false } };
  }
  return fields;
}

/** Replace every field this turn states. Fields it does not state survive untouched. */
function applyTurn(fields: EffectiveFields, reading: TurnReading, options: { skipPeriod?: boolean } = {}): AmendmentField[] {
  const applied: AmendmentField[] = [];
  if (reading.offense) { fields.offense = statedBy(reading.offense, reading.turn); applied.push("offense"); }
  if (reading.unit) { fields.unit = statedBy(reading.unit, reading.turn); applied.push("unit"); }
  if (reading.window) { fields.window = statedBy(reading.window, reading.turn); applied.push("window"); }
  if (reading.geography) { fields.geography = statedBy(reading.geography, reading.turn); applied.push("geography"); }
  if (reading.period && !options.skipPeriod) { fields.period = statedBy(reading.period, reading.turn); applied.push("period"); }
  return applied;
}

function breakdownsForWindow(window: RequestWindow | null): string[] {
  if (window === "monthly") return ["month"];
  if (window === "annual") return ["year"];
  return [];
}

/**
 * The effective request, as a new contract. The anchor's contract supplies the fields this path
 * does not own (comparability, warnings), and every owned field comes from the turn that stated it.
 */
function contractFrom(
  anchor: TurnReading, fields: EffectiveFields, currentTurn: string,
): QueryContract & { request: AmendedRequestState } {
  const base = anchor.contract!;
  const offenseMetric = fields.offense.value ?? base.metric;
  const unit = fields.unit.value ?? (offenseMetric.topic === "unknown" ? "unknown" : "count");
  const geography = fields.geography.value ?? base.geography;
  const time = fields.period.value ?? base.time;
  const provenance = {} as Record<RequestField, RequestFieldOrigin>;
  for (const key of ["offense", "unit", "window", "geography", "period"] as const) {
    const origin = fields[key].origin;
    provenance[key] = { ...origin, inherited: origin.turn !== null && origin.turn !== currentTurn };
  }
  return {
    ...base,
    geography,
    geographies: [geography],
    metric: {
      ...offenseMetric,
      unit,
      denominator: unit === "rate_per_100k" ? "population" : null,
    },
    time: { ...time },
    breakdowns: breakdownsForWindow(fields.window.value),
    comparability: { ...base.comparability, partialYearDisclosure: time.partialYear },
    followup: { isFollowup: true, operation: "refine" },
    warnings: [...base.warnings],
    request: { kind: "current_amendment", window: fields.window.value, provenance, anchor: anchor.turn },
  };
}

/* ── rendering, and the check that the rendering says the same thing ─────────────────── */

const WINDOW_WORDS: Record<RequestWindow, string> = {
  rolling_12: "rolling over 12 months", monthly: "by month", annual: "by year",
};

function placeOf(geography: QueryContractGeography): string {
  if (geography.kind === "national") return "nationwide";
  const label = geography.canonicalName ?? (geography.state ? `${geography.name}, ${geography.state}` : geography.name);
  return `in ${label}`;
}

function periodOf(time: QueryContract["time"]): string | null {
  const { startYear, endYear } = time;
  if (startYear !== null && endYear !== null && startYear === endYear) return `in ${startYear}`;
  if (startYear !== null && endYear === null) return `from ${startYear} to present`;
  if (startYear !== null && endYear !== null) return `from ${startYear} to ${endYear}`;
  return null;
}

/**
 * Read the contract back in the order a person would say it. "nationwide" rather than
 * "nationally", because the parser recognizes the first and not the second.
 */
export function renderEffectiveRequest(contract: QueryContract & { request: AmendedRequestState }): string {
  const parts: string[] = [];
  parts.push((contract.metric.offenses[0]?.label ?? "offenses").toLowerCase());
  if (contract.request.window) parts.push(WINDOW_WORDS[contract.request.window]);
  if (contract.metric.unit === "rate_per_100k") parts.push("per capita");
  if (contract.geography.kind !== "unknown" && (contract.geography.name || contract.geography.kind === "national")) {
    parts.push(placeOf(contract.geography));
  }
  const period = periodOf(contract.time);
  if (period) parts.push(period);
  return parts.join(" ");
}

/**
 * The route's text-only guardrails and delivery checks still read a sentence. They get this
 * rendering, so it has to say exactly what the contract says. Returns the fields that disagree.
 */
export function renderingDisagreements(
  rendered: string, contract: QueryContract & { request: AmendedRequestState },
): string[] {
  const reparsed = buildQueryContract(rendered, "current");
  if (!reparsed) return ["unparseable"];
  const out: string[] = [];
  if (reparsed.metric.topic !== contract.metric.topic) out.push("offense");
  const unitOf = (u: string) => (u === "rate_per_100k" ? "rate" : "count");
  if (unitOf(reparsed.metric.unit) !== unitOf(contract.metric.unit)) out.push("unit");
  const g1 = reparsed.geography;
  const g2 = contract.geography;
  if (g1.kind !== g2.kind || (g1.kind !== "national" && (
    (g1.name ?? "").toLowerCase() !== (g2.name ?? "").toLowerCase() || (g1.state ?? "") !== (g2.state ?? "")))) {
    out.push("geography");
  }
  if (reparsed.time.startYear !== contract.time.startYear || reparsed.time.endYear !== contract.time.endYear) out.push("period");
  if (detectRequestedGrain(rendered) !== requestWindowGrain(contract.request.window)) out.push("window");
  return out;
}

const UNIT_WORDS = { count: "counts", rate_per_100k: "rate per 100,000 residents" } as const;

function sourceNote(origin: RequestFieldOrigin): string {
  if (origin.origin === "defaulted") return "not stated by the user; the default";
  if (origin.origin === "absent") return "not stated";
  return `stated in "${origin.turn!.trim()}"`;
}

/** The model instruction, rendered field by field from the contract. */
function instructionFor(contract: QueryContract & { request: AmendedRequestState }, rendered: string): string {
  const p = contract.request.provenance;
  const lines: string[] = [];
  lines.push(`- offense: ${contract.metric.offenses[0]?.label ?? "not stated"} (${sourceNote(p.offense)})`);
  const unit = contract.metric.unit === "rate_per_100k" || contract.metric.unit === "count" ? UNIT_WORDS[contract.metric.unit] : "not stated";
  lines.push(`- measure: ${unit} (${sourceNote(p.unit)})`);
  if (contract.request.window) {
    const series = contract.request.window === "rolling_12" ? "rolling 12-month totals, one value per month" : WINDOW_WORDS[contract.request.window];
    lines.push(`- series: ${series} (${sourceNote(p.window)})`);
  }
  if (p.geography.origin !== "absent") lines.push(`- place: ${placeOf(contract.geography).replace(/^in /, "")} (${sourceNote(p.geography)})`);
  const period = periodOf(contract.time);
  if (period) lines.push(`- period: ${period.replace(/^in /, "")} (${sourceNote(p.period)})`);
  return `[SYSTEM: This turn amends an earlier request. The effective request is: ${rendered}. `
    + `It was built from the user's own turns, starting from "${contract.request.anchor.trim()}":\n${lines.join("\n")}\n`
    + `Answer the effective request. Do not carry over any filter, threshold or scope that the user did not state.]`;
}

/* ── the resolution ─────────────────────────────────────────────────────────────────── */

/**
 * Build the effective request for a Current-series follow-up, or say why it cannot be built.
 */
export function resolveCurrentFollowupAmendment(
  question: string,
  rawHistory: unknown,
  tab: string,
): AmendmentResolution {
  if (tab !== "current") return { kind: "none", reason: "this path covers the Current Trends series only" };

  const messages = windowOf(rawHistory);
  if (messages.length === 0) return { kind: "none", reason: "no history was supplied" };

  // The user turns after the last other-tab boundary, each with the assistant turn just before it.
  let userTurns: Array<{ turn: string; previousAssistant: string | null }> = [];
  let lastAssistant: string | null = null;
  for (const message of messages) {
    if (message.source && message.source !== tab) { userTurns = []; lastAssistant = null; continue; }
    if (message.role === "assistant") { lastAssistant = message.content; continue; }
    userTurns.push({ turn: message.content, previousAssistant: lastAssistant });
    lastAssistant = null;
  }
  if (userTurns.length === 0) return { kind: "none", reason: "no user turn from this tab is in the window" };

  const current = readTurn(question);
  // THE CURRENT TURN DECIDES FIRST, before any question waiting in the history.
  if (isMetadataRequest(question)) return { kind: "none", reason: "a metadata request keeps its own path" };
  const currentOwnership = ownershipOf(current);
  if (isAnchor(current) && currentOwnership === "owned") {
    return { kind: "none", reason: "this turn stands on its own and needs no amendment" };
  }
  if (currentOwnership === "competing-value" || currentOwnership === "unmodelled-clause") {
    return {
      kind: "none",
      reason: `this turn states a meaning this path cannot carry (${currentOwnership}: ${current.competing.join(",") || "unmodelled words"})`,
    };
  }

  const parsed = userTurns.map((entry) => ({ ...readTurn(entry.turn), previousAssistant: entry.previousAssistant }));
  let anchorIndex = -1;
  for (let i = 0; i < parsed.length; i += 1) {
    if (isAnchor(parsed[i]) && ownershipOf(parsed[i]) === "owned") anchorIndex = i;
  }
  if (anchorIndex < 0) return { kind: "none", reason: "no full request this path can carry is in the window" };

  const anchor = parsed[anchorIndex];
  const fields = fieldsOfAnchor(anchor);
  const applied: Array<{ turn: string; fields: AmendmentField[] }> = [];
  let open: OpenQuestion[] = [];
  // A place the resolver could not settle. A later place the reader states supersedes it — the
  // route's own place question is how that answer usually arrives — and otherwise nothing is carried.
  let unsettledPlace: string | null = anchor.ambiguousPlace ? anchor.turn : null;
  const trackPlace = (reading: TurnReading) => {
    if (reading.geography) unsettledPlace = null;
    else if (reading.ambiguousPlace) unsettledPlace = reading.turn;
  };

  const sequence = [
    ...parsed.slice(anchorIndex + 1),
    { ...current, previousAssistant: lastAssistant },
  ];

  for (const reading of sequence) {
    const own = ownershipOf(reading);
    if (own === "competing-value" || own === "unmodelled-clause") {
      return { kind: "none", reason: `a turn states a meaning this path cannot carry: "${reading.turn}"` };
    }

    if (own === "owned") {
      // What resolves an open question, and nothing else does:
      //   - a stated year answers an unreadable year;
      //   - a turn like "range" is answered only by the reader's REPLY to this path's own question
      //     about it, and only when the reply picks one of the two things that question offered —
      //     the years (a period), or a change to the series (a window). Any other reply leaves the
      //     question open (CR1): "now robberies" changes the offense, and the change is carried,
      //     but it does not say which meaning of "range" was intended. Nor does a place or a unit.
      if (reading.period) open = open.filter((q) => q.kind !== "malformed-year");
      const picksAnOffer = reading.stated.some((field) => field === "period" || field === "window");
      open = open.filter((q) => !(q.kind === "ambiguous-amendment" && picksAnOffer
        && askedAbout(reading.previousAssistant, q.turn)));
      trackPlace(reading);
      const changed = applyTurn(fields, reading);
      applied.push({ turn: reading.turn, fields: changed });
      continue;
    }
    if (own === "unreadable-year") {
      // The readable part of the turn is still the reader's: "show seattle for 20206" moves to
      // Seattle. Only the year waits.
      trackPlace(reading);
      const changed = applyTurn(fields, reading, { skipPeriod: true });
      if (changed.length > 0) applied.push({ turn: reading.turn, fields: changed });
      open.push({ kind: "malformed-year", turn: reading.turn });
      continue;
    }
    // nothing-stated: a turn like "range". It does not say which field it is about.
    open.push({ kind: "ambiguous-amendment", turn: reading.turn });
  }

  if (open.length > 0) {
    return {
      kind: "clarify", reason: open[0].kind, unresolvedTurn: open[0].turn, openQuestions: open,
      question: clarificationFor(open),
    };
  }
  if (unsettledPlace !== null) {
    // Asked AFTER the open questions, so an unanswered "range" is still asked about rather than
    // handed to the existing path, where it would be dropped.
    return { kind: "none", reason: `a place was never settled: "${unsettledPlace}"` };
  }
  if (applied.length === 0) return { kind: "none", reason: "this turn states nothing to amend" };

  const contract = contractFrom(anchor, fields, question);
  const effectiveQuestion = renderEffectiveRequest(contract);
  const disagreements = renderingDisagreements(effectiveQuestion, contract);
  if (disagreements.length > 0) {
    // The text-only consumers would read a different request than the contract carries. Declining
    // leaves the existing behavior; carrying on would let the two halves of the route disagree.
    return { kind: "none", reason: `the rendering does not read back to the same request (${disagreements.join(",")})` };
  }
  return {
    kind: "composed", anchor: anchor.turn, applied, contract, effectiveQuestion,
    transform: {
      name: "compose_current_amendment",
      contextQuestion: effectiveQuestion,
      instruction: instructionFor(contract, effectiveQuestion),
    },
  };
}
