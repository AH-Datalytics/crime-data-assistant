import { resolveGeoPlaces } from "./geo-place-resolver";
import { buildQueryContract } from "./query-contract";
import type { ChartConfig, ChartMeta } from "./types";

export interface MultiCityTrendPlan {
  sql: string;
  title: string;
  explanation: string;
  columns: string[];
  chartConfig: ChartConfig;
  chartMeta: ChartMeta;
  guardrail: string;
}

type City = { name: string; state: string; alias: string; label: string };
type Offense = { label: string; current: string[]; historical: string };

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function cities(question: string): City[] {
  const resolution = resolveGeoPlaces(question);
  if (resolution.requiresClarification) return [];
  const found = resolution.mentions
    .map((mention) => mention.candidates.length === 1 ? mention.candidates[0] : null)
    .filter((candidate): candidate is NonNullable<typeof candidate> =>
      Boolean(candidate && candidate.kind === "city" && candidate.state)
    );
  const seen = new Set<string>();
  const result: City[] = [];
  for (const city of found) {
    const key = `${city.name}|${city.state}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name: city.name,
      state: city.state!,
      alias: slug(city.name),
      label: `${city.name}, ${city.state}`,
    });
  }
  const aliasCounts = new Map<string, number>();
  for (const city of result) aliasCounts.set(city.alias, (aliasCounts.get(city.alias) ?? 0) + 1);
  return result.map((city) => aliasCounts.get(city.alias)! > 1
    ? { ...city, alias: `${city.alias}_${city.state.toLowerCase()}` }
    : city
  );
}

function offense(question: string): Offense | null {
  if (/\b(?:motor\s+vehicle|auto)\s+thefts?\b/i.test(question)) {
    return { label: "motor vehicle theft", current: ["Motor Vehicle Theft"], historical: "hac.motor_vehicle_theft" };
  }
  if (/\bviolent\s+crimes?\b/i.test(question)) {
    return { label: "violent crime", current: ["Murder", "Rape", "Robbery", "Aggravated Assault"], historical: "hac.violent" };
  }
  if (/\bproperty\s+crimes?\b/i.test(question)) {
    return { label: "property crime", current: ["Burglary", "Theft", "Motor Vehicle Theft"], historical: "hac.property" };
  }
  if (/\b(?:murders?|homicides?)\b/i.test(question)) {
    return { label: "homicide", current: ["Murder"], historical: "hac.murder" };
  }
  if (/\brapes?\b/i.test(question)) return { label: "rape", current: ["Rape"], historical: "hac.rape" };
  if (/\brobber(?:y|ies)\b/i.test(question)) return { label: "robbery", current: ["Robbery"], historical: "hac.robbery" };
  if (/\b(?:aggravated\s+)?assaults?\b/i.test(question)) {
    return { label: "aggravated assault", current: ["Aggravated Assault"], historical: "hac.assault" };
  }
  if (/\bburglar(?:y|ies)\b/i.test(question)) return { label: "burglary", current: ["Burglary"], historical: "hac.burglary" };
  if (/\b(?:larcen(?:y|ies)|thefts?)\b/i.test(question)) return { label: "theft", current: ["Theft"], historical: "hac.theft" };
  return null;
}

function cityCondition(alias: string, city: City, source: "current" | "historical"): string {
  const name = source === "current" ? `${alias}.agency` : `${alias}.agency`;
  const state = source === "current" ? `${alias}.state` : `UPPER(${alias}.state)`;
  const type = source === "current" ? `LOWER(${alias}.type) = 'city'` : `LOWER(${alias}.type) = 'city'`;
  return `${name} = ${sqlString(city.name)} AND ${state} = ${sqlString(city.state)} AND ${type}`;
}

export function buildMultiCityTrendPlan(
  question: string,
  source: "current" | "historical"
): MultiCityTrendPlan | null {
  if (/\b(?:clearance|staff(?:ing)?|offender|victim|arrestee|race|ethnicity|sex|gender|age|weapon|relationship|rank|top)\b/i.test(question)) return null;
  const places = cities(question);
  if (places.length < 2 || places.length > 12) return null;
  const selectedOffense = offense(question);
  if (!selectedOffense) return null;
  const contract = buildQueryContract(question, source);
  if (!contract) return null;
  const { startYear, endYear } = contract.time;
  if (startYear === null || endYear === null || startYear === endYear) return null;
  if (!["count", "rate_per_100k"].includes(contract.metric.unit)) return null;
  const allowedBreakdowns = new Set(["year", "month", "city"]);
  if (contract.breakdowns.some((item) => !allowedBreakdowns.has(item))) return null;
  const rate = contract.metric.unit === "rate_per_100k";
  const monthly = source === "current" && !/\b(?:annual(?:ly)?|by\s+year|per\s+year|each\s+year|yearly)\b/i.test(question);
  const periodColumn = monthly ? "period" : "year";
  const columns = [periodColumn, ...places.map((city) => city.alias)];
  let sql: string;
  if (source === "current") {
    const filters = places.map((city) => `(${cityCondition("am", city, source)})`);
    const offenseList = selectedOffense.current.map(sqlString).join(", ");
    const cityColumns = places.map((city) => {
      const condition = cityCondition("am", city, source);
      const count = `SUM(CASE WHEN ${condition} THEN am.count ELSE 0 END)`;
      const value = rate
        ? `ROUND(100000.0 * ${count} / NULLIF(MAX(CASE WHEN ${condition} THEN ap.population END), 0), 1)`
        : count;
      return `${value} AS ${city.alias}`;
    });
    const period = monthly ? `printf('%04d-%02d', am.year, am.month)` : "am.year";
    const grouping = monthly ? "am.year, am.month" : "am.year";
    sql = `SELECT ${period} AS ${periodColumn},
  ${cityColumns.join(",\n  ")}
FROM agency_monthly am
LEFT JOIN agency_population ap ON ap.ori = am.ori AND ap.year = am.year
WHERE am.year BETWEEN ${startYear} AND ${endYear}
  AND am.offense IN (${offenseList})
  AND (${filters.join(" OR ")})
GROUP BY ${grouping}
ORDER BY ${grouping}`;
  } else {
    const filters = places.map((city) => `(${cityCondition("ha", city, source)})`);
    const cityColumns = places.map((city) => {
      const condition = cityCondition("ha", city, source);
      const count = `SUM(CASE WHEN ${condition} THEN ${selectedOffense.historical} ELSE 0 END)`;
      const value = rate
        ? `ROUND(100000.0 * ${count} / NULLIF(MAX(CASE WHEN ${condition} THEN hap.population END), 0), 1)`
        : count;
      return `${value} AS ${city.alias}`;
    });
    sql = `SELECT hac.year AS year,
  ${cityColumns.join(",\n  ")}
FROM historical_agency ha
JOIN historical_agency_crime hac ON hac.ori = ha.ori
LEFT JOIN historical_agency_population hap ON hap.ori = ha.ori AND hap.year = hac.year
WHERE hac.year BETWEEN ${startYear} AND ${endYear}
  AND (${filters.join(" OR ")})
GROUP BY hac.year
ORDER BY hac.year`;
  }
  const measure = rate ? "rate per 100,000 residents" : "reported count";
  const placeLabels = places.map((city) => city.label).join(", ");
  const currentDisclosure = source === "current"
    ? " Current data use the RTCI sample and are not a nationally representative trend series."
    : "";
  return {
    sql,
    title: `${selectedOffense.label[0].toUpperCase()}${selectedOffense.label.slice(1)} ${rate ? "Rates" : "Counts"} by City, ${startYear}-${endYear}`,
    explanation: `${source === "current" ? "Current" : "Historical"} ${selectedOffense.label} ${measure} for ${placeLabels} from ${startYear} through ${endYear}.${currentDisclosure}`,
    columns,
    chartConfig: {
      type: "line",
      xAxis: periodColumn,
      yAxis: places.map((city) => city.alias),
      title: `${selectedOffense.label} ${rate ? "rate" : "count"} by city`,
      yAxisLabel: rate ? "Rate per 100,000" : "Reported offenses",
    },
    chartMeta: {
      source: source === "current" ? "RTCI" : "FBI SRS",
      agencyCount: places.length,
      population: null,
    },
    guardrail: `deterministic-${source}-multi-city-trend`,
  };
}
