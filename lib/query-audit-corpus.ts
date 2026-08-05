/**
 * Calibration corpus of real production query_log rows.
 *
 * IMPORTANT — how the must-not-flag list was built, and its one known trap:
 * those 12 rate rows were verified correct **for the population fan-out class**
 * during the 2026-08-04 audit. "Clean for one defect class" is not "clean
 * overall". Row 3133 was listed as must-not-flag on that basis and D2 flagged
 * it; on inspection D2 was right — its narrative reads "national murder rates
 * excluding cities in the dataset City data" when the question asked about
 * excluding NYPD. That is the same place-garbling defect as 7772/7773, from
 * 2026-06-02, before Fix 1 (b558d3e) shipped. The corpus was wrong, not the
 * detector, so 3133 moved to must-flag.
 *
 * When adding a must-not-flag row, verify it against every defect class the
 * detectors cover, not just the one that prompted its review.
 */
export const AUDIT_MUST_FLAG: Record<number, string[]> = {
  7881: ["D1"],
  7772: ["D2"], 7773: ["D2"], 3133: ["D2"],
  7845: ["D3"], 2305: ["D3"],
  // 4570 narrates "Violent crime definitions and per capita rates for Chicago
  // and Houston from 1932 to 2025" while its SQL is `year BETWEEN 1991 AND
  // 2025` — the stated range overstates coverage by roughly sixty years.
  4570: ["D4"],
  7780: ["D6"],
  7855: ["D7"], 7900: ["D7"],
  // 7770 delivered 67 rows carrying an unsuffixed contract-year-lower-bound-
  // missing tag, i.e. the answer shipped with an unresolved contract violation.
  // (Investigation of the same shape on 7783 showed the tag was inherited from
  // a superseded attempt — which is exactly the kind of thing D8 should surface.)
  7770: ["D8"],
  1413: ["D5"], 5524: ["D5"], 7518: ["D5"], 7463: ["D5"],
  2849: ["D5"], 2822: ["D5"], 2031: ["D5"], 1939: ["D5"],
};

/**
 * Verification provenance for every must-not-flag row.
 *
 * `verifiedAgainst` records WHICH defect classes a row was actually checked
 * against. A row is only trustworthy as a negative for those classes. This
 * exists because 3133 was listed as clean on the strength of a fan-out-only
 * review, then turned out to carry a place-garbling defect — see the note above.
 */
export type CleanRowProvenance = {
  /** Defect classes this row was explicitly verified against. */
  verifiedAgainst: string[];
  note: string;
};

export const AUDIT_CLEAN_PROVENANCE: Record<number, CleanRowProvenance> = {
  3736: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense — correct denominator." },
  3234: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  2872: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  2591: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  2535: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  2534: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  2533: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  1937: { verifiedAgainst: ["rate-fanout", "grain-mismatch"], note: "Windowed monthly series described by period; grain claim is legitimate." },
  1936: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  1935: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  1934: { verifiedAgainst: ["rate-fanout"], note: "Monthly grain, single offense." },
  7920: { verifiedAgainst: ["qualifier-drop", "shooting-path"], note: "Plain fatal-shootings control, verified live post-8137655." },
  7915: { verifiedAgainst: ["place-mismatch", "rate-fanout"], note: "Chicago violent crime control, verified live." },
  4228: { verifiedAgainst: ["year-range"], note: "States 2000-2025 matching its SQL; mentions 2026 only in an incompleteness caveat." },
  5915: { verifiedAgainst: ["year-range"], note: "States 2021-2025 matching its SQL; mentions 2026 only in a population-denominator note." },
  7902: { verifiedAgainst: ["contract-tag", "rate-fanout"], note: "Contract tag carries the -resolved-on-retry suffix, so the delivered answer is not in violation." },
};

export const AUDIT_MUST_NOT_FLAG = Object.keys(AUDIT_CLEAN_PROVENANCE).map(Number);

/**
 * Detectors with no corpus coverage. Calibration reports these as
 * `unvalidated` rather than passing, because zero flagged rows is
 * indistinguishable from a detector that cannot fire at all — which is exactly
 * how D6 looked while its reference data was missing.
 */
export const AUDIT_UNVALIDATED_DETECTORS: string[] = [];

export const AUDIT_CORPUS_IDS = [
  ...Object.keys(AUDIT_MUST_FLAG).map(Number),
  ...AUDIT_MUST_NOT_FLAG,
];
