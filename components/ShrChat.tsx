"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { QueryResponse, QueryError } from "@/lib/types";
import DataTable from "./DataTable";
import NibrsChartPanel from "./NibrsChartPanel";
import ExportButtons from "./ExportButtons";
import { useAnimatedPlaceholder } from "./useAnimatedPlaceholder";
import QuerySkeleton from "./QuerySkeleton";
import ErrorCard from "./ErrorCard";
import { getPageToken } from "./Tracker";
import ShrHeroChart from "./ShrHeroChart";
import { useCaptcha } from "./useCaptcha";
import TurnstileModal from "./TurnstileModal";

const SHR_PROMPTS = [
  "Domestic homicides by weapon type since 2000",
  "Victim race breakdown in Texas since 2010",
];
const SHR_DEFAULT = "Ask about Supplementary Homicide Report data...";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  sql?: string;
}

interface ShrChatProps {
  visible: boolean;
  heroData?: { year: number; pct_firearm: number }[];
}

export default function ShrChat({ visible, heroData }: ShrChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [loading, setLoading] = useState(false);
  const animated = useAnimatedPlaceholder(SHR_PROMPTS, SHR_DEFAULT);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  const { captchaNeeded, requestCaptcha, onVerified, onClose } = useCaptcha();

  const [currentResponse, setCurrentResponse] =
    useState<QueryResponse | null>(null);

  const chartRef = useRef<HTMLDivElement>(null);
  const pastQueries = messages.filter((m) => m.role === "user").map((m) => m.text);

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;

      setInput("");
      setHasInteracted(true);
      animated.pause();
      setLoading(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        text: question,
      };

      const history = messages.slice(-6).map((m) => ({  // last 3 exchanges
        role: m.role,
        content: m.text,
      }));

      setMessages((prev) => [...prev, userMsg]);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90000);
        const res = await fetch("/api/shr-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history, sessionId: (() => { try { return sessionStorage.getItem("cda-session") || ""; } catch { return ""; } })(), pageToken: getPageToken() }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await res.json();

        if (data.captchaRequired) {
          // Remove the user message we just added — will re-add on retry
          setMessages((prev) => prev.slice(0, -1));
          if (timerRef.current) clearInterval(timerRef.current);
          setLoading(false);
          requestCaptcha(() => submitQuestion(question));
          return;
        }

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
    [loading, messages]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitQuestion(input.trim());
    },
    [input, submitQuestion]
  );

  const hasActiveQuery = messages.length > 0 || loading;

  const searchBar = (
    <div className={`bg-white ${hasActiveQuery ? "border-t" : "border-b"} border-[var(--border)] shrink-0`}>
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2.5 sm:py-4">
        <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
          <input
            type="text"
            value={input}
            onChange={(e) => { setInput(e.target.value); if (!hasInteracted && e.target.value) { setHasInteracted(true); animated.pause(); } }}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            placeholder={!hasInteracted ? animated.placeholder : SHR_DEFAULT}
            className="flex-1 min-w-0 px-3 sm:px-4 py-2 sm:py-2.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[var(--navy)] bg-[var(--surface)]"
            disabled={loading}
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            className="px-4 sm:px-6 py-2 sm:py-2.5 text-sm font-medium text-white bg-[var(--navy)] rounded-full hover:bg-[var(--navy-light)] disabled:opacity-40 cursor-pointer shrink-0"
          >
            {loading ? "..." : "Ask"}
          </button>
        </form>
        {/* History pills or sample questions */}
        <div className="flex flex-nowrap sm:flex-wrap gap-1.5 sm:gap-3 mt-2 sm:mt-3 items-center overflow-x-auto scrollbar-hide">
          {pastQueries.length > 0 && (
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1 shrink-0">History:</span>
          )}
          {pastQueries.length > 0 && (
            <button
              onClick={() => { setMessages([]); setCurrentResponse(null); }}
              className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors ml-auto shrink-0"
            >
              Clear
            </button>
          )}
          {pastQueries.length > 0
            ? (<>
                {pastQueries.slice(-5).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => submitQuestion(q)}
                    className="group relative text-[11px] pl-2.5 sm:pl-3 pr-6 sm:pr-7 py-1 sm:py-1.5 rounded-lg bg-white border border-[var(--border)] text-[var(--muted)] hover:shadow-md hover:border-transparent hover:text-[var(--foreground)] cursor-pointer transition-all duration-200 shrink-0"
                  >
                    {q}
                    <svg className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 transition-opacity" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 14L14 2M14 2H5M14 2v9"/></svg>
                  </button>
                ))}
              </>)
            : !loading && (
              <>
                <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1 shrink-0">Sample Questions:</span>
                {[
                  "Big cities with highest share of murders via firearm in 2024",
                  "Show domestic homicide trends nationally since 2000",
                  "Victim age breakdown in Texas in 2023",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => submitQuestion(q)}
                    className="group relative text-[11px] pl-2.5 sm:pl-3 pr-6 sm:pr-7 py-1 sm:py-1.5 rounded-lg bg-white border border-[var(--border)] text-[var(--muted)] hover:shadow-md hover:border-transparent hover:text-[var(--foreground)] cursor-pointer transition-all duration-200 shrink-0"
                  >
                    {q}
                    <svg className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 transition-opacity" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 14L14 2M14 2H5M14 2v9"/></svg>
                  </button>
                ))}
              </>
            )
          }
        </div>
      </div>
    </div>
  );

  return (
    <div className={`flex-1 flex flex-col min-h-0 ${visible ? "tab-fade-in" : ""}`} style={{ display: visible ? "flex" : "none" }}>
      {captchaNeeded && <TurnstileModal onVerified={onVerified} onClose={onClose} />}
      {/* Search bar at top only before first query */}
      {!hasActiveQuery && searchBar}

      {/* Response text + message history */}
      <div className="border-b border-[var(--border)] bg-white shrink-0">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2">
          {loading && currentResponse && (
            <div className="text-sm text-[var(--muted)] flex items-center gap-2">
              <span className="inline-flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--navy)]" />
                <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--navy)]" style={{ animationDelay: "0.3s" }} />
                <span className="w-1.5 h-1.5 rounded-full animate-pulse bg-[var(--navy)]" style={{ animationDelay: "0.6s" }} />
              </span>
              Thinking...{elapsed > 3 && <span className="text-xs opacity-60 ml-1">({elapsed}s)</span>}
            </div>
          )}
          {messages.length > 0 && (
            <button
              onClick={() => setChatCollapsed(c => !c)}
              className="text-[11px] font-semibold uppercase tracking-wider text-[var(--accent)] hover:text-[var(--foreground)] cursor-pointer transition-colors flex items-center gap-1.5 mb-1 px-1.5 sm:px-2 py-1 rounded-md hover:bg-[var(--surface)]"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${chatCollapsed ? "" : "rotate-90"}`} fill="none" stroke="currentColor" strokeWidth={2.5} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
              {chatCollapsed ? "Show conversation" : "Hide conversation"}
            </button>
          )}
          {/* Scrollable message area */}
          {!chatCollapsed && messages.length > 0 && (
            <div className="overflow-y-auto max-h-24 sm:max-h-32 space-y-2">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`text-[13px] sm:text-sm ${
                    msg.role === "user"
                      ? "text-[var(--muted)]"
                      : "text-[var(--foreground)]"
                  }`}
                >
                  {msg.role === "user" ? (
                    <span className="font-semibold">Q: {msg.text}</span>
                  ) : (
                    <span className="whitespace-pre-line">{msg.text}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {chatCollapsed && messages.length > 0 && (
            <div className="text-xs text-[var(--muted)] italic">
              {messages.filter(m => m.role === "user").slice(-1)[0]?.text}
            </div>
          )}
          {/* Follow-up input + history — always visible outside scroll area */}
          {!loading && messages.length > 0 && (
            <>
            <form
              onSubmit={(e) => { e.preventDefault(); const val = (e.currentTarget.elements.namedItem("reply") as HTMLInputElement)?.value?.trim(); if (val) { submitQuestion(val); (e.currentTarget.elements.namedItem("reply") as HTMLInputElement).value = ""; } }}
              className="flex gap-2 mt-2"
            >
              <input
                name="reply"
                type="text"
                placeholder="Ask a follow-up..."
                className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]"
              />
              <button type="submit" className="px-3 sm:px-4 py-1.5 text-xs font-medium text-white bg-[var(--foreground)] rounded-full hover:bg-[var(--accent-hover)] cursor-pointer shrink-0">
                Ask
              </button>
            </form>
            {pastQueries.length > 1 && (
              <div className="flex flex-nowrap gap-1.5 sm:gap-2 mt-2 items-center overflow-x-auto scrollbar-hide">
                <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1 shrink-0">History:</span>
                {pastQueries.slice(-5).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => submitQuestion(q)}
                    className="text-[10px] px-2 py-1 rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:border-transparent hover:shadow-sm cursor-pointer transition-all truncate max-w-[160px] sm:max-w-[200px] shrink-0"
                    title={q}
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}
            </>
          )}
          {messages.length === 0 && !loading && (
            <div className="text-[13px] sm:text-sm text-gray-400 py-1 text-center">
              Explore <span className="font-semibold text-[var(--navy)]">890,000+</span> homicide victims from the FBI&apos;s Supplementary Homicide Reports, 1976&ndash;present. Includes victim/offender demographics, weapon, circumstance, and relationship data. Coverage varies by state and year.
            </div>
          )}
        </div>
      </div>

      {/* Content area */}
      {messages.length === 0 && !currentResponse ? (
        /* Hero chart when idle */
        <div className="flex-1 overflow-auto flex items-center justify-center bg-[var(--surface)]">
          <div className="max-w-3xl w-full px-4 sm:px-6 py-6">
            {heroData && heroData.length > 0 && <ShrHeroChart data={heroData} />}
            <p className="text-xs text-center text-gray-400 mt-4">
              I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
            </p>
          </div>
        </div>
      ) : loading && !currentResponse ? (
        /* Skeleton while loading */
        <div className="flex-1 relative">
          <QuerySkeleton accentColor="var(--navy)" step="Thinking..." elapsed={elapsed} />
        </div>
      ) : (
        /* Chart + Table — side by side on desktop, stacked on mobile/tablet */
        <div className="flex-1 flex flex-col md:flex-row overflow-auto md:overflow-hidden">
          {/* Chart panel */}
          <div className="md:w-1/2 md:border-r border-b md:border-b-0 border-[var(--border)] bg-white shrink-0 md:shrink md:overflow-auto" style={{ minHeight: 280 }}>
            {currentResponse?.chartConfig ? (
              <div ref={chartRef} className="px-3 sm:px-4 pt-3 pb-1 h-full flex flex-col">
                <div className="flex items-start justify-between gap-2 sm:gap-3 mb-1 shrink-0">
                  <h2
                    className="text-[11px] sm:text-xs font-medium uppercase tracking-wider text-[var(--muted)] flex-1 min-w-0"
                    style={{ letterSpacing: "0.6px" }}
                  >
                    {currentResponse.title}
                  </h2>
                  <ExportButtons
                    chartRef={chartRef}
                    csvFilename={`${currentResponse.title || "chart"}.jpeg`}
                  />
                </div>
                <div className="flex-1 min-h-0" style={{ minHeight: 260 }}>
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
              <div className="p-3 sm:p-4">
                <div className="flex items-center justify-between mb-2">
                  <h2
                    className="text-[11px] sm:text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                    style={{ letterSpacing: "0.6px" }}
                  >
                    Data ({currentResponse.rowCount.toLocaleString()} rows
                    {currentResponse.executionTimeMs > 0 &&
                      ` · ${(currentResponse.executionTimeMs / 1000) < 0.1 ? '<0.1' : (currentResponse.executionTimeMs / 1000).toFixed(1)}s`}
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
              <div className="p-3 sm:p-4 text-sm text-gray-400">
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
