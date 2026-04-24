"use client";

import { useCallback, useState, type RefObject } from "react";

interface ExportButtonsProps {
  chartRef?: RefObject<HTMLDivElement | null>;
  csvData?: Record<string, unknown>[];
  csvColumns?: string[];
  csvFilename?: string;
}

function fmtCsvVal(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "number") {
    const rounded = Number.isInteger(val) ? val : Math.round(val * 10) / 10;
    return String(rounded);
  }
  return String(val);
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
        const str = fmtCsvVal(row[c]);
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

/** Render the Crime Index logo SVG as an Image for canvas use */
function loadLogoImage(size: number): Promise<HTMLImageElement> {
  return new Promise((resolve) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 40 42">
      <path d="M19.1706 10.6386C22.5314 10.6386 25.5302 12.1839 27.4979 14.6003L33.6135 9.64955C29.9168 5.0845 25.0107 2.74426 19.1365 2.74426V10.6413C19.1365 10.6413 19.1601 10.6413 19.1706 10.6413V10.6386Z" fill="#01114B"/>
      <path d="M17.3918 10.7882V0C9.56299 0 2.80462 4.64376 0 11.9531L10.0011 15.7914C11.591 13.1836 14.2618 11.3103 17.3918 10.7882Z" fill="#183080"/>
      <path d="M8.43748 21.3718C8.43748 20.0206 8.68935 18.7272 9.14585 17.5361L1.7447 14.6947C0.343701 18.3441 0.104954 21.7522 0.983858 25.5616L8.71034 23.7776C8.53193 23.0036 8.43486 22.1982 8.43486 21.3718H8.43748Z" fill="#002BD6"/>
      <path d="M32.0551 34.7547L26.6059 29.1087C24.6776 30.9636 22.0566 32.1023 19.1707 32.1023C14.0704 32.1023 9.80443 28.5447 8.7104 23.775L0.983917 25.559C2.63678 32.7162 8.07549 38.0631 15.2615 39.59C21.5476 40.9254 27.7629 38.9157 32.0682 34.7678L32.0525 34.7521L32.0551 34.7547Z" fill="#475EC7"/>
      <path d="M29.6674 23.6123C29.2136 25.7506 28.1221 27.65 26.6031 29.1088L32.0707 34.7731C34.8831 32.0577 36.5413 29.072 37.3546 25.2468L29.6674 23.6097V23.6123Z" fill="#C5CDEE"/>
    </svg>`;
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

/** Render a branded footer onto a canvas and return the combined image as a data URL */
async function addBrandedFooter(sourceDataUrl: string): Promise<string> {
  return new Promise(async (resolve) => {
    const [chartImg, logoImg] = await Promise.all([
      new Promise<HTMLImageElement>((res) => { const i = new Image(); i.onload = () => res(i); i.src = sourceDataUrl; }),
      loadLogoImage(18),
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = chartImg.width;
    canvas.height = chartImg.height;
    const ctx = canvas.getContext("2d")!;

    // Draw chart image
    ctx.drawImage(chartImg, 0, 0);

    // Draw Crime Index logo + text in bottom-right, large and prominent
    const logoSize = 48;
    const text = "Crime Index";
    ctx.font = "600 20px 'Hanken Grotesk', Helvetica, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const totalWidth = logoSize + 10 + textWidth;
    const x = canvas.width - totalWidth - 24;
    const y = canvas.height - 36;

    // White background patch for legibility
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(x - 10, y - logoSize - 6, totalWidth + 20, logoSize + 16);

    ctx.drawImage(logoImg, x, y - logoSize, logoSize, logoSize);
    ctx.fillStyle = "#555";
    ctx.textBaseline = "bottom";
    ctx.font = "600 20px 'Hanken Grotesk', Helvetica, sans-serif";
    ctx.fillText(text, x + logoSize + 10, y - 10);

    resolve(canvas.toDataURL("image/png"));
  });
}

const btnClass =
  "group inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-md bg-[var(--surface)] text-[var(--muted)] hover:bg-[var(--foreground)] hover:text-white cursor-pointer transition-all duration-200";

export default function ExportButtons({
  chartRef,
  csvData,
  csvColumns,
  csvFilename = "crime-data-export.csv",
}: ExportButtonsProps) {
  const [copied, setCopied] = useState(false);

  const captureChart = useCallback(async (): Promise<string | null> => {
    if (!chartRef?.current) return null;
    const buttons = chartRef.current.querySelectorAll("[data-export-btn]");
    buttons.forEach((b) => ((b as HTMLElement).style.display = "none"));
    try {
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(chartRef.current, {
        pixelRatio: 2,
        backgroundColor: "#ffffff",
      });
      return await addBrandedFooter(dataUrl);
    } finally {
      buttons.forEach((b) => ((b as HTMLElement).style.display = ""));
    }
  }, [chartRef]);

  const handleJpeg = useCallback(async () => {
    const dataUrl = await captureChart();
    if (!dataUrl) return;
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = csvFilename.replace(/\.csv$/, ".png");
    a.click();
  }, [captureChart, csvFilename]);

  const handleCopy = useCallback(async () => {
    const dataUrl = await captureChart();
    if (!dataUrl) return;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: download instead
      handleJpeg();
    }
  }, [captureChart, handleJpeg]);

  const handleCsv = useCallback(() => {
    if (!csvData || !csvColumns) return;
    downloadCsv(csvData, csvColumns, csvFilename);
  }, [csvData, csvColumns, csvFilename]);

  return (
    <div className="flex gap-2" data-export-btn>
      {chartRef && (
        <button onClick={handleCopy} className={btnClass}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.5"/><path d="M5 11H4a1.5 1.5 0 01-1.5-1.5v-7A1.5 1.5 0 014 1h7a1.5 1.5 0 011.5 1.5V4"/></svg>
          {copied ? "Copied" : "Copy"}
        </button>
      )}
      {chartRef && (
        <button onClick={handleJpeg} className={btnClass}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M8 2v9m0 0l-3-3m3 3l3-3M3 14h10"/></svg>
          Download
        </button>
      )}
      {csvData && csvColumns && (
        <button onClick={handleCsv} className={btnClass}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 2h6l3 3v9H4V2z"/><path d="M10 2v3h3"/></svg>
          CSV
        </button>
      )}
    </div>
  );
}
