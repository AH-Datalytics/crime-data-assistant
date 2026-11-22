/**
 * A default never answers without the breakdown that was asked, and keeps it by every year (Coordinator 2026-11-22, the follow-up to F1 of the independent review
 * of PR 331): "arrests by age in Memphis" has no period, and the reader moves "by age" out of the words into a person attribute, so the ask's own text no longer
 * has it. The every-year question is built from the question as typed; the answer is Year by Arrestee age, never "Arrests Per Year". Executed on a tiny canonical
 * folder (three Group A arrestees and one Group B arrest in Memphis, 2024). Needs a Python with duckdb (NIBRS_SHADOW_PYTHON, else "python"); skipped without one.
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
  console.log("default breakdown: skipped (no Python with duckdb)");
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "default-breakdown-test-")).replace(/\\/g, "/");
try {
  const script = `
import duckdb, os
con = duckdb.connect()
def put(table, select, partition=True):
    d = "${root}/" + table + ("/data_year=2024" if partition else "")
    os.makedirs(d, exist_ok=True)
    con.execute("COPY (" + select + ") TO '" + d + "/data.parquet' (FORMAT PARQUET)")
put("arrestee", "SELECT * FROM (VALUES ('TNMPD0000','I1','01',1,'20240115','13A','N','20'), ('TNMPD0000','I2','01',1,'20240215','13A','N','35'), ('TNMPD0000','I3','01',1,'20240315','13A','N','35')) t(ori, incident_num, arrestee_seq, key_occurrence, arrest_date, arrest_offense, multiple_arrestee_indicator, age)")
put("group_b_arrest", "SELECT * FROM (VALUES ('TNMPD0000','T1','01',1,'20240415','90D',NULL,'40')) t(ori, arrest_transaction_num, arrestee_seq, occurrence, arrest_date, arrest_offense, identical_to_line_no, age)")
put("agency", "SELECT * FROM (VALUES ('TNMPD0000', [{'data_year': 2024, 'population': 600000, 'state_abbr': 'TN'}])) t(ori, by_year)", partition=False)
put("agency_month_status", "SELECT 2024 AS data_year, 'TNMPD0000' AS ori, m AS month, 'REPORTED_CRIMES' AS status, 1 AS group_a_rows, 0 AS group_b_rows, 'N' AS zero_flag, 'Y' AS ab_flag FROM range(1, 13) t(m)")
`;
  const made = spawnSync(python, ["-I", "-c", script], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const deps = { places: loadPlaceIndex(), release: { id: "test", firstMonth: "2017-01", lastMonth: "2024-12", asOf: "2025-01-15" },
    target: { root, builtYears: [2024] }, execute: duckdbExecutor(python) } as unknown as ShadowDeps;
  type Out = { kind: string; delivered?: { table: { columns: { header: string }[]; rows: (string | number | null)[][] }; text: string[] } };
  const a = shadowAnswer("arrests by age in Memphis, TN", deps) as unknown as Out;
  assert.equal(a.kind, "answer", JSON.stringify(a).slice(0, 300));
  const heads = a.delivered!.table.columns.map((c) => c.header);
  assert.ok(heads.includes("Year") && heads.includes("Arrestee age"), JSON.stringify(heads));
  assert.ok(a.delivered!.text.some((t) => /No years were given, so every year in the data is shown/.test(t)), JSON.stringify(a.delivered!.text));
  // 2024: ages 20 (1), 35 (2), 40 (the Group B arrest, 1): the age groups carry the counts, every year is there.
  const ia = heads.indexOf("Arrestee age"), ic = heads.indexOf("Arrests"), iy = heads.indexOf("Year");
  const in2024 = a.delivered!.table.rows.filter((r) => String(r[iy]) === "2024");
  assert.equal(in2024.reduce((n, r) => n + (Number(r[ic]) || 0), 0), 4, JSON.stringify(in2024));
  assert.ok(in2024.length > 1 && new Set(in2024.map((r) => r[ia])).size === in2024.length, "one row per age group");
  // The same question for the nation is declined up front (several years by age nationally): it stays an ask, never an answer without the age.
  const nat = shadowAnswer("arrests by age in the United States", deps) as unknown as Out;
  assert.notEqual(nat.kind, "answer");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("default breakdown: arrests by age with no period answer Year by age group, every year; the nation stays an ask");
