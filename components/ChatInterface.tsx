"use client";

import { useState, useRef, useCallback } from "react";
import type { QueryResponse, QueryError } from "@/lib/types";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import CrimeIndexLogo from "./CrimeIndexLogo";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  sql?: string;
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const [currentResponse, setCurrentResponse] =
    useState<QueryResponse | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const question = input.trim();
      if (!question || loading) return;

      setInput("");
      setLoading(true);

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        text: question,
      };

      const history = messages.map((m) => ({
        role: m.role,
        content: m.text,
      }));

      setMessages((prev) => [...prev, userMsg]);

      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history }),
        });

        const data = await res.json();

        if (data.success) {
          const resp = data as QueryResponse;
          const assistantMsg: Message = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            text: resp.explanation,
            sql: resp.sql || undefined,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setCurrentResponse(resp);
        } else {
          const err = data as QueryError;
          const assistantMsg: Message = {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            text: `Error: ${err.error}`,
            sql: err.sql || undefined,
          };
          setMessages((prev) => [...prev, assistantMsg]);
          setCurrentResponse(null);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            text: `Error: ${msg}`,
          },
        ]);
        setCurrentResponse(null);
      } finally {
        setLoading(false);
      }
    },
    [input, loading, messages]
  );

  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface)]">
      {/* Header */}
      <header className="bg-white border-b border-[var(--border)] px-6 flex items-center justify-between shrink-0" style={{ height: 72 }}>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <CrimeIndexLogo size={28} />
            <span className="text-sm font-medium tracking-widest uppercase text-[var(--foreground)]" style={{ letterSpacing: "2.5px" }}>Crime Index</span>
          </div>
          <div className="h-6 w-px bg-[var(--border)]" />
          <span className="text-sm text-[var(--foreground)]">Data Assistant</span>
        </div>
        <span className="text-xs text-[var(--muted)]">700+ agencies · 48 states · 2017–2025</span>
      </header>

      {/* Search bar area */}
      <div className="bg-white border-b border-[var(--border)]">
        <div className="max-w-5xl mx-auto px-6 py-4">
          <form onSubmit={handleSubmit} className="flex gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question about crime data..."
              className="flex-1 px-4 py-2.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[#475EC7] bg-[var(--surface)]"
              disabled={loading}
              autoFocus
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--foreground)] rounded-full hover:bg-[var(--accent-hover)] disabled:opacity-40 cursor-pointer"
            >
              {loading ? "..." : "Ask"}
            </button>
          </form>
          {messages.length === 0 && !loading && (
            <div className="flex gap-3 mt-3 justify-center">
              {["National murder trend", "Robbery in Houston 2020–2024", "Compare Texas cities"].map((q) => (
                <button
                  key={q}
                  onClick={() => { setInput(q); }}
                  className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[#475EC7] hover:text-[#475EC7] cursor-pointer transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Response area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 space-y-4">
          {/* Loading */}
          {loading && (
            <div className="bg-white rounded-xl border border-[var(--border)] px-5 py-4">
              <div className="text-sm text-[var(--muted)] flex items-center gap-2">
                <span className="inline-flex gap-0.5">
                  <span className="animate-bounce text-[#475EC7]">·</span>
                  <span className="animate-bounce text-[#475EC7]" style={{ animationDelay: "0.1s" }}>·</span>
                  <span className="animate-bounce text-[#475EC7]" style={{ animationDelay: "0.2s" }}>·</span>
                </span>
                Analyzing your question...
              </div>
            </div>
          )}

          {/* Explanation */}
          {!loading && messages.length > 0 && (
            <div className="bg-white rounded-xl border border-[var(--border)] px-5 py-4">
              <p className="text-sm text-[var(--foreground)] leading-relaxed">
                {messages[messages.length - 1]?.role === "assistant"
                  ? messages[messages.length - 1].text
                  : ""}
              </p>
            </div>
          )}

          {/* Chart */}
          {currentResponse?.chartConfig && (
            <div className="bg-white rounded-xl border border-[var(--border)] p-5">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]" style={{ letterSpacing: "0.6px" }}>
                  {currentResponse.title}
                </h2>
                <ExportButtons
                  chartRef={chartRef}
                  csvFilename={`${currentResponse.title || "chart"}.jpeg`}
                />
              </div>
              <div style={{ height: 360 }}>
                <ChartPanel
                  ref={chartRef}
                  config={currentResponse.chartConfig}
                  rows={currentResponse.rows}
                />
              </div>
            </div>
          )}

          {/* Table */}
          {currentResponse && currentResponse.rows.length > 0 && (
            <div className="bg-white rounded-xl border border-[var(--border)] p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]" style={{ letterSpacing: "0.6px" }}>
                  Data{" "}
                  <span className="normal-case tracking-normal">
                    ({currentResponse.rowCount.toLocaleString()} rows
                    {currentResponse.executionTimeMs > 0 &&
                      ` · ${(currentResponse.executionTimeMs / 1000).toFixed(1)}s`}
                    )
                  </span>
                </h2>
                <ExportButtons
                  csvData={currentResponse.rows}
                  csvColumns={currentResponse.columns}
                  csvFilename={`${currentResponse.title || "crime-data-export"}.csv`}
                />
              </div>
              <DataTable
                columns={currentResponse.columns}
                rows={currentResponse.rows}
                truncated={currentResponse.truncated}
              />
            </div>
          )}

          {/* Previous questions */}
          {messages.filter(m => m.role === "user").length > 0 && (
            <div className="pt-2">
              <p className="text-[10px] uppercase tracking-wider text-[var(--muted)] mb-2" style={{ letterSpacing: "0.6px" }}>Previous questions</p>
              <div className="space-y-1">
                {[...messages].reverse().filter(m => m.role === "user").map((msg) => (
                  <button
                    key={msg.id}
                    onClick={() => setInput(msg.text)}
                    className="block text-xs text-[var(--muted)] hover:text-[#475EC7] cursor-pointer transition-colors"
                  >
                    {msg.text}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
