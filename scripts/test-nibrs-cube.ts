/**
 * The cube read side (lib/nibrs-plan/cube.ts): pure checks always; the cell-by-cell comparison of cube answers against raw answers only when
 * a release and a cube are named (NIBRS_CUBE_TEST_CUBE = a folder with cube/data_year=YYYY, NIBRS_CUBE_TEST_ROOT = the canonical release, both
 * on a machine that has them; the runner sets them). Run: npx tsx scripts/test-nibrs-cube.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { ageMapping, cubeUnits, CUBE_GROUPS, runShadow, shadowSql, splitShadow, type CubeAsk, type CubeConfig } from "../lib/nibrs-plan/cube";

console.log("nibrs cube: the cube serves exactly its cell families; every other plan keeps the raw statements");

// --- Age bins: the cube's nine bins mapped onto the plan's bins; a plan that cuts across a cube bin is not served.
{
  const same = ageMapping([{ label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "25-34", from: 25, to: 34 }, { label: "35-44", from: 35, to: 44 },
    { label: "45-54", from: 45, to: 54 }, { label: "55-64", from: 55, to: 64 }, { label: "65+", from: 65, to: 99 }])!;
  assert.equal(same.merges, false);
  assert.equal(same.map["Under 18"], "Under 18");
  assert.equal(same.map["Unknown"], "Unknown");
  const coarse = ageMapping([{ label: "under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "25 and over", from: 25, to: 99 }])!;
  assert.equal(coarse.merges, true, "several cube bins in one plan bin");
  assert.equal(coarse.map["45-54"], "25 and over");
  assert.equal(ageMapping([{ label: "Teens", from: 10, to: 19 }, { label: "20+", from: 20, to: 99 }]), null, "a plan bin that cuts across the cube's Under 18 and 18-24 is not served");
  assert.equal(ageMapping([{ label: "Under 18", from: 1, to: 17 }, { label: "18 and over", from: 18, to: 120 }]), null, "a plan bin reaching ages the cube lumps as Outside is not served");
  assert.equal(ageMapping([{ label: "Under 18", from: 0, to: 17 }, { label: "18 and over", from: 18, to: 99 }]), null, "age 0 is outside the cube's bins");
  const partial = ageMapping([{ label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }])!;
  assert.equal(partial.map["35-44"], "Outside the groups", "a cube bin no plan bin covers reads as Outside the groups, as the raw binning does");
}

// --- Eligibility.
const cfg: CubeConfig = { root: "/cubes", years: [2024, 2025, 2026] };
const base: CubeAsk = { cfg, kind: "offenders", codes: CUBE_GROUPS.person_crimes, allCrimeArrests: false, attribute: { dimension: "offender.age", bins: [{ label: "Under 18", from: 1, to: 17 }, { label: "18 and over", from: 18, to: 99 }] },
  wantsIncidents: false, years: [2024, 2025, 2026], conditioned: false };
{
  const ok = cubeUnits(base)!;
  assert.ok(ok, "offenders of person crimes by age bins are a cube cell family");
  assert.match(ok.sql, /unit = 'offender' AND source = 'A' AND crime_group = 'person_crimes' AND attribute = 'age_bin'/);
  assert.match(ok.sql, /data_year=2024\/data\.parquet[\s\S]*data_year=2026\/data\.parquet/);
  assert.equal(cubeUnits({ ...base, conditioned: true }), null, "any condition: raw");
  assert.equal(cubeUnits({ ...base, years: [2023, 2024] }), null, "a year without a cube partition: raw");
  assert.equal(cubeUnits({ ...base, codes: ["09A", "13A"] }), null, "a code list that is no cube group: raw");
  assert.equal(cubeUnits({ ...base, attribute: { dimension: "offender.sex" } }), null, "offender sex is not in the cube: raw");
  assert.equal(cubeUnits({ ...base, attribute: { dimension: "victim.age", bins: base.attribute!.bins } }), null, "another unit's attribute: raw");
  assert.equal(cubeUnits({ ...base, wantsIncidents: true }), null, "incidents beside merged age bins are not additive: raw");
  const incidentsOk = cubeUnits({ ...base, wantsIncidents: true, attribute: { dimension: "offender.age", bins: [{ label: "Under 18", from: 1, to: 17 }, { label: "18-24", from: 18, to: 24 }, { label: "25-34", from: 25, to: 34 }, { label: "35-44", from: 35, to: 44 }, { label: "45-54", from: 45, to: 54 }, { label: "55-64", from: 55, to: 64 }, { label: "65+", from: 65, to: 99 }] } });
  assert.ok(incidentsOk, "incidents beside the cube's own bins are served");
  const total = cubeUnits({ ...base, attribute: null, wantsIncidents: true })!;
  assert.match(total.sql, /attribute = 'none'/, "a total reads the none rows");
  assert.doesNotMatch(total.sql, /AS g0/);
  const victims = cubeUnits({ ...base, kind: "victims", attribute: { dimension: "victim.sex" } })!;
  assert.match(victims.sql, /unit = 'victim'[\s\S]*attribute = 'sex'/);
  assert.match(victims.sql, /'\(blank\)' THEN 'U'/, "a blank is the engine's U");
  assert.equal(cubeUnits({ ...base, kind: "victims", attribute: { dimension: "victim.sex" }, wantsIncidents: true }), null, "sex/race categories can merge: incidents are raw");
  assert.equal(cubeUnits({ ...base, kind: "victims", codes: ["09A"], attribute: null }), null, "a single code is no group");
  const arrests = cubeUnits({ ...base, kind: "arrests", codes: null, allCrimeArrests: true, attribute: { dimension: "arrestee.age", bins: base.attribute!.bins } })!;
  assert.match(arrests.sql, /unit = 'arrestee' AND source IN \('A', 'B'\) AND crime_group = 'all_crime'/);
  assert.equal(cubeUnits({ ...base, kind: "offenders", codes: null, allCrimeArrests: true }), null, "offenders have no all-arrests reading");
}

// --- Shadow mode: the raw statement answers; the cube statement rides in a comment, is run beside it, and a difference or failure is only logged.
{
  const wrapped = shadowSql("SELECT 1 /* x */", "SELECT 2");
  assert.deepEqual(splitShadow(wrapped), { raw: "SELECT 1 /* x */", cube: "SELECT 2" });
  assert.equal(splitShadow("SELECT 1"), null);
  const log: string[] = [];
  const run = (s: string): unknown[][] => { if (s === "SELECT 3") throw new Error("boom"); return [[s === "SELECT 2" ? 2 : 1]]; };
  assert.deepEqual(runShadow(shadowSql("SELECT 1", "SELECT 2"), run, (l) => log.push(l)), [[1]], "the raw rows come back");
  assert.equal(JSON.parse(log[0]).kind, "mismatch");
  assert.deepEqual(runShadow(shadowSql("SELECT 1", "SELECT 1"), run, (l) => log.push(l)), [[1]]);
  assert.equal(log.length, 1, "equal rows log nothing");
  assert.deepEqual(runShadow(shadowSql("SELECT 1", "SELECT 3"), run, (l) => log.push(l)), [[1]], "a failing cube side never fails the answer");
  assert.equal(JSON.parse(log[1]).kind, "cube-error");
  assert.equal(runShadow("SELECT 1", run, (l) => log.push(l)), null, "an ordinary statement is not shadowed");
}

// --- Cell by cell against the raw statements, where a release and a cube exist.
const CUBE = process.env.NIBRS_CUBE_TEST_CUBE, ROOT = process.env.NIBRS_CUBE_TEST_ROOT;
if (CUBE && ROOT && fs.existsSync(`${CUBE}/cube`)) {
  const run = async () => {
    const { shadowAnswer } = await import("../lib/nibrs-shadow/answer");
    const { loadPlaceIndex } = await import("../lib/nibrs-shadow/places");
    const { duckdbExecutor } = await import("../lib/nibrs-shadow/duckdb");
    const { loadNibrsRelease } = await import("../lib/nibrs-shadow/release");
    const { cubeFromEnv } = await import("../lib/nibrs-plan/cube");
    const rel = loadNibrsRelease(undefined, ROOT);
    const r = { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: "2026-10-29" };
    const executed: string[] = [];
    const exec = duckdbExecutor(process.env.NIBRS_CUBE_TEST_PYTHON ?? "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe");
    const execute = (sql: string) => { executed.push(sql); return exec(sql); };
    const cubeCfg = cubeFromEnv({ NIBRS_CUBE: "on", NIBRS_CUBE_ROOT: CUBE });
    assert.ok(cubeCfg, "the cube folder is readable");
    const mk = (cube: CubeConfig | null) => ({ places: loadPlaceIndex(), release: r, target: { root: ROOT, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], cube }, execute });
    const questions = (process.env.NIBRS_CUBE_TEST_QUESTIONS ?? "").split("|").filter(Boolean);
    let served = 0;
    for (const q of questions) {
      const rawSql = executed.length;
      const raw = await shadowAnswer(q, mk(null));
      const cubeMark = executed.length;
      const cub = await shadowAnswer(q, mk(cubeCfg));
      const usedCube = executed.slice(cubeMark).some((s) => /cube\/data_year=/.test(s));
      const noSql = (_k: string, v: unknown) => (_k === "sql" || _k === "sqls" ? undefined : v); // the statements differ by design; everything else must not
      assert.equal(JSON.stringify(cub, noSql), JSON.stringify(raw, noSql), `cube and raw answer alike: ${q}`);
      if (usedCube) served++;
      console.log(`  ${usedCube ? "cube" : "raw "} ${raw.kind}: ${q} (${rawSql >= 0 ? "same" : ""})`);
    }
    if (questions.length) assert.ok(served > 0, "at least one question was read from the cube");
  };
  run().then(() => console.log("nibrs cube: cell-by-cell comparison done"), (e) => { console.error(e); process.exit(1); });
} else console.log("(no release or cube named: the cell-by-cell comparison is skipped)");
