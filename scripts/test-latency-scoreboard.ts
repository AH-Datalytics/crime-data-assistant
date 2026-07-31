import assert from "node:assert/strict";
import { isProductionTraffic, latencyFamily, latencyStats } from "../lib/latency-scoreboard";

const stats = latencyStats([
  { tab: "nibrs", question: "a", ms: 100, session_id: null },
  { tab: "nibrs", question: "b", ms: 1_000, session_id: null },
  { tab: "nibrs", question: "c", ms: 10_000, session_id: null },
  { tab: "nibrs", question: "d", ms: 20_000, session_id: null },
], 10_000);
assert.deepEqual(stats, { total: 4, slow: 2, slowRate: 0.5, p50: 1_000, p95: 20_000, max: 20_000 });

assert.equal(isProductionTraffic({ tab: "nibrs", question: "", ms: 1, session_id: null }), true);
assert.equal(isProductionTraffic({ tab: "nibrs", question: "", ms: 1, session_id: "deploy-smoke-1" }), false);
assert.equal(latencyFamily("Arrest trends broken out by offense type"), "nibrs-arrests");
assert.equal(latencyFamily("Murder trends for continuous reporting agencies"), "continuous-reporters");
assert.equal(latencyFamily("Countywide offender age in Tarrant County"), "countywide");
assert.equal(latencyFamily("Homicide rates in Baltimore city Boston Chicago Cleveland Detroit Houston Phoenix Pittsburgh Washington DC Philadelphia"), "multi-city");
assert.equal(latencyFamily("2017 is good"), "followup-fragment");

console.log("latency scoreboard tests passed");
