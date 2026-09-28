/**
 * Increment 2 — police record versus court process (frozen Decision 1).
 *
 * A shared, pure policy core. Given a question, it decides whether the request refers to
 * something the police record holds or to something that happens after the police are
 * finished with a case.
 *
 * WHY THIS EXISTS. `asksOutOfScopeTopic` in source-capabilities.ts refused any question
 * containing the word "prosecution". But NIBRS records `cleared_B = "Prosecution
 * declined"` as an EXCEPTIONAL CLEARANCE REASON — a police disposition, recorded by the
 * police, present in our data. So "what share of rapes were cleared because prosecution
 * was declined" is a question about our own data, and the product was refusing it as a
 * court-outcome question. All ten Decision 1 expectations failed in the baseline.
 *
 * Decision 1 decides by REFERENT, not by keyword: what is the sentence actually asking
 * about? A clearance reason recorded by a police agency is answerable. A conviction, a
 * sentence, a prison population or a court disposition is not, because no dataset here
 * carries it — whichever words happen to appear alongside.
 *
 * The hard case, which the review calls out explicitly: the word "prosecution" alone must
 * never decide this.
 */

export type ClearanceReferent =
  | "police_record"      // answerable: a police clearance/disposition
  | "court_process"      // not answerable: what happened after police involvement
  | "mixed"              // both referents present; answer the police half, decline the rest
  | "not_applicable";    // the question is about neither

export interface ReferentDecision {
  referent: ClearanceReferent;
  /** Why, for logs. Never shown to the reader. */
  reason: string;
  /** True when a capability rule may refuse the whole request. */
  refuseWholeRequest: boolean;
}

/**
 * Police clearance vocabulary. These describe how an agency closed a case, and NIBRS and
 * the FBI clearance tables carry them. "Prosecution declined" is the canonical trap: it
 * is a police clearance reason whose wording borrows a court word.
 */
const POLICE_CLEARANCE_CONTEXT = [
  /\bclear(?:ed|ance|ances)\b/i,
  /\bexceptional(?:ly)? clear/i,
  /\bcleared by (?:arrest|exception)/i,
  /\bcase (?:closed|closure)\b/i,
  /\bsolved\b/i,
];

/**
 * Phrases that are police clearance reasons even though they name court actors.
 * Source: NIBRS cleared-exceptionally codes (prosecution declined, extradition denied,
 * victim refused to cooperate, death of offender, juvenile/no custody).
 */
const POLICE_CLEARANCE_REASONS = [
  // The plural is carried here as well as in the singular because the court-side rule below
  // now recognizes the plural noun. Without this, "prosecutions declined by state" would lose
  // its police reading and pick up the court one -- the exact defect this module was written
  // to prevent, arriving from the other direction.
  //
  // These two also mark the SPANS the court-side rule must not read a second time; see
  // `policeReasonSpans` below. `\s+` rather than a single literal space because the span is now
  // load-bearing: "prosecutions  declined" has to be recognized as the same phrase.
  /\bprosecutions?\s+(?:was\s+|were\s+)?declin\w*/i,
  /\bdeclined\s+(?:to\s+)?prosecut\w*/i,
  /\bdeclination(?:s)?\b/i,
  /\bextradition (?:was )?denied\b/i,
  /\bvictim refused to cooperate\b/i,
  /\bdeath of (?:the )?offender\b/i,
];

/**
 * Genuine court-process referents. None of these is recorded by a police agency in any
 * dataset here, so a question that is ABOUT one of them cannot be answered.
 */
const COURT_PROCESS_REFERENTS = [
  /\bconvict(?:ed|ion|ions)\b/i,
  /\bacquit\w*/i,
  /\bsentenc(?:e|ed|es|ing)\b/i,
  /\bincarcerat\w*/i,
  /\bprison population\b/i,
  /\bjail population\b/i,
  /\binmates?\b/i,
  /\bplea (?:deal|bargain|agreement)s?\b/i,
  /\bdefendants?\b/i,
  /\bcourt (?:case|outcome|disposition|record)s?\b/i,
  /\btrials?\b/i,
  /\bbail\b/i,
  /\bfines? (?:and|or) fees?\b/i,
  /\bcharges? (?:were )?filed\b/i,
];

/**
 * "prosecution" used as a court process rather than as a clearance reason.
 *
 * WHAT WAS MISSING (2026-09-25, Cause A). The list below already covered the rate and the
 * actor. It did not cover the request that asks HOW MANY prosecutions there were -- so
 * "the number or percentage of gun prosecutions per year" (GC-005) classified as
 * `not_applicable`, and the reader was told to restate the question with a place, offense
 * and date range. No restatement can produce a prosecution count from a police record.
 *
 * WHY THE PLURAL, AND NOT THE BARE WORD. Adding `prosecution` as a universal trigger is the
 * defect this whole module exists to prevent: `cleared_B = "Prosecution declined"` is a
 * police clearance reason, and a question about it is answerable. The plural noun names
 * court cases brought, which no dataset here records -- except when the plural IS the police
 * reason, which is settled by occurrence rather than by word order; see below.
 *
 * WHAT THE FIRST VERSION GOT WRONG (2026-09-25 review, item A1). It excluded the police form
 * with a lookahead -- `prosecutions` not followed by "declined". That covers one word order
 * only. "Show declined prosecutions by state" puts the verb FIRST, so the lookahead saw
 * "prosecutions by state", the court rule fired alongside the police rule, and the request
 * became `mixed`. Nothing refused it, but `applyResultDisclosures` consumes `mixed` and
 * appended "The court and corrections part isn't in any dataset here, so I've left it out
 * rather than guessing" to an answer whose question had asked for no court part. A false
 * statement about our own coverage is worse than the missing recognition it was fixing.
 *
 * The lookahead is gone, replaced by the occurrence test below, which subsumes it in both
 * word orders. No word-order catalogue and no police-side precedence rule: a separately
 * stated prosecution rate or conviction request is a DIFFERENT occurrence and still counts.
 */
const PROSECUTION_AS_COURT = [
  /\bprosecution rate/i,
  /\bprosecuted (?:successfully|in court)/i,
  /\bwent to trial\b/i,
  /\bprosecutor'?s? office\b/i,
  /\bcharging decisions?\b/i,
  /\bprosecutions\b/i,
  /\bprosecution (?:counts?|numbers?|totals?|filings?|cases?)\b/i,
];

const any = (patterns: RegExp[], q: string) => patterns.some(p => p.test(q));

type Span = [start: number, end: number];

/** Every match of `pattern` in `q`, as spans. The source patterns are not global; these are. */
function spansOf(pattern: RegExp, q: string): Span[] {
  const scan = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g");
  const found: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = scan.exec(q)) !== null) {
    found.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) scan.lastIndex++;   // a zero-width match would loop forever
  }
  return found;
}

/** The stretches of the question already serving as a named police clearance reason. */
function policeReasonSpans(q: string): Span[] {
  return POLICE_CLEARANCE_REASONS.flatMap((pattern) => spansOf(pattern, q));
}

const PROSECUTION_WORD = /\bprosecut\w*/i;

/**
 * Does this court-side match rest ONLY on prosecution words that are already the police phrase?
 *
 * "Show declined prosecutions by state" has one occurrence of the word, and it belongs to
 * "declined prosecutions". Counting it a second time as a court request invents a court half
 * the reader never asked for. "Show declined prosecutions and the prosecution rate" has two,
 * and the second one is a real court request, so the match stands.
 *
 * A match with no prosecution word in it at all -- "went to trial", "charging decisions" --
 * is never consumed this way; there is nothing for the police phrase to have claimed.
 */
function restsOnPoliceOccurrence(matchText: string, matchStart: number, police: Span[]): boolean {
  const words = spansOf(PROSECUTION_WORD, matchText)
    .map(([s, e]): Span => [matchStart + s, matchStart + e]);
  if (words.length === 0) return false;
  return words.every(([s, e]) => police.some(([ps, pe]) => s >= ps && e <= pe));
}

/** Whether the question asks about prosecution AS A COURT PROCESS, by occurrence. */
function asksProsecutionAsCourt(q: string): boolean {
  const police = policeReasonSpans(q);
  return PROSECUTION_AS_COURT.some((pattern) =>
    spansOf(pattern, q).some(([start, end]) =>
      !restsOnPoliceOccurrence(q.slice(start, end), start, police)));
}

/**
 * Decide what a question is asking about.
 *
 * The order encodes Decision 1's referent rule: an explicit police-clearance reason wins
 * over a bare court-sounding word, because that is what the data actually holds.
 */
export function classifyClearanceReferent(question: string): ReferentDecision {
  const q = question ?? "";

  const hasPoliceReason = any(POLICE_CLEARANCE_REASONS, q);
  const hasClearanceContext = any(POLICE_CLEARANCE_CONTEXT, q);
  const hasCourtReferent = any(COURT_PROCESS_REFERENTS, q);
  const prosecutionAsCourt = asksProsecutionAsCourt(q);

  // A named police clearance reason, or a clearance question, is about the police record.
  const policeSide = hasPoliceReason || hasClearanceContext;

  if (policeSide && (hasCourtReferent || prosecutionAsCourt)) {
    // Both referents are present — e.g. "clearance rates and prison population".
    // Decision 1 requires answering the police half rather than refusing everything.
    return {
      referent: "mixed",
      reason: "the question asks about a police clearance and also about a court-process topic",
      refuseWholeRequest: false,
    };
  }
  if (policeSide) {
    return {
      referent: "police_record",
      reason: hasPoliceReason
        ? "the question names a police clearance reason recorded in the data"
        : "the question is about case clearance, which the police record holds",
      refuseWholeRequest: false,
    };
  }
  if (hasCourtReferent || prosecutionAsCourt) {
    return {
      referent: "court_process",
      reason: "the question's subject is a court process no dataset here records",
      refuseWholeRequest: true,
    };
  }
  return { referent: "not_applicable", reason: "neither referent is present", refuseWholeRequest: false };
}

/**
 * Whether a capability rule may refuse this question outright as a court-outcome topic.
 *
 * `asksOutOfScopeTopic` calls this. Returning false does NOT assert the question is
 * answerable — only that it must not be refused on this ground.
 */
export function mayRefuseAsCourtProcess(question: string): boolean {
  return classifyClearanceReferent(question).refuseWholeRequest;
}

/**
 * The reader-facing explanation for a court-process request.
 *
 * WHY IT LIVES HERE. Two places need it — the `out-of-scope-override` guardrail, and the routes'
 * no-SQL terminal exits, which return before that guardrail ever runs. Copying the wording into the
 * routes would leave two policies to drift apart, so the referent module that decides the question
 * also owns the sentence.
 *
 * WHAT IT DELIBERATELY DOES NOT SAY. The absence claim is limited to court and corrections records.
 * It affirms that reported crime IS tracked and never asserts that a whole request is unsupported —
 * GC-010 asks for a violent-crime series alongside prison population, and the crime half is
 * answerable even though this classifier currently refuses the request as a whole.
 */
export function buildCourtProcessExplanation(question: string): string {
  const match = (question ?? "").match(
    // Plurals are matched because the question that prompted this repair used one: "gun
    // prosecutions". Without them the sentence falls back to "that topic", which is accurate
    // but tells the reader less than the question already said. This list FORMATS an
    // explanation after the decision is taken; it classifies nothing.
    /\b(prosecutions?|convictions?|sentences?|incarceration|prison population|jail population|fines|fees|bail|immigration status|GARS|GVRS|gun violence restraining|red flag law|defendants?)\b/i
  );
  const topic = match ? match[1] : "that topic";
  return `This database tracks reported crime incidents, not court outcomes or policy data. It does not contain information about ${topic}. The data covers crime reports filed by law enforcement agencies — not what happens after arrest. I can provide clearance rates (whether a case was resolved by arrest or exceptional means), but not convictions, sentences, or other court outcomes.`;
}

/** The sentence used when only part of a mixed request can be answered. */
export const MIXED_REFERENT_NOTE =
  "I can answer the police-clearance part of this. The court and corrections part isn't in any dataset here, so I've left it out rather than guessing.";
