"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import type { QueryResponse, ChartConfig, StreamEvent } from "@/lib/types";
import DataTable from "./DataTable";
import ChartPanel from "./ChartPanel";
import ExportButtons from "./ExportButtons";
import HeroChart from "./HeroChart";
import CrimeIndexLogo from "./CrimeIndexLogo";

interface Message {
  id: string;
  role: "user" | "assistant";
  text: string;
  sql?: string;
  response?: QueryResponse | null;
  loading?: boolean;
}

interface ChatInterfaceProps {
  heroData?: { year: number; month: number; rolling_12: number }[];
  heroAgencyCount?: number;
  heroPopulation?: number | null;
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

export default function ChatInterface({ heroData, heroAgencyCount, heroPopulation }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");

  const scrollRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const latestUserRef = useRef<HTMLDivElement>(null);

  // When a new user message appears, scroll it to the top of the scroll container
  useEffect(() => {
    if (latestUserRef.current && scrollRef.current && messages.length > 0) {
      const container = scrollRef.current;
      const target = latestUserRef.current;
      const targetTop = target.offsetTop - container.offsetTop;
      container.scrollTo({ top: targetTop, behavior: "smooth" });
    }
  }, [messages.length]);

  const submitQuestion = useCallback(
    async (question: string) => {
      if (!question || loading) return;

      setInput("");
      setLoading(true);
      setLoadingStep("Analyzing your question...");

      const userMsg: Message = {
        id: Date.now().toString(),
        role: "user",
        text: question,
      };

      const assistantId = (Date.now() + 1).toString();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        text: "",
        loading: true,
      };

      // Build conversation history for Claude context
      const history = messages.map((m) => ({
        role: m.role,
        content:
          m.role === "assistant" && m.sql
            ? `${m.text}\n[SQL: ${m.sql}]`
            : m.text,
      }));

      setMessages((prev) => [...prev, userMsg, assistantMsg]);

      try {
        const res = await fetch("/api/query", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question, history }),
        });

        if (res.status === 429) {
          const data = await res.json();
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId
                ? { ...m, text: data.error, loading: false }
                : m
            )
          );
          setLoading(false);
          return;
        }

        await readSSEStream(res, (event) => {
          switch (event.type) {
            case "status":
              setLoadingStep(event.text);
              break;

            case "explanation":
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, text: event.text, loading: true }
                    : m
                )
              );
              break;

            case "result":
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        text: event.explanation,
                        sql: event.sql || undefined,
                        loading: false,
                        response:
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
                            : null,
                      }
                    : m
                )
              );
              setLoading(false);
              break;

            case "error":
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        text: event.text,
                        sql: event.sql || undefined,
                        loading: false,
                      }
                    : m
                )
              );
              setLoading(false);
              break;
          }
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Network error";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? { ...m, text: `Connection error: ${msg}. Please try again.`, loading: false }
              : m
          )
        );
      } finally {
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

  const showHero = messages.length === 0 && !loading && heroData && heroData.length > 0;

  // Find the latest assistant message with a response (for chart/table display)
  const latestResponseId = (() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].response) {
        return messages[i].id;
      }
    }
    return null;
  })();

  return (
    <div className="h-screen flex flex-col bg-[var(--surface)]">
      {/* Header */}
      <header
        className="bg-white border-b border-[var(--border)] px-4 sm:px-6 flex items-center justify-between shrink-0"
        style={{ height: 56 }}
      >
        <div className="flex items-center gap-3 sm:gap-6 min-w-0">
          <div className="flex items-center gap-2 shrink-0">
            <CrimeIndexLogo size={24} />
            <span
              className="text-xs sm:text-sm font-medium tracking-widest uppercase text-[var(--foreground)]"
              style={{ letterSpacing: "2.5px" }}
            >
              Crime Index
            </span>
          </div>
          <div className="h-5 w-px bg-[var(--border)] hidden sm:block" />
          <span className="text-xs sm:text-sm text-[var(--foreground)] hidden sm:block">
            Crime Data Assistant
          </span>
        </div>
        <span className="text-[10px] sm:text-xs text-[var(--muted)] shrink-0">
          700+ agencies · 48 states · 2017–2025
        </span>
      </header>

      {/* Search bar area */}
      <div className="bg-white border-b border-[var(--border)]">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          <form onSubmit={handleSubmit} className="flex gap-2 sm:gap-3">
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
            <div className="flex flex-wrap gap-2 sm:gap-3 mt-3 justify-center">
              {[
                "National murder trend",
                "Robbery in Houston 2020–2024",
                "Compare Texas cities",
              ].map((q) => (
                <button
                  key={q}
                  onClick={() => submitQuestion(q)}
                  className="text-xs px-3 py-1.5 rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[#475EC7] hover:text-[#475EC7] cursor-pointer transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Main content area */}
      <div className="flex-1 min-h-0 overflow-y-auto" ref={scrollRef}>
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 sm:py-6 space-y-4">
          {/* Hero chart when no messages */}
          {showHero && (
            <HeroChart
              data={heroData}
              agencyCount={heroAgencyCount || 0}
              population={heroPopulation ?? null}
            />
          )}

          {/* Conversation thread */}
          {messages.map((msg, idx) => {
            if (msg.role === "user") {
              // Check if this is the last user message
              const isLastUser = messages.slice(idx + 1).every((m) => m.role !== "user");
              return (
                <div key={msg.id} ref={isLastUser ? latestUserRef : undefined} className="flex justify-end">
                  <div className="bg-[var(--foreground)] text-white rounded-2xl rounded-br-sm px-4 py-2.5 max-w-[80%]">
                    <p className="text-sm">{msg.text}</p>
                  </div>
                </div>
              );
            }

            // Assistant message
            const resp = msg.response;
            const isLatest = msg.id === latestResponseId;

            return (
              <div key={msg.id} className="space-y-3">
                {/* Explanation */}
                <div className="bg-white rounded-xl border border-[var(--border)] px-5 py-4">
                  {msg.loading && !msg.text ? (
                    <div className="text-sm text-[var(--muted)] flex items-center gap-2">
                      <span className="inline-flex gap-0.5">
                        <span className="animate-bounce text-[#475EC7]">·</span>
                        <span
                          className="animate-bounce text-[#475EC7]"
                          style={{ animationDelay: "0.1s" }}
                        >
                          ·
                        </span>
                        <span
                          className="animate-bounce text-[#475EC7]"
                          style={{ animationDelay: "0.2s" }}
                        >
                          ·
                        </span>
                      </span>
                      {loadingStep}
                    </div>
                  ) : (
                    <div>
                      <p className="text-sm text-[var(--foreground)] leading-relaxed">
                        {msg.text}
                      </p>
                      {msg.loading && (
                        <div className="text-xs text-[var(--muted)] mt-2 flex items-center gap-1">
                          <span className="inline-flex gap-0.5">
                            <span className="animate-bounce text-[#475EC7]">·</span>
                            <span
                              className="animate-bounce text-[#475EC7]"
                              style={{ animationDelay: "0.1s" }}
                            >
                              ·
                            </span>
                            <span
                              className="animate-bounce text-[#475EC7]"
                              style={{ animationDelay: "0.2s" }}
                            >
                              ·
                            </span>
                          </span>
                          {loadingStep}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Chart — only for the latest response */}
                {isLatest && resp?.chartConfig && (
                  <div className="bg-white rounded-xl border border-[var(--border)] p-5">
                    <div className="flex items-center justify-between mb-2">
                      <h2
                        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                        style={{ letterSpacing: "0.6px" }}
                      >
                        {resp.title}
                      </h2>
                      <ExportButtons
                        chartRef={chartRef}
                        csvFilename={`${resp.title || "chart"}.jpeg`}
                      />
                    </div>
                    <div className="h-[320px] sm:h-[480px]">
                      <ChartPanel
                        ref={chartRef}
                        config={resp.chartConfig}
                        rows={resp.rows}
                        meta={resp.chartMeta}
                      />
                    </div>
                  </div>
                )}

                {/* Table — only for the latest response */}
                {isLatest && resp && resp.rows.length > 0 && (
                  <div className="bg-white rounded-xl border border-[var(--border)] p-5">
                    <div className="flex items-center justify-between mb-3">
                      <h2
                        className="text-xs font-medium uppercase tracking-wider text-[var(--muted)]"
                        style={{ letterSpacing: "0.6px" }}
                      >
                        Data{" "}
                        <span className="normal-case tracking-normal">
                          ({resp.rowCount.toLocaleString()} rows
                          {resp.executionTimeMs > 0 &&
                            ` · ${(resp.executionTimeMs / 1000).toFixed(1)}s`}
                          )
                        </span>
                      </h2>
                      <ExportButtons
                        csvData={resp.rows}
                        csvColumns={resp.columns}
                        csvFilename={`${resp.title || "crime-data-export"}.csv`}
                      />
                    </div>
                    <DataTable
                      columns={resp.columns}
                      rows={resp.rows}
                      truncated={resp.truncated}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
