/**
 * Request accounting, stage 1, correction r1 (Codex findings 2, 3, 6): a requested PERIOD is applied
 * only when the statement that produces the number constrains exactly that period, at the requested
 * grain. Recognizing period words proves nothing ("until July" was recognized while the murder plan
 * counted January-December; "since 2025" was accepted for `year = 2025`).
 *
 * One parser for the request (the ledger's period parts) and one for a statement (its year/month
 * constraints and grouping), compared as SETS of years and months. The same proof serves every path
 * that has a statement: the deterministic murder and shooting plans and the model's final SQL.
 *
 * What cannot be proved is not applied: relative wording ("last five years", "so far") is accepted only
 * as "some year constraint is present" and stated as a limitation; seasons, halves and fiscal years are
 * unprovable here and decline.
 */
import type { Part } from "./request-accounting";

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_RE = String.raw`(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)\.?`;
export const YEAR_MIN = 1960;
export const YEAR_MAX = 2035;
const range = (a: number, b: number) => Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i);

export type RequestedPeriod = {
  /** Requested years, or null when the request names none. */
  years: Set<number> | null;
  /** Requested months (1-12) within each year, or null when it names none. */
  months: Set<number> | null;
  grain: "year" | "month" | null;
  /** Relative wording: only "some year constraint" can be proved. */
  relative: boolean;
  /** "since 2015", "2015 to present": the requested years run up to the latest data. */
  openEnded: boolean;
  /** Wording this proof cannot represent (seasons, halves, fiscal years): never applied. */
  unprovable: string[];
};

export function requestedPeriod(parts: Part[]): RequestedPeriod {
  const out: RequestedPeriod = { years: null, months: null, grain: null, relative: false, openEnded: false, unprovable: [] };
  const addYears = (ys: number[]) => { out.years = new Set([...(out.years ?? []), ...ys]); };
  const addMonths = (ms: number[]) => { out.months = new Set([...(out.months ?? []), ...ms]); };
  for (const part of parts.filter((p) => p.concept === "period")) {
    const t = part.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (/\b(?:monthly|by month|per month|each month|every month|month[- ]by[- ]month)\b/.test(t)) out.grain = "month";
    else if (/\b(?:by year|per year|each year|every year|yearly|annual(?:ly)?|year[- ]by[- ]year|over time|trends?)\b/.test(t) && !/of (?:each|every) year/.test(t)) out.grain = out.grain ?? "year";
    if (/\b(?:summers?|winters?|springs?|falls?|autumns?|holidays?|half|h[12]|fiscal|weeks?|days?|mid[- ]?\d|early \d|late \d|decades?|\d0s|end of|beginning of|start of|middle of)\b/.test(t)) { out.unprovable.push(part.text); continue; }
    if (/\b(?:last|past|previous|prior|recent(?:ly)?|latest|most recent|trailing|rolling|this|current(?:ly)?|so far|to date|ytd|year[- ]?to[- ]?date|now|today|present|ago|all (?:available )?years|all time|history|historically)\b/.test(t)) out.relative = true;
    // Quarters.
    const q = /\bq([1-4])\b|\b(first|second|third|fourth) quarter\b/.exec(t);
    if (q) { const n = q[1] ? Number(q[1]) : ["first", "second", "third", "fourth"].indexOf(q[2]) + 1; addMonths(range(3 * n - 2, 3 * n)); }
    // Months: a span, "through M", or a single month.
    const span = new RegExp(`${MONTH_RE}\\s*(?:-|to|through|thru)\\s*${MONTH_RE}`).exec(t);
    const through = new RegExp(`\\b(?:through|thru|to|until|till|as of)\\s+(?:the end of\\s+)?${MONTH_RE}`).exec(t);
    if (span) addMonths(range(MONTHS[span[1]], MONTHS[span[2]]));
    else if (through) addMonths(range(1, MONTHS[through[1]]));
    else {
      const single = new RegExp(`\\b${MONTH_RE}\\b`).exec(t);
      if (single && MONTHS[single[1]]) addMonths([MONTHS[single[1]]]);
    }
    const dateLike = /\b\d{1,2}\/\d{1,2}|\b\d{4}[-.]\d{2}/.test(t);
    if (dateLike) { out.unprovable.push(part.text); continue; }
    // Years.
    const ys = (t.match(/\b(?:19|20)\d{2}\b/g) ?? []).map(Number);
    const between = /\b(?:between|from)\s+((?:19|20)\d{2})\s*(?:-|–|and|to|through|thru|until)\s*((?:19|20)\d{2})\b/.exec(t)
      || /\b((?:19|20)\d{2})\s*(?:-|–|to|through|thru|until)\s*((?:19|20)\d{2})\b/.exec(t);
    const toPresent = /\b((?:19|20)\d{2})\s*(?:-|–|to|through|thru|until)\s*(?:present|now|today)\b/.exec(t);
    const since = /\b(?:since|starting(?: in)?|beginning(?: in)?|after|from)\s+((?:19|20)\d{2})\b/.exec(t);
    const before = /\b(?:before|prior to|until)\s+((?:19|20)\d{2})\b/.exec(t);
    if (between) addYears(range(Math.min(+between[1], +between[2]), Math.max(+between[1], +between[2])));
    else if (toPresent) { addYears(range(+toPresent[1], YEAR_MAX)); out.openEnded = true; }
    else if (since) { addYears(range(/after/.test(since[0]) ? +since[1] + 1 : +since[1], YEAR_MAX)); out.openEnded = true; }
    else if (before) addYears(range(YEAR_MIN, /until/.test(before[0]) ? +before[1] : +before[1] - 1));
    else if (ys.length > 0) addYears(ys);
  }
  return out;
}

export type StatementPeriod = { years: Set<number>; months: Set<number>; yearConstrained: boolean; monthGrain: boolean; yearGrain: boolean };

/** Year/month constraints and grouping read from a statement's text (alias prefixes ignored). */
export function statementPeriod(sql: string): StatementPeriod {
  // A recursive month GENERATOR ("SELECT month + 1 FROM months WHERE month < 7") bounds the rows it
  // generates, not the incidents counted; the incidents' own month constraint is read separately.
  const s = sql.replace(/\s+/g, " ").replace(/SELECT\s+month\s*\+\s*1\s+FROM\s+months\s+WHERE\s+month\s*<\s*\d+/gi, "")
    .replace(/\b(?:[a-z_]+\.)?ori\s*=\s*'[^']*'\s+AND\s+(?:[a-z_]+\.)?year\s+BETWEEN\s+\d+\s+AND\s+\d+/gi, "ORI_RANGE");
  let years = new Set(range(YEAR_MIN, YEAR_MAX));
  let months = new Set(range(1, 12));
  let yearConstrained = false;
  const apply = (column: "year" | "month", allowed: number[]) => {
    const set = new Set(allowed);
    if (column === "year") { years = new Set([...years].filter((y) => set.has(y))); yearConstrained = true; }
    else months = new Set([...months].filter((m) => set.has(m)));
  };
  for (const column of ["year", "month"] as const) {
    const all = column === "year" ? range(YEAR_MIN, YEAR_MAX) : range(1, 12);
    const col = String.raw`(?:\b[a-z_][a-z0-9_]*\.)?\b${column}\b`;
    for (const m of s.matchAll(new RegExp(`${col}\\s+BETWEEN\\s+(\\d+)\\s+AND\\s+(\\d+)`, "gi"))) apply(column, all.filter((v) => v >= +m[1] && v <= +m[2]));
    for (const m of s.matchAll(new RegExp(`${col}\\s+IN\\s*\\(([^)]*)\\)`, "gi"))) apply(column, m[1].split(",").map((x) => Number(x.trim().replace(/'/g, ""))).filter(Number.isFinite));
    for (const m of s.matchAll(new RegExp(`${col}\\s*(>=|<=|<>|!=|=|>|<)\\s*'?(\\d+)'?`, "gi"))) {
      const n = +m[2];
      const op = m[1];
      apply(column, all.filter((v) => (op === "=" ? v === n : op === ">=" ? v >= n : op === ">" ? v > n : op === "<=" ? v <= n : op === "<" ? v < n : v !== n)));
    }
  }
  const groupBy = /\bGROUP BY\b([\s\S]*?)(?:\bORDER BY\b|\bLIMIT\b|\bHAVING\b|\)|$)/gi;
  let monthGrain = /printf\('%04d-%02d'/i.test(s);
  let yearGrain = false;
  for (const m of s.matchAll(groupBy)) {
    if (/\bmonth\b/i.test(m[1])) monthGrain = true;
    if (/\byear\b/i.test(m[1])) yearGrain = true;
  }
  return { years, months, yearConstrained, monthGrain, yearGrain };
}

const equal = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));

/** Does the statement constrain exactly the requested period, at the requested grain? Reasons when not. */
export function periodProved(req: RequestedPeriod, st: StatementPeriod): { ok: boolean; why: string } {
  if (req.unprovable.length > 0) return { ok: false, why: `period wording not representable: ${req.unprovable.join(", ")}` };
  // An open-ended request ("since 2015") matches a statement that starts there and runs through the latest data year
  // (a cap at the data cutoff is the same period); a closed request must match exactly.
  // The latest data year is the current calendar year (SHR carries a partial current year).
  const latest = new Date().getUTCFullYear();
  const stYears = req.openEnded && st.years.size > 0 && Math.max(...st.years) >= latest
    ? new Set([...st.years, ...range(Math.max(...st.years), YEAR_MAX)]) : st.years;
  if (req.years && !equal(new Set([...req.years].filter((y) => y >= YEAR_MIN && y <= YEAR_MAX)), stYears)) return { ok: false, why: "years differ" };
  if (!req.years && req.relative && !st.yearConstrained) return { ok: false, why: "no year constraint for relative wording" };
  if (req.months && !equal(req.months, st.months)) return { ok: false, why: "months differ" };
  if (!req.months && st.months.size !== 12) return { ok: false, why: "statement restricts months the request did not" };
  if (req.grain === "month" && !st.monthGrain) return { ok: false, why: "not monthly" };
  if (req.grain === "year" && !st.yearGrain && !(req.years && req.years.size === 1)) return { ok: false, why: "not by year" };
  return { ok: true, why: "" };
}

/** Convenience: every period part of `parts` is applied by `sql`. */
export function periodsApplied(parts: Part[], sql: string): boolean {
  const periodParts = parts.filter((p) => p.concept === "period");
  if (periodParts.length === 0) return true;
  return periodProved(requestedPeriod(periodParts), statementPeriod(sql)).ok;
}
