import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { consolidatedDisplayName, historicalAgencyTarget, consolidatedRtciAgency } from "./agency-consolidations";
import { detectAgencyScorecardQuestion } from "./scorecard-format";
import { evaluateAgencyYearFromDb, describeFindings } from "./agency-reliability";

export const SCORECARD_COLUMNS = ["offense", "offenses", "rate_per_100k", "clearance_rate", "offense_change_pct"] as const;

/**
 * How far behind the newest year in the data a scorecard year may be before the card
 * is refused rather than shown. Three years absorbs the normal UCR publication lag
 * (2025 data while 2026 is in progress) without licensing a card from 1985.
 */
export const STALE_SCORECARD_YEARS = 3;

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

export type ScorecardScope = "agency" | "state" | "national";

export type AgencyScorecardTarget = {
  agency: string;
  state: string;
  type: "city" | "county";
};

export const COUNTY_AGENCY_SCORECARD_NOTE =
  "This scorecard reflects the lead county agency's FBI-reported data, not a countywide total of all law enforcement agencies.";

/**
 * Shared result contract for every Historical scorecard scope. The UI reads the
 * structured fields (scope, yearStatus, statusText, showClearance) rather than parsing
 * prose out of `explanation`, which stays in the contract for logging and for the
 * unavailable-card body text.
 *
 * `agencyLabel` is the display label for ANY scope -- "Toledo, OH", "Ohio",
 * "United States". The name is kept for wire compatibility: the route, the client
 * reconstruction in WorkspaceChatV2, and the wiring tests all address the field by
 * this name, and renaming it would break old client bundles against new servers.
 */
export type AgencyScorecardResult = {
  title: string;
  explanation: string;
  columns: string[];
  rows: AgencyScorecardRow[];
  year: number | null;
  sql: string | null;
  agencyLabel: string;
  scope: ScorecardScope;
  /** "latest" when the newest usable year is shown; "fallback" when a newer year was rejected. */
  yearStatus: "latest" | "fallback";
  /** Compact line for under the card title, e.g. "2024 · Latest reliable year · 2025 may be incomplete". */
  statusText: string;
  /** The newer year that was rejected as possibly incomplete, when yearStatus is "fallback". */
  newerExcludedYear: number | null;
  /** Agency cards carry clearance; state and national cards must not render the column at all. */
  showClearance: boolean;
};

// Defined in scorecard-format.ts (which has no dependencies) so the client can route
// scorecard questions without pulling the geo place catalog into the browser bundle.
// Re-exported here because this is where callers expect to find it.
export { detectAgencyScorecardQuestion };

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Reliability thresholds and decision logic live in lib/agency-reliability.ts,
// SHARED with the agency_year_reliability table builder so the scorecard and the
// table cannot drift apart when a threshold is tuned -- that duplication was the
// biggest risk Codex flagged in the disclosure design review. baselineMedian is
// re-exported because tests import it from here.
export { baselineMedian } from "./agency-reliability";

export function unavailableScorecard(
  title: string,
  explanation: string,
  agencyLabel = "",
  scope: ScorecardScope = "agency"
): AgencyScorecardResult {
  return {
    title, explanation, columns: [...SCORECARD_COLUMNS], rows: [],
    year: null, sql: null, agencyLabel,
    scope, yearStatus: "latest", statusText: "", newerExcludedYear: null, showClearance: scope === "agency",
  };
}

export function buildAgencyScorecard(
  db: Database.Database,
  question: string,
  explicitTarget?: AgencyScorecardTarget,
): AgencyScorecardResult | null {
  if (!detectAgencyScorecardQuestion(question)) return null;
  const mentions = resolveGeoPlaces(question).mentions;
  if (!explicitTarget && mentions.some((mention) => mention.requiresClarification)) {
    return unavailableScorecard("Agency Scorecard Needs Clarification", "I need one unambiguous city agency for a scorecard. Please provide a city and state.");
  }
  const candidates = mentions.flatMap((mention) => mention.candidates)
    .filter((candidate) => candidate.kind === "city" && candidate.state);
  if (!explicitTarget && candidates.length !== 1) {
    return unavailableScorecard("Agency Scorecard Needs Clarification", "I need one specific city agency for a scorecard. Please provide a city and state, and specify the city agency rather than a county or state-wide geography.");
  }

  const candidate = explicitTarget
    ? { name: explicitTarget.agency, state: explicitTarget.state, kind: explicitTarget.type }
    : candidates[0];
  // Merged agencies are filed under their post-merger name and type, while the
  // pre-merger ORI lingers with NULL crime rows and a frozen population -- matching
  // the typed name would silently answer from a dead agency (Louisville: 2003).
  // `agency` stays the friendly alias so every tab labels the place identically;
  // only the SQL target changes. Several survivors are type 'county', not 'city'.
  const agency = consolidatedDisplayName(candidate.state, candidate.name);
  const state = candidate.state!.toLowerCase();
  const target = historicalAgencyTarget(candidate.state, candidate.name, explicitTarget?.type ?? "city");
  const where = target.ori
    ? `ha.ori = ${sqlQuote(target.ori)}`
    : `ha.agency = ${sqlQuote(target.agency)} AND ha.state = ${sqlQuote(state)} AND ha.type = ${sqlQuote(target.type)}`;
  const completeYears = (db.prepare(`
    SELECT hac.year AS year
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
    ORDER BY hac.year DESC
  `).all() as { year: number }[]).map((row) => row.year);
  // The abbreviation is used everywhere -- heading and prose alike -- so one place is
  // never spelled "Kentucky" while another says "KY".
  const stateAbbr = candidate.state!.toUpperCase();
  const label = `${agency}, ${stateAbbr}`;
  const newestCompleteYear = completeYears[0] ?? null;
  if (newestCompleteYear == null) return unavailableScorecard(`${label} Scorecard`, `${label} does not have one recent year with complete crime, population, and clearance data for every scorecard row. No scorecard was substituted from an older or different source.`, label);

  // A scorecard is read as a statement about the agency NOW. Without this guard the
  // builder happily reaches back as far as the data allows to find a year where all
  // eighteen crime and clearance columns are populated -- Kankakee resolved to 1985
  // and Hartsville to 2001 -- and presents it with no signal that it is decades old.
  // Refusing is the honest answer: the alternative is a card that looks current and
  // is not. The year is named so the user can ask for it deliberately if they want it.
  const datasetMax = (db.prepare("SELECT MAX(year) AS year FROM historical_agency_crime").get() as { year: number | null }).year;
  if (datasetMax != null && newestCompleteYear < datasetMax - STALE_SCORECARD_YEARS) {
    return unavailableScorecard(
      `${label} Scorecard`,
      `${label} has no recent year with complete crime, population, and clearance data. Its most recent complete year is ${newestCompleteYear}, which is too far behind ${datasetMax} to present as a current scorecard. Ask for ${newestCompleteYear} directly if you want that year.`,
      label
    );
  }

  // The historical file can carry one badly wrong column in an otherwise sane row.
  // Louisville's 2025 row reports 19 murders against 147 the year before, while RTCI's
  // twelve monthly submissions for the same agency and year total 108. `violent` and
  // `property` are stored FBI totals rather than sums computed here, so the totals are
  // not necessarily wrong -- but the murder figure gets its own row on the card and
  // would be read as fact. Publishing an older, self-consistent year is better than
  // publishing a current one with a figure we can show is unreliable, so candidate years
  // are checked newest first and the first one that survives is used.
  const rtciAgency = consolidatedRtciAgency(candidate.state, candidate.name);
  const rowSql = (forYear: number) => `SELECT hac.year, hp.population, hac.violent, hac.murder, hac.rape, hac.robbery, hac.assault, hac.property, hac.burglary, hac.theft, hac.motor_vehicle_theft, hcl.violent_clr, hcl.murder_clr, hcl.rape_clr, hcl.robbery_clr, hcl.assault_clr, hcl.property_clr, hcl.burglary_clr, hcl.theft_clr, hcl.motor_vehicle_theft_clr FROM historical_agency_crime hac JOIN historical_agency_clearance hcl ON hcl.ori = hac.ori AND hcl.year = hac.year JOIN historical_agency_population hp ON hp.ori = hac.ori AND hp.year = hac.year JOIN historical_agency ha ON ha.ori = hac.ori WHERE ${where} AND hac.year = ${forYear} AND hp.population > 0 LIMIT 1`;

  let year: number | null = null;
  let data: Record<string, number | null> | undefined;
  // `detail` records which offences disagreed and by how much. It is deliberately kept
  // OUT of the user-facing text: naming an agency's own submission as wrong is a claim
  // we should not make in passing, and the specific figures invite a debate the answer
  // cannot settle. "May be incomplete" is the honest, sufficient statement. The detail
  // stays here for diagnosis.
  let firstRejection: { year: number; detail: string[] } | null = null;
  for (const candidateYear of completeYears) {
    if (datasetMax != null && candidateYear < datasetMax - STALE_SCORECARD_YEARS) break;
    const row = db.prepare(rowSql(candidateYear)).get() as Record<string, number | null> | undefined;
    if (!row || row.population == null || row.population <= 0) continue;
    // Two independent checks: against RTCI's monthly submissions (large agencies only)
    // and against the agency's own recent history (every agency). Either one is enough
    // to disqualify the year.
    const suspect = describeFindings(
      evaluateAgencyYearFromDb(db, { where, state, rtciAgency, year: candidateYear, row, rtciType: target.type === "county" ? "County" : "City" })
    );
    if (suspect.length > 0) {
      if (!firstRejection) firstRejection = { year: candidateYear, detail: suspect };
      continue;
    }
    year = candidateYear;
    data = row;
    break;
  }

  if (year == null || !data || data.population == null) {
    return unavailableScorecard(
      `${label} Scorecard`,
      firstRejection
        ? `${label} data may be incomplete for ${firstRejection.year}, and there is no earlier year of known complete data recent enough to show instead.`
        : `${label} has no valid population denominator for its latest complete scorecard year.`,
      label
    );
  }
  const sql = rowSql(year);
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
  // "Fallback" means a newer COMPLETE year existed and was rejected by a reliability
  // check. A newest year that is merely absent from completeYears (columns missing) is
  // ordinary publication lag, not a fallback -- the status line should not cast doubt
  // on a year this builder never considered usable in the first place.
  const isFallback = newestCompleteYear != null && year < newestCompleteYear;
  const newerExcludedYear = isFallback ? newestCompleteYear : null;
  const statusText = isFallback
    ? `${year} · Latest reliable year · ${newerExcludedYear} may be incomplete`
    : `${year} · Latest reliable year`;
  const substituted = isFallback
    ? ` ${newestCompleteYear} data may be incomplete, so this is the most recent year of known complete data.`
    : "";
  const disclosure = hasOver100Clearance ? " Some clearance rates exceed 100% because the FBI can clear cases in the current year that originated in prior reporting years." : "";
  const countyDisclosure = target.type === "county" ? ` ${COUNTY_AGENCY_SCORECARD_NOTE}` : "";
  return {
    title: target.type === "county" ? `${label} County Scorecard (${year})` : `${label} Scorecard (${year})`,
    explanation: `${label} crime scorecard for the most recent year with complete crime, population, and clearance data: ${year}.${substituted}${disclosure}${countyDisclosure}`,
    columns: [...SCORECARD_COLUMNS],
    rows,
    year,
    sql,
    agencyLabel: label,
    scope: "agency",
    yearStatus: isFallback ? "fallback" : "latest",
    statusText,
    newerExcludedYear,
    showClearance: true,
  };
}
