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
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");

  const chartRef = useRef<HTMLDivElement>(null);
  const [showDatasetInfo, setShowDatasetInfo] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);

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

        let finalExplanation = "";
        let finalSql = "";

        await readSSEStream(res, (event) => {
          switch (event.type) {
            case "status":
              setLoadingStep(event.text);
              break;

            case "explanation":
              setExplanation(event.text);
              finalExplanation = event.text;
              break;

            case "result":
              finalExplanation = event.explanation;
              finalSql = event.sql || "";
              setExplanation(event.explanation);
              setResponse(
                event.rows.length > 0 || event.chartConfig
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
                  : null
              );
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
          return updated.slice(-10); // 5 exchanges = 10 messages
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setError(`Connection error: ${msg}. Please try again.`);
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

  return (
    <div className={`flex-1 flex flex-col min-h-0 ${visible ? "tab-fade-in" : ""}`} style={{ display: visible ? "flex" : "none" }}>
      {/* Search bar area */}
      <div className="bg-white border-b border-[var(--border)] shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => { setInput(e.target.value); if (!hasInteracted && e.target.value) { setHasInteracted(true); animated.pause(); } }}
              onFocus={() => setInputFocused(true)}
              onBlur={() => setInputFocused(false)}
              placeholder={!hasInteracted ? animated.placeholder : (mode === "historical" ? HISTORICAL_DEFAULT : CURRENT_DEFAULT)}
              className="flex-1 px-4 py-2.5 text-sm border border-[var(--border)] rounded-full focus:outline-none focus:border-[#475EC7] bg-[var(--surface)]"
              disabled={loading}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="px-6 py-2.5 text-sm font-medium text-white bg-[var(--foreground)] rounded-full hover:bg-[var(--accent-hover)] disabled:opacity-40 cursor-pointer"
            >
              {loading ? "..." : "Ask"}
            </button>
          </form>
          {/* Suggestion pills or past query history */}
          <div className="flex flex-nowrap sm:flex-wrap gap-2 sm:gap-3 mt-3 items-center overflow-x-auto scrollbar-hide">
            {pastQueries.length > 0 && (
              <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">History:</span>
            )}
            {pastQueries.length > 0 && (
              <button
                onClick={() => { setHistory([]); setExplanation(""); setResponse(null); setError(""); try { localStorage.removeItem(`cda-history-${mode}`); } catch {} }}
                className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors ml-auto"
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
                      className="group relative text-[11px] pl-3 pr-7 py-1.5 rounded-lg bg-white border border-[var(--border)] text-[var(--muted)] hover:shadow-md hover:border-transparent hover:text-[var(--foreground)] cursor-pointer transition-all duration-200 disabled:opacity-40 truncate max-w-[240px]"
                      title={q}
                    >
                      {q}
                      <svg className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 transition-opacity" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 14L14 2M14 2H5M14 2v9"/></svg>
                    </button>
                  ))}
                  {pastQueries.length > 5 && !showAllHistory && (
                    <button
                      onClick={() => setShowAllHistory(true)}
                      className="text-[10px] px-2 py-1 rounded-md text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white cursor-pointer transition-all duration-200"
                    >
                      +{pastQueries.length - 5} more
                    </button>
                  )}
                  {showAllHistory && pastQueries.length > 5 && (
                    <button
                      onClick={() => setShowAllHistory(false)}
                      className="text-[10px] px-2 py-1 rounded-md text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer transition-colors"
                    >
                      Show less
                    </button>
                  )}
                </>)
              : !explanation && !loading && !error && (
                  <>
                    <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">Sample Questions:</span>
                    {(mode === "historical" ? [
                      "National murder trend, 2000\u20132020",
                      "National robbery clearance rate since 1960",
                      `Chicago officers per year, 1930–${new Date().getFullYear()}`,
                    ] : [
                      "National murder trend",
                      `Robbery in Houston 2020–${new Date().getFullYear() - 1}`,
                      `Top 10 auto theft rates in ${new Date().getFullYear() - 1}`,
                    ]).map((q) => (
                      <button
                        key={q}
                        onClick={() => submitQuestion(q)}
                        className="group relative text-[11px] pl-3 pr-7 py-1.5 rounded-lg bg-white border border-[var(--border)] text-[var(--muted)] hover:shadow-md hover:border-transparent hover:text-[var(--foreground)] cursor-pointer transition-all duration-200"
                      >
                        {q}
                        <svg className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-60 transition-opacity" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M2 14L14 2M14 2H5M14 2v9"/></svg>
                      </button>
                    ))}
                  </>
                )}
          </div>
        </div>
      </div>

      {/* Current Trends description line */}
      {showCurrentHero && (
        <div className="bg-white border-b border-[var(--border)] shrink-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 text-center relative">
            <span className="text-sm text-gray-400">
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
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 text-center relative">
            <span className="text-sm text-gray-400">
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

      {/* Explanation text — only show when we have text or are loading with text */}
      {(explanation || (loading && explanation)) && (
        <div className="border-b border-[var(--border)] bg-white shrink-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
            <div className="max-h-32 overflow-y-auto">
              <div>
                <p className="text-sm text-[var(--foreground)] leading-relaxed" dangerouslySetInnerHTML={{ __html: explanation.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
                {loading && (
                  <div className="text-xs text-[var(--muted)] mt-2 flex items-center gap-1">
                    <span className="inline-flex gap-0.5">
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.3s" }} />
                      <span className="w-1 h-1 rounded-full animate-pulse" style={{ backgroundColor: accentColor, animationDelay: "0.6s" }} />
                    </span>
                    {loadingStep}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !loading && (
        <div className="border-b border-[var(--border)] bg-white shrink-0">
          <ErrorCard
            message={error}
            accentColor={accentColor}
            onRetry={lastQuestion ? () => submitQuestion(lastQuestion) : undefined}
          />
        </div>
      )}

      {/* Main content — chart and table fill remaining space */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden">
        {/* Hero chart when no data */}
        {showCurrentHero && (
          <div className="flex-1 overflow-y-auto flex items-center justify-center p-4 sm:p-6">
            <div className="max-w-4xl w-full">
              <HeroChart
                data={heroData}
                agencyCount={heroAgencyCount || 0}
                population={heroPopulation ?? null}
              />
              <p className="text-xs text-center text-gray-400 mt-4">
                I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
              </p>
            </div>
          </div>
        )}
        {showHistoricalHero && (
          <div className="flex-1 overflow-y-auto flex items-center justify-center p-4 sm:p-6">
            <div className="max-w-4xl w-full">
              <HistoricalHeroChart data={historicalHeroData!} />
              <p className="text-xs text-center text-gray-400 mt-4">
                I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
              </p>
            </div>
          </div>
        )}

        {/* Loading skeleton — show when loading and no result yet */}
        {loading && !hasData && !showCurrentHero && !showHistoricalHero && (
          <QuerySkeleton accentColor={accentColor} step={loadingStep} elapsed={elapsed} />
        )}

        {/* Chart panel */}
        {hasData && response.chartConfig && (
          <div className={`${response.rows.length > 0 ? "lg:w-1/2 lg:border-r" : "w-full"} border-[var(--border)] shrink-0 lg:shrink lg:overflow-hidden bg-white`} style={{ minHeight: response.rows.length >= 8 ? 440 : 320 }}>
            <div ref={chartRef} className="h-full flex flex-col p-4 sm:p-5">
              <div className="flex items-start justify-between gap-3 mb-2 shrink-0">
                <h2
                  className="text-xs font-medium uppercase tracking-wider text-[var(--muted)] flex-1 min-w-0"
                  style={{ letterSpacing: "0.6px" }}
                >
                  {response.title}
                </h2>
                <ExportButtons
                  chartRef={chartRef}
                  csvFilename={`${response.title || "chart"}.jpeg`}
                />
              </div>
              <div className="flex-1 min-h-0" style={{ minHeight: response.rows.length >= 8 ? 420 : 300 }}>
                <ChartPanel
                  config={response.chartConfig}
                  rows={response.rows}
                  meta={response.chartMeta}
                />
              </div>
            </div>
          </div>
        )}

        {/* Table panel */}
        {hasData && response.rows.length > 0 && (
          <div className={`${response.chartConfig ? "lg:w-1/2" : "w-full"} shrink-0 lg:shrink lg:overflow-auto bg-white p-4 sm:p-5`}>
            <div className="flex items-center justify-between mb-3">
              <h2
                className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                style={{ letterSpacing: "0.6px" }}
              >
                Data{" "}
                <span className="normal-case tracking-normal">
                  ({response.rowCount.toLocaleString()} rows
                  {response.executionTimeMs > 0 &&
                    ` · ${(response.executionTimeMs / 1000) < 0.1 ? '<0.1' : (response.executionTimeMs / 1000).toFixed(1)}s`}
                  )
                </span>
              </h2>
              <ExportButtons
                csvData={response.rows}
                csvColumns={response.columns}
                csvFilename={`${response.title || "crime-data-export"}.csv`}
              />
            </div>
            <DataTable
              columns={response.columns}
              rows={response.rows}
              truncated={response.truncated}
            />
          </div>
        )}
      </div>
      {response && (
        <p className="text-xs text-center text-gray-400 py-1 border-t border-[var(--border)] bg-white shrink-0">
          I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
        </p>
      )}
    </div>
  );
}
