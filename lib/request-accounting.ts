/**
 * Request accounting: no delivered answer may quietly drop part of the question it answers.
 *
 * WHY THIS EXISTS (owner rule, 2026-10-07): "if there's a question about murder via banana in Texas
 * it should say it can't do murder via banana". Saved answers dropped restrictions they did not
 * understand ("limited to immigrants", "through July", "median age") and returned a confident,
 * broader number. Phrase-by-phrase fixes failed in both directions for three rounds (GC-102), so the
 * guarantee is procedural instead: every non-space character of the request belongs to a recorded
 * PART, every part ends in exactly one STATE, and only `applied` and `context` parts let a number out.
 *
 * The mechanics are the city-ranking ledger's (lib/city-ranking.ts, unchanged in stage 1):
 *   - a claim that overlaps an existing one is REFUSED, never merged;
 *   - an OBLIGATION is recorded apart from the part, so losing a part cannot erase what was asked;
 *   - outer residue (text no part covers) and interior residue (text inside a part that the part did
 *     not explain) are both accounted for -- a broad match is not evidence its interior was understood.
 *
 * WHAT IS NEW is the state. Recognition decides `not-recorded`, `not-interpreted` and `context`;
 * every other recognized part starts `recognized` and stays BLOCKING until the planner that owns its
 * clause binds it (`applied`) or declares it cannot (`not-applied-here`). Residue is `not-interpreted`.
 *
 * CLAUSES. A part belongs to one answer clause. Blocking is per clause (Codex plan r1 clarification):
 * an unsupported part blocks the clause that owns it, and the full ledger is kept so the unsupported
 * clause is disclosed rather than lost. Single-clause requests use clause 0.
 */

export type Span = [number, number];

/** Terminal states, plus `recognized` -- understood, not yet bound by an owning planner. */
export type PartState =
  | "recognized"
  | "applied"
  | "not-recorded"
  | "not-interpreted"
  | "not-applied-here"
  | "context";

export type Part = {
  /** A typed concept: "place", "period", "weapon", "victim-sex", "immigration-status", "purpose", ... */
  concept: string;
  /** The recognized value, when there is one ("Firearm", "Female", "TX"). */
  value: string | null;
  span: Span;
  text: string;
  /** Sub-spans the recognizer actually explained. Defaults to the whole span. */
  explains: Span[];
  clause: number;
  /** The rule that recognized it, for evidence. */
  rule: string;
  state: PartState;
  /** Reader-facing sentence for a non-applied terminal state. */
  explanation: string | null;
  /**
   * Carried from an earlier turn that this turn does not restate (a follow-up fragment no planner
   * reconstructed). Its span and text are in that earlier question, not this one.
   */
  inherited?: boolean;
};

export type Obligation = { concept: string; span: Span; key: string; text: string; clause: number };

export type PartInput = {
  concept: string;
  value?: string | null;
  span: Span;
  explains?: Span[];
  clause?: number;
  rule: string;
  state?: Exclude<PartState, "applied" | "not-applied-here">;
  explanation?: string | null;
};

const spanKey = (span: Span): string => `${span[0]}:${span[1]}`;

/** Runs of non-space text in `[from, to)` for which `covered` is false. */
export function gaps(
  text: string, covered: (index: number) => boolean, within?: Span,
): { text: string; span: Span }[] {
  const [from, to] = within ?? [0, text.length];
  const out: { text: string; span: Span }[] = [];
  let start = -1;
  for (let i = from; i <= to; i += 1) {
    const open = i < to && !covered(i) && !/\s/.test(text[i]);
    if (open && start < 0) start = i;
    if (!open && start >= 0) { out.push({ text: text.slice(start, i), span: [start, i] }); start = -1; }
  }
  return out;
}

/** Punctuation alone carries no meaning to account for. */
const PUNCTUATION_ONLY = /^[\p{P}\p{S}]+$/u;

export class RequestLedger {
  readonly parts: Part[] = [];
  readonly obligations: Obligation[] = [];
  private readonly taken: boolean[];
  private finalized = false;

  constructor(readonly question: string) {
    this.taken = new Array(question.length).fill(false);
  }

  overlaps([start, end]: Span): boolean {
    for (let i = start; i < end; i += 1) if (this.taken[i]) return true;
    return false;
  }

  /** Record a part. Refused (false) when empty, overlapping, or after finalize(). */
  record(input: PartInput): boolean {
    if (this.finalized) return false;
    const [start, end] = input.span;
    if (!(end > start) || start < 0 || end > this.question.length) return false;
    if (this.overlaps(input.span)) return false;
    for (let i = start; i < end; i += 1) this.taken[i] = true;
    const text = this.question.slice(start, end);
    const clause = input.clause ?? 0;
    // Recorded BEFORE the part: an obligation survives the loss of the part that would discharge it.
    this.obligations.push({ concept: input.concept, span: input.span, key: spanKey(input.span), text, clause });
    this.parts.push({
      concept: input.concept,
      value: input.value ?? null,
      span: input.span,
      text,
      explains: input.explains ?? [input.span],
      clause,
      rule: input.rule,
      state: input.state ?? "recognized",
      explanation: input.explanation ?? null,
    });
    return true;
  }

  /** Every stretch of non-space text no part covers. */
  residue(): { text: string; span: Span }[] {
    return gaps(this.question, (i) => this.taken[i]);
  }

  /** Every stretch of non-space text inside a part that the part did not explain. */
  interiorResidue(): { text: string; span: Span; part: Part }[] {
    const out: { text: string; span: Span; part: Part }[] = [];
    for (const part of this.parts) {
      const explained = new Array(this.question.length).fill(false);
      for (const [s, e] of part.explains) for (let i = s; i < e; i += 1) explained[i] = true;
      for (const piece of gaps(this.question, (i) => explained[i], part.span)) out.push({ ...piece, part });
    }
    return out;
  }

  /**
   * Close recognition: residue and unexplained interiors become `not-interpreted` parts.
   * Punctuation-only residue is the one thing dropped, and it is dropped visibly (as `context`).
   */
  finalize(clauseOf: (span: Span) => number = () => 0): this {
    if (this.finalized) return this;
    for (const piece of this.interiorResidue()) {
      if (PUNCTUATION_ONLY.test(piece.text)) continue;
      // The owning part did not understand all of itself: it cannot be applied as recognized.
      if (piece.part.state === "recognized" || piece.part.state === "context") {
        piece.part.state = "not-interpreted";
        piece.part.explanation = couldNotInterpret(piece.part.text);
      }
    }
    for (const piece of this.residue()) {
      const punctuation = PUNCTUATION_ONLY.test(piece.text);
      this.record({
        concept: punctuation ? "punctuation" : "unrecognized",
        span: piece.span,
        clause: clauseOf(piece.span),
        rule: punctuation ? "punctuation" : "residue",
        state: punctuation ? "context" : "not-interpreted",
        explanation: punctuation ? null : couldNotInterpret(piece.text),
      });
    }
    this.finalized = true;
    return this;
  }

  isFinalized(): boolean { return this.finalized; }

  /**
   * Carry parts from an earlier turn into this request (after finalize: they take no characters of
   * this question). Each keeps its recognition state, so an earlier not-recorded restriction refuses
   * again, and a recognized one must be bound like any other part.
   */
  inherit(parts: Part[]): void {
    if (!this.finalized) throw new Error("RequestLedger.inherit before finalize()");
    for (const part of parts) this.parts.push({ ...part, clause: 0, inherited: true });
  }

  /** Every obligation whose own span no longer holds a part. Always empty in correct operation. */
  undischarged(): Obligation[] {
    const held = new Set(this.parts.filter((p) => !p.inherited).map((p) => spanKey(p.span)));
    return this.obligations.filter((o) => !held.has(o.key));
  }

  clauses(): number[] {
    return [...new Set(this.parts.map((p) => p.clause))].sort((a, b) => a - b);
  }

  partsOf(clause: number): Part[] {
    return this.parts.filter((p) => p.clause === clause);
  }

  /**
   * A planner that OWNS `clause` declares what its plan applies -- a set of concepts, or a predicate
   * over the part itself (so a planner applies the places it actually resolved, not every place).
   * Every `recognized` part of that clause it applies becomes `applied`; every other `recognized` part becomes
   * `not-applied-here`, worded with `cannot(part)`. Terminal states are never overwritten.
   * Requires finalize() first, so residue cannot be bound away.
   */
  bind(clause: number, applies: ReadonlySet<string> | ((part: Part) => boolean), cannot: (part: Part) => string): void {
    if (!this.finalized) throw new Error("RequestLedger.bind before finalize()");
    const test = typeof applies === "function" ? applies : (part: Part) => applies.has(part.concept);
    for (const part of this.partsOf(clause)) {
      if (part.state !== "recognized") continue;
      if (test(part)) {
        part.state = "applied";
      } else {
        part.state = "not-applied-here";
        part.explanation = cannot(part);
      }
    }
  }

  /** Parts of `clause` that stop a number: anything not `applied` or `context`. */
  blocking(clause: number): Part[] {
    return this.partsOf(clause).filter((p) => p.state !== "applied" && p.state !== "context");
  }

  /** Parts that stop a number before any planner runs: recognition-time refusals. */
  refusedAtRecognition(): Part[] {
    return this.parts.filter((p) => p.state === "not-recorded" || p.state === "not-interpreted");
  }

  /** Evidence: one row per part, in written order. */
  evidence(): { concept: string; value: string | null; text: string; span: Span; clause: number; rule: string; state: PartState }[] {
    return [...this.parts]
      .sort((a, b) => a.span[0] - b.span[0])
      .map(({ concept, value, text, span, clause, rule, state }) => ({ concept, value, text, span, clause, rule, state }));
  }
}

/* ================================================================== *
 * Shared context and filler rules -- each paired in scripts/test-request-accounting.ts
 * ================================================================== */

/**
 * Conversation openers. Leading only: the same words mid-request are not context.
 * Negations, numbers, units, periods and `and`/`or` never appear in any context rule.
 */
const OPENERS: { rule: string; pattern: RegExp }[] = [
  // Round 1 step B (STEP-B-LEFTOVER-RULE-r2.md; Codex ACCEPT-WITH-CHANGES): two closed leading openers seen in real
  // traffic. Listed FIRST because only the first matching opener is recorded, and the generic question/yes-no openers
  // would otherwise take only their first words. The words after them go through ordinary recognition.
  // dataset-opener: L9015, L9060, L9062, L9063, L9066 ("dataset of" without "create" is not an opener: L9067).
  { rule: "dataset-opener", pattern: /^\s*(?:is\s+it\s+possible\s+to\s+|(?:can|could)\s+you\s+|please\s+)?create\s+(?:a\s+|me\s+a\s+)?dataset\s+(?:of|for)\s+/i },
  // tell-me-opener: L9552, L9554, L2577.
  { rule: "tell-me-opener", pattern: /^\s*what\s+(?:data\s+)?can\s+you\s+tell\s+me\s+about\s+/i },
  // Round 1 W22 ("make that monthly" after a complete question): a leading "make it/that" points back at the earlier answer
  // and restricts nothing; the route's follow-up reconstruction decides what is carried, and the K2 check still requires
  // every earlier restriction. Leading only, like every opener.
  // Codex build review (W22): only the singular forms, which the follow-up detector also reads as a change to the earlier
  // answer ("make it|this|that"), so the turn always reaches reconstruction and K2; "make them/those" stays residue.
  { rule: "make-it-opener", pattern: /^\s*(?:(?:ok(?:ay)?|now|please)[,!.]?\s+)?(?:(?:can|could)\s+you\s+)?make\s+(?:it|that|this)\s+/i },
  // Follow-up openers. The inherited conditions themselves come from the route's reconstruction;
  // these words only open the turn ("what about Ohio?", "same for 2024").
  { rule: "followup-opener", pattern: /^\s*(?:(?:ok(?:ay)?|great|thanks|cool|got\s+it)[,!.]?\s+)?(?:(?:and\s+)?(?:what|how)\s+about|and\s+(?:for|in)|(?:the\s+)?same\s+(?:thing\s+)?(?:for|in)|(?:and\s+)?now(?:\s+(?:do|show|give\s+me|try))?|also|then|ok(?:ay)?|now\s+give\s+me)\s+(?:the\s+)?/i },
  { rule: "request-opener", pattern: /^\s*(?:(?:hi|hello|hey)[,!.]?\s+)?(?:please\s+)?(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:show|list|give|tell|display|find|get|pull|provide|break\s+down)\s+(?:me\s+|us\s+)?(?:about\s+(?:how\s+)?)?(?:the\s+)?/i },
  { rule: "how-opener", pattern: /^\s*(?:please\s+)?how\s+(?:did|has|have|does|do|is|are|was|were)\s+(?:the\s+)?/i },
  { rule: "question-opener", pattern: /^\s*(?:(?:hi|hello|hey)[,!.]?\s+)?(?:please\s+)?(?:what(?:['’]s(?=\s))?|how\s+many|how\s+much)\s+(?:are\s+|is\s+|were\s+|was\s+)?(?:the\s+)?(?:number\s+of\s+|total\s+(?:number\s+of\s+)?|count\s+of\s+)?/i },
  { rule: "see-opener", pattern: /^\s*(?:please\s+)?(?:can|could|may)\s+i\s+(?:please\s+)?(?:see|get|have|view|look\s+at)\s+(?:the\s+)?/i },
  { rule: "need-opener", pattern: /^\s*(?:please\s+)?i\s+(?:want|need)\s+(?:to\s+(?:see|know)\s+)?(?:the\s+)?/i },
  // Option 3 batch 1 (OVER-REFUSAL-PLAN-r3.md, table A): "let's look at", "let's see" and "calculate the" open a request and
  // restrict nothing. The calculation itself ("percent change", "rate") is recognized by the source's own rules.
  // Option 3 batch 1 (P041): a leading "yes"/"sure" opens the turn and restricts nothing (an inherited choice comes from the
  // route's own follow-up reconstruction, never from this word).
  { rule: "yes-opener", pattern: /^\s*(?:yes|yeah|yep|sure)[,.!]?\s+/i },
  { rule: "lets-opener", pattern: /^\s*(?:(?:ok(?:ay)?|so|now)[,!.]?\s+)?let(?:['’]s|\s+us|\s+me)\s+(?:look\s+at|see|check(?:\s+out)?|take\s+a\s+look\s+at)\s+(?:the\s+)?/i },
  { rule: "calculate-opener", pattern: /^\s*(?:please\s+)?(?:(?:can|could|would)\s+you\s+(?:please\s+)?)?(?:calculate|compute|work\s+out)\s+(?:me\s+)?(?:the\s+)?/i },
  { rule: "yesno-opener", pattern: /^\s*(?:is|are|was|were|does|do|did|has|have|had)\s+(?:there\s+)?/i },
  { rule: "want-opener", pattern: /^\s*(?:please\s+)?i(?:'d|\s+would)\s+like\s+(?:to\s+(?:see|know)\s+)?(?:the\s+)?/i },
];

const TRAILING_POLITE = /[\s,]*(?:please|thanks|thank\s+you)[\s?.!]*$/i;
const TRAILING_PUNCTUATION = /[\s?.!]+$/;

/**
 * A stated purpose. Context ONLY as a whole clause ending the request, and only when nothing inside
 * it could restrict the answer: a restriction connector or a negation inside the purpose words
 * ("for a report limited to immigrants") means it is NOT context, and those words are left for the
 * source's recognizers -- a purpose phrase cannot swallow a restriction (Codex plan r0 #5).
 */
const PURPOSE = /\b(?:for|in)\s+(?:a|an|my|our|the|this|his|her|their)\s+((?:[A-Za-z][\w'-]*\s+){0,5}?)(?:report|article|story|presentation|class|paper|project|study|assignment|briefing|memo|newsletter|podcast|piece|thesis|dissertation|grant(?:\s+application)?|slide(?:\s+deck)?|deck)\b[\s?.!]*$/i;
const RESTRICTION_INSIDE = /\b(?:limited|limit|only|just|who|whom|whose|which|where|among|excluding|exclude|except|without|with|via|by|of|on|about|involving|that|not|no|never|under|over|aged|age|between|before|after|during|since|until|through|per)\b|\d/i;

/**
 * In-between filler: linking words standing between two recorded parts. They link; they never
 * restrict. Negations, numbers, periods and `and`/`or` are absent and must stay absent.
 */
const BETWEEN_FILLER = /^(?:the|a|an|in|for|at|to|from|of|on|as|with|by|that|there|which|who|whose|is|are|was|were|be|been|being|had|have|has|did|do|does|happened|happen|happens|occurred|occur|occurs|committed|took|take|place|saw|see|get|got|recorded|reported|it|its|their|they|them|those|these|this)$/i;

/** Record leading openers, a trailing politeness word, a whole trailing purpose clause and trailing punctuation as `context`. */
export function recordContext(ledger: RequestLedger): void {
  const q = ledger.question;
  let end = q.length;
  const punct = TRAILING_PUNCTUATION.exec(q);
  if (punct && punct[0].trim()) {
    ledger.record({ concept: "punctuation", span: [punct.index, q.length], rule: "trailing-punctuation", state: "context" });
    end = punct.index;
  }
  const polite = TRAILING_POLITE.exec(q.slice(0, end));
  if (polite && polite[0].trim()) {
    const lead = polite[0].length - polite[0].replace(/^[\s,]+/, "").length;
    if (ledger.record({ concept: "politeness", span: [polite.index + lead, end], rule: "trailing-polite", state: "context" })) end = polite.index;
  }
  const purpose = PURPOSE.exec(q.slice(0, end));
  if (purpose && !RESTRICTION_INSIDE.test(purpose[1] ?? "")) {
    ledger.record({ concept: "purpose", span: [purpose.index, purpose.index + purpose[0].replace(/[\s?.!]+$/, "").length], rule: "purpose-clause", state: "context" });
  }
  for (const { rule, pattern } of OPENERS) {
    const m = pattern.exec(q);
    if (m && m[0].trim()) {
      const len = m[0].replace(/\s+$/, "").length;
      if (ledger.record({ concept: "opener", span: [m.index, m.index + len], rule, state: "context" })) break;
    }
  }
}

/**
 * After the source's recognizers: a single filler word standing between two recorded parts is
 * `context`. A filler word at either edge, or next to residue, stays residue.
 */
/**
 * Stage 3b round 2 (plan r1.3 / r2 R2.7): "broken down" immediately before "by" restricts nothing -- "robberies broken down
 * by month" asks for "robberies by month" -- so it is recorded as context. Every tab's accounting calls this.
 */
export function recordBrokenDown(ledger: RequestLedger): void {
  const m = /\bbroken\s+down(?=\s+by\b)/i.exec(ledger.question);
  if (!m) return;
  const span: Span = [m.index, m.index + m[0].length];
  if (ledger.parts.some((p) => p.span[0] < span[1] && span[0] < p.span[1])) return;
  ledger.record({ concept: "filler", span, rule: "broken-down", state: "context" });
}

export function recordBetweenFiller(ledger: RequestLedger): void {
  const q = ledger.question;
  for (const piece of ledger.residue()) {
    if (PUNCTUATION_ONLY.test(piece.text)) ledger.record({ concept: "punctuation", span: piece.span, rule: "punctuation", state: "context" });
  }
  const recorded = [...ledger.parts].sort((a, b) => a.span[0] - b.span[0]);
  const residue = ledger.residue();
  // Runs of consecutive filler words (only whitespace between them), each run bounded on both sides
  // by a recorded part. A run touching residue or an edge is not filler.
  let i = 0;
  while (i < residue.length) {
    if (!BETWEEN_FILLER.test(residue[i].text)) { i += 1; continue; }
    let j = i;
    while (j + 1 < residue.length && BETWEEN_FILLER.test(residue[j + 1].text) && /^\s*$/.test(q.slice(residue[j].span[1], residue[j + 1].span[0]))) j += 1;
    const start = residue[i].span[0];
    const end = residue[j].span[1];
    const before = /^\s*$/.test(q.slice(0, start)) || recorded.some((p) => p.span[1] <= start && /^\s*$/.test(q.slice(p.span[1], start)));
    const after = recorded.some((p) => p.span[0] >= end && /^\s*$/.test(q.slice(end, p.span[0])));
    if (before && after) {
      for (let k = i; k <= j; k += 1) ledger.record({ concept: "filler", span: residue[k].span, rule: "between-filler", state: "context" });
    }
    i = j + 1;
  }
}

/** The not-interpreted wording. Never phrased as a fact about the data (owner decision 1). */
export function couldNotInterpret(text: string): string {
  return `I couldn't interpret "${text.trim()}" in this question, so I haven't answered it with a number that ignores it.`;
}

/**
 * One reader-facing sentence per refused part, in written order, deduplicated.
 * Used by every accounting exit so the wording of a state is decided in one place.
 */
export function refusalSentences(parts: Part[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...parts].sort((a, b) => a.span[0] - b.span[0])) {
    const sentence = part.explanation ?? couldNotInterpret(part.text);
    if (seen.has(sentence)) continue;
    seen.add(sentence);
    out.push(sentence);
  }
  return out;
}
