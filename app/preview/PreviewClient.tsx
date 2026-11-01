"use client";

import { useState } from "react";
import DataTable from "@/components/DataTable";
import NibrsChartPanel from "@/components/NibrsChartPanel";
import type { PreviewButton, PreviewResponse } from "@/lib/nibrs-shadow/preview";

type Exchange = { question: string; path: string[]; result: PreviewResponse | { error: string } };

/** The preview's question box and answers: the existing table and chart components, plus the text and buttons. */
export default function PreviewClient() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);

  async function ask(question: string, path: string[] = []) {
    setLoading(true);
    try {
      const res = await fetch("/api/nibrs-shadow-query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, path }) });
      const result = (await res.json()) as PreviewResponse | { error: string };
      setExchanges((xs) => [{ question, path, result }, ...xs]);
    } catch (e) {
      setExchanges((xs) => [{ question, path, result: { error: e instanceof Error ? e.message : String(e) } }, ...xs]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-6 text-[#1e2a35]">
      <h1 className="text-xl font-semibold">NIBRS engine preview</h1>
      <p className="mb-4 text-sm text-gray-600">Private and local: the new engine on the pinned canonical build. Not the live site&apos;s answers.</p>
      <form className="mb-6 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (input.trim() && !loading) { void ask(input.trim()); setInput(""); } }}>
        <input aria-label="Question" className="flex-1 border border-gray-300 px-3 py-2" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Shoplifting in Memphis by month in 2024" />
        <button type="submit" className="border border-[#1e2a35] px-4 py-2" disabled={loading}>{loading ? "Running" : "Ask"}</button>
      </form>
      {exchanges.map((x, i) => (
        <section key={`${exchanges.length - i}`} className="mb-8 border-t border-gray-300 pt-4" data-testid="preview-exchange">
          <p className="mb-2 font-medium">{x.question}{x.path.length ? <span className="text-gray-600"> → {x.path.join(" → ")}</span> : null}</p>
          {/* P74: a question button asks its own question, as a new one, only when chosen; other buttons follow their path. */}
          {"error" in x.result ? <p className="text-red-700">{x.result.error}</p> : <Outcome r={x.result} onButton={(b) => void (b.kind === "question" && b.question ? ask(b.question, []) : ask(x.question, b.path))} />}
        </section>
      ))}
    </main>
  );
}

function Buttons({ buttons, onButton }: { buttons: PreviewButton[]; onButton: (b: PreviewButton) => void }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {buttons.map((b) => (
        <span key={b.label} className="inline-flex flex-col">
          <button type="button" className="border border-gray-400 px-3 py-1 text-sm disabled:text-gray-400" disabled={b.kind !== "continuation" && b.kind !== "question"} onClick={() => onButton(b)}>{b.label}</button>
          {b.note ? <span className="text-xs text-gray-500">{b.note}</span> : null}
        </span>
      ))}
    </div>
  );
}

function Outcome({ r, onButton }: { r: PreviewResponse; onButton: (b: PreviewButton) => void }) {
  if (r.kind === "clarify") return (<div><p>Which {r.about.replace(/^which /, "")}?</p><Buttons buttons={r.buttons} onButton={onButton} /></div>);
  if (r.kind === "decline") return (<div><p>{r.text}</p>{r.notBuilt ? <p className="text-sm text-gray-500">(Outside the years the data here covers.)</p> : null}<Buttons buttons={r.buttons} onButton={onButton} /></div>);
  return (
    <div>
      <p className="mb-2">{r.text[0]}</p>
      {/* As the live NIBRS view lays them out: the chart in a sized panel beside the table. */}
      {r.chart ? (
        <div className="flex flex-col gap-4 md:flex-row" style={{ minHeight: 340 }}>
          <div className="flex flex-col bg-white md:min-w-0 md:flex-[1.15]">
            <div className="min-h-0 flex-1" style={{ minHeight: 300 }}><NibrsChartPanel config={r.chart} rows={r.rows} /></div>
          </div>
          <div className="flex min-w-0 flex-1 flex-col" style={{ maxHeight: 420 }}><DataTable columns={r.columns} rows={r.rows} fillHeight /></div>
        </div>
      ) : (
        <div style={{ maxHeight: 420 }} className="flex flex-col"><DataTable columns={r.columns} rows={r.rows} /></div>
      )}
      <div className="mt-2 space-y-1 text-sm">{r.text.slice(1).map((t, j) => <p key={j}>{t}</p>)}</div>
      {r.buttons.length ? <Buttons buttons={r.buttons} onButton={onButton} /> : null}
    </div>
  );
}
