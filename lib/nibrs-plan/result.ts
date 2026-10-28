/**
 * The result envelope and provenance every NIBRS answer carries (restructure plan, design point 9). The COMPILER
 * fills it, never the model. Caches are keyed by `cacheKey`, which includes every version that can change an answer.
 */
import type { AbsolutePeriod, NibrsPlan } from "./plan";

export type CellStatus =
  | "VALUE"                     // a number, from known months
  | "REPORTED_ZERO"             // 0 from an evidenced zero report
  | "UNKNOWN"                   // no evidence for the agency-month
  | "NOT_REPORTED"              // evidence the agency did not submit
  | "UNKNOWN_UNEVIDENCED_ZERO"  // no rows for this filtered measure in a month not evidenced complete (D6)
  | "UNAVAILABLE";              // a rate, share or ratio that cannot be computed; `reason` says why

export type Cell = {
  value: number | null;
  status: CellStatus;
  reason?: string;
  /** Shares and ratios: the parts. */
  numerator?: number | null;
  denominator?: number | null;
  /** Rates: observed count over all reporting agencies, the eligible cohort's count, and its covered population. */
  observedCount?: number | null;
  eligibleCount?: number | null;
  coveredPopulation?: number | null;
  /** Rates: a fixed label when the numerator is filtered but the population is all residents (case S5). */
  populationLabel?: string;
};

export type ResultEnvelope = {
  plan: NibrsPlan;
  planDigest: string;
  versions: {
    planLanguage: string;
    semantic: string;
    canonicalRelease: string;      // canonical release_id
    canonicalManifestSha256: string;
    servingArtifact: string;       // NIBRSAI artifact id (accelerators included)
    compiler: string;              // NIBRSAI commit
  };
  /** The interpretation as resolved against the release: what the answer actually covers. */
  resolved: {
    period: AbsolutePeriod | { kind: "years"; years: number[] };
    comparisons: { earlier: AbsolutePeriod; later: AbsolutePeriod }[];
    places: { place: NibrsPlan["geography"]["places"][number]; agencies: number }[];
    combinedAgencies?: { total: number; deduplicated: number };
    defaults: NibrsPlan["defaults"];
    nationalLabel: "reported NIBRS counts" | null;
  };
  compiled: { sql: string; sha256: string; accelerator: string | null };
  /** For each statistic: its denominator and the cohort rule that selected agencies. */
  denominators: { statistic: string; rule: string; cohort: string; agencies: number }[];
  transformations: string[];
  /** Rows dropped by a rank limit, or cells withheld, with the count. Nothing is truncated silently. */
  truncation: { what: string; count: number }[];
  /** Fixed statements the answer must carry, e.g. property not attributed to one offense (N2). No other notes. */
  requiredStatements: string[];
  rows: Record<string, string | number | Cell | null>[];
  cacheKey: string;
};
