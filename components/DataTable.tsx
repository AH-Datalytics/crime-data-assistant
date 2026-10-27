"use client";

import { useState, useMemo } from "react";
import { formatNumber, formatDate } from "@/lib/utils";
import { monthLabel, tableDisplay } from "@/lib/table-display";

/**
 * Round 1 W2 (owner threshold 2): plain-word headers for internal column names. "Rate per 100k" is the owner's choice.
 * The CSV export keeps the original column names.
 */
const PLAIN_HEADERS: Record<string, string> = {
  rate_per_100k: "Rate per 100k",
  firearm_share_pct: "Firearm share (%)",
  share_pct: "Share (%)",
  offense_change_pct: "Change from prior year (%)",
  shr_records: "Homicide records",
  shr_recorded_months: "Months with homicide records",
  shr_status: "Coverage status",
  shr_coverage_caveat: "Coverage note",
  numerator_victims: "Victims in group",
  denominator_victims: "All victims",
  unknown_value_victims: "Victims with unknown value",
  first_month: "First month with records",
  last_month: "Last month with records",
  agency_type: "Agency type",
  jurisdiction_label: "Jurisdiction",
  agency_label: "Agency",
  ori: "Agency ID",
  agency_ori: "Agency ID",
};
/** Convert column name like "kidnapping_count" → "Kidnapping Count" */
function formatHeader(col: string): string {
  if (PLAIN_HEADERS[col.toLowerCase()]) return PLAIN_HEADERS[col.toLowerCase()];
  return col
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bDc\b/g, "DC")
    .replace(/\bNyc\b/g, "NYC")
    .replace(/\bUsa\b/g, "USA");
}

/** Detect if a column holds year-like values (4-digit integers ~1900-2100) */
function isYearColumn(col: string, rows: Record<string, unknown>[]): boolean {
  if (/year|^period$/i.test(col)) return true;
  const nums = rows.slice(0, 20).map((r) => r[col]).filter((v): v is number => typeof v === "number");
  return nums.length > 0 && nums.every((v) => v >= 1900 && v <= 2100 && Number.isInteger(v));
}

/** Round 1 W2: the agency ID column is shown only when two rows would otherwise look the same. */
function idColumnNeeded(col: string, columns: string[], rows: Record<string, unknown>[]): boolean {
  const labelCol = columns.find((c) => /^(?:place|city|agency|agency_name|jurisdiction|jurisdiction_label|agency_label)$/i.test(c) && c !== col);
  if (!labelCol) return true;
  const labels = rows.map((r) => `${String(r[labelCol] ?? "")}|${String(r.state ?? "")}`);
  return new Set(labels).size !== labels.length;
}



interface DataTableProps {
  /** The answer's title: a constant it already states (e.g. the place) is not restated above the table. */
  title?: string;
  /** Owner 2026-10-26: a table shown without a chart gets the chart-style title above it (single-number answers). */
  heading?: string;
  /** Plain headers for technical column names, from the answer (display only). */
  columnLabels?: Record<string, string>;
  columns: string[];
  rows: Record<string, unknown>[];
  truncated?: boolean;
  fillHeight?: boolean;
  /** Round 1 D3: the chart's partial periods, shown in the period column as "2026 (Partial)" (owner 2026-10-24). */
  partialPeriods?: { x: string | number; label: string }[];
  periodColumn?: string;
}

export default function DataTable({ columns: rawColumns, rows, truncated, fillHeight, title, heading, columnLabels, partialPeriods, periodColumn }: DataTableProps) {
  // Round 1 W2: an ori column is hidden unless it is needed to tell rows apart.
  const allColumns = useMemo(
    () => rawColumns.filter((c) => !/^(?:ori|agency_ori)$/i.test(c) || idColumnNeeded(c, rawColumns, rows)),
    [rawColumns, rows]
  );
  // Table display hotfix (2026-10-22): empty columns are not shown, and a text column that is the same on every row is
  // stated once above the table instead of repeated on every row. The CSV export keeps every column.
  const display = useMemo(() => tableDisplay(allColumns, rows, title ?? heading ?? "", columnLabels ?? {}), [allColumns, rows, title, heading, columnLabels]);
  const columns = display.shown;
  const partialLabel = useMemo(() => new Map((partialPeriods ?? []).map((p) => [String(p.x), p.label] as const)), [partialPeriods]);
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
    // Owner 2026-10-24: a partial period reads "2026 (Partial)"; the months it covers are not named in the table.
    if (col === (periodColumn ?? "period") && partialLabel.has(String(val))) return `${display.months.includes(col) ? monthLabel(val) : String(val)} (Partial)`;
    if (display.months.includes(col)) return monthLabel(val);
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

  const renderCell = (val: unknown, col: string) => {
    if (col !== "offense_change_pct") return formatCell(val, col);
    const change = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
    if (!Number.isFinite(change)) return formatCell(val, col);
    const color = change > 0 ? "#b91c1c" : change < 0 ? "#15803d" : "#1e2a35";
    return <span style={{ color, fontWeight: 700 }}>{formatCell(change, col)}</span>;
  };

  if (columns.length === 0 || rows.length === 0) return null;

  return (
    <div className={fillHeight ? "flex flex-col flex-1 min-h-0" : ""}>
      {heading && (
        <div
          className="text-[16px] sm:text-[20px] mb-2"
          data-table-heading="1"
          style={{ textAlign: "center", fontFamily: "'Bricolage Grotesque', 'DM Sans', sans-serif", fontWeight: 800, color: "#1e2a35", padding: "8px 12px 0", overflowWrap: "break-word", wordBreak: "break-word" }}
        >
          {heading}
        </div>
      )}
      {display.constants.length > 0 && (
        <p className="mb-2 text-sm text-[var(--muted)]" data-table-constants="1">
          {display.constants.map((c) => `${formatHeader(c.column)}: ${/^(state|state_abbr)$/i.test(c.column) && /^[a-zA-Z]{2}$/.test(c.value) ? c.value.toUpperCase() : c.value}`).join("; ")}
        </p>
      )}
      <div className={`overflow-x-auto overflow-y-auto ${fillHeight ? "flex-1" : "max-h-96"}`}>
        <table className="stat-table">
          <thead className="sticky top-0 z-10">
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  onClick={() => handleSort(col)}
                >
                  <span>{display.labels[col] ?? formatHeader(col)}</span>
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
                    {renderCell(row[col], col)}
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
