"use client";

import { useEffect, useRef, type RefObject } from "react";
import type { ChartConfig } from "@/lib/types";

function labels(root: HTMLElement, selector: string): string[] {
  return [...root.querySelectorAll(selector)]
    .map((element) => (element.textContent || "").trim().slice(0, 100))
    .filter(Boolean)
    .slice(0, 50);
}

export function useChartRenderReceipt(input: {
  requestId?: string;
  component: "ChartPanel" | "NibrsChartPanel";
  chartType: ChartConfig["type"];
  effectiveXKey: string;
  effectiveYKeys: string[];
}): RefObject<HTMLDivElement | null> {
  const rootRef = useRef<HTMLDivElement>(null);
  const effectiveYKeysJson = JSON.stringify(input.effectiveYKeys);
  useEffect(() => {
    if (!input.requestId) return;
    const timer = window.setTimeout(() => {
      const root = rootRef.current;
      if (!root) return;
      const svg = root.querySelector("svg");
      const bounds = svg?.getBoundingClientRect();
      const text = root.textContent || "";
      const svgLabels = labels(root, "svg text");
      const xTickLabels = labels(root, ".recharts-xAxis text, .xAxis text");
      const yTickLabels = labels(root, ".recharts-yAxis text, .yAxis text");
      const receipt = {
        requestId: input.requestId,
        component: input.component,
        chartType: input.chartType,
        effectiveXKey: input.effectiveXKey.slice(0, 100),
        effectiveYKeys: (JSON.parse(effectiveYKeysJson) as string[]).slice(0, 25).map((key) => key.slice(0, 100)),
        lineCount: root.querySelectorAll(".recharts-line-curve").length,
        barCount: root.querySelectorAll(".recharts-bar-rectangle path, path.recharts-rectangle").length,
        pointCount: root.querySelectorAll(".recharts-scatter-symbol, .recharts-line-dot").length,
        areaCount: root.querySelectorAll(".recharts-area-area, .recharts-pie-sector").length,
        legendLabels: labels(root, ".recharts-legend-item-text"),
        xTickLabels: xTickLabels.length ? xTickLabels : svgLabels,
        yTickLabels: yTickLabels.length ? yTickLabels : svgLabels,
        svgWidth: Math.round(bounds?.width || 0),
        svgHeight: Math.round(bounds?.height || 0),
        overflow: root.scrollWidth > root.clientWidth + 2 || root.scrollHeight > root.clientHeight + 2,
        zeroSize: !bounds || bounds.width <= 0 || bounds.height <= 0,
        invalidText: /(?:NaN|undefined)/i.test(text),
        renderError: false,
        viewportClass: window.innerWidth < 640 ? "narrow" : "desktop",
        renderedAt: Date.now(),
      };
      fetch("/api/chart-render-receipt", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receipt), keepalive: true,
      }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [input.requestId, input.component, input.chartType, input.effectiveXKey, effectiveYKeysJson]);
  return rootRef;
}
