"use client";

import { useEffect, useMemo, useState } from "react";
import {
  HOW_TO_ASK_EXAMPLES,
  type GuidanceWarning,
  applyGuidanceAction,
  getQueryGuidanceWarnings,
} from "@/lib/query-guidance";

type QueryGuidanceProps = {
  input: string;
  onChangeInput: (value: string) => void;
  showExamples?: boolean;
  compact?: boolean;
  floating?: boolean;
  onFloatingOpenChange?: (open: boolean) => void;
  /** When a guidance choice is clicked, receive the corrected question (e.g. to submit it immediately). */
  onApplyAction?: (value: string) => void;
  /** Increment to draw attention to the card (e.g. after a blocked submit attempt). */
  attentionSignal?: number;
};

function actionLabel(label: string) {
  return label.replace(/^Use\s+/i, "");
}

function GuidanceWarningRow({
  input,
  warning,
  onChangeInput,
  onApplyAction,
}: {
  input: string;
  warning: GuidanceWarning;
  onChangeInput: (value: string) => void;
  onApplyAction?: (value: string) => void;
}) {
  const hasActions = Boolean(warning.actions?.length);
  const promptLabel = warning.kind === "blocking" ? "Choose" : "Better choices";
  const rowClass =
    warning.kind === "blocking"
      ? "rounded-md border border-[#D8DDED] bg-[#FAFBFF] px-2.5 py-2"
      : "rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-2";
  const buttonClass = "rounded-md border px-3 py-1.5 text-[12px] font-semibold leading-none shadow-sm cursor-pointer transition-colors hover:opacity-90";
  const buttonStyle = { backgroundColor: "#475EC7", borderColor: "#354A9F", color: "#fff" };

  return (
    <div className={rowClass}>
      <div className={warning.kind === "blocking" ? "text-[13px] leading-[18px] text-[var(--foreground)]" : "text-[13px] leading-[18px] text-[var(--muted)]"}>
        <span className="font-semibold text-[var(--foreground)]">{warning.title}.</span>{" "}
        {warning.detail}
      </div>
      {hasActions && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="mr-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            {promptLabel}
          </span>
          {warning.actions?.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                const next = applyGuidanceAction(input, action);
                onChangeInput(next);
                onApplyAction?.(next);
              }}
              className={buttonClass}
              style={buttonStyle}
            >
              {actionLabel(action.label)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function QueryGuidance({
  input,
  onChangeInput,
  showExamples = true,
  compact = false,
  floating = false,
  onFloatingOpenChange,
  onApplyAction,
  attentionSignal = 0,
}: QueryGuidanceProps) {
  const warnings = useMemo(() => getQueryGuidanceWarnings(input), [input]);
  const blocking = warnings.filter((warning) => warning.kind === "blocking");
  const advisory = warnings.filter((warning) => warning.kind === "advisory");
  // Blocking warnings gate submission, so hiding them would strand the user
  // at a disabled Ask button with no visible reason.
  const dismissible = blocking.length === 0;
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  useEffect(() => {
    if (dismissedInput && dismissedInput !== input) setDismissedInput(null);
  }, [dismissedInput, input]);

  // Debounce the card's first appearance so it doesn't interrupt mid-word;
  // once visible it stays while warnings persist, and hides instantly when clear.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!floating) return;
    if (warnings.length === 0) { setSettled(false); return; }
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), 450);
    return () => clearTimeout(timer);
  }, [floating, warnings.length, settled, input]);

  const [attention, setAttention] = useState(false);
  useEffect(() => {
    if (!attentionSignal) return;
    setSettled(true);
    setAttention(true);
    const timer = setTimeout(() => setAttention(false), 1100);
    return () => clearTimeout(timer);
  }, [attentionSignal]);

  const floatingOpen = floating && warnings.length > 0 && settled && !(dismissible && dismissedInput === input);
  useEffect(() => {
    if (!onFloatingOpenChange) return;
    onFloatingOpenChange(floatingOpen);
    return () => onFloatingOpenChange(false);
  }, [floatingOpen, onFloatingOpenChange]);
  if (!showExamples && warnings.length === 0) return null;
  if (floating && !floatingOpen) return null;
  const containerClass = floating
    ? `guidance-pop-in absolute left-0 top-full z-30 mt-1 w-[min(640px,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] rounded-lg border border-[var(--border)] bg-white p-2 ${dismissible ? "pr-9" : ""} shadow-lg${attention ? " guidance-attention" : ""}`
    : compact
      ? "space-y-2"
      : "space-y-3";

  return (
    <div className={containerClass}>
      {floating && warnings.length > 0 && dismissible && (
        <button
          type="button"
          onClick={() => setDismissedInput(input)}
          className="absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--foreground)] cursor-pointer"
          aria-label="Dismiss guidance"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      )}
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
        <div className="space-y-2">
          {blocking.map((warning) => (
            <GuidanceWarningRow key={warning.id} input={input} warning={warning} onChangeInput={onChangeInput} onApplyAction={onApplyAction} />
          ))}
        </div>
      )}

      {advisory.length > 0 && (
        <div className="space-y-2">
          {advisory.map((warning) => (
            <GuidanceWarningRow key={warning.id} input={input} warning={warning} onChangeInput={onChangeInput} onApplyAction={onApplyAction} />
          ))}
        </div>
      )}
    </div>
  );
}
