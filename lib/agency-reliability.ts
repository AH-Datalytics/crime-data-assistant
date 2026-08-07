import type Database from "better-sqlite3";

/**
 * Shared agency-year reliability evaluation.
 *
 * ONE implementation, two consumers: the scorecard's year-selection loop
 * (lib/agency-scorecard.ts) and the agency_year_reliability table builder
 * (scripts/build-agency-year-reliability.ts). Codex's review of the first design
 * identified duplicated logic as the biggest risk -- the table and the scorecard
 * would drift the next time someone tunes a threshold -- so the DECISION functions
 * here are pure and both consumers call them. The scorecard loads its inputs with
 * the same per-question SQL it always used; the builder bulk-loads for speed. The
 * SQL differs, the judgment cannot.
 *
 * Why any of this exists: the FBI file can be wrong rather than stale. Louisville
 * submitted 19 murders for 2025 against ~150 in each recent year, and no upstream
 * refresh will ever correct it. Two independent checks:
 *
 *   own-history      -- the year against the same agency's prior-3-year median.
 *                       Works for every agency; the only check that can see Augusta
 *                       or Chicago.
 *   rtci-crosscheck  -- the annual row against RTCI's twelve monthly submissions.
 *                       Only the ~700 RTCI agencies, and murder is judged against the
 *                       agency's OWN usual annual/monthly ratio, because some
 *                       agencies (Los Angeles at 0.57-0.66, stably, for years) simply
 *                       count murder differently from their monthly feed.
 *
 * Finding kinds, which the disclosure layer treats differently:
 *   partial-year     -- every column fell together: the agency reported only part of
 *                       the year. Any crime measure for that year is affected.
 *   systemic         -- several columns low at once against RTCI (Baton Rouge 2024,
 *                       all seven at 16-35%). Treated like partial-year.
 *   column-collapse  -- one column implausible while the rest hold (Louisville's
 *                       murder). ONLY the flagged columns are affected; the stored
 *                       violent/property totals do not inherit the warning.
 */

export type ReliabilityKind = "partial-year" | "systemic" | "column-collapse";
export type ReliabilitySource = "own-history" | "rtci-crosscheck";

export type ReliabilityEvidence = {
  column: string;
  /** The suspect year's value. */
  current: number;
  /** What it was judged against: the own-history median, or the RTCI monthly total. */
  reference: number;
  ratio: number;
};

export type ReliabilityFinding = {
  kind: ReliabilityKind;
  source: ReliabilitySource;
  /** Offense column keys affected ('murder', 'assault', ...). */
  columns: string[];
  evidence: ReliabilityEvidence[];
};

/**
 * Bump when thresholds or decision logic change, so table rows built under an old
 * algorithm are distinguishable from a data change.
 */
export const RELIABILITY_ALGORITHM_VERSION = "1.0.0-2026-08-06";

/** The seven offence columns of historical_agency_crime, with their RTCI labels. */
export const RELIABILITY_OFFENSES: { offense: string; column: string; label: string }[] = [
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
export const MURDER_RATIO_LOOKBACK_YEARS = 4;

export const HISTORY_SEVERE_RATIO = 0.35;
export const HISTORY_LOW_RATIO = 0.6;
export const HISTORY_MIN_BASELINE = 10;
export const HISTORY_LOOKBACK_YEARS = 3;
/** Minimum non-NULL prior observations OF THE SAME OFFENCE before a baseline is trusted. */
export const HISTORY_MIN_OBSERVATIONS = 2;

/**
 * Conventional median: the average of the two middle values for an even count.
 *
 * Taking the upper of the two instead biases every even-length baseline upward, which
 * makes the current year look worse than it is and rejects years that should stand.
 * With a three-year lookback an even count is the common case, not an edge case.
 */
export function baselineMedian(values: (number | null)[]): number | null {
  const sorted = values.filter((value): value is number => value != null).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * PURE own-history decision: the year's row against prior rows of the same agency.
 *
 * Baselines are per offence over non-NULL priors only -- counting rows instead let a
 * single stray observation stand in for a baseline. Partial year: all but at most one
 * compared column low together. Collapse: any column below the severe ratio.
 */
export function evaluateOwnHistory(
  row: Record<string, number | null>,
  priors: Record<string, number | null>[]
): ReliabilityFinding[] {
  if (priors.length === 0) return [];
  const compared: ReliabilityEvidence[] = [];
  for (const check of RELIABILITY_OFFENSES) {
    const observations = priors
      .map((prior) => prior[check.column])
      .filter((value): value is number => value != null);
    if (observations.length < HISTORY_MIN_OBSERVATIONS) continue;
    const baseline = baselineMedian(observations);
    const current = row[check.column];
    if (baseline == null || baseline < HISTORY_MIN_BASELINE || current == null) continue;
    compared.push({ column: check.column, current, reference: baseline, ratio: current / baseline });
  }
  if (compared.length < 4) return [];

  const low = compared.filter((entry) => entry.ratio < HISTORY_LOW_RATIO);
  const severe = compared.filter((entry) => entry.ratio < HISTORY_SEVERE_RATIO);

  if (compared.length >= 5 && low.length >= compared.length - 1) {
    return [{ kind: "partial-year", source: "own-history", columns: low.map((e) => e.column), evidence: low }];
  }
  if (severe.length > 0) {
    return [{ kind: "column-collapse", source: "own-history", columns: severe.map((e) => e.column), evidence: severe }];
  }
  return [];
}

/**
 * PURE RTCI cross-check decision: the annual row against the agency's 12-month RTCI
 * totals for the same year, plus the agency's own prior annual/monthly murder ratios.
 *
 * `monthlyByOffense` is keyed by the RTCI offense label ("Murder", "Theft", ...) and
 * must contain ONLY full 12-month years -- the loaders enforce that.
 */
export function evaluateRtciCrosscheck(
  row: Record<string, number | null>,
  monthlyByOffense: Map<string, number>,
  priorMurderRatios: number[]
): ReliabilityFinding[] {
  if (monthlyByOffense.size === 0) return [];
  const low: ReliabilityEvidence[] = [];
  const severe: ReliabilityEvidence[] = [];
  let murderCollapse: ReliabilityEvidence | null = null;
  for (const check of RELIABILITY_OFFENSES) {
    const reported = monthlyByOffense.get(check.offense);
    const annual = row[check.column];
    if (reported == null || annual == null || reported < RTCI_CROSSCHECK_MIN_COUNT) continue;
    const ratio = annual / reported;
    if (ratio >= RTCI_CROSSCHECK_MIN_RATIO) continue;
    const evidence: ReliabilityEvidence = { column: check.column, current: annual, reference: reported, ratio };
    low.push(evidence);
    if (ratio < RTCI_CROSSCHECK_SEVERE_RATIO) severe.push(evidence);
    if (check.column === "murder" && priorMurderRatios.length >= HISTORY_MIN_OBSERVATIONS) {
      const usual = baselineMedian(priorMurderRatios);
      if (usual != null && ratio < usual * MURDER_RATIO_COLLAPSE_FACTOR) murderCollapse = evidence;
    }
  }

  const findings: ReliabilityFinding[] = [];
  if (low.length >= RTCI_CROSSCHECK_SYSTEMIC_COLUMNS) {
    findings.push({ kind: "systemic", source: "rtci-crosscheck", columns: low.map((e) => e.column), evidence: low });
  } else {
    // Not systemic: report the individually damning columns only.
    const collapsed = [...severe];
    if (murderCollapse && !collapsed.some((e) => e.column === "murder")) collapsed.push(murderCollapse);
    if (collapsed.length > 0) {
      findings.push({ kind: "column-collapse", source: "rtci-crosscheck", columns: collapsed.map((e) => e.column), evidence: collapsed });
    }
  }
  return findings;
}

/** Human-readable one-liners for diagnostics (never user-facing). */
export function describeFindings(findings: ReliabilityFinding[]): string[] {
  const label = new Map(RELIABILITY_OFFENSES.map((o) => [o.column, o.label]));
  return findings.flatMap((finding) =>
    finding.evidence.map((e) =>
      `${label.get(e.column) ?? e.column} ${e.current} against ${finding.source === "own-history" ? `a baseline of ${e.reference}` : `${e.reference} reported monthly`}`
    )
  );
}

// ---------------------------------------------------------------------------------
// DB loaders. The scorecard evaluates one agency-year per call with the same SQL it
// has always used; the table builder bulk-loads instead (see the build script).
// ---------------------------------------------------------------------------------

export function loadOwnHistoryPriors(
  db: Database.Database,
  where: string,
  year: number
): Record<string, number | null>[] {
  try {
    return db.prepare(`
      SELECT hac.murder, hac.rape, hac.robbery, hac.assault, hac.burglary, hac.theft, hac.motor_vehicle_theft
      FROM historical_agency_crime hac
      JOIN historical_agency ha ON ha.ori = hac.ori
      WHERE ${where} AND hac.year BETWEEN ${year - HISTORY_LOOKBACK_YEARS} AND ${year - 1}
    `).all() as Record<string, number | null>[];
  } catch {
    return [];
  }
}

export function loadRtciMonthly(
  db: Database.Database,
  state: string,
  rtciAgency: string,
  year: number,
  rtciType: "City" | "County" = "City"
): Map<string, number> {
  try {
    const monthly = db.prepare(`
      SELECT am.offense AS offense, SUM(am.count) AS n, COUNT(DISTINCT am.month) AS months
      FROM agency_monthly am
      JOIN agencies a ON a.ori = am.ori
      WHERE a.agency = ? AND upper(a.state) = ? AND a.type = ? AND am.year = ?
      GROUP BY am.offense
      HAVING months = 12
    `).all(rtciAgency, state.toUpperCase(), rtciType, year) as { offense: string; n: number }[];
    return new Map(monthly.map((m) => [m.offense, m.n]));
  } catch {
    // No RTCI coverage is not evidence of a problem -- most agencies in the
    // historical file are not in RTCI at all. Fail open.
    return new Map();
  }
}

/**
 * This agency's own recent history of annual-vs-monthly murder agreement, as ratios.
 * The absolute ratio says nothing on its own -- a stable 60% is a counting convention,
 * while a fall from 100% to 18% is a broken figure.
 */
export function loadMurderRatioHistory(
  db: Database.Database,
  where: string,
  state: string,
  rtciAgency: string,
  year: number,
  rtciType: "City" | "County" = "City"
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
      WHERE a.agency = ? AND upper(a.state) = ? AND a.type = ? AND lower(am.offense) = 'murder'
        AND am.year BETWEEN ? AND ?
      GROUP BY am.year
      HAVING months = 12
    `).all(rtciAgency, state.toUpperCase(), rtciType, year - MURDER_RATIO_LOOKBACK_YEARS, year - 1) as
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

/** One agency-year, loaded and judged -- the scorecard's per-question entry point. */
export function evaluateAgencyYearFromDb(
  db: Database.Database,
  args: {
    where: string; state: string; rtciAgency: string; year: number;
    row: Record<string, number | null>;
    /** County agencies check against RTCI County rows, never a same-named city. */
    rtciType?: "City" | "County";
  }
): ReliabilityFinding[] {
  const rtciType = args.rtciType ?? "City";
  return [
    ...evaluateRtciCrosscheck(
      args.row,
      loadRtciMonthly(db, args.state, args.rtciAgency, args.year, rtciType),
      loadMurderRatioHistory(db, args.where, args.state, args.rtciAgency, args.year, rtciType)
    ),
    ...evaluateOwnHistory(args.row, loadOwnHistoryPriors(db, args.where, args.year)),
  ];
}
