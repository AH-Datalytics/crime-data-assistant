import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { consolidatedDisplayName, historicalAgencyTarget } from "./agency-consolidations";

export const SCORECARD_COLUMNS = ["offense", "offenses", "rate_per_100k", "clearance_rate", "offense_change_pct"] as const;

const OFFENSES = [
  { key: "violent", label: "Violent Crime", crime: "violent", clearance: "violent_clr", section: true },
  { key: "murder", label: "Murder", crime: "murder", clearance: "murder_clr" },
  { key: "rape", label: "Rape", crime: "rape", clearance: "rape_clr" },
  { key: "robbery", label: "Robbery", crime: "robbery", clearance: "robbery_clr" },
  { key: "assault", label: "Aggravated Assault", crime: "assault", clearance: "assault_clr" },
  { key: "property", label: "Property Crime", crime: "property", clearance: "property_clr", section: true },
  { key: "burglary", label: "Burglary", crime: "burglary", clearance: "burglary_clr" },
  { key: "theft", label: "Theft", crime: "theft", clearance: "theft_clr" },
  { key: "motor_vehicle_theft", label: "Motor Vehicle Theft", crime: "motor_vehicle_theft", clearance: "motor_vehicle_theft_clr" },
] as const;

const STATE_NAMES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho",
  IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana",
  ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey",
  NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington",
  WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia",
};

export type AgencyScorecardRow = {
  offense: string;
  offenses: number | null;
  rate_per_100k: number | null;
  clearance_rate: number | null;
  offense_change_pct: number | null;
  section?: boolean;
};

export type AgencyScorecardResult = {
  title: string;
  explanation: string;
  columns: string[];
  rows: AgencyScorecardRow[];
  year: number | null;
  sql: string | null;
  population: number;
  agencyLabel: string;
};

export function detectAgencyScorecardQuestion(question: string): boolean {
  return /\b(?:crime\s+)?scorecard\b/i.test(question);
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function unavailableScorecard(title: string, explanation: string, agencyLabel = ""): AgencyScorecardResult {
  return {
    title, explanation, columns: [...SCORECARD_COLUMNS], rows: [],
    year: null, sql: null, population: 0, agencyLabel,
  };
}

export function buildAgencyScorecard(db: Database.Database, question: string): AgencyScorecardResult | null {
  if (!detectAgencyScorecardQuestion(question)) return null;
  const mentions = resolveGeoPlaces(question).mentions;
  if (mentions.some((mention) => mention.requiresClarification)) {
    return unavailableScorecard("Agency Scorecard Needs Clarification", "I need one unambiguous city agency for a scorecard. Please provide a city and state.");
  }
  const candidates = mentions.flatMap((mention) => mention.candidates)
    .filter((candidate) => candidate.kind === "city" && candidate.state);
  if (candidates.length !== 1) {
    return unavailableScorecard("Agency Scorecard Needs Clarification", "I need one specific city agency for a scorecard. Please provide a city and state, and specify the city agency rather than a county or state-wide geography.");
  }

  const candidate = candidates[0];
  const agency = consolidatedDisplayName(candidate.state, candidate.name);
  const state = candidate.state!.toLowerCase();
  const target = historicalAgencyTarget(candidate.state, candidate.name);
  const where = target.ori
    ? `ha.ori = ${sqlQuote(target.ori)}`
    : `ha.agency = ${sqlQuote(target.agency)} AND ha.state = ${sqlQuote(state)} AND ha.type = ${sqlQuote(target.type)}`;
  const complete = db.prepare(`
    SELECT MAX(hac.year) AS year
    FROM historical_agency_crime hac
    JOIN historical_agency_clearance hcl ON hcl.ori = hac.ori AND hcl.year = hac.year
    JOIN historical_agency_population hp ON hp.ori = hac.ori AND hp.year = hac.year
    JOIN historical_agency ha ON ha.ori = hac.ori
    WHERE ${where} AND hp.population > 0
      AND hac.violent IS NOT NULL AND hac.murder IS NOT NULL AND hac.rape IS NOT NULL
      AND hac.robbery IS NOT NULL AND hac.assault IS NOT NULL AND hac.property IS NOT NULL
      AND hac.burglary IS NOT NULL AND hac.theft IS NOT NULL AND hac.motor_vehicle_theft IS NOT NULL
      AND hcl.violent_clr IS NOT NULL AND hcl.murder_clr IS NOT NULL AND hcl.rape_clr IS NOT NULL
      AND hcl.robbery_clr IS NOT NULL AND hcl.assault_clr IS NOT NULL AND hcl.property_clr IS NOT NULL
      AND hcl.burglary_clr IS NOT NULL AND hcl.theft_clr IS NOT NULL AND hcl.motor_vehicle_theft_clr IS NOT NULL
  `).get() as { year: number | null };
  const stateName = STATE_NAMES[candidate.state!.toUpperCase()] ?? candidate.state;
  if (!complete.year) return unavailableScorecard(`${agency}, ${stateName} Scorecard`, `${agency}, ${stateName} does not have one recent year with complete crime, population, and clearance data for every scorecard row. No scorecard was substituted from an older or different source.`, `${agency}, ${stateName}`);

  const year = complete.year;
  const sql = `SELECT hac.year, hp.population, hac.violent, hac.murder, hac.rape, hac.robbery, hac.assault, hac.property, hac.burglary, hac.theft, hac.motor_vehicle_theft, hcl.violent_clr, hcl.murder_clr, hcl.rape_clr, hcl.robbery_clr, hcl.assault_clr, hcl.property_clr, hcl.burglary_clr, hcl.theft_clr, hcl.motor_vehicle_theft_clr FROM historical_agency_crime hac JOIN historical_agency_clearance hcl ON hcl.ori = hac.ori AND hcl.year = hac.year JOIN historical_agency_population hp ON hp.ori = hac.ori AND hp.year = hac.year JOIN historical_agency ha ON ha.ori = hac.ori WHERE ${where} AND hac.year = ${year} AND hp.population > 0 LIMIT 1`;
  const data = db.prepare(sql).get() as Record<string, number | null> | undefined;
  if (!data || data.population == null || data.population <= 0) return unavailableScorecard(`${agency}, ${stateName} Scorecard`, `${agency}, ${stateName} has no valid population denominator for its latest complete scorecard year.`, `${agency}, ${stateName}`);
  const population = data.population;
  const previousSql = `SELECT hac.violent, hac.murder, hac.rape, hac.robbery, hac.assault, hac.property, hac.burglary, hac.theft, hac.motor_vehicle_theft FROM historical_agency_crime hac JOIN historical_agency ha ON ha.ori = hac.ori WHERE ${where} AND hac.year = ${year - 1} LIMIT 1`;
  const previous = db.prepare(previousSql).get() as Record<string, number | null> | undefined;
  const rows: AgencyScorecardRow[] = [];
  let hasOver100Clearance = false;
  for (const offense of OFFENSES) {
    const count = data[offense.crime] ?? null;
    const isSection = "section" in offense && offense.section === true;
    const clearance = data[offense.clearance] ?? null;
    const previousCount = previous?.[offense.crime] ?? null;
    if (clearance != null && clearance > 100) hasOver100Clearance = true;
    rows.push({
      offense: offense.label,
      offenses: count,
      rate_per_100k: count == null ? null : Math.round((count * 100000 / population) * 10) / 10,
      clearance_rate: clearance,
      offense_change_pct: count != null && previousCount != null && previousCount > 0
        ? Math.round(((count - previousCount) * 100 / previousCount) * 10) / 10
        : null,
      ...(isSection ? { section: true } : {}),
    });
  }
  const disclosure = hasOver100Clearance ? " Some clearance rates exceed 100% because the FBI can clear cases in the current year that originated in prior reporting years." : "";
  return {
    title: `${agency}, ${stateName} Scorecard (${year})`,
    explanation: `${agency}, ${stateName} crime scorecard for the most recent year with complete crime, population, and clearance data: ${year}.${disclosure}`,
    columns: [...SCORECARD_COLUMNS],
    rows,
    year,
    sql,
    population,
    agencyLabel: `${agency}, ${stateName}`,
  };
}
