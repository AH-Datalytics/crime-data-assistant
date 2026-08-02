import assert from "node:assert/strict";
import { earliestReturnedYear, ensureExplanationOffenseLabel } from "../lib/explain";
import { extractQueryContext } from "../lib/query-context";

{
  const rows = [
    { year: "2025", city: "Austin" },
    { year: "2024", city: "Austin" },
    { year: "2023", city: "Austin" },
    { year: "2022", city: "Austin" },
  ];
  assert.equal(earliestReturnedYear(rows), 2022);
}

{
  const rows = [
    { year: 2025, city: "Austin" },
  ];
  assert.equal(earliestReturnedYear(rows), 2025);
}

{
  const rows = [
    { data_year: "2024", city: "Austin" },
    { data_year: "2022", city: "Austin" },
  ];
  assert.equal(earliestReturnedYear(rows), 2022);
}

{
  assert.equal(earliestReturnedYear([{ city: "Austin" }]), null);
}

{
  const ctx = extractQueryContext(
    "SELECT year, SUM(count) AS houston FROM agency_monthly WHERE offense = 'Murder' GROUP BY year",
    "Add 2020 and 2021",
    "current",
  );
  assert.deepEqual(ctx.offenses, ["murder"]);
  assert.equal(
    ensureExplanationOffenseLabel("Crime data for Houston and Dallas for 2020 and 2021.", ["murder"]),
    "Murder data for Houston and Dallas for 2020 and 2021.",
  );
  assert.equal(
    ensureExplanationOffenseLabel("Annual homicide counts for Houston.", ["murder"]),
    "Annual homicide counts for Houston.",
  );
  assert.equal(
    ensureExplanationOffenseLabel("Annual totals for Houston.", ["murder"]),
    "Murder — Annual totals for Houston.",
  );
  assert.equal(
    ensureExplanationOffenseLabel("Crime data for Houston.", []),
    "Crime data for Houston.",
  );
}

console.log("explain tests passed");
