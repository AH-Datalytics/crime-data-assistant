"use client";

import { useState, useMemo } from "react";
import { formatNumber, formatDate } from "@/lib/utils";

/** Convert column name like "kidnapping_count" → "Kidnapping Count" */
function formatHeader(col: string): string {
  return col
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bDc\b/g, "DC")
    .replace(/\bNyc\b/g, "NYC")
    .replace(/\bUsa\b/g, "USA");
}

/** Detect if a column holds year-like values (4-digit integers ~1900-2100) */
function isYearColumn(col: string, rows: Record<string, unknown>[]): boolean {
  if (/year/i.test(col)) return true;
  const sample = rows.slice(0, 10);
  return sample.every((r) => {
    const v = r[col];
    return typeof v === "number" && v >= 1900 && v <= 2100 && Number.isInteger(v);
  });
}



interface DataTableProps {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  fillHeight?: boolean;
}

export default function DataTable({ columns, rows, truncated, fillHeight }: DataTableProps) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState(false);

  const sortedRows = useMemo(() => {
    if (!sortCol) return rows;
    return [...rows].sort((a, b) => {
      const av = a[sortCol];
      const bv = b[sortCol];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") {
        return sortDir === "asc" ? av - bv : bv - av;
      }
      const as = String(av);
      const bs = String(bv);
      return sortDir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
    });
  }, [rows, sortCol, sortDir]);

  const displayRows = expanded ? sortedRows : sortedRows.slice(0, 100);

  const handleSort = (col: string) => {
    if (sortCol === col) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
  };

  const isNumeric = (col: string) => {
    return rows.some((r) => typeof r[col] === "number");
  };

  const yearCols = useMemo(
    () => new Set(columns.filter((c) => isYearColumn(c, rows))),
    [columns, rows]
  );

  const formatCell = (val: unknown, col: string) => {
    if (val == null) return "";
    if (typeof val === "number") {
      if (yearCols.has(col)) return String(val);
      return formatNumber(val);
    }
    const s = String(val);
    if (/^(19|20)\d{6}$/.test(s)) return formatDate(s);
    // Uppercase 2-letter state abbreviations
    if (/^(state|state_abbr)$/i.test(col) && /^[a-zA-Z]{2}$/.test(s)) return s.toUpperCase();
    return s;
  };

  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <div className={fillHeight ? "flex flex-col flex-1 min-h-0" : ""}>
      <div className={`overflow-x-auto overflow-y-auto ${fillHeight ? "flex-1" : "max-h-96"}`}>
        <table className="stat-table">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                >
                  <span>{formatHeader(col)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, i) => (
              <tr key={i}>
                {columns.map((col) => (
                  <td
                    key={col}
                  >
                    {formatCell(row[col], col)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 50 && !expanded && (
        <button
          onClick={() => setExpanded(true)}
          className="mt-3 text-sm text-[var(--muted)] hover:text-[var(--foreground)] cursor-pointer transition-colors"
        >
          Show all {rows.length.toLocaleString()} rows
          {truncated && " (results truncated)"}
        </button>
      )}
      {truncated && expanded && (
        <p className="mt-3 text-xs text-[var(--muted)]">
          Results truncated
        </p>
      )}
    </div>
  );
}
