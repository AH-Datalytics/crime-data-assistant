/**
 * A month reported only through Group B arrest rows is not a crime report (P51, P121; lib/nibrs-plan/month-status.ts), executed on a tiny canonical folder
 * (the independent review of PR 347 asked for executed tests, not SQL string matches): five agencies in 2024, each with one odd month.
 *
 *   Memphis TN   every month has Group A rows                                 -> 12 months, 12 victims; in the Consistent Reporting Agencies
 *   Denver CO    June has Group B rows only, no zero flag                      -> June not reported (blank), no yearly total: "11 of 12 months reported"
 *   Boise ID     June has Group B rows and the zero flag                       -> the same: a Group B-only month is not reported whatever the flag says
 *   Tulsa OK     June is a formal zero report (flag set, no rows at all)       -> a reported 0: June shows 0 and the year is 11; out of the Consistent set
 *   Omaha NE     January to March Group B rows only, Group A from April        -> "9 of 12"; the first month that reported crimes is April; for arrests, January
 *   Austin AR    no month with any evidence                                    -> "NIBRS has no data from the Austin Police Department in 2024."
 *
 * and the national sum over them (the grid path) with its Consistent Reporting Agencies (Memphis alone), the coverage rule, and the first-reported-month condition.
 * (NIBRS_SHADOW_PYTHON, else "python"); skipped without one.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { ARREST_MONTH_REPORTED, CRIME_MONTH_REPORTED } from "../lib/nibrs-plan/month-status";

const python = process.env.NIBRS_SHADOW_PYTHON ?? "python";
if (spawnSync(python, ["-I", "-c", "import duckdb"]).status !== 0) {
  console.log("group A months: skipped (no Python with duckdb)");
  process.exit(0);
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "group-a-months-test-")).replace(/\\/g, "/");
try {
  const script = `
import duckdb, os
con = duckdb.connect()
def put(table, select, partition=True):
    d = "${root}/" + table + ("/data_year=2024" if partition else "")
    os.makedirs(d, exist_ok=True)
    con.execute("COPY (" + select + ") TO '" + d + "/data.parquet' (FORMAT PARQUET)")
# agency, state, A-month rule: a function of the month -> (status, group_a_rows, group_b_rows, zero_flag, ab_flag)
def months(odd):
    out = []
    for m in range(1, 13):
        out.append(odd(m) or ("REPORTED_CRIMES", 1, 0, "N", "Y"))
    return out
AG = {
  "TNMPD0000": ("TN", months(lambda m: None)),
  "CODPD0000": ("CO", months(lambda m: ("REPORTED_CRIMES", 0, 2, "N", "Y") if m == 6 else None)),
  "ID0010100": ("ID", months(lambda m: ("REPORTED_CRIMES", 0, 2, "Y", "Y") if m == 6 else None)),
  "OK0720500": ("OK", months(lambda m: ("REPORTED_ZERO", 0, 0, "Y", "N") if m == 6 else None)),
  "NB0280200": ("NE", months(lambda m: ("REPORTED_CRIMES", 0, 2, "N", "Y") if m <= 3 else None)),
  "AR0430500": ("AR", months(lambda m: ("UNKNOWN", 0, 0, "N", "N"))),
}
ams, vic, vo = [], [], []
for ori, (st, ms) in AG.items():
    for m, (status, a, b, z, ab) in enumerate(ms, 1):
        ams.append(f"(2024, '{ori}', {m}, '{status}', {a}, {b}, '{z}', '{ab}')")
        if a > 0:
            vic.append(f"(2024, '{ori}', 'I{m}', '001', 1, '2024{m:02d}15')")
            vo.append(f"(2024, '{ori}', 'I{m}', '001', 1, '13A')")
put("agency_month_status", "SELECT * FROM (VALUES " + ", ".join(ams) + ") t(data_year, ori, month, status, group_a_rows, group_b_rows, zero_flag, ab_flag)")
put("victim", "SELECT * FROM (VALUES " + ", ".join(vic) + ") t(data_year, ori, incident_num, victim_seq, key_occurrence, incident_date)")
put("victim_offense", "SELECT * FROM (VALUES " + ", ".join(vo) + ") t(data_year, ori, incident_num, victim_seq, key_occurrence, connected_offense)")
ag = ", ".join(f"('{ori}', [{{'data_year': 2024, 'population': 50000, 'state_abbr': '{st}'}}])" for ori, (st, _) in AG.items())
put("agency", "SELECT * FROM (VALUES " + ag + ") t(ori, by_year)", partition=False)
`;
  const made = spawnSync(python, ["-I", "-c", script], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const execute = duckdbExecutor(python);
  const deps = { places: loadPlaceIndex(), release: { id: "test", firstMonth: "2017-01", lastMonth: "2024-12", asOf: "2025-01-15" },
    target: { root, builtYears: [2024] }, execute } as unknown as ShadowDeps;
  type Out = { kind: string; delivered?: { table: { columns: { header: string }[]; rows: (string | number | null)[][] }; text: string[] }; explanation?: string };
  const ask = (q: string) => shadowAnswer(q, deps) as unknown as Out;
  const byMonth = (q: string) => {
    const a = ask(q);
    assert.equal(a.kind, "answer", JSON.stringify(a).slice(0, 300));
    return Object.fromEntries(a.delivered!.table.rows.map((r) => [String(r[0]), r[1]]));
  };
  const total = (q: string) => {
    const a = ask(q);
    assert.equal(a.kind, "answer", JSON.stringify(a).slice(0, 300));
    return a.delivered!.table.rows[0]?.[a.delivered!.table.rows[0].length - 1] ?? null;
  };

  // A fully reporting agency: 12 months of one victim each.
  const memphis = byMonth("Aggravated assault victims in Memphis, TN by month in 2024 according to NIBRS");
  assert.deepEqual(Object.values(memphis), Array(12).fill(1), JSON.stringify(memphis));
  // A month with only Group B arrest rows is unknown for a crime count: blank, never a 0.
  const denver = byMonth("Aggravated assault victims in Denver, CO by month in 2024 according to NIBRS");
  assert.equal(denver["2024-06"], null, JSON.stringify(denver));
  assert.equal(Object.values(denver).filter((v) => v === 1).length, 11, JSON.stringify(denver));
  // Group B rows with the zero flag (Boise) are still not a crime report, whatever the flag says: blank.
  const boise = byMonth("Aggravated assault victims in Boise, ID by month in 2024");
  assert.equal(boise["2024-06"], null, JSON.stringify(boise));
  assert.equal(Object.values(boise).filter((v) => v === 1).length, 11);
  // A formal zero report (Tulsa: the flag, no rows at all) is a reported 0.
  const tulsa = byMonth("Aggravated assault victims in Tulsa, OK by month in 2024");
  assert.equal(tulsa["2024-06"], 0, JSON.stringify(tulsa));
  assert.equal(Object.values(tulsa).filter((v) => v === 1).length, 11);
  // Yearly: the formal zero adds 0 to the year; a month not reported leaves the year blank, never a partial sum, and says how many months were (audit batch 2, B18).
  assert.equal(total("Aggravated assault victims in Memphis, TN in 2024 according to NIBRS"), 12);
  assert.equal(total("Aggravated assault victims in Tulsa, OK in 2024 according to NIBRS"), 11, "the zero report adds 0 to the year");
  const why = (q: string) => { const a = ask(q); assert.equal(a.kind, "decline", q + JSON.stringify(a).slice(0, 200)); return a.explanation ?? ""; };
  assert.match(why("Aggravated assault victims in Denver, CO in 2024 according to NIBRS"), /^Denver's NIBRS data isn't complete for 2024 \(11 of 12 months reported\)\./);
  assert.match(why("Aggravated assault victims in Boise, ID in 2024 according to NIBRS"), /^Boise's NIBRS data isn't complete for 2024 \(11 of 12 months reported\)\./);
  assert.match(why("Aggravated assault victims in Omaha, NE in 2024 according to NIBRS"), /^Omaha's NIBRS data isn't complete for 2024 \(9 of 12 months reported\)\./);
  assert.match(why("Aggravated assault victims in Austin, AR in 2024 according to NIBRS"), /^NIBRS has no data from the Austin Police Department in 2024\./);

  // The grid path (the national sum over the five agencies): no group-B-only month adds a victim, a zero report adds none, and the total is the victims there are.
  const nat = ask("Aggravated assault victims in the United States in 2024 according to NIBRS");
  assert.equal(nat.kind, "answer", JSON.stringify(nat).slice(0, 300));
  // 12 (Memphis) + 11 (Denver) + 11 (Boise) + 11 (Tulsa) + 9 (Omaha, April on): every victim of a Group A month, none made up for a Group B-only or zero-report month.
  assert.deepEqual(nat.delivered!.table.rows, [[54]], JSON.stringify(nat.delivered!.table.rows) + JSON.stringify(nat.delivered!.text));
  // The Consistent Reporting Agencies need a Group A row in every month: Memphis alone (a zero report, a Group B-only month, a missing month each exclude an agency).
  assert.equal((nat as unknown as { stateSum?: { everyAgencies: number } }).stateSum?.everyAgencies, 1, JSON.stringify(nat.delivered!.text));

  // The first month that reported crimes: Omaha's January to March are Group B rows only, so April; for arrests the status as built, so January.
  const first = (cond: string) => Number(execute(`SELECT min(data_year * 100 + month) FROM read_parquet('${root}/agency_month_status/data_year=*/data.parquet', hive_partitioning = true) WHERE ori = 'NB0280200' AND ${cond}`)[0][0]);
  assert.equal(first(CRIME_MONTH_REPORTED), 202404);
  assert.equal(first(ARREST_MONTH_REPORTED), 202401);
  // Agencies that reported in 2024 (the coverage rule): all five, Denver's June not counted as a reported month.
  const monthsReported = (ori: string) => Number(execute(`SELECT count(*) FROM read_parquet('${root}/agency_month_status/data_year=*/data.parquet', hive_partitioning = true) WHERE ori = '${ori}' AND ${CRIME_MONTH_REPORTED}`)[0][0]);
  assert.deepEqual(["TNMPD0000", "CODPD0000", "ID0010100", "OK0720500", "NB0280200", "AR0430500"].map(monthsReported), [12, 11, 11, 12, 9, 0]);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("group A months: a Group B-only month is unknown, a zero report is a reported zero, a full agency counts 12; the sum, the first month and the coverage rule agree");
