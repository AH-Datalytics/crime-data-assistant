import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { resolveShrAgency, type ShrResolvedAgency } from "./shr-place-resolver";
import { loadShrAnnualCoverage, shrCoverageCaveat } from "./shr-annual-coverage";

export type ShrMurderPlan =
  | { kind: "blocked"; explanation: string }
  | {
      kind: "query";
      sql: string;
      title: string;
      explanation: string;
      columns: string[];
      chartType: "bar" | "line";
      xAxis: string;
      yAxis: string[];
    };

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function resolutionName(name: string): string {
  const overrides: Record<string, string> = {
    "New York City": "New York",
    Charlotte: "Charlotte-Mecklenburg",
    Nashville: "Metropolitan Nashville",
    "Las Vegas": "Las Vegas Metropolitan",
    Louisville: "Louisville Metro",
  };
  return overrides[name] || name;
}

function displayName(name: string, state: string): string {
  return `${name}, ${state.toUpperCase()}`;
}

function throughMonth(question: string): number {
  const names = Object.keys(MONTHS).join("|");
  const match = new RegExp(`\\b(?:through|thru|to|as\\s+of)\\s+(${names})\\b`, "i").exec(question);
  return match ? MONTHS[match[1].toLowerCase()] : 12;
}

function requestedYear(question: string): number | null {
  const years = [...question.matchAll(/\b(?:19|20)\d{2}\b/g)].map((match) => Number(match[0]));
  return years.length === 1 ? years[0] : null;
}

function targetValues(places: { display: string; resolved: ShrResolvedAgency }[]): string {
  return places.flatMap(({ display, resolved }) => resolved.ranges.map((range) =>
    `(${sqlText(display)}, ${sqlText(range.ori)}, ${range.startYear}, ${range.endYear})`
  )).join(", ");
}

function coverageValues(
  places: { display: string; resolved: ShrResolvedAgency }[],
  db: Database.Database,
  year: number,
): string {
  return places.map(({ display, resolved }) => {
    const activeOris = resolved.ranges
      .filter((range) => year >= range.startYear && year <= range.endYear)
      .map((range) => range.ori);
    const coverage = loadShrAnnualCoverage(db, activeOris, resolved.state, year);
    const caveat = shrCoverageCaveat(coverage.caveatCode);
    return `(${sqlText(display)}, ${coverage.shrVictims}, ${coverage.displayStatus === "validated_zero" ? 1 : 0}, ${sqlText(coverage.displayStatus)}, ${caveat ? sqlText(caveat) : "NULL"}, ${coverage.monthsWithRecords})`;
  }).join(", ");
}

export function buildShrMurderPlan(question: string, db: Database.Database): ShrMurderPlan | null {
  if (!/\bmurders?\b/i.test(question)) return null;
  if (/\b(rate|per\s+capita|weapon|firearm|gun|shoot|race|sex|gender|age|relationship|circumstance|offender|clearance|arrest|exception)\b/i.test(question)) return null;

  const year = requestedYear(question);
  if (!year) return null;
  const geo = resolveGeoPlaces(question);
  if (geo.requiresClarification || geo.mentions.length === 0) return null;
  const candidates = geo.mentions.map((mention) => mention.candidates[0]);
  if (candidates.some((candidate) => !candidate || candidate.kind !== "city" || !candidate.state)) return null;

  const unique = candidates.filter((candidate, index, all) =>
    all.findIndex((other) => other.id === candidate.id) === index
  );
  const places = unique.map((candidate) => {
    const resolved = resolveShrAgency(db, resolutionName(candidate.name), candidate.state!, {
      kind: "city", startYear: year, endYear: year,
    });
    return { display: displayName(candidate.name, candidate.state!), resolved };
  });
  const blocked = places.find(({ resolved }) => resolved.status !== "resolved");
  if (blocked) {
    return {
      kind: "blocked",
      explanation: `I cannot safely identify ${blocked.display} in the SHR agency identity data for ${year}. I will not substitute or silently omit another agency.`,
    };
  }

  const endMonth = throughMonth(question);
  const monthly = /\b(?:monthly|per\s+month|by\s+month)\b/i.test(question);
  const values = targetValues(places);
  const annualCoverageValues = coverageValues(places, db, year);
  const monthLabel = Object.keys(MONTHS).find((name) => MONTHS[name] === endMonth)!;
  const period = endMonth < 12 ? `January through ${monthLabel[0].toUpperCase()}${monthLabel.slice(1)}` : `calendar year ${year}`;
  const placeList = places.map((place) => place.display).join(", ");

  if (monthly) {
    const sql = `WITH RECURSIVE months(month) AS (SELECT 1 UNION ALL SELECT month + 1 FROM months WHERE month < ${endMonth}), targets(city, ori, start_year, end_year) AS (VALUES ${values}), annual_coverage(city, annual_shr_victims, validated_zero, coverage_status, coverage_caveat, months_with_records) AS (VALUES ${annualCoverageValues}), counts AS (SELECT t.city, i.month, COUNT(v.id) AS murder_victims FROM targets t JOIN incidents i ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year = ${year} AND i.month BETWEEN 1 AND ${endMonth} GROUP BY t.city, i.month) SELECT printf('%04d-%02d', ${year}, m.month) AS month, ac.city, CASE WHEN COALESCE(c.murder_victims, 0) > 0 THEN c.murder_victims WHEN ac.annual_shr_victims > 0 OR ac.validated_zero = 1 THEN 0 ELSE NULL END AS murder_victims, ac.months_with_records AS shr_recorded_months, ac.coverage_status AS shr_status, ac.coverage_caveat AS shr_coverage_caveat FROM annual_coverage ac CROSS JOIN months m LEFT JOIN counts c ON c.city = ac.city AND c.month = m.month ORDER BY ac.city, m.month LIMIT 1000`;
    return {
      kind: "query", sql,
      title: `Monthly Murder Victims, ${placeList}, ${year}`,
      explanation: `Monthly murder victim counts reported in SHR for ${placeList}, ${period}. Positive SHR victim records are always shown. Zeroes are shown only when annual SHR evidence exists or Return A validates a true zero; otherwise the value is blank with a coverage disclosure. One incident can have multiple victims, so this counts victim records rather than incidents.`,
      columns: ["month", "city", "murder_victims", "shr_recorded_months", "shr_status", "shr_coverage_caveat"], chartType: "line", xAxis: "month", yAxis: ["murder_victims"],
    };
  }

  const sql = `WITH targets(city, ori, start_year, end_year) AS (VALUES ${values}), annual_coverage(city, annual_shr_victims, validated_zero, coverage_status, coverage_caveat, months_with_records) AS (VALUES ${annualCoverageValues}), counts AS (SELECT t.city, COUNT(v.id) AS murder_victims FROM targets t JOIN incidents i ON i.ori = t.ori AND i.year BETWEEN t.start_year AND t.end_year JOIN victims v ON v.incident_id = i.id WHERE i.homicide_type = 'Murder' AND i.year = ${year} AND i.month BETWEEN 1 AND ${endMonth} GROUP BY t.city) SELECT ac.city, CASE WHEN COALESCE(c.murder_victims, 0) > 0 THEN c.murder_victims WHEN ac.annual_shr_victims > 0 OR ac.validated_zero = 1 THEN 0 ELSE NULL END AS murder_victims, ac.months_with_records AS shr_recorded_months, ac.coverage_status AS shr_status, ac.coverage_caveat AS shr_coverage_caveat FROM annual_coverage ac LEFT JOIN counts c ON c.city = ac.city ORDER BY ac.city LIMIT 1000`;
  return {
    kind: "query", sql,
    title: `Murder Victims, ${period}`,
    explanation: `Murder victim counts reported in SHR for ${placeList}, ${period}. Every requested city is retained and positive SHR victim records are always shown. Zero-victim values appear as zero only when annual evidence supports a valid zero; gaps and unknown coverage remain blank with a disclosure. One incident can have multiple victims, so this counts victim records rather than incidents.`,
    columns: ["city", "murder_victims", "shr_recorded_months", "shr_status", "shr_coverage_caveat"], chartType: "bar", xAxis: "city", yAxis: ["murder_victims"],
  };
}
