import { autoRoute, isFollowUp, parseIntent, TAB_DISPLAY_NAMES, type TabId } from "./tab-suggest";
import { getQueryGuidanceWarnings } from "./query-guidance";
import { getGeoGuidanceIssues } from "./geo-guidance-lite";
import type { PickerSourceId } from "./sources";

export type QueryPlanChip = {
  key: "source" | "place" | "metric" | "time" | "unit";
  label: string;
  value: string;
  status: "ok" | "advisory" | "blocking" | "empty";
};

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
