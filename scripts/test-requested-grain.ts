import assert from "node:assert/strict";
import { detectRequestedGrain, resultGrain, validateGrain } from "../lib/requested-grain";
import { detectNibrsCapabilityOverride } from "../lib/nibrs-capability-overrides";

const annualRows = [{ year: 2022, arrests: 10 }, { year: 2023, arrests: 12 }];
const monthlyRows = [{ year: 2023, month: 1, arrests: 1 }, { year: 2023, month: 2, arrests: 2 }];
assert.equal(detectRequestedGrain("Show DWI arrests monthly"), "monthly");
assert.equal(detectRequestedGrain("Show DWI arrests by year"), "annual");
assert.equal(detectRequestedGrain("Show DWI arrests"), null);
assert.equal(resultGrain(annualRows), "annual");
assert.equal(resultGrain([{ year: 2023, data_month: 1, arrests: 2 }]), "monthly");
assert.equal(resultGrain(monthlyRows, "SELECT year, data_month, arrests FROM summary_city_monthly"), "monthly");
assert.deepEqual(validateGrain("Show DWI arrests monthly", annualRows), {
  ok: false,
  message: "This source reports this measure annually, not monthly. The annual results are shown below.",
});
assert.equal(validateGrain("Show DWI arrests annually", annualRows).ok, true);
assert.equal(validateGrain("Show DWI arrests monthly", monthlyRows).ok, true);
assert.equal(validateGrain("Show DWI arrests monthly", [{ arrests: 2 }]).ok, true);
const monthlyDwiOverride = detectNibrsCapabilityOverride("Show DWI arrests monthly in Chicago");
assert.equal(monthlyDwiOverride?.guardrail, "nibrs-annual-only-grain");
assert.equal(detectNibrsCapabilityOverride("Show burglaries monthly in Chicago"), null);

console.log("requested grain tests passed");
