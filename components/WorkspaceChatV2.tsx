"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { QueryResponse, StreamEvent } from "@/lib/types";
import { autoRoute, isFollowUp, manualSourceNudge, parseIntent, recommendTabs, TAB_DISPLAY_NAMES, TAB_COLORS, type SourceYearRanges, type TabRecommendation } from "@/lib/tab-suggest";
import { pickerOptions, type SourceId as RegistrySourceId, type PickerSourceId } from "@/lib/sources";
import { applyChartOnlyCustomization } from "@/lib/chart-customization";
import { hasBlockingQueryGuidanceWarnings } from "@/lib/query-guidance";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import QuerySkeleton from "./QuerySkeleton";
import ErrorCard from "./ErrorCard";
import Tracker, { getPageToken } from "./Tracker";
import HomeIcon from "./HomeIcon";
import GettingStarted from "./GettingStarted";
import ExplainerContent from "./ExplainerContent";
import QueryGuidance from "./QueryGuidance";

/** Render inline markdown: **bold** and [text](url) links */
function renderInlineMarkdown(text: string) {
  const parts: (string | React.ReactElement)[] = [];
  let key = 0;
  const pattern = /(\*\*(.+?)\*\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1]) parts.push(<strong key={key++}>{match[2]}</strong>);
    else if (match[3]) parts.push(<a key={key++} href={match[5]} className="underline" style={{ color: "inherit", fontWeight: 600 }}>{match[4]}</a>);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : text;
}

/** Typewriter animation for explanations */
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <>{renderInlineMarkdown(displayed)}</>;
}

interface HistoryEntry { role: "user" | "assistant"; content: string; sql?: string; source?: RegistrySourceId; }

interface Exchange {
  question: string;
  summary: string;
  response: QueryResponse | null;
  explanation: string;
  error?: string;
  source: RegistrySourceId;
  routingReason?: string;
}

type SourceId = PickerSourceId;
type RoutingConfidence = "high" | "medium" | "low";
type RoutingMode = "auto" | "picker" | "manual" | "follow_up" | "rerun";

const SOURCE_OPTIONS = pickerOptions();
const RERUN_SOURCE_OPTIONS = SOURCE_OPTIONS.filter((opt): opt is { id: RegistrySourceId; label: string; color: string } => opt.id !== "auto");


async function readSSEStream(response: Response, onEvent: (event: StreamEvent) => void) {
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
      if (line.startsWith("data: ")) { try { onEvent(JSON.parse(line.slice(6))); } catch {} }
    }
  }
  if (buffer.trim().startsWith("data: ")) { try { onEvent(JSON.parse(buffer.trim().slice(6))); } catch {} }
}

interface WorkspaceChatProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
  historicalHeroData?: { year: number; murder_rate: number }[];
  shrHeroData?: { year: number; pct_firearm: number }[];
  sourceYearRanges?: SourceYearRanges;
}

export default function WorkspaceChat({ sourceYearRanges }: WorkspaceChatProps) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loadingStep, setLoadingStep] = useState("");
  const [source, setSource] = useState<SourceId>("auto");

  // Disambiguation
  const [showDisambiguation, setShowDisambiguation] = useState(false);
  const [disambiguationRecs, setDisambiguationRecs] = useState<TabRecommendation[]>([]);
  const [disambiguationConfidence, setDisambiguationConfidence] = useState<RoutingConfidence | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState("");

  // Active source for current query
  const [activeSource, setActiveSource] = useState<"current" | "historical" | "nibrs" | "shr" | "hate_crime" | null>(null);

  // Conversation
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [activeExchangeIdx, setActiveExchangeIdx] = useState(-1);
  const [expandedRailIdx, setExpandedRailIdx] = useState(-1);
  const [animateIdx, setAnimateIdx] = useState(-1);
  const [showTutorial, setShowTutorial] = useState(false);

  // Result state
  const [explanation, setExplanation] = useState("");
  const [response, setResponse] = useState<QueryResponse | null>(null);
  const [error, setError] = useState("");
  const [lastQuestion, setLastQuestion] = useState("");
  const [showChart, setShowChart] = useState(true);
  const [showTable, setShowTable] = useState(true);
  const chartRef = useRef<HTMLDivElement>(null);
  const railRef = useRef<HTMLDivElement>(null);

  // Scroll rail on new exchange
  useEffect(() => {
    if (railRef.current) railRef.current.scrollTop = railRef.current.scrollHeight;
  }, [exchanges.length, loading]);

  const accentColor = activeSource ? TAB_COLORS[activeSource] : "#475EC7";
  const setGuidedInput = useCallback((value: string) => {
    setInput(value);
    setShowDisambiguation(false);
  }, []);
  const inputBlockedByGuidance = hasBlockingQueryGuidanceWarnings(input);
  const inputSubmitDisabled = !input.trim() || loading || inputBlockedByGuidance;
  const askButtonClass = inputBlockedByGuidance
    ? "border border-[#475EC7]/30 bg-white text-[#475EC7] cursor-not-allowed"
    : !input.trim() || loading
      ? "text-white opacity-40 cursor-not-allowed"
      : "text-white cursor-pointer hover:opacity-90";

  const submitQuestion = useCallback(
    async (
      question: string,
      tab: "current" | "historical" | "nibrs" | "shr" | "hate_crime",
      reason?: string,
      routingConfidence: RoutingConfidence | null = null,
      routingMode: RoutingMode = "manual"
    ) => {
      if (!question || loading) return;
      setActiveSource(tab);
      setInput("");
      setLoading(true);
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(s => s + 1), 1000);
      setLoadingStep("Analyzing your question...");
      setExplanation("");
      setResponse(null);
      setError("");
      setLastQuestion(question);
      setShowDisambiguation(false);

      const route = tab === "nibrs" ? "/api/nibrs-query" : tab === "shr" ? "/api/shr-query" : tab === "hate_crime" ? "/api/hc-query" : "/api/query";
      const mode = tab === "historical" ? "historical" : "current";

      try {
        // Session id from the Tracker component — required for per-session
        // analytics and captcha/daily-cap accounting; without it every query
        // logs session_id NULL (query-audit-2026-07-03 F28)
        const sessionId = (() => {
          try { return sessionStorage.getItem("cda-session") || null; } catch { return null; }
        })();
        const body: Record<string, unknown> = { question, history, pageToken: getPageToken(), routingMode, sessionId };
        if (reason) body.routingReason = reason;
        if (routingConfidence) body.routingConfidence = routingConfidence;
        if (tab === "current" || tab === "historical") { body.mode = mode; }

        const res = await fetch(route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

        if (res.status === 429) { setError((await res.json()).error); if (timerRef.current) clearInterval(timerRef.current); setLoading(false); return; }
        if (res.status === 202) { setError("Session limit reached. Please refresh."); if (timerRef.current) clearInterval(timerRef.current); setLoading(false); return; }

        let finalExplanation = "", finalSql = "";
        let finalResponse: QueryResponse | null = null;

        if (tab === "nibrs" || tab === "shr" || tab === "hate_crime") {
          const data = await res.json();
          if (data.success) { finalExplanation = data.explanation || ""; finalSql = data.sql || ""; finalResponse = data; setExplanation(finalExplanation); setResponse(data); }
          else { setError(data.error || "Query failed"); }
          if (timerRef.current) clearInterval(timerRef.current);
          setLoading(false);
        } else {
          await readSSEStream(res, (event) => {
            switch (event.type) {
              case "status": setLoadingStep(event.text); break;
              case "explanation": finalExplanation = event.text; setExplanation(event.text); break;
              case "result":
                finalExplanation = event.explanation; finalSql = event.sql || "";
                setExplanation(event.explanation);
                const qr: QueryResponse | null = event.rows.length > 0 || event.chartConfig
                  ? { success: true as const, question, sql: event.sql, explanation: event.explanation, title: event.title, columns: event.columns, rows: event.rows, rowCount: event.rowCount, truncated: event.truncated, chartConfig: event.chartConfig, chartMeta: event.chartMeta, executionTimeMs: event.executionTimeMs }
                  : null;
                finalResponse = qr; setResponse(qr);
                if (timerRef.current) clearInterval(timerRef.current); setLoading(false);
                break;
              case "error": setError(event.text); finalSql = event.sql || ""; if (timerRef.current) clearInterval(timerRef.current); setLoading(false); break;
            }
          });
        }

        const summary = finalExplanation ? finalExplanation.split(/[.!?]\s/)[0] + "." : error || "No results.";
        const newExchange: Exchange = { question, summary, response: finalResponse, explanation: finalExplanation, error: error || undefined, source: tab, routingReason: reason };
        setExchanges(prev => { const u = [...prev, newExchange]; setActiveExchangeIdx(u.length - 1); setAnimateIdx(u.length - 1); return u; });
        setHistory(prev => [
          ...prev,
          { role: "user" as const, content: question, source: tab },
          { role: "assistant" as const, content: finalSql ? `${finalExplanation}\n[SQL: ${finalSql}]` : finalExplanation, sql: finalSql || undefined, source: tab },
        ].slice(-12));
      } catch (err) {
        setError(`Connection error: ${err instanceof Error ? err.message : "Network error"}`);
      } finally { if (timerRef.current) clearInterval(timerRef.current); setLoading(false); }
    },
    [loading, history, error]
  );

  const handleAsk = useCallback((question: string) => {
    const q = question.trim();
    if (!q) return;
    if (hasBlockingQueryGuidanceWarnings(q)) return;
    setShowDisambiguation(false);

    const chartOnlyResponse = applyChartOnlyCustomization(q, response);
    if (chartOnlyResponse && activeSource) {
      const summary = chartOnlyResponse.explanation.split(/\n|\./)[0] + ".";
      setResponse(chartOnlyResponse);
      setExplanation(chartOnlyResponse.explanation);
      setLastQuestion(q);
      setError("");
      const newExchange: Exchange = {
        question: q,
        summary,
        response: chartOnlyResponse,
        explanation: chartOnlyResponse.explanation,
        source: activeSource,
        routingReason: "Chart-only follow-up",
      };
      setExchanges(prev => {
        const u = [...prev, newExchange];
        setActiveExchangeIdx(u.length - 1);
        setAnimateIdx(u.length - 1);
        return u;
      });
      setHistory(prev => [
        ...prev,
        { role: "user" as const, content: q, source: activeSource },
        { role: "assistant" as const, content: summary, sql: chartOnlyResponse.sql || undefined, source: activeSource },
      ].slice(-12));
      return;
    }

    // Follow-ups inherit the current active source — unless the follow-up
    // introduces hard requirements the current source can't handle.
    // E.g., "now show firearm murders instead" adds weapon detail → needs SHR/NIBRS.
    if (isFollowUp(q) && activeSource) {
      const intent = parseIntent(q);
      const DEMO_ATTRS = new Set(["weapon", "firearm", "victim_race", "victim_sex",
        "offender_demographics", "relationship", "circumstance", "drug_type", "bias",
        "location_type", "clearance_type", "time_of_day", "carjacking", "arrest_demographics"]);
      const hasHardReq = intent.requiredAttributes.some(a => DEMO_ATTRS.has(a));
      const currentLacksDemos = activeSource === "current" || activeSource === "historical";
      if (hasHardReq && currentLacksDemos) {
        // Follow-up adds a requirement the current tab can't handle — reroute
        const r = autoRoute(q, sourceYearRanges);
        if (r) {
          submitQuestion(q, r.source, `Rerouted — ${r.reason}`, r.confidence, "follow_up");
          return;
        }
      }
      submitQuestion(q, activeSource, `Follow-up — inherited ${TAB_DISPLAY_NAMES[activeSource]} context`, null, "follow_up");
      return;
    }

    if (source === "auto") {
      const r = autoRoute(q, sourceYearRanges);
      if (!r || r.confidence !== "high") {
        const recs = r ? [{ tab: r.source, why: r.reason, primary: true, score: 10 }, ...r.alternatives] : recommendTabs(q, sourceYearRanges);
        setPendingQuestion(q); setDisambiguationRecs(recs.length > 0 ? recs : []); setDisambiguationConfidence(r?.confidence ?? null); setShowDisambiguation(true); setAnimateIdx(-1);
        return;
      }
      submitQuestion(q, r.source, r.reason, r.confidence, "auto");
    } else {
      submitQuestion(q, source as "current" | "historical" | "nibrs" | "shr" | "hate_crime", undefined, null, "manual");
    }
  }, [source, activeSource, response, submitQuestion, sourceYearRanges]);

  const selectExchange = (idx: number) => {
    const ex = exchanges[idx];
    if (!ex) return;
    setActiveExchangeIdx(idx); setActiveSource(ex.source); setResponse(ex.response); setExplanation(ex.explanation); setError(ex.error || "");
  };

  const hasData = response && (response.chartConfig || response.rows.length > 0);
  const hasStarted = exchanges.length > 0 || loading || error || showDisambiguation;
  const activeExchange = exchanges[activeExchangeIdx];
  const rerunQuestion = exchanges[activeExchangeIdx]?.question || lastQuestion;
  const rerunSourceOptions = activeSource ? RERUN_SOURCE_OPTIONS.filter(opt => opt.id !== activeSource) : RERUN_SOURCE_OPTIONS;
  const sourceNudge =
    activeExchange &&
    activeExchangeIdx === exchanges.length - 1 &&
    !activeExchange.routingReason
      ? manualSourceNudge(activeExchange.question, activeExchange.source, sourceYearRanges)
      : null;
  const sourceNudgeBanner = sourceNudge && activeExchange ? (
    <div
      className="flex items-center gap-2 mb-2 shrink-0 text-[11px] rounded-md border px-3 py-2 flex-wrap"
      style={{ borderColor: TAB_COLORS[sourceNudge.source] + "40", backgroundColor: TAB_COLORS[sourceNudge.source] + "08" }}
    >
      <span className="text-[var(--foreground)]">
        This question may be better answered in <strong style={{ color: TAB_COLORS[sourceNudge.source] }}>{TAB_DISPLAY_NAMES[sourceNudge.source]}</strong> - {sourceNudge.reason.charAt(0).toLowerCase() + sourceNudge.reason.slice(1)}.
      </span>
      <button
        onClick={() => submitQuestion(activeExchange.question, sourceNudge.source, sourceNudge.reason, sourceNudge.confidence, "rerun")}
        className="px-2.5 py-1 text-[10px] font-semibold text-white rounded cursor-pointer hover:opacity-90 shrink-0"
        style={{ backgroundColor: TAB_COLORS[sourceNudge.source] }}
      >
        Run in {TAB_DISPLAY_NAMES[sourceNudge.source]}
      </button>
    </div>
  ) : null;
  const rerunControl = rerunQuestion && !loading && rerunSourceOptions.length > 0 ? (
    <div className="relative shrink-0">
      <select
        value=""
        onChange={(e) => {
          const tab = e.target.value as RegistrySourceId;
          if (!tab) return;
          submitQuestion(rerunQuestion, tab, `Rerun in ${TAB_DISPLAY_NAMES[tab]}`, null, "rerun");
        }}
        className="appearance-none pl-2.5 pr-7 py-1.5 text-[11px] font-medium rounded-md border border-[var(--border)] bg-white text-[var(--foreground)] cursor-pointer focus:outline-none focus:border-[#475EC7] focus:ring-1 focus:ring-[#475EC7]/20"
      >
        <option value="">Run in another source...</option>
        {rerunSourceOptions.map(opt => (
          <option key={opt.id} value={opt.id}>{opt.label}</option>
        ))}
      </select>
      <svg className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
    </div>
  ) : null;

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      <Tracker activeTab={activeSource} />

      {/* Header with input */}
      <header className="bg-white border-b border-[var(--border)] shrink-0">
        <div className="px-3 sm:px-4 md:px-6 flex items-center gap-3" style={{ height: 56 }}>
          <button
            onClick={() => { setResponse(null); setExplanation(""); setError(""); setActiveSource(null); setShowDisambiguation(false); setExchanges([]); setHistory([]); setActiveExchangeIdx(-1); setShowTutorial(false); }}
            className="shrink-0 cursor-pointer hover:opacity-70 transition-opacity"
          >
            <HomeIcon size={20} />
          </button>

          {/* Input bar — hidden on landing, shown after first query */}
          {hasStarted && (<>
            <form onSubmit={(e) => { e.preventDefault(); handleAsk(input); }} className="flex-1 flex gap-2 min-w-0 max-w-[760px]">
              <div className="relative flex-1 min-w-0">
                <input
                  type="text"
                  value={input}
                  onChange={(e) => setGuidedInput(e.target.value)}
                  placeholder="Ask about crime data..."
                  className="w-full min-w-0 px-3 py-2 text-[13px] border border-[var(--border)] rounded-lg focus:outline-none focus:border-[#475EC7] focus:ring-1 focus:ring-[#475EC7]/20 bg-[var(--surface)]"
                  disabled={loading}
                />
                <QueryGuidance
                  input={input}
                  onChangeInput={setGuidedInput}
                  showExamples={false}
                  compact
                  floating
                />
              </div>
              <button
                type="submit"
                disabled={inputSubmitDisabled}
                className={`px-4 py-2 text-[12px] font-semibold rounded-lg shrink-0 ${askButtonClass}`}
                style={inputBlockedByGuidance ? undefined : { backgroundColor: "#475EC7" }}
              >
                {inputBlockedByGuidance ? "Clarify first" : "Ask"}
              </button>
            </form>
            <button
              type="button"
              onClick={() => setShowTutorial(true)}
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-md border border-[var(--border)] bg-[var(--surface)] text-[var(--foreground)] hover:bg-white cursor-pointer focus:outline-none focus:border-[#475EC7] focus:ring-1 focus:ring-[#475EC7]/20"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 2.5h4.5A2.5 2.5 0 0 1 10 5v10a2.5 2.5 0 0 0-2.5-2.5H3z" />
                <path d="M10 5a2.5 2.5 0 0 1 2.5-2.5H14v10h-1.5A2.5 2.5 0 0 0 10 15z" />
              </svg>
              <span className="hidden sm:inline">Tutorial</span>
            </button>
            <div className="shrink-0 relative">
              <select
                value={source}
                onChange={(e) => { setSource(e.target.value as SourceId); setShowDisambiguation(false); }}
                className="appearance-none pl-2.5 pr-7 py-1.5 text-[11px] font-medium rounded-md border border-[var(--border)] bg-[var(--surface)] cursor-pointer focus:outline-none focus:border-[#475EC7] focus:ring-1 focus:ring-[#475EC7]/20"
                style={{ color: SOURCE_OPTIONS.find(o => o.id === source)?.color || "var(--foreground)" }}
              >
                {SOURCE_OPTIONS.map(opt => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
              <svg className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--muted)" strokeWidth="1.5" strokeLinecap="round"><path d="M2 3.5l3 3 3-3"/></svg>
            </div>
          </>)}
        </div>
      </header>

      {showTutorial && (
        <div
          className="fixed inset-0 z-50 bg-black/35 p-3 sm:p-6"
          onClick={() => setShowTutorial(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Tutorial"
            className="h-full max-w-5xl mx-auto bg-white rounded-xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="h-12 px-4 sm:px-5 border-b border-[var(--border)] flex items-center justify-between shrink-0 bg-white">
              <div className="text-sm font-semibold text-[var(--foreground)]">Tutorial</div>
              <button
                type="button"
                onClick={() => setShowTutorial(false)}
                className="w-8 h-8 inline-flex items-center justify-center rounded-md border border-[var(--border)] text-[var(--muted)] hover:text-[var(--foreground)] hover:bg-[var(--surface)] cursor-pointer"
                aria-label="Close tutorial"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>
            <ExplainerContent visible />
          </div>
        </div>
      )}

      {/* Landing screen — the full production Getting Started page */}
      {!hasStarted && (
        <GettingStarted
          onSelectTab={(tab) => { setSource(tab); }}
          onAsk={(q) => { setInput(q); handleAsk(q); }}
          renderInputBar={() => (
            <div className="relative">
              <form onSubmit={(e) => { e.preventDefault(); handleAsk(input); }} className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1 min-w-0">
                  <input
                    type="text"
                    value={input}
                    onChange={(e) => setGuidedInput(e.target.value)}
                    placeholder="Ask about crime data..."
                    className="w-full min-w-0 px-4 py-2.5 text-[14px] border border-[var(--border)] rounded-xl focus:outline-none focus:border-[#475EC7] focus:ring-2 focus:ring-[#475EC7]/20 bg-white shadow-sm"
                    disabled={loading}
                  />
                  <QueryGuidance input={input} onChangeInput={setGuidedInput} showExamples={false} floating />
                </div>
                <button
                  type="submit"
                  disabled={inputSubmitDisabled}
                  className={`px-5 py-2.5 text-[13px] font-semibold rounded-xl shrink-0 shadow-sm ${askButtonClass}`}
                  style={inputBlockedByGuidance ? undefined : { backgroundColor: "#475EC7" }}
                >
                  {inputBlockedByGuidance ? "Clarify first" : "Ask"}
                </button>
              </form>
            </div>
          )}
        />
      )}

      {/* Disambiguation overlay */}
      {showDisambiguation && (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-4 pt-8 pb-12">
            <div className="bg-white border border-[var(--border)] rounded-2xl px-5 py-4 shadow-sm">
              <p className="text-[14px] text-[var(--foreground)] mb-3">
                {disambiguationRecs.length > 1 ? "This question could be answered by multiple sources:" : disambiguationRecs.length === 1 ? "Recommended source:" : "Pick a data source:"}
              </p>
              <div className={disambiguationRecs.length > 0 ? "space-y-2" : "grid grid-cols-2 gap-2"}>
                {(disambiguationRecs.length > 0 ? disambiguationRecs : (["current","historical","nibrs","shr"] as const).map(t => ({ tab: t, why: "", primary: false, score: 0 }))).map(rec => (
                  <button key={rec.tab} onClick={() => { setShowDisambiguation(false); submitQuestion(pendingQuestion, rec.tab, rec.why || undefined, disambiguationConfidence, disambiguationRecs.length === 1 ? "auto" : "picker"); }}
                    className="w-full text-left rounded-xl border-2 px-4 py-3 cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 group"
                    style={{ borderColor: TAB_COLORS[rec.tab] + (rec.primary ? "80" : "30"), backgroundColor: TAB_COLORS[rec.tab] + (rec.primary ? "0c" : "05") }}>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] font-bold" style={{ color: TAB_COLORS[rec.tab] }}>{TAB_DISPLAY_NAMES[rec.tab]}</span>
                          {rec.primary && <span className="text-[9px] font-semibold uppercase text-white px-1.5 py-0.5 rounded" style={{ backgroundColor: TAB_COLORS[rec.tab] }}>Best match</span>}
                        </div>
                        {rec.why && <p className="text-[12px] text-[var(--muted)]">{rec.why}</p>}
                      </div>
                      <span className="text-[11px] font-semibold shrink-0" style={{ color: TAB_COLORS[rec.tab] }}>{disambiguationRecs.length === 1 ? "Continue" : "Ask"} &rarr;</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Workspace: left rail + right stage — same layout as production */}
      {hasStarted && !showDisambiguation && (
        <div className="flex-1 flex min-h-0">
          {/* LEFT RAIL */}
          <div className="w-[260px] lg:w-[320px] xl:w-[340px] border-r border-[var(--border)] hidden min-[700px]:flex flex-col bg-white shrink-0">
            <div ref={railRef} className="flex-1 overflow-y-auto p-4 space-y-3">
              {exchanges.map((ex, i) => {
                const isActive = i === activeExchangeIdx;
                const isExpanded = expandedRailIdx === i;
                return (
                  <div key={i} className={`w-full text-left rounded-md transition-all ${isActive ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)] border-l-[3px] pl-[9px] pr-3 py-2.5" : `${i === exchanges.length - 1 ? "opacity-60" : "opacity-45"} hover:opacity-80 pl-3 pr-3 py-2.5`}`} style={isActive ? { borderLeftColor: accentColor } : undefined}>
                    <button onClick={() => selectExchange(i)} className="w-full text-left cursor-pointer">
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: TAB_COLORS[ex.source] }}>{TAB_DISPLAY_NAMES[ex.source].split(" ")[0]}</span>
                        <span className={`text-[12px] leading-snug ${isActive ? "font-bold text-[var(--navy)]" : "font-semibold text-[var(--foreground-strong)]"}`}>{ex.question}</span>
                      </div>
                    </button>
                    <div className={`text-[11.5px] text-[var(--muted)] leading-relaxed ${isExpanded ? "" : "line-clamp-6"}`}>
                      <TypewriterText text={ex.explanation} animate={i === animateIdx && isActive} />
                    </div>
                    {ex.explanation && ex.explanation.length > 80 && (
                      <button onClick={(e) => { e.stopPropagation(); setExpandedRailIdx(isExpanded ? -1 : i); }} className="text-[10px] mt-1 cursor-pointer" style={{ color: accentColor }}>{isExpanded ? "Show less" : "Show more"}</button>
                    )}
                    {isActive && !loading && (
                      <form onSubmit={(e) => { e.preventDefault(); const el = e.currentTarget.elements.namedItem("followup") as HTMLInputElement; const val = el?.value?.trim(); if (val && activeSource) { submitQuestion(val, activeSource, `Follow-up — inherited ${TAB_DISPLAY_NAMES[activeSource]} context`, null, "follow_up"); el.value = ""; } }} className="flex gap-1 mt-2">
                        <input name="followup" type="text" placeholder="Follow up..." className="flex-1 min-w-0 px-2 py-1.5 text-[11px] border border-[var(--border)] rounded focus:outline-none focus:border-[var(--accent)] bg-[var(--surface)]" />
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
                  <button onClick={() => { setExchanges([]); setActiveExchangeIdx(-1); setHistory([]); setExplanation(""); setResponse(null); setError(""); }} className="text-[10px] uppercase tracking-wider text-[var(--muted)] hover:text-red-500 cursor-pointer">Clear history</button>
                </div>
              )}
            </div>
          </div>

          {/* RIGHT STAGE */}
          <div className={`flex-1 flex flex-col min-h-0 overflow-x-hidden bg-[var(--surface)] ${hasData ? "" : "overflow-y-auto"}`}>
            {/* Mobile: history pills */}
            <div className="min-[700px]:hidden border-b border-[var(--border)] bg-white">
              {exchanges.length > 0 && (
                <div className="scroll-gradient px-3 py-2" style={{ "--bg-gradient-end": "#fff" } as React.CSSProperties}>
                  <div className="flex flex-nowrap gap-1.5 overflow-x-auto scrollbar-hide pr-6">
                    {exchanges.map((ex, i) => (
                      <button key={i} onClick={() => selectExchange(i)}
                        className={`text-[10px] px-2 py-1 rounded-md shrink-0 truncate max-w-[180px] cursor-pointer ${i === activeExchangeIdx ? "font-semibold text-white" : "bg-[var(--surface)] border border-[var(--border)] text-[var(--muted)]"}`}
                        style={i === activeExchangeIdx ? { backgroundColor: accentColor } : undefined}
                      >{ex.question}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Empty state — only when truly nothing to show */}
            {!loading && !hasData && !error && !explanation && (
              <div className="flex-1 flex items-center justify-center px-4">
                <p className="text-[var(--muted)] text-sm">Ask a question using the input above</p>
              </div>
            )}

            {/* Text-only response (explanation but no chart/table) */}
            {!loading && !hasData && !error && explanation && (
              <div className="p-3 sm:p-5 lg:p-6">
                {activeSource && (
                  <div className="mb-2 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-white uppercase tracking-wider" style={{ backgroundColor: accentColor }}>{TAB_DISPLAY_NAMES[activeSource]}</span>
                    {rerunControl}
                  </div>
                )}
                {sourceNudgeBanner}
                <div className="text-[13px] sm:text-[14px] text-[var(--foreground)] leading-relaxed">
                  {renderInlineMarkdown(explanation)}
                </div>
              </div>
            )}

            {/* Loading */}
            {loading && !hasData && (
              <QuerySkeleton accentColor={accentColor} step={loadingStep} elapsed={elapsed} />
            )}

            {/* Error */}
            {error && !loading && (
              <div className="shrink-0">
                <ErrorCard message={error} accentColor={accentColor} onRetry={lastQuestion && activeSource ? () => submitQuestion(lastQuestion, activeSource, undefined, null, "rerun") : undefined} />
              </div>
            )}

            {/* Results */}
            {hasData && (
              <div className="flex-1 flex flex-col p-3 sm:p-5 lg:p-6 min-h-0">
                {/* Source badge */}
                {activeSource && (
                  <div className="mb-2 shrink-0 flex items-center gap-2 flex-wrap">
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded text-white uppercase tracking-wider" style={{ backgroundColor: accentColor }}>{TAB_DISPLAY_NAMES[activeSource]}</span>
                    {exchanges[activeExchangeIdx]?.routingReason && <span className="text-[11px] text-[var(--muted)]">{exchanges[activeExchangeIdx].routingReason}</span>}
                    {rerunControl}
                  </div>
                )}
                {sourceNudgeBanner}

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
                    {response.chartConfig && showChart && <ExportButtons chartRef={chartRef} csvFilename={`${response.title || "chart"}.jpeg`} />}
                    {response.rows.length > 0 && <ExportButtons csvData={response.rows} csvColumns={response.columns} csvFilename={`${response.title || "data"}.csv`} />}
                  </div>
                </div>

                {/* Chart + Table side by side */}
                <div className={`flex-1 flex flex-col ${showChart && response.chartConfig && showTable && response.rows.length > 0 ? "md:flex-row" : ""} gap-3 sm:gap-6 min-h-0`}>
                  {response.chartConfig && showChart && (
                    <div ref={chartRef} className={`bg-white flex flex-col ${showTable && response.rows.length > 0 ? "md:flex-[1.15] md:min-w-0" : "w-full flex-1"}`}>
                      <div className="flex-1 min-h-0" style={{ minHeight: 280 }}>
                        <ChartPanel config={response.chartConfig} rows={response.rows} meta={response.chartMeta} />
                      </div>
                    </div>
                  )}
                  {response.rows.length > 0 && showTable && (
                    <div className={`bg-white overflow-hidden workspace-table flex flex-col ${showChart && response.chartConfig ? "md:flex-[0.85] md:min-w-0" : "w-full flex-1"}`}>
                      <DataTable columns={response.columns} rows={response.rows} truncated={response.truncated} fillHeight />
                    </div>
                  )}
                </div>

                {/* Disclaimer */}
                <p className="text-[10px] text-center text-[var(--muted-light)] mt-3 shrink-0">
                  I am a bot and sometimes may make mistakes. Verify findings with official sources. Your questions are logged to improve accuracy. No personally identifying information is collected.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
