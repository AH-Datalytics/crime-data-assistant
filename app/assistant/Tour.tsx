"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A short click-through tour for a first visit (Jeff, 2026-11-02), on a fixed example answer the page puts in place
 * while it runs (no question goes to the engine or the model). Each step lights up the real element on the page; a shade
 * over everything else takes the clicks, so nothing on the example can be run. Skip, Back, Next and Done; Esc skips,
 * the arrow keys step.
 */
type Step = { target: string; title: string; body: string };
export const STEPS: Step[] = [
  { target: ".Dock .AskRow", title: "Ask in plain words",
    body: "Name a crime, a place and a time, for example “carjacking in Memphis in 2024”, then press Enter or Ask." },
  { target: "[data-tour=answer] .Lead", title: "What the numbers are",
    body: "The sentence above each chart says what was counted, who reported it and where the data comes from." },
  { target: "[data-tour=answer] .Frame", title: "Chart and table",
    body: "Switch the chart type above the chart, and hover a bar or a row to see its value. Download the chart as a PNG or the table as a CSV." },
  { target: "[data-tour=answer] .read", title: "Follow-ups",
    body: "Ask a follow-up such as “same for 2023” or “by month” to change the last question. The line above the answer shows what was asked; Edit changes it." },
  { target: "[data-tour=decline] .Re", title: "When it can’t answer",
    body: "If a question can’t be answered here, it says why and offers a question it can answer." },
];

const PAD = 6, GAP = 12, EDGE = 16;

export function Tour({ step, onStep, onClose }: { step: number; onStep: (i: number) => void; onClose: () => void }) {
  const s = STEPS[step];
  const [box, setBox] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(0);
  const last = step === STEPS.length - 1;

  // Bring the step's element to the middle of the screen, then follow it while the page scrolls or resizes.
  useLayoutEffect(() => {
    const el = document.querySelector(s.target);
    if (!el) { setBox(null); return; }
    el.scrollIntoView({ block: "center" });
    const measure = () => setBox(el.getBoundingClientRect());
    measure();
    addEventListener("scroll", measure, { passive: true });
    addEventListener("resize", measure);
    return () => { removeEventListener("scroll", measure); removeEventListener("resize", measure); };
  }, [s.target]);
  useLayoutEffect(() => { if (card.current) setCardH(card.current.offsetHeight); }, [step, box]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") { if (last) onClose(); else onStep(step + 1); }
      else if (e.key === "ArrowLeft" && step > 0) onStep(step - 1);
      else return;
      e.preventDefault();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [step, last, onStep, onClose]);

  // The card sits under the element when it fits, else over it, else at the foot of the screen; never wider than the screen.
  const vw = typeof window === "undefined" ? 1024 : document.documentElement.clientWidth;
  const vh = typeof window === "undefined" ? 768 : innerHeight;
  const width = Math.min(352, vw - 2 * EDGE);
  let top = vh - cardH - EDGE, left = EDGE;
  if (box) {
    left = Math.max(EDGE, Math.min(box.left, vw - width - EDGE));
    if (box.bottom + PAD + GAP + cardH <= vh - EDGE) top = box.bottom + PAD + GAP;
    else if (box.top - PAD - GAP - cardH >= EDGE) top = box.top - PAD - GAP - cardH;
  }
  return (
    <div className="Tour" role="dialog" aria-modal="true" aria-labelledby="tour-title">
      <div className="TourShade" onClick={(e) => e.stopPropagation()} />
      {box ? <div className="TourHole" style={{ top: box.top - PAD, left: box.left - PAD, width: box.width + 2 * PAD, height: box.height + 2 * PAD }} /> : null}
      <div className="TourCard" ref={card} style={{ top, left, width }}>
        <p className="k">Step {step + 1} of {STEPS.length}</p>
        <h3 id="tour-title">{s.title}</h3>
        <p>{s.body}</p>
        <div className="TourNav">
          <button type="button" className="link" onClick={onClose}>Skip</button>
          <span>
            <button type="button" className="Btn" disabled={step === 0} onClick={() => onStep(step - 1)}>Back</button>
            <button type="button" className="Btn teal" autoFocus onClick={() => (last ? onClose() : onStep(step + 1))}>{last ? "Done" : "Next"}</button>
          </span>
        </div>
      </div>
    </div>
  );
}
