/**
 * Any-arrest month test: the raw scan against the arrests cube (job: any-arrest cube, Engine 2.0 review of 05361a32).
 *
 * compile.ts picks the (agency, month) pairs that have an arrest in one of two ways: the raw scan (arrestee rows whose
 * multiple_arrestee_indicator is not 'M', plus standalone Group B rows with identical_to_line_no NULL, by substr(arrest_date, 1, 6))
 * or, with the cube on for every year asked, cubeAnyArrestMonths (cube rows with unit 'arrestee', source A or B, all crime,
 * attribute none, more than 0 distinct arrestees). This script runs both for each year the cube covers, one data year at a time,
 * and prints every (ori, ym) that one side has and the other does not, with counts in both directions.
 * Zero in both directions = the two tests agree.
 *
 * Read-only; no SQLite. Needs a Python with duckdb. Environment (the same names test-nibrs-cube.ts uses):
 *   NIBRS_CUBE_TEST_ROOT    the raw parquet release root (holds arrestee/ and group_b_arrest/)
 *   NIBRS_CUBE_TEST_CUBE    the crime-group cube root (must be the group v4 cube, as the compiler requires)
 *   NIBRS_CUBE_TEST_PYTHON  Python with duckdb (default: the nibrs-model venv)
 *   NIBRS_CUBE_TEST_YEARS   comma-separated years to compare (default: every year the cube covers from 2017 to 2026)
 *   NIBRS_DIFF_OUT          the TSV of differing rows (default any-arrest-diff.tsv in the working folder)
 * Run: npx tsx scripts/diff-any-arrest-months.ts
 * Exit 0 when both directions are zero, 1 when not, 2 when it could not run.
 */
import fs from "node:fs";
import { cubeAnyArrestMonths, cubeFromEnv } from "../lib/nibrs-plan/cube";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";

const ROOT = process.env.NIBRS_CUBE_TEST_ROOT, CUBE = process.env.NIBRS_CUBE_TEST_CUBE;
if (!ROOT || !CUBE) { console.error("set NIBRS_CUBE_TEST_ROOT (raw parquet root) and NIBRS_CUBE_TEST_CUBE (group cube root)"); process.exit(2); }
const cfg = cubeFromEnv({ NIBRS_CUBE: "on", NIBRS_CUBE_ROOT: CUBE }, ROOT);
if (!cfg || !cfg.groupV4) { console.error("the cube at NIBRS_CUBE_TEST_CUBE is not readable as a group v4 cube"); process.exit(2); }
const want = process.env.NIBRS_CUBE_TEST_YEARS ? process.env.NIBRS_CUBE_TEST_YEARS.split(",").map(Number) : cfg.years.filter((y) => y >= 2017 && y <= 2026);
const years = want.filter((y) => cfg.years.includes(y));
if (!years.length || years.length !== want.length) { console.error(`the cube lacks some wanted years: wanted ${want.join(",")}, cube has ${cfg.years.join(",")}`); process.exit(2); }

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
const exec = duckdbExecutor(process.env.NIBRS_CUBE_TEST_PYTHON ?? "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe");
const read = (table: string, y: number) => `read_parquet([${q(`${ROOT}/${table}/data_year=${y}/data.parquet`)}], hive_partitioning = true)`;
// Exactly the compiler's raw test (compile.ts, the any_arrest CTE), one year at a time, before the agency and month filters.
const rawSql = (y: number) => `SELECT DISTINCT ori, ym FROM (
  SELECT ori, substr(arrest_date, 1, 6) AS ym FROM ${read("arrestee", y)} WHERE coalesce(multiple_arrestee_indicator, '') <> 'M'
  UNION ALL SELECT ori, substr(arrest_date, 1, 6) AS ym FROM ${read("group_b_arrest", y)} WHERE identical_to_line_no IS NULL)`;
const cubeSql = (y: number) => `SELECT DISTINCT ori, ym FROM (${cubeAnyArrestMonths(cfg, [y])!.sql})`;

const out: string[] = ["data_year\tside\tori\tym\tym_shape"];
let rawOnly = 0, cubeOnly = 0;
const shape = (ym: unknown) => ym == null ? "NULL" : /^\d{6}$/.test(String(ym)) ? "yyyymm" : String(ym) === "" ? "blank" : "other";
console.log(`any-arrest months, raw scan vs cube, years ${years.join(", ")}`);
console.log("year\traw months\tcube months\traw only\tcube only");
for (const y of years) {
  const raw = `(${rawSql(y)})`, cube = `(${cubeSql(y)})`;
  const [[nRaw, nCube]] = exec(`SELECT (SELECT count(*) FROM ${raw}), (SELECT count(*) FROM ${cube})`) as number[][];
  const ro = exec(`SELECT ori, ym FROM (SELECT * FROM ${raw} EXCEPT SELECT * FROM ${cube}) ORDER BY ori, ym`) as unknown[][];
  const co = exec(`SELECT ori, ym FROM (SELECT * FROM ${cube} EXCEPT SELECT * FROM ${raw}) ORDER BY ori, ym`) as unknown[][];
  rawOnly += ro.length; cubeOnly += co.length;
  for (const [ori, ym] of ro) out.push(`${y}\traw_only\t${ori}\t${ym ?? ""}\t${shape(ym)}`);
  for (const [ori, ym] of co) out.push(`${y}\tcube_only\t${ori}\t${ym ?? ""}\t${shape(ym)}`);
  console.log(`${y}\t${nRaw}\t${nCube}\t${ro.length}\t${co.length}`);
}
const file = process.env.NIBRS_DIFF_OUT ?? "any-arrest-diff.tsv";
fs.writeFileSync(file, out.join("\n") + "\n");
// What kind of month the raw-only rows are, so one look says whether a gap is blank or invalid arrest dates (c) or real months.
const kinds = new Map<string, number>();
for (const line of out.slice(1)) { const [, side, , , sh] = line.split("\t"); kinds.set(`${side} ${sh}`, (kinds.get(`${side} ${sh}`) ?? 0) + 1); }
console.log(`raw only: ${rawOnly}   cube only: ${cubeOnly}`);
for (const [k, n] of [...kinds].sort()) console.log(`  ${k}: ${n}`);
console.log(`first rows (all rows in ${file}):`);
for (const l of out.slice(1, 41)) console.log("  " + l);
exec.close?.();
if (rawOnly || cubeOnly) { console.log("DIFFERENT: the two month tests do not agree"); process.exit(1); }
console.log("SAME: zero both ways");
