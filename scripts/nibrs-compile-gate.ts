/**
 * The compiler's correctness gate (engine phase 1, step 2): compiles correctness-case plans, runs them read-only
 * against a canonical build, and compares every cell with the hand-traced expected values.
 *
 *   npx tsx scripts/nibrs-compile-gate.ts [--root <canonical dir>] [--python <python with duckdb>] [--expected <cases dir>]
 *
 * Defaults are the local test release and nibrs-model's correctness cases. LOCAL ONLY: it needs the canonical build,
 * which is not in this repository, so it is not part of the CI harness. Read-only: DuckDB runs in memory with its
 * temporary directory outside the build. Exit 1 on any mismatch.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { compilePlan } from "../lib/nibrs-plan/compile";
import { DRAFT_LAYER } from "../lib/nibrs-plan/draft-layer";
import * as X from "../lib/nibrs-plan/examples";
import type { NibrsPlan } from "../lib/nibrs-plan/plan";
import { validateResolved } from "../lib/nibrs-plan/resolve";

const arg = (name: string, dflt: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const ROOT = arg("--root", "C:/Users/jeffm/nibrs-model/work/build/20261028-test5/canonical");
const PY = arg("--python", "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe");
const CASES = arg("--expected", "C:/Users/jeffm/nibrs-model-correctness/correctness/cases");
const BUILT = [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026];
const release = { id: "20261028-test5", firstMonth: "2017-01", lastMonth: "2026-09", asOf: "2026-10-29" };
const geo = { members: (p: { kind: string }) => (p.kind === "agency" ? ["(agency)"] : ["(any)"]) };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-compile-gate-"));

/** Runs one SQL statement in an in-memory DuckDB and returns its rows. */
function runSql(sql: string): unknown[][] {
  const file = path.join(TMP, "q.sql");
  fs.writeFileSync(file, sql);
  const code = `import duckdb, json, sys
con = duckdb.connect()
con.execute("SET temp_directory = ?", [sys.argv[2]])
rows = con.execute(open(sys.argv[1], encoding="utf-8").read()).fetchall()
print(json.dumps(rows, default=str))`;
  const r = spawnSync(PY, ["-I", "-c", code, file, TMP], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`duckdb failed: ${r.stderr.slice(-2000)}`);
  return JSON.parse(r.stdout);
}

type Case = { name: string; plan: NibrsPlan; expected: Map<string, number> };
const n4 = JSON.parse(fs.readFileSync(path.join(CASES, "N4", "expected.json"), "utf8"));
const n3 = JSON.parse(fs.readFileSync(path.join(CASES, "N3", "expected.json"), "utf8"));
const rowsOf = (rows: Record<string, unknown>[], key: string, value: string) => new Map(rows.map((r) => [String(r[key]), Number(r[value])]));
const pick = (rows: Record<string, unknown>[]) => {
  const k = Object.keys(rows[0]);
  return { key: k.find((x) => x === "month" || x === "year" || x === "period")!, value: k.find((x) => !["month", "year", "period", "status"].includes(x) && typeof rows[0][x] === "number")! };
};
const cases: Case[] = [];
for (const [name, plan] of [["H1", X.H1], ["H2", X.H2], ["H3", X.H3]] as const) {
  const rows = n4[name].rows as Record<string, unknown>[];
  const { key, value } = pick(rows);
  cases.push({ name, plan, expected: rowsOf(rows, key, value) });
}
cases.push({ name: "N3", plan: X.N3, expected: new Map((n3.rows as { month: string; motor_vehicle_theft_offenses: number }[]).map((r) => [r.month, r.motor_vehicle_theft_offenses])) });

let failed = 0;
for (const c of cases) {
  const resolved = validateResolved(c.plan, release, DRAFT_LAYER, geo);
  const compiled = compilePlan(c.plan, resolved.period, { root: ROOT.replace(/\\/g, "/"), builtYears: BUILT });
  if (compiled.kind !== "query") { console.log(`${c.name}: UNSUPPORTED ${compiled.reason}`); failed++; continue; }
  const rows = runSql(compiled.query.sql);
  const got = new Map(rows.map((r) => (r.length === 3 ? [String(r[0]), r[1] === null ? null : Number(r[1])] : ["total", r[0] === null ? null : Number(r[0])])));
  const diffs: string[] = [];
  for (const [k, v] of c.expected) {
    const key = got.has(k) ? k : got.has("total") && c.expected.size === 1 ? "total" : k;
    if (got.get(key) !== v) diffs.push(`${k}: expected ${v}, got ${got.get(key)}`);
  }
  const total = [...c.expected.values()].reduce((a, b) => a + b, 0);
  console.log(`${c.name}: ${c.expected.size} cells, ${diffs.length ? `${diffs.length} MISMATCHED` : "all equal"} (expected total ${total})`);
  for (const d of diffs.slice(0, 12)) console.log(`  ${d}`);
  if (diffs.length) failed++;
}
fs.rmSync(TMP, { recursive: true, force: true });
console.log(failed ? `compile gate: ${failed} case(s) failed` : "compile gate: every case equal");
process.exit(failed ? 1 : 0);
