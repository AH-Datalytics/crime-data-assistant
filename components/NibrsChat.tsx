"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { QueryResponse, QueryError } from "@/lib/types";
import DataTable from "./DataTable";
import NibrsChartPanel from "./NibrsChartPanel";
import ExportButtons from "./ExportButtons";
import NibrsHeroChart from "./NibrsHeroChart";
import { useAnimatedPlaceholder } from "./useAnimatedPlaceholder";
import QuerySkeleton from "./QuerySkeleton";
import ErrorCard from "./ErrorCard";
import { getPageToken } from "./Tracker";
import { useCaptcha } from "./useCaptcha";
import TurnstileModal from "./TurnstileModal";

const NIBRS_PROMPTS = [
  "Carjackings per year in Houston since 2019",
  "Murders by weapon type in Pennsylvania last year",
];
const NIBRS_DEFAULT = "Ask about NIBRS crime data...";

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
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [showTable, setShowTable] = useState(true);
  const [expandedExplanation, setExpandedExplanation] = useState(false);
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [loading, setLoading] = useState(false);
  const animated = useAnimatedPlaceholder(NIBRS_PROMPTS, NIBRS_DEFAULT);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  const { captchaNeeded, requestCaptcha, onVerified, onClose } = useCaptcha();

  const [currentResponse, setCurrentResponse] =
    useState<QueryResponse | null>(null);
  // Stack of past exchanges for the side rail
  const [exchanges, setExchanges] = useState<{ question: string; explanation: string; response: QueryResponse | null }[]>([]);
  const [activeExchangeIdx, setActiveExchangeIdx] = useState(-1);
  const [expandedRailIdx, setExpandedRailIdx] = useState(-1);

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
        const res = await fetch("/api/nibrs-query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history, sessionId: (() => { try { return sessionStorage.getItem("cda-session") || ""; } catch { return ""; } })(), pageToken: getPageToken() }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const data = await res.json();

        if (data.captchaRequired) {
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
          setExchanges((prev) => [...prev, { question, explanation: resp.explanation, response: resp }]);
          setActiveExchangeIdx(-1); // -1 means "latest"
          setExpandedRailIdx(-1);
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
          setExchanges((prev) => [...prev, { question, explanation: `Error: ${err.error}`, response: null }]);
          setActiveExchangeIdx(-1);
        }
      } catch (err) {
        const isAbort = err instanceof DOMException && err.name === "AbortError";
        const msg = isAbort
          ? "That request took too long. Try a simpler question — a specific city, state, or shorter time range."
          : err instanceof Error ? err.message : "Network error";
        const errText = isAbort ? msg : `Error: ${msg}`;
        setMessages((prev) => [
          ...prev,
          {
            id: (Date.now() + 1).toString(),
            role: "assistant",
            text: errText,
          },
        ]);
        setCurrentResponse(null);
        setExchanges((prev) => [...prev, { question, explanation: errText, response: null }]);
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
            placeholder={!hasInteracted ? animated.placeholder : NIBRS_DEFAULT}
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
                  "How many vehicle burglaries per month in Boston in 2023?",
                  "Show carjacking trend by month/year",
                  `Murders by weapon in Houston in ${new Date().getFullYear() - 1}`,
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

      {/* Side panel layout: left rail + right stage */}
      <div className="flex-1 min-h-0 flex">
        {/* LEFT RAIL */}
        {hasActiveQuery && (
          <div className="w-[260px] lg:w-[320px] xl:w-[340px] border-r border-[var(--border)] flex flex-col bg-white shrink-0 hidden md:flex">
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* New question bar */}
              {!loading && (
                <form onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem("railask") as HTMLTextAreaElement; const val = el?.value?.trim(); if (val) { setMessages([]); setCurrentResponse(null); setExchanges([]); setActiveExchangeIdx(-1); submitQuestion(val); el.value = ""; } }} className="flex flex-col gap-1.5">
                  <textarea name="railask" rows={2} placeholder="Ask a new question..." onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} className="w-full min-w-0 px-3 py-2 text-[12px] border border-[var(--border)] rounded-md focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)] resize-none" />
                  <button type="submit" className="self-end px-3 py-1.5 text-[11px] font-semibold text-white rounded-md hover:opacity-90 cursor-pointer" style={{ backgroundColor: '#2d8659' }}>Ask</button>
                </form>
              )}
              {/* Exchange stack */}
              {exchanges.map((ex, i) => {
                const isActive = activeExchangeIdx === -1 ? i === exchanges.length - 1 : i === activeExchangeIdx;
                const isExpanded = expandedRailIdx === i;
                return (
                  <div key={i} className={`rounded-md transition-all ${isActive ? "bg-[color-mix(in_srgb,#2d8659_6%,white)] border-l-[3px] pl-[9px] pr-3 py-2.5" : `${i === exchanges.length - 1 ? "opacity-60" : "opacity-45"} hover:opacity-80 pl-3 pr-3 py-2`}`} style={isActive ? { borderLeftColor: '#2d8659' } : undefined}>
                    <button onClick={() => { setActiveExchangeIdx(i); if (ex.response) setCurrentResponse(ex.response); }} className="w-full text-left cursor-pointer">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: '#2d8659' }}>NIBRS</span>
                        <span className={`text-[12px] leading-snug ${isActive ? "font-bold text-[var(--navy)]" : "font-semibold text-[var(--foreground-strong)]"}`}>{ex.question}</span>
                      </div>
                    </button>
                    <div className={`text-[11.5px] text-[var(--muted)] leading-relaxed whitespace-pre-line ${isExpanded ? "" : "line-clamp-4"}`}>
                      {ex.explanation}
                    </div>
                    {ex.explanation.length > 80 && (
                      <button onClick={() => setExpandedRailIdx(isExpanded ? -1 : i)} className="text-[10px] mt-1 cursor-pointer" style={{ color: '#2d8659' }}>{isExpanded ? "Show less" : "Show more"}</button>
                    )}
                    {isActive && !loading && (
                      <form onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem(`followup-${i}`) as HTMLInputElement; const val = el?.value?.trim(); if (val) { submitQuestion(val); el.value = ""; } }} className="flex gap-1 mt-2">
                        <input name={`followup-${i}`} type="text" placeholder="Follow up..." className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]" />
                        <button type="submit" className="px-2 py-1.5 text-[10px] font-semibold text-white rounded hover:opacity-90 cursor-pointer shrink-0" style={{ backgroundColor: '#2d8659' }}>Ask</button>
                      </form>
                    )}
                  </div>
                );
              })}
              {loading && (
                <div className="pl-3 pr-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                    <span className="inline-flex gap-0.5">
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: '#2d8659' }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: '#2d8659', animationDelay: "0.3s" }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: '#2d8659', animationDelay: "0.6s" }} />
                    </span>
                    Thinking...{elapsed > 3 && <span className="opacity-60 ml-1">({elapsed}s)</span>}
                  </div>
                </div>
              )}
              {exchanges.length > 0 && (
                <div className="text-center pt-2">
                  <button onClick={() => { setMessages([]); setCurrentResponse(null); setExchanges([]); setActiveExchangeIdx(-1); }} className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer">Clear history</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* RIGHT STAGE */}
        <div className={`flex-1 flex flex-col min-h-0 overflow-x-hidden bg-[var(--surface)] ${currentResponse ? "" : "overflow-y-auto"}`}>
          {/* Hero / idle */}
          {messages.length === 0 && !currentResponse && !loading && (
            <div className="flex-1 overflow-auto flex flex-col">
              <div className="bg-white border-b border-[var(--border)] shrink-0">
                <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 text-center">
                  <span className="text-[13px] sm:text-sm text-gray-400">
                    Review more than <span className="font-semibold text-[var(--navy)]">1 Billion</span> NIBRS records. Data available since 1991, recent data is preliminary and subject to change.
                  </span>
                </div>
              </div>
              <div className="flex-1 flex items-center justify-center">
                <div className="max-w-3xl w-full px-4 sm:px-6 py-6">
                  <NibrsHeroChart />
                  <p className="text-xs text-center text-gray-400 mt-4">I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.</p>
                </div>
              </div>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && !currentResponse && (
            <QuerySkeleton accentColor="var(--navy)" step="Thinking..." elapsed={elapsed} />
          )}

          {/* Results */}
          {currentResponse && (
            <div className="flex-1 flex flex-col p-3 sm:p-5 lg:p-6 min-h-0">
              <div className="mb-2 shrink-0 flex items-center gap-2">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-white uppercase tracking-wider" style={{ backgroundColor: '#2d8659' }}>NIBRS Explorer</span>
                <span className="text-[11px] text-[var(--muted)]">Incident-level crime data from the FBI</span>
              </div>
              <div className="flex items-center justify-between mb-2 sm:mb-3 shrink-0 flex-wrap gap-1">
                <div className="flex border border-[var(--border)] rounded-md overflow-hidden">
                  {currentResponse.chartConfig && (
                    <button onClick={() => setShowChart(v => !v)} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${showChart ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"}`}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 12 5 6 8 9 11 3 14 7"/></svg>
                      <span className="hidden sm:inline">Chart</span>
                    </button>
                  )}
                  {currentResponse.chartConfig && currentResponse.rows.length > 0 && <div className="w-px bg-[var(--border)]" />}
                  {currentResponse.rows.length > 0 && (
                    <button onClick={() => setShowTable(v => !v)} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${showTable ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"}`}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="2" x2="6" y2="14"/></svg>
                      <span className="hidden sm:inline">Table</span>
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  {currentResponse.chartConfig && showChart && (
                    <ExportButtons chartRef={chartRef} csvFilename={`${currentResponse.title || "chart"}.jpeg`} embedData={currentResponse.sql ? { tab: "nibrs", title: currentResponse.title, sql: currentResponse.sql, chartConfig: currentResponse.chartConfig, chartMeta: currentResponse.chartMeta } : undefined} />
                  )}
                  {currentResponse.rows.length > 0 && <ExportButtons csvData={currentResponse.rows} csvColumns={currentResponse.columns} csvFilename={`${currentResponse.title || "nibrs-export"}.csv`} />}
                </div>
              </div>
              <div className={`flex-1 flex flex-col ${showChart && currentResponse.chartConfig && showTable && currentResponse.rows.length > 0 ? "md:flex-row" : ""} gap-3 sm:gap-6 min-h-0`}>
                {currentResponse.chartConfig && showChart && (
                  <div ref={chartRef} className={`bg-white flex flex-col ${showTable && currentResponse.rows.length > 0 ? "md:flex-[1.15] md:min-w-0" : "w-full flex-1"}`}>
                    <div className="flex-1 min-h-0" style={{ minHeight: 280 }}>
                      <NibrsChartPanel config={currentResponse.chartConfig} rows={currentResponse.rows} />
                    </div>
                  </div>
                )}
                {currentResponse.rows.length > 0 && showTable && (
                  <div className={`bg-white overflow-hidden flex flex-col ${showChart && currentResponse.chartConfig ? "md:flex-[0.85] md:min-w-0" : "w-full flex-1"}`}>
                    <DataTable columns={currentResponse.columns} rows={currentResponse.rows} truncated={currentResponse.truncated} fillHeight />
                  </div>
                )}
              </div>
              <p className="text-[10px] text-center text-[var(--muted-light)] mt-3 shrink-0">I am a bot and sometimes may make mistakes. Verify findings with official sources.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
