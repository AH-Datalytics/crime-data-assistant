/**
 * Writes scripts/fixtures/nibrs-groupable-golden.json: the grouping table of lib/nibrs-plan/compile.ts as observed (scripts/lib/groupable-observe.ts). It was written ONCE from the
 * hand-written table, before the table was generated from data (general query model, step 1); scripts/test-groupable-table.ts holds the table to it. Re-run only when a grouping
 * is changed on purpose, in the same PR as that change.
 */
import fs from "node:fs";
import { observeGroupable } from "./lib/groupable-observe";

fs.writeFileSync("scripts/fixtures/nibrs-groupable-golden.json", JSON.stringify(observeGroupable(), null, 2) + "\n");
console.log("wrote scripts/fixtures/nibrs-groupable-golden.json");
