import { STATE_NAME_TO_ABBR } from "./state-population";
import type { ChartConfig, ChartMeta } from "./types";

export interface CurrentIndexedStatePlan {
  sql: string;
  title: string;
  explanation: string;
  columns: string[];
  chartConfig: ChartConfig;
  chartMeta: ChartMeta;
  guardrail: string;
}

type StateTarget = { name: string; code: string; alias: string };

function historyUserQuestions(rawHistory: unknown): string[] {
  if (!Array.isArray(rawHistory)) return [];
  return rawHistory
    .filter((entry): entry is { role: string; content: string } =>
      Boolean(entry && typeof entry === "object" &&
        (entry as { role?: unknown }).role === "user" &&
        typeof (entry as { content?: unknown }).content === "string")
    )
    .map((entry) => entry.content);
}

function acceptedBaseline(question: string): number | null {
  const match = question.trim().match(/^(?:yes[,;:]?\s*)?((?:19|20)\d{2})\s+(?:is\s+)?(?:good|fine|okay|ok|great|works?|will\s+do|please)\s*[.!]?$/i);
  return match ? Number(match[1]) : null;
}

function offense(question: string): string[] | null {
  if (/\b(?:motor\s+vehicle|auto)\s+thefts?\b/i.test(question)) return ["Motor Vehicle Theft"];
  if (/\bviolent\s+crimes?\b/i.test(question)) return ["Murder", "Rape", "Robbery", "Aggravated Assault"];
  if (/\bproperty\s+crimes?\b/i.test(question)) return ["Burglary", "Theft", "Motor Vehicle Theft"];
  if (/\b(?:murders?|homicides?)\b/i.test(question)) return ["Murder"];
  if (/\brapes?\b/i.test(question)) return ["Rape"];
  if (/\brobber(?:y|ies)\b/i.test(question)) return ["Robbery"];
  if (/\b(?:aggravated\s+)?assaults?\b/i.test(question)) return ["Aggravated Assault"];
  if (/\bburglar(?:y|ies)\b/i.test(question)) return ["Burglary"];
  if (/\b(?:larcen(?:y|ies)|thefts?)\b/i.test(question)) return ["Theft"];
  return null;
}

function states(question: string): StateTarget[] {
  const lower = question.toLowerCase();
  const occupied: Array<{ start: number; end: number }> = [];
  const found: Array<StateTarget & { start: number }> = [];
  const entries = Object.entries(STATE_NAME_TO_ABBR)
    .filter(([, code]) => code !== "US")
    .sort(([a], [b]) => b.length - a.length);
  for (const [name, code] of entries) {
    let start = lower.indexOf(name.toLowerCase());
    while (start >= 0) {
      const end = start + name.length;
      if (!occupied.some((range) => start >= range.start && end <= range.end)) {
        occupied.push({ start, end });
        found.push({ name, code, alias: name.toLowerCase().replace(/[^a-z0-9]+/g, "_"), start });
      }
      start = lower.indexOf(name.toLowerCase(), start + 1);
    }
  }
  return found.sort((a, b) => a.start - b.start).map(({ start: _start, ...state }) => state);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildCurrentIndexedStatePlan(
  question: string,
  rawHistory?: unknown
): CurrentIndexedStatePlan | null {
  let context = question;
  let baseline = acceptedBaseline(question);
  if (baseline !== null) {
    const prior = historyUserQuestions(rawHistory)
      .reverse()
      .find((value) => /\b(?:index(?:ed|ing)?|baseline)\b/i.test(value));
    if (!prior) return null;
    context = prior;
  } else {
    const match = question.match(/\b(?:indexed?\s+to|baseline(?:\s+(?:of|year))?)\s*((?:19|20)\d{2})\b/i);
    baseline = match ? Number(match[1]) : null;
  }
  if (baseline === null || baseline < 2017 || baseline > new Date().getFullYear()) return null;
  if (!/\b(?:rates?|per\s*(?:capita|100k|100,?000))\b/i.test(context)) return null;
  const selectedStates = states(context);
  const selectedOffenses = offense(context);
  if (selectedStates.length < 2 || selectedStates.length > 20 || !selectedOffenses) return null;

  const includeNational = /\b(?:national|nationwide|united\s+states|u\.?s\.?)\b/i.test(context);
  const stateCodes = selectedStates.map((state) => sqlString(state.code)).join(", ");
  const offenseList = selectedOffenses.map(sqlString).join(", ");
  const pivot = selectedStates.map((state) =>
    `MAX(CASE WHEN state = ${sqlString(state.code)} THEN indexed END) AS ${state.alias}`
  );
  if (includeNational) pivot.push("MAX(CASE WHEN state = 'US' THEN indexed END) AS national");
  const sql = `WITH sample_agency_year AS (
  SELECT
    am.ori,
    sa.state,
    am.year,
    SUM(am.count) AS offenses,
    MAX(ap.population) AS population
  FROM agency_monthly am
  JOIN sample_agencies sa ON sa.ori = am.ori
  LEFT JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year
  WHERE am.offense IN (${offenseList})
    AND am.year >= ${baseline}
  GROUP BY am.ori, sa.state, am.year
),
series AS (
  SELECT state, year,
    100000.0 * SUM(offenses) / NULLIF(SUM(population), 0) AS rate
  FROM sample_agency_year
  WHERE state IN (${stateCodes})
    AND population IS NOT NULL
  GROUP BY state, year
  ${includeNational ? `UNION ALL
  SELECT 'US' AS state, year,
    100000.0 * SUM(offenses) / NULLIF(SUM(population), 0) AS rate
  FROM sample_agency_year
  WHERE population IS NOT NULL
  GROUP BY year` : ""}
),
indexed AS (
  SELECT state, year,
    ROUND(100.0 * rate / NULLIF(MAX(CASE WHEN year = ${baseline} THEN rate END) OVER (PARTITION BY state), 0), 1) AS indexed
  FROM series
)
SELECT year,
  ${pivot.join(",\n  ")}
FROM indexed
GROUP BY year
ORDER BY year
LIMIT 1000`;
  const columns = ["year", ...selectedStates.map((state) => state.alias), ...(includeNational ? ["national"] : [])];
  const offenseLabel = selectedOffenses.length > 1 ? "crime" : selectedOffenses[0].toLowerCase();
  return {
    sql,
    title: `${offenseLabel[0].toUpperCase()}${offenseLabel.slice(1)} Rates Indexed to ${baseline}`,
    explanation: `Rates for ${selectedStates.map((state) => state.name).join(", ")}${includeNational ? " and the national sample" : ""}, indexed so ${baseline} equals 100. Rates use the combined population served by the consistently reporting Current Trends sample agencies in each state, not full-state population or statewide estimates. The latest year may be partial.`,
    columns,
    chartConfig: {
      type: "line",
      xAxis: "year",
      yAxis: columns.slice(1),
      title: `${offenseLabel} rate index (${baseline} = 100)`,
      yAxisLabel: `Index (${baseline} = 100)`,
    },
    chartMeta: { source: "RTCI", agencyCount: 0, population: null },
    guardrail: "deterministic-current-indexed-state-followup",
  };
}
