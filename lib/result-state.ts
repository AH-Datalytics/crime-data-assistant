/**
 * Increment 1 — honest empty/error-state handling (frozen Decision 13).
 *
 * A shared, pure policy core. It takes evidence a source adapter has already gathered and
 * returns a typed decision. It renders nothing, reads no database, and never guesses.
 *
 * WHY THIS EXISTS. The baseline showed the product describing its own failures as absent
 * data. "No results", "this agency may not participate" and "the site could not complete
 * this" are three different claims, and only the first two are claims about the world.
 * Decision 13 names four owner-facing states; this core adds a fifth, internal one.
 *
 *   true_zero        the measure genuinely is zero, and every precondition proves it
 *   missing_report   the entity exists and the period is covered, but nothing was filed
 *   outside_coverage the entity or the period sits outside what this source carries
 *   product_failure  we failed — a timeout, an error, a query we could not run
 *   unknown          we cannot tell which of the above is true
 *
 * THE RULE THAT OUTRANKS THE OTHERS: `unknown` is a real answer and must stay one. It is
 * never rounded to zero, to "no data", to non-participation, or to outside coverage. An
 * empty row set proves only that the query returned nothing; on its own it is evidence of
 * nothing else at all.
 *
 * True zero is deliberately the hardest state to reach. Six conditions must ALL hold
 * (architecture review §4); any one unproven yields `unknown`. Saying "there were zero
 * murders" when we merely failed to look is the worst error this system can make, so the
 * asymmetry is intentional: absence of proof is never proof of zero.
 */

export type ResultState =
  | "true_zero"
  | "missing_report"
  | "outside_coverage"
  | "product_failure"
  | "unknown";

/** Evidence a source adapter supplies. Every field is deliberately tri-state. */
export interface ResultStateEvidence {
  /** Did the query run to completion? false = we failed. null = we do not know. */
  queryCompleted: boolean | null;
  /** Was a product-side error, timeout or guardrail block recorded? */
  productError?: string | null;
  /** Were the requested entity and period both resolved to concrete identities? */
  requestResolved: boolean | null;
  /** Is the requested period inside what this source covers? */
  periodInCoverage: boolean | null;
  /** Is the requested entity carried by this source at all? */
  entityInCoverage: boolean | null;
  /**
   * Does the source indicate reporting was expected or present for this entity and
   * period? null when the adapter cannot establish it — which is common and honest.
   */
  reportingExpected: boolean | null;
  /** Does the executed query actually represent the measure the user asked for? */
  queryRepresentsRequest: boolean | null;
  /**
   * The measured value, when the query returned one. `0` is a value; `null` means no
   * row was returned at all, which is NOT the same thing and must never be read as zero.
   */
  measuredValue: number | null;
  /** Number of data rows returned, when known. */
  rowCount: number | null;
}

export interface ResultStateDecision {
  state: ResultState;
  /** True only when the state was established from evidence, not assumed. */
  establishedFromEvidence: boolean;
  /** Which condition stopped a stronger claim. Internal; for logs and proofs. */
  blockingReason: string;
  /** Plain-English sentence safe to show. Never contains internal vocabulary. */
  message: string;
}

/** The six conditions a true-zero claim requires, in the order they are checked. */
export const TRUE_ZERO_CONDITIONS = [
  "queryCompleted",
  "requestResolved",
  "periodInCoverage",
  "reportingExpected",
  "queryRepresentsRequest",
  "measuredValueIsZero",
] as const;

const UNKNOWN_MESSAGE =
  "I can't determine safely whether this is a genuine zero, an unreported period, or a gap in coverage, so I'm not going to state one. Try a single place, period and offense.";

const PRODUCT_FAILURE_MESSAGE =
  "I couldn't complete this request. That's a failure on our side, not a statement about the data.";

/**
 * Classify an empty or zero result.
 *
 * Order matters. Our own failure is checked first, because a failed request tells us
 * nothing about the world and must never be described as though it did.
 */
export function classifyResultState(e: ResultStateEvidence): ResultStateDecision {
  // 1. Our failure. Checked first and unconditionally.
  if (e.productError) {
    return {
      state: "product_failure",
      establishedFromEvidence: true,
      blockingReason: `product error: ${e.productError}`,
      message: PRODUCT_FAILURE_MESSAGE,
    };
  }
  if (e.queryCompleted === false) {
    return {
      state: "product_failure",
      establishedFromEvidence: true,
      blockingReason: "the query did not complete",
      message: PRODUCT_FAILURE_MESSAGE,
    };
  }
  if (e.queryCompleted === null) {
    return unknown("we cannot establish whether the query completed");
  }

  // 2. Coverage. Only stated when the adapter positively established it.
  if (e.entityInCoverage === false) {
    return {
      state: "outside_coverage",
      establishedFromEvidence: true,
      blockingReason: "the entity is not carried by this source",
      message: "This source doesn't carry that place, so there's no figure to report for it.",
    };
  }
  if (e.periodInCoverage === false) {
    return {
      state: "outside_coverage",
      establishedFromEvidence: true,
      blockingReason: "the period is outside coverage",
      message: "The period you asked about is outside what this source covers, so there's no figure to report for it.",
    };
  }
  if (e.requestResolved === false) {
    return unknown("the requested entity or period could not be resolved");
  }
  if (e.requestResolved === null || e.periodInCoverage === null || e.entityInCoverage === null) {
    return unknown("coverage for the requested entity or period could not be established");
  }

  // 3. Reporting. A place inside coverage that filed nothing is a missing report —
  //    but only when the source can actually show that reporting was expected.
  if (e.reportingExpected === false) {
    return {
      state: "missing_report",
      establishedFromEvidence: true,
      blockingReason: "no report was filed for this entity and period",
      message: "That place is covered for this period, but no report was filed for it, so there's no figure to report — that is not the same as a zero.",
    };
  }
  if (e.reportingExpected === null) {
    return unknown("we cannot establish whether a report was expected or filed");
  }

  // 4. Does the query we ran actually answer the question asked?
  if (e.queryRepresentsRequest !== true) {
    return unknown("we cannot establish that the query represents the requested measure");
  }

  // 5. Only now may a zero be called a zero.
  if (e.measuredValue === 0) {
    return {
      state: "true_zero",
      establishedFromEvidence: true,
      blockingReason: "",
      message: "The reported figure for that place and period is zero.",
    };
  }
  if (e.measuredValue === null) {
    // Reporting was expected, coverage holds, the query was right — and still no row
    // came back. That is not a zero; we do not know what it is.
    return unknown("no value was returned, and an absent row is not a zero");
  }

  return unknown(`a non-zero value (${e.measuredValue}) was returned; this classifier is for empty and zero results`);
}

function unknown(reason: string): ResultStateDecision {
  return {
    state: "unknown",
    establishedFromEvidence: false,
    blockingReason: reason,
    message: UNKNOWN_MESSAGE,
  };
}

/**
 * Wording the product must never use about a state it has not established.
 *
 * Used by the egress guard below. These are the phrasings the baseline caught: a failed
 * request presented as absent data or as an agency choosing not to participate.
 */
/**
 * Wording the product must never use unless the ESTABLISHED state authorizes that exact
 * claim. Each pattern lists the states that make it true; any other state blocks it.
 *
 * The earlier version allowed any text through once some state was established, which let
 * an established outside-coverage finding authorize a statement of true zero or of missing
 * reporting — three different claims about the world. Establishing one does not license
 * the others.
 */
const CLAIM_RULES: {
  pattern: RegExp;
  claim: string;
  allowedStates: ResultState[];
}[] = [
  { pattern: /\bzero\b|\bnone were\b/i, claim: "a true zero", allowedStates: ["true_zero"] },
  /*
   * The numeral form of the same claim. `zero` was matched and `0` was not, so
   * "There were 0 murders in Ward, AR in 2024" shipped from an empty result.
   *
   * Scoped so a zero inside a number or an identifier cannot trip it:
   *   (?<![\d.,])      rejects the 0 in "10" and in "0.7"
   *   (?![\d,%])(?!\.\d)  rejects "0.7%" and "0,5", while still allowing a sentence-final "0."
   * Years, ranges and ORIs carry neither a reporting verb nor a counted noun, so they are
   * untouched — the negatives are asserted in scripts/test-evidence-boundary-guard.ts.
   */
  {
    pattern: /\b(?:were|was|is|are|had|has|recorded|reported|returns?|returned|shows?|showed|totall?ed|remains?|remained|stood at)\s+(?<![\d.,])0(?![\d,%])(?!\.\d)/i,
    claim: "a true zero",
    allowedStates: ["true_zero"],
  },
  {
    pattern: /(?<![\d.,])0(?![\d,%])(?!\.\d)\s+(?:murders|homicides|offen[sc]es|incidents|cases|crimes|arrests|clearances|victims|reports?|records?|results?)\b/i,
    claim: "a true zero",
    allowedStates: ["true_zero"],
  },
  {
    /*
     * "Murders in Ward, AR in 2024: 0" — a labelled quantity standing alone.
     *
     * This rule is NOT exempted when rows are present. An earlier version skipped it on any
     * populated result, reasoning that a labelled zero is "a returned cell". That was wrong,
     * and it let the exact claim this batch exists to block through whenever any row existed
     * — a null aggregate, or another city's figure. Row presence changes the EXTENT OF
     * EDITING, never whether a claim is checked: a freestanding `label: 0` sentence is a
     * claim, and only an established true-zero state authorizes it.
     *
     * Genuine zero-valued table cells are unaffected because they are pipe- or
     * whitespace-delimited columns, not `label: value` prose — asserted in the suite.
     */
    pattern: /:\s*(?<![\d.,])0(?![\d,%])(?!\.\d)\s*$/m,
    claim: "a true zero",
    allowedStates: ["true_zero"],
  },
  { pattern: /\bnothing was (?:reported|recorded)\b/i, claim: "nothing reported", allowedStates: ["true_zero", "missing_report"] },
  { pattern: /\bno report was filed\b/i, claim: "a missing report", allowedStates: ["missing_report"] },
  { pattern: /\bdoes(?:n't| not) (?:report|participate)\b/i, claim: "non-participation", allowedStates: ["missing_report"] },
  { pattern: /\bmay not (?:be )?particip\w*/i, claim: "possible non-participation", allowedStates: ["missing_report"] },
  { pattern: /\bnot (?:currently )?particip\w*/i, claim: "non-participation", allowedStates: ["missing_report"] },
  { pattern: /\bno (?:data|results?|records?|figures?)\b/i, claim: "absent data", allowedStates: ["missing_report", "outside_coverage"] },
  { pattern: /\b(?:is|are|was|were)?\s*not in (?:our|the) dataset\b/i, claim: "outside coverage", allowedStates: ["outside_coverage"] },
  { pattern: /\bwasn't found in (?:our|the) dataset\b/i, claim: "outside coverage", allowedStates: ["outside_coverage"] },
  { pattern: /\bwe (?:don't|do not) (?:carry|cover|have)\b/i, claim: "outside coverage", allowedStates: ["outside_coverage"] },
  { pattern: /\bdoesn't carry that place\b/i, claim: "outside coverage", allowedStates: ["outside_coverage"] },
  { pattern: /\boutside what this source covers\b/i, claim: "outside coverage", allowedStates: ["outside_coverage"] },
];

export interface EmptyStateGuardResult {
  /** True when the wording asserts a state the decision does not support. */
  blocked: boolean;
  /** The claim that was not supported, for logs. */
  unsupportedClaim: string | null;
  /** The wording to use instead. Equals the input when nothing was blocked. */
  safeText: string;
  /**
   * True when the offending unit was REMOVED from a populated answer, rather than the whole
   * narrative being replaced. Unchanged text never carries this.
   *
   * Route-log wiring is deliberately out of scope for this batch: `applyResultDisclosures`
   * returns a string and takes no guardrail list, so a reason recorded here does NOT reach
   * the route's captured rails. It is asserted locally and is nowhere claimed to be logged.
   */
  removed?: boolean;
}

/**
 * What the caller knows about the returned rows.
 *
 * `hasFigures` is ROW PRESENCE and nothing more. It is not proof that the requested figure
 * exists, that a named place is among the rows, or that any number is right. It changes only
 * the EXTENT OF EDITING — remove one sentence rather than discard the answer — never whether
 * a claim is true. Omitted context stays conservative and is never guessed from the prose.
 */
export interface GuardRowContext {
  hasFigures?: boolean;
}

/** The neutral note left when a unit is removed. It restates no unverified claim. */
const OMITTED_UNIT_NOTE = "One statement was omitted because the returned results do not establish it.";

/**
 * Split a narrative into removable units: lines first, then sentences within a line.
 *
 * A sentence boundary requires whitespace and an opening character after the terminator, so
 * "0.7%", "U.S." and decimal figures are never split. Line boundaries carry bullets and
 * rendered tables, where sentence boundaries are ambiguous.
 */
function splitTextUnits(line: string): string[] {
  return line.split(/(?<=[.!?])(?=\s+["'(‘“]?[A-Z])/);
}

/**
 * Remove only the units asserting something the state does not support.
 *
 * Returns `null` when nothing was removed, so the caller hands back the ORIGINAL string
 * byte-for-byte rather than a re-joined near-copy.
 */
function removeOffendingUnits(text: string, offends: (unit: string) => boolean): string | null {
  let removedAny = false;
  const keptLines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) { keptLines.push(line); continue; }
    const kept = splitTextUnits(line).filter((unit) => {
      if (!offends(unit)) return true;
      removedAny = true;
      return false;
    });
    if (kept.length === 0) continue; // the whole line was the offending unit
    keptLines.push(kept.join("").replace(/[ \t]+/g, " ").trim());
  }
  if (!removedAny) return null;
  const body = keptLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!body) return OMITTED_UNIT_NOTE;
  return body.includes(OMITTED_UNIT_NOTE) ? body : `${body}\n\n${OMITTED_UNIT_NOTE}`;
}

/**
 * The egress guard: refuse a factual empty-state label unless the decision supports it.
 *
 * The architecture review is explicit that the finalizer enforces a decision it cannot
 * itself discover — classification happens earlier, in the adapters. This function is the
 * enforcement half. It is deliberately conservative in one direction only: it will
 * replace an unsupported claim, never invent one.
 */
export function guardEmptyStateWording(
  text: string,
  decision: ResultStateDecision,
  context?: GuardRowContext,
): EmptyStateGuardResult {
  // 1. A KNOWN product failure always identifies itself as our failure. Unconditional, and
  // checked before any row context: relying on the patterns below would let a failure
  // through whenever its wording happened not to match one ("Try a shorter date range"),
  // which is the case the baseline caught. A partial row set never buys past this.
  if (decision.state === "product_failure") {
    if (text.includes(decision.message)) return { blocked: false, unsupportedClaim: null, safeText: text };
    return { blocked: true, unsupportedClaim: "a product failure described as anything else", safeText: decision.message };
  }

  const hasFigures = context?.hasFigures === true;

  // 2. Validate against the PARTICULAR established state, not merely the fact that one was
  // established. An unestablished state authorizes nothing at all.
  //
  // EVERY rule is evaluated whatever the row context. Row presence must never decide whether
  // a claim is CHECKED — only how much text is edited once it is found unsupported.
  const offending = (unit: string) =>
    CLAIM_RULES.some(({ pattern, allowedStates }) =>
      pattern.test(unit) && !(decision.establishedFromEvidence && allowedStates.includes(decision.state)));

  const firstUnsupported = CLAIM_RULES.find(({ pattern, allowedStates }) =>
    pattern.test(text) && !(decision.establishedFromEvidence && allowedStates.includes(decision.state)));
  if (!firstUnsupported) return { blocked: false, unsupportedClaim: null, safeText: text };

  /*
   * 3. The result returned rows. Replacing the whole narrative with the empty-state message
   * would be false about this answer and would destroy figures, entities, period and
   * caveats the reader is entitled to — the GC-073 defect. Remove only the offending unit.
   *
   * Row presence changes the EXTENT OF EDITING, not the truth of the claim: the unsupported
   * sentence still goes, and is never restated in the note left behind.
   */
  if (hasFigures) {
    const trimmed = removeOffendingUnits(text, offending);
    if (trimmed === null) return { blocked: false, unsupportedClaim: null, safeText: text };
    return { blocked: true, unsupportedClaim: firstUnsupported.claim, safeText: trimmed, removed: true };
  }

  // 4. No rows, or no context at all: conservative replacement, exactly as before.
  return { blocked: true, unsupportedClaim: firstUnsupported.claim, safeText: decision.message };
}

/**
 * Is this guidance sentence safe to show alongside a failure admission?
 *
 * G1: guidance is allowed to SURVIVE the product-failure replacement, so it has to clear
 * the same bar the replaced text failed. It may not make any empty-state claim, and it may
 * not smuggle a raw exception back in. Anything that trips a claim rule is dropped, not
 * rewritten — a control that edits guidance would be inventing text.
 */
export function isTrustedGuidanceSafe(guidance: string): boolean {
  const g = String(guidance ?? "").trim();
  if (!g) return false;
  for (const { pattern } of CLAIM_RULES) {
    if (pattern.test(g)) return false;          // no empty-state claim may ride along
  }
  // A raw exception is never guidance, however it reaches us.
  if (/\b(SqliteError|SQLITE_[A-Z]+|no such (?:table|column)|syntax error|ambiguous column|stack trace|at \w+\.\w+ \()/i.test(g)) return false;
  return true;
}

/**
 * The single call every factual narrative goes through at a terminal route exit.
 *
 * Extracted deliberately: the routes have ~130 terminal responses between them, and the
 * review's finding F3 is that the control sat downstream of most of them. A named builder
 * the routes call is testable in a way that "the guard runs somewhere later" is not.
 *
 * G1 (defect recorded 2026-09-06, ruling 2026-09-07). A product failure still replaces the
 * narrative unconditionally — that rule stays, because the baseline caught a failure worded
 * "Try a shorter date range" slipping past the pattern list, and arbitrary composed text
 * ("the data may not support that breakdown", a raw database error) must never survive.
 *
 * What changes is that the recovery policy may supply a SEPARATE trusted field. It is not
 * model prose and not an exception string: it is built by `lib/nibrs-recovery.ts` from
 * context that was actually resolved. It is appended AFTER the admission, and only if it
 * clears `isTrustedGuidanceSafe`. When the policy has no justified alternative it passes
 * nothing, and the honest failure stands alone.
 */
export function governFactualNarrative(
  text: string,
  decision: ResultStateDecision | null | undefined,
  trustedGuidance?: string | null,
  context?: GuardRowContext,
): string {
  if (!decision) return text;
  const safe = guardEmptyStateWording(text, decision, context).safeText;
  if (!trustedGuidance) return safe;
  if (!isTrustedGuidanceSafe(trustedGuidance)) return safe;
  if (safe.includes(trustedGuidance.trim())) return safe;
  return `${safe.trimEnd()}\n\n${trustedGuidance.trim()}`;
}
