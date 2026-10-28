"use client";

import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

// useLayoutEffect measures before the first paint in the browser; on the server it is a no-op that would warn.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * The element's width, measured before the first paint and again on every resize. Chart layout decisions that
 * depend on width (sideways bars on a phone, the slanted-label margin) need it from the start: Recharts'
 * ResponsiveContainer onResize does not fire on the initial mount, so it left the width at 0 until a later resize.
 */
export function useBoxWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setWidth(entries[0].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
