/**
 * B1 place aliases (bad-declines plan, family B1): questions the labels expect answered that the reader or the place
 * resolver declined for the way the place was written. Offline: the shadow slice with a stub DuckDB step and the checked-in
 * place index. Each question must get past the reader and the place step (a build-dependent route may still say "This
 * isn't available here."): never "couldn't find", "didn't understand" or "couldn't use". No database, no model, no network.
 */
import assert from "node:assert/strict";
import { accountNibrsRequest } from "../lib/nibrs-request-accounting";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { agencyInState, loadPlaceIndex, resolvePlace } from "../lib/nibrs-shadow/places";

const places = loadPlaceIndex();
const deps: ShadowDeps = {
  places,
  release: { id: "t", firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-11-23" } as never,
  target: { root: "/build", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] } as never,
  execute: () => [],
};
const CASES: [string, string][] = [
  ["ct-4c0c719a4c", "What is the crime rate in Athens, GA"],
  ["ct-51a2a0ca3d", "How is the Saint Augustine in Florida trending?"],
  ["ct-a9f17a6098", "Show me homicides reported by the Suffern (NY) Police Department over the last 5 years"],
  ["hist-192dd57de3", "Murders reported by the Cook County police department in Illinois in 2022"],
  ["hist-1dbbc58fd7", "Historical agency coverage for Athens, GA"],
  ["hist-4a839cc5c4", "How is the Saint Augustine Florida crime trending?"],
  ["hist-6633207932", "what is the autotheft clearance rate for Albany, New York State by year?"],
  ["hist-c08be9f759", "Pierce County, Washington State crime rates?"],
  ["hist-c6c712165e", "Historical agency coverage for Butte, MT"],
  ["hist-e6a97ee785", "Number of murders in cherry hill NJ in 2023"],
  ["nibrs-6900e4157e", "Murder rate for Fairfax County Police Department in Virginia from 2021 to 2025"],
  ["nibrs-8f18f9f338", "LMPD vs LFUCPD (Kentucky) murders over time"],
  ["nibrs-e5183adf58", "Maplewood Police Department in Maplewood, NJ"],
  ["shr-9a6a3f1355", "How many homicides took place in Maplewood, NJ since 1976"],
];
let failed = 0;
for (const [id, q] of CASES) {
  try {
    const o = shadowAnswer(q, deps) as unknown as { kind: string; explanation?: string };
    const text = String(o.explanation ?? "");
    assert.ok(!/couldn't find|didn't understand|couldn't use|couldn't tell/i.test(text), `${id}: ${text.slice(0, 120)}`);
    console.log(`  PASS  ${id}`);
  } catch (e) { console.log(`  FAIL  ${(e as Error).message}`); failed++; }
}
const checks: [string, () => void][] = [
  ["Athens, GA is Athens-Clarke County", () => assert.equal(agencyInState(places, "Athens", "GA")?.ori, "GA0290100")],
  ["a city-valued place named like a county still resolves its city agency", () => {
    const r = resolvePlace(places, "city:Athens-Clarke County:GA", "Athens, GA");
    assert.equal(r.kind, "agency");
  }],
  ["a county sheriff in a state code keeps the state", () => {
    const o = shadowAnswer("show violent crime by month for johnson county sheriff in ks", deps) as unknown as { explanation?: string; kind: string };
    assert.ok(!/couldn't find|didn't understand/i.test(String(o.explanation ?? "")));
  }],
  ["a state name beside a state is not read as one city (Kansas, Missouri)", () => {
    // Since P270 two states in one question are answerable (side by side), so the check is the reading, not a decline: the
    // reader sees two states and no city. (This offline stub has no agencies, so a NIBRS route can still decline in the plan step.)
    const places = accountNibrsRequest("Robberies in Kansas, Missouri in 2024 according to NIBRS").parts.filter((p) => p.concept === "place").map((p) => p.value);
    assert.deepEqual(places, ["state:Kansas", "state:Missouri"]);
  }],
];
for (const [name, fn] of checks) { try { fn(); console.log(`  PASS  ${name}`); } catch (e) { console.log(`  FAIL  ${name}: ${(e as Error).message}`); failed++; } }
if (failed) { console.log(`${failed} failed`); process.exit(1); }
console.log("place alias tests passed");
