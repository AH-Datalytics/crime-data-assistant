"use client";

import { useCallback, type RefObject } from "react";

interface ExportButtonsProps {
  chartRef?: RefObject<HTMLDivElement | null>;
  csvData?: Record<string, unknown>[];
  csvColumns?: string[];
  csvFilename?: string;
}

function downloadCsv(
  data: Record<string, unknown>[],
  columns: string[],
  filename: string
) {
  const header = columns.join(",");
  const rows = data.map((row) =>
    columns
      .map((c) => {
        const val = row[c] ?? "";
        const str = String(val);
        return str.includes(",") || str.includes('"')
          ? `"${str.replace(/"/g, '""')}"`
          : str;
      })
      .join(",")
  );
  const csv = [header, ...rows].join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const btnClass =
  "px-3 py-1.5 text-xs font-medium rounded-full border border-[var(--border)] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] cursor-pointer transition-colors";

export default function ExportButtons({
  chartRef,
  csvData,
  csvColumns,
  csvFilename = "crime-data-export.csv",
}: ExportButtonsProps) {
  const handleJpeg = useCallback(async () => {
    if (!chartRef?.current) return;
    // Hide all export buttons inside the capture area
    const buttons = chartRef.current.querySelectorAll("[data-export-btn]");
    buttons.forEach((b) => ((b as HTMLElement).style.display = "none"));
    try {
      const { toJpeg } = await import("html-to-image");
      const dataUrl = await toJpeg(chartRef.current, {
        quality: 0.95,
        backgroundColor: "#ffffff",
      });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = csvFilename.replace(/\.csv$/, ".jpeg");
      a.click();
    } finally {
      buttons.forEach((b) => ((b as HTMLElement).style.display = ""));
    }
  }, [chartRef, csvFilename]);

  const handleCsv = useCallback(() => {
    if (!csvData || !csvColumns) return;
    downloadCsv(csvData, csvColumns, csvFilename);
  }, [csvData, csvColumns, csvFilename]);

  return (
    <div className="flex gap-2" data-export-btn>
      {csvData && csvColumns && (
        <button onClick={handleCsv} className={btnClass}>
          ↓ Export CSV
        </button>
      )}
      {chartRef && (
        <button onClick={handleJpeg} className={btnClass}>
          ↓ Export JPEG
        </button>
      )}
    </div>
  );
}
