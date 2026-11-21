/**
 * General query model, step 1: the compiler's grouping table is built from DATA (lib/nibrs-plan/attribute-table.ts) and must be byte-identical to the table the hand-written code
 * produced (scripts/fixtures/nibrs-groupable-golden.json: column expressions, flags, join text, binned expressions), and every row must name a dimension of the semantic layer.
 * Offline. Run: npx tsx scripts/test-groupable-table.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { ATTRIBUTE_TABLE } from "../lib/nibrs-plan/attribute-table";
import { DRAFT_LAYER } from "../lib/nibrs-plan/draft-layer";
import { observeGroupable } from "./lib/groupable-observe";

const golden = JSON.parse(fs.readFileSync("scripts/fixtures/nibrs-groupable-golden.json", "utf8"));
const now = observeGroupable();
// Same units, same dimensions in the same order, and every observable value equal.
assert.deepEqual(Object.keys(now), Object.keys(golden), "the same counting units");
for (const unit of Object.keys(golden)) {
  assert.deepEqual(Object.keys(now[unit]), Object.keys(golden[unit]), `${unit}: the same dimensions in the same order`);
  for (const dim of Object.keys(golden[unit])) assert.deepEqual(now[unit][dim], golden[unit][dim], `${unit} / ${dim}: column, flags, join and binned expressions unchanged`);
}
// Every row names a dimension the semantic layer knows.
for (const r of ATTRIBUTE_TABLE) assert.ok(DRAFT_LAYER.dimension(r.dimension), `${r.unit} / ${r.dimension} is a dimension of the semantic layer`);
// No unit has a dimension twice (a later row would silently replace an earlier one).
const seen = new Set<string>();
for (const r of ATTRIBUTE_TABLE) { const k = `${r.unit}|${r.dimension}`; assert.ok(!seen.has(k), `${k} appears once`); seen.add(k); }
console.log(`groupable table: ${ATTRIBUTE_TABLE.length} rows, identical to the hand-written table (${Object.values(golden).reduce((n: number, d) => n + Object.keys(d as object).length, 0)} dimensions)`);
