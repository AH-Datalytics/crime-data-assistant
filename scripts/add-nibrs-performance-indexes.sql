-- Performance indexes for common NIBRS summary queries.
-- Safe to rerun after imports or summary-table rebuilds.

CREATE INDEX IF NOT EXISTS idx_sad_offense_state_year
  ON summary_arrestee_demographics(ucr_arrest_offense, state, year);

CREATE INDEX IF NOT EXISTS idx_agencies_year_state_population
  ON agencies(year, state, population);
