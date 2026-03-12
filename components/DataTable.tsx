"use client";

import { useState, useMemo } from "react";
import { formatNumber, formatDate } from "@/lib/utils";

/** Convert column name like "kidnapping_count" → "Kidnapping Count" */
function formatHeader(col: string): string {
  return col
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
}

export default function DataTable({ columns, rows, truncated }: DataTableProps) {
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

  const displayRows = expanded ? sortedRows : sortedRows.slice(0, 50);

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
    return s;
  };

  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <div>
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="stat-table">
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                  style={{ textAlign: isNumeric(col) ? "right" : "left" }}
                >
                  {formatHeader(col)}
                  {sortCol === col && (sortDir === "asc" ? " ▲" : " ▼")}
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
                    style={{ textAlign: isNumeric(col) ? "right" : "left" }}
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
          className="mt-2 text-sm text-blue-600 hover:underline cursor-pointer"
        >
          Show all {rows.length.toLocaleString()} rows
          {truncated && " (results capped at 1,000)"}
        </button>
      )}
      {truncated && expanded && (
        <p className="mt-2 text-xs text-gray-500">
          Results capped at 1,000 rows
        </p>
      )}
    </div>
  );
}
