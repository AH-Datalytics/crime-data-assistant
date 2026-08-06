import type Database from "better-sqlite3";
import { resolveGeoPlaces } from "./geo-place-resolver";
import { consolidatedDisplayName, historicalAgencyTarget, consolidatedRtciAgency } from "./agency-consolidations";
import { detectAgencyScorecardQuestion } from "./scorecard-format";

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

/**
 * RTCI's `agency_monthly` is a second, independent count of the same seven offences
 * for ~700 large agencies, in the same database. Where it has a full twelve months for
 * a year, it is a usable check on the historical annual row.
 *
 * The two feeds are NOT expected to match exactly -- coverage and counting differ, and
 * across 1,818 comparable agency-years they routinely sit within 10-20% of each other.
 * The threshold is therefore deliberately loose: it is there to catch a column that has
 * collapsed (Louisville 2025 murder at 18% of the monthly total), not to police normal
 * disagreement. A minimum count keeps small-number noise out of it.
 */
const RTCI_CROSSCHECK_OFFENSES: { offense: string; column: string; label: string }[] = [
  { offense: "Murder", column: "murder", label: "murder" },
  { offense: "Rape", column: "rape", label: "rape" },
  { offense: "Robbery", column: "robbery", label: "robbery" },
  { offense: "Aggravated Assault", column: "assault", label: "aggravated assault" },
  { offense: "Burglary", column: "burglary", label: "burglary" },
  { offense: "Theft", column: "theft", label: "theft" },
  { offense: "Motor Vehicle Theft", column: "motor_vehicle_theft", label: "motor vehicle theft" },
];
/**
 * A single column dipping below this is NOT evidence of a bad year. Agencies differ
 * from RTCI systematically: Baton Rouge's annual figures run 70-90% of its monthly
 * submissions across the board, and individual categories wander to ~53% without the
 * year being wrong. Judging one column in isolation threw away Baton Rouge 2023, a
 * perfectly good year, over robbery at 54%.
 */
export const RTCI_CROSSCHECK_MIN_RATIO = 0.6;
/** A single column this far below the monthly count is a collapse, not disagreement. */
export const RTCI_CROSSCHECK_SEVERE_RATIO = 0.35;
/** How many columns must be low before the year is treated as systemically wrong. */
export const RTCI_CROSSCHECK_SYSTEMIC_COLUMNS = 3;
export const RTCI_CROSSCHECK_MIN_COUNT = 10;
/** A murder ratio below this fraction of the agency's OWN usual ratio is a collapse. */
export const MURDER_RATIO_COLLAPSE_FACTOR = 0.5;
/** Years of prior annual-vs-monthly agreement to draw the murder baseline from. */
const MURDER_RATIO_LOOKBACK_YEARS = 4;

function contradictedOffenses(
  db: Database.Database,
  where: string,
  state: string,
  rtciAgency: string,
  year: number,
  row: Record<string, number | null>
): string[] {
  let monthly: { offense: string; n: number }[];
  try {
    monthly = db.prepare(`
      SELECT am.offense AS offense, SUM(am.count) AS n, COUNT(DISTINCT am.month) AS months
      FROM agency_monthly am
      JOIN agencies a ON a.ori = am.ori
      WHERE a.agency = ? AND upper(a.state) = ? AND am.year = ?
      GROUP BY am.offense
      HAVING months = 12
    `).all(rtciAgency, state.toUpperCase(), year) as { offense: string; n: number }[];
  } catch {
    // No RTCI coverage available is not evidence of a problem -- most agencies in the
    // historical file are not in RTCI at all. Fail open.
    return [];
  }
  if (monthly.length === 0) return [];
  const byOffense = new Map(monthly.map((m) => [m.offense, m.n]));
  const low: string[] = [];
  let severe = false;
  let murderCollapsed = false;
  for (const check of RTCI_CROSSCHECK_OFFENSES) {
    const reported = byOffense.get(check.offense);
    const annual = row[check.column];
    if (reported == null || annual == null || reported < RTCI_CROSSCHECK_MIN_COUNT) continue;
    const ratio = annual / reported;
    if (ratio >= RTCI_CROSSCHECK_MIN_RATIO) continue;
    low.push(`${check.label} ${annual} against ${reported} reported monthly`);
    if (ratio < RTCI_CROSSCHECK_SEVERE_RATIO) severe = true;
    if (check.column === "murder") {
      // A low murder ratio is only evidence of a bad year if it is low BY THIS AGENCY'S
      // STANDARDS. Some agencies simply count murder differently from their monthly
      // submissions, stably, for years: Los Angeles sits at 57-66% and San Diego shows a
      // similar persistent gap. Treating any sub-60% ratio as an error rejected their
      // newest year every time and walked the card back to 2023 or 2024 for no reason.
      // What actually identifies Louisville is the CHANGE -- about 100% in each recent
      // year, then 18% -- so compare against the agency's own prior agreement instead.
      const priorRatios = murderRatioHistory(db, where, state, rtciAgency, year);
      if (priorRatios.length >= HISTORY_MIN_OBSERVATIONS) {
        const usual = baselineMedian(priorRatios);
        if (usual != null && ratio < usual * MURDER_RATIO_COLLAPSE_FACTOR) murderCollapsed = true;
      }
    }
  }
  // Reject the year only when the disagreement is an absolute collapse (any column far
  // below its monthly count), systemic (several columns low at once, as in Baton Rouge
  // 2024 where all seven fell to 16-35%), or a murder figure that has broken away from
  // this agency's own long-running level of agreement. One middling column is left alone.
  const rejected = severe || murderCollapsed || low.length >= RTCI_CROSSCHECK_SYSTEMIC_COLUMNS;
  return rejected ? low : [];
}

/**
 * This agency's own recent history of annual-vs-monthly murder agreement, as ratios.
 *
 * The absolute ratio says nothing on its own -- a stable 60% is a counting convention,
 * while a fall from 100% to 18% is a broken figure. Only the agency's own track record
 * separates the two.
 */
function murderRatioHistory(
  db: Database.Database,
  where: string,
  state: string,
  rtciAgency: string,
  year: number
): number[] {
  try {
    const annual = db.prepare(`
      SELECT hac.year AS year, hac.murder AS murder
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ${where} AND hac.year BETWEEN ${year - MURDER_RATIO_LOOKBACK_YEARS} AND ${year - 1}
    `).all() as { year: number; murder: number | null }[];
    const monthly = db.prepare(`
      SELECT am.year AS year, SUM(am.count) AS n, COUNT(DISTINCT am.month) AS months
      FROM agency_monthly am
      JOIN agencies a ON a.ori = am.ori
      WHERE a.agency = ? AND upper(a.state) = ? AND lower(am.offense) = 'murder'
        AND am.year BETWEEN ? AND ?
      GROUP BY am.year
      HAVING months = 12
    `).all(rtciAgency, state.toUpperCase(), year - MURDER_RATIO_LOOKBACK_YEARS, year - 1) as
      { year: number; n: number }[];
    const reportedByYear = new Map(monthly.map((entry) => [entry.year, entry.n]));
    const ratios: number[] = [];
    for (const entry of annual) {
      const reported = reportedByYear.get(entry.year);
      if (entry.murder == null || reported == null || reported < RTCI_CROSSCHECK_MIN_COUNT) continue;
      ratios.push(entry.murder / reported);
    }
    return ratios;
  } catch {
    return [];
  }
}

/**
 * Second, independent reliability check: an agency-year against the SAME AGENCY's own
 * recent history.
 *
 * This exists because the RTCI cross-check above only covers the ~700 agencies RTCI
 * carries. Sweeping every city agency against its own prior-3-year median found 954
 * suspect agency-years across 2024-2025, and RTCI could not see most of them --
 * including Chicago 2025 (aggravated assault 2,503 against a baseline of 15,789),
 * Savannah 2024 (every column at 13% of its own history), and Augusta 2025 (roughly a
 * quarter of a normal year). No curated list is involved: the baseline is derived from
 * the data each time, so it cannot go stale when the data is rebuilt.
 *
 * Two different failures, deliberately reported separately:
 *   - PARTIAL YEAR  -- every column falls together, the signature of an agency that
 *     submitted only some months. The whole year is unusable.
 *   - COLUMN COLLAPSE -- one column implausible while the others hold, the signature of
 *     a single bad figure (Louisville's 19 murders). The scorecard still rejects the year,
 *     because that figure is displayed on its own row and would be read as fact. Note
 *     that `violent` and `property` are STORED FBI TOTALS, not sums we compute, so a bad
 *     murder figure does not necessarily corrupt the violent total -- the year is rejected
 *     because the murder row itself is unreliable, not because the total must be wrong.
 *
 * These are candidates, not proven errors -- genuine steep declines happen. Hence the
 * deliberately severe threshold and the minimum baseline: this must not fire on the
 * ordinary year-to-year movement that makes up most of the data.
 */
const HISTORY_SEVERE_RATIO = 0.35;
const HISTORY_LOW_RATIO = 0.6;
const HISTORY_MIN_BASELINE = 10;
const HISTORY_LOOKBACK_YEARS = 3;
/** Minimum non-NULL prior observations OF THE SAME OFFENCE before a baseline is trusted. */
const HISTORY_MIN_OBSERVATIONS = 2;

/**
 * Conventional median: the average of the two middle values for an even count.
 *
 * Taking the upper of the two instead biases every even-length baseline upward, which
 * makes the current year look worse than it is and rejects years that should stand. With
 * a three-year lookback an even count is the common case, not an edge case -- an agency
 * with exactly two prior observations gets its baseline from precisely this branch.
 */
export function baselineMedian(values: (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function implausibleAgainstHistory(
  db: Database.Database,
  where: string,
  year: number,
  row: Record<string, number | null>
): string[] {
  let priors: Record<string, number | null>[];
  try {
    priors = db.prepare(`
      SELECT hac.murder, hac.rape, hac.robbery, hac.assault, hac.burglary, hac.theft, hac.motor_vehicle_theft
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ${where} AND hac.year BETWEEN ${year - HISTORY_LOOKBACK_YEARS} AND ${year - 1}
    `).all() as Record<string, number | null>[];
  } catch {
    return [];
  }
  if (priors.length === 0) return [];

  const compared: { column: string; ratio: number; current: number; baseline: number }[] = [];
  for (const check of RTCI_CROSSCHECK_OFFENSES) {
    // The two-observation minimum is PER OFFENCE, not per row. Counting rows let a
    // column with a single non-NULL prior value form a baseline off that one number,
    // which is not a baseline at all -- and NULL columns are common in this file, so
    // "three prior rows" routinely means one usable observation for some offences.
    const observations = priors
      .map((prior) => prior[check.column])
      .filter((value): value is number => value != null);
    if (observations.length < HISTORY_MIN_OBSERVATIONS) continue;
    const baseline = baselineMedian(observations);
    const current = row[check.column];
    if (baseline == null || baseline < HISTORY_MIN_BASELINE || current == null) continue;
    compared.push({ column: check.label, ratio: current / baseline, current, baseline });
  }
  if (compared.length < 4) return [];

  const low = compared.filter((entry) => entry.ratio < HISTORY_LOW_RATIO);
  const severe = compared.filter((entry) => entry.ratio < HISTORY_SEVERE_RATIO);
  const describe = (list: typeof compared) =>
    list.map((entry) => `${entry.column} ${entry.current} against a baseline of ${entry.baseline}`);

  // Partial year: all but at most one column down together.
  if (compared.length >= 5 && low.length >= compared.length - 1) {
    const average = compared.reduce((sum, entry) => sum + entry.ratio, 0) / compared.length;
    return [`every column at about ${Math.round(average * 100)}% of this agency's own baseline`, ...describe(low)];
  }
  if (severe.length > 0) return describe(severe);
  return [];
}

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
  // Merged agencies are filed under their post-merger name and type, while the
  // pre-merger ORI lingers with NULL crime rows and a frozen population -- matching
  // the typed name would silently answer from a dead agency (Louisville: 2003).
  // `agency` stays the friendly alias so every tab labels the place identically;
  // only the SQL target changes. Several survivors are type 'county', not 'city'.
  const agency = consolidatedDisplayName(candidate.state, candidate.name);
  const state = candidate.state!.toLowerCase();
  const target = historicalAgencyTarget(candidate.state, candidate.name);
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
    const suspect = [
      ...contradictedOffenses(db, where, state, rtciAgency, candidateYear, row),
      ...implausibleAgainstHistory(db, where, candidateYear, row),
    ];
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
  return {
    title: `${label} Scorecard (${year})`,
    explanation: `${label} crime scorecard for the most recent year with complete crime, population, and clearance data: ${year}.${substituted}${disclosure}`,
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
