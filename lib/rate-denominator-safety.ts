const POPULATION_COLUMNS = /(?:^|_)(?:population|total_pop|sample_pop|reporting_population)$/i;

/**
 * Detect a denominator that is implausibly larger than the current RTCI
 * sample. This is deliberately a result-level backstop for SQL shapes that
 * structural fan-out checks do not recognize.
 */
export function implausiblePopulationDenominator(
  rows: Record<string, unknown>[],
  chartPopulation: number | null | undefined,
  latestSamplePopulation: number | null | undefined,
): boolean {
  if (!latestSamplePopulation || latestSamplePopulation <= 0) return false;
  const ceiling = latestSamplePopulation * 2;
  const candidates: number[] = [];
  if (typeof chartPopulation === "number" && Number.isFinite(chartPopulation)) {
    candidates.push(chartPopulation);
  }
  for (const row of rows) {
    for (const [column, value] of Object.entries(row)) {
      if (POPULATION_COLUMNS.test(column) && typeof value === "number" && Number.isFinite(value)) {
        candidates.push(value);
      }
    }
  }
  return candidates.some((value) => value > ceiling);
}

/** Used by tests and monitoring to make the dynamic threshold explicit. */
export function populationDenominatorCeiling(latestSamplePopulation: number): number {
  return latestSamplePopulation * 2;
}