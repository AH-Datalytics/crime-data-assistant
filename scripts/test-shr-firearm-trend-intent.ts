import assert from "node:assert/strict";
import { asksSimpleFirearmHomicideTrend } from "../lib/shr-firearm-trend-intent";

assert.equal(
  asksSimpleFirearmHomicideTrend("firearm murders in Houston since 2010"),
  true
);
assert.equal(
  asksSimpleFirearmHomicideTrend("annual gun homicides in Chicago from 2015 through 2025"),
  true
);

for (const question of [
  "what share of murders in Houston involved a firearm since 2010",
  "firearm murder rate in Houston since 2010",
  "compare firearm murders in Houston and Dallas since 2010",
  "top cities for firearm murders since 2010",
  "firearm murders by race in Houston since 2010",
  "monthly firearm murders in Houston since 2010",
  "firearm murders in Houston in 2024",
]) {
  assert.equal(asksSimpleFirearmHomicideTrend(question), false, question);
}

console.log("SHR firearm trend intent tests passed");
