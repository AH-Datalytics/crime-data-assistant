import { stripSqlComments } from "./sql-restriction";

/**
 * Zero-filled Historical rates, in both the forms that have been observed.
 *
 * WHY THIS MODULE EXISTS. Two rules already refused a zero-filled rate: the
 * `historical-rate-zero-fill` guardrail (the retry) and the `historical-rate-null-gaps` capability
 * rule (the contract). Both carried the same regular expression, and it recognized only a BARE
 * MEASURE COLUMN -- `COALESCE(hac.murder, 0)`. The GC-048 witness showed the same lie one level
 * up: `COALESCE(ROUND(<rate>, 1), 0)` passed both, and on a fixture where Chicago reported nothing
 * in 1971 and nobody reported 1972, it delivered a murder rate of 0.0 for both years.
 *
 * A fabricated zero is worse than a gap. A gap says the product does not know; a zero says the
 * place had no murders. Decision 4 asks for interior missing years to be named as missing, and
 * this is the form that names them as safety.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It is not a COALESCE ban and not a SQL parser. It recognizes
 * two shapes, both demonstrated: a zero-filled measure column, and a zero-filled finished rate.
 * A genuine recorded zero is untouched -- nothing here reads values. Coalescing a label, a count,
 * or anything that is not the rate itself is untouched, and the callers only consult this at all
 * when the request asked for a rate.
 */

/**
 * The original pattern, unchanged, so the control it has always served keeps serving it.
 * `COALESCE`/`IFNULL` around a measure or population column, defaulted to zero or one.
 */
export const BARE_MEASURE_ZERO_FILL =
  /\b(?:COALESCE|IFNULL)\s*\(\s*(?:\w+\.)?(?:murder|rape|robbery|assault|violent|property|burglary|theft|motor_vehicle_theft|population|all_total|officer_total|civilian_total)\s*,\s*(?:0|0\.0|1|1\.0)\s*\)/i;

/** What makes an expression a rate rather than a count. */
const RATE_MARKER = /\*\s*100000(?:\.0)?\b|\bper_100k\b|\brate\b/i;

/**
 * `COALESCE(<a rate>, 0)` / `IFNULL(<a rate>, 0)`, with the parentheses walked rather than
 * matched.
 *
 * A regular expression cannot do this: the first argument is
 * `ROUND(SUM(CASE WHEN … END) * 100000.0 / NULLIF(MAX(CASE WHEN … END), 0), 1)`, four levels deep,
 * and a pattern loose enough to span it is loose enough to catch things it should not. So this
 * finds each call, walks to its matching close paren, splits the top-level arguments, and asks two
 * questions with definite answers: is the last argument zero, and does the first argument compute
 * a rate.
 */
export function zeroFillsFinishedRate(sql: string): boolean {
  const text = stripSqlComments(sql ?? "");
  const call = /\b(?:COALESCE|IFNULL)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = call.exec(text)) !== null) {
    const open = match.index + match[0].length - 1;
    const args = topLevelArguments(text, open);
    if (!args || args.length < 2) continue;
    const fallback = args[args.length - 1].trim();
    if (!/^(?:0|0\.0)$/.test(fallback)) continue;
    const value = args.slice(0, -1).join(",");
    if (RATE_MARKER.test(value)) return true;
  }
  return false;
}

/** Both observed shapes, for a caller that has already established the request asks for a rate. */
export function zeroFillsHistoricalRate(sql: string): boolean {
  const text = stripSqlComments(sql ?? "");
  return BARE_MEASURE_ZERO_FILL.test(text) || zeroFillsFinishedRate(text);
}

/**
 * The arguments of a call whose opening parenthesis is at `open`, split at the top level only.
 * Returns null when the call is unbalanced, because an unparseable statement is not this
 * function's to judge.
 */
function topLevelArguments(text: string, open: number): string[] | null {
  let depth = 0;
  let start = open + 1;
  let quote: string | null = null;
  const args: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "(") { depth += 1; continue; }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) { args.push(text.slice(start, i)); return args; }
      continue;
    }
    if (ch === "," && depth === 1) { args.push(text.slice(start, i)); start = i + 1; }
  }
  return null;
}
