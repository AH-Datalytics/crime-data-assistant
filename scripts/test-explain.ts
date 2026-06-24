import assert from "node:assert/strict";
import { earliestReturnedYear } from "../lib/explain";

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

console.log("explain tests passed");
