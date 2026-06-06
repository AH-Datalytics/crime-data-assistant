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
            className="px-4 sm:px-6 py-2 sm:py-2.5 text-sm font-medium text-white bg-[var(--accent)] rounded-full hover:bg-[var(--accent-hover)] disabled:opacity-40 cursor-pointer shrink-0"
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

      {/* Side panel layout: conversation sidebar (left) + results (right) */}
      <div className="flex-1 min-h-0 flex flex-col md:flex-row overflow-auto md:overflow-hidden">

        {/* Left sidebar — conversation, follow-up, history */}
        {(messages.length > 0 || loading) && (
          <div className="md:w-[280px] lg:w-[320px] border-b md:border-b-0 md:border-r border-[var(--border)] bg-white shrink-0 md:overflow-y-auto p-3 sm:p-4 flex flex-col">
            {/* Tab badge */}
            <span className="inline-block text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded mb-2 w-fit" style={{ backgroundColor: '#8B691415', color: '#8B6914' }}>
              SHR
            </span>

            {/* Title */}
            {currentResponse?.title && (
              <h3 className="text-sm font-semibold text-[var(--foreground)] mb-2 leading-snug">{currentResponse.title}</h3>
            )}

            {/* Messages */}
            {messages.length > 0 && (
              <div className="space-y-2 mb-3">
                {messages.filter(m => m.role === "assistant").slice(-1).map((msg) => (
                  <p key={msg.id} className="text-[13px] text-[var(--foreground)] leading-relaxed whitespace-pre-line">{msg.text}</p>
                ))}
              </div>
            )}

            {/* Loading indicator */}
            {loading && (
              <div className="text-xs text-[var(--muted)] flex items-center gap-1 mb-3">
                <span className="inline-flex gap-0.5">
                  <span className="w-1 h-1 rounded-full animate-pulse bg-[var(--navy)]" />
                  <span className="w-1 h-1 rounded-full animate-pulse bg-[var(--navy)]" style={{ animationDelay: "0.3s" }} />
                  <span className="w-1 h-1 rounded-full animate-pulse bg-[var(--navy)]" style={{ animationDelay: "0.6s" }} />
                </span>
                Thinking...{elapsed > 3 && <span className="opacity-60 ml-1">({elapsed}s)</span>}
              </div>
            )}

            {/* Follow-up input */}
            {!loading && messages.length > 0 && (
              <div className="mt-auto pt-3">
                <form
                  onSubmit={(e) => { e.preventDefault(); const val = (e.currentTarget.elements.namedItem("reply") as HTMLInputElement)?.value?.trim(); if (val) { submitQuestion(val); (e.currentTarget.elements.namedItem("reply") as HTMLInputElement).value = ""; } }}
                  className="flex gap-2"
                >
                  <input
                    name="reply"
                    type="text"
                    placeholder="Follow up..."
                    className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]"
                  />
                  <button type="submit" className="px-3 py-1.5 text-xs font-medium text-white bg-[#8B6914] rounded-lg cursor-pointer shrink-0">
                    Ask
                  </button>
                </form>
                <button
                  onClick={() => { setMessages([]); setCurrentResponse(null); }}
                  className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors mt-3"
                >
                  Clear History
                </button>
              </div>
            )}
          </div>
        )}

        {/* Right panel — hero, chart, table */}
        {messages.length === 0 && !currentResponse ? (
          <div className="flex-1 overflow-auto flex flex-col">
            <div className="bg-white border-b border-[var(--border)] shrink-0">
              <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 text-center">
                <span className="text-[13px] sm:text-sm text-gray-400">
                  Explore <span className="font-semibold text-[var(--navy)]">890,000+</span> homicide victims from the FBI&apos;s Supplementary Homicide Reports, 1976&ndash;present. Includes victim/offender demographics, weapon, circumstance, and relationship data. Coverage varies by state and year.
                </span>
              </div>
            </div>
            <div className="flex-1 flex items-center justify-center bg-[var(--surface)]">
              <div className="max-w-3xl w-full px-4 sm:px-6 py-6">
                {heroData && heroData.length > 0 && <ShrHeroChart data={heroData} />}
                <p className="text-xs text-center text-gray-400 mt-4">
                  I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
                </p>
              </div>
            </div>
          </div>
        ) : loading && !currentResponse ? (
          <div className="flex-1 relative">
            <QuerySkeleton accentColor="var(--navy)" step="Thinking..." elapsed={elapsed} />
          </div>
        ) : currentResponse ? (
          <div className="flex-1 flex flex-col md:flex-row overflow-auto md:overflow-hidden">
            {/* Chart panel */}
            <div className={`${currentResponse.rows.length > 0 ? "md:w-1/2 md:border-r" : "w-full"} border-b md:border-b-0 border-[var(--border)] bg-white shrink-0 md:shrink md:overflow-auto`} style={{ minHeight: 280 }}>
              {currentResponse.chartConfig ? (
                <div ref={chartRef} className="px-3 sm:px-4 pt-3 pb-1 h-full flex flex-col">
                  <div className="flex items-end justify-end gap-2 sm:gap-3 mb-1 shrink-0">
                    <ExportButtons
                      chartRef={chartRef}
                      csvFilename={`${currentResponse.title || "chart"}.jpeg`}
                      embedData={currentResponse.sql ? {
                        tab: "shr",
                        title: currentResponse.title,
                        sql: currentResponse.sql,
                        chartConfig: currentResponse.chartConfig,
                        chartMeta: currentResponse.chartMeta,
                      } : undefined}
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
                <div className="p-4 text-sm text-gray-400">No chart for this query</div>
              )}
            </div>

            {/* Table panel */}
            {currentResponse.rows.length > 0 && (
              <div className="md:w-1/2 shrink-0 md:shrink md:overflow-auto bg-white">
                <div className="p-3 sm:p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h2 className="text-[11px] sm:text-xs font-medium uppercase tracking-wider text-[var(--muted)]" style={{ letterSpacing: "0.6px" }}>
                      Data ({currentResponse.rowCount.toLocaleString()} rows
                      {currentResponse.executionTimeMs > 0 && ` · ${(currentResponse.executionTimeMs / 1000) < 0.1 ? '<0.1' : (currentResponse.executionTimeMs / 1000).toFixed(1)}s`})
                    </h2>
                    <ExportButtons
                      csvData={currentResponse.rows}
                      csvColumns={currentResponse.columns}
                      csvFilename={`${currentResponse.title || "shr-export"}.csv`}
                    />
                  </div>
                  <DataTable
                    columns={currentResponse.columns}
                    rows={currentResponse.rows}
                    truncated={currentResponse.truncated}
                  />
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
      {currentResponse && (
        <p className="text-xs text-center text-gray-400 py-1 border-t border-[var(--border)] bg-white shrink-0">
          I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
        </p>
      )}
    </div>
  );
}
