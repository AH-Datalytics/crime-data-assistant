/**
 * Victim injury type (NIBRS element 33; lib/nibrs-plan, lib/nibrs-shadow/deliver.ts) end to end on a tiny canonical folder: "aggravated assault victims
 * by injury type" counts each VICTIM once under every type they have (COUNT DISTINCT of the victim key, never rows), so one victim with two types
 * appears in two rows and the rows add up to more than the victims; a victim with no injury row is its own row; the FBI's code names are the row
 * names; the line says a victim can have several. Needs a Python with duckdb (NIBRS_SHADOW_PYTHON, else "python"); skipped without one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";

const python = process.env.NIBRS_SHADOW_PYTHON ?? "python";
if (spawnSync(python, ["-I", "-c", "import duckdb"]).status !== 0) {
  console.log("victim injury: skipped (no Python with duckdb)");
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "victim-injury-test-")).replace(/\\/g, "/");
try {
  // Memphis (TNMPD0000), 2024: victim 1 has two injury types (minor, broken bones), victim 2 none, victim 3 no injury row; every month reports.
  const script = `
import duckdb, os
con = duckdb.connect()
def put(table, select):
    d = "${root}/" + table + "/data_year=2024"
    os.makedirs(d, exist_ok=True)
    con.execute("COPY (" + select + ") TO '" + d + "/data.parquet' (FORMAT PARQUET)")
key = "2024 AS data_year, 'TNMPD0000' AS ori, 'I1' AS incident_num, '%s' AS victim_seq, 1 AS key_occurrence"
put("victim", "SELECT " + key % "001" + ", '20240115' AS incident_date, 'I' AS victim_type UNION ALL SELECT " + key % "002" + ", '20240115', 'I' UNION ALL SELECT " + key % "003" + ", '20240115', 'I'")
put("victim_offense", "SELECT " + key % "001" + ", '13A' AS connected_offense UNION ALL SELECT " + key % "002" + ", '13A' UNION ALL SELECT " + key % "003" + ", '13A'")
put("victim_injury", "SELECT " + key % "001" + ", 1 AS ordinal, 'M' AS injury UNION ALL SELECT " + key % "001" + ", 2, 'B' UNION ALL SELECT " + key % "002" + ", 1, 'N'")
put("agency_month_status", "SELECT 2024 AS data_year, 'TNMPD0000' AS ori, m AS month, 'REPORTED_CRIMES' AS status FROM range(1, 13) t(m)")
`;
  const made = spawnSync(python, ["-I", "-c", script], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const deps = { places: loadPlaceIndex(), release: { id: "test", firstMonth: "2017-01", lastMonth: "2024-12", asOf: "2025-01-15" },
    target: { root, builtYears: [2024] }, execute: duckdbExecutor(python) } as unknown as ShadowDeps;
  const a = shadowAnswer("Aggravated assault victims in Memphis by injury type in 2024", deps) as unknown as
    { kind: string; delivered: { table: { columns: { header: string }[]; rows: (string | number | null)[][] }; text: string[] }; explanation?: string };
  assert.equal(a.kind, "answer", JSON.stringify(a).slice(0, 400));
  const rows = Object.fromEntries(a.delivered.table.rows.map((r) => [String(r[0]), r[1]]));
  assert.equal(rows["Apparent minor injury"], 1, JSON.stringify(a.delivered.table.rows));
  assert.equal(rows["Apparent broken bones"], 1);
  assert.equal(rows["None"], 1);
  // Three victims, four rows of counts: the victim with two types is in two rows.
  const sum = Object.values(rows).reduce<number>((n, x) => n + Number(x), 0);
  assert.equal(sum, 4, JSON.stringify(a.delivered.table.rows));
  assert.ok(a.delivered.text.includes("A victim can have several injury types, so the rows can add up to more than the number of victims."), JSON.stringify(a.delivered.text));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("victim injury: one victim with two types counts once under each, the rows add up to more than the victims, with the note");
