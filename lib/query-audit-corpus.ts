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
  7780: ["D6"],
  7855: ["D7"], 7900: ["D7"],
  1413: ["D5"], 5524: ["D5"], 7518: ["D5"], 7463: ["D5"],
  2849: ["D5"], 2822: ["D5"], 2031: ["D5"], 1939: ["D5"],
};

export const AUDIT_MUST_NOT_FLAG = [
  3736, 3234, 2872, 2591, 2535, 2534, 2533,
  1937, 1936, 1935, 1934, 7920, 7915,
];

export const AUDIT_CORPUS_IDS = [
  ...Object.keys(AUDIT_MUST_FLAG).map(Number),
  ...AUDIT_MUST_NOT_FLAG,
];
