/**
 * Stage 3b: one "why" turn, end to end (plan r1-r1.4, amendment A1; round 2 plan r2 + r2.1). Called by ONE early branch
 * per route, after the outer request's own admission checks. Returns what the outer exits deliver; the route finalizes it
 * (narrative = the returned text) and emits it, outside any inner run.
 *
 *   - no explanation span: null (the turn is not a "why" turn; nothing changes).
 *   - mixed (a data request outside the spans): the masked question runs as the turn's data part (inner mode "data");
 *     each sub-clause is explained from THAT answer's facts (R2.1', F5). When the data part delivers nothing, the
 *     sub-clauses that don't depend on it (a cause, W3) are still answered and tagged `why:independent-answered`.
 *   - why-only: W3 from the tab's own ledger; causes get the decline alone, with nothing rebuilt and no data path (round
 *     3, owner decision 2026-10-12: drop figures from cause answers); otherwise the earlier same-tab question is rebuilt
 *     (inner mode "rebuild") and explained.
 */
import { findExplanationSpans, maskSpans, hasDataRequest, type ExplanationSpan } from "./why-spans";
import { runInner, resultCapture, type InnerCapture } from "./why-scope";
import { subClauses, topicOf, answerTopic, w3, WHY_SENTENCES, type WhyAnswerFacts, type WhyTab } from "./why-answers";
import { normalizeHistoryWithSource, type SourceTaggedMessage } from "./chat-history";

export type WhyOutcome =
  | { kind: "text"; text: string; answered: boolean; tags: string[] }
  | { kind: "data"; text: string; capture: InnerCapture; tags: string[] };

export type WhyHooks = {
  tab: WhyTab;
  /** Re-enter this route's own POST with (question, history) and consume its whole response. */
  reenter: (question: string, history: { role: string; content: string; source?: string }[]) => Promise<void>;
};

const TAB_LABEL: Record<string, string> = { current: "Current Trends", historical: "Historical Library", nibrs: "NIBRS", shr: "Homicide Reports", hate_crime: "Hate Crime" };
const isWhyOnly = (q: string) => { const spans = findExplanationSpans(q); return spans.length > 0 && !hasDataRequest(maskSpans(q, spans)); };

/** The explained answer: the capture's own rows and chart, with the facts and notes paired with THAT emission (R2.4'). */
function factsOf(question: string, cap: InnerCapture): WhyAnswerFacts {
  const p = cap.payload;
  return {
    question,
    columns: Array.isArray(p.columns) ? (p.columns as string[]) : [],
    rows: Array.isArray(p.rows) ? (p.rows as Record<string, unknown>[]) : [],
    chartConfig: (p.chartConfig as WhyAnswerFacts["chartConfig"]) ?? null,
    notes: cap.notes,
    facts: cap.facts,
  };
}
/** The text the reader saw for the data part: a streamed explanation event after the result wins over the result's own. */
function displayedIn(captures: InnerCapture[], cap: InnerCapture): string {
  const after = captures.slice(captures.indexOf(cap) + 1).filter((c) => typeof c.payload.text === "string");
  return after.length ? String(after[after.length - 1].payload.text) : String(cap.payload.explanation ?? "");
}

/** The inner request: the outer request's URL and headers, with this turn's question and history (A1). */
export function innerRequest(req: Request, body: Record<string, unknown>, question: string, history: unknown[]): Request {
  return new Request(req.url, { method: "POST", headers: req.headers, body: JSON.stringify({ ...body, question, history }) });
}
const hasRows = (cap: InnerCapture) => Array.isArray(cap.payload.rows) && (cap.payload.rows as unknown[]).length > 0;
const isK2 = (cap: InnerCapture) => {
  const g = (cap.input as { guardrails?: string[] } | null)?.guardrails ?? [];
  return g.includes("request-accounting-owner:followup");
};

/**
 * The sentences for every sub-clause of every span, explained from `f` (null: no answer to explain). `only` restricts to
 * the topics that don't depend on an answer (a mixed turn whose data part delivered nothing).
 */
function explainClauses(spans: ExplanationSpan[], f: WhyAnswerFacts | null, tab: WhyTab, only?: ("cause" | "W3")[]): { text: string; answered: boolean; any: boolean } {
  const out: string[] = []; let answered = true; let any = false;
  // Round 3 (R3.0' 4): a sentence already said in this turn is not repeated (one cause decline; a field asked twice).
  const say = (sentence: string) => { if (!out.includes(sentence)) out.push(sentence); };
  for (const span of spans) for (const sub of subClauses(span.clause, tab, f)) {
    if (only && !only.includes(sub.topic as "cause" | "W3")) continue;
    any = true;
    if (sub.topic === "W3") { say(w3(sub.text, tab)); continue; }
    // Owner decision (2026-10-12): a cause gets the decline alone, never a figure or a correction.
    if (sub.topic === "cause") { say(WHY_SENTENCES.cause(tab)); answered = false; continue; }
    if (sub.topic === "unsupported" || !f) { say(WHY_SENTENCES.unsupported(sub.text, sub.leftover)); answered = false; continue; }
    const sentence = answerTopic(sub.topic, sub.text, f, tab);
    if (sentence) say(sentence);
    else { say(WHY_SENTENCES.notRecorded(`what's needed to explain why ${sub.text}`)); answered = false; }
  }
  return { text: out.join(" "), answered, any };
}

export async function handleWhyTurn(question: string, rawHistory: unknown, hooks: WhyHooks): Promise<WhyOutcome | null> {
  const spans = findExplanationSpans(question);
  if (!spans.length) return null;
  const topics = spans.flatMap((s) => subClauses(s.clause, hooks.tab, null).map((x) => x.topic));
  const tags = ["why-turn", ...[...new Set(topics)].map((t) => `why-topic:${t}`)];
  const history = normalizeHistoryWithSource(rawHistory, 50);
  const plainHistory = history.map((h) => ({ role: h.role, content: h.content, ...(h.source ? { source: h.source } : {}) }));
  const masked = maskSpans(question, spans);

  // ---- mixed: the data part is the turn's own question; every sub-clause is explained from ITS answer (F5).
  if (hasDataRequest(masked)) {
    const s = await runInner("data", () => hooks.reenter(masked, plainHistory));
    const cap = resultCapture(s);
    if (!cap) return { kind: "text", text: WHY_SENTENCES.cantRebuild, answered: false, tags: [...tags, "why:no-capture"] };
    if (!hasRows(cap)) {
      // F1: sub-clauses that don't depend on the undelivered data answer (a cause, W3) are still answered; the rest are
      // declined with the data part (its own sentence). The data part's disposition governs the outcome (R2.6').
      const extra = explainClauses(spans, null, hooks.tab, ["cause", "W3"]);
      return { kind: "data", text: `${displayedIn(s.captures, cap)} ${extra.text}`.trim(), capture: cap, tags: [...tags, "why:data-declined", ...(extra.any ? ["why:independent-answered"] : [])] };
    }
    const why = explainClauses(spans, factsOf(masked, cap), hooks.tab);
    return { kind: "data", text: `${displayedIn(s.captures, cap)} ${why.text}`.trim(), capture: cap, tags: [...tags, "why:mixed"] };
  }

  // ---- why-only, W3: the tab's own ledger, no rebuild.
  if (topics.every((t) => t === "W3")) return { kind: "text", text: explainClauses(spans, null, hooks.tab).text, answered: true, tags: [...tags, "why:source-facts"] };

  // ---- why-only, causes (with or without W3): neither needs an answer, so nothing is rebuilt and no data path runs
  // (R3.0', owner decision 2026-10-12).
  if (topics.every((t) => t === "cause" || t === "W3")) return { kind: "text", text: explainClauses(spans, null, hooks.tab).text, answered: false, tags: [...tags, "why:cause"] };

  // ---- why-only: the target turn (F2, R2.2). The tab boundary is checked FIRST; only same-tab (or untagged) why-only
  // turns are skipped.
  const users = history.map((h, i) => ({ h, i })).filter((x) => x.h.role === "user");
  let target: { h: SourceTaggedMessage; i: number } | null = null;
  for (let k = users.length - 1; k >= 0; k -= 1) {
    const src = users[k].h.source;
    if (src && src !== hooks.tab) return { kind: "text", text: WHY_SENTENCES.otherTab(TAB_LABEL[src] ?? src), answered: false, tags: [...tags, "why:other-tab"] };
    if (isWhyOnly(users[k].h.content)) continue;
    target = users[k]; break;
  }
  if (!target) {
    // P1 (R3.0'): with no earlier answer, no data path runs. A cause sub-clause gets the decline (with the other
    // sub-clauses' own sentences); otherwise there is nothing to explain.
    if (topics.includes("cause")) return { kind: "text", text: explainClauses(spans, null, hooks.tab).text, answered: false, tags: [...tags, "why:cause"] };
    return { kind: "text", text: WHY_SENTENCES.noPrevious, answered: false, tags: [...tags, "why:no-previous"] };
  }

  // ---- rebuild the earlier question from USER turns only (nothing manufactured), with the model blocked.
  const prefix = history.slice(0, target.i).filter((h) => h.role === "user").map((h) => ({ role: h.role, content: h.content, ...(h.source ? { source: h.source } : {}) }));
  const s = await runInner("rebuild", () => hooks.reenter(target!.h.content, prefix));
  if (s.blocked) return { kind: "text", text: WHY_SENTENCES.cantRebuild, answered: false, tags: [...tags, "why:rebuild-blocked"] };
  const cap = resultCapture(s);
  if (!cap) return { kind: "text", text: WHY_SENTENCES.cantRebuild, answered: false, tags: [...tags, "why:no-capture"] };
  if (!hasRows(cap)) {
    const said = displayedIn(s.captures, cap);
    return { kind: "text", text: isK2(cap) ? WHY_SENTENCES.k2(said) : WHY_SENTENCES.earlierDeclined(said), answered: false, tags: [...tags, isK2(cap) ? "why:k2" : "why:earlier-declined"] };
  }
  const why = explainClauses(spans, factsOf(target.h.content, cap), hooks.tab);
  return { kind: "text", text: `${WHY_SENTENCES.lead(target.h.content)} ${why.text}`, answered: why.answered, tags: [...tags, "why:rebuilt"] };
}

/** Exposed for tests: the topic of a clause with no answer at hand. */
export const topicOfClause = (clause: string): string => topicOf(clause);
