#!/usr/bin/env node
/**
 * Writes docs/policy/nibrsai-answer-policy.csv (not committed) from the row files docs/policy/rows/<id>.json (scripts/lib/policy-rows.cjs).
 *   node scripts/build-answer-policy-csv.js [out.csv]
 * A new or changed policy row is a new or changed file in docs/policy/rows/, with its id added to scripts/fixtures/policy-row-ids.txt.
 */
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { loadRows, policyCsv, OPEN } = require("./lib/policy-rows.cjs");

const rows = loadRows();
const out = process.argv[2] || path.join(__dirname, "..", "docs", "policy", "nibrsai-answer-policy.csv");
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, policyCsv(rows));
console.log(rows.length, "rows,", rows.filter((r) => r.status === OPEN).length, "need Jeff");
