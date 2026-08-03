import type Database from "better-sqlite3";

export type CompletenessSource = "current" | "historical" | "nibrs" | "shr" | "hate_crime";
export type CompletenessRow = { year: number; value: number; month?: number };
export type CompletenessIntent = { year: number | null };

const ANALYTICAL_SIGNAL_RE = /\b(?:safest|riskiest|highest|lowest|most|least|rate|rates|trend|trends|change|changed|compare|comparison|increase|decrease|per\s+capita|ranking|rank|town|towns|city|cities)\b/i;

export function detectCompletenessQuestion(question: string): CompletenessIntent | null {
  const q = question.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!q || /\b(?:complete|completeness)\s+(?:list|set|table)\b/.test(q) || /\bcompleteness\s+rate\b/.test(q) || ANALYTICAL_SIGNAL_RE.test(q)) return null;
  const asks = /\b(?:complete|up to date|current|final(?:ized)?|full year)\b/.test(q);
  if (!asks) return null;
  const asksAboutData = /\b(?:data|year|reporting|numbers|figures|reports?)\b/.test(q);
  const questionShape = /\b(?:is|are|how)\b/.test(q) && (asksAboutData || /\bhow\s+(?:complete|current|up to date)\b/.test(q));
  if (!questionShape) return null;
  const year = q.match(/\b(?:19|20)\d{2}\b/);
  return { year: year ? Number(year[0]) : null };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function latestCompleteYear(rows: CompletenessRow[], currentYear: number): { latestPresent: number | null; latestComplete: number | null; preliminaryYears: number[] } {
  const totals = new Map<number, number>();
  for (const row of rows) {
    if (Number.isFinite(row.year) && Number.isFinite(row.value)) totals.set(row.year, (totals.get(row.year) || 0) + row.value);
  }
  const years = [...totals.keys()].sort((a, b) => a - b);
  if (years.length === 0) return { latestPresent: null, latestComplete: null, preliminaryYears: [] };
  const prior = years.filter((year) => year < currentYear - 1).slice(-3);
  const baseline = prior.length >= 2 ? median(prior.map((year) => totals.get(year)!)) : null;
  const sharpDropYears = baseline == null ? [] : years.filter((year) => year >= currentYear - 1 && year <= currentYear && totals.get(year)! < baseline * 0.6);
  const latestComplete = years.filter((year) => year < currentYear - 1 && !sharpDropYears.includes(year)).at(-1) ?? null;
  const preliminaryYears = years.filter((year) => latestComplete != null && year > latestComplete);
  return { latestPresent: years.at(-1) ?? null, latestComplete, preliminaryYears };
}

const SOURCE_LABEL: Record<CompletenessSource, string> = {
  current: "Current Trends",
  historical: "Historical Library",
  nibrs: "NIBRS",
  shr: "SHR",
  hate_crime: "hate-crime",
};

export function buildCompletenessAnswer(source: CompletenessSource, rows: CompletenessRow[], currentYear: number, requestedYear: number | null): string {
  const label = SOURCE_LABEL[source];
  if (source === "current") {
    const latest = rows.filter((row) => Number.isFinite(row.year) && Number.isFinite(row.month)).sort((a, b) => a.year - b.year || (a.month || 0) - (b.month || 0)).at(-1);
    if (!latest) return "Current Trends reports monthly data, but no reporting period was found in the available source data.";
    const period = latest.year + "-" + String(latest.month).padStart(2, "0");
    return requestedYear != null && requestedYear >= currentYear
      ? requestedYear + " Current Trends data is in progress and incomplete; the latest available monthly period is " + period + "."
      : "Current Trends reports monthly data. The latest available period is " + period + ", and the most recent months may be incomplete as agencies continue reporting.";
  }
  const summary = latestCompleteYear(rows, currentYear);
  if (summary.latestPresent == null) return "I could not determine the completeness of the requested data from the available " + label + " records.";
  const latestComplete = summary.latestComplete ?? summary.latestPresent;
  const preliminary = summary.preliminaryYears.length > 0 ? summary.preliminaryYears.join(", ") : "none identified";
  if (requestedYear != null && summary.preliminaryYears.includes(requestedYear)) {
    return requestedYear + " " + label + " data is in progress and incomplete. The latest reasonably complete year is " + latestComplete + "; preliminary years include " + preliminary + ".";
  }
  if (requestedYear != null && requestedYear > summary.latestPresent) {
    return "The available " + label + " data ends at " + summary.latestPresent + "; " + requestedYear + " is not yet present in the source and cannot be considered complete.";
  }
  return label + " data is available through " + summary.latestPresent + ". The latest reasonably complete year is " + latestComplete + "; preliminary or still-maturing years include " + preliminary + ".";
}

export function loadCompletenessRows(source: CompletenessSource, db: Database.Database | null): CompletenessRow[] {
  if (!db) return [];
  try {
    if (source === "current") return db.prepare("SELECT year, month, SUM(count) AS value FROM national_monthly GROUP BY year, month ORDER BY year, month").all() as CompletenessRow[];
    if (source === "hate_crime") return db.prepare("SELECT year, SUM(incident_count) AS value FROM summary_hate_crime_bias_trend GROUP BY year ORDER BY year").all() as CompletenessRow[];
    if (source === "nibrs") return db.prepare("SELECT year, SUM(victim_count) AS value FROM summary_victim_state_monthly GROUP BY year ORDER BY year").all() as CompletenessRow[];
    if (source === "historical") return db.prepare("SELECT year, SUM(violent_crime) AS value FROM historical_state_national GROUP BY year ORDER BY year").all() as CompletenessRow[];
    return db.prepare("SELECT year, COUNT(*) AS value FROM incidents GROUP BY year ORDER BY year").all() as CompletenessRow[];
  } catch {
    return [];
  }
}
