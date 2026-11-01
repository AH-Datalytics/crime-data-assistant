"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewButton, PreviewResponse } from "@/lib/nibrs-shadow/preview";
import AnswerChart, { type ChartKind, type Line, type Point } from "./AnswerChart";
import Logo from "./Logo";
import QuestionStrip, { type StripItem } from "./QuestionStrip";
import { StartPage } from "./StartPage";

/**
 * The Crime Data Assistant chat (spec: docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md).
 * One straight scroll: the question box pinned at the top, the newest question and its answer under it, one per screen.
 * Every typed question after the first is sent with the last answer's standalone question (`previous`), so the
 * engine's rewriter (P69) decides whether it is a follow-up; the read line shows what was answered.
 */
type Option = { label: string; question: string };
type Reply =
  | (PreviewResponse & { asked: string; rewrite?: string | null; title?: string; subtitle?: string | null; partialYear?: string | null; ms?: number })
  | { kind: "rewrite-ask"; why: string; options: Option[]; ms?: number }
  | { kind: "presentation"; asked: string; how: string; ms?: number }
  // The engine's coming confirm-before-run outcome for a model rewrite (stubbed until the engine returns it).
  | { kind: "proposal"; asked: string; question: string; ms?: number }
  | { kind: "error"; error: string };
type Src = "nibrs" | "historical" | "rtci" | "shr";
type Asking = { question: string; path: string[] };
/**
 * Choices made inside an answer that rerun it in place (Jeff, 2026-11-01), in the same slot, with no new question:
 * all reporting agencies or only those that reported every month (P61), and the source.
 */
type Scope = { all: Asking; every: Asking; on: boolean };
type Sources = { on: Src; list: { source: Src; asking: Asking; available: boolean }[] };
type Turn = { id: number; typed: string; question: string; path: string[]; reply: Reply | null; chart?: ChartMode; viaButton?: boolean;
  scope?: Scope; sources?: Sources; loading?: boolean };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const label = (v: unknown) => {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}$/.test(s) ? `${MONTHS[Number(s.slice(5)) - 1]} ${s.slice(0, 4)}` : s;
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
/**
 * Whether a category-by-time answer's categories are exclusive (each unit in exactly one), so stacked forms are honest.
 * From the engine's flag (top-level `exclusive`: the charted count's categories sum to its total).
 */
const exclusive = (r: object) => (r as { exclusive?: boolean }).exclusive === true;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}${/[?.]$/.test(s) ? "" : "?"}`;

const SRC_NAME: Record<Src, string> = { nibrs: "NIBRS", historical: "Historical", rtci: "Current Trends", shr: "Homicide Reports" };
const LIVE: Src[] = ["nibrs"];
// How the lead names another source's data, as a link.
const SRC_DATA: Record<Src, string> = { nibrs: "the FBI's NIBRS data", historical: "Crime Index's historical data", rtci: "Crime Index's Current Trends data", shr: "the FBI's Supplementary Homicide Reports" };
// The engine's role for a button, or (until the engine sends one) read from its label.
type Roled = PreviewButton & { role?: "consistent-agencies" | "source"; source?: Src };
const isScope = (b: Roled) => b.role === "consistent-agencies" || (!b.role && /reported every month/i.test(b.label));
const sourceOfButton = (b: Roled): Src | null => (b.role === "source" ? b.source ?? null
  : !b.role && b.question && /\baccording to NIBRS$/i.test(b.question) ? "nibrs" : null);
/** The source an engine reply belongs to: the engine's, a route's, or (P01's NIBRS alternative) the official counts'. */
function sourceOf(r: PreviewResponse): Src {
  const own = (r as { source?: Src }).source;
  if (own) return own;
  if (r.kind === "decline" && r.reason.startsWith("route:")) return r.reason.slice(6) as Src;
  if (r.kind === "decline" && r.buttons.some((b) => sourceOfButton(b) === "nibrs")) return "historical";
  return "nibrs";
}
const scopeOf = (r: Reply | null, at: Asking): Scope | undefined => {
  const b = r && (r.kind === "answer") ? (r.buttons as Roled[]).find(isScope) : undefined;
  return b ? { all: at, every: { question: at.question, path: [...at.path, b.label] }, on: false } : undefined;
};
const sourcesOf = (r: Reply | null, at: Asking): Sources | undefined => {
  if (!r || (r.kind !== "answer" && r.kind !== "decline")) return undefined;
  const on = sourceOf(r);
  const others = (r.buttons as Roled[]).flatMap((b) => {
    const s = sourceOfButton(b);
    return s && s !== on ? [{ source: s, asking: b.question ? { question: b.question, path: [] } : { question: at.question, path: [...at.path, b.label] }, available: LIVE.includes(s) }] : [];
  });
  return { on, list: [{ source: on, asking: at, available: LIVE.includes(on) }, ...others] };
};
/** The buttons left under an answer once the scope and source choices have moved into its control row. */
const rest = (bs: PreviewButton[]) => (bs as Roled[]).filter((b) => !isScope(b) && !sourceOfButton(b));

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
      const res = await fetch("/api/assistant-query", { method: "POST", headers: { "Content-Type": "application/json" },
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
    // A presentation-only follow-up ("make it a bar chart") redraws the last answer; no data question is asked (P69).
    if (reply.kind === "presentation") {
      const last = [...turnsRef.current].reverse().find((t) => t.reply?.kind === "answer");
      if (last && last.reply) reply = { ...(last.reply as Extract<Reply, { kind: "answer" }>), ms: reply.ms };
    }
    const shown = reply;
    setTurns((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      const q = "asked" in shown && shown.asked ? shown.asked : t.question, at = { question: q, path };
      return { ...t, reply: shown, question: q, scope: scopeOf(shown, at), sources: sourcesOf(shown, at) };
    }));
    scroll(id);
    setBusy(false);
  }

  // A scope or source choice reruns the answer in place: the same slot, the same question line, the new reply.
  async function rerun(id: number, asking: Asking, change: (t: Turn, r: Reply) => Partial<Turn>) {
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, loading: true } : t)));
    const reply = await fetchReply(asking.question, asking.path);
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...change(t, reply), reply, path: asking.path, loading: false } : t)));
  }
  const setScope = (t: Turn, on: boolean) => t.scope && t.scope.on !== on
    && void rerun(t.id, on ? t.scope.every : t.scope.all, (u) => ({ scope: { ...u.scope!, on } }));
  // The lead's own sentences for the agencies counted and the source (Jeff, 2026-11-01: part of the description, as
  // links in plain words, not controls). Each link reruns the answer in place. Nothing is said about other sources when
  // no other source answers the question.
  const suggestions = (t: Turn): Suggestion[] => {
    const out: Suggestion[] = [];
    // Jeff's wording (2026-11-01); the number in the fixed set is read from the engine's answer sentence.
    const every = t.reply?.kind === "answer" ? /\bthe ([\d,]+) agencies that reported every month\b/.exec(t.reply.text[0] ?? "")?.[1] : undefined;
    if (t.scope) out.push(t.scope.on
      ? { before: `This counts only the ${every ? `${every} ` : ""}Consistent Reporting Agencies that reported every month. `, link: "See all reporting agencies", after: " instead.", run: () => setScope(t, false) }
      : { before: "Not every agency reported in every year, so part of this change could come from agencies starting or stopping reporting. To compare the same agencies across years, see only the ",
          link: "Consistent Reporting Agencies", after: " that reported every month.", run: () => setScope(t, true) });
    const others = t.sources ? t.sources.list.filter((s) => s.source !== t.sources!.on) : [];
    if (t.reply?.kind === "decline") {
      for (const o of others) out.push({ before: "The same question can be answered from ", link: SRC_DATA[o.source], after: ".", run: () => setSource(t, o.source) });
    } else {
      others.forEach((o, k) => out.push({ before: k ? "Or from " : `These are ${SRC_NAME[t.sources!.on]} figures from the FBI. The same question can also be answered from `,
        link: SRC_DATA[o.source], after: ".", run: () => setSource(t, o.source) }));
    }
    return out;
  };
  const setSource = (t: Turn, s: Src) => {
    const to = t.sources?.list.find((x) => x.source === s);
    if (!to || t.sources!.on === s) return;
    // A new source is a new answer: its own scope choice, if it offers one.
    void rerun(t.id, to.asking, (u, r) => ({ sources: { ...u.sources!, on: s }, scope: scopeOf(r, to.asking),
      question: "asked" in r && r.asked ? r.asked : to.asking.question }));
  };

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

  const start = turns.length === 0;
  // One hint under the box: how to ask, then (after an answer) that a follow-up or a new question both work.
  const hint = start
    ? <>Name a crime, a place and a year, for example &ldquo;carjacking in Memphis in 2024&rdquo;.</>
    : <>Ask a follow-up, like &ldquo;same for 2023&rdquo;, or a new question.</>;
  const form = (
    <form className="AskForm" onSubmit={(e) => { e.preventDefault(); ask(input); setInput(""); }}>
      <div className="AskRow">
        <input ref={box} value={input} onChange={(e) => setInput(e.target.value)} placeholder={start ? "Shoplifting in Memphis by month in 2024" : "Ask a question or a follow-up"} aria-label="Question" />
        <button className="Ask" type="submit" disabled={busy}>Ask</button>
      </div>
      <p className="Hint">{hint}</p>
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
          <a href="/assistant" className="on">Crime Data Assistant</a>
        </nav>
        <span className="Preview">Local preview, NIBRS only</span>
      </div></header>

      {start ? <StartPage form={form} onAsk={(q) => { setInput(""); ask(q); }} onFill={(q) => { setInput(q); window.scrollTo({ top: 0, behavior: "smooth" }); box.current?.focus(); }} /> : (<>
        {dock}
        <main className="Chat">
          {/* One answer per screen (Jeff, 2026-11-01): each question and its answer fill the space under the box. */}
          {[...turns].reverse().map((t) => (
            <section className="Turn" key={t.id} id={`turn${t.id}`}>
              <div className="Me" id={`me${t.id}`}><p>{t.typed}</p></div>
              <div className={`Re${t.loading ? " loading" : ""}`}>{t.reply
                ? <ReplyView t={t} onButton={(b) => click(t, b)} onAsk={(q, prev) => void run(q, { previous: prev })}
                    suggest={suggestions(t)} />
                : <div className="wait">Answering</div>}</div>
            </section>
          ))}
        </main>
        <QuestionStrip items={strip} active={inView} onGo={(id) => document.getElementById(`turn${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" })} />
      </>)}
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

  if (r.kind === "proposal") return (<>
    <p className="say">Did you mean <b>{r.question}</b>?</p>
    <div className="Choices"><button className="Choice primary" type="button" onClick={() => onAsk(r.question, null)}>Run it</button>
      <button className="Choice" type="button" onClick={() => { setDraft(r.question); setEditing(true); }}>Edit it</button></div>
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
    <Choices buttons={rest(r.buttons)} onButton={onButton} primary />
  </>);
  return (<>{read}<AnswerView r={r} chartKind={t.chart} title={asked ?? t.typed} onButton={onButton} scoped={!!t.scope} suggest={suggest} /></>);
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

function AnswerView({ r, chartKind: typedKind, title: asked, onButton, scoped, suggest }: { r: Extract<PreviewResponse, { kind: "answer" }> & { title?: string; subtitle?: string | null; partialYear?: string | null }; chartKind?: ChartMode; title: string; onButton: (b: PreviewButton) => void; scoped: boolean; suggest: Suggestion[] }) {
  // The chart title (from the engine's plan, Jeff's convention) names the answer on screen and in both exports; the
  // question as asked is the fallback for an answer without one (the historical file's).
  const title = r.title ?? asked, subtitle = r.subtitle ?? null;
  const yearLabel = (v: unknown) => (r.partialYear && String(v) === r.partialYear ? `${r.partialYear} (Partial)` : label(v));
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
  const { columns, text } = r;
  // A series that begins with periods no agency reported starts at the first reported one (owner, 2026-10-31): the
  // leading blank rows are left out of the chart, the table and the export, and a note says where it starts.
  const isSeries = !!r.chart?.xAxis;
  const firstKnown = isSeries ? r.rows.findIndex((row) => columns.some((c) => typeof row[c] === "number")) : 0;
  const rows = firstKnown > 0 ? r.rows.slice(firstKnown) : r.rows;
  const numberCols = columns.filter((c) => rows.every((row) => row[c] === null || typeof row[c] === "number"));
  const groupCols = columns.filter((c) => !numberCols.includes(c));
  const lead = composeLead(text, scoped);
  // The notes keep the finer points: whatever the lead did not say.
  let notes = text.filter((_, i) => !lead.used.has(i));
  if (firstKnown > 0) {
    // The engine's note for exactly the left-out run ("No report is known for January 2017 to May 2018: shown blank,
    // not zero.") would no longer be true; it becomes one sentence saying where the series starts.
    const x = r.chart!.xAxis, start = label(rows[0][x]);
    const run = `${label(r.rows[0][x])}${firstKnown > 1 ? ` to ${label(r.rows[firstKnown - 1][x])}` : ""}`;
    const replaced = notes.map((n) => (n === `No report is known for ${run}: shown blank, not zero.` ? `No report is known for ${run}, so the chart and table start at ${start}.` : n));
    notes = replaced.some((n, i) => n !== notes[i]) ? replaced : [`The chart and table start at ${start}, the first period with a report.`, ...notes];
  }

  // One number: the answer sentence only (owner, 2026-10-31), including a one-row series ("2024: 10,149").
  if (rows.length === 1 && numberCols.length === 1) {
    const v = rows[0][numberCols[0]];
    const shown = typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null;
    return (<>
      {r.title ? <div className="ChartTitle"><h3>{r.title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div> : null}
      <Lead lines={lead.lines} bold={shown} suggest={suggest} />
      <Notes lines={notes} />
      <Choices buttons={rest(r.buttons)} onButton={onButton} />
    </>);
  }

  // The chart: the engine's time series, or a bar chart drawn from a breakdown's table (one category, first number column).
  let kind: ChartKind | null = null, points: Point[] = [], series = "", lines: Line[] | undefined, moreLines = 0;
  // The chart types this answer offers (Jeff, 2026-11-01): a series Line | Bar; a breakdown horizontal | vertical bars;
  // category by time Line | Grouped bars, plus stacked forms only when the engine marks the categories as exclusive
  // (overlapping categories, such as a crime under each weapon, would show false shares).
  let options: ChartKind[] = [];
  // Which chart point a table row belongs to: its own index, or (time by category) its period's.
  let pointOf = (i: number) => i;
  if (r.chart && r.chart.xAxis && r.chart.yAxis?.[0]) {
    options = ["line", "bar"];
    kind = r.chart.type === "bar" ? "bar" : "line";
    series = r.chart.yAxis[0];
    points = rows.map((row) => ({ x: String(row[r.chart!.xAxis]), label: yearLabel(row[r.chart!.xAxis]), y: row[series] as number | null }));
  } else if (rows.length > 1 && groupCols.length === 1 && numberCols.length >= 1 && rows.every((row) => PERIOD.test(String(row[groupCols[0]])))) {
    // A series without an engine chart (a state or national sum by year): time, so Line | Bar, never category bars.
    options = ["line", "bar"];
    kind = "bar";
    series = numberCols[0];
    points = rows.map((row) => ({ x: String(row[groupCols[0]]), label: yearLabel(row[groupCols[0]]), y: row[series] as number | null }));
  } else if (groupCols.length === 2 && numberCols.length >= 1 && rows.every((row) => PERIOD.test(String(row[groupCols[0]])))) {
    // Time by category (no engine chart): one line per category over the periods, the first number column; at most
    // eight lines, in the engine's order (largest first in the first period), each keeping its color.
    const [tc, cc] = groupCols;
    series = numberCols[0];
    const periods = [...new Set(rows.map((row) => String(row[tc])))];
    const cats = [...new Set(rows.map((row) => String(row[cc])))];
    points = periods.map((pd) => ({ x: pd, label: yearLabel(pd), y: null }));
    lines = cats.slice(0, SERIES.length).map((c, k) => ({ name: c, color: SERIES[k],
      ys: periods.map((pd) => { const hit = rows.find((row) => String(row[tc]) === pd && String(row[cc]) === c); return hit ? (hit[series] as number | null) : null; }) }));
    options = ["line", "bar", ...(exclusive(r) ? (["stacked", "stacked100", "area"] as ChartKind[]) : [])];
    kind = periods.length < 2 ? null : "line";
    pointOf = (i: number) => periods.indexOf(String(rows[i][tc]));
    if (cats.length > SERIES.length) moreLines = cats.length;
  } else if (rows.length > 1 && groupCols.length === 1 && numberCols.length >= 1) {
    // A breakdown is bars, never a line (a line across categories would imply an order they don't have).
    options = ["hbar", "bar", ...(exclusive(r) && rows.length <= SERIES.length ? (["stacked100"] as ChartKind[]) : [])];
    kind = "hbar";
    series = numberCols[0];
    points = rows.map((row) => ({ x: String(row[groupCols[0]]), label: label(row[groupCols[0]]), y: row[series] as number | null }));
    if (chartKind === "stacked100" && options.includes("stacked100")) {
      // One bar of shares: each category a part, in the table's order, each in its own color.
      lines = rows.map((row, k) => ({ name: label(row[groupCols[0]]), color: SERIES[k], ys: [row[series] as number | null] }));
      points = [{ x: "all", label: "", y: null }];
      pointOf = () => 0;
    }
  }
  // The chosen type, when this answer offers it; otherwise the default above.
  if (kind && chartKind && chartKind !== "table" && options.includes(chartKind)) kind = chartKind;
  const breakdown = groupCols.length === 1 && !r.chart && options[0] === "hbar"; // bars of categories, or their one 100% bar
  // A long breakdown: the largest categories are drawn (the engine sorts them, largest first); the table has all.
  const drawn = breakdown && points.length > MAX_BARS ? points.slice(0, MAX_BARS) : points;
  const sub = (text[0] ?? "").split(":")[0];
  // "Table only" hides the chart; the control stays, with nothing chosen, to bring it back.
  const hidden = chartKind === "table";
  const name = (m: ChartKind) => (lines && !breakdown && m === "bar" ? "Grouped bars" : breakdown && m === "bar" ? "Vertical bars" : KIND_LABEL[m]);
  const seg = kind && options.length > 1 ? (
    <div className="Seg noexport" role="group" aria-label="Chart type">
      {options.map((m) => <button key={m} type="button" className={!hidden && kind === m ? "on" : ""} aria-pressed={!hidden && kind === m} onClick={() => setChartKind(m)}>{name(m)}</button>)}
    </div>
  ) : null;

  const charted = !!kind && !hidden;
  // The source line under the chart in its PNG (the engine's source statement, always its last line).
  const source = [...text].reverse().find((t) => /^Source:/.test(t)) ?? "Source: FBI NIBRS.";
  return (<>
    {r.title ? <div className="ChartTitle"><h3>{r.title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div> : null}
    <Lead lines={lead.lines} suggest={suggest} />
    <div className="ToolRow">
      {seg}
      {/* Downloads (Jeff): small, at the right of the row. PNG is the chart alone; CSV is the table alone. */}
      <span className="Dl" role="group" aria-label="Download">
        <span className="lbl">Download</span>
        {charted ? <button type="button" onClick={() => void downloadPng(cap.current, title)}>PNG</button> : null}
        <button type="button" onClick={() => downloadCsv(columns, order(rows, sort).map((i) => rows[i]), numberCols, yearLabel, title)}>CSV</button>
      </span>
    </div>
    <div className={`Answer${charted ? "" : " tableOnly"}`}>
      {charted ? (
        <div className="cap" ref={cap}>
          {/* Only in the PNG: the chart's title and subtitle above it, its source under it. */}
          <div className="pngOnly pngHead"><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div>
          <AnswerChart kind={kind!} points={drawn} series={series} sub={sub} hover={hover} onHover={setHover} lines={lines} />
          {moreLines ? <p className="chartnote">The {SERIES.length} largest of {moreLines} are drawn; the table lists all.</p> : null}
          {drawn.length < points.length ? <p className="chartnote">The {drawn.length} largest of {points.length} are drawn; the table lists all {points.length}.</p> : null}
          <p className="pngOnly pngSource">{source}</p>
        </div>
      ) : null}
      <div className="TableScroll" style={tableMax ? { maxHeight: tableMax } : undefined}>
        <table className="T">
          <thead><tr>{columns.map((c) => (
            <th key={c} className={`${numberCols.includes(c) ? "" : "txt"}${sort?.col === c ? " sorted" : ""}`} aria-sort={sort?.col === c ? (sort.dir === 1 ? "ascending" : "descending") : "none"}>
              <button type="button" className="sortBtn" onClick={() => setSort((s) => (s?.col === c ? { col: c, dir: s.dir === 1 ? -1 : 1 } : { col: c, dir: numberCols.includes(c) ? -1 : 1 }))}>
                {c}{sort?.col === c ? <span className={`dir ${sort.dir === 1 ? "up" : "down"}`} aria-hidden="true" /> : null}
              </button>
            </th>
          ))}</tr></thead>
          <tbody>{order(rows, sort).map((i) => { const row = rows[i]; return (
            <tr key={i} className={hover !== null && pointOf(i) === hover ? "hl" : ""} onMouseEnter={() => setHover(pointOf(i))} onMouseLeave={() => setHover(null)}>
              {columns.map((c) => <td key={c} className={numberCols.includes(c) ? "" : "txt"}>{numberCols.includes(c) ? cell(row[c], /\(%\)/.test(c)) : yearLabel(row[c])}</td>)}
            </tr>
          ); })}</tbody>
        </table>
      </div>
    </div>
    <Notes lines={notes} />
    <Choices buttons={rest(r.buttons)} onButton={onButton} />
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
const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`;
/**
 * The lead (Jeff, 2026-11-01): one to three plain sentences under the title, on the page only (never in the chart, the
 * table or either download). Until the engine sends its own lead, it is stitched from the engine's text:
 *   1. what is shown: the answer sentence ("Memphis, Tennessee: carjacking offenses by clearance status, 2024."), recast
 *      with the reporting agency line ("Reported by the Memphis Police Department.") into one sentence;
 *   2. the main caveat, when the engine states one: categories that overlap, or agencies joining and leaving over the years;
 * and the suggestions follow as buttons. The lines it uses are left out of the notes below.
 */
function composeLead(text: string[], scoped: boolean): { lines: string[]; used: Set<number> } {
  const used = new Set([0]);
  const ri = text.findIndex((l, i) => i > 0 && /^Reported by .+\.$/.test(l));
  const reporter = ri > 0 ? text[ri].slice("Reported by ".length, -1) : null;
  let first = text[0] ?? "";
  const one = /^(.+?): ([\d,.]+) (.+) in (\d{4})\.$/.exec(first);
  const many = /^(.+?): (.+?)(?: by (.+?))?, (\d{4})(?: to (\d{4}))?(, .+)?\.$/.exec(first);
  if (one && reporter) {
    first = `${cap(reporter)} reported ${one[2]} ${one[3]} in ${one[4]}.`;
    used.add(ri);
  } else if (many) {
    const [, place, what, by, y0, y1, rest] = many;
    const each = by && /^(?:year|quarter|month)$/.test(by) ? `, ${by} by ${by}` : by ? `, split by ${by}` : "";
    first = `${cap(what)} ${reporter ? `reported by ${reporter}` : `in ${place}`} ${y1 ? `from ${y0} to ${y1}` : `in ${y0}`}${each}${rest ?? ""}.`;
    if (reporter) used.add(ri);
  }
  // The fixed set is said in the lead's own sentence about it ("This counts only the 248 Consistent Reporting Agencies…").
  const lines = [first.replace(/, counting only the [\d,]+ agencies that reported every month[^.]*\./, ".")];
  const overlap = text.findIndex((l) => /counted once in each/.test(l));
  const change = text.findIndex((l) => /^Which agencies report changed/.test(l));
  if (overlap > 0) { lines.push(text[overlap]); used.add(overlap); }
  // With the consistent-agencies choice, the lead's own sentence about it says this; the engine's goes.
  else if (change > 0) { if (!scoped) lines.push(`${text[change].split(";")[0]}.`); used.add(change); }
  return { lines, used };
}

function Lead({ lines, bold, suggest }: { lines: string[]; bold?: string | null; suggest: Suggestion[] }) {
  const em = (s: string) => { const i = bold ? s.indexOf(bold) : -1; return i >= 0 ? <>{s.slice(0, i)}<b>{bold}</b>{s.slice(i + bold!.length)}</> : s; };
  return (
    <p className="Lead">
      {lines.map((l, i) => <span key={i}>{i ? " " : ""}{em(l)}</span>)}
      {suggest.map((s) => <span key={s.link}> {s.before}<button type="button" className="sug" onClick={s.run}>{s.link}</button>{s.after}</span>)}
    </p>
  );
}

function Notes({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <div className="notes">{lines.map((l, i) => <p key={i} className={i === lines.length - 1 && /^Source:/.test(l) ? "src" : ""}>{l}</p>)}</div>;
}
