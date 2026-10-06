import assert from "node:assert/strict";
import { buildHistoricalCityChangeRankingPlan, buildHistoricalLocalRecentChangePlan } from "../lib/historical-deterministic-queries";
import { buildHistoricalNationalViolentCountPlan, NATIONAL_VIOLENT_COUNT_GUARDRAIL } from "../lib/historical-national-violent";
import { historicalViolentComposite } from "../lib/historical-composite-measure";

{
  const plan = buildHistoricalLocalRecentChangePlan(
    "How has violent crime changed in the last year in Washington D.C.?",
    2025
  );
  assert.ok(plan?.sql, "single-city recent change should be handled deterministically");
  assert.match(plan.sql, /ha\.agency = 'Washington'/);
  assert.match(plan.sql, /UPPER\(ha\.state\) = 'DC'/);
  assert.match(plan.sql, /hac\.year IN \(2024, 2025\)/);
  assert.match(plan.sql, /hac\.violent/);
  assert.doesNotMatch(plan.sql, /historical_state_national/);
  assert.deepEqual(plan.columns, ["city", "violent_2024", "violent_2025", "numeric_change", "percent_change"]);
}

assert.equal(
  buildHistoricalLocalRecentChangePlan("How has violent crime changed in Texas in the last year?", 2025),
  null,
  "state questions must remain outside the local city builder"
);

{
  const plan = buildHistoricalCityChangeRankingPlan(
    "which city had the steepest decline in total violent crime?",
    []
  );
  assert.ok(plan, "broad city decline ranking should be handled deterministically");
  assert.equal(plan.sql, null, "underspecified city decline ranking should ask for a comparison period");
  assert.match(plan.explanation, /comparison period/i);
  assert.match(plan.explanation, /from 2015 to 2024/i);
}

{
  const plan = buildHistoricalCityChangeRankingPlan(
    "from 2015 to 2024",
    [
      { role: "user", content: "which city had the steepest decline in total violent crime?", source: "historical" },
      { role: "assistant", content: "I need a comparison period.", source: "historical" },
      { role: "user", content: "percentage decline", source: "historical" },
    ]
  );
  assert.ok(plan?.sql, "year-range follow-up should inherit the city decline ranking context");
  assert.match(plan.sql, /hac\.year IN \(2015, 2024\)/);
  assert.match(plan.sql, /LOWER\(ha\.type\) = 'city'/i);
  assert.match(plan.sql, /ha\.agency = 'Louisville'/);
  assert.match(plan.sql, /ha\.ori <> 'KY0568000'/);
  assert.match(plan.sql, /pct_change < 0/);
  assert.match(plan.sql, /ORDER BY pct_change ASC/);
  assert.doesNotMatch(plan.explanation, /Alabama/i);
  assert.deepEqual(plan.columns, ["city", "violent_2015", "violent_2024", "pct_change"]);
}

{
  const plan = buildHistoricalCityChangeRankingPlan(
    "these cities are too small, need large cities",
    [
      { role: "user", content: "which city had the steepest decline in total violent crime?", source: "historical" },
      { role: "assistant", content: "I need a comparison period.", source: "historical" },
      { role: "user", content: "from 2015 to 2024", source: "historical" },
      { role: "assistant", content: "Cities with the steepest percentage decline in total violent crime from 2015 to 2024.", source: "historical" },
    ]
  );
  assert.ok(plan?.sql, "large-cities follow-up should inherit the prior comparison period");
  assert.match(plan.sql, /historical_agency_population/);
  assert.match(plan.sql, /population_end >= 250000/);
  assert.match(plan.explanation, /at least 250,000/);
  assert.deepEqual(plan.columns, ["city", "violent_2015", "violent_2024", "pct_change", "population_end"]);
}

{
  const plan = buildHistoricalCityChangeRankingPlan("murders in Houston since 2010", []);
  assert.equal(plan, null, "single-city trend queries should remain model-routed");
}

// National violent-crime batch (Codex :36558): the U.S. annual violent-crime COUNT series is owned, from the national
// table, for any wording and period form; everything else keeps its route.
{
  const NAT = (bounds: string) => `SELECT year, murder + rape + robbery + aggravated_assault AS violent_crime FROM historical_state_national WHERE state = 'United States'${bounds} ORDER BY year`;
  for (const [q, bounds] of [
    ["NATIONWIDE VIOLENT CRIME FROM 1930-PRESENT", " AND year >= 1930"],     // the failed release-f D1, verbatim
    ["U.S. violent crime by year since 1990", " AND year >= 1990"],
    ["national violent crime 2000 to 2020", " AND year BETWEEN 2000 AND 2020"],
    ["How many violent crimes were there in the United States each year from 1960 to 2024?", " AND year BETWEEN 1960 AND 2024"],
    ["nationwide violent crime", ""],
  ] as [string, string][]) {
    const plan = buildHistoricalNationalViolentCountPlan(q);
    assert.equal(plan?.sql, NAT(bounds), q);
    assert.equal(plan?.guardrail, NATIONAL_VIOLENT_COUNT_GUARDRAIL);
    assert.doesNotMatch(plan!.sql!, /historical_agency_crime|COALESCE|IFNULL/, "national table only; no zero-filled components");
    // The owned composite description binds to exactly this SQL.
    assert.equal(historicalViolentComposite("historical", plan!.sql, [{ year: 2000, violent_crime: 1 }])?.narrative,
      "U.S. national violent crime by year: the sum of the FBI UCR murder, rape, robbery and aggravated assault counts.", q);
  }
  // Not this family: rate, place, cohort, other or extra offense, ranking, comparison, share, change, filter.
  for (const q of [
    "violent crime rate nationally since 1960", "U.S. violent crime rate per 100,000 since 1990", "violent crime in Texas since 2000",
    "violent crime in Chicago since 2000", "national murders 2010 to 2020", "national violent crime and property crime since 2000",
    "violent crime by state since 2000", "which states had the highest violent crime in 2020", "compare national violent crime with Texas since 2000",
    "share of national violent crime that was robbery since 2000", "change in national violent crime from 2019 to 2020",
    "national violent crime excluding rape since 2000", "violent crime across reporting agencies nationally since 1990",
  ]) assert.equal(buildHistoricalNationalViolentCountPlan(q), null, q);

  // Correction F1/F2 (Codex :36622): the whole request and its period are recognized before ownership.
  // Codex's four counterexamples and their neighbors keep their meaning (left for the existing route):
  for (const q of [
    "national violent crime by year before 2000", "national violent crime by year over the past 5 years",
    "national violent crime in 2000 and 2020", "national violent crime by year involving knives since 2000",
    "national violent crime after 2000", "national violent crime in the last 10 years", "national violent crime in 2000, 2010 and 2020",
    "national violent crime by year since 2000 for juveniles", "national violent crime by year since 2000 in all states",
    "national violent crime by year from 2020 to 2000",
  ]) assert.equal(buildHistoricalNationalViolentCountPlan(q), null, q);
  // ...while the supported forms are owned with exactly the stated period.
  for (const [q, bounds] of [
    ["national violent crime in 2020", " AND year BETWEEN 2020 AND 2020"],
    ["U.S. violent crime between 1990 and 2000", " AND year BETWEEN 1990 AND 2000"],
    ["nationwide violent crime 1990-present", " AND year >= 1990"],
    ["national violent crime from 2000 to 2020", " AND year BETWEEN 2000 AND 2020"],
    ["Show me violent crime in the United States since 1975 to the present", " AND year >= 1975"],
    ["national violent crime from 1995 through 2005", " AND year BETWEEN 1995 AND 2005"],
  ] as [string, string][]) assert.equal(buildHistoricalNationalViolentCountPlan(q)?.sql, NAT(bounds), q);
}

console.log("historical deterministic query tests passed");
