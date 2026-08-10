"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { QueryResponse, StreamEvent } from "@/lib/types";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import HeroChart from "./HeroChart";
import HistoricalHeroChart from "./HistoricalHeroChart";
import { useAnimatedPlaceholder } from "./useAnimatedPlaceholder";
import QuerySkeleton from "./QuerySkeleton";
import ErrorCard from "./ErrorCard";
import { getPageToken } from "./Tracker";
import { useCaptcha } from "./useCaptcha";
import TurnstileModal from "./TurnstileModal";

const CURRENT_PROMPTS = [
  "Show me robbery per month in the national sample",
  "Top 10 cities by aggravated assault rate in 2022",
];
const CURRENT_DEFAULT = "Ask a question about crime data...";

const HISTORICAL_PROMPTS = [
  "Chicago police staffing per year",
  "National murder rate since 1960",
];
const HISTORICAL_DEFAULT = "Ask about historical crime trends...";

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  sql?: string;
}

interface RtciChatProps {
  mode: "current" | "historical";
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  historicalMaxYear?: number;
  visible: boolean;
}

/** Parse SSE stream from fetch response */
async function readSSEStream(
  response: Response,
  onEvent: (event: StreamEvent) => void
) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";

    for (const part of parts) {
      const line = part.trim();
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          onEvent(event);
        } catch (e) {
          console.warn("[SSE] Failed to parse event:", line, e);
        }
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    try {
      const event = JSON.parse(buffer.trim().slice(6)) as StreamEvent;
      onEvent(event);
    } catch (e) {
      console.warn("[SSE] Failed to parse trailing event:", buffer, e);
    }
  }
}

export default function RtciChat({ mode, heroData, heroAgencyCount, heroPopulation, historicalHeroData, historicalMaxYear, visible }: RtciChatProps) {
  const [input, setInput] = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const [hasInteracted, setHasInteracted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const animated = useAnimatedPlaceholder(
    mode === "historical" ? HISTORICAL_PROMPTS : CURRENT_PROMPTS,
    mode === "historical" ? HISTORICAL_DEFAULT : CURRENT_DEFAULT,
  );
  const [loadingStep, setLoadingStep] = useState("");

  // Conversation history (for Claude context only, not displayed as thread)
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(`cda-history-${mode}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // Persist query history to localStorage
  useEffect(() => {
    try { localStorage.setItem(`cda-history-${mode}`, JSON.stringify(history)); } catch {}
  }, [history, mode]);

  // Current response state
  const [explanation, setExplanation] = useState("");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");

  const chartRef = useRef<HTMLDivElement>(null);
  const [showDatasetInfo, setShowDatasetInfo] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [showChart, setShowChart] = useState(true);
  const [showTable, setShowTable] = useState(true);
  const [expandedExplanation, setExpandedExplanation] = useState(false);
  const { captchaNeeded, requestCaptcha, onVerified, onClose } = useCaptcha();
  const [exchanges, setExchanges] = useState<{ question: string; explanation: string; response: QueryResponse | null }[]>([]);
  const [activeExchangeIdx, setActiveExchangeIdx] = useState(-1);
  const [expandedRailIdx, setExpandedRailIdx] = useState(-1);

  // Extract past user questions from history
  const pastQueries = history.filter((h) => h.role === "user").map((h) => h.content);

  const showCurrentHero = mode === "current" && !explanation && !loading && !error && !response && heroData && heroData.length > 0;
  const showHistoricalHero = mode === "historical" && !explanation && !loading && !error && !response && historicalHeroData && historicalHeroData.length > 0;

  const accentColor = mode === "current" ? "#475EC7" : "#8B5E3C";

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;

      setInput("");
      setHasInteracted(true);
      animated.pause();
      setLoading(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setLoadingStep("Analyzing your question...");
      setExplanation("");
      setResponse(null);
      setError("");
      setLastQuestion(question);

      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history, mode, sessionId: (() => { try { return sessionStorage.getItem("cda-session") || ""; } catch { return ""; } })(), pageToken: getPageToken() }),
        });

        if (res.status === 429) {
          const data = await res.json();
          setError(data.error);
          if (timerRef.current) clearInterval(timerRef.current); setLoading(false);
          return;
        }

        if (res.status === 202) {
          const data = await res.json();
          if (data.captchaRequired) {
            setExplanation("");
            setResponse(null);
            setError("");
            setLastQuestion("");
            if (timerRef.current) clearInterval(timerRef.current);
            setLoading(false);
            requestCaptcha(() => submitQuestion(question));
            return;
          }
        }

        let finalExplanation = "";
        let finalSql = "";
        let finalResponse: QueryResponse | null = null;

        await readSSEStream(res, (event) => {
          switch (event.type) {
            case "status":
              setLoadingStep(event.text);
              break;

            case "explanation":
              // Post-query explanation replaces the pre-query one after result is shown
              finalExplanation = event.text;
              setExplanation(event.text);
              if (response) {
                setResponse(prev => prev ? { ...prev, explanation: event.text } : prev);
              }
              break;

            case "result":
              finalExplanation = event.explanation;
              finalSql = event.sql || "";
              setExplanation(event.explanation);
              finalResponse = event.rows.length > 0 || event.chartConfig
                ? {
                    success: true as const,
                    question,
                    sql: event.sql,
                    explanation: event.explanation,
                    title: event.title,
                    columns: event.columns,
                    rows: event.rows,
                    rowCount: event.rowCount,
                    truncated: event.truncated,
                    chartConfig: event.chartConfig,
                    chartMeta: event.chartMeta,
                    executionTimeMs: event.executionTimeMs,
                  }
                : null;
              setResponse(finalResponse);
              if (timerRef.current) clearInterval(timerRef.current); setLoading(false);
              break;

            case "error":
              setError(event.text);
              finalSql = event.sql || "";
              if (timerRef.current) clearInterval(timerRef.current); setLoading(false);
              break;
          }
        });

        // Add to conversation history for Claude context (keep last 5 exchanges)
        setHistory((prev) => {
          const updated = [
            ...prev,
            { role: "user" as const, content: question },
            {
              role: "assistant" as const,
              content: finalSql
                ? `${finalExplanation}\n[SQL: ${finalSql}]`
                : finalExplanation,
              sql: finalSql || undefined,
            },
          ];
          return updated.slice(-6); // 3 exchanges = 6 messages
        });

        // Push to exchange stack for the side rail
        setExchanges((prev) => [...prev, { question, explanation: finalExplanation, response: finalResponse }]);
        setActiveExchangeIdx(-1);
        setExpandedRailIdx(-1);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setError(`Connection error: ${msg}. Please try again.`);
        setExchanges((prev) => [...prev, { question, explanation: `Error: ${msg}`, response: null }]);
      } finally {
        setLoading(false);
      }
    },
    [loading, history, mode]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitQuestion(input.trim());
    },
    [input, submitQuestion]
  );

  const hasData = response && (response.chartConfig || response.rows.length > 0);

  const hasActiveQuery = !!(explanation || loading || error || response);

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
            placeholder={!hasInteracted ? animated.placeholder : (mode === "historical" ? HISTORICAL_DEFAULT : CURRENT_DEFAULT)}
            className="flex-1 min-w-0 px-3 sm:px-4 py-2 sm:py-2.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[#475EC7] bg-[var(--surface)]"
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
        {/* Suggestion pills or past query history */}
        <div className="flex flex-nowrap sm:flex-wrap gap-1.5 sm:gap-3 mt-2 sm:mt-3 items-center overflow-x-auto scrollbar-hide">
          {pastQueries.length > 0 && (
            <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1 shrink-0">History:</span>
          )}
          {pastQueries.length > 0 && (
            <button
              onClick={() => { setHistory([]); setExplanation(""); setResponse(null); setError(""); try { localStorage.removeItem(`cda-history-${mode}`); } catch {} }}
              className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors ml-auto shrink-0"
            >
              Clear
            </button>
          )}
          {pastQueries.length > 0
            ? (<>
                {(showAllHistory ? pastQueries : pastQueries.slice(-5)).map((q, i) => (
                  <button
                    key={i}
                    onClick={() => submitQuestion(q)}
                    disabled={loading}
                    className="group relative text-[11px] pl-2.5 sm:pl-3 pr-6 sm:pr-7 py-1 sm:py-1.5 rounded-lg bg-white border border-[var(--border)] text-[var(--muted)] hover:shadow-md hover:border-transparent hover:text-[var(--foreground)] cursor-pointer transition-all duration-200 disabled:opacity-40 truncate max-w-[200px] sm:max-w-[240px] shrink-0"
                    title={q}
                  >
                    {q}
                    <svg className="absolute right-1.5 sm:right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 transition-opacity" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 14L14 2M14 2H5M14 2v9"/></svg>
                  </button>
                ))}
                {pastQueries.length > 5 && !showAllHistory && (
                  <button
                    onClick={() => setShowAllHistory(true)}
                    className="text-[10px] px-2 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white cursor-pointer transition-all duration-200 shrink-0"
                  >
                    +{pastQueries.length - 5} more
                  </button>
                )}
                {showAllHistory && pastQueries.length > 5 && (
                  <button
                    onClick={() => setShowAllHistory(false)}
                    className="text-[10px] px-2 py-1 rounded-md text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer transition-colors shrink-0"
                  >
                    Show less
                  </button>
                )}
              </>)
            : !explanation && !loading && !error && (
                <>
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1 shrink-0">Sample Questions:</span>
                  {(mode === "historical" ? [
                    "National murder trend, 2000\u20132020",
                    "National robbery clearance rate since 1960",
                    "Chicago officers per year",
                  ] : [
                    "National murder trend",
                    `Robbery in Houston 2020–${new Date().getFullYear() - 1}`,
                    `Top 10 auto theft rates in ${new Date().getFullYear() - 1}`,
                  ]).map((q) => (
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
              )}
        </div>
      </div>
    </div>
  );

  return (
    <div className={`flex-1 flex flex-col min-h-0 ${visible ? "tab-fade-in" : ""}`} style={{ display: visible ? "flex" : "none" }}>
      {captchaNeeded && <TurnstileModal onVerified={onVerified} onClose={onClose} />}
      {/* Search bar at top only before first query */}
      {!hasActiveQuery && searchBar}

      {/* Current Trends description line */}
      {showCurrentHero && (
        <div className="bg-white border-b border-[var(--border)] shrink-0">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 text-center relative">
            <span className="text-[13px] sm:text-sm text-gray-400">
              <span className="font-semibold text-[#475EC7]">Current Trends</span> shows monthly crime data with minimal lag from hundreds of agencies nationwide. Here you can view cities, states, and national trends month by month from 2017 to the present. Current data is preliminary and may not precisely match the formal annual data reported by the FBI shown in the <span className="font-semibold text-[#8B5E3C]">Historical Library</span>.
              {" "}
              <button
                onClick={() => setShowDatasetInfo(!showDatasetInfo)}
                className="text-[var(--accent)] hover:underline cursor-pointer font-medium"
              >
                What&apos;s the difference?
              </button>
            </span>
            {showDatasetInfo && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-[90vw] max-w-lg bg-white border border-[var(--border)] rounded-lg shadow-lg p-4 text-left text-sm text-[var(--foreground)]">
                <div className="flex justify-between items-start mb-3">
                  <span className="font-semibold text-base">What&apos;s The Difference?</span>
                  <button onClick={() => setShowDatasetInfo(false)} className="text-[var(--muted)] hover:text-[var(--foreground)] text-lg leading-none cursor-pointer">&times;</button>
                </div>
                <div className="space-y-3">
                  <p className="text-gray-500">The <span className="font-semibold text-[#475EC7]">Current Trends</span> and <span className="font-semibold text-[#8B5E3C]">Historical Library</span> are explored separately because they aren&apos;t exactly apples-to-apples.</p>
                  <p className="text-gray-500">The <span className="font-semibold text-[#475EC7]">Current Trends</span> dataset is updated monthly to show national trends as they develop from a sample of hundreds of agencies. <span className="font-semibold text-[#475EC7]">Current Trends</span> has data from 2017 to present though recent data is preliminary, subject to change, and may not precisely match official FBI data.</p>
                  <p className="text-gray-500">The <span className="font-semibold text-[#8B5E3C]">Historical Library</span>, by contrast, contains officially reported annual data from 10,000+ agencies &mdash; since 1930 for some agencies &mdash; plus data on national and statewide trends since 1960. This dataset is derived from official FBI data. The Historical Library is authoritative but may not convey today&apos;s trends.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Historical description line — always visible when no query active */}
      {mode === "historical" && !explanation && !loading && !error && !response && (
        <div className="bg-white border-b border-[var(--border)] shrink-0">
          <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 text-center relative">
            <span className="text-[13px] sm:text-sm text-gray-400">
              The <span className="font-semibold text-[#8B5E3C]">Historical Library</span> shows annual crime, clearance, and staffing data that has been officially published by the FBI. Includes agency-level crime counts, staffing levels, and clearance rates from 1930 until {historicalMaxYear || new Date().getFullYear() - 1} as well as state and national trends since 1958. See <span className="font-semibold text-[#475EC7]">Current Trends</span> for a look at today&apos;s crime trends.
              {" "}
              <button
                onClick={() => setShowDatasetInfo(!showDatasetInfo)}
                className="text-[var(--accent)] hover:underline cursor-pointer font-medium"
              >
                What&apos;s the difference?
              </button>
            </span>
            {showDatasetInfo && (
              <div className="absolute left-1/2 -translate-x-1/2 top-full mt-2 z-50 w-[90vw] max-w-lg bg-white border border-[var(--border)] rounded-lg shadow-lg p-4 text-left text-sm text-[var(--foreground)]">
                <div className="flex justify-between items-start mb-3">
                  <span className="font-semibold text-base">What&apos;s The Difference?</span>
                  <button onClick={() => setShowDatasetInfo(false)} className="text-[var(--muted)] hover:text-[var(--foreground)] text-lg leading-none cursor-pointer">&times;</button>
                </div>
                <div className="space-y-3">
                  <p className="text-gray-500">The <span className="font-semibold text-[#475EC7]">Current Trends</span> and <span className="font-semibold text-[#8B5E3C]">Historical Library</span> are explored separately because they aren&apos;t exactly apples-to-apples.</p>
                  <p className="text-gray-500">The <span className="font-semibold text-[#475EC7]">Current Trends</span> dataset is updated monthly to show national trends as they develop from a sample of hundreds of agencies. <span className="font-semibold text-[#475EC7]">Current Trends</span> has data from 2017 to present though recent data is preliminary, subject to change, and may not precisely match official FBI data.</p>
                  <p className="text-gray-500">The <span className="font-semibold text-[#8B5E3C]">Historical Library</span>, by contrast, contains officially reported annual data from 10,000+ agencies &mdash; since 1930 for some agencies &mdash; plus data on national and statewide trends since 1960. This dataset is derived from official FBI data. The Historical Library is authoritative but may not convey today&apos;s trends.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Side panel layout: left rail + right stage */}
      <div className="flex-1 min-h-0 flex">
        {/* LEFT RAIL */}
        {hasActiveQuery && (
          <div className="w-[260px] lg:w-[320px] xl:w-[340px] border-r border-[var(--border)] hidden min-[700px]:flex flex-col bg-white shrink-0">
            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* New question bar */}
              {!loading && (
                <form onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem("railask") as HTMLTextAreaElement; const val = el?.value?.trim(); if (val) { setHistory([]); setExchanges([]); setActiveExchangeIdx(-1); submitQuestion(val); el.value = ""; } }} className="flex flex-col gap-1.5">
                  <textarea name="railask" rows={2} placeholder="Ask a new question..." onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} className="w-full min-w-0 px-3 py-2 text-[12px] border border-[var(--border)] rounded-md focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)] resize-none" />
                  <button type="submit" className="self-end px-3 py-1.5 text-[11px] font-semibold text-white rounded-md hover:opacity-90 cursor-pointer" style={{ backgroundColor: accentColor }}>Ask</button>
                </form>
              )}
              {/* Exchange stack */}
              {exchanges.map((ex, i) => {
                const isActive = activeExchangeIdx === -1 ? i === exchanges.length - 1 : i === activeExchangeIdx;
                const isExpanded = expandedRailIdx === i;
                return (
                  <div key={i} className={`rounded-md transition-all ${isActive ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)] border-l-[3px] pl-[9px] pr-3 py-2.5" : `${i === exchanges.length - 1 ? "opacity-60" : "opacity-45"} hover:opacity-80 pl-3 pr-3 py-2`}`} style={isActive ? { borderLeftColor: accentColor } : undefined}>
                    <button onClick={() => { setActiveExchangeIdx(i); if (ex.response) { setResponse(ex.response); setExplanation(ex.explanation); } }} className="w-full text-left cursor-pointer">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: accentColor }}>{mode === "current" ? "Current" : "Historical"}</span>
                        <span className={`text-[12px] leading-snug ${isActive ? "font-bold text-[var(--navy)]" : "font-semibold text-[var(--foreground-strong)]"}`}>{ex.question}</span>
                      </div>
                    </button>
                    <div className={`text-[11.5px] text-[var(--muted)] leading-relaxed whitespace-pre-line ${isExpanded ? "" : "line-clamp-4"}`}>{ex.explanation}</div>
                    {ex.explanation.length > 80 && (
                      <button onClick={() => setExpandedRailIdx(isExpanded ? -1 : i)} className="text-[10px] mt-1 cursor-pointer" style={{ color: accentColor }}>{isExpanded ? "Show less" : "Show more"}</button>
                    )}
                    {isActive && !loading && (
                      <form onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem(`followup-${i}`) as HTMLInputElement; const val = el?.value?.trim(); if (val) { submitQuestion(val); el.value = ""; } }} className="flex gap-1 mt-2">
                        <input name={`followup-${i}`} type="text" placeholder="Follow up..." className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]" />
                        <button type="submit" className="px-2 py-1.5 text-[10px] font-semibold text-white rounded hover:opacity-90 cursor-pointer shrink-0" style={{ backgroundColor: accentColor }}>Ask</button>
                      </form>
                    )}
                  </div>
                );
              })}
              {loading && (
                <div className="pl-3 pr-3 py-2.5">
                  <div className="text-[12px] font-bold text-[var(--navy)] mb-1">{lastQuestion}</div>
                  <div className="flex items-center gap-1.5 text-[11px] text-[var(--muted)]">
                    <span className="inline-flex gap-0.5">
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.3s" }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.6s" }} />
                    </span>
                    {loadingStep}
                  </div>
                </div>
              )}
              {exchanges.length > 0 && (
                <div className="text-center pt-2">
                  <button onClick={() => { setHistory([]); setExplanation(""); setResponse(null); setError(""); setExchanges([]); setActiveExchangeIdx(-1); try { localStorage.removeItem(`cda-history-${mode}`); } catch {} }} className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer">Clear history</button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* RIGHT STAGE */}
        <div className={`flex-1 flex flex-col min-h-0 overflow-x-hidden bg-[var(--surface)] ${hasData ? "" : "overflow-y-auto"}`}>
          {/* Error */}
          {error && !loading && (
            <div className="shrink-0">
              <ErrorCard message={error} accentColor={accentColor} onRetry={lastQuestion ? () => submitQuestion(lastQuestion) : undefined} />
            </div>
          )}
          {/* Hero charts */}
          {showCurrentHero && (
            <div className="flex-1 overflow-y-auto flex items-center justify-center p-3 sm:p-6">
              <div className="max-w-4xl w-full">
                <HeroChart data={heroData} agencyCount={heroAgencyCount || 0} population={heroPopulation ?? null} />
                <p className="text-xs text-center text-gray-400 mt-4">I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.</p>
              </div>
            </div>
          )}
          {showHistoricalHero && (
            <div className="flex-1 overflow-y-auto flex items-center justify-center p-3 sm:p-6">
              <div className="max-w-4xl w-full">
                <HistoricalHeroChart data={historicalHeroData!} />
                <p className="text-xs text-center text-gray-400 mt-4">I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.</p>
              </div>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && !hasData && !showCurrentHero && !showHistoricalHero && (
            <QuerySkeleton accentColor={accentColor} step={loadingStep} elapsed={elapsed} />
          )}

          {/* Results */}
          {hasData && (
            <div className="flex-1 flex flex-col p-3 sm:p-5 lg:p-6 min-h-0">
              {/* Source badge + description */}
              <div className="mb-2 shrink-0 flex items-center gap-2">
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-white uppercase tracking-wider" style={{ backgroundColor: accentColor }}>{mode === "current" ? "Current Trends" : "Historical Library"}</span>
                <span className="text-[11px] text-[var(--muted)]">{mode === "current" ? "Monthly crime data from hundreds of agencies" : "Crime, clearance and staffing data back to 1930"}</span>
              </div>

              {/* Toolbar */}
              <div className="flex items-center justify-between mb-2 sm:mb-3 shrink-0 flex-wrap gap-1">
                <div className="flex border border-[var(--border)] rounded-md overflow-hidden">
                  {response.chartConfig && (
                    <button onClick={() => setShowChart(v => !v)} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${showChart ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"}`}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="2 12 5 6 8 9 11 3 14 7"/></svg>
                      <span className="hidden sm:inline">Chart</span>
                    </button>
                  )}
                  {response.chartConfig && response.rows.length > 0 && <div className="w-px bg-[var(--border)]" />}
                  {response.rows.length > 0 && (
                    <button onClick={() => setShowTable(v => !v)} className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${showTable ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"}`}>
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="2" x2="6" y2="14"/></svg>
                      <span className="hidden sm:inline">Table</span>
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  {response.chartConfig && showChart && (
                    <ExportButtons chartRef={chartRef} csvFilename={`${response.title || "chart"}.jpeg`} embedData={response.sql ? { tab: mode, title: response.title, sql: response.sql, chartConfig: response.chartConfig, chartMeta: response.chartMeta } : undefined} />
                  )}
                  {response.rows.length > 0 && <ExportButtons csvData={response.rows} csvColumns={response.columns} csvFilename={`${response.title || "crime-data-export"}.csv`} />}
                </div>
              </div>

              {/* Chart + Table side by side */}
              <div className={`flex-1 flex flex-col ${showChart && response.chartConfig && showTable && response.rows.length > 0 ? "md:flex-row" : ""} gap-3 sm:gap-6 min-h-0`}>
                {response.chartConfig && showChart && (
                  <div ref={chartRef} className={`bg-white flex flex-col ${showTable && response.rows.length > 0 ? "md:flex-[1.15] md:min-w-0" : "w-full flex-1"}`}>
                    <div className="flex-1 min-h-0" style={{ minHeight: 280 }}>
                      <ChartPanel config={response.chartConfig} rows={response.rows} meta={response.chartMeta} requestId={response.requestId} />
                    </div>
                  </div>
                )}
                {response.rows.length > 0 && showTable && (
                  <div className={`bg-white overflow-hidden flex flex-col ${showChart && response.chartConfig ? "md:flex-[0.85] md:min-w-0" : "w-full flex-1"}`}>
                    <DataTable columns={response.columns} rows={response.rows} truncated={response.truncated} fillHeight />
                  </div>
                )}
              </div>

              <p className="text-[10px] text-center text-[var(--muted-light)] mt-3 shrink-0">
                I am a bot and sometimes may make mistakes. Verify findings with official sources. Your questions are logged to improve accuracy. No personally identifying information is collected.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
