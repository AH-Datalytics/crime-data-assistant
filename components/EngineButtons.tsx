"use client";

import type { EngineMeta } from "@/lib/types";

/**
 * The engine's buttons under an answer (stage 1, private flag): continuations that run the same question one step further, whole questions it offers, and the ones it cannot run
 * (shown disabled with their note, as the engine states them). Nothing here knows how a step runs: the page does, through `onPick`.
 */
export default function EngineButtons({ meta, accentColor, onPick }: { meta: EngineMeta; accentColor: string; onPick: (b: EngineMeta["buttons"][number]) => void }) {
  if (!meta.buttons.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-testid="engine-buttons">
      {meta.buttons.map((b) => {
        const runnable = b.kind === "continuation" || b.kind === "question";
        return (
          <span key={b.label} className="inline-flex flex-col">
            <button
              type="button"
              disabled={!runnable}
              onClick={() => onPick(b)}
              className="text-[12px] px-3 py-1 rounded-md border bg-white disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer hover:bg-[var(--surface)]"
              style={{ borderColor: accentColor, color: accentColor }}
            >{b.label}</button>
            {b.note ? <span className="text-[10px] text-[var(--muted)] mt-0.5 max-w-[240px]">{b.note}</span> : null}
          </span>
        );
      })}
    </div>
  );
}
