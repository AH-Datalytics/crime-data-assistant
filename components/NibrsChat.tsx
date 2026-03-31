"use client";

import { useState, useRef, useCallback } from "react";
import type { QueryResponse, QueryError } from "@/lib/types";
import DataTable from "./DataTable";
import NibrsChartPanel from "./NibrsChartPanel";
import ExportButtons from "./ExportButtons";
import NibrsHeroChart from "./NibrsHeroChart";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  sql?: string;
}

interface NibrsChatProps {
  visible: boolean;
}

export default function NibrsChat({ visible }: NibrsChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [currentResponse, setCurrentResponse] =
    useState<QueryResponse | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;

      setInput("");
      setLoading(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

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
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const res = await fetch("/api/nibrs-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

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
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        const msg = isAbort
          ? "That request took too long. Try a simpler question — a specific city, state, or shorter time range."
          : err instanceof Error ? err.message : "Network error";
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            text: isAbort ? msg : `Error: ${msg}`,
          },
        ]);
        setCurrentResponse(null);
      } finally {
        if (timerRef.current) clearInterval(timerRef.current);
        setLoading(false);
      }
    },
    [input, loading, messages]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitQuestion(input.trim());
    },
    [input, submitQuestion]
  );

  return (
    <div className="flex-1 flex flex-col min-h-0" style={{ display: visible ? "flex" : "none" }}>
      {/* Search bar */}
      <div className="bg-white border-b border-[var(--border)] shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={`Ask about NIBRS crime data (1991–${new Date().getFullYear()})...`}
              className="flex-1 px-4 py-2.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[var(--navy)] bg-[var(--surface)]"
              disabled={loading}
              autoFocus
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--navy)] rounded-full hover:bg-[var(--navy-light)] disabled:opacity-40 cursor-pointer"
            >
              {loading ? "..." : "Ask"}
            </button>
          </form>
          {/* Suggestion pills or clear button */}
          <div className="flex flex-wrap gap-2 sm:gap-3 mt-3 items-center">
            {messages.length === 0 && !loading ? (
              <>
                {[
                  "How many vehicle burglaries in Boston in 2023?",
                  "Show carjacking trend by month/year",
                  `Murders by weapon in Houston in ${new Date().getFullYear() - 1}`,
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => submitQuestion(q)}
                    className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[var(--navy)] hover:text-[var(--navy)] cursor-pointer transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </>
            ) : messages.length > 0 && (
              <button
                onClick={() => { setMessages([]); setCurrentResponse(null); }}
                className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors ml-auto"
              >
                Clear
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Response text + message history */}
      <div className="border-b border-[var(--border)] bg-white shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 overflow-y-auto max-h-40 space-y-2">
          {loading && (
            <div className="text-sm text-[var(--muted)]">
              <span className="inline-flex gap-0.5">
                <span className="animate-bounce text-[var(--navy)]">·</span>
                <span className="animate-bounce text-[var(--navy)]" style={{ animationDelay: "0.1s" }}>·</span>
                <span className="animate-bounce text-[var(--navy)]" style={{ animationDelay: "0.2s" }}>·</span>
              </span>{" "}
              Thinking...{elapsed > 3 && ` (${elapsed}s)`}
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`text-sm ${
                msg.role === "user"
                  ? "text-[var(--muted)]"
                  : "text-[var(--foreground)]"
              }`}
            >
              {msg.role === "user" ? (
                <span className="font-semibold">Q: {msg.text}</span>
              ) : (
                <span dangerouslySetInnerHTML={{ __html: msg.text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
              )}
            </div>
          ))}
          {messages.length === 0 && !loading && (
            <div className="text-sm text-gray-400 py-1 text-center">
              Review more than <span className="font-semibold text-[var(--navy)]">1 Billion</span> NIBRS records relating to offenses, victims, arrestees, weapons, property, clearances, and more! Data available since 1991, recent data is preliminary and subject to change.
            </div>
          )}
        </div>
      </div>

      {/* Content area */}
      {messages.length === 0 && !currentResponse ? (
        /* Hero chart when idle */
        <div className="flex-1 overflow-auto bg-[var(--surface)]">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 py-6">
            <NibrsHeroChart />
            <p className="text-xs text-center text-gray-400 mt-4">
              I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
            </p>
          </div>
        </div>
      ) : (
        /* Chart + Table — side by side on desktop, stacked on mobile/tablet */
        <div className="flex-1 flex flex-col md:flex-row overflow-auto md:overflow-hidden">
          {/* Chart panel */}
          <div className="md:w-1/2 md:border-r border-b md:border-b-0 border-[var(--border)] bg-white shrink-0 md:shrink md:overflow-auto" style={{ minHeight: 320 }}>
            {currentResponse?.chartConfig ? (
              <div ref={chartRef} className="px-4 pt-3 pb-1 h-full flex flex-col">
                <div className="flex items-center justify-between mb-1 shrink-0">
                  <h2
                    className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                    style={{ letterSpacing: "0.6px" }}
                  >
                    {currentResponse.title}
                  </h2>
                  <ExportButtons
                    chartRef={chartRef}
                    csvFilename={`${currentResponse.title || "chart"}.jpeg`}
                  />
                </div>
                <div className="flex-1 min-h-0" style={{ minHeight: 280 }}>
                  <NibrsChartPanel
                    config={currentResponse.chartConfig}
                    rows={currentResponse.rows}
                  />
                </div>
              </div>
            ) : (
              <div className="p-4 text-sm text-gray-400">
                {currentResponse
                  ? "No chart for this query"
                  : "Chart will appear here"}
              </div>
            )}
          </div>

          {/* Table panel */}
          <div className="md:w-1/2 shrink-0 md:shrink md:overflow-auto bg-white">
            {currentResponse && currentResponse.rows.length > 0 ? (
              <div className="p-4">
                <div className="flex items-center justify-between mb-2">
                  <h2
                    className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                    style={{ letterSpacing: "0.6px" }}
                  >
                    Data ({currentResponse.rowCount.toLocaleString()} rows
                    {currentResponse.executionTimeMs > 0 &&
                      ` · ${(currentResponse.executionTimeMs / 1000).toFixed(1)}s`}
                    )
                  </h2>
                  <ExportButtons
                    csvData={currentResponse.rows}
                    csvColumns={currentResponse.columns}
                    csvFilename={`${currentResponse.title || "nibrs-export"}.csv`}
                  />
                </div>
                <DataTable
                  columns={currentResponse.columns}
                  rows={currentResponse.rows}
                  truncated={currentResponse.truncated}
                />
              </div>
            ) : (
              <div className="p-4 text-sm text-gray-400">
                {currentResponse
                  ? "No data for this query"
                  : "Data table will appear here"}
              </div>
            )}
          </div>
        </div>
      )}
      {currentResponse && (
        <p className="text-xs text-center text-gray-400 py-1 border-t border-[var(--border)] bg-white shrink-0">
          I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
        </p>
      )}
    </div>
  );
}
