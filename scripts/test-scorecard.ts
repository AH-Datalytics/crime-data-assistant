/**
 * P215: the crime scorecard (lib/nibrs-shadow/scorecard.ts) read from a tiny Crime Index fixture written to temp parquet files: an agency card (nine rows, change,
 * rate, clearance), the over-100% sentence, a blank change when there is no prior count, a state card and a national card without a clearance column, sums of the
 * component rows, and the refusal of a card more than three years behind the file's newest year. Needs the local Python with duckdb (as test-nibrs-cube does).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { buildScorecard } from "../lib/nibrs-shadow/scorecard";
import type { HistoricalBuild } from "../lib/nibrs-shadow/historical";

const python = process.env.NIBRS_CUBE_TEST_PYTHON ?? "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe";
if (!fs.existsSync(python)) { console.log("test-scorecard: skipped (no python with duckdb at " + python + ")"); process.exit(0); }
let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (ok) console.log("ok  ", name);
  else { failed++; console.log("FAIL", name, detail === undefined ? "" : JSON.stringify(detail)); }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scorecard-")).replace(/\\/g, "/");
const execute = duckdbExecutor(python, { timeoutMs: 120_000 });
const STEMS = ["violent", "murder", "rape", "robbery", "assault", "property", "burglary", "theft", "motor"];
const lit = (v: unknown) => (v === null ? "NULL" : typeof v === "string" ? `'${v}'` : String(v));
const write = (file: string, cols: string[], rows: unknown[][]) => {
  const values = rows.map((r) => `(${r.map(lit).join(",")})`).join(",");
  execute(`COPY (SELECT * FROM (VALUES ${values}) t(${cols.join(",")})) TO '${dir}/${file}.parquet' (FORMAT parquet)`);
};
const base = (year: number, i: number) => 100 + i * 10 + (year - 2022);

const crimeCols = ["ori", "year", "population", ...STEMS.map((s) => `${s}_total`)];
const agencyRows: unknown[][] = [];
for (const year of [2022, 2023, 2024, 2025]) agencyRows.push(["AA0000100", year, 50000, ...STEMS.map((_, i) => base(year, i))]);
agencyRows.push(["OLD000100", 2020, 50000, ...STEMS.map((_, i) => 100 + i)]);   // newest complete year 2020: four years behind 2025
agencyRows.push(["ONE000100", 2025, 20000, ...STEMS.map((_, i) => 40 + i)]);    // one year only: no prior count
write("agency_crime", crimeCols, agencyRows);
write("agency_clearances", ["ori", "year", ...STEMS.map((s) => `${s}_cleared_rate`)], [
  ["AA0000100", 2025, ...STEMS.map((s, i) => (s === "murder" ? 120.0 : 30 + i))],
  ["OLD000100", 2020, ...STEMS.map(() => 50.0)],
  ["ONE000100", 2025, ...STEMS.map(() => 25.0)],
]);
write("current_final", ["ori", "year", "month", ...STEMS.map((s) => `${s}_total`)], [["ZZ0000000", 2025, 1, ...STEMS.map(() => 0)]]);
// A state: components only matter (the card sums them); a nation likewise.
const aggCols = ["state", "year", "population", ...STEMS.flatMap((s) => [`${s}_total`, `${s}_capita`])];
const aggRow = (state: string | null, year: number, k: number) => [...(state === null ? [] : [state]), year, 1000000, ...STEMS.flatMap((_, i) => [k + i + (year - 2024) * 10, (k + i) / 10])];
// The 2025 national property rate as the FBI publishes it is 1,534.8 while its parts (burglary 193.6... theft 1,144.1, motor 197.0) sum to 1,534.7: the card shows the published figure.
const nationRow = (year: number) => { const r = aggRow(null, year, 200); r[3 + STEMS.indexOf("property") * 2] = 1534.8; r[3 + STEMS.indexOf("burglary") * 2] = 193.6; r[3 + STEMS.indexOf("theft") * 2] = 1144.1; r[3 + STEMS.indexOf("motor") * 2] = 197.0; return r; };
// KY: no published violent_capita, so its violent rate falls back to the sum of its four parts.
const kyRow = (year: number) => { const r: unknown[] = aggRow("KY", year, 300); r[3 + STEMS.indexOf("violent") * 2 + 1] = null; return r; };
write("state_crime", aggCols, [aggRow("OH", 2024, 100), aggRow("OH", 2025, 100), kyRow(2024), kyRow(2025)]);
write("nation_crime", aggCols.slice(1), [nationRow(2024), nationRow(2025)]);

const build = { root: dir, release: "fixture", firstYear: 2020, lastYear: 2025, clearanceFirstYear: 2020 } as HistoricalBuild;
const cell = (rows: unknown[][], label: string, col: number) => rows.find((r) => r[0] === label)?.[col];

{
  const r = buildScorecard(build, execute, { kind: "agency", ori: "AA0000100", label: "Alpha PD, OH" });
  check("agency: a card", r.kind === "card", r);
  if (r.kind === "card") {
    const rows = r.table.rows as unknown[][];
    check("agency: year 2025, nine rows", r.year === 2025 && rows.length === 9, [r.year, rows.length]);
    check("agency: columns", JSON.stringify(r.table.columns.map((c) => c.header)) === JSON.stringify(["Type", "Offenses", "Change from 2024", "Rate per 100k", "Clearance Rate"]), r.table.columns.map((c) => c.header));
    check("agency: murder count and change", cell(rows, "Murder", 1) === 113 && cell(rows, "Murder", 2) === 0.9, [cell(rows, "Murder", 1), cell(rows, "Murder", 2)]);
    check("agency: rate per 100k", cell(rows, "Murder", 3) === 226, cell(rows, "Murder", 3));
    check("agency: clearance is not clamped", cell(rows, "Murder", 4) === 120, cell(rows, "Murder", 4));
    check("agency: says why a rate is over 100%", r.text.join(" ").includes("exceed 100%"), r.text);
  }
}
{
  const r = buildScorecard(build, execute, { kind: "agency", ori: "ONE000100", label: "One PD, OH" });
  check("no prior year: the change is blank, never 0.0", r.kind === "card" && (r.table.rows as unknown[][]).every((x) => x[2] === null), r.kind === "card" ? r.table.rows : r);
}
{
  const r = buildScorecard(build, execute, { kind: "agency", ori: "OLD000100", label: "Old PD, OH" });
  check("stale agency year: no card, and it says so", r.kind === "none" && /too far behind 2025/.test(r.explanation), r);
}
{
  const r = buildScorecard(build, execute, { kind: "agency", ori: "MISSING00", label: "Nowhere PD" });
  check("unknown agency: no card", r.kind === "none", r);
}
{
  const r = buildScorecard(build, execute, { kind: "state", code: "OH", name: "Ohio" });
  check("state: a card with no clearance column", r.kind === "card" && r.table.columns.length === 4, r);
  if (r.kind === "card") {
    const rows = r.table.rows as unknown[][];
    // 2025 murder = 100+1+10 = 111 ; violent = murder+rape+robbery+assault = (101+10)+(102+10)+(103+10)+(104+10)... uses components: indices 1..4
    const comp = [1, 2, 3, 4].reduce((s, i) => s + 100 + i + 10, 0);
    check("state: violent is the sum of its four components", cell(rows, "Violent Crime", 1) === comp, [cell(rows, "Violent Crime", 1), comp]);
    check("state: the text says clearance is not shown", /Clearance rates are not shown/.test(r.text.join(" ")), r.text);
  }
}
{
  const r = buildScorecard(build, execute, { kind: "national" });
  check("national: a card, year 2025", r.kind === "card" && r.year === 2025, r);
  if (r.kind === "card") {
    const rows = r.table.rows as unknown[][];
    check("national: property rate is the published 1,534.8, not the 1,534.7 sum of its parts", cell(rows, "Property Crime", 3) === 1534.8, cell(rows, "Property Crime", 3));
    check("national: violent rate is the published violent_capita", cell(rows, "Violent Crime", 3) === 20, cell(rows, "Violent Crime", 3));
  }
}
{
  const r = buildScorecard(build, execute, { kind: "state", code: "KY", name: "Kentucky" });
  check("state: a null violent_capita falls back to the sum of the four parts", r.kind === "card" && cell(r.table.rows as unknown[][], "Violent Crime", 3) === 121, r.kind === "card" ? cell(r.table.rows as unknown[][], "Violent Crime", 3) : r);
}
{
  const r = buildScorecard(build, execute, { kind: "state", code: "ZZ", name: "Nowhere" });
  check("state with no data: no card", r.kind === "none", r);
}
fs.rmSync(dir, { recursive: true, force: true });
if (failed) { console.log(`test-scorecard: ${failed} FAILED`); process.exit(1); }
console.log("test-scorecard: all passed");
process.exit(0);
