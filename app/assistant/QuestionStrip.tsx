"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The question history (Jeff, 2026-11-01): a thin strip on the right edge, one short mark per question like a minimap.
 * A follow-up is a smaller mark under its question. Hovering a mark shows the question as answered; clicking scrolls to
 * it; the answer in view is marked in teal. On a phone the strip is hidden and a "Questions" button opens the same list.
 */
export type StripItem = { id: number; text: string; follow: boolean };

export default function QuestionStrip({ items, active, onGo }: { items: StripItem[]; active: number | null; onGo: (id: number) => void }) {
  const [tip, setTip] = useState<{ text: string; top: number } | null>(null);
  const [open, setOpen] = useState(false);
  const nav = useRef<HTMLElement>(null);
  // Like a scrollbar: each mark sits where its question is on the page, kept at least MIN px below the one before.
  const [pos, setPos] = useState<Record<number, number>>({});
  useEffect(() => {
    const MIN = 12;
    const place = () => {
      const h = nav.current?.clientHeight ?? 0, doc = document.documentElement.scrollHeight;
      if (!h || !doc) return;
      const next: Record<number, number> = {};
      let last = -MIN;
      for (const q of items) {
        const el = document.getElementById(`me${q.id}`);
        const y = el ? Math.round(((el.getBoundingClientRect().top + window.scrollY) / doc) * (h - MIN)) : last + MIN;
        last = Math.min(h - MIN, Math.max(y, last + MIN));
        next[q.id] = last;
      }
      setPos(next);
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(document.body);
    addEventListener("resize", place);
    return () => { ro.disconnect(); removeEventListener("resize", place); };
  }, [items.map((q) => q.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  if (items.length < 2) return null;
  return (
    <>
      <nav className="Strip" ref={nav} aria-label="Questions in this conversation">
        {items.map((q) => (
          <button key={q.id} type="button" aria-label={q.text} className={`Mark${q.follow ? " sub" : ""}${q.id === active ? " on" : ""}`} style={{ top: pos[q.id] ?? 0 }}
            onClick={() => onGo(q.id)}
            onMouseEnter={(e) => setTip({ text: q.text, top: e.currentTarget.getBoundingClientRect().top + e.currentTarget.offsetHeight / 2 })}
            onMouseLeave={() => setTip(null)} onFocus={(e) => setTip({ text: q.text, top: e.currentTarget.getBoundingClientRect().top + 4 })} onBlur={() => setTip(null)}>
            <span />
          </button>
        ))}
      </nav>
      {tip ? <div className="StripTip" style={{ top: tip.top }}>{tip.text}</div> : null}

      <button type="button" className="StripOpen" onClick={() => setOpen((o) => !o)} aria-expanded={open}>Questions</button>
      {open ? (
        <div className="StripList" role="dialog" aria-label="Questions in this conversation">
          {items.map((q) => (
            <button key={q.id} type="button" className={`${q.follow ? "sub" : ""}${q.id === active ? " on" : ""}`} onClick={() => { setOpen(false); onGo(q.id); }}>{q.text}</button>
          ))}
        </div>
      ) : null}
    </>
  );
}
