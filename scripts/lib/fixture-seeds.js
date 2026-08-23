/**
 * Named seed profiles for the fixture databases.
 *
 * A profile is `{databaseName: {tableName: [rowObject, ...]}}`. Columns come from each row's own keys,
 * so a profile cannot silently drift from the committed DDL: a wrong column name is an immediate
 * SQLite error, not a row that lands somewhere unexpected.
 *
 * WHY PROFILES ARE NAMED AND SHARED, AND WHY THEY ARE STILL NOT A GLOBAL RULE. Several tests need the
 * same shape of data, so a shared profile avoids 40 near-identical seed blocks. But sufficiency is
 * declared PER TEST in the tier manifest, not here: two tests can share `state_index_baseline` while
 * demanding different things of it, and the manifest's `requires` is what decides whether this profile
 * is enough for that test. A profile says what exists; `requires` says what must be true.
 *
 * `empty` is not listed here. It is the absence of a profile -- schema only -- and it is a legitimate
 * choice for a test whose subject IS missing data.
 *
 * WHAT IS AND IS NOT IN HERE. Only profiles some manifest entry actually names. A profile nothing
 * references is dead seed data that still has to be maintained, so `test-harness-contract.js` fails
 * the run if one appears.
 */
"use strict";

/**
 * Two agencies in two states, two years, with populations -- the minimum that makes an indexed rate
 * series computable and its baseline year meaningful.
 *
 * Sized from the SQL the test actually runs, not guessed. `buildCurrentIndexedStatePlan` produces a
 * CTE chain over `agency_monthly` JOIN `sample_agencies` LEFT JOIN `agency_population`, filtered to
 * `offense IN ('Aggravated Assault')` and `year >= 2017`, then indexes each state's rate to the
 * baseline year. So the seed needs: agencies present in `sample_agencies` (an inner join -- an agency
 * missing there contributes nothing), monthly counts for at least two years, and NON-NULL populations,
 * because the series CTE filters `population IS NOT NULL` and divides by its sum.
 *
 * Only two of the eleven requested states are seeded, deliberately. The test's final loop is
 * `if (base[column] !== null) assert.equal(base[column], 100, column)`, so the nine unseeded states
 * are NULL and skipped -- which is the real behaviour -- while Alabama, Texas and the national series
 * are non-null and must equal 100 at the baseline. The manifest's `requires` is what guarantees at
 * least one of them is non-null; without that clause an all-NULL fixture would pass this test while
 * evaluating no equality at all.
 */
const STATE_INDEX_BASELINE = (() => {
  const agencies = [
    { ori: "AL0010000", agency: "BIRMINGHAM", state: "AL", type: "City" },
    { ori: "TX0010000", agency: "AUSTIN", state: "TX", type: "City" },
  ];
  const years = [2017, 2018];
  const monthly = [];
  const population = [];
  for (const agency of agencies) {
    for (const year of years) {
      monthly.push({
        ori: agency.ori, agency: agency.agency, state: agency.state, type: agency.type,
        year, month: 1, offense: "Aggravated Assault",
        // A different count per year so the indexed series is not flat by accident: a seed where
        // every year matched would make "the baseline equals 100" true for an uninteresting reason.
        count: year === 2017 ? 400 : 440,
      });
      population.push({ ori: agency.ori, year, population: 500000 });
    }
  }
  return { rtci: { sample_agencies: agencies, agency_monthly: monthly, agency_population: population } };
})();

/**
 * The same agencies and monthly counts, with the population table left EMPTY.
 *
 * Used only by `test-harness-preflight-mutations.js`. It is the strongest bad fixture actually
 * reachable for the worked example: `agency_population.population` is declared NOT NULL, so a NULL
 * cannot be seeded directly -- the nulls in that test arise from a LEFT JOIN finding no population
 * row. With this profile the plan's series CTE filters every row out at `population IS NOT NULL`, and
 * the test fails deep inside its own assertions with an opaque message.
 *
 * That is what the `non_null` requires clause converts into a precise preflight failure naming the
 * missing precondition. Profiles prefixed `mutation_` exist to prove a check works and are exempt
 * from the "no unreferenced profile" rule for that reason.
 */
const MUTATION_MONTHLY_WITHOUT_POPULATION = {
  rtci: {
    sample_agencies: STATE_INDEX_BASELINE.rtci.sample_agencies,
    agency_monthly: STATE_INDEX_BASELINE.rtci.agency_monthly,
  },
};

const SEED_PROFILES = {
  state_index_baseline: STATE_INDEX_BASELINE,
  mutation_monthly_without_population: MUTATION_MONTHLY_WITHOUT_POPULATION,
};

module.exports = { SEED_PROFILES };
