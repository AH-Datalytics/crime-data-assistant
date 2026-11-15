/**
 * The current year's population (Jeff 2026-11-14): "the fbi sets current year population as the most recent completed
 * year until the current year is formally reported". A year with no population of its own takes the latest completed
 * year's, only when it is the year right after it (2026 now); 2027 and later stay outside the data. The year's own
 * figure always wins, so the day a new completed year is published it replaces the carried one. Silent: no note.
 * `lastYear` is the latest completed year the data holds, read from the data and never written here as a number.
 */
export const carriesTo = (year: number, lastYear: number): boolean => year === lastYear + 1;

/** The population for `year`: its own, else (only for the year after `lastYear`) the figure of `lastYear`. */
export function carriedPopulation(own: (year: number) => number | null, year: number, lastYear: number): number | null {
  const mine = own(year);
  if (mine !== null) return mine;
  return carriesTo(year, lastYear) ? own(lastYear) : null;
}
