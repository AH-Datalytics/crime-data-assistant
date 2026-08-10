"use client";

import { useEffect, useState } from "react";
import ChartPanel from "@/components/ChartPanel";
import NibrsChartPanel from "@/components/NibrsChartPanel";
import type { ChartAuditArtifact } from "@/lib/chart-audit";

declare global {
  interface Window { __CHART_AUDIT_READY__?: boolean; }
}

export default function ChartAuditPreviewClient() {
  const [artifact, setArtifact] = useState<ChartAuditArtifact | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("chart-audit-artifact");
      if (!raw) throw new Error("No chart artifact was injected.");
      const parsed = JSON.parse(raw) as ChartAuditArtifact;
      if (!parsed.chartConfig || !Array.isArray(parsed.rows)) throw new Error("The injected chart artifact is invalid.");
      setArtifact(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => {
    if (artifact) window.__CHART_AUDIT_READY__ = true;
  }, [artifact]);
  if (error) return <div data-chart-audit-error>{error}</div>;
  if (!artifact) return <div>Loading chart artifact...</div>;
  const nibrsStyle = ["nibrs", "shr", "hate_crime"].includes(artifact.source);
  return (
    <main data-chart-audit-ready="true" style={{ width: 960, height: 600, padding: 24, background: "#F5F0E8" }}>
      {nibrsStyle
        ? <NibrsChartPanel config={artifact.chartConfig} rows={artifact.rows} />
        : <ChartPanel config={artifact.chartConfig} rows={artifact.rows} />}
    </main>
  );
}
