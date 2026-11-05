"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewButton, PreviewResponse } from "@/lib/nibrs-shadow/preview";
import { PROFILES, joinAmp, leadOf, notesOf, seriesLabel, titleOf, type ChartKind as ContractKind, type ChoicePresentation, type Offer, type Presentation } from "@/lib/answer-contract/contract";
import AnswerChart, { type ChartKind, type Line, type Point } from "./AnswerChart";
import Logo from "./Logo";
import QuestionStrip, { type StripItem } from "./QuestionStrip";
import { StartPage } from "./StartPage";
import { Tour } from "./Tour";
import TOUR from "./tour-example.json";

/**
 * The Crime Data Assistant chat (spec: docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md).
 * One straight scroll: the question box pinned at the top, the newest question and its answer under it, one per screen.
 * Every typed question after the first is sent with the last answer's standalone question (`previous`), so the
 * engine's rewriter (P69) decides whether it is a follow-up; the read line shows what was answered.
 */
type Option = { label: string; question: string };
type Reply =
  | (PreviewResponse & { asked: string; rewrite?: string | null; presentation?: Presentation | ChoicePresentation; ms?: number })
  | { kind: "rewrite-ask"; why: string; options: Option[]; ms?: number }
  | { kind: "presentation"; asked: string; how: string; ms?: number }
  // The engine's coming confirm-before-run outcome for a model rewrite (stubbed until the engine returns it).
  | { kind: "proposal"; asked: string; question?: string; why?: string; options?: Option[]; ms?: number }
  | { kind: "error"; error: string };
type Asking = { question: string; path: string[] };
type Turn = { id: number; typed: string; question: string; path: string[]; reply: Reply | null; chart?: ChartMode; viaButton?: boolean;
  loading?: boolean;
  /** Whether this answer's source had not been spelled out earlier in the session: its lead spells it out. */
  firstMention?: boolean;
  /** One of the tour's fixed example turns (its steps find them by this). */
  tour?: "answer" | "decline" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const label = (v: unknown) => {
  const s = String(v ?? "");
  // Months as "January 2023"; quarters as "Q1 2023", as the engine's notes name them.
  return /^\d{4}-\d{2}$/.test(s) ? `${MONTHS[Number(s.slice(5)) - 1]} ${s.slice(0, 4)}` : /^\d{4}-Q[1-4]$/.test(s) ? `${s.slice(5)} ${s.slice(0, 4)}` : s;
};
// A percent column always shows its one decimal ("13.0"); counts show no decimals.
const cell = (v: unknown, pct = false) => (v === null || v === undefined ? "" : typeof v === "number"
  ? v.toLocaleString("en-US", pct ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 1 }) : label(v));
const MAX_BARS = 15;
type ChartMode = ChartKind | "table";
const KIND_LABEL: Record<ChartKind, string> = { line: "Line", bar: "Bar", hbar: "Horizontal bars", stacked: "Stacked bars", stacked100: "100% stacked", area: "Stacked area" };
/**
 * A chart-type command the page handles itself (P69, P73: a presentation change never asks the data engine again):
 * "bar graph", "show as bars", "make it a line chart", "stacked", "100% stacked", "vertical", "horizontal", "area",
 * "table only". Returns null for anything else. A type that doesn't fit the answer falls back to its default.
 */
function chartCommand(text: string): ChartMode | null {
  const t = text.toLowerCase().replace(/%/g, " percent ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(?:bars?|columns?)\b/g, " bar ")
    .replace(/\b(?:please|can|could|you|show|make|display|draw|turn|change|switch|put|give|me|it|this|that|them|the|chart|graph|instead|as|into|to|in|a|an|just|only)\b/g, " ")
    .replace(/\s+/g, " ").trim();
  if (/^(?:bar|vertical(?: bar)?|grouped(?: bar)?)$/.test(t)) return "bar";
  if (/^horizontal(?: bar)?$/.test(t)) return "hbar";
  if (/^lines?$/.test(t)) return "line";
  if (/^(?:100 percent|percent|100) stacked(?: bar)?$|^stacked(?: bar)? (?:100 percent|percent)$/.test(t)) return "stacked100";
  if (/^(?:stacked )?area$/.test(t)) return "area";
  if (/^stacked(?: bar)?$/.test(t)) return "stacked";
  return /^(?:tables?|no|data)$/.test(t) ? "table" : null;
}
// The dataviz skill's validated categorical order (references/palette.md, light mode): a category keeps its slot.
const SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const PERIOD = /^\d{4}(-\d{2}|-?Q[1-4])?$/;
// The contract's chart types as this page draws them (a grouped bar is the bar form of several lines).
const KIND: Record<ContractKind, ChartKind> = { line: "line", bar: "bar", horizontal_bar: "hbar", grouped_bar: "bar", stacked_bar: "stacked", stacked_100: "stacked100" };
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}${/[?.]$/.test(s) ? "" : "?"}`;

const TOUR_SEEN = "cda-tour-seen";
/** An answer's presentation (the engine's answer contract, lib/answer-contract), when the reply is an answer. */
const answerOf = (r: Reply | null): Presentation | null => (r && r.kind === "answer" && r.presentation && "lead" in r.presentation ? r.presentation : null);
/** The offers its lead carries inline, as links in plain words; every other button stays a button. */
const inlineOffers = (r: Reply | null): Offer[] => { const p = answerOf(r); return p ? leadOf(p).offers : []; };
const rest = (r: Reply, bs: PreviewButton[]) => bs.filter((b) => !inlineOffers(r).some((o) => o.label === b.label));

// The prefix the app is mounted under (next.config.ts basePath); Next does not add it to fetch() or <a>.
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export default function AssistantClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const next = useRef(1);
  const turnsRef = useRef<Turn[]>([]);
  const [scrollTo, setScrollTo] = useState<{ id: number; n: number } | null>(null);
  const scroll = (id: number) => setScrollTo((s) => ({ id, n: (s?.n ?? 0) + 1 }));
  const [inView, setInView] = useState<number | null>(null);

  // The question history: each question as answered; a follow-up (the rewriter's "rewrite", a button's continuation,
  // a redrawn chart) is a smaller mark under the question before it.
  const strip: StripItem[] = turns.map((t) => {
    const r = t.reply;
    const follow = !!t.viaButton || (!!r && ((r.kind === "answer" || r.kind === "clarify" || r.kind === "decline") && "rewrite" in r && r.rewrite === "rewrite"))
      || (!!r && r.kind === "answer" && !!t.chart);
    // A button's continuation and a redrawn chart say what was chosen or asked; the question above already says the rest.
    const text = t.viaButton || (r?.kind === "answer" && t.chart) ? t.typed : r && "asked" in r && r.asked ? r.asked : t.typed;
    return { id: t.id, text, follow };
  });
  // The answer in view: the last question whose top has passed just below the header.
  useEffect(() => {
    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        // The lowest question line that has passed the line just under the box; before any has, the one nearest the top.
        const line = (document.querySelector(".cda .Dock")?.getBoundingClientRect().bottom ?? 180) + 40;
        let cur: number | null = null, curTop = -Infinity, first: number | null = null, firstTop = Infinity;
        for (const t of turnsRef.current) {
          const top = document.getElementById(`me${t.id}`)?.getBoundingClientRect().top;
          if (top === undefined) continue;
          if (top <= line && top > curTop) { cur = t.id; curTop = top; }
          if (top < firstTop) { first = t.id; firstTop = top; }
        }
        // At the very bottom of the page the last question can't reach that line: take the lowest one on screen.
        if (innerHeight + scrollY >= document.documentElement.scrollHeight - 2) {
          for (const t of turnsRef.current) {
            const top = document.getElementById(`me${t.id}`)?.getBoundingClientRect().top;
            if (top !== undefined && top < innerHeight - 120 && top > curTop) { cur = t.id; curTop = top; }
          }
        }
        setInView(cur ?? first);
      });
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => { removeEventListener("scroll", onScroll); cancelAnimationFrame(raf); };
  }, [turns.length]);
  turnsRef.current = turns;
  const box = useRef<HTMLInputElement>(null);
  // The box's height, for the CSS that sizes each answer to the screen under it (--dock).
  const dockEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = dockEl.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty("--dock", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [turns.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  // "/" puts the cursor in the question box from anywhere on the page (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey || (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable))) return;
      e.preventDefault();
      box.current?.focus({ preventScroll: true });
      box.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  async function fetchReply(question: string, path: string[], previous?: string | null): Promise<Reply> {
    try {
      const res = await fetch(`${BASE}/api/assistant-query`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, path, ...(previous ? { previous } : {}) }) });
      const j = await res.json();
      return "error" in j ? { kind: "error", error: j.error } : (j as Reply);
    } catch (e) {
      return { kind: "error", error: e instanceof Error ? e.message : String(e) };
    }
  }

  async function run(typed: string, opts: { question?: string; path?: string[]; previous?: string | null; chart?: ChartMode; viaButton?: boolean } = {}) {
    const id = next.current++;
    const question = opts.question ?? typed, path = opts.path ?? [];
    setTurns((ts) => [...ts, { id, typed, question, path, reply: null, chart: opts.chart, viaButton: opts.viaButton }]);
    scroll(id);
    setBusy(true);
    let reply = await fetchReply(question, path, opts.previous);
    // Where the reply belongs (question and path), for the cache and the lead's offers.
    let at = path;
    // A presentation-only follow-up ("make it a bar chart") redraws the last answer, with its own path (a consistent
    // view stays one); no data question is asked (P69).
    if (reply.kind === "presentation") {
      const last = [...turnsRef.current].reverse().find((t) => t.reply?.kind === "answer");
      if (last && last.reply) { reply = { ...(last.reply as Extract<Reply, { kind: "answer" }>), ms: reply.ms }; at = last.path; }
    }
    const shown = reply;
    if (shown.kind !== "error" && "asked" in shown && shown.asked) seen.current.set(JSON.stringify([shown.asked, at]), shown);
    // A source is spelled out in the first answer from it in the session, then said short.
    const p = answerOf(shown), firstMention = !!p && !spelled.current.has(p.source);
    if (p) spelled.current.add(p.source);
    setTurns((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      return { ...t, reply: shown, question: "asked" in shown && shown.asked ? shown.asked : t.question, path: at, firstMention };
    }));
    scroll(id);
    setBusy(false);
  }

  // An offer in the lead reruns the answer in place: the same slot, the same question line, the new reply.
  // Replies already fetched, by question and path, so going back to a view (all agencies, a source) is instant.
  const seen = useRef(new Map<string, Reply>());
  // The sources spelled out so far in this session.
  const spelled = useRef(new Set<string>());
  async function rerun(id: number, asking: Asking) {
    const key = JSON.stringify([asking.question, asking.path]);
    let reply = seen.current.get(key);
    if (!reply) {
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, loading: true } : t)));
      reply = await fetchReply(asking.question, asking.path);
      if (reply.kind !== "error") seen.current.set(key, reply);
    }
    const shown = reply;
    const question = "asked" in shown && shown.asked ? shown.asked : asking.question;
    // An offer on another source spells that source out the first time, as a new answer would.
    const p = answerOf(shown), fresh = !!p && !spelled.current.has(p.source);
    if (p) spelled.current.add(p.source);
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, reply: shown, question, path: asking.path, loading: false, ...(fresh ? { firstMention: true } : {}) } : t)));
  }
  // The lead's offers (the Consistent Reporting Agencies and the way back, another source), in the engine's words:
  // links in plain words, each rerunning the answer in place (Jeff, 2026-11-01).
  const suggestions = (t: Turn): Suggestion[] => inlineOffers(t.reply).flatMap((o) => {
    const asking = "path" in o.run ? { question: t.question, path: o.run.path } : "question" in o.run ? { question: o.run.question, path: [] } : null;
    return o.text && asking ? [{ ...o.text, run: () => void rerun(t.id, asking) }] : [];
  });

  // A typed question follows up on the last answer the engine read (P69).
  const lastAsked = () => [...turns].reverse().find((t) => t.reply && "asked" in t.reply && t.reply.kind !== "presentation")?.question ?? null;
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    // A chart-type command redraws the last answer here, with no call to the engine.
    const mode = chartCommand(text);
    const last = [...turnsRef.current].reverse().find((t) => t.reply?.kind === "answer");
    if (mode && last?.reply) {
      const id = next.current++;
      setTurns((ts) => [...ts, { id, typed: text.trim(), question: last.question, path: [], reply: { ...(last.reply as Extract<Reply, { kind: "answer" }>), ms: 0 }, chart: mode }]);
      scroll(id);
      return;
    }
    const chart = /\bbar\b/i.test(text) ? "bar" : /\bline\b/i.test(text) ? "line" : /\btable\b/i.test(text) ? "table" : undefined;
    void run(text.trim(), { previous: lastAsked(), chart });
  };
  // A continuation follows the button's path; a question-only choice (P74) is asked as a new question.
  const click = (t: Turn, b: PreviewButton) => (b.kind === "question" && b.question
    ? void run(b.question)
    : void run(b.label, { question: t.question, path: b.path, viaButton: true }));

  // The newest answer is just under the box (Jeff, 2026-11-01: box at the top, newest first): go back up to it.
  useEffect(() => {
    if (!scrollTo) return;
    const raf = requestAnimationFrame(() => { if (scrollY > 0) window.scrollTo({ top: 0, behavior: "smooth" }); });
    return () => cancelAnimationFrame(raf);
  }, [scrollTo]);

  // The tour (Jeff, 2026-11-02): on a first visit, and from "Take the tour". While it runs, the page shows its fixed
  // example (an answer and a decline, no engine or model call); when it ends, the page is as it was.
  const [tourStep, setTourStep] = useState<number | null>(null);
  const beforeTour = useRef<Turn[]>([]);
  const startTour = () => {
    beforeTour.current = turnsRef.current;
    const answer = { ...(TOUR.answer.reply as unknown as Extract<Reply, { kind: "answer" }>) };
    const decline = { ...(TOUR.decline.reply as unknown as Extract<Reply, { kind: "decline" }>) };
    setTurns([
      { id: -2, typed: TOUR.decline.typed, question: decline.asked, path: [], reply: decline, firstMention: true, tour: "decline" },
      { id: -1, typed: TOUR.answer.typed, question: answer.asked, path: [], reply: answer, firstMention: true, tour: "answer" },
    ]);
    setTourStep(0);
  };
  const endTour = () => {
    setTourStep(null);
    setTurns(beforeTour.current);
    try { localStorage.setItem(TOUR_SEEN, "1"); } catch { /* storage unavailable: the tour may show again */ }
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    let seen = true;
    try { seen = !!localStorage.getItem(TOUR_SEEN); } catch { /* storage unavailable: don't show it unasked */ }
    if (!seen) startTour();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const start = turns.length === 0;
  const form = (
    <form className="AskForm" onSubmit={(e) => { e.preventDefault(); ask(input); setInput(""); }}>
      <div className="AskRow">
        <input ref={box} value={input} onChange={(e) => setInput(e.target.value)} placeholder={start ? "Shoplifting in Memphis by month in 2024" : "Ask a question or a follow-up"} aria-label="Question" />
        <button className="Ask" type="submit" disabled={busy}>Ask</button>
      </div>
      {/* On the start page only (Jeff, 2026-11-02): how to ask, and the tour. After a question the box's own placeholder says it. */}
      {start ? <p className="Hint">Name a crime, a place and a year, for example &ldquo;carjacking in Memphis in 2024&rdquo;. <button type="button" className="tourLink" onClick={startTour}>Take the tour</button></p> : null}
    </form>
  );
  const dock = (
    <div className="Dock" ref={dockEl}><div className="DockIn">
      {form}
      <p className="fine">Answers come from FBI data and can be wrong. Check important figures against the FBI Crime Data Explorer.</p>
    </div></div>
  );
  return (
    <div className="cda">
      <header className="Header"><div className="HeaderInner">
        <a className="Logo" href="https://crimeindex.org"><Logo /></a>
        <nav className="Nav">
          <a href="https://crimeindex.org/current">Current Trends</a>
          <a href="https://crimeindex.org/historical">Historical Data Library</a>
          <a href={`${BASE}/assistant`} className="on">Crime Data Assistant</a>
        </nav>
      </div></header>

      {start ? <StartPage form={form} onAsk={(q) => { setInput(""); ask(q); }} onFill={(q) => { setInput(q); window.scrollTo({ top: 0, behavior: "smooth" }); box.current?.focus(); }} /> : (<>
        {dock}
        <main className="Chat">
          {/* One answer per screen (Jeff, 2026-11-01): each question and its answer fill the space under the box. */}
          {[...turns].reverse().map((t) => (
            <section className="Turn" key={t.id} id={`turn${t.id}`} data-tour={t.tour}>
              <div className="Me" id={`me${t.id}`}><p>{t.typed}</p></div>
              <div className={`Re${t.loading ? " loading" : ""}`}>{t.reply
                ? <ReplyView t={t} onButton={(b) => click(t, b)} onAsk={(q, prev) => void run(q, { previous: prev })} suggest={suggestions(t)} />
                : <div className="wait">Answering</div>}</div>
            </section>
          ))}
        </main>
        <QuestionStrip items={strip} active={inView} onGo={(id) => document.getElementById(`turn${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      </>)}
      {tourStep !== null && !start ? <Tour step={tourStep} onStep={setTourStep} onClose={endTour} /> : null}
    </div>
  );
}

function ReplyView({ t, onButton, onAsk, suggest }: { t: Turn; onButton: (b: PreviewButton) => void; onAsk: (q: string, previous: string | null) => void; suggest: Suggestion[] }) {
  const r = t.reply!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  // The answer's time is for testing only: the console, never the page (Jeff, 2026-11-01).
  useEffect(() => { if ("ms" in r && r.ms !== undefined) console.debug(`answer ${t.id}: ${(r.ms / 1000).toFixed(1)} s`); }, [r, t.id]);
  if (r.kind === "error") return <p className="err">{r.error}</p>;

  // The read line: what was answered, when it is not just what was typed (P69). Edit asks the edited question anew.
  const asked = "asked" in r ? r.asked : null;
  const read = asked && !t.viaButton && norm(asked) !== norm(t.typed) ? (
    editing ? (
      <form className="EditQ" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { setEditing(false); onAsk(draft.trim(), null); } }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label="Edit the question" />
        <button className="Btn teal" type="submit">Ask this</button><button className="Btn" type="button" onClick={() => setEditing(false)}>Cancel</button>
      </form>
    ) : (
      <p className="read">Answering <b>{asked}</b>. <button type="button" className="link" onClick={() => { setDraft(asked); setEditing(true); }}>Edit</button></p>
    )
  ) : null;

  // The model's rewrite of a follow-up (P73): shown, never run until it is confirmed.
  // The model's question back with its own choices (each checked by the guards): one click runs that question.
  if (r.kind === "proposal" && r.options?.length) return (<>
    <p className="Lead">{r.why}</p>
    <div className="Choices">
      {r.options.map((o) => <button key={o.label} className="Choice" type="button" onClick={() => onAsk(o.question, null)}><span>{o.label}</span></button>)}
      <button className="Choice" type="button" onClick={() => onAsk(t.typed, null)}><span>Ask &ldquo;{t.typed}&rdquo; as a new question</span></button>
    </div>
  </>);
  if (r.kind === "proposal") return (<>
    <p className="Lead">Did you mean: <b>{r.question}</b></p>
    <div className="Propose"><button className="Btn teal" type="button" onClick={() => onAsk(r.question!, null)}>Run</button>
      <button className="Btn" type="button" onClick={() => { setDraft(r.question!); setEditing(true); }}>Edit</button></div>
    {editing ? <form className="EditQ" style={{ marginTop: "1rem" }} onSubmit={(e) => { e.preventDefault(); onAsk(draft, null); setEditing(false); }}><input value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus /><button className="Btn teal" type="submit">Ask this</button></form> : null}
  </>);
  if (r.kind === "rewrite-ask") return (<>
    <p className="say">{r.why}</p>
    <div className="Choices">
      {r.options.map((o) => <button key={o.label} className="Choice" type="button" onClick={() => onAsk(o.question, null)}>{o.label}</button>)}
      <button className="Choice" type="button" onClick={() => onAsk(t.typed, null)}><span>Ask &ldquo;{t.typed}&rdquo; as a new question</span></button>
    </div>
  </>);
  if (r.kind === "presentation") return <p className="say">There is no earlier chart to change.</p>;
  if (r.kind === "clarify") return (<>
    {read}
    <p className="say">{sentence(r.about)}</p>
    <Choices buttons={r.buttons} onButton={onButton} />
  </>);
  if (r.kind === "decline") return (<>
    {r.reason.startsWith("route:") ? <p className="unavailable">Not available yet in this preview</p> : r.notBuilt ? <p className="unavailable">Not in this test build</p> : null}
    {read}
    <Lead lines={[r.text]} suggest={suggest} />
    <div className="Body"><Choices buttons={r.buttons} onButton={onButton} primary /></div>
  </>);
  const p = answerOf(r);
  if (!p) return <p className="err">This answer came without its presentation.</p>;
  return (<>{read}<AnswerView r={r} p={p} firstMention={!!t.firstMention} chartKind={t.chart} onButton={onButton} suggest={suggest} /></>);
}

function Choices({ buttons, onButton, primary = false }: { buttons: PreviewButton[]; onButton: (b: PreviewButton) => void; primary?: boolean }) {
  if (!buttons.length) return null;
  return (
    <div className="Choices">
      {buttons.map((b, i) => (
        <button key={b.label} type="button" className={`Choice${primary && i === 0 && (b.kind === "continuation" || b.kind === "question") ? " primary" : ""}`} disabled={b.kind !== "continuation" && b.kind !== "question"} onClick={() => onButton(b)}>
          <span>{b.label}</span>
          {b.kind === "not-built" ? <span className="k">Not in this build</span> : b.kind === "other-source" ? <span className="k">Not available yet</span> : b.kind === "entry" ? <span className="k">Type it in the question</span> : null}
        </button>
      ))}
    </div>
  );
}

function AnswerView({ r, p, firstMention, chartKind: typedKind, onButton, suggest }: { r: Extract<Reply, { kind: "answer" }>; p: Presentation; firstMention: boolean; chartKind?: ChartMode; onButton: (b: PreviewButton) => void; suggest: Suggestion[] }) {
  // Everything said about the answer comes from its presentation, through the contract's shared builders: the title
  // (on screen and in both exports), the lead, the notes and the chart types (lib/answer-contract).
  const { title, subtitle } = titleOf(p.titleParts);
  // A partial last year ("2026 (Partial): January-September 2026") is marked in its year's cells.
  const partial = p.titleParts.partialLastYear?.slice(0, 4) ?? null;
  const yearLabel = (v: unknown) => (partial && String(v) === partial ? `${partial} (Partial)` : label(v));
  // The chart type: chosen with the Line | Bar control beside the chart, or preselected by a typed command.
  const [chartKind, setChartKind] = useState<ChartMode | undefined>(typedKind);
  const [hover, setHover] = useState<number | null>(null);
  // Click a header to sort this answer's table by it; again to reverse. Blanks (unknown) always sort last.
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  const cap = useRef<HTMLDivElement>(null);
  const [tableMax, setTableMax] = useState<number | null>(null);
  useEffect(() => {
    const el = cap.current;
    if (!el) { setTableMax(null); return; }
    const ro = new ResizeObserver(() => setTableMax(Math.max(240, el.offsetHeight)));
    ro.observe(el);
    return () => ro.disconnect();
  });
  // The engine sends the coverage columns (agencies counted, population covered) only when the question asks for them.
  const columns = r.columns;
  // Rows in the engine's order (by count, or a grouping's natural order; an unknown category last). A series that
  // begins with months no report is known for starts at the first reported one, and the engine's note says so (#99).
  const rows = r.rows;
  const numberCols = columns.filter((c) => rows.every((row) => row[c] === null || typeof row[c] === "number"));
  // Values sent as text (the share of population covered, "96.2%" or "≥ 84.3%" at a lower bound) are values, shown
  // right-aligned and never charted as categories.
  const shareCols = columns.filter((c) => !numberCols.includes(c) && rows.every((row) => row[c] === null || /^≥?\s*[\d.,]+%$/.test(String(row[c]))));
  const groupCols = columns.filter((c) => !numberCols.includes(c) && !shareCols.includes(c));
  const lead = leadOf(p, { firstMention }).sentences;
  // The notes keep the finer points the lead did not say, the source line last.
  const notes = notesOf(p);

  // One number with nothing beside it: the answer sentence only (owner, 2026-10-31). With the coverage columns the
  // sentence stays and the table shows them.
  if (p.lead.kind === "single" && columns.length === 1) {
    const v = rows[0]?.[columns[0]];
    const shown = typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null;
    return (<>
      {/* The sentence is the answer; the title would only repeat it. */}
      <Lead lines={lead} bold={shown} suggest={suggest} />
      <div className="Body">
        <Notes lines={notes} />
        <Choices buttons={rest(r, r.buttons)} onButton={onButton} />
      </div>
    </>);
  }

  // The chart types and the default are the contract's (stacked and 100% only when every category is exclusive); the
  // page only draws the table's shape: one series or several over time, lines per category over time, or bars.
  let options: ChartKind[] = [...new Set(p.chart.allowed.map((k) => KIND[k]))];
  let kind: ChartKind | null = p.chart.default ? KIND[p.chart.default] : null;
  let points: Point[] = [], series = "", lines: Line[] | undefined, moreLines = 0;
  // Which chart point a table row belongs to: its own index, or (time by category) its period's.
  let pointOf = (i: number) => i;
  const timed = groupCols.length >= 1 && rows.every((row) => PERIOD.test(String(row[groupCols[0]])));
  // The columns charted are the engine's (#100); coverage, populations and incidents are shown in the table only.
  const charted = p.chart.columns;
  if (timed && groupCols.length === 1 && charted.length) {
    const tc = groupCols[0];
    series = charted[0];
    points = rows.map((row) => ({ x: String(row[tc]), label: yearLabel(row[tc]), y: charted.length > 1 ? null : (row[series] as number | null) }));
    // Several series over time (places compared, measures side by side): one line each, each keeping its color, named
    // as the engine labels it ("Memphis, TN").
    if (charted.length > 1) {
      lines = charted.slice(0, SERIES.length).map((c, k) => ({ name: seriesLabel(p, c), color: SERIES[k], ys: rows.map((row) => row[c] as number | null) }));
      if (charted.length > SERIES.length) moreLines = charted.length;
    }
  } else if (timed && groupCols.length === 2 && charted.length) {
    // Time by category: one line per category over the periods, the first number column; at most eight lines, in the
    // engine's order, each keeping its color.
    const [tc, cc] = groupCols;
    series = charted[0];
    const periods = [...new Set(rows.map((row) => String(row[tc])))];
    const cats = [...new Set(rows.map((row) => String(row[cc])))];
    points = periods.map((pd) => ({ x: pd, label: yearLabel(pd), y: null }));
    lines = cats.slice(0, SERIES.length).map((c, k) => ({ name: c, color: SERIES[k],
      ys: periods.map((pd) => { const hit = rows.find((row) => String(row[tc]) === pd && String(row[cc]) === c); return hit ? (hit[series] as number | null) : null; }) }));
    pointOf = (i: number) => periods.indexOf(String(rows[i][tc]));
    // Only some categories drawn: no 100% stack, whose shares would be of those drawn, not of the total.
    if (cats.length > SERIES.length) { moreLines = cats.length; options = options.filter((m) => m !== "stacked100"); }
  } else if (!timed && groupCols.length === 1 && charted.length) {
    // A breakdown: bars of categories; its one 100% bar only while each category can keep its own color.
    if (rows.length > SERIES.length) options = options.filter((m) => m !== "stacked100");
    series = charted[0];
    points = rows.map((row) => ({ x: String(row[groupCols[0]]), label: label(row[groupCols[0]]), y: row[series] as number | null }));
    if (chartKind === "stacked100" && options.includes("stacked100")) {
      // One bar of shares: each category a part, in the table's order, each in its own color.
      lines = rows.map((row, k) => ({ name: label(row[groupCols[0]]), color: SERIES[k], ys: [row[series] as number | null] }));
      points = [{ x: "all", label: "", y: null }];
      pointOf = () => 0;
    }
  } else options = [];
  if (!options.length || !points.length) kind = null;
  else if (!kind || !options.includes(kind)) kind = options[0];
  // The chosen type, when this answer offers it; otherwise the default above.
  if (kind && chartKind && chartKind !== "table" && options.includes(chartKind)) kind = chartKind;
  const breakdown = !timed && groupCols.length === 1 && !!kind; // bars of categories, or their one 100% bar
  // A long breakdown: the largest categories are drawn (the engine sorts them, largest first); the table has all.
  const drawn = breakdown && points.length > MAX_BARS ? points.slice(0, MAX_BARS) : points;
  const sub = joinAmp(p.titleParts.places);
  // "Table only" hides the chart; the control stays, with nothing chosen, to bring it back.
  const hidden = chartKind === "table";
  const name = (m: ChartKind) => (lines && !breakdown && m === "bar" ? "Grouped bars" : breakdown && m === "bar" ? "Vertical bars" : KIND_LABEL[m]);
  const seg = kind && options.length > 1 ? (
    <div className="Seg noexport" role="group" aria-label="Chart type">
      {options.map((m) => <button key={m} type="button" className={!hidden && kind === m ? "on" : ""} aria-pressed={!hidden && kind === m} onClick={() => setChartKind(m)}>{name(m)}</button>)}
    </div>
  ) : null;

  const drawnChart = !!kind && !hidden;
  // The source line under the chart in its PNG.
  const source = PROFILES[p.source]!.name.sourceLine;
  return (<>
    <Lead lines={lead} suggest={suggest} />
    {/* The chart's block: its title (as in the PNG), the chart type and downloads, the chart beside the table, the notes. */}
    <div className="Body">
    {/* A hairline frame around the data, apart from the sentence above it (Jeff, 2026-11-01, to try). */}
    <div className="Frame">
    <div className="ChartTitle"><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div>
    <div className="ToolRow">
      {seg}
      {/* Downloads (Jeff): small, at the right of the row. PNG is the chart alone; CSV is the table alone. */}
      <span className="Dl" role="group" aria-label="Download">
        <span className="lbl">Download</span>
        {drawnChart ? <button type="button" onClick={() => void downloadPng(cap.current, title)}>PNG</button> : null}
        <button type="button" onClick={() => downloadCsv(columns, order(rows, sort).map((i) => rows[i]), numberCols, yearLabel, title)}>CSV</button>
      </span>
    </div>
    <div className={`Answer${drawnChart ? "" : " tableOnly"}`}>
      {drawnChart ? (
        <div className="cap" ref={cap}>
          {/* Only in the PNG: the chart's title and subtitle above it, its source under it. */}
          <div className="pngOnly pngHead"><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div>
          <AnswerChart kind={kind!} points={drawn} series={seriesLabel(p, series)} sub={sub} hover={hover} onHover={setHover} lines={lines} />
          {moreLines ? <p className="chartnote">The {SERIES.length} largest of {moreLines} are drawn; the table lists all.</p> : null}
          {drawn.length < points.length ? <p className="chartnote">The {drawn.length} largest of {points.length} are drawn; the table lists all {points.length}.</p> : null}
          <p className="pngOnly pngSource">{source}</p>
        </div>
      ) : null}
      <div className="TableScroll" style={tableMax ? { maxHeight: tableMax } : undefined}>
        <table className="T">
          <thead><tr>{columns.map((c) => (
            <th key={c} className={`${numberCols.includes(c) || shareCols.includes(c) ? "" : "txt"}${sort?.col === c ? " sorted" : ""}`} aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
              <button type="button" className="sortBtn" onClick={() => setSort((s) => (s?.col === c ? { col: c, dir: s.dir === 1 ? -1 : 1 } : { col: c, dir: numberCols.includes(c) ? -1 : 1 }))}>
                {c}{sort?.col === c ? <span className={`dir ${sort.dir === 1 ? "up" : "down"}`} aria-hidden="true" /> : null}
              </button>
            </th>
          ))}</tr></thead>
          <tbody>{order(rows, sort).map((i) => { const row = rows[i]; return (
            <tr key={i} className={hover !== null && pointOf(i) === hover ? "hl" : ""} onMouseEnter={() => setHover(pointOf(i))} onMouseLeave={() => setHover(null)}>
              {columns.map((c) => shareCols.includes(c)
                // A lower bound ("≥ 84.3%") says why on hover.
                ? <td key={c} className={String(row[c]).startsWith("≥") ? "atLeast" : ""} title={String(row[c]).startsWith("≥") ? "At least this share; some agencies have no population figure." : undefined}>{row[c] ?? ""}</td>
                : <td key={c} className={numberCols.includes(c) ? "" : "txt"}>{numberCols.includes(c) ? cell(row[c], /\(%\)/.test(c)) : yearLabel(row[c])}</td>)}
            </tr>
          ); })}</tbody>
        </table>
      </div>
    </div>
    <Notes lines={notes} />
    </div>
    <Choices buttons={rest(r, r.buttons)} onButton={onButton} />
    </div>
  </>);
}

/** Row indexes in display order: as delivered, or sorted by one column (numbers by value, text alphabetically), blanks last. */
function order(rows: Record<string, string | number | null>[], sort: { col: string; dir: 1 | -1 } | null): number[] {
  const idx = rows.map((_, i) => i);
  if (!sort) return idx;
  return idx.sort((a, b) => {
    const x = rows[a][sort.col], y = rows[b][sort.col];
    if (x === null || x === undefined) return y === null || y === undefined ? a - b : 1;
    if (y === null || y === undefined) return -1;
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "en-US", { numeric: true });
    return c === 0 ? a - b : c * sort.dir;
  });
}

const fileName = (title: string, ext: string) => `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "answer"}.${ext}`;
const save = (href: string, name: string) => { const a = document.createElement("a"); a.href = href; a.download = name; a.click(); };

/**
 * The table alone as a CSV (Jeff): its columns and rows exactly as shown, in the order shown; numbers as numbers, a
 * blank for an unknown one; no title, notes or question.
 */
function downloadCsv(columns: string[], rows: Record<string, string | number | null>[], numberCols: string[], shown: (v: unknown) => string, title: string) {
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [columns.map(q).join(","), ...rows.map((row) => columns.map((c) => {
    const v = row[c];
    return v === null || v === undefined ? "" : numberCols.includes(c) ? String(v) : q(shown(v));
  }).join(","))];
  // A UTF-8 byte order mark, so spreadsheet programs read the en dashes and accents correctly.
  save(URL.createObjectURL(new Blob(["﻿" + lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" })), fileName(title, "csv"));
}

/** The answer as a picture: the question, the chart beside the full table, and the notes with the source last. */
async function downloadPng(el: HTMLDivElement | null, title: string) {
  if (!el) return;
  const { toPng } = await import("html-to-image");
  // The chart is drawn at the column's pixel width; the PNG's margin goes outside it, so nothing is cut off.
  el.style.width = `${el.clientWidth}px`;
  el.classList.add("exporting");
  try {
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    save(await toPng(el, { backgroundColor: "#ffffff", pixelRatio: 2, filter: (n) => !(n instanceof HTMLElement && n.classList.contains("noexport")) }), fileName(title, "png"));
  } finally {
    el.classList.remove("exporting");
    el.style.width = "";
  }
}

type Suggestion = { before: string; link: string; after: string; run: () => void };
function Lead({ lines, bold, suggest }: { lines: string[]; bold?: string | null; suggest: Suggestion[] }) {
  if (!lines.join("") && !suggest.length) return null;
  const em = (t: string) => { const i = bold ? t.indexOf(bold) : -1; return i >= 0 ? <>{t.slice(0, i)}<b>{bold}</b>{t.slice(i + bold!.length)}</> : t; };
  // A new answer fades in, the lead first and then the chart's block (assistant.css); Jeff picked it, 2026-11-02.
  return (
    <p className="Lead fade">
      {em(lines.join(" "))}
      {suggest.map((x, i) => <span key={i}>{` ${x.before}`}<button type="button" className="sug" onClick={x.run}>{x.link}</button>{x.after}</span>)}
    </p>
  );
}

/** The notes under an answer; the source line, always last (notesOf), set apart. */
function Notes({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <div className="notes">{lines.map((l, i) => <p key={i} className={i === lines.length - 1 ? "src" : ""}>{l}</p>)}</div>;
}
