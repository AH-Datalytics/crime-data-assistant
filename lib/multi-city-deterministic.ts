import { resolveGeoPlaces } from "./geo-place-resolver";
import { buildQueryContract } from "./query-contract";
import { asksToIncludeCurrentYear, relativeYearRangeForQuestion } from "./time-conventions";
import type { ChartConfig, ChartMeta } from "./types";
import { consolidatedDisplayName, findConsolidatedAgency } from "./agency-consolidations";

export interface MultiCityTrendPlan {
  sql: string;
  title: string;
  explanation: string;
  columns: string[];
  chartConfig: ChartConfig;
  chartMeta: ChartMeta;
  guardrail: string;
  /**
   * The cities this plan asked for, paired with the result column each becomes.
   *
   * Needed because this plan PIVOTS cities into columns rather than rows, so
   * "which requested entities came back?" cannot be answered by scanning row
   * values -- a city that returned no data appears as an all-null column, not as
   * an absent row. This is the shape of the 31-of-32 completeness failure, and
   * lib/proof-checks' entityCompleteness check needs both halves to detect it.
   */
  requestedCities: { label: string; alias: string }[];
  /**
   * The years a RELATIVE request ("past 10 years") resolved to on the Historical path, so the exit
   * can say when the returned rows stop short of them rather than silently shortening the period.
   * Absent for explicit years and for Current, whose behavior is unchanged.
   */
  relativePeriod?: { start: number; end: number };
  /**
   * Request accounting stage 2a: the values this plan actually built its statement from (offense column, count or
   * rate, the resolved years), so the Historical route can check every part of the request was applied by value.
   */
  applied?: { offense: string; rate: boolean; startYear: number | null; endYear: number | null; relative: boolean };
}

/**
 * GC-098 correction C1: the sentence that keeps a relative Historical period from being silently
 * shortened to the years the source happens to hold. Null when the rows cover the resolved period.
 */
export function relativePeriodShortfallNote(plan: Pick<MultiCityTrendPlan, "relativePeriod">, rows: Record<string, unknown>[]): string | null {
  const period = plan.relativePeriod;
  if (!period) return null;
  const years = rows.map((row) => Number(row.year)).filter((year) => Number.isFinite(year));
  if (years.length === 0) return null;
  const first = Math.min(...years);
  const last = Math.max(...years);
  if (first <= period.start && last >= period.end) return null;
  const range = (a: number, b: number) => a === b ? String(a) : `${a}-${b}`;
  const missing = [
    ...(first > period.start ? [range(period.start, first - 1)] : []),
    ...(last < period.end ? [range(last + 1, period.end)] : []),
  ];
  return `The requested period is ${period.start}-${period.end}; the rows returned cover ${range(first, last)}, so ${missing.join(" and ")} ${missing.length === 1 && !missing[0].includes("-") ? "is" : "are"} not included.`;
}

type City = { name: string; state: string; alias: string; label: string; historicalOri?: string; currentName: string };
type Offense = { label: string; current: string[]; historical: string };

/** The chart title with the years the rows cover ("…, 1932 - 2025"); monthly periods count by their year. */
export function multiCityChartTitle(title: string, rows: Record<string, unknown>[], periodColumn: string): string {
  const years = rows.map((r) => Number(String(r[periodColumn] ?? "").slice(0, 4))).filter((y) => Number.isInteger(y) && y > 0);
  if (!years.length) return title;
  const lo = Math.min(...years), hi = Math.max(...years);
  return `${title}, ${lo === hi ? lo : `${lo} - ${hi}`}`;
}

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
    const consolidated = findConsolidatedAgency(city.state, city.name);
    const displayName = consolidatedDisplayName(city.state, city.name);
    result.push({
      name: displayName,
      state: city.state!,
      alias: slug(displayName),
      label: `${displayName}, ${city.state}`,
      historicalOri: consolidated?.historicalOri,
      currentName: consolidated?.currentAgency ?? displayName,
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
  if (/\bmurders?\b/i.test(question)) {
    return { label: "murder", current: ["Murder"], historical: "hac.murder" };
  }
  if (/\bhomicides?\b/i.test(question)) {
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
  if (source === "historical" && city.historicalOri) return `${alias}.ori = ${sqlString(city.historicalOri)}`;
  const name = source === "current" ? `${alias}.agency` : `${alias}.agency`;
  const state = source === "current" ? `${alias}.state` : `UPPER(${alias}.state)`;
  const type = source === "current" ? `LOWER(${alias}.type) = 'city'` : `LOWER(${alias}.type) = 'city'`;
  const sourceName = source === "current" ? city.currentName : city.name;
  // Owner 2026-10-25 ("new york city vs chicago robbery rate per year only gives chicago"): Historical stores some cities
  // without "City" (NYPD is "New York"). As resolveHistoricalAgency does, the name without a trailing "City" is used,
  // but only when no city agency has the full name and exactly one has the shorter name (Codex PF-01: two agencies
  // under one name are never summed; the column is left empty instead).
  const stripped = city.name.replace(/\s+city$/i, "");
  if (source === "historical" && stripped !== city.name) {
    const st = sqlString(city.state.toUpperCase());
    const named = (n: string) => `(SELECT COUNT(*) FROM historical_agency x WHERE x.agency = ${sqlString(n)} AND UPPER(x.state) = ${st} AND LOWER(x.type) = 'city')`;
    return `${name} = CASE WHEN ${named(city.name)} > 0 THEN ${sqlString(city.name)} WHEN ${named(stripped)} = 1 THEN ${sqlString(stripped)} END AND ${state} = ${sqlString(city.state)} AND ${type}`;
  }
  return `${name} = ${sqlString(sourceName)} AND ${state} = ${sqlString(city.state)} AND ${type}`;
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
  const contractYears = contract.time;
  if (source === "current" && !(contractYears.startYear !== null && contractYears.endYear !== null && contractYears.startYear !== contractYears.endYear)) return null;
  if ((contractYears.startYear === null) !== (contractYears.endYear === null) || (contractYears.startYear !== null && contractYears.startYear === contractYears.endYear)) return null;
  // GC-098 correction C1, Historical only: the contract carries explicit years alone, so "past 10
  // years" used to reach `WHERE 1 = 1` and return every year. The shared relative-year convention
  // resolves it; explicit years and the Current branch are untouched.
  const relative = source === "historical" && contractYears.startYear === null
    ? relativeYearRangeForQuestion(question)
    : null;
  const startYear = relative?.start ?? contractYears.startYear;
  const endYear = relative?.end ?? contractYears.endYear;
  const hasRange = startYear !== null && endYear !== null && startYear !== endYear;
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
WHERE am.year BETWEEN ${startYear!} AND ${endYear!}
  AND am.offense IN (${offenseList})
  AND (${filters.join(" OR ")})
GROUP BY ${grouping}
ORDER BY ${grouping}`;
  } else {
    const filters = places.map((city) => `(${cityCondition("ha", city, source)})`);
    const cityColumns = places.map((city) => {
      const condition = cityCondition("ha", city, source);
      // No ELSE branch: a year in which this agency filed nothing must stay NULL.
      // With ELSE 0 the grouped row -- which exists because some OTHER city in the
      // comparison reported that year -- renders a non-reporting agency as a real
      // zero, which on a trend chart is indistinguishable from zero homicides.
      const count = `SUM(CASE WHEN ${condition} THEN ${selectedOffense.historical} END)`;
      const value = rate
        ? `ROUND(100000.0 * ${count} / NULLIF(MAX(CASE WHEN ${condition} THEN hap.population END), 0), 1)`
        : count;
      return `${value} AS ${city.alias}`;
    });
    const yearFilter = hasRange ? `hac.year BETWEEN ${startYear} AND ${endYear}` : "1 = 1";
    sql = `SELECT hac.year AS year,
  ${cityColumns.join(",\n  ")}
FROM historical_agency ha
JOIN historical_agency_crime hac ON hac.ori = ha.ori
LEFT JOIN historical_agency_population hap ON hap.ori = ha.ori AND hap.year = hac.year
WHERE ${yearFilter}
  AND (${filters.join(" OR ")})
GROUP BY hac.year
ORDER BY hac.year`;
  }
  const measure = rate ? "rate per 100,000 residents" : "reported count";
  const placeLabels = places.map((city) => city.label).join(", ");
  const currentDisclosure = source === "current"
    ? " Current data use the RTCI sample and are not a nationally representative trend series."
    : "";
  const rangeLabel = hasRange ? `${startYear}-${endYear}` : "All Available Years";
  const relativeText = relative
    ? asksToIncludeCurrentYear(question)
      ? ` (the requested last ${endYear! - startYear! + 1} years, including ${endYear}, which is partial)`
      : ` (the requested last ${endYear! - startYear! + 1} complete calendar years)`
    : "";
  const rangeText = hasRange ? `from ${startYear} through ${endYear}${relativeText}` : "for all available years";
  return {
    sql,
    title: `${selectedOffense.label[0].toUpperCase()}${selectedOffense.label.slice(1)} ${rate ? "Rates" : "Counts"} by City, ${rangeLabel}`,
    explanation: `${source === "current" ? "Current" : "Historical"} ${selectedOffense.label} ${measure} for ${placeLabels} ${rangeText}.${currentDisclosure}`,
    columns,
    chartConfig: {
      type: "line",
      xAxis: periodColumn,
      yAxis: places.map((city) => city.alias),
      // Owner 2026-10-25: "Place Measure, 1936 - 2025" in title case; the years are added from the rows returned.
      title: `${places.map((city) => city.label).join(" and ")} ${selectedOffense.label.replace(/\b[a-z]/g, (c) => c.toUpperCase())} ${rate ? "Rate" : "Count"}`,
      yAxisLabel: rate ? "Rate per 100,000" : "Reported offenses",
    },
    chartMeta: {
      source: source === "current" ? "RTCI" : "FBI SRS",
      agencyCount: places.length,
      population: null,
    },
    guardrail: `deterministic-${source}-multi-city-trend`,
    applied: { offense: selectedOffense.historical, rate, startYear: hasRange ? startYear : null, endYear: hasRange ? endYear : null, relative: Boolean(relative) },
    requestedCities: places.map((city) => ({ label: city.label, alias: city.alias })),
    ...(relative ? { relativePeriod: { start: relative.start, end: relative.end } } : {}),
  };
}
