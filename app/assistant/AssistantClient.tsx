"use client";

import { useEffect, useRef, useState } from "react";
import type { PreviewButton, PreviewResponse } from "@/lib/nibrs-shadow/preview";
import AnswerChart, { type Point } from "./AnswerChart";
import Logo from "./Logo";

/**
 * The Crime Data Assistant chat (spec: docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md).
 * One straight scroll: the question as typed on the right, the reply below, the question box pinned at the bottom.
 * Every typed question after the first is sent with the last answer's standalone question (`previous`), so the
 * engine's rewriter (P69) decides whether it is a follow-up; the read line shows what was answered.
 */
type Option = { label: string; question: string };
type Reply =
  | (PreviewResponse & { asked: string; ms?: number })
  | { kind: "rewrite-ask"; why: string; options: Option[]; ms?: number }
  | { kind: "presentation"; asked: string; how: string; ms?: number }
  // The engine's coming confirm-before-run outcome for a model rewrite (stubbed until the engine returns it).
  | { kind: "proposal"; asked: string; question: string; ms?: number }
  | { kind: "error"; error: string };
type Turn = { id: number; typed: string; question: string; path: string[]; reply: Reply | null; chart?: "line" | "bar"; viaButton?: boolean };

const EXAMPLES = [
  "Shoplifting in Memphis by month in 2024",
  "Murder victims in Houston by race in 2024",
  "How many carjackings were there in Memphis in 2024?",
  "Vehicle burglaries in Baltimore in 2024",
  "Shoplifting in Memphis in 2027",
];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const label = (v: unknown) => {
  const s = String(v ?? "");
  return /^\d{4}-\d{2}$/.test(s) ? `${MONTHS[Number(s.slice(5)) - 1]} ${s.slice(0, 4)}` : s;
};
// A percent column always shows its one decimal ("13.0"); counts show no decimals.
const cell = (v: unknown, pct = false) => (v === null || v === undefined ? "" : typeof v === "number"
  ? v.toLocaleString("en-US", pct ? { minimumFractionDigits: 1, maximumFractionDigits: 1 } : { maximumFractionDigits: 1 }) : label(v));
const MAX_BARS = 15;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const sentence = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}${/[?.]$/.test(s) ? "" : "?"}`;

export default function AssistantClient() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [source, setSource] = useState("auto");
  const [busy, setBusy] = useState(false);
  const next = useRef(1);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const box = useRef<HTMLInputElement>(null);

  async function run(typed: string, opts: { question?: string; path?: string[]; previous?: string | null; chart?: "line" | "bar"; viaButton?: boolean } = {}) {
    const id = next.current++;
    const question = opts.question ?? typed, path = opts.path ?? [];
    setTurns((ts) => [...ts, { id, typed, question, path, reply: null, chart: opts.chart, viaButton: opts.viaButton }]);
    setBusy(true);
    let reply: Reply;
    try {
      const res = await fetch("/api/assistant-query", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, path, ...(opts.previous ? { previous: opts.previous } : {}) }) });
      const j = await res.json();
      reply = "error" in j ? { kind: "error", error: j.error } : (j as Reply);
    } catch (e) {
      reply = { kind: "error", error: e instanceof Error ? e.message : String(e) };
    }
    // A presentation-only follow-up ("make it a bar chart") redraws the last answer; no data question is asked (P69).
    if (reply.kind === "presentation") {
      const last = [...turnsRef.current].reverse().find((t) => t.reply?.kind === "answer");
      if (last && last.reply) reply = { ...(last.reply as Extract<Reply, { kind: "answer" }>), ms: reply.ms };
    }
    const shown = reply;
    setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, reply: shown, question: "asked" in shown && shown.asked ? shown.asked : t.question } : t)));
    setBusy(false);
  }

  // A typed question follows up on the last answer the engine read (P69).
  const lastAsked = () => [...turns].reverse().find((t) => t.reply && "asked" in t.reply && t.reply.kind !== "presentation")?.question ?? null;
  const ask = (text: string) => {
    if (!text.trim() || busy) return;
    if (source !== "auto" && source !== "nibrs") {
      const id = next.current++;
      setTurns((ts) => [...ts, { id, typed: text, question: text, path: [], reply: { kind: "decline", reason: `route:${source}`, text: "This source is not available yet in the preview; it is added to the new engine before launch.", buttons: [], notBuilt: false, asked: text } }]);
      return;
    }
    const chart = /\bbar\b/i.test(text) ? "bar" : /\bline\b/i.test(text) ? "line" : undefined;
    void run(text.trim(), { previous: lastAsked(), chart });
  };
  const click = (t: Turn, b: PreviewButton) => void run(b.label, { question: t.question, path: b.path, viaButton: true });

  useEffect(() => {
    const last = turns[turns.length - 1];
    if (last) document.getElementById(`me${last.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [turns.length]); // eslint-disable-line react-hooks/exhaustive-deps

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

      <main className="Chat">
        {turns.length === 0 ? (
          <div className="Empty">
            <h1>Crime Data Assistant</h1>
            <p>Questions about U.S. crime data, answered with a chart, a table and the source. This preview answers NIBRS questions; the other sources are added before launch.</p>
            <div className="Examples">{EXAMPLES.map((q) => <button key={q} type="button" onClick={() => ask(q)}>{q}</button>)}</div>
          </div>
        ) : null}
        {turns.map((t) => (
          <div key={t.id}>
            <div className="Me" id={`me${t.id}`}><p>{t.typed}</p></div>
            <div className="Re">{t.reply ? <ReplyView t={t} onButton={(b) => click(t, b)} onAsk={(q, prev) => void run(q, { previous: prev })} /> : <div className="wait">Answering</div>}</div>
          </div>
        ))}
      </main>

      <div className="Dock">
        <form className="DockInner" onSubmit={(e) => { e.preventDefault(); ask(input); setInput(""); }}>
          <input ref={box} value={input} onChange={(e) => setInput(e.target.value)} placeholder={turns.length ? "Ask a question or a follow-up" : "Shoplifting in Memphis by month in 2024"} aria-label="Question" />
          <label className="Src"><span className="k">Source</span>
            <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Source">
              <option value="auto">Auto</option><option value="nibrs">NIBRS</option><option value="current">Current Trends</option>
              <option value="historical">Historical</option><option value="shr">Homicide Reports</option><option value="hate">Hate Crime</option>
            </select>
          </label>
          <button className="Ask" type="submit" disabled={busy}>Ask</button>
        </form>
        <p className="fine">Answers come from FBI data and can be wrong. Check important figures against the FBI Crime Data Explorer.</p>
      </div>
    </div>
  );
}

function ReplyView({ t, onButton, onAsk }: { t: Turn; onButton: (b: PreviewButton) => void; onAsk: (q: string, previous: string | null) => void }) {
  const r = t.reply!;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const ms = "ms" in r && r.ms !== undefined ? <p className="ms">{(r.ms / 1000).toFixed(1)} s</p> : null;
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
    {ms}
  </>);
  if (r.kind === "presentation") return <p className="say">There is no earlier chart to change. {ms}</p>;
  if (r.kind === "clarify") return (<>
    {read}
    <p className="say">{sentence(r.about)}</p>
    <Choices buttons={r.buttons} onButton={onButton} />
    {ms}
  </>);
  if (r.kind === "decline") return (<>
    {r.reason.startsWith("route:") ? <p className="unavailable">Not available yet in this preview</p> : r.notBuilt ? <p className="unavailable">Not in this test build</p> : null}
    {read}
    <p className="say">{r.text}</p>
    <Choices buttons={r.buttons} onButton={onButton} primary />
    {ms}
  </>);
  return (<>{read}<AnswerView r={r} chartKind={t.chart} headline={!read} onButton={onButton} />{ms}</>);
}

function Choices({ buttons, onButton, primary = false }: { buttons: PreviewButton[]; onButton: (b: PreviewButton) => void; primary?: boolean }) {
  if (!buttons.length) return null;
  return (
    <div className="Choices">
      {buttons.map((b, i) => (
        <button key={b.label} type="button" className={`Choice${primary && i === 0 && b.kind === "continuation" ? " primary" : ""}`} disabled={b.kind !== "continuation"} onClick={() => onButton(b)}>
          <span>{b.label}</span>
          {b.kind === "not-built" ? <span className="k">Not in this build</span> : b.kind === "other-source" ? <span className="k">Not available yet</span> : b.kind === "entry" ? <span className="k">Type it in the question</span> : null}
        </button>
      ))}
    </div>
  );
}

function AnswerView({ r, chartKind, headline, onButton }: { r: Extract<PreviewResponse, { kind: "answer" }>; chartKind?: "line" | "bar"; headline: boolean; onButton: (b: PreviewButton) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  const { columns, rows, text } = r;
  const numberCols = columns.filter((c) => rows.every((row) => row[c] === null || typeof row[c] === "number"));
  const groupCols = columns.filter((c) => !numberCols.includes(c));
  const notes = text.slice(1);

  // One number: the answer sentence only (owner, 2026-10-31), including a one-row series ("2024: 10,149").
  if (rows.length === 1 && numberCols.length === 1) {
    const v = rows[0][numberCols[0]];
    const shown = typeof v === "number" ? v.toLocaleString("en-US", { maximumFractionDigits: 1 }) : null;
    const s = text[0] ?? "";
    const i = shown ? s.indexOf(shown) : -1;
    return (<>
      <p className="say">{i >= 0 ? <>{s.slice(0, i)}<b>{shown}</b>{s.slice(i + shown!.length)}</> : s}</p>
      <Notes lines={notes} />
      <Choices buttons={r.buttons} onButton={onButton} />
    </>);
  }

  // The chart: the engine's time series, or a bar chart drawn from a breakdown's table (one category, first number column).
  let kind: "line" | "bar" | "hbar" | null = null, points: Point[] = [], series = "";
  if (r.chart && r.chart.xAxis && r.chart.yAxis?.[0]) {
    kind = chartKind ?? (r.chart.type === "bar" ? "bar" : "line");
    series = r.chart.yAxis[0];
    points = rows.map((row) => ({ x: String(row[r.chart!.xAxis]), label: label(row[r.chart!.xAxis]), y: row[series] as number | null }));
  } else if (rows.length > 1 && groupCols.length === 1 && numberCols.length >= 1) {
    kind = chartKind === "line" ? "line" : "hbar";
    series = numberCols[0];
    points = rows.map((row) => ({ x: String(row[groupCols[0]]), label: label(row[groupCols[0]]), y: row[series] as number | null }));
  }
  // A long breakdown: the largest categories are drawn (the engine sorts them, largest first); the table has all.
  const drawn = kind === "hbar" && points.length > MAX_BARS ? points.slice(0, MAX_BARS) : points;
  const sub = (text[0] ?? "").split(":")[0];

  return (<>
    {rows.length === 1 || headline ? <p className="say">{text[0]}</p> : null}
    <div className={`Answer${kind ? "" : " tableOnly"}`}>
      {kind ? (
        <div>
          <AnswerChart kind={kind} points={drawn} series={series} sub={sub} hover={hover} onHover={setHover} />
          {drawn.length < points.length ? <p className="chartnote">The {drawn.length} largest of {points.length} are drawn; the table lists all {points.length}.</p> : null}
        </div>
      ) : null}
      <div className="TableScroll">
        <table className="T">
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>{rows.map((row, i) => (
            <tr key={i} className={hover === i ? "hl" : ""} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              {columns.map((c) => <td key={c}>{cell(row[c], /\(%\)/.test(c))}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
    <Notes lines={rows.length === 1 ? notes : text.slice(1)} />
    <Choices buttons={r.buttons} onButton={onButton} />
  </>);
}

function Notes({ lines }: { lines: string[] }) {
  if (!lines.length) return null;
  return <div className="notes">{lines.map((l, i) => <p key={i} className={i === lines.length - 1 && /^Source:/.test(l) ? "src" : ""}>{l}</p>)}</div>;
}
