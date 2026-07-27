"use client";

import { useMemo } from "react";
import { buildQueryPlan } from "@/lib/query-plan";
import type { PickerSourceId, SourceId } from "@/lib/sources";

type QueryPlanChipsProps = {
  input: string;
  selectedSource: PickerSourceId;
  activeSource: SourceId | null;
  variant?: "input" | "result";
};

const RESULT_STALE_VALUES = new Set(["Unclear", "Needs choice", "Needs metric", "Unspecified", "Auto"]);

const STATUS_CLASS = {
  ok: "border-[#DDE3EE] bg-white text-[var(--foreground)]",
  advisory: "border-[#E7D49A] bg-[#FFF9E8] text-[var(--foreground)]",
  blocking: "border-[#C9D0EA] bg-[#F4F6FF] text-[#354A9F]",
  empty: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]",
};

export default function QueryPlanChips({ input, selectedSource, activeSource, variant = "input" }: QueryPlanChipsProps) {
  const plan = useMemo(() => buildQueryPlan(input, selectedSource, activeSource), [input, selectedSource, activeSource]);
  if (!plan) return null;

  // Result variant: provenance for a query that already ran. The source badge
  // covers the source chip, and picker statuses are stale once resolved.
  const chips = variant === "result"
    ? plan.chips
        .filter((chip) => chip.key !== "source" && chip.status !== "empty" && !RESULT_STALE_VALUES.has(chip.value))
        .map((chip) => ({ ...chip, status: "ok" as const }))
    : plan.chips;
  if (variant === "result" && chips.length < 2) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {variant === "result" && (
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Understood as</span>
      )}
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`inline-flex max-w-full items-center gap-1 rounded-md border px-2 py-1 text-[10px] leading-none shadow-[0_1px_0_rgba(0,0,0,0.02)] ${STATUS_CLASS[chip.status]}`}
          title={`${chip.label}: ${chip.value}`}
        >
          <span className="font-semibold uppercase tracking-wide text-[var(--muted)]">{chip.label}</span>
          <span className="max-w-[170px] truncate font-medium">{chip.value}</span>
        </span>
      ))}
    </div>
  );
}
