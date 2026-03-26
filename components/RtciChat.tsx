"use client";

import { useState, useRef, useCallback } from "react";
import type { QueryResponse, StreamEvent } from "@/lib/types";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import HeroChart from "./HeroChart";
import HistoricalHeroChart from "./HistoricalHeroChart";

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
        } catch {
          // Ignore malformed events
        }
      }
    }
  }

  // Process any remaining buffer
  if (buffer.trim().startsWith("data: ")) {
    try {
      const event = JSON.parse(buffer.trim().slice(6)) as StreamEvent;
      onEvent(event);
    } catch {
      // Ignore
    }
  }
}

export default function RtciChat({ mode, heroData, heroAgencyCount, heroPopulation, historicalHeroData, historicalMaxYear, visible }: RtciChatProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");

  // Conversation history (for Claude context only, not displayed as thread)
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  // Current response state
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");

  const chartRef = useRef<HTMLDivElement>(null);
  const [showDatasetInfo, setShowDatasetInfo] = useState(false);

  // Extract past user questions from history
  const pastQueries = history.filter((h) => h.role === "user").map((h) => h.content);

  const showCurrentHero = mode === "current" && !explanation && !loading && !error && !response && heroData && heroData.length > 0;
  const showHistoricalHero = mode === "historical" && !explanation && !loading && !error && !response && historicalHeroData && historicalHeroData.length > 0;

  const accentColor = mode === "current" ? "#475EC7" : "#8B5E3C";

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;

      setInput("");
      setLoading(true);
      setLoadingStep("Analyzing your question...");
      setExplanation("");
      setResponse(null);
      setError("");

      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history, mode }),
        });

        if (res.status === 429) {
          const data = await res.json();
          setError(data.error);
          setLoading(false);
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
              setLoading(false);
              break;

            case "error":
              setError(event.text);
              finalSql = event.sql || "";
              setLoading(false);
              break;
          }
        });

        // Add to conversation history for Claude context
        setHistory((prev) => [
          ...prev,
          { role: "user", content: question },
          {
            role: "assistant",
            content: finalSql
              ? `${finalExplanation}\n[SQL: ${finalSql}]`
              : finalExplanation,
            sql: finalSql || undefined,
          },
        ]);
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
    <div className="flex-1 flex flex-col min-h-0" style={{ display: visible ? "flex" : "none" }}>
      {/* Search bar area */}
      <div className="bg-white border-b border-[var(--border)] shrink-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={mode === "historical" ? `Ask about historical crime trends (1930–${new Date().getFullYear() - 1})...` : "Ask a question about crime data..."}
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
          {/* Suggestion pills or past query history */}
          <div className="flex flex-wrap gap-2 sm:gap-3 mt-3 items-center">
            {pastQueries.length > 0 && (
              <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] mr-1">History:</span>
            )}
            {pastQueries.length > 0 && (
              <button
                onClick={() => { setHistory([]); setExplanation(""); setResponse(null); setError(""); }}
                className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors ml-auto"
              >
                Clear
              </button>
            )}
            {pastQueries.length > 0
              ? pastQueries.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => submitQuestion(q)}
                    disabled={loading}
                    className="text-xs px-3 py-1 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[#475EC7] hover:text-[#475EC7] cursor-pointer transition-colors disabled:opacity-40 truncate max-w-[200px]"
                    title={q}
                  >
                    {q}
                  </button>
                ))
              : !explanation && !loading && !error && (
                  <>
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
                        className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[#475EC7] hover:text-[#475EC7] cursor-pointer transition-colors"
                      >
                        {q}
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

      {/* Explanation text */}
      {(explanation || loading || error) && (
        <div className="border-b border-[var(--border)] bg-white shrink-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
            <div className="max-h-32 overflow-y-auto">
              {loading && !explanation ? (
                <div className="text-sm text-[var(--muted)] flex items-center gap-2">
                  <span className="inline-flex gap-0.5">
                    <span className="animate-bounce" style={{ color: accentColor }}>·</span>
                    <span className="animate-bounce" style={{ color: accentColor, animationDelay: "0.1s" }}>·</span>
                    <span className="animate-bounce" style={{ color: accentColor, animationDelay: "0.2s" }}>·</span>
                  </span>
                  {loadingStep}
                </div>
              ) : error ? (
                <p className="text-sm text-red-600">{error}</p>
              ) : (
                <div>
                  <p className="text-sm text-[var(--foreground)] leading-relaxed" dangerouslySetInnerHTML={{ __html: explanation.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') }} />
                  {loading && (
                    <div className="text-xs text-[var(--muted)] mt-2 flex items-center gap-1">
                      <span className="inline-flex gap-0.5">
                        <span className="animate-bounce" style={{ color: accentColor }}>·</span>
                        <span className="animate-bounce" style={{ color: accentColor, animationDelay: "0.1s" }}>·</span>
                        <span className="animate-bounce" style={{ color: accentColor, animationDelay: "0.2s" }}>·</span>
                      </span>
                      {loadingStep}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Main content — chart and table fill remaining space */}
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
        {/* Hero chart when no data */}
        {showCurrentHero && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="max-w-4xl mx-auto">
              <HeroChart
                data={heroData}
                agencyCount={heroAgencyCount || 0}
                population={heroPopulation ?? null}
              />
            </div>
          </div>
        )}
        {showHistoricalHero && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6">
            <div className="max-w-4xl mx-auto">
              <HistoricalHeroChart data={historicalHeroData!} />
            </div>
          </div>
        )}

        {/* Chart panel */}
        {hasData && response.chartConfig && (
          <div className={`${response.rows.length > 0 ? "lg:w-1/2 lg:border-r" : "w-full"} border-[var(--border)] overflow-hidden bg-white`}>
            <div ref={chartRef} className="h-full flex flex-col p-4 sm:p-5">
              <div className="flex items-center justify-between mb-2 shrink-0">
                <h2
                  className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                  style={{ letterSpacing: "0.6px" }}
                >
                  {response.title}
                </h2>
                <ExportButtons
                  chartRef={chartRef}
                  csvFilename={`${response.title || "chart"}.jpeg`}
                />
              </div>
              <div className="flex-1 min-h-0" style={{ minHeight: 300 }}>
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
          <div className={`${response.chartConfig ? "lg:w-1/2" : "w-full"} overflow-auto bg-white p-4 sm:p-5`}>
            <div className="flex items-center justify-between mb-3">
              <h2
                className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                style={{ letterSpacing: "0.6px" }}
              >
                Data{" "}
                <span className="normal-case tracking-normal">
                  ({response.rowCount.toLocaleString()} rows
                  {response.executionTimeMs > 0 &&
                    ` · ${(response.executionTimeMs / 1000).toFixed(1)}s`}
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
    </div>
  );
}
