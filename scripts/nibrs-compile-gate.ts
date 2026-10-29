/**
 * The compiler's correctness gate (engine phase 1, step 2). Two parts:
 *   1. synthetic: a tiny canonical build written to a temporary directory exercises the rules no real case happens
 *      to hit (an incident in a later year's file under a REPORTED_ZERO month, an unevidenced zero, two offense
 *      segments of one code in one incident, UNKNOWN and REPORTED_ZERO months);
 *   2. correctness cases: the plans X.H1-H3 and X.N3, run read-only against a canonical build and compared cell by
 *      cell with the hand-traced expected values.
 * Every comparison checks the exact set of rows (no missing, extra or duplicate period), the value and the status of
 * each, and that no status the compiler marks for refusal appears.
 *
 *   npx tsx scripts/nibrs-compile-gate.ts [--root <canonical dir>] [--python <python with duckdb>] [--expected <cases dir>]
 *
 * LOCAL ONLY: it needs Python with duckdb and the canonical build, which are not in this repository, so it is not part
 * of the CI harness. Read-only against the build: DuckDB runs in memory with its temporary directory elsewhere.
 * Exit 1 on any failure.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compilePlan } from "../lib/nibrs-plan/compile";
import { DRAFT_LAYER } from "../lib/nibrs-plan/draft-layer";
import * as X from "../lib/nibrs-plan/examples";
import type { NibrsPlan } from "../lib/nibrs-plan/plan";
import { validateResolved, type ResolvedPeriod } from "../lib/nibrs-plan/resolve";

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const ROOT = arg("--root", "C:/Users/jeffm/nibrs-model/work/build/20261028-test5/canonical").replace(/\\/g, "/");
const PY = arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe");
const CASES = arg("--expected", "C:/Users/jeffm/nibrs-model-correctness/correctness/cases");
const BUILT = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const release = { id: "20261028-test5", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-compile-gate-")).replace(/\\/g, "/");

function python(code: string, args: string[]): string {
  const r = spawnSync(PY, ["-I", "-c", code, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr.slice(-2000)}`);
  return r.stdout;
}
/** Runs one SQL statement in an in-memory DuckDB and returns its rows. */
function runSql(sql: string): unknown[][] {
  const file = path.join(TMP, "q.sql");
  fs.writeFileSync(file, sql);
  return JSON.parse(python(`import duckdb, json, sys
con = duckdb.connect()
con.execute("SET temp_directory = ?", [sys.argv[2]])
print(json.dumps(con.execute(open(sys.argv[1], encoding="utf-8").read()).fetchall(), default=str))`, [file, TMP]));
}

type Row = { value: number | null; status: string };
let failed = 0;
/** Compiles, runs and compares one plan: the exact rows, each value and status, and no refusal status. */
function check(name: string, plan: NibrsPlan, period: ResolvedPeriod, root: string, built: number[], expected: Map<string, Row | number>) {
  const c = compilePlan(plan, period, { root, builtYears: built });
  if (c.kind !== "query") { console.log(`${name}: UNSUPPORTED ${c.reason}`); failed++; return; }
  const rows = runSql(c.query.sql);
  const got = new Map<string, Row>();
  const problems: string[] = [];
  for (const r of rows) {
    const [k, v, s] = r.length === 3 ? [String(r[0]), r[1], String(r[2])] : ["total", r[0], String(r[1])];
    if (got.has(k)) problems.push(`duplicate row ${k}`);
    const value = v === null ? null : Number(v);
    got.set(k, { value, status: s });
    if ((value === null) !== ["UNKNOWN", "NOT_REPORTED", "UNKNOWN_UNEVIDENCED_ZERO", "EVIDENCE_CONFLICT"].includes(s)) problems.push(`${k}: value ${value} disagrees with status ${s}`);
  }
  const refused = [...got.values()].some((r) => c.query.refuseOn.includes(r.status));
  for (const [k, e] of expected) {
    const g = got.get(k);
    const want: Row = typeof e === "number" ? { value: e, status: e === 0 ? "REPORTED_ZERO" : "VALUE" } : e;
    if (!g) problems.push(`${k}: missing`);
    else if (g.value !== want.value || (typeof e !== "number" && g.status !== want.status) || (typeof e === "number" && !["VALUE", "REPORTED_ZERO"].includes(g.status))) problems.push(`${k}: expected ${want.value} ${want.status}, got ${g.value} ${g.status}`);
  }
  for (const k of got.keys()) if (!expected.has(k)) problems.push(`${k}: extra row`);
  const expectsRefusal = [...expected.values()].some((e) => typeof e !== "number" && c.query.refuseOn.includes(e.status));
  if (refused !== expectsRefusal) problems.push(refused ? "the result holds a refusal status" : "a refusal was expected");
  console.log(`${name}: ${expected.size} rows, ${problems.length ? `${problems.length} PROBLEM(S)` : "all equal"}${refused ? " (refused, as expected)" : ""}`);
  for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
  if (problems.length) failed++;
}

// ---- 1. synthetic build ----
const SYN = `${TMP}/canonical`;
python(`import duckdb, sys
root = sys.argv[1]
con = duckdb.connect()
def write(table, year, cols, rows):
    import os
    d = f"{root}/{table}/data_year={year}"
    os.makedirs(d, exist_ok=True)
    values = ", ".join("(" + ", ".join(repr(v) for v in r) + ")" for r in rows) or None
    sel = f"SELECT * FROM (VALUES {values}) t({', '.join(cols)})"
    con.execute(f"COPY ({sel}) TO '{d}/data.parquet' (FORMAT parquet)")
O = ["ori", "incident_num", "incident_date", "offense_code", "key_occurrence"]
write("offense", 2025, O, [
    ("XX0000000", "FEB-OTHER", "20250210", "13B", 1),   # February: crimes reported, none of this kind
    ("XX0000000", "MAR-1", "20250305", "240", 1),       # March: one incident, two 240 segments
    ("XX0000000", "MAR-1", "20250305", "240", 2),
])
write("offense", 2026, O, [("XX0000000", "JAN-LATE", "20250115", "240", 1)])  # a January 2025 incident in the 2026 file
S = ["ori", "month", "status"]
write("agency_month_status", 2025, S, [("XX0000000", 1, "REPORTED_ZERO"), ("XX0000000", 2, "REPORTED_CRIMES"), ("XX0000000", 3, "REPORTED_CRIMES"), ("XX0000000", 4, "UNKNOWN"), ("XX0000000", 5, "REPORTED_ZERO")])
write("agency_month_status", 2026, S, [("XX0000000", 1, "REPORTED_CRIMES")])
`, [SYN]);
const syn = (id: string, unit: "offense" | "incident"): NibrsPlan => ({ ...X.N3, question: "synthetic", geography: { places: [{ kind: "agency", ori: "XX0000000", label: "Synthetic, XX" }], combine: "separate" }, measures: [{ id, unit, as: "n" }], statistics: [{ kind: "count", as: "count", measure: "n" }], bindings: [], defaults: [] });
const SYN_PERIOD: ResolvedPeriod = { kind: "absolute", from: "2025-01", to: "2025-05" };
const R = (value: number | null, status: string): Row => ({ value, status });
check("synthetic offenses", syn("offenses.motor_vehicle_theft", "offense"), SYN_PERIOD, SYN, [2025, 2026], new Map<string, Row>([
  ["2025-01", R(null, "EVIDENCE_CONFLICT")], ["2025-02", R(null, "UNKNOWN_UNEVIDENCED_ZERO")], ["2025-03", R(2, "VALUE")], ["2025-04", R(null, "UNKNOWN")], ["2025-05", R(0, "REPORTED_ZERO")]]));
check("synthetic incidents", syn("incidents.motor_vehicle_theft", "incident"), SYN_PERIOD, SYN, [2025, 2026], new Map<string, Row>([
  ["2025-01", R(null, "EVIDENCE_CONFLICT")], ["2025-02", R(null, "UNKNOWN_UNEVIDENCED_ZERO")], ["2025-03", R(1, "VALUE")], ["2025-04", R(null, "UNKNOWN")], ["2025-05", R(0, "REPORTED_ZERO")]]));

// ---- 2. correctness cases against the canonical build ----
const n4 = JSON.parse(fs.readFileSync(path.join(CASES, "N4", "expected.json"), "utf8"));
const n3 = JSON.parse(fs.readFileSync(path.join(CASES, "N3", "expected.json"), "utf8"));
const geo = { members: (p: { kind: string }) => (p.kind === "agency" ? ["(agency)"] : ["(any)"]) };
for (const [name, plan, expected] of [
  ["H1", X.H1, new Map((n4.H1.rows as { month: string; carjackings: number }[]).map((r) => [r.month, r.carjackings]))],
  ["H2", X.H2, new Map([["total", (n4.H2.rows as { carjackings: number }[])[0].carjackings]])],
  ["H3", X.H3, new Map((n4.H3.rows as { year: number; carjackings: number }[]).map((r) => [String(r.year), r.carjackings]))],
  ["N3", X.N3, new Map((n3.rows as { month: string; motor_vehicle_theft_offenses: number }[]).map((r) => [r.month, r.motor_vehicle_theft_offenses]))],
] as const) {
  const resolved = validateResolved(plan, release, DRAFT_LAYER, geo);
  if (resolved.problems.length) { console.log(`${name}: RESOLUTION FAILED ${resolved.problems.map((p) => p.rule).join(", ")}`); failed++; continue; }
  check(name, plan, resolved.period, ROOT, BUILT, expected as Map<string, number>);
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `compile gate: ${failed} check(s) failed` : "compile gate: every check passed");
process.exit(failed ? 1 : 0);
