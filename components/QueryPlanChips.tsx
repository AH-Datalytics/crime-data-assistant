"use client";

import { useMemo } from "react";
import { buildQueryPlan } from "@/lib/query-plan";
import type { PickerSourceId, SourceId } from "@/lib/sources";

type QueryPlanChipsProps = {
  input: string;
  selectedSource: PickerSourceId;
  activeSource: SourceId | null;
};

const STATUS_CLASS = {
  ok: "border-[#DDE3EE] bg-white text-[var(--foreground)]",
  advisory: "border-[#E7D49A] bg-[#FFF9E8] text-[var(--foreground)]",
  blocking: "border-[#C9D0EA] bg-[#F4F6FF] text-[#354A9F]",
  empty: "border-[var(--border)] bg-[var(--surface)] text-[var(--muted)]",
};

export default function QueryPlanChips({ input, selectedSource, activeSource }: QueryPlanChipsProps) {
  const plan = useMemo(() => buildQueryPlan(input, selectedSource, activeSource), [input, selectedSource, activeSource]);
  if (!plan) return null;

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
      {plan.chips.map((chip) => (
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
