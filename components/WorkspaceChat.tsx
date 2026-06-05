"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import type { QueryResponse, StreamEvent } from "@/lib/types";
import { suggestTab, TAB_DISPLAY_NAMES, TAB_COLORS, type TabSuggestion } from "@/lib/tab-suggest";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import QuerySkeleton from "./QuerySkeleton";
import ErrorCard from "./ErrorCard";
import Tracker, { getPageToken } from "./Tracker";
import HeroChart from "./HeroChart";
import HistoricalHeroChart from "./HistoricalHeroChart";
import NibrsHeroChart from "./NibrsHeroChart";
import ShrHeroChart from "./ShrHeroChart";
import ExplainerContent from "./ExplainerContent";
import HomeIcon from "./HomeIcon";
import GettingStarted from "./GettingStarted";


/** Render inline markdown: **bold** and [text](url) links */
function renderInlineMarkdown(text: string) {
  const parts: (string | React.ReactElement)[] = [];
  let remaining = text;
  let key = 0;
  const pattern = /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[1]) {
      parts.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<a key={key++} href={match[5]} className="underline" style={{ color: "inherit", fontWeight: 600 }}>{match[4]}</a>);
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  remaining; // suppress unused warning
  return parts.length > 0 ? parts : text;
}

/** Reveals text character-by-character on first render, then static. */
function TypewriterText({ text, animate }: { text: string; animate: boolean }) {
  const [displayed, setDisplayed] = useState(animate ? "" : text);
  const animating = useRef(animate);

  useEffect(() => {
    if (!animating.current || !text) { setDisplayed(text); return; }
    let i = 0;
    const id = setInterval(() => {
      i = Math.min(i + 2, text.length);
      setDisplayed(text.slice(0, i));
      if (i >= text.length) { clearInterval(id); animating.current = false; }
    }, 12);
    return () => clearInterval(id);
  // Only run once on mount
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <>{renderInlineMarkdown(displayed)}</>;
}

interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  sql?: string;
}

/** Conversation exchange shown in the left rail */
interface Exchange {
  question: string;
  summary: string;
  response: QueryResponse | null;
  explanation: string;
  error?: string;
}

type TabId = "current" | "historical" | "nibrs" | "shr" | "hate_crime" | "explainer";
type ActiveTab = TabId | null;

const TABS: { id: TabId; label: string; shortLabel: string; color: string }[] = [
  { id: "current", label: "Current Trends", shortLabel: "Current", color: "#475EC7" },
  { id: "historical", label: "Historical Library", shortLabel: "Historical", color: "#8B5E3C" },
  { id: "nibrs", label: "NIBRS Explorer", shortLabel: "NIBRS", color: "#2d8659" },
  { id: "shr", label: "Homicide Reports", shortLabel: "SHR", color: "#8B6914" },
  { id: "explainer", label: "Tutorial", shortLabel: "Tutorial", color: "#333" },
];

const SAMPLE_QUESTIONS: Record<string, string[]> = {
  current: [
    "Show me theft in Omaha rolling over 12 months",
    `Give me robbery numbers in Houston 2020\u2013${new Date().getFullYear() - 1}`,
    `Can I see the top 10 auto theft rates in ${new Date().getFullYear() - 1}?`,
  ],
  historical: [
    "Show me the national murder trend from 2000 to 2020",
    "Give me the national robbery clearance rate since 1960",
    "Can I see Chicago officers per year?",
  ],
  nibrs: [
    "Show me vehicle burglaries per month in Boston in 2023",
    "Give me the carjacking trend by month and year",
    `Can I see murders by weapon in Houston in ${new Date().getFullYear() - 1}?`,
  ],
  shr: [
    "Show me which big cities had the highest share of firearm murders in 2024",
    "Give me domestic homicide trends nationally since 2000",
    "Can I see the victim age breakdown in Texas in 2023?",
  ],
};

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

  if (buffer.trim().startsWith("data: ")) {
    try {
      const event = JSON.parse(buffer.trim().slice(6)) as StreamEvent;
      onEvent(event);
    } catch (e) {
      console.warn("[SSE] Failed to parse trailing event:", buffer, e);
    }
  }
}

interface WorkspaceChatProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  shrHeroData?: { year: number; pct_firearm: number }[];
}

export default function WorkspaceChat({ heroData, heroAgencyCount, heroPopulation, historicalHeroData, shrHeroData }: WorkspaceChatProps) {
  const [activeTab, setActiveTab] = useState<ActiveTab>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const committedTabRef = useRef<ActiveTab>(null);
  const [loadingStep, setLoadingStep] = useState("");
  const PLACEHOLDER_DEFAULTS: Record<string, string> = {
    current: "Ask a question about crime data...",
    historical: "Ask about historical crime trends...",
    nibrs: "Ask about NIBRS crime data...",
    shr: "Ask about Supplementary Homicide Report data...",
  };

  // Conversation history for Claude context
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const saved = localStorage.getItem(`cda-ws-history-${activeTab}`);
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });

  // Exchange list shown in left rail — persisted per tab
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [activeExchangeIdx, setActiveExchangeIdx] = useState<number>(-1);
  const [expandedRailIdx, setExpandedRailIdx] = useState<number>(-1);
  const [animateIdx, setAnimateIdx] = useState<number>(-1);
  const [showMobileRail, setShowMobileRail] = useState(false);

  // Exchanges live in memory only — reset on page refresh or tab switch

  // Current in-flight state
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");

  const chartRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Persist history — skip during tab transitions
  useEffect(() => {
    if (committedTabRef.current !== activeTab) return;
    try { localStorage.setItem(`cda-ws-history-${activeTab}`, JSON.stringify(history)); } catch {}
  }, [history, activeTab]);

  // Reset/restore state when switching tabs
  useEffect(() => {
    committedTabRef.current = activeTab;
    setExplanation("");
    setResponse(null);
    setError("");
    setLastQuestion("");
    setLoading(false);
    setAnimateIdx(-1);
    setExpandedRailIdx(-1);
    try {
      const saved = localStorage.getItem(`cda-ws-history-${activeTab}`);
      setHistory(saved ? JSON.parse(saved) : []);
    } catch { setHistory([]); }
    setExchanges([]);
    setActiveExchangeIdx(-1);
  }, [activeTab]);

  // Scroll rail to bottom on new exchange
  useEffect(() => {
    if (railRef.current) {
      railRef.current.scrollTop = railRef.current.scrollHeight;
    }
  }, [exchanges.length, loading]);

  const mode = activeTab === "historical" ? "historical" : "current";
  const accentColor = TABS.find(t => t.id === activeTab)?.color || "#475EC7";

  // Determine API route based on tab
  const apiRoute = activeTab === "nibrs" ? "/api/nibrs-query" : activeTab === "shr" ? "/api/shr-query" : "/api/query";

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;
      if (activeTab === "explainer") return;

      setInput("");
      setLoading(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setLoadingStep("Analyzing your question...");
      setExplanation("");
      setResponse(null);
      setError("");
      setLastQuestion(question);

      try {
        const body: Record<string, unknown> = { question, history, pageToken: getPageToken() };
        if (activeTab === "current" || activeTab === "historical") {
          body.mode = mode;
          body.sessionId = null;
        }

        const res = await fetch(apiRoute, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (res.status === 429) {
          const data = await res.json();
          setError(data.error);
          if (timerRef.current) clearInterval(timerRef.current);
          setLoading(false);
          return;
        }

        if (res.status === 202) {
          setError("Session limit reached. Please refresh the page to continue.");
          if (timerRef.current) clearInterval(timerRef.current);
          setLoading(false);
          return;
        }

        let finalExplanation = "";
        let finalSql = "";
        let finalResponse: QueryResponse | null = null;

        // NIBRS and SHR use JSON, not SSE
        if (activeTab === "nibrs" || activeTab === "shr") {
          const data = await res.json();
          if (data.success) {
            finalExplanation = data.explanation || "";
            finalSql = data.sql || "";
            finalResponse = data;
            setExplanation(finalExplanation);
            setResponse(data);
          } else {
            setError(data.error || "Query failed");
          }
          if (timerRef.current) clearInterval(timerRef.current);
          setLoading(false);
        } else {
          await readSSEStream(res, (event) => {
            switch (event.type) {
              case "status":
                setLoadingStep(event.text);
                break;
              case "explanation":
                finalExplanation = event.text;
                setExplanation(event.text);
                break;
              case "result":
                finalExplanation = event.explanation;
                finalSql = event.sql || "";
                setExplanation(event.explanation);
                const qr: QueryResponse | null =
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
                    : null;
                finalResponse = qr;
                setResponse(qr);
                if (timerRef.current) clearInterval(timerRef.current);
                setLoading(false);
                break;
              case "error":
                setError(event.text);
                finalSql = event.sql || "";
                if (timerRef.current) clearInterval(timerRef.current);
                setLoading(false);
                break;
            }
          });
        }

        // Build exchange for the rail
        const summary = finalExplanation
          ? finalExplanation.split(/[.!?]\s/)[0] + "."
          : error || "No results.";

        const newExchange: Exchange = {
          question,
          summary,
          response: finalResponse,
          explanation: finalExplanation,
          error: error || undefined,
        };

        setExchanges(prev => {
          const updated = [...prev, newExchange];
          const newIdx = updated.length - 1;
          setActiveExchangeIdx(newIdx);
          if (newExchange.explanation) setAnimateIdx(newIdx);
          return updated;
        });

        // Update Claude context history
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
          return updated.slice(-6);
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setError(`Connection error: ${msg}. Please try again.`);
      } finally {
        if (timerRef.current) clearInterval(timerRef.current);
        setLoading(false);
      }
    },
    [loading, history, mode, activeTab, apiRoute, error]
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      submitQuestion(input.trim());
    },
    [input, submitQuestion]
  );

  // Click a past exchange to re-display it
  const selectExchange = (idx: number) => {
    const ex = exchanges[idx];
    if (!ex) return;
    setActiveExchangeIdx(idx);
    setResponse(ex.response);
    setExplanation(ex.explanation);
    setError(ex.error || "");
  };

  const [showChart, setShowChart] = useState(true);
  const [showTable, setShowTable] = useState(true);

  const hasData = response && (response.chartConfig || response.rows.length > 0);
  const showEmpty = !loading && !hasData && !error && activeTab !== "explainer";

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      <Tracker activeTab={activeTab} />
      {/* Header */}
      <header className="bg-white border-b border-[var(--border)] shrink-0">
        {/* Top row: title + tab pills (desktop) */}
        <div className="px-3 sm:px-4 md:px-6 flex items-center justify-between relative" style={{ height: 52 }}>
          <div className="flex items-center shrink-0 gap-2">
            <button
              onClick={() => setActiveTab(null)}
              className="flex items-center shrink-0 cursor-pointer hover:opacity-70 transition-opacity"
            >
              <HomeIcon size={22} />
            </button>
            {/* Mobile history toggle — only shown when there are exchanges */}
            {exchanges.length > 0 && activeTab !== null && (
              <button
                onClick={() => setShowMobileRail(true)}
                className="md:hidden flex items-center cursor-pointer hover:opacity-70 transition-opacity"
                aria-label="Show conversation history"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-[var(--muted)]">
                  <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                </svg>
              </button>
            )}
          </div>
          <button
            onClick={() => setActiveTab(null)}
            className="absolute left-1/2 -translate-x-1/2 font-bold uppercase text-[var(--foreground)] text-[10px] sm:text-[11px] md:text-xs whitespace-nowrap cursor-pointer hover:opacity-70 transition-opacity"
            style={{ letterSpacing: "1.5px" }}
          >
            Crime Data Assistant
          </button>
          <div className="hidden md:flex items-center gap-0.5">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`relative text-[11px] lg:text-xs px-2 lg:px-3 py-2 rounded-md cursor-pointer whitespace-nowrap transition-all duration-200 ${
                  activeTab === tab.id
                    ? "font-semibold"
                    : "font-medium text-[#888] hover:text-[var(--foreground)] hover:bg-[#f4f4f4]"
                }`}
                style={activeTab === tab.id ? { color: tab.color, backgroundColor: tab.color + "0d" } : undefined}
              >
                <span className="hidden lg:inline">{tab.label}</span>
                <span className="lg:hidden">{tab.shortLabel}</span>
                <span
                  className="absolute bottom-0 left-3 right-3 h-[2px] rounded-full transition-all duration-300"
                  style={{
                    backgroundColor: tab.color,
                    opacity: activeTab === tab.id ? 1 : 0,
                    transform: activeTab === tab.id ? "scaleX(1)" : "scaleX(0)",
                  }}
                />
              </button>
            ))}
          </div>
        </div>
        {/* Mobile tab row */}
        <div className="md:hidden flex border-t border-[var(--border)] bg-white">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex-1 text-[10px] sm:text-[11px] font-medium py-2 transition-all cursor-pointer ${
                activeTab === tab.id ? "font-semibold" : "text-[#999]"
              }`}
              style={activeTab === tab.id ? { color: tab.color } : undefined}
            >
              {tab.shortLabel}
              <span
                className="absolute bottom-0 left-1.5 right-1.5 h-[2px] rounded-full transition-all duration-300"
                style={{
                  backgroundColor: tab.color,
                  opacity: activeTab === tab.id ? 1 : 0,
                  transform: activeTab === tab.id ? "scaleX(1)" : "scaleX(0)",
                }}
              />
            </button>
          ))}
        </div>
      </header>

      {/* Mobile slide-out rail overlay */}
      {showMobileRail && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setShowMobileRail(false)}
          />
          <div className="relative w-[280px] max-w-[80vw] bg-white flex flex-col shadow-xl animate-slide-in-left">
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
              <span className="text-[12px] font-semibold uppercase tracking-wider text-[var(--muted)]" style={{ letterSpacing: "1px" }}>History</span>
              <button
                onClick={() => setShowMobileRail(false)}
                className="text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer p-1"
                aria-label="Close history"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
              {exchanges.map((ex, i) => {
                const isActive = i === activeExchangeIdx;
                return (
                  <button
                    key={i}
                    onClick={() => { selectExchange(i); setShowMobileRail(false); }}
                    className={`w-full text-left rounded-md px-3 py-2.5 transition-all cursor-pointer ${
                      isActive
                        ? "bg-[color-mix(in_srgb,var(--accent)_8%,white)] border-l-[3px]"
                        : "opacity-60 hover:opacity-80"
                    }`}
                    style={isActive ? { borderLeftColor: accentColor } : undefined}
                  >
                    <div className={`text-[12px] leading-snug ${isActive ? "font-bold text-[var(--navy)]" : "font-semibold text-[var(--foreground-strong)]"}`}>
                      {ex.question}
                    </div>
                    <div className="text-[11px] text-[var(--muted)] leading-relaxed line-clamp-2 mt-0.5">
                      {ex.summary}
                    </div>
                  </button>
                );
              })}
            </div>
            {exchanges.length > 0 && (
              <div className="p-3 border-t border-[var(--border)]">
                <button
                  onClick={() => {
                    setExchanges([]);
                    setActiveExchangeIdx(-1);
                    setExpandedRailIdx(-1);
                    setResponse(null);
                    setExplanation("");
                    setError("");
                    try { localStorage.removeItem(`cda-ws-history-${activeTab}`); } catch {}
                    setShowMobileRail(false);
                  }}
                  className="w-full text-[11px] text-[var(--muted)] hover:text-red-600 py-2 cursor-pointer transition-colors"
                >
                  Clear history
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main body: conversation rail + result stage */}
      <div className={`flex-1 flex min-h-0 ${activeTab === null ? "hidden" : ""}`}>
        {/* LEFT RAIL */}
        <div className="w-[260px] lg:w-[320px] xl:w-[340px] border-r border-[var(--border)] flex flex-col bg-white shrink-0 hidden md:flex">
          {/* Input at top of rail */}
          <div className="p-3 border-b border-[var(--border)] bg-white shrink-0">
            <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(e); } }}
                placeholder={PLACEHOLDER_DEFAULTS[activeTab || "current"] || "Ask a question..."}
                rows={2}
                className="w-full px-3 py-2.5 text-[13px] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] bg-[var(--surface)] resize-none"
                disabled={loading || activeTab === "explainer"}
              />
              <button
                type="submit"
                disabled={loading || !input.trim() || activeTab === "explainer"}
                className="self-end px-4 py-2 text-[12px] font-semibold text-white rounded-lg hover:opacity-90 disabled:opacity-40 cursor-pointer"
                style={{ backgroundColor: accentColor }}
              >
                Ask
              </button>
            </form>
          </div>

          {/* Conversation thread */}
          <div ref={railRef} className="flex-1 overflow-y-auto p-4 space-y-3">
            {exchanges.length === 0 && !loading && activeTab !== "explainer" && (
              <div className="pt-6">
                <p className="text-[11px] text-[var(--muted-light)] uppercase tracking-wider mb-3" style={{ letterSpacing: "1px" }}>Try asking</p>
                <div className="space-y-1.5">
                  {(SAMPLE_QUESTIONS[activeTab || "current"] || SAMPLE_QUESTIONS.current).map((q) => (
                    <button
                      key={q}
                      onClick={() => submitQuestion(q)}
                      className="group w-full text-left text-[12px] text-[var(--muted)] hover:text-[var(--foreground)] pl-3 pr-2 py-2 rounded-lg cursor-pointer transition-all hover:bg-[var(--surface)] flex items-start gap-2"
                    >
                      <span className="text-[var(--muted-light)] group-hover:text-[var(--accent)] mt-px transition-colors shrink-0">&rarr;</span>
                      <span>{q}</span>
                    </button>
                  ))}
                </div>

                {/* Data snapshot */}
                <div className="mt-6 pt-5 border-t border-[var(--border)] space-y-3">
                  {activeTab === "current" && heroData && heroData.length > 0 && (() => {
                    const last = heroData[heroData.length - 1];
                    const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
                    return (<>
                      <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Latest month</span><span className="font-bold text-[var(--foreground)]">{monthNames[last.month - 1]} {last.year}</span></div>
                      <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Current agencies</span><span className="font-bold text-[var(--foreground)]">{heroAgencyCount?.toLocaleString()}</span></div>
                      <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Sample population</span><span className="font-bold text-[var(--foreground)]">{heroPopulation ? `${(heroPopulation / 1e6).toFixed(1)}M` : "—"}</span></div>
                      <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Best for</span><span className="font-bold text-[var(--foreground)]">Monthly trends</span></div>
                    </>);
                  })()}
                  {activeTab === "historical" && (<>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Coverage</span><span className="font-bold text-[var(--foreground)]">Since 1930</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Agencies</span><span className="font-bold text-[var(--foreground)]">10,000+</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Includes</span><span className="font-bold text-[var(--foreground)]">Crime, staffing, clearance</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Best for</span><span className="font-bold text-[var(--foreground)]">Annual trends</span></div>
                  </>)}
                  {activeTab === "nibrs" && (<>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Coverage</span><span className="font-bold text-[var(--foreground)]">1991–present</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Records</span><span className="font-bold text-[var(--foreground)]">1B+ incidents</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Includes</span><span className="font-bold text-[var(--foreground)]">Victims, weapons, offenses</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Best for</span><span className="font-bold text-[var(--foreground)]">Incident-level detail</span></div>
                    <div className="text-[10px] text-[var(--muted-light)] mt-1 leading-snug">Recent months likely incomplete as agencies continue to submit.</div>
                  </>)}
                  {activeTab === "shr" && (<>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Coverage</span><span className="font-bold text-[var(--foreground)]">1976–present</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Records</span><span className="font-bold text-[var(--foreground)]">890,000+ victims</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Includes</span><span className="font-bold text-[var(--foreground)]">Weapons, demographics, circumstances</span></div>
                    <div className="flex justify-between text-[12px]"><span className="text-[var(--muted)]">Best for</span><span className="font-bold text-[var(--foreground)]">Homicide analysis</span></div>
                  </>)}
                </div>
              </div>
            )}

            {exchanges.map((ex, i) => {
              const isActive = i === activeExchangeIdx;
              const isExpanded = expandedRailIdx === i;
              return (
                <div
                  key={i}
                  className={`w-full text-left rounded-md transition-all ${
                    isActive
                      ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)] border-l-[3px] pl-[9px] pr-3 py-2.5"
                      : `${i === exchanges.length - 1 ? "opacity-60" : "opacity-45"} hover:opacity-80 pl-3 pr-3 py-2.5`
                  }`}
                  style={isActive ? { borderLeftColor: accentColor } : undefined}
                >
                  <button
                    onClick={() => selectExchange(i)}
                    className="w-full text-left cursor-pointer"
                  >
                    <div
                      className={`text-[12px] mb-1 leading-snug ${
                        isActive ? "font-bold text-[var(--navy)]" : "font-semibold text-[var(--foreground-strong)]"
                      }`}
                    >
                      {ex.question}
                    </div>
                  </button>
                  <div
                    className={`text-[11.5px] text-[var(--muted)] leading-relaxed ${isExpanded ? "" : "line-clamp-4"}`}
                  >
                    <TypewriterText
                      text={ex.explanation}
                      animate={i === animateIdx && isActive}
                    />
                  </div>
                  {ex.explanation && ex.explanation.length > 80 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setExpandedRailIdx(isExpanded ? -1 : i); }}
                      className="text-[10px] mt-1 cursor-pointer transition-colors"
                      style={{ color: accentColor }}
                    >
                      {isExpanded ? "Show less" : "Show more"}
                    </button>
                  )}
                  {isActive && !loading && (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const el = e.currentTarget.elements.namedItem("followup") as HTMLInputElement;
                        const val = el?.value?.trim();
                        if (val) { submitQuestion(val); el.value = ""; }
                      }}
                      className="flex gap-1 mt-2"
                    >
                      <input
                        name="followup"
                        type="text"
                        placeholder="Follow up..."
                        className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]"
                      />
                      <button
                        type="submit"
                        className="px-2 py-1.5 text-[10px] font-semibold text-white rounded hover:opacity-90 cursor-pointer shrink-0"
                        style={{ backgroundColor: accentColor }}
                      >
                        Ask
                      </button>
                    </form>
                  )}
                </div>
              );
            })}

            {/* Loading indicator in rail */}
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

            {/* Clear history at bottom of thread */}
            {exchanges.length > 0 && (
              <div className="text-center pt-2">
                <button
                  onClick={() => {
                    setExchanges([]);
                    setActiveExchangeIdx(-1);
                    setExpandedRailIdx(-1);
                    setHistory([]);
                    setExplanation("");
                    setResponse(null);
                    setError("");
                    try { localStorage.removeItem(`cda-ws-history-${activeTab}`); } catch {}
                  }}
                  className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer transition-colors"
                >
                  Clear history
                </button>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT STAGE */}
        <div className={`flex-1 flex flex-col min-h-0 overflow-x-hidden bg-[var(--surface)] ${hasData ? "" : "overflow-y-auto"}`}>
          {/* Mobile input + history (hidden on md+) */}
          <div className="md:hidden border-b border-[var(--border)] bg-white">
            {activeTab !== "explainer" && (
            <div className="p-3">
              <form onSubmit={handleSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={PLACEHOLDER_DEFAULTS[activeTab || "current"] || "Ask a question..."}
                  className="flex-1 min-w-0 px-3 py-2.5 text-sm border border-[var(--border)] rounded-lg focus:outline-none focus:border-[var(--accent)] focus:ring-1 focus:ring-[var(--accent)] bg-[var(--surface)]"
                  disabled={loading}
                />
                <button
                  type="submit"
                  disabled={loading || !input.trim()}
                  className="px-4 py-2.5 text-sm font-semibold text-white rounded-lg disabled:opacity-40 cursor-pointer shrink-0"
                  style={{ backgroundColor: accentColor }}
                >
                  Ask
                </button>
              </form>
            </div>
            )}
            {/* Mobile: sample questions or history pills */}
            {exchanges.length === 0 && !loading && (
              <div className="scroll-gradient px-3 pb-2" style={{ "--bg-gradient-end": "#fff" } as React.CSSProperties}>
                <div className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-hide pr-6">
                  <span className="text-[10px] uppercase tracking-wider text-[var(--muted)] shrink-0 self-center mr-0.5">Try:</span>
                  {(SAMPLE_QUESTIONS[activeTab || "current"] || SAMPLE_QUESTIONS.current).map((q) => (
                    <button
                      key={q}
                      onClick={() => submitQuestion(q)}
                      className="text-[10px] px-2 py-1 rounded-md bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer transition-colors shrink-0 truncate max-w-[200px]"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {exchanges.length > 0 && (
              <div className="scroll-gradient px-3 pb-2" style={{ "--bg-gradient-end": "#fff" } as React.CSSProperties}>
                <div className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-hide pr-6">
                  {exchanges.map((ex, i) => (
                    <button
                      key={i}
                      onClick={() => selectExchange(i)}
                      className={`text-[10px] px-2 py-1 rounded-md shrink-0 truncate max-w-[180px] cursor-pointer transition-colors ${
                        i === activeExchangeIdx
                          ? "font-semibold text-white"
                          : "bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]"
                      }`}
                      style={i === activeExchangeIdx ? { backgroundColor: accentColor } : undefined}
                    >
                      {ex.question}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Empty state — hero charts */}
          {showEmpty && (
            <div className="flex-1 overflow-y-auto pt-5 sm:pt-12 px-4 sm:px-9">
              <div className="max-w-[850px] mx-auto">
                {activeTab === "current" && (
                  <>
                    <p className="text-[13px] sm:text-sm text-[var(--foreground)] text-center mb-3.5 max-w-[820px] mx-auto leading-relaxed">
                      <span className="font-semibold text-[#475EC7]">Current Trends</span> shows monthly crime data with minimal lag from hundreds of agencies nationwide. Here you can view cities, states, and national trends month by month from 2017 to the present. Current data is preliminary and may not precisely match the formal annual data reported by the FBI shown in the <span className="font-semibold text-[#8B5E3C]">Historical Library</span>.
                    </p>
                    {heroData && heroData.length > 0 && (
                      <div className="bg-white">
                        <HeroChart data={heroData} agencyCount={heroAgencyCount || 0} population={heroPopulation ?? null} />
                      </div>
                    )}
                  </>
                )}
                {activeTab === "historical" && (
                  <>
                    <p className="text-[13px] sm:text-sm text-[var(--foreground)] text-center mb-3.5 max-w-[820px] mx-auto leading-relaxed">
                      The <span className="font-semibold text-[#8B5E3C]">Historical Library</span> shows annual crime, clearance, and staffing data that has been officially published by the FBI. Includes agency-level crime counts, staffing levels, and clearance rates from 1930 until {new Date().getFullYear() - 1} as well as state and national trends since 1958. See <span className="font-semibold text-[#475EC7]">Current Trends</span> for a look at today&apos;s crime trends.
                    </p>
                    {historicalHeroData && historicalHeroData.length > 0 && (
                      <div className="bg-white">
                        <HistoricalHeroChart data={historicalHeroData} />
                      </div>
                    )}
                  </>
                )}
                {activeTab === "nibrs" && (
                  <>
                    <p className="text-[13px] sm:text-sm text-[var(--foreground)] text-center mb-3.5 max-w-[820px] mx-auto leading-relaxed">
                      Review more than <span className="font-semibold text-[var(--navy)]">1 Billion</span> NIBRS records relating to offenses, victims, arrestees, weapons, property, clearances, and more! Data available since 1991. The most recent months of data are likely incomplete as agencies continue to submit records to the FBI.
                    </p>
                    <NibrsHeroChart />
                  </>
                )}
                {activeTab === "shr" && (
                  <>
                    <p className="text-[13px] sm:text-sm text-[var(--foreground)] text-center mb-3.5 max-w-[820px] mx-auto leading-relaxed">
                      Explore <span className="font-semibold text-[var(--navy)]">890,000+</span> homicide victims from the FBI&apos;s Supplementary Homicide Reports, 1976&ndash;present. Includes victim/offender demographics, weapon, circumstance, and relationship data. Coverage varies by state and year.
                    </p>
                    {shrHeroData && shrHeroData.length > 0 && (
                      <div className="bg-white">
                        <ShrHeroChart data={shrHeroData} />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {/* Loading skeleton */}
          {loading && !hasData && (
            <QuerySkeleton accentColor={accentColor} step={loadingStep} elapsed={elapsed} />
          )}

          {/* Error */}
          {error && !loading && (
            <div className="shrink-0">
              <ErrorCard
                message={error}
                accentColor={accentColor}
                onRetry={lastQuestion ? () => submitQuestion(lastQuestion) : undefined}
              />
            </div>
          )}

          {/* Result: title + chart/table side by side — fill available space */}
          {hasData && (
            <div className="flex-1 flex flex-col p-3 sm:p-5 lg:p-6 min-h-0">
              {/* Toolbar: toggles + export */}
              <div className="flex items-center justify-between mb-2 sm:mb-3 shrink-0 flex-wrap gap-1">
                <div className="flex border border-[var(--border)] rounded-md overflow-hidden">
                  {response.chartConfig && (
                    <button
                      onClick={() => setShowChart(v => !v)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${
                        showChart ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"
                      }`}
                      title={showChart ? "Hide chart" : "Show chart"}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="2 12 5 6 8 9 11 3 14 7"/>
                      </svg>
                      <span className="hidden sm:inline">Chart</span>
                    </button>
                  )}
                  {response.chartConfig && response.rows.length > 0 && (
                    <div className="w-px bg-[var(--border)]" />
                  )}
                  {response.rows.length > 0 && (
                    <button
                      onClick={() => setShowTable(v => !v)}
                      className={`flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium cursor-pointer transition-colors ${
                        showTable ? "bg-white text-[var(--foreground)]" : "bg-[var(--surface)] text-[var(--muted-light)]"
                      }`}
                      title={showTable ? "Hide table" : "Show table"}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><line x1="2" y1="10" x2="14" y2="10"/><line x1="6" y1="2" x2="6" y2="14"/>
                      </svg>
                      <span className="hidden sm:inline">Table</span>
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  {response.chartConfig && showChart && (
                    <ExportButtons
                      chartRef={chartRef}
                      csvFilename={`${response.title || "chart"}.jpeg`}
                      embedData={response.sql ? {
                        tab: mode,
                        title: response.title,
                        sql: response.sql,
                        chartConfig: response.chartConfig,
                        chartMeta: response.chartMeta,
                      } : undefined}
                    />
                  )}
                  {response.rows.length > 0 && (
                    <ExportButtons
                      csvData={response.rows}
                      csvColumns={response.columns}
                      csvFilename={`${response.title || "crime-data-export"}.csv`}
                    />
                  )}
                </div>
              </div>

              {/* Chart + Table side by side — fill remaining height */}
              <div className={`flex-1 flex flex-col ${showChart && response.chartConfig && showTable && response.rows.length > 0 ? "md:flex-row" : ""} gap-3 sm:gap-6 min-h-0`}>
                {/* Chart */}
                {response.chartConfig && showChart && (
                  <div
                    ref={chartRef}
                    className={`bg-white flex flex-col ${
                      showTable && response.rows.length > 0 ? "md:flex-[1.15] md:min-w-0" : "w-full flex-1"
                    }`}
                  >
                    <div className="flex-1 min-h-0" style={{ minHeight: 280 }}>
                      <ChartPanel
                        config={response.chartConfig}
                        rows={response.rows}
                        meta={response.chartMeta}
                      />
                    </div>
                  </div>
                )}

                {/* Table */}
                {response.rows.length > 0 && showTable && (
                  <div
                    className={`bg-white overflow-hidden workspace-table flex flex-col ${
                      showChart && response.chartConfig ? "md:flex-[0.85] md:min-w-0" : "w-full flex-1"
                    }`}
                  >
                    {(!response.chartConfig || !showChart) && (
                      <div className="mb-3 shrink-0">
                        <div className="text-[15px] font-bold text-[#333] leading-snug">
                          {response.title}
                        </div>
                      </div>
                    )}
                    <DataTable
                      columns={response.columns}
                      rows={response.rows}
                      truncated={response.truncated}
                      fillHeight
                    />
                  </div>
                )}
              </div>

              {/* Disclaimer */}
              <p className="text-[10px] text-center text-[var(--muted-light)] mt-3 shrink-0">
                I am a bot and sometimes may make mistakes. When in doubt, verify these findings with official sources.
                {(activeTab === "nibrs" || activeTab === "shr") && " The most recent months of data are likely incomplete as agencies continue to submit records."}
              </p>
            </div>
          )}

          {/* Tutorial tab */}
          <ExplainerContent visible={activeTab === "explainer"} />
        </div>
      </div>

      {/* Getting Started — shown when no tab is selected */}
      {activeTab === null && (
        <GettingStarted onSelectTab={(tab) => setActiveTab(tab)} />
      )}
    </div>
  );
}
