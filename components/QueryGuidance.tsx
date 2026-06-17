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
};

export default function QueryGuidance({
  input,
  onChangeInput,
  showExamples = true,
  compact = false,
}: QueryGuidanceProps) {
  const warnings = useMemo(() => getQueryGuidanceWarnings(input), [input]);
  if (!showExamples && warnings.length === 0) return null;

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
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

      {warnings.length > 0 && (
        <section className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
          <div className="space-y-2">
            {warnings.map((warning) => (
              <div key={warning.id}>
                <div className="text-[12px] font-semibold text-amber-950">{warning.title}</div>
                <div className="text-[11px] text-amber-900 leading-relaxed">{warning.detail}</div>
                {warning.actions && warning.actions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {warning.actions.map((action) => (
                      <button
                        key={action.label}
                        type="button"
                        onClick={() => onChangeInput(applyGuidanceAction(input, action))}
                        className="rounded-md border border-amber-300 bg-white px-2 py-1 text-[10px] font-semibold text-amber-950 hover:border-amber-500 cursor-pointer"
                      >
                        {action.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
