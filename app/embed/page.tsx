"use client";

import { useEffect, useState, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import ChartPanel from "@/components/ChartPanel";
import NibrsChartPanel from "@/components/NibrsChartPanel";
import DataTable from "@/components/DataTable";
import type { ChartConfig, ChartMeta } from "@/lib/types";

interface EmbedData {
  tab: string;
  title: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chartConfig: ChartConfig | null;
  requestId?: string;
  chartMeta: ChartMeta | null;
}

function EmbedContent() {
  // Ensure html/body fill the iframe
  useEffect(() => {
    document.documentElement.style.height = "100%";
    document.body.style.height = "100%";
    document.body.style.margin = "0";
  }, []);
  const params = useSearchParams();
  const id = params.get("id");
  const view = params.get("view"); // "chart", "table", or null (both)

  const [data, setData] = useState<EmbedData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!id) {
      setError("No embed ID provided");
      setLoading(false);
      return;
    }
    fetch(`/api/embed?id=${encodeURIComponent(id)}`)
      .then((r) => {
        if (!r.ok) throw new Error("Not found");
        return r.json();
      })
      .then(setData)
      .catch(() => setError("Chart not found or expired"))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "#F5F0E8" }}>
        <div className="text-sm" style={{ color: "#5a6a7a", fontFamily: "'DM Sans', sans-serif" }}>
          Loading...
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-center h-screen" style={{ background: "#F5F0E8" }}>
        <div className="text-sm" style={{ color: "#5a6a7a", fontFamily: "'DM Sans', sans-serif" }}>
          {error || "Not found"}
        </div>
      </div>
    );
  }

  // Default: chart-only when chartConfig exists, table-only otherwise
  const showChart = view !== "table" && data.chartConfig;
  const showTable = view === "table" || (!data.chartConfig && data.rows.length > 0);
  const isNibrs = data.tab === "nibrs" || data.tab === "shr";

  return (
    <div
      className="flex flex-col"
      style={{ background: "#F5F0E8", fontFamily: "'DM Sans', 'Segoe UI', Arial, sans-serif", height: "100%", minHeight: 300 }}
    >
      {showChart && data.chartConfig && (
        <div style={{ flex: 1, minHeight: 0 }}>
          {isNibrs ? (
            <NibrsChartPanel config={data.chartConfig} rows={data.rows} requestId={data.requestId} />
          ) : (
            <ChartPanel config={data.chartConfig} rows={data.rows} meta={data.chartMeta} requestId={data.requestId} />
          )}
        </div>
      )}

      {showTable && (
        <div className="px-4 pb-4" style={{ background: "#F5F0E8" }}>
          <DataTable columns={data.columns} rows={data.rows} />
        </div>
      )}
    </div>
  );
}

export default function EmbedPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-screen" style={{ background: "#F5F0E8" }}>
          <div className="text-sm" style={{ color: "#5a6a7a" }}>Loading...</div>
        </div>
      }
    >
      <EmbedContent />
    </Suspense>
  );
}
