import assert from "node:assert/strict";
import { buildHistoricalCityChangeRankingPlan } from "../lib/historical-deterministic-queries";

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

console.log("historical deterministic query tests passed");
