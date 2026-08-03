export type RequestedGrain = "monthly" | "annual" | null;
export type ResultGrain = "monthly" | "annual" | "unknown";

const MONTHLY_REQUEST = /\b(?:monthly|per\s+month|by\s+month|month[-\s]?over[-\s]?month|\d+\s+months?)\b/i;
const ANNUAL_REQUEST = /\b(?:annual(?:ly)?|yearly|per\s+year|by\s+year|each\s+year|year[-\s]?over[-\s]?year)\b/i;

function rowKeys(rows: Record<string, unknown>[]): string[] {
  return rows.flatMap((row) => Object.keys(row)).map((key) => key.toLowerCase());
}

export function detectRequestedGrain(question: string): RequestedGrain {
  if (MONTHLY_REQUEST.test(question)) return "monthly";
  if (ANNUAL_REQUEST.test(question)) return "annual";
  return null;
}

export function resultGrain(rows: Record<string, unknown>[], sql = ""): ResultGrain {
  const keys = rowKeys(rows);
  const hasMonth = keys.some((key) => /^(?:month|data_month|month_number|month_name)$/.test(key) || /(?:^|_)month$/.test(key));
  const hasYear = keys.some((key) => /^(?:year|data_year|report_year)$/.test(key) || /(?:^|_)year$/.test(key));
  if (hasMonth) return "monthly";
  if (hasYear) return "annual";

  const selectSql = sql.match(/\bselect\b[\s\S]*?\bfrom\b/i)?.[0] ?? sql;
  if (/\b(?:month|data_month|month_number|month_name)\b/i.test(selectSql)) return "monthly";
  if (/\b(?:year|data_year|report_year)\b/i.test(selectSql)) return "annual";
  return "unknown";
}

export function validateGrain(
  question: string,
  rows: Record<string, unknown>[],
  sql = "",
): { ok: boolean; message?: string } {
  const requested = detectRequestedGrain(question);
  if (!requested) return { ok: true };

  const actual = resultGrain(rows, sql);
  if (actual === "unknown" || actual === requested) return { ok: true };

  if (requested === "monthly" && actual === "annual") {
    return { ok: false, message: "This source reports this measure annually, not monthly. The annual results are shown below." };
  }
  return { ok: false, message: "This source reports this measure monthly, not annually. The monthly results are shown below." };
}
