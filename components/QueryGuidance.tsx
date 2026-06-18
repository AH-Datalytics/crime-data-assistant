"use client";

import { useMemo } from "react";
import {
  HOW_TO_ASK_EXAMPLES,
  applyGuidanceAction,
  getQueryGuidanceWarnings,
} from "@/lib/query-guidance";

type QueryGuidanceProps = {
  input: string;
  onChangeInput: (value: string) => void;
  showExamples?: boolean;
  compact?: boolean;
  floating?: boolean;
};

export default function QueryGuidance({
  input,
  onChangeInput,
  showExamples = true,
  compact = false,
  floating = false,
}: QueryGuidanceProps) {
  const warnings = useMemo(() => getQueryGuidanceWarnings(input), [input]);
  if (!showExamples && warnings.length === 0) return null;
  const blocking = warnings.filter((warning) => warning.kind === "blocking");
  const advisory = warnings.filter((warning) => warning.kind === "advisory");
  const containerClass = floating
    ? "absolute left-0 top-full z-30 mt-1 w-max min-w-full max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-white px-2 py-1.5 shadow-lg"
    : compact
      ? "space-y-2"
      : "space-y-3";

  return (
    <div className={containerClass}>
      {showExamples && (
        <section className="rounded-lg border border-[var(--border)] bg-white px-3 py-3 shadow-sm">
          <div className="flex items-center justify-between gap-3 mb-2">
            <h2 className="text-[12px] font-semibold text-[var(--foreground)]">How to ask</h2>
            <span className="text-[10px] text-[var(--muted)]">Click an example to edit it</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {HOW_TO_ASK_EXAMPLES.map((example) => (
              <button
                key={example.category}
                type="button"
                onClick={() => onChangeInput(example.question)}
                className="text-left rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2 hover:bg-white hover:border-[#475EC7]/40 cursor-pointer transition-colors"
              >
                <span className="block text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
                  {example.category}
                </span>
                <span className="block text-[12px] text-[var(--foreground)] leading-snug mt-0.5">
                  {example.question}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {blocking.length > 0 && (
        <div className={floating ? "" : "px-1.5"}>
          {blocking.map((warning) => (
            <div key={warning.id} className="flex flex-wrap items-center gap-1.5 text-[12px] leading-6">
              <span className="text-[var(--foreground)]">{warning.title}. <span className="font-semibold text-[#475EC7]">Choose:</span></span>
              {warning.actions?.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => onChangeInput(applyGuidanceAction(input, action))}
                  className="rounded-md border border-[#475EC7]/20 bg-[#475EC7]/5 px-2 py-0.5 text-[11px] font-semibold text-[#475EC7] hover:border-[#475EC7]/50 hover:bg-[#475EC7]/10 cursor-pointer transition-colors"
                >
                  {action.label.replace(/^Use\s+/i, "")}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {advisory.length > 0 && (
        <div className={floating ? "" : "px-1.5"}>
          {advisory.map((warning) => (
            <div key={warning.id} className="flex flex-wrap items-center gap-1.5 text-[12px] leading-6 text-[var(--muted)]">
              <span>{warning.title}{warning.actions && warning.actions.length > 0 ? "." : ""} {warning.actions && warning.actions.length > 0 && <span className="font-semibold text-[var(--foreground)]">Better choices:</span>}</span>
              {warning.actions?.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  onClick={() => onChangeInput(applyGuidanceAction(input, action))}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] font-medium text-[var(--foreground)] hover:border-[#475EC7]/40 hover:bg-white hover:text-[#475EC7] cursor-pointer transition-colors"
                >
                  {action.label.replace(/^Use\s+/i, "")}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
