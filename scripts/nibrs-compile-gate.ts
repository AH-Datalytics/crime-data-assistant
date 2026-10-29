/**
 * The compiler's correctness gate (engine phase 1, step 2). Two parts:
 *   1. synthetic: a tiny canonical build written to a temporary directory exercises the rules no real case happens
 *      to hit (an incident in a later year's file under a REPORTED_ZERO month, an unevidenced zero, two offense
 *      segments of one code in one incident, UNKNOWN and REPORTED_ZERO months);
 *   2. correctness cases: the plans X.H1-H3, X.N1, X.N2 and X.N3, run read-only against a canonical build and compared
 *      cell by cell with the hand-traced expected values (nibrs-model's correctness cases).
 * Every comparison checks the exact set of rows (no missing, extra or duplicate key), the value and status of every
 * statistic in every row, value/status consistency, the fixed answer statements, and that no status the compiler
 * marks for refusal appears.
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
const release = { id: "20261028-test5", firstMonth: "2017-01", lastMonth: "2026-10", asOf: "2026-10-29" };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-compile-gate-")).replace(/\\/g, "/");

function python(code: string, args: string[]): string {
  const r = spawnSync(PY, ["-I", "-c", code, ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
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
con.execute("SET enable_progress_bar = false")
print(json.dumps(con.execute(open(sys.argv[1], encoding="utf-8").read()).fetchall(), default=str))`, [file, TMP]));
}

/** One statistic in one row: its value and status. `pct1`: compare the value as a percentage rounded half up to one decimal. */
type Cell = { value: number | null; status: string; pct1?: boolean };
const C = (value: number | null, status: string, pct1 = false): Cell => ({ value, status, ...(pct1 ? { pct1 } : {}) });
/** A known count: 0 is a reported zero, anything else a VALUE. */
const known = (n: number): Cell => C(n, n === 0 ? "REPORTED_ZERO" : "VALUE");
const BLANK = ["UNKNOWN", "NOT_REPORTED", "UNKNOWN_UNEVIDENCED_ZERO", "UNAVAILABLE", "EVIDENCE_CONFLICT"];
const pct1 = (x: number) => Math.floor(x * 1000 + 0.5 + 1e-9) / 10;
let failed = 0;

/**
 * Compares result rows with expected rows. Keys are the columns before the first statistic, joined with "|" ("total"
 * when there are none). Checks the exact key set (no missing, extra or duplicate), every statistic's value and status,
 * consistency (blank exactly for blank statuses; a REPORTED_ZERO count exactly 0), and refusal.
 */
function compareRows(rows: unknown[][], columns: string[], stats: string[], expected: Map<string, Cell[]>, refuseOn: string[]): { problems: string[]; refused: boolean } {
  const keyCols = columns.indexOf(stats[0]);
  const got = new Map<string, Cell[]>();
  const problems: string[] = [];
  let refused = false;
  for (const r of rows) {
    const k = keyCols ? r.slice(0, keyCols).map(String).join("|") : "total";
    if (got.has(k)) problems.push(`duplicate row ${k}`);
    const cells = stats.map((_, i) => C(r[keyCols + 2 * i] === null ? null : Number(r[keyCols + 2 * i]), String(r[keyCols + 2 * i + 1])));
    got.set(k, cells);
    cells.forEach((c, i) => {
      if ((c.value === null) !== BLANK.includes(c.status)) problems.push(`${k} ${stats[i]}: value ${c.value} disagrees with status ${c.status}`);
      if (c.status === "REPORTED_ZERO" && c.value !== 0) problems.push(`${k} ${stats[i]}: REPORTED_ZERO with value ${c.value}`);
      if (refuseOn.includes(c.status)) refused = true;
    });
  }
  for (const [k, want] of expected) {
    const g = got.get(k);
    if (!g) { problems.push(`${k}: missing`); continue; }
    want.forEach((w, i) => {
      const v = w.pct1 && g[i].value !== null ? pct1(g[i].value!) : g[i].value;
      if (v !== w.value || g[i].status !== w.status) problems.push(`${k} ${stats[i]}: expected ${w.value} ${w.status}, got ${v} ${g[i].status}`);
    });
  }
  for (const k of got.keys()) if (!expected.has(k)) problems.push(`${k}: extra row`);
  const expectsRefusal = [...expected.values()].some((cs) => cs.some((c) => refuseOn.includes(c.status)));
  if (refused !== expectsRefusal) problems.push(refused ? "the result holds a refusal status" : "a refusal was expected");
  return { problems, refused };
}

// The comparator catches what it claims to (Codex compiler review r2): a positive REPORTED_ZERO, a missing, an extra
// and a duplicate row, a blank VALUE, a wrong share.
{
  const exp = new Map<string, Cell[]>([["2025-01", [known(26)]]]);
  const bad = (rows: unknown[][]) => compareRows(rows, ["period", "n", "n_status"], ["n"], exp, ["EVIDENCE_CONFLICT"]).problems.length > 0;
  const share = (v: number) => compareRows([["2025-01", 3, "VALUE", v, "VALUE"]], ["period", "n", "n_status", "s", "s_status"], ["n", "s"], new Map([["2025-01", [known(3), C(6.5, "VALUE", true)]]]), []).problems.length > 0;
  if (!bad([["2025-01", 26, "REPORTED_ZERO"]]) || !bad([]) || !bad([["2025-01", 26, "VALUE"], ["2025-02", 1, "VALUE"]])
    || !bad([["2025-01", 26, "VALUE"], ["2025-01", 26, "VALUE"]]) || !bad([["2025-01", null, "VALUE"]]) || bad([["2025-01", 26, "VALUE"]])
    || share(2 / 31) || !share(2 / 30)) {
    console.log("comparator self-test FAILED");
    process.exit(1);
  }
}

/** Compiles, runs and compares one plan. */
function check(name: string, plan: NibrsPlan, period: ResolvedPeriod, root: string, built: number[], expected: Map<string, Cell[]>, statements: string[] = []) {
  const c = compilePlan(plan, period, { root, builtYears: built });
  if (c.kind !== "query") { console.log(`${name}: UNSUPPORTED ${c.reason}`); failed++; return; }
  const stats = plan.statistics.map((s) => s.as);
  const { problems, refused } = compareRows(runSql(c.query.sql), c.query.columns, stats, expected, c.query.refuseOn);
  if (JSON.stringify(c.query.statements) !== JSON.stringify(statements)) problems.push(`statements ${JSON.stringify(c.query.statements)}, expected ${JSON.stringify(statements)}`);
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
    values = ", ".join("(" + ", ".join(repr(v) for v in r) + ")" for r in rows)
    sel = f"SELECT * FROM (VALUES {values}) t({', '.join(cols)})"
    con.execute(f"COPY ({sel}) TO '{d}/data.parquet' (FORMAT parquet)")
O = ["ori", "incident_num", "incident_date", "offense_code", "key_occurrence", "location_type"]
write("offense", 2024, O, [("YY0000000", "Y-1", "20240110", "240", 1, "20"),  # YY: one 2024 theft at a residence
    ("ZZ0000000", "Z-1", "20240105", "120", 1, "13"), ("ZZ0000000", "Z-2", "20240106", "13A", 1, "20")])  # ZZ: below
write("offense", 2025, O, [
    ("XX0000000", "FEB-OTHER", "20250210", "13B", 1, "20"),   # February: crimes reported, none of this kind
    ("XX0000000", "MAR-1", "20250305", "240", 1, "20"),       # March: one incident, two 240 segments
    ("XX0000000", "MAR-1", "20250305", "240", 2, "20"),
])
write("offense", 2026, O, [("XX0000000", "JAN-LATE", "20250115", "240", 1, "20")])  # a January 2025 incident in the 2026 file
S = ["ori", "month", "status"]
write("agency_month_status", 2024, S, [("YY0000000", 1, "REPORTED_CRIMES")] + [("YY0000000", m, "REPORTED_ZERO") for m in range(2, 13)] + [("ZZ0000000", 1, "REPORTED_CRIMES")])
write("agency_month_status", 2025, S, [("XX0000000", 1, "REPORTED_ZERO"), ("XX0000000", 2, "REPORTED_CRIMES"), ("XX0000000", 3, "REPORTED_CRIMES"), ("XX0000000", 4, "UNKNOWN"), ("XX0000000", 5, "REPORTED_ZERO")]
    + [("YY0000000", m, "REPORTED_ZERO") for m in range(1, 13)])  # YY: all of 2025 reported zero
write("agency_month_status", 2026, S, [("XX0000000", 1, "REPORTED_CRIMES")])
# ZZ, January 2024 (Codex review 02): key_occurrence numbers lines within one segment family, so it never links families.
# One robbery (occurrence 1) with two offender lines sharing sequence "##" (occurrences 1 and 2, M and F); one aggravated
# assault (occurrence 1, handgun) whose victim line is occurrence 2 of its sequence.
F = ["ori", "incident_num", "incident_date", "offender_seq", "key_occurrence", "sex"]
write("offender", 2024, F, [("ZZ0000000", "Z-1", "20240105", "##", 1, "M"), ("ZZ0000000", "Z-1", "20240105", "##", 2, "F"), ("ZZ0000000", "Z-2", "20240106", "01", 1, "M")])
write("victim", 2024, ["ori", "incident_num", "incident_date", "victim_seq", "key_occurrence"], [("ZZ0000000", "Z-2", "20240106", "001", 2)])
write("victim_offense", 2024, ["ori", "incident_num", "victim_seq", "key_occurrence", "connected_offense"], [("ZZ0000000", "Z-2", "001", 2, "13A")])
write("offense_weapon", 2024, ["ori", "incident_num", "offense_code", "key_occurrence", "weapon", "weapon_automatic"], [("ZZ0000000", "Z-2", "13A", 1, "12", " ")])
`, [SYN]);
const syn = (id: string, unit: "offense" | "incident"): NibrsPlan => ({ ...X.N3, question: "synthetic", geography: { places: [{ kind: "agency", ori: "XX0000000", label: "Synthetic, XX" }], combine: "separate" }, measures: [{ id, unit, as: "n" }], statistics: [{ kind: "count", as: "count", measure: "n" }], bindings: [], defaults: [] });
const SYN_PERIOD: ResolvedPeriod = { kind: "absolute", from: "2025-01", to: "2025-05" };
const synExpected = (march: number) => new Map<string, Cell[]>([
  ["2025-01", [C(null, "EVIDENCE_CONFLICT")]], ["2025-02", [C(null, "UNKNOWN_UNEVIDENCED_ZERO")]], ["2025-03", [C(march, "VALUE")]], ["2025-04", [C(null, "UNKNOWN")]], ["2025-05", [C(0, "REPORTED_ZERO")]]]);
check("synthetic offenses", syn("offenses.motor_vehicle_theft", "offense"), SYN_PERIOD, SYN, [2025, 2026], synExpected(2));
check("synthetic incidents", syn("incidents.motor_vehicle_theft", "incident"), SYN_PERIOD, SYN, [2025, 2026], synExpected(1));
// Codex review (N1/N2 increment): a category year that is all reported zeros has count 0 and an UNAVAILABLE share.
const by = (dimension: string) => ({ dimension, unknown: "visible" as const, absent: "show" as const });
check("synthetic grouped years", { ...syn("offenses.motor_vehicle_theft", "offense"), geography: { places: [{ kind: "agency", ori: "YY0000000", label: "Synthetic, YY" }], combine: "separate" },
  groupings: [by("time.year"), by("offense.location_type")], statistics: [{ kind: "count", as: "count", measure: "n" }, { kind: "share", as: "share", measure: "n", within: ["time.year"] }] },
  { kind: "absolute", from: "2024-01", to: "2025-12" }, SYN, [2024, 2025, 2026], new Map<string, Cell[]>([
    ["2024|20", [C(1, "VALUE"), C(100, "VALUE", true)]], ["2025|20", [C(0, "REPORTED_ZERO"), C(null, "UNAVAILABLE")]]]));

const zz = (measures: NibrsPlan["measures"], groupings: NibrsPlan["groupings"] = [], filters: NibrsPlan["filters"] = []): NibrsPlan =>
  ({ ...syn("offenses.robbery", "offense"), geography: { places: [{ kind: "agency", ori: "ZZ0000000", label: "Synthetic, ZZ" }], combine: "separate" }, measures, groupings, filters });
const JAN24: ResolvedPeriod = { kind: "absolute", from: "2024-01", to: "2024-01" };
check("synthetic offenders sharing a sequence", zz([{ id: "offenders.robbery", unit: "offender", as: "n" }]), JAN24, SYN, [2024], new Map([["total", [known(2)]]]));
check("synthetic robbery by its offenders' sexes", zz([{ id: "offenses.robbery", unit: "offense", as: "n" }], [{ ...by("offender.sex"), multiValue: "each_value" }]), JAN24, SYN, [2024],
  new Map([["M", [known(1)]], ["F", [known(1)]]]), ["categories_overlap"]);
check("synthetic victim with a handgun on its connecting offense", zz([{ id: "victims.aggravated_assault", unit: "victim", as: "n" }], [],
  [{ kind: "exists", scope: "victim", entity: "offense_weapon", where: [{ kind: "attribute", dimension: "offense_weapon.weapon", op: "in", values: ["12"] }] }]), JAN24, SYN, [2024], new Map([["total", [known(1)]]]));

// ---- 2. correctness cases against the canonical build ----
const load = (c: string) => JSON.parse(fs.readFileSync(path.join(CASES, c, "expected.json"), "utf8"));
const [n1, n2, n3, n4] = ["N1", "N2", "N3", "N4"].map(load);
// N1: every race-sex category that occurs, in every month; an UNKNOWN month is blank in every category.
type N1Cell = { race: string; sex: string; num: number | null; pct_1dp: number | null; status?: string };
type N1Row = { month: string; status: string; cells: N1Cell[] | null };
const n1Cats = [...new Set((n1.rows as N1Row[]).flatMap((r) => (r.cells ?? []).map((c) => `${c.race}|${c.sex}`)))];
const n1Expected = new Map<string, Cell[]>();
for (const r of n1.rows as N1Row[]) {
  for (const cat of n1Cats) {
    const cell = r.cells?.find((c) => `${c.race}|${c.sex}` === cat);
    n1Expected.set(`${r.month}|${cat}`, !r.cells ? [C(null, r.status), C(null, r.status)]
      : !cell ? [C(null, "MISSING-IN-EXPECTED"), C(null, "MISSING-IN-EXPECTED")]
        : cell.num === null ? [C(null, cell.status ?? "?"), C(null, cell.status ?? "?")]
          : [C(cell.num, "VALUE"), C(cell.pct_1dp, "VALUE", true)]);
  }
}
const geo = { members: (p: { kind: string }) => (p.kind === "agency" ? ["(agency)"] : ["(any)"]) };
const cases: [string, NibrsPlan, Map<string, Cell[]>, string[]][] = [
  ["H1", X.H1, new Map((n4.H1.rows as { month: string; carjackings: number }[]).map((r) => [r.month, [known(r.carjackings)]])), []],
  ["H2", X.H2, new Map([["total", [known((n4.H2.rows as { carjackings: number }[])[0].carjackings)]]]), []],
  ["H3", X.H3, new Map((n4.H3.rows as { year: number; carjackings: number }[]).map((r) => [String(r.year), [known(r.carjackings)]])), []],
  ["N3", X.N3, new Map((n3.rows as { month: string; motor_vehicle_theft_offenses: number }[]).map((r) => [r.month, [known(r.motor_vehicle_theft_offenses)]])), []],
  ["N2", X.N2, new Map((n2.rows as { month: string; theft_from_motor_vehicle_offenses_in_incidents_with_stolen_firearm: number }[]).map((r) => [r.month, [known(r.theft_from_motor_vehicle_offenses_in_incidents_with_stolen_firearm)]])), ["property_not_attributed"]],
  ["N1", X.N1, n1Expected, []],
];
for (const [name, plan, expected, statements] of cases) {
  const resolved = validateResolved(plan, release, DRAFT_LAYER, geo);
  if (resolved.problems.length) { console.log(`${name}: RESOLUTION FAILED ${resolved.problems.map((p) => `${p.rule} ${p.message}`).join("; ")}`); failed++; continue; }
  check(name, plan, resolved.period, ROOT, BUILT, expected, statements);
}

// D18 counts carjacking by offense. NIBRS allows one segment per offense code per incident, so on this build a
// carjacking's offenses and incidents are the same number: H1's independent incident counts must hold for offenses too,
// and no agency-month in the release may differ.
const h1Offenses: NibrsPlan = { ...X.H1, measures: X.H1.measures.map((m) => ({ ...m, id: "offenses.carjacking", unit: "offense" as const })) };
check("H1 by offense", h1Offenses, validateResolved(X.H1, release, DRAFT_LAYER, geo).period, ROOT, BUILT, cases[0][2]);
const readAll = (t: string) => `read_parquet('${ROOT}/${t}/data_year=*/data.parquet', hive_partitioning = true)`;
const [[agencyMonths, offenses, incidents, differing]] = runSql(`WITH cj AS (
    SELECT o.ori, substr(o.incident_date, 1, 6) AS ym, o.incident_num, o.key_occurrence FROM ${readAll("offense")} o
    WHERE o.offense_code = '120' AND EXISTS (SELECT 1 FROM ${readAll("property")} p WHERE p.data_year = o.data_year AND p.ori = o.ori
      AND p.incident_num = o.incident_num AND p.loss_type = '7' AND p.property_description IN ('03', '05', '24', '28', '37'))),
  m AS (SELECT ori, ym, count(*) AS offenses, count(DISTINCT incident_num) AS incidents FROM cj GROUP BY ALL)
  SELECT count(*), sum(offenses), sum(incidents), count(*) FILTER (WHERE offenses <> incidents) FROM m`) as number[][];
console.log(`carjacking offenses = incidents: ${agencyMonths} agency-months, ${offenses} offenses, ${incidents} incidents, ${differing} differing`);
if (Number(differing) !== 0 || Number(offenses) !== Number(incidents)) failed++;
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `compile gate: ${failed} check(s) failed` : "compile gate: every check passed");
process.exit(failed ? 1 : 0);
