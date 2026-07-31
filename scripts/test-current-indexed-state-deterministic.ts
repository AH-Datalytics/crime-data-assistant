import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { buildCurrentIndexedStatePlan } from "../lib/current-indexed-state-deterministic";

const prior = "from 2015 to the present i'd like to compare aggravated assault data in these states compared to the national rate, indexed to 2015: AlabamaAlaskaCaliforniaGeorgiaHawaiiIdahoMinnesotaOklahomaSouth CarolinaTexasUtah";
const plan = buildCurrentIndexedStatePlan("2017 is good", [
  { role: "user", content: prior },
  { role: "assistant", content: "The Current data begin in 2017. Would you like 2017 as the baseline?" },
]);
assert.ok(plan);
assert.deepEqual(plan.columns, [
  "year", "alabama", "alaska", "california", "georgia", "hawaii", "idaho",
  "minnesota", "oklahoma", "south_carolina", "texas", "utah", "national",
]);
assert.match(plan.sql, /SUM\(population\)/);
assert.match(plan.sql, /year = 2017/);
assert.match(plan.explanation, /not full-state population/);
assert.equal(buildCurrentIndexedStatePlan("2017 is good", []), null);

const db = new Database("crime_data.db", { readonly: true });
const rows = db.prepare(plan.sql).all() as Record<string, number | null>[];
assert.ok(rows.length > 1);
const base = rows.find((row) => row.year === 2017);
assert.ok(base);
for (const column of plan.columns.slice(1)) {
  if (base[column] !== null) assert.equal(base[column], 100, column);
}
db.close();

console.log("current indexed-state deterministic tests passed");
