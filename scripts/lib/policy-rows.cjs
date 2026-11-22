"use strict";
/**
 * The answer policy, one file per row: docs/policy/rows/<id>.json (2026-11-21, coordinator plan a-c). Two PRs that each add or change
 * rows touch different files, so they never conflict; the CSV (docs/policy/nibrsai-answer-policy.csv) is generated from these files
 * for reading and is not committed (node scripts/build-answer-policy-csv.js).
 *
 * Each row file holds the CSV's columns as keys (COLUMNS, in order). Rows are ordered: open rows ("Needs Jeff") first, by topic and
 * id; then every decided row by id (letter, then number).
 */
const fs = require("node:fs");
const path = require("node:path");

const COLUMNS = ["id", "topic", "decision needed", "situation (example wording)", "what the app does today", "proposed behavior",
  "exact default or choices offered", "why", "status", "test cases"];
const OPEN = "Needs Jeff";
const ROOT = path.resolve(__dirname, "..", "..");
const DIR = path.join(ROOT, "docs", "policy", "rows");

const idKey = (id) => { const m = /^([A-Z]+)(\d+)$/.exec(id); return m ? [m[1], Number(m[2])] : [id, 0]; };
const byId = (a, b) => { const x = idKey(a.id), y = idKey(b.id); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1]; };

/** Every row, read and checked: the file name is its id, every column is a string, no other key. */
function loadRows(dir = DIR) {
  const rows = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    const keys = Object.keys(r);
    if (keys.join("\n") !== COLUMNS.join("\n")) throw new Error(`${f}: the keys must be exactly, in order: ${COLUMNS.join(" | ")}`);
    for (const k of COLUMNS) if (typeof r[k] !== "string") throw new Error(`${f}: "${k}" must be a string`);
    if (`${r.id}.json` !== f) throw new Error(`${f}: the file name must be its id (${r.id}.json)`);
    rows.push(r);
  }
  const open = rows.filter((r) => r.status === OPEN).sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : byId(a, b)));
  return [...open, ...rows.filter((r) => r.status !== OPEN).sort(byId)];
}

/** One CSV field as Python's csv module writes it (minimal quoting). */
const field = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** The CSV text: BOM, header, one record per row, LF line ends. */
function policyCsv(rows = loadRows()) {
  return "﻿" + [COLUMNS, ...rows.map((r) => COLUMNS.map((k) => r[k]))].map((rec) => rec.map(field).join(",")).join("\n") + "\n";
}
/** A row's file text: the columns in order, two-space indent, LF, a final newline. */
const rowText = (r) => JSON.stringify(Object.fromEntries(COLUMNS.map((k) => [k, r[k]])), null, 2) + "\n";

module.exports = { COLUMNS, OPEN, DIR, loadRows, policyCsv, rowText };
