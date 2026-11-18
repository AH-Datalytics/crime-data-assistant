/**
 * The cube read side (lib/nibrs-plan/cube.ts): pure checks always; the cell-by-cell comparison of cube answers against raw answers only when
 * a release and a cube are named (NIBRS_CUBE_TEST_CUBE = a folder with cube/data_year=YYYY, NIBRS_CUBE_TEST_ROOT = the canonical release, both
 * on a machine that has them; the runner sets them). Run: npx tsx scripts/test-nibrs-cube.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { ageMapping, cubeFromEnv, cubeUnits, CUBE_GROUPS, GROUPS_FILE_SHA256, GROUPS_VERSION, listSha256, runShadow, shadowSql, splitShadow, type CubeAsk, type CubeConfig } from "../lib/nibrs-plan/cube";

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

// --- The per-offense-code cube: one code for any unit, several codes only for arrests, Group B by its own rows; the group cube still takes the groups.
{
  const code = { root: "/code", years: [2024, 2025, 2026], codes: new Set(["09A", "09B", "13A", "13B", "11A", "11B", "11C", "90D", "35A"]) };
  const cfgBoth: CubeConfig = { ...cfg, code };
  const bins = base.attribute!.bins;
  const one: CubeAsk = { ...base, cfg: cfgBoth, kind: "victims", codes: ["09A"], attribute: { dimension: "victim.age", bins } };
  const murder = cubeUnits(one)!;
  assert.ok(murder, "victims of one code are a code-cube cell family");
  assert.match(murder.sql, /\/code\/canonical\/cube\/data_year=2024/);
  assert.match(murder.sql, /unit = 'victim' AND source = 'A' AND offense_code = '09A' AND attribute = 'age_bin'/);
  assert.equal(cubeUnits({ ...one, cfg: cfg }), null, "without a code cube a single code stays raw");
  // Victims and offenders under several codes are never added across codes; a list that IS a composite group is one group of the cube (counted once).
  const homicideV = cubeUnits({ ...one, codes: ["09A", "09B"] })!;
  assert.match(homicideV.sql, /\/cubes\/canonical\/cube[\s\S]*unit = 'victim' AND source = 'A' AND crime_group = 'homicide' AND attribute = 'age_bin'/, "09A+09B is the homicide group");
  const homicideO = cubeUnits({ ...one, kind: "offenders", codes: ["09B", "09A"], attribute: { dimension: "offender.age", bins } })!;
  assert.match(homicideO.sql, /unit = 'offender' AND source = 'A' AND crime_group = 'homicide'/, "in any order, offenders too");
  assert.match(cubeUnits({ ...one, codes: ["11C", "11A", "11B"], attribute: { dimension: "victim.sex" } })!.sql, /crime_group = 'rape' AND attribute = 'sex'/);
  assert.match(cubeUnits({ ...one, codes: ["13A", "13B", "13C"], attribute: { dimension: "victim.race" } })!.sql, /crime_group = 'assault_offenses' AND attribute = 'race'/);
  assert.match(cubeUnits({ ...one, codes: ["11A", "11B", "11C", "11D", "36A", "36B"] })!.sql, /crime_group = 'sex_offense'/);
  assert.match(cubeUnits({ ...one, kind: "arrests", codes: ["09A", "09B"], attribute: { dimension: "arrestee.age", bins } })!.sql, /unit = 'arrestee' AND source = 'A' AND crime_group = 'homicide'/);
  assert.equal(cubeUnits({ ...one, codes: ["09A", "13A"] }), null, "two codes that are no group are never added (victims)");
  assert.equal(cubeUnits({ ...one, kind: "offenders", codes: ["09A", "13A"], attribute: { dimension: "offender.age", bins } }), null, "nor offenders");
  assert.equal(cubeUnits({ ...one, cfg: { ...cfgBoth, years: [] }, codes: ["09A", "09B"] }), null, "no group cube: the composite stays raw");
  assert.equal(cubeUnits({ ...one, codes: ["13C"] }), null, "a code the manifest does not name stays raw");
  assert.equal(cubeUnits({ ...one, years: [2023, 2024] }), null, "a year the code cube lacks stays raw");
  assert.equal(cubeUnits({ ...one, conditioned: true }), null, "a weapon or any condition stays raw");
  for (const d of ["offender.sex", "offender.race"]) {
    const o = cubeUnits({ ...one, kind: "offenders", codes: ["13A"], attribute: { dimension: d } })!;
    assert.ok(o, `${d} is read from the code cube (offender sequence 00 is blank there, as in the engine)`);
    assert.match(o.sql, new RegExp(`unit = 'offender'[\\s\\S]*attribute = '${d.split(".")[1]}'`));
  }
  const victimSex = cubeUnits({ ...one, codes: ["13A"], attribute: { dimension: "victim.sex" } })!;
  assert.match(victimSex.sql, /unit = 'victim'[\s\S]*attribute = 'sex'/);
  assert.ok(cubeUnits({ ...one, kind: "offenders", codes: ["13A"], attribute: { dimension: "offender.age", bins } }), "offender age is read from the code cube");
  assert.equal(cubeUnits({ ...base, kind: "offenders", attribute: { dimension: "offender.sex" } }), null, "the group cube does not");
  const rape = cubeUnits({ ...one, kind: "arrests", codes: ["11A", "11B"], attribute: { dimension: "arrestee.age", bins } })!;
  assert.ok(rape, "arrests add exactly across codes");
  assert.match(rape.sql, /offense_code IN \('11A', '11B'\)/);
  assert.match(cubeUnits({ ...one, kind: "arrests", codes: ["11A", "11B", "11C"], attribute: { dimension: "arrestee.age", bins } })!.sql, /crime_group = 'rape'/, "the three rape codes are the rape group");
  assert.equal(cubeUnits({ ...one, kind: "arrests", codes: ["11A", "11B"], attribute: null, wantsIncidents: true }), null, "incidents are not added across codes");
  const dui = cubeUnits({ ...one, kind: "arrests", codes: ["90D"], groupB: true, attribute: { dimension: "group_b_arrest.age", bins } })!;
  assert.ok(dui, "Group B arrests of one code");
  assert.match(dui.sql, /unit = 'arrestee' AND source = 'B' AND offense_code = '90D'/);
  assert.equal(cubeUnits({ ...one, kind: "arrests", codes: ["90D"], groupB: true, attribute: { dimension: "arrestee.age", bins } }), null, "a Group B arrest's attribute is its own");
  // The group cube is still the one for a group, with both cubes set.
  const grp = cubeUnits({ ...base, cfg: cfgBoth })!;
  assert.match(grp.sql, /crime_group = 'person_crimes'/);
  assert.equal(cubeUnits({ ...base, cfg: { ...cfg, years: [], code } , codes: CUBE_GROUPS.person_crimes, kind: "offenders" }), null, "a group of codes with no group cube: offenders are not added across codes");
}

// --- The manifest check: a cube is used only when it was built from this release, with the engine's group lists, and its file is there.
{
  assert.equal(listSha256(CUBE_GROUPS.person_crimes), "e0da932813fb580e2fa05215a6ce59d977c7915830f3f0cdfb3cc12db4bb87ee", "the Model's recorded hash of the person_crimes list");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-cube-test-"));
  try {
    const release = path.join(dir, "release"), canonical = path.join(release, "canonical"), cubeRoot = path.join(dir, "cube");
    fs.mkdirSync(canonical, { recursive: true });
    fs.writeFileSync(path.join(release, "manifest.json"), '{"id":"r1"}');
    const sha = createHash("sha256").update(fs.readFileSync(path.join(release, "manifest.json"))).digest("hex");
    fs.mkdirSync(path.join(cubeRoot, "canonical/cube/data_year=2024"), { recursive: true });
    fs.writeFileSync(path.join(cubeRoot, "canonical/cube/data_year=2024/data.parquet"), "x");
    const groups = Object.fromEntries(Object.entries(CUBE_GROUPS).map(([g, c]) => [g, { codes: c, list_sha256: listSha256(c) }]));
    const write = (m: object) => fs.writeFileSync(path.join(cubeRoot, "manifest.json"), JSON.stringify(m));
    const good = { schema_version: "cube-0.1", source_manifest_sha256: sha, groups_version: GROUPS_VERSION, groups_file_sha256: GROUPS_FILE_SHA256, groups, years: { "2024": {}, "2025": {} },
      files: { "canonical/cube/data_year=2024/data.parquet": {}, "canonical/cube/data_year=2025/data.parquet": {} } };
    const env = { NIBRS_CUBE: "on", NIBRS_CUBE_ROOT: cubeRoot };
    const quiet = console.error; console.error = () => {};
    try {
      assert.equal(cubeFromEnv(env, canonical), null, "no manifest: an unfinished build");
      write(good);
      const ok = cubeFromEnv(env, canonical)!;
      assert.deepEqual(ok.years, [2024], "only the years whose file is there (2025 is listed but absent)");
      assert.equal(ok.mode, "on");
      assert.equal(cubeFromEnv({ ...env, NIBRS_CUBE: "shadow" }, canonical)!.mode, "shadow");
      assert.equal(cubeFromEnv({ ...env, NIBRS_CUBE: "off" }, canonical), null, "the flag off: no cube");
      assert.equal(cubeFromEnv({ NIBRS_CUBE: "on" }, canonical), null, "no cube root: no cube");
      write({ ...good, source_manifest_sha256: "0".repeat(64) });
      assert.equal(cubeFromEnv(env, canonical), null, "built from another release");
      write({ ...good, schema_version: "cube-9" });
      assert.equal(cubeFromEnv(env, canonical), null, "another schema version");
      write({ ...good, groups: { ...groups, property_crime: { codes: [], list_sha256: "x" } } });
      assert.equal(cubeFromEnv(env, canonical), null, "a group list that is not the engine's");
      const { homicide: _h, ...v1groups } = groups;
      write({ ...good, groups: v1groups });
      assert.equal(cubeFromEnv(env, canonical), null, "a cube without the composite groups");
      write({ ...good, groups_version: "crime_groups_v1" });
      assert.equal(cubeFromEnv(env, canonical), null, "another groups version");
      write({ ...good, groups_file_sha256: "0".repeat(64) });
      assert.equal(cubeFromEnv(env, canonical), null, "another groups file");
      write({ ...good, groups_file_sha256: undefined });
      assert.equal(cubeFromEnv(env, canonical), null, "no groups file hash");
      write(good);
      assert.equal(cubeFromEnv(env, path.join(dir, "elsewhere", "canonical")), null, "no release manifest to compare with");
      // The code cube: its own manifest.
      const codeRoot = path.join(dir, "codecube");
      fs.mkdirSync(path.join(codeRoot, "canonical/cube/data_year=2024"), { recursive: true });
      fs.writeFileSync(path.join(codeRoot, "canonical/cube/data_year=2024/data.parquet"), "x");
      const writeCode = (m: object) => fs.writeFileSync(path.join(codeRoot, "manifest.json"), JSON.stringify(m));
      const goodCode = { schema_version: "cube-code-0.1", source_manifest_sha256: sha, never_add_across_codes: true, reference_codes: ["09A", "13A"], years: { "2024": {} }, files: { "canonical/cube/data_year=2024/data.parquet": {} } };
      const cenv = { NIBRS_CUBE: "on", NIBRS_CODE_CUBE_ROOT: codeRoot };
      writeCode(goodCode);
      const only = cubeFromEnv(cenv, canonical)!;
      assert.deepEqual(only.years, [], "no group cube set");
      assert.deepEqual(only.code!.years, [2024]);
      assert.ok(only.code!.codes.has("09A") && !only.code!.codes.has("13B"));
      const both = cubeFromEnv({ ...env, ...cenv }, canonical)!;
      assert.deepEqual([both.years, both.code!.years], [[2024], [2024]], "both cubes, each with its own manifest");
      writeCode({ ...goodCode, never_add_across_codes: "Never add n_distinct_units across offense codes for victims and offenders: a victim linked to two codes is one unit in each code cell." });
      assert.ok(cubeFromEnv(cenv, canonical), "the Model's manifest carries the rule as a sentence");
      writeCode({ ...goodCode, never_add_across_codes: false });
      assert.equal(cubeFromEnv(cenv, canonical), null, "a code cube that does not say it never adds across codes");
      writeCode({ ...goodCode, never_add_across_codes: "  " });
      assert.equal(cubeFromEnv(cenv, canonical), null, "an empty rule");
      writeCode({ ...goodCode, never_add_across_codes: undefined });
      assert.equal(cubeFromEnv(cenv, canonical), null, "no rule at all");
      writeCode({ ...goodCode, schema_version: "cube-0.1" });
      assert.equal(cubeFromEnv(cenv, canonical), null, "the group schema is not a code cube");
      writeCode({ ...goodCode, source_manifest_sha256: "0".repeat(64) });
      assert.equal(cubeFromEnv(cenv, canonical), null, "a code cube built from another release");
      writeCode({ ...goodCode, source_manifest_sha256: "0".repeat(64) });
      assert.deepEqual(cubeFromEnv({ ...env, ...cenv }, canonical)!.code, undefined, "a bad code cube leaves the group cube in use");
      writeCode({ ...goodCode, reference_codes: undefined });
      assert.equal(cubeFromEnv(cenv, canonical), null, "no reference codes named");
    } finally { console.error = quiet; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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
const CUBE = process.env.NIBRS_CUBE_TEST_CUBE, CODE_CUBE = process.env.NIBRS_CUBE_TEST_CODE_CUBE, ROOT = process.env.NIBRS_CUBE_TEST_ROOT;
if ((CUBE || CODE_CUBE) && ROOT && fs.existsSync(`${CUBE ?? CODE_CUBE}/manifest.json`)) {
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
    const cubeCfg = cubeFromEnv({ NIBRS_CUBE: "on", NIBRS_CUBE_ROOT: CUBE, NIBRS_CODE_CUBE_ROOT: CODE_CUBE }, ROOT);
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
