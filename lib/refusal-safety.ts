import { buildCourtProcessExplanation, mayRefuseAsCourtProcess } from "./clearance-referent";
import { buildQueryContract, type QueryContractSource } from "./query-contract";
import { validateSourceCapabilities } from "./source-capabilities";
import { DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE } from "./capability-overrides";

const UNSUPPORTED_AVAILABILITY_CLAIM = /\b(?:not in|not included in|not found in|doesn\'t appear in|isn\'t in)\s+(?:our|the|this)?\s*(?:dataset|data|sample|library)\b/i;

export function neutralizeUnverifiedAvailabilityClaim(explanation: string, source: string): string {
  if (!UNSUPPORTED_AVAILABILITY_CLAIM.test(explanation || "")) return explanation;
  return "I couldn\'t verify that the requested data is unavailable because no database query was generated. I wasn\'t able to produce a valid " + source + " query for this request. Please try again or specify the place, offense, and date range.";
}

export function buildNoSqlFallbackMessage(source: string): string {
  const label = source === "hate_crime" ? "hate-crime" : source === "shr" ? "homicide" : source === "nibrs" ? "NIBRS" : source === "current" ? "Current Trends" : "Historical Library";
  return "I could not generate a database query for that request in the " + label + " source. Please restate it with the place, offense, and date range you want.";
}

export type NoSqlRefusalReason =
  | "court-data-out-of-scope"
  | "nonfatal-shooting-scope"
  | "demographic-rate-denominator"
  | "no-sql-server-template";

export type NoSqlRefusal = {
  explanation: string;
  /** The branch actually taken, so the log names the real reason rather than the generic one. */
  reason: NoSqlRefusalReason;
};

/**
 * What to tell the reader when no database query was produced.
 *
 * THE DEFECT THIS FIXES. Both the Current/Historical and NIBRS routes return from their no-SQL
 * branch BEFORE `runGuardrails`, so `out-of-scope-override` — which already classifies court-process
 * requests correctly — never got to speak. Every such question received the generic template, whose
 * advice to "restate it with the place, offense, and date range" can never succeed for a
 * conviction-rate question. The product knew the request was out of scope and told the reader to try
 * again (Decision 1, GC-006/007/008/009).
 *
 * SCOPE, as it now stands. This consults the court-process referent policy AND, for two named
 * limitation families, what the existing capability policy establishes for the same request. It
 * does not run the guardrail pipeline on an invented statement, add a model call, or change any
 * path where SQL was produced. A question none of those policies classifies keeps the generic
 * template unchanged — including a genuinely unclassifiable request, which must stay honest rather
 * than acquire a borrowed excuse.
 *
 * (The paragraph above describes the original court-only version, kept because it records why this
 * function exists. It is no longer the whole of what it consults.)
 */
export function selectNoSqlRefusal(question: string, source: string): NoSqlRefusal {
  // Court process keeps its precedence, unchanged.
  if (mayRefuseAsCourtProcess(question)) {
    return {
      explanation: buildCourtProcessExplanation(question),
      reason: "court-data-out-of-scope",
    };
  }
  if (asksExplicitNonfatalShootings(question)) {
    return { explanation: NONFATAL_SHOOTING_LIMITATION, reason: "nonfatal-shooting-scope" };
  }
  const established = establishedLimitations(question, source);
  if (established.has("demographic-rate-unsupported")) {
    return { explanation: demographicRateExplanation(established), reason: "demographic-rate-denominator" };
  }
  // A request with no established limitation keeps the generic template, word for word. An
  // unclassifiable question staying honest is better than one acquiring a borrowed excuse.
  return { explanation: buildNoSqlFallbackMessage(source), reason: "no-sql-server-template" };
}

/**
 * Whether a no-SQL reply to this request is ALREADY TERMINAL on the product's own policy.
 *
 * WHAT THIS IS FOR. Both routes react to a missing `sql` field by retrying the model. For a
 * court-process request that retry cannot succeed, and it is not merely wasteful: on GC-009
 * ("the race of defendants") the model declined correctly on the first attempt and the retry
 * produced SQL that counted ARRESTEES instead -- a different population, offered as if it
 * answered the question. The guard caught it. Retrying a request the policy has already
 * settled manufactures exactly that kind of substitute.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not read the model's explanation. A fluent
 * sentence about missing data is not evidence that data is missing -- GC-058's retry wrote a
 * confident limitation about the historical state-level table for a question the agency-level
 * tables can answer. The limitation here is established from the REQUEST by the existing
 * referent policy, before any reply is considered, so a mistaken refusal keeps its recovery.
 *
 * NARROW ON PURPOSE. Court process only. The nonfatal-shooting and demographic-denominator
 * families still reach the same terminal exit with their own explanations; whether their
 * retries are also pointless is a separate question and is not decided here.
 */
export function courtProcessNoSqlIsTerminal(question: string): boolean {
  return mayRefuseAsCourtProcess(question);
}

/**
 * A REQUEST WHOSE NONFATAL MEANING IS ESTABLISHED -- not merely one that mentions shootings.
 *
 * I first lifted the SHR route's routing regex here verbatim and called it "explicit nonfatal". It
 * was not. It treated `shooting incidents`, `people shot` and `gunshot victim` as nonfatal, so
 * "fatal shooting incidents in Chicago since 2015" selected the nonfatal explanation -- and because
 * this selector is SHARED, that reading spread to the Current, Historical and NIBRS no-SQL callers,
 * which never had it. Wording that has been wrong in one route for a while does not become safe by
 * being moved somewhere it reaches three more.
 *
 * None of those phrases establishes that anyone survived. A victim can be a fatal victim; an
 * incident can be a fatal incident; a person shot can have died. The only requests that reach this
 * explanation are the ones that SAY so: the word nonfatal, or being shot and surviving.
 *
 * Everything else keeps the generic fallback, which is the honest answer when the product cannot
 * establish what was asked. That includes a bare "shootings in Chicago" -- ambiguous between fatal
 * and nonfatal, and not this reply's to resolve.
 *
 * SCOPE. This governs the shared reply selector only. The SHR route's own earlier nonfatal branch
 * keeps its broader routing predicate, which is a separately recorded limitation and is NOT
 * certified by these checks; repairing that routing is explicitly out of this build.
 */
/**
 * Wording that states the outcome WAS fatal.
 *
 * The lookbehind is load-bearing. A hyphen or a space IS a word boundary, so `\bfatal\b` matches
 * inside "non-fatal" and "non fatal"; without it the hyphenated saved request (GC-105) and the
 * "non fatal shooting incidents" preservation example both fall to the generic template. Only the
 * unhyphenated "nonfatal" is safe without it.
 */
const FATAL_STATED = /\b(?<!non[-\s])(?:fatal|fatally|killed|kills?|died|die|deaths?|homicides?|murders?|deceased|slain)\b/i;

/**
 * ANY negation declines classification, and that breadth is deliberate.
 *
 * "Show shootings that were NOT nonfatal" reached the survivor explanation because the previous
 * version negated only survival wording, never the word `nonfatal` itself -- the same grant, the
 * other polarity. Rather than chase polarities, a negated request is simply not one whose meaning
 * this rule will claim to have established.
 *
 * STATED LIMITATION, not a hidden cost: this also declines benign negative modifiers, so a request
 * like "nonfatal shootings not counting suicides" keeps the generic reply rather than receiving the
 * specific explanation. That is a withheld explanation, never a wrong one, and it is the price of
 * not guessing.
 */
const NEGATION = /\b(?:not|never|no|none|nobody|neither|without)\b|n't\b/i;

/**
 * PHRASES THAT LINK THE OUTCOME TO THE SHOOTING, rather than words that happen to be near it.
 *
 * Two rejected approaches got here. First I accepted any nonfatal or survival word anywhere in the
 * question; then I required it within sixty characters of a shooting term. Both are the same
 * mistake wearing different clothes -- "How many shootings near flood survivors in Chicago?" passes
 * a distance test while describing a flood. Distance is not a relationship, and no threshold makes
 * it one.
 *
 * So the grant comes from forms in which the two are grammatically joined. An unfamiliar phrasing
 * keeps the generic reply, which is the honest outcome when the product cannot establish what was
 * asked.
 */
const LINKED_NONFATAL_PHRASES: RegExp[] = [
  /\bnon[-\s]?fatal(?:ly)?\s+(?:shootings?|gunshots?|gun\s+violence|shot)\b/i,
  /\bshot\s+(?:and|who)\s+survived\b/i,
  /\bshootings?\s+survivors?\b/i,
  /\bsurvivors?\s+of\s+(?:the\s+)?shootings?\b/i,
  /\bsurvived\s+(?:a|the)\s+shooting\b/i,
];

/**
 * A REQUEST WHOSE NONFATAL MEANING IS STATED ABOUT THE SHOOTING ITSELF.
 *
 * Three conditions, each of which cost something to learn:
 *
 *   1. STATED, not inferred. `shooting incidents`, `people shot` and `gunshot victim` say nothing
 *      about survival; nor do `wounded` and `injured`, which is how "shot and fatally injured"
 *      received the explanation written for survivors. Injury is evidence of harm, never of living.
 *   2. LINKED to the shooting, by phrase rather than by distance -- see above.
 *   3. Conflicting or negated wording establishes nothing, in either polarity.
 *
 * Everything else keeps the generic fallback, including a bare "shootings in Chicago": ambiguous,
 * and not this reply's to resolve.
 *
 * SCOPE. This governs the shared reply selector only. The SHR route's own earlier nonfatal branch
 * keeps its broader routing predicate: a separately recorded limitation, NOT certified here, and
 * repairing it is GC-110's question rather than this build's.
 */
export function asksExplicitNonfatalShootings(question: string): boolean {
  const q = question ?? "";
  if (FATAL_STATED.test(q)) return false;
  if (NEGATION.test(q)) return false;
  return LINKED_NONFATAL_PHRASES.some((phrase) => phrase.test(q));
}

/**
 * What the reader is told when they ask for nonfatal shootings.
 *
 * The old wording was right that the data is not collected and then sent the reader to two outside
 * websites, offering fatal homicides as the in-product alternative -- a different measure of a
 * different thing. The nearest measure the product actually holds is aggravated assault involving a
 * firearm, on NIBRS, and the distinction matters enough to state: it counts firearm assaults where
 * nobody was hit. That distinction is the product's own, already written into the NIBRS prompt.
 *
 * No coverage is promised. Whether a particular place, month or year is there depends on what the
 * agency reported, and this reply does not know that.
 */
export const NONFATAL_SHOOTING_LIMITATION =
  "Nonfatal shootings are not collected here. The Supplementary Homicide Reports cover fatal " +
  "outcomes only -- murders and manslaughters -- so there is no count of people who were shot and " +
  "survived.\n\n" +
  "The nearest measure this product holds is aggravated assault victims involving a firearm, on the " +
  "NIBRS tab. It is not a nonfatal-shooting count: it includes firearm assaults where nobody was " +
  "hit, such as a gun brandished or used as a blunt weapon, and it excludes shootings that were not " +
  "recorded as aggravated assault. Whether a particular place, month or year is covered depends on " +
  "what that agency reported to NIBRS.";

/**
 * The answer fields a limitation reply delivers, so both exits emit the same shape.
 *
 * A limitation is not a figure: no SQL, no title, no rows, nothing for a chart. Returning this from
 * one place is what lets a test assert the delivered state rather than read it out of a route.
 */
export type LimitationReply = {
  explanation: string;
  reason: NoSqlRefusalReason;
  sql: null;
  title: "";
  columns: never[];
  rows: never[];
  rowCount: 0;
  truncated: false;
  chartConfig: null;
  chartMeta: null;
};

export function limitationReply(question: string, source: string): LimitationReply {
  const refusal = selectNoSqlRefusal(question, source);
  return {
    explanation: refusal.explanation,
    reason: refusal.reason,
    sql: null,
    title: "",
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    chartConfig: null,
    chartMeta: null,
  };
}

/** The capability findings this composer is willing to turn into a refusal, and nothing else. */
const REFUSABLE_CAPABILITY_RULES = new Set([
  "demographic-rate-unsupported",
  "shr-non-homicide-unsupported",
]);

/**
 * Limitations this request has established, read from the existing capability policy.
 *
 * DELIBERATELY NARROW, twice over. Only rules on the allowlist above count, and only at
 * `unsupported` severity -- a table-selection WARNING produced by an empty statement says which
 * table a query should have used, not that the data is unavailable, and promoting one into a
 * refusal would invent a limitation the product never established.
 *
 * This runs only where no SQL was produced. It adds no model call and changes nothing on a path
 * that did produce a statement.
 */
function establishedLimitations(question: string, source: string): Set<string> {
  try {
    const contract = buildQueryContract(question, source as QueryContractSource);
    if (!contract) return new Set();
    return new Set(
      validateSourceCapabilities({ question, source: source as QueryContractSource, contract, sql: "" })
        .filter((finding) => finding.severity === "unsupported" && REFUSABLE_CAPABILITY_RULES.has(finding.ruleId))
        .map((finding) => finding.ruleId));
  } catch {
    // A limitation we cannot establish is not one we may assert.
    return new Set();
  }
}

/** The demographic-denominator reply, told accurately for the source it is being asked of. */
function demographicRateExplanation(established: Set<string>): string {
  const parts = [DEMOGRAPHIC_RATE_UNSUPPORTED_MESSAGE];
  if (established.has("shr-non-homicide-unsupported")) {
    // Saying only "no denominators" would leave the reader thinking this source holds the offence
    // and merely lacks a population figure. It does not hold it at all.
    parts.push(
      "This source, the Supplementary Homicide Reports, also covers homicide only, so it does not " +
      "hold arrests or non-homicide offenses at all -- counts or shares by demographic group for " +
      "those would be a NIBRS question, subject to what the agency reported there.");
  }
  return parts.join("\n\n");
}
