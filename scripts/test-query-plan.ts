import assert from "node:assert/strict";
import { buildQueryPlan } from "../lib/query-plan";

function chipValue(question: string, key: string, source: "auto" | "current" | "historical" | "nibrs" | "shr" | "hate_crime" = "auto", active: "current" | "historical" | "nibrs" | "shr" | "hate_crime" | null = null) {
  const plan = buildQueryPlan(question, source, active);
  assert.ok(plan, `${question} should produce a plan`);
  return plan.chips.find((chip) => chip.key === key);
}

{
  const source = chipValue("homicide rate from 1960 to present", "source");
  assert.equal(source?.value, "Historical Library");
  assert.equal(chipValue("homicide rate from 1960 to present", "time")?.value, "1960-present");
  assert.equal(chipValue("homicide rate from 1960 to present", "unit")?.value, "Per 100k");
}

{
  const plan = buildQueryPlan("shootings in Kansas City");
  assert.equal(plan?.blocking, true);
  assert.equal(plan?.chips.find((chip) => chip.key === "source")?.value, "Needs metric");
  assert.equal(plan?.chips.find((chip) => chip.key === "place")?.value, "Needs choice");
  assert.equal(plan?.chips.find((chip) => chip.key === "place")?.status, "blocking");
  assert.equal(plan?.chips.find((chip) => chip.key === "metric")?.value, "Needs choice");
  assert.equal(plan?.chips.some((chip) => chip.key === "unit"), false);
}

{
  const plan = buildQueryPlan("shootings in San Francisco");
  assert.equal(plan?.blocking, true);
  assert.equal(plan?.chips.find((chip) => chip.key === "source")?.value, "Needs metric");
  assert.equal(plan?.chips.find((chip) => chip.key === "place")?.value, "San Francisco");
  assert.equal(plan?.chips.find((chip) => chip.key === "metric")?.value, "Needs choice");
}

{
  const plan = buildQueryPlan("crime in Dallas since 2020");
  assert.equal(plan?.blocking, false);
  assert.equal(plan?.chips.find((chip) => chip.key === "source")?.status, "advisory");
  assert.equal(plan?.chips.find((chip) => chip.key === "metric")?.value, "Needs choice");
}

{
  const plan = buildQueryPlan("thefts in Dallas since 2020");
  assert.equal(plan?.blocking, false);
  assert.equal(plan?.chips.find((chip) => chip.key === "source")?.value, "Needs metric");
  assert.equal(plan?.chips.find((chip) => chip.key === "metric")?.value, "Needs choice");
  assert.equal(plan?.chips.some((chip) => chip.key === "unit"), false);
}

{
  assert.equal(
    chipValue("violent crime in Dallas", "source")?.value,
    "Historical Library / Current Trends",
    "medium-confidence source fits should show the close alternative"
  );
  assert.equal(
    chipValue("violent crime in Dallas since 2020", "source")?.value,
    "Current Trends / Historical Library",
    "recent violent-crime asks should show Current first but acknowledge Historical also fits"
  );
}

{
  assert.equal(
    chipValue("murders per year", "source")?.value,
    "Historical Library / Homicide Reports",
    "plain annual homicide counts should not suggest NIBRS before SHR/Current"
  );
  assert.equal(
    chipValue("murders per year since 2020", "source")?.value,
    "Historical Library / Current Trends",
    "recent annual homicide counts should keep Current as the close alternative"
  );
}

{
  const metric = chipValue("homicide rates for gender and race", "metric");
  assert.equal(metric?.value, "Unsupported rate");
  assert.equal(metric?.status, "advisory");
}

{
  const source = chipValue("same for murder", "source", "auto", "nibrs");
  assert.equal(source?.value, "NIBRS");
}

console.log("query plan tests passed");
