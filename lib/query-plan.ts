import { autoRoute, isFollowUp, parseIntent, TAB_DISPLAY_NAMES, type TabId } from "./tab-suggest";
import { getQueryGuidanceWarnings } from "./query-guidance";
import { getGeoGuidanceIssues } from "./geo-guidance-lite";
import type { PickerSourceId } from "./sources";

export type QueryPlanChip = {
  key: "source" | "place" | "metric" | "time" | "unit";
  label: string;
  value: string;
  status: "ok" | "advisory" | "blocking" | "empty";
  /** Full text for the tooltip when `value` is shortened (e.g. "3 places"). */
  detail?: string;
};

/** The delivered answer a result chip is checked against (round 1 D8). */
export type DeliveredAnswer = { title?: string; explanation?: string; columns?: string[]; rows?: Record<string, unknown>[] };

const GENERIC_METRIC_WORDS = new Set(["rate", "rates", "count", "counts", "share", "ranking", "comparison", "trend", "trends", "total", "totals", "number", "per", "of", "the", "and", "by", "in", "change"]);
const stem = (w: string) => w.toLowerCase().replace(/ies$/, "y").replace(/s$/, "");

/**
 * Round 1 D8: the "understood as" chips of an answered question are checked against the delivered answer, never only
 * the question text. A place chip lists the places the answer actually covers; a metric, time or unit chip the answer
 * does not confirm is hidden rather than shown as understood (baseline W05, W06, P032, P050, P402).
 */
export function confirmResultChips(chips: QueryPlanChip[], answer: DeliveredAnswer | null | undefined): QueryPlanChip[] {
  if (!answer) return chips;
  const rows = Array.isArray(answer.rows) ? answer.rows : [];
  const columnValues = (key: string) => [...new Set(rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && v !== "").map(String))];
  const measures = columnValues("measure").map((m) => m.replace(/_/g, " "));
  const periods = [...columnValues("period"), ...columnValues("year")];
  const text = [answer.title ?? "", answer.explanation ?? "", ...(answer.columns ?? []), ...measures, ...periods].join(" ").toLowerCase().replace(/_/g, " ");
  const words = new Set(text.split(/[^a-z0-9]+/).filter(Boolean).map(stem));
  const places = columnValues("place");
  const statistics = columnValues("statistic");
  const out: QueryPlanChip[] = [];
  for (const chip of chips) {
    if (chip.key === "place") {
      if (places.length) { out.push({ ...chip, value: places.length <= 2 ? places.join(" and ") : `${places.length} places`, detail: places.join("; ") }); continue; }
      // Without a place column (wide answers: one column per place), a single-place chip is kept only when the answer
      // does not name further places ("New York City, NY and Chicago, IL"; baseline P032).
      const tokens = chip.value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2).map(stem);
      const namesMore = /[A-Z][A-Za-z.]+(?:,\s*[A-Z]{2})?\s+(?:and|vs\.?|versus)\s+[A-Z]/.test(answer.title ?? "");
      if (tokens.length && tokens.every((t) => words.has(t)) && !namesMore) out.push(chip);
      continue;
    }
    if (chip.key === "metric") {
      const tokens = chip.value.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t && !GENERIC_METRIC_WORDS.has(t)).map(stem);
      if (tokens.length && tokens.every((t) => words.has(t))) out.push(chip);
      continue;
    }
    if (chip.key === "time") {
      const years = chip.value.match(/\b(?:19|20)\d{2}\b/g) ?? [];
      const openEnded = /present|now|latest|current/i.test(chip.value);
      // An open-ended chip ("2025-present") needs an answer that spans more than one year (baseline P329, P402, P051).
      const answerYears = new Set([...(text.match(/\b(?:19|20)\d{2}\b/g) ?? []), ...periods.map((p) => p.slice(0, 4))]);
      const answerOpen = answerYears.size > 1;
      if (years.every((y) => words.has(y)) && (!openEnded || answerOpen)) out.push(chip);
      continue;
    }
    if (chip.key === "unit") {
      const v = chip.value.toLowerCase();
      const rateShown = /per 100(?:,000|k)|rate per|rate_per_100k|rate per 100k/.test(text) || statistics.some((s) => /rate/.test(s));
      const pctShown = /%|percent|share|pct/.test(text) || statistics.some((s) => /share|percent/.test(s));
      if (/100k|100,000|per/.test(v)) { if (rateShown) out.push(chip); continue; }
      if (/percent|%|share/.test(v)) { if (pctShown) out.push(chip); continue; }
      if (/count/.test(v) && statistics.length && !statistics.some((s) => /count/.test(s))) continue;
      out.push(chip);
      continue;
    }
    out.push(chip);
  }
  return out;
}

export type QueryPlan = {
  chips: QueryPlanChip[];
  blocking: boolean;
};

const SOURCE_LABELS: Record<TabId, string> = TAB_DISPLAY_NAMES;

function titleCase(value: string): string {
  return value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function formatPlace(intent: ReturnType<typeof parseIntent>, geoNeedsChoice: boolean): string {
  if (geoNeedsChoice) return "Needs choice";
  if (intent.geography.type === "national") return "National";
  if (intent.geography.type === "ambiguous") return "Unclear";
  if (intent.geography.name && intent.geography.state) return `${intent.geography.name}, ${intent.geography.state}`;
  if (intent.geography.name) return intent.geography.name;
  return titleCase(intent.geography.type);
}

function formatMetric(intent: ReturnType<typeof parseIntent>): string {
  if (intent.unsupportedConcepts.includes("demographic_homicide_rate_denominator")) return "Unsupported rate";
  const offense = intent.offense ? titleCase(intent.offense) : null;
  const measure = intent.measure === "clearance_rate"
    ? "Clearance rate"
    : intent.measure === "comparison"
      ? "Comparison"
      : titleCase(intent.measure);
  return offense ? `${offense} ${measure}` : measure;
}

function formatTime(intent: ReturnType<typeof parseIntent>): string {
  const { start, end } = intent.timeRange;
  if (start && end && start === end) return String(start);
  if (start && end) return `${start}-${end}`;
  if (start) return `${start}-present`;
  if (end) return `through ${end}`;
  return "Unspecified";
}

function formatUnit(intent: ReturnType<typeof parseIntent>): string {
  if (intent.measure === "rate" || intent.measure === "clearance_rate") return intent.measure === "clearance_rate" ? "Percent" : "Per 100k";
  if (intent.measure === "share") return "Percent";
  return "Count";
}

export function buildQueryPlan(input: string, selectedSource: PickerSourceId = "auto", activeSource: TabId | null = null): QueryPlan | null {
  const question = input.trim();
  if (!question) return null;

  const intent = parseIntent(question);
  const warnings = getQueryGuidanceWarnings(question);
  const geoNeedsChoice = getGeoGuidanceIssues(question).some((warning) => warning.kind === "blocking");
  const blocking = warnings.some((warning) => warning.kind === "blocking");
  const advisory = warnings.length > 0 && !blocking;
  const warningIds = new Set(warnings.map((warning) => warning.id));
  const needsMetricChoice = [
    "gun-violence",
    "shooting-scope",
    "generic-crime-type",
    "assault-type",
    "theft-type",
  ].some((id) => warningIds.has(id));
  const route = selectedSource === "auto" && !(isFollowUp(question) && activeSource) ? autoRoute(question) : null;
  const source = selectedSource !== "auto"
    ? selectedSource
    : isFollowUp(question) && activeSource
      ? activeSource
      : route?.source ?? null;

  const closeAlternatives = route && route.confidence !== "high"
    ? route.alternatives.filter((alt) => alt.score >= route.alternatives[0]?.score - 1 && alt.score >= 6).slice(0, 2)
    : [];
  const sourceValue = needsMetricChoice
    ? "Needs metric"
    : source && closeAlternatives.length > 0
      ? [source, ...closeAlternatives.map((alt) => alt.tab)]
          .filter((tab, idx, tabs) => tabs.indexOf(tab) === idx)
          .slice(0, 2)
          .map((tab) => SOURCE_LABELS[tab])
          .join(" / ")
      : source
        ? SOURCE_LABELS[source]
        : "Auto";
  const sourceStatus = blocking ? "blocking" : advisory ? "advisory" : "ok";
  const placeValue = formatPlace(intent, geoNeedsChoice);
  const placeStatus = geoNeedsChoice ? "blocking" : placeValue === "Unclear" ? "empty" : "ok";
  const metricValue = needsMetricChoice ? "Needs choice" : formatMetric(intent);
  const metricStatus = needsMetricChoice || intent.unsupportedConcepts.length > 0 ? "advisory" : "ok";
  const timeValue = formatTime(intent);

  const chips: QueryPlanChip[] = [
      { key: "source", label: "Source", value: sourceValue, status: sourceStatus },
      { key: "place", label: "Place", value: placeValue, status: placeStatus },
      { key: "metric", label: "Metric", value: metricValue, status: metricStatus },
      { key: "time", label: "Time", value: timeValue, status: timeValue === "Unspecified" ? "empty" : "ok" },
  ];
  if (!needsMetricChoice) chips.push({ key: "unit", label: "Unit", value: formatUnit(intent), status: "ok" });

  return { blocking, chips };
}
