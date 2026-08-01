export type ShrComparisonStatus =
  | "pre2021_matched"
  | "pre2021_gap_candidate"
  | "pre2021_true_zero_candidate"
  | "post2020_transition_review"
  | "reta_unreported"
  | "join_unresolved";

export type ShrDisplayStatus = "count" | "validated_zero" | "gap" | "coverage_unknown";

export type ShrAnnualCoverageInput = {
  retaMurders: number | null;
  shrVictims: number;
  comparisonStatus: ShrComparisonStatus;
  joinMethod: string;
};

export type ShrAnnualCoverageDecision = {
  normalizedComparisonStatus: ShrComparisonStatus;
  displayValue: number | null;
  displayStatus: ShrDisplayStatus;
  caveatCode: string | null;
  comparisonConflict: boolean;
  presentationChanged: boolean;
};

function positiveCountCaveat(status: ShrComparisonStatus): string | null {
  if (status === "post2020_transition_review") return "post2020_coverage_maturing";
  if (status === "reta_unreported") return "return_a_unavailable";
  if (status === "join_unresolved") return "identity_uncertainty";
  return null;
}

export function classifyShrAnnualCoverage(input: ShrAnnualCoverageInput): ShrAnnualCoverageDecision {
  const shrVictims = Math.max(0, Number(input.shrVictims || 0));
  const retaMurders = input.retaMurders != null && Number(input.retaMurders) >= 0
    ? Number(input.retaMurders)
    : null;
  const comparisonConflict = retaMurders != null && retaMurders !== shrVictims;

  // Victim-level SHR evidence always wins. Comparison metadata can qualify the
  // count, but it must never hide records that actually exist.
  if (shrVictims > 0) {
    return {
      normalizedComparisonStatus: input.comparisonStatus,
      displayValue: shrVictims,
      displayStatus: "count",
      caveatCode: positiveCountCaveat(input.comparisonStatus),
      comparisonConflict,
      presentationChanged: false,
    };
  }

  // Exhaustively repair legacy zero-victim matched rows using Return A.
  let status = input.comparisonStatus;
  if (status === "pre2021_matched") {
    status = retaMurders === 0
      ? "pre2021_true_zero_candidate"
      : retaMurders != null && retaMurders > 0
        ? "pre2021_gap_candidate"
        : "reta_unreported";
  }

  if (status === "pre2021_true_zero_candidate") {
    return {
      normalizedComparisonStatus: status,
      displayValue: 0,
      displayStatus: "validated_zero",
      caveatCode: null,
      comparisonConflict,
      presentationChanged: false,
    };
  }
  if (status === "pre2021_gap_candidate") {
    return {
      normalizedComparisonStatus: status,
      displayValue: null,
      displayStatus: "gap",
      caveatCode: "return_a_positive_shr_gap",
      comparisonConflict,
      presentationChanged: true,
    };
  }
  return {
    normalizedComparisonStatus: status,
    displayValue: null,
    displayStatus: "coverage_unknown",
    caveatCode: status === "join_unresolved" ? "identity_uncertainty" : "coverage_unknown",
    comparisonConflict,
    presentationChanged: true,
  };
}

export function shrCoverageCaveat(code: string | null): string | null {
  if (code === "post2020_coverage_maturing") return "SHR coverage from 2021 onward is still maturing; the victim count shown is present in SHR but may be incomplete.";
  if (code === "return_a_unavailable") return "The SHR victim count is present, but no annual Return A comparison is available.";
  if (code === "identity_uncertainty") return "SHR victim records are present, but the annual Return A agency identity join is unresolved.";
  if (code === "return_a_positive_shr_gap") return "Return A reports murders for this agency-year, but SHR has no murder victims; the missing SHR value is not shown as zero.";
  if (code === "coverage_unknown") return "SHR has no murder victims for this agency-year and annual comparison evidence cannot validate a true zero.";
  return null;
}

type ComparisonRow = {
  reta_murders: number | null;
  shr_victims: number;
  join_method: string;
  comparison_status: ShrComparisonStatus;
};

export type LoadedShrAnnualCoverage = ShrAnnualCoverageDecision & {
  shrVictims: number;
  monthsWithRecords: number;
};

export function loadShrAnnualCoverage(
  db: Database.Database,
  oris: string[],
  state: string,
  year: number,
): LoadedShrAnnualCoverage {
  const uniqueOris = [...new Set(oris)];
  if (uniqueOris.length === 0) {
    const decision = classifyShrAnnualCoverage({
      retaMurders: null, shrVictims: 0, comparisonStatus: "reta_unreported", joinMethod: "unmatched",
    });
    return { ...decision, shrVictims: 0, monthsWithRecords: 0 };
  }
  const placeholders = uniqueOris.map(() => "?").join(",");
  const tableExists = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shr_return_a_comparison'"
  ).get());
  const rows = tableExists
    ? db.prepare(`SELECT reta_murders, shr_victims, join_method, comparison_status
        FROM shr_return_a_comparison
        WHERE upper(state) = ? AND year = ? AND shr_ori IN (${placeholders})`)
      .all(state.toUpperCase(), year, ...uniqueOris) as ComparisonRow[]
    : [];
  const shrVictims = rows.reduce((sum, row) => sum + Number(row.shr_victims || 0), 0);
  const retaMurders = rows.length > 0 && rows.every((row) => row.reta_murders != null && Number(row.reta_murders) >= 0)
    ? rows.reduce((sum, row) => sum + Number(row.reta_murders), 0)
    : null;
  const comparisonStatus: ShrComparisonStatus = rows.some((row) => row.comparison_status === "join_unresolved")
    ? "join_unresolved"
    : rows.some((row) => row.comparison_status === "post2020_transition_review")
      ? "post2020_transition_review"
      : rows.some((row) => row.comparison_status === "pre2021_gap_candidate")
        ? "pre2021_gap_candidate"
        : rows.some((row) => row.comparison_status === "pre2021_true_zero_candidate") && shrVictims === 0
          ? "pre2021_true_zero_candidate"
          : rows.some((row) => row.comparison_status === "pre2021_matched")
            ? "pre2021_matched"
            : "reta_unreported";
  const joinMethod = rows.some((row) => row.join_method === "ambiguous" || row.join_method === "unmatched")
    ? "unresolved"
    : rows[0]?.join_method || "unmatched";
  const months = db.prepare(`SELECT COUNT(DISTINCT month) AS n
      FROM incidents WHERE year = ? AND ori IN (${placeholders})`)
    .get(year, ...uniqueOris) as { n: number } | undefined;
  const decision = classifyShrAnnualCoverage({ retaMurders, shrVictims, comparisonStatus, joinMethod });
  return { ...decision, shrVictims, monthsWithRecords: Number(months?.n || 0) };
}
import type Database from "better-sqlite3";
