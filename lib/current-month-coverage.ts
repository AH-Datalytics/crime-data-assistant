/**
 * GC-051 batch (Codex next-batch selection, handoff :37507; Jeff's grant audit/phase3-gc051-2026-10-07/grant.txt).
 *
 * WHY THIS EXISTS. "what months does 2026 include?" on the Current Trends tab got the generic "I could not generate a
 * database query" refusal: the completeness recognizer (lib/completeness-intent.ts) does not read month-availability
 * wording, and its Current answer reports the LATEST period across all years -- never the requested year's months -- while
 * its reader turns a failed read into an empty list.
 *
 * WHAT THIS OWNS (recognized POSITIVELY from the whole turn): a standalone Current Trends question asking which months ONE
 * named year includes ("what months does 2026 include", "which months of 2026 are available", "months available for 2026",
 * …). No place, offense, second year, comparison or other wording -- those keep their existing route. Only a turn with no
 * conversation history is owned, so a "which months" asked about an earlier answer (a city, an offense) is never answered
 * with the national aggregate.
 *
 * MEANING (Jeff's interpretation, grant): the months REPRESENTED in Current Trends' `national_monthly` aggregate for that
 * year -- the table the existing completeness reader uses. A month is represented when the table holds any row for it, even
 * a zero-valued one; the read lists the months present (SELECT DISTINCT month), never crime totals. The answer names the table, lists the months present and the months
 * absent, and says what it does NOT establish: that every agency reported, or why a month is absent.
 *
 * OUTCOMES, kept distinct: months found; a successful read with NO months for the year (absence in this aggregate, never
 * zero crime); and a refused or failed read (the check failed -- never reported as empty).
 */

export const CURRENT_MONTH_COVERAGE_GUARDRAIL = "deterministic-current-month-coverage";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const listAnd = (xs: string[]) => (xs.length <= 1 ? xs.join("") : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const Y = String.raw`((?:19|20)\d{2})`;
const MONTH_WORDS = String.raw`(?:months?)`;
const VERB = String.raw`(?:include|includes|included|cover|covers|covered|have|has|contain|contains|show|shows)`;
const STATE = String.raw`(?:available|included|covered|reported|present|in\s+the\s+data(?:set)?|in\s+(?:current\s+trends|the\s+source)|there)`;
const LEAD = String.raw`(?:(?:can\s+you\s+tell\s+me|tell\s+me|please\s+tell\s+me|show\s+me|list)\s+)?`;
const FORMS: RegExp[] = [
  // what/which months does 2026 include | does the 2026 data include | are in 2026
  new RegExp(String.raw`^${LEAD}(?:what|which)\s+${MONTH_WORDS}\s+(?:does|do|did)\s+(?:the\s+)?${Y}(?:\s+data)?\s+${VERB}$`, "i"),
  // what/which months are available/included for/in 2026
  new RegExp(String.raw`^${LEAD}(?:what|which)\s+${MONTH_WORDS}\s+(?:are|were|is)\s+${STATE}\s+(?:for|in|of)\s+${Y}$`, "i"),
  // what/which months of 2026 are available | do you have (data for)
  new RegExp(String.raw`^${LEAD}(?:what|which)\s+${MONTH_WORDS}\s+(?:of|in|for)\s+${Y}\s+(?:are|were)\s+${STATE}$`, "i"),
  new RegExp(String.raw`^${LEAD}(?:what|which)\s+${MONTH_WORDS}\s+(?:of|in|for)\s+${Y}\s+(?:do|does)\s+(?:you|the\s+data|current\s+trends)\s+(?:have|include|cover)(?:\s+data\s+for)?$`, "i"),
  // months available for 2026 | 2026 months available
  new RegExp(String.raw`^${LEAD}(?:the\s+)?${MONTH_WORDS}\s+${STATE}\s+(?:for|in)\s+${Y}$`, "i"),
  new RegExp(String.raw`^${LEAD}${Y}\s+${MONTH_WORDS}\s+${STATE}$`, "i"),
];

const normalize = (q: string) => q.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "").trim();

/** The single requested year when the whole turn is a supported month-availability question; otherwise null. */
export function recognizeMonthCoverageQuestion(question: string): { year: number } | null {
  const turn = normalize(question);
  for (const re of FORMS) {
    const m = re.exec(turn);
    if (m) return { year: Number(m[1]) };
  }
  return null;
}

/** Owned only as a standalone turn: any conversation history leaves the question to its existing route. */
export function ownsMonthCoverage(question: string, history: unknown): { year: number } | null {
  if (Array.isArray(history) && history.length > 0) return null;
  return recognizeMonthCoverageQuestion(question);
}

/** The one year-bound statement: which months the national aggregate holds rows for (row presence, not crime totals). */
export function monthCoverageSql(year: number): string {
  return `SELECT DISTINCT month FROM national_monthly WHERE year = ${year} ORDER BY month`;
}

const SCOPE =
  // No table name: the response firewall treats internal identifiers in user text as a leak (lib/scaffold-helpers.ts).
  "This reads Current Trends' national monthly totals: a month is listed when those totals hold any record for it. " +
  "It does not show that every agency reported in those months, and it does not say why a month is absent.";

/** The answer, established by the statement's rows alone. */
export function monthCoverageAnswer(year: number, rows: Record<string, unknown>[]): string {
  const present = [...new Set(rows.map((r) => Number(r.month)).filter((m) => Number.isInteger(m) && m >= 1 && m <= 12))].sort((a, b) => a - b);
  if (present.length === 0) {
    return `Current Trends' national monthly totals have no months for ${year}: those totals hold no records for that year. ` +
      "That is an absence in this aggregate, not a count of zero crimes.";
  }
  const absent = MONTHS.map((_, i) => i + 1).filter((m) => !present.includes(m));
  const names = (ms: number[]) => listAnd(ms.map((m) => MONTHS[m - 1]));
  const lead = `For ${year}, Current Trends' national monthly totals include ${present.length === 12 ? "all 12 months" : `${present.length} ${present.length === 1 ? "month" : "months"}`}: ${names(present)}.`;
  const gaps = absent.length === 0 ? "" : ` Not included: ${names(absent)}.`;
  return `${lead}${gaps} ${SCOPE}`;
}

export const MONTH_COVERAGE_FAILED = (year: number) =>
  `I couldn't check which months Current Trends' national monthly totals include for ${year}: the coverage read did not complete. ` +
  "That is a failure on our side, not a statement about which months the data holds.";
