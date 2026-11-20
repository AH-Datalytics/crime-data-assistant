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
import { BIG_LIST, oriIn, oriRows } from "../lib/nibrs-plan/ori-rows";
import { ageFilterBins, ageMapping, cubeFromEnv, cubeOffenseUnits, cubeUnits, cubeWeaponUnits, CODE_FILE_SHA256_V2, CODE_VERSION_V2, CUBE_GROUPS, GROUPS_FILE_SHA256, GROUPS_FILE_SHA256_V4, GROUPS_VERSION, GROUPS_VERSION_V4, OFFENSE_FILE_SHA256_V1, OFFENSE_VERSION_V1, WEAPON_FILE_SHA256_V1, WEAPON_VERSION_V1, listSha256, runShadow, shadowSql, splitShadow, type CubeAsk, type CubeConfig } from "../lib/nibrs-plan/cube";
import { categorySumsFromGrid } from "../lib/nibrs-shadow/state-sum";

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

// --- ORI sets in statements: a national set is one split string, a state's stays the plain list DuckDB can prune raw tables with.
{
  const small = ["TX0010000", "TX0020000", "NY0030000"];
  assert.equal(oriRows(small), "unnest(['TX0010000', 'TX0020000', 'NY0030000'])", "a short set is the plain list, as before");
  assert.equal(oriIn("ori", small), "ori IN ('TX0010000', 'TX0020000', 'NY0030000')", "and its IN is the plain list: the raw tables are pruned by it");
  const big = Array.from({ length: BIG_LIST + 1 }, (_, i) => `ZZ${String(i).padStart(7, "0")}`);
  assert.equal(oriRows(big), `unnest(string_split('${big.join(",")}', ','))`, "a national set is one string split inside DuckDB");
  assert.equal(oriIn("u.ori", big), `u.ori IN (SELECT unnest(string_split('${big.join(",")}', ',')))`);
  assert.ok(oriRows(big).length < big.map((o) => `'${o}'`).join(", ").length, "and smaller than the list");
  const odd = [...big.slice(0, -1), "A,B"];
  assert.match(oriRows(odd), /^unnest\(\['ZZ/, "an ORI that would break the split keeps the list literal");
  assert.match(oriRows([...big.slice(0, -1), "O'N"]), /'O''N'/, "a quote is escaped in the list literal");
}

// --- Grid once: the category sums read from the grid's (agency, year, category) rows.
{
  const row = (ori: string, y: number, n: number, k: string | null) => ["s", ori, y, n, null, null, null, null, k];
  const rows = [row("A1", 2024, 5, "Under 18"), row("A2", 2024, 7, "Under 18"), row("A1", 2024, 2, null), row("A2", 2023, 4, "Unknown"), row("A1", 2023, 1, "Unknown"), row("A3", 2024, 9, "65+")];
  assert.deepEqual(categorySumsFromGrid(rows, ["A1"], null), [[2023, "Unknown", 5, 1], [2024, "65+", 9, 0], [2024, "Under 18", 12, 5], [2024, null, 2, 2]],
    "summed over agencies and over the Consistent Reporting Agencies; ordered by year, then category, a missing category last");
  const headers = new Map<number, Set<string>>([[2023, new Set(["A1"])], [2024, new Set(["A1", "A3"])]]);
  assert.deepEqual(categorySumsFromGrid(rows, ["A1"], headers), [[2023, "Unknown", 1, 1], [2024, "65+", 9, 0], [2024, "Under 18", 5, 5], [2024, null, 2, 2]],
    "an arrest counts only in a year in which its agency has a header in the place");
  assert.deepEqual(categorySumsFromGrid([], [], null), []);
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

// --- Age as a condition ("juvenile arrests", "offenders under 18"): the cube's age rows of the bins the range keeps, summed.
{
  assert.deepEqual(ageFilterBins(0, 17), ["Under 18"], "under 18 is one bin (NN, NB and BB are in it, as in the plan's rule for a range starting at 0 or 1)");
  assert.deepEqual(ageFilterBins(1, 17), ["Under 18"]);
  assert.deepEqual(ageFilterBins(18, 24), ["18-24"]);
  assert.deepEqual(ageFilterBins(18, 34), ["18-24", "25-34"]);
  assert.deepEqual(ageFilterBins(25, 44), ["25-34", "35-44"]);
  assert.deepEqual(ageFilterBins(65, 99), ["65+"]);
  assert.equal(ageFilterBins(0, 99)!.length, 7);
  for (const [lo, hi] of [[18, 21], [17, 24], [2, 17], [19, 24], [18, 25], [30, 40], [0, 100], [5, 3], [-1, 17]]) assert.equal(ageFilterBins(lo, hi), null, `${lo} to ${hi} cuts a cube bin`);
  const juv: CubeAsk = { ...base, kind: "arrests", allCrimeArrests: true, codes: null, attribute: null, conditioned: false, ageFilter: { dimension: "arrestee.age", lo: 0, hi: 17 } };
  const s1 = cubeUnits(juv)!;
  assert.ok(s1, "juvenile arrests are read from the group cube's all-crime age rows");
  assert.match(s1.sql, /crime_group = 'all_crime' AND attribute = 'age_bin' AND value IN \('Under 18'\)/);
  assert.doesNotMatch(s1.sql, /AS g0/, "one total, no breakdown");
  assert.equal(cubeUnits({ ...juv, attribute: { dimension: "arrestee.race" } }), null, "a second split (age and race are never crossed in a cell) stays raw");
  assert.equal(cubeUnits({ ...juv, attribute: { dimension: "arrestee.age", bins: base.attribute!.bins } }), null, "so does age grouped and filtered at once");
  assert.equal(cubeUnits({ ...juv, ageFilter: { dimension: "arrestee.age", lo: 18, hi: 21 } }), null, "a range that cuts a bin stays raw");
  assert.equal(cubeUnits({ ...juv, ageFilter: { dimension: "arrestee.sex", lo: 0, hi: 17 } }), null, "only age");
  assert.equal(cubeUnits({ ...juv, ageFilter: { dimension: "offender.age", lo: 0, hi: 17 } }), null, "the counted person's own age");
  assert.equal(cubeUnits({ ...juv, conditioned: true }), null, "any other condition keeps it raw");
  assert.ok(cubeUnits({ ...juv, wantsIncidents: true }), "incidents beside one bin are exact");
  assert.equal(cubeUnits({ ...juv, ageFilter: { dimension: "arrestee.age", lo: 18, hi: 34 }, wantsIncidents: true }), null, "incidents never add across bins");
  assert.match(cubeUnits({ ...juv, ageFilter: { dimension: "arrestee.age", lo: 18, hi: 34 } })!.sql, /value IN \('18-24', '25-34'\)/, "units add across bins");
  const off = cubeUnits({ ...base, kind: "offenders", conditioned: false, attribute: null, ageFilter: { dimension: "offender.age", lo: 0, hi: 17 } })!;
  assert.match(off.sql, /unit = 'offender' AND source = 'A' AND crime_group = 'person_crimes' AND attribute = 'age_bin' AND value IN \('Under 18'\)/);
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
  // Cube 3: ethnicity needs a code cube built from offense_codes_v2; the group cube v4 adds sex, race and ethnicity to every unit.
  assert.equal(cubeUnits({ ...one, codes: ["13A"], attribute: { dimension: "victim.ethnicity" } }), null, "a v1 code cube has no ethnicity: raw");
  const cfgV2 = { ...cfgBoth, code: { ...code, ethnicity: true } };
  for (const [kind, dim] of [["offenders", "offender.ethnicity"], ["victims", "victim.ethnicity"], ["arrests", "arrestee.ethnicity"]] as const) {
    const e = cubeUnits({ ...one, cfg: cfgV2, kind, codes: ["13A"], attribute: { dimension: dim } })!;
    assert.ok(e, `${dim} is read from a code cube v2`);
    assert.match(e.sql, new RegExp(`attribute = 'ethnicity'`));
    assert.match(e.sql, /CASE WHEN value = '\(blank\)' THEN 'U' ELSE value END/, "blank ethnicity is U, as in the engine");
    assert.equal(cubeUnits({ ...one, cfg: cfgV2, kind, codes: ["13A"], attribute: { dimension: dim }, wantsIncidents: true }), null, "(blank) and U merge: incidents stay raw");
  }
  const cfgV4 = { ...cfg, groupV4: true };
  for (const [kind, dim, att] of [["offenders", "offender.sex", "sex"], ["offenders", "offender.race", "race"], ["offenders", "offender.ethnicity", "ethnicity"], ["victims", "victim.ethnicity", "ethnicity"], ["arrests", "arrestee.sex", "sex"], ["arrests", "arrestee.ethnicity", "ethnicity"]] as const) {
    const g = cubeUnits({ ...base, cfg: cfgV4, kind, attribute: { dimension: dim } })!;
    assert.ok(g, `${dim} is read from a group cube v4`);
    assert.match(g.sql, new RegExp(`attribute = '${att}'`));
  }
  assert.equal(cubeUnits({ ...base, cfg: cfgV4, kind: "victims", attribute: { dimension: "victim.ethnicity" } })!.sql.includes("crime_group = 'person_crimes'"), true);
  assert.equal(cubeUnits({ ...base, cfg: cfgV4, kind: "offenders", attribute: { dimension: "offender.relationship" } }), null, "any other attribute stays raw");
  assert.equal(cubeUnits({ ...base, cfg, kind: "victims", attribute: { dimension: "victim.ethnicity" } }), null, "a v2 group cube has no ethnicity: raw");
  assert.match(cubeUnits({ ...base, cfg: cfgV4, kind: "arrests", codes: null, allCrimeArrests: true, attribute: { dimension: "arrestee.race" } })!.sql, /crime_group = 'all_crime'[\s\S]*attribute = 'race'|source IN \('A', 'B'\)/, "all-crime arrests by race: Group A and B rows");
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

// --- Cube 1, the offense-and-incident cube: offenses and distinct incidents of one or more codes, by hour, location or clearance.
{
  const offense = { root: "/off", years: [2024, 2025], codes: new Set(["120", "13A", "13B", "23H", "35A"]), attributes: ["incident_hour", "location_type", "clearance_type"] };
  const cfgO: CubeConfig = { root: "", years: [], mode: "on", offense };
  const ask = { cfg: cfgO, entity: "offense" as const, codes: ["120"], attribute: null, wantsIncidents: false, years: [2024], conditioned: false };
  const total = cubeOffenseUnits(ask)!;
  assert.match(total.sql, /unit = 'offense' AND source = 'A' AND offense_code = '120' AND attribute = 'none'/);
  assert.match(total.sql, /SUM\(n_distinct_units\) AS BIGINT\) AS w,/);
  assert.equal(cubeOffenseUnits({ ...ask, cfg: { ...cfgO, offense: undefined } }), null, "no offense cube: raw");
  assert.equal(cubeOffenseUnits({ ...ask, conditioned: true }), null, "any condition stays raw");
  assert.equal(cubeOffenseUnits({ ...ask, codes: ["999"] }), null, "a code the cube was not built for stays raw");
  assert.equal(cubeOffenseUnits({ ...ask, years: [2023] }), null, "a year the cube lacks stays raw");
  // Offenses add across codes; incidents never do.
  const two = cubeOffenseUnits({ ...ask, codes: ["13A", "13B"] })!;
  assert.match(two.sql, /offense_code IN \('13A', '13B'\)/);
  assert.match(two.sql, /CAST\(NULL AS BIGINT\) AS wi/, "no incident count across codes");
  assert.equal(cubeOffenseUnits({ ...ask, codes: ["13A", "13B"], wantsIncidents: true }), null, "incidents beside offenses of two codes: raw");
  assert.equal(cubeOffenseUnits({ ...ask, codes: ["13A", "13B"], entity: "incident" }), null, "incidents of two codes: raw");
  const inc = cubeOffenseUnits({ ...ask, entity: "incident" })!;
  assert.match(inc.sql, /SUM\(n_distinct_incidents\) AS BIGINT\) AS w,/, "an incident count is the cell's distinct incidents");
  assert.match(cubeOffenseUnits({ ...ask, wantsIncidents: true })!.sql, /SUM\(n_distinct_units\) AS BIGINT\) AS w, CAST\(SUM\(n_distinct_incidents\) AS BIGINT\) AS wi/);
  // Hour: the plan's bins over the 24 two-character hours; an hour in no bin and the cube's Unknown are Unknown.
  const hbins = [{ label: "night", from: 0, to: 5 }, { label: "morning", from: 6, to: 11 }, { label: "afternoon", from: 12, to: 17 }, { label: "evening", from: 18, to: 23 }];
  const hour = cubeOffenseUnits({ ...ask, attribute: { dimension: "incident.hour", bins: hbins } })!;
  assert.match(hour.sql, /attribute = 'incident_hour'/);
  assert.match(hour.sql, /WHEN '00' THEN 'night'/);
  assert.match(hour.sql, /WHEN '06' THEN 'morning'/);
  assert.match(hour.sql, /WHEN '23' THEN 'evening'/);
  assert.match(hour.sql, /ELSE 'Unknown' END AS g0/);
  const gap = cubeOffenseUnits({ ...ask, attribute: { dimension: "incident.hour", bins: [{ label: "day", from: 8, to: 17 }] } })!;
  assert.match(gap.sql, /WHEN '03' THEN 'Unknown'/, "an hour outside the plan's bins is Unknown, as the raw statement says");
  assert.equal(cubeOffenseUnits({ ...ask, attribute: { dimension: "incident.hour" } }), null, "the hour needs bins");
  assert.ok(cubeOffenseUnits({ ...ask, entity: "incident", attribute: { dimension: "incident.hour", bins: hbins } }), "incidents by hour bin (one hour per incident)");
  // Location: raw codes, never merged; an incident count per value is exact; incidents have no location grouping.
  const loc = cubeOffenseUnits({ ...ask, attribute: { dimension: "offense.location_type" }, wantsIncidents: true })!;
  assert.match(loc.sql, /attribute = 'location_type'/);
  assert.match(loc.sql, /CASE WHEN value = '\(blank\)' THEN NULL ELSE value END AS g0/);
  assert.equal(cubeOffenseUnits({ ...ask, entity: "incident", attribute: { dimension: "offense.location_type" } }), null);
  // Clearance: type as stored, method and status merged from it.
  assert.match(cubeOffenseUnits({ ...ask, attribute: { dimension: "offense.clearance_type" } })!.sql, /attribute = 'clearance_type'/);
  assert.match(cubeOffenseUnits({ ...ask, attribute: { dimension: "offense.clearance_method" } })!.sql, /WHEN 'arrest' THEN 'arrest' WHEN 'none' THEN 'none' ELSE 'exceptional'/);
  assert.match(cubeOffenseUnits({ ...ask, entity: "incident", attribute: { dimension: "offense.clearance_status" } })!.sql, /WHEN 'none' THEN 'none' ELSE 'cleared'/);
  assert.equal(cubeOffenseUnits({ ...ask, attribute: { dimension: "offense.weapon" } }), null, "any other attribute stays raw");
  assert.equal(cubeOffenseUnits({ ...ask, cfg: { ...cfgO, offense: { ...offense, attributes: ["incident_hour"] } }, attribute: { dimension: "offense.clearance_type" } }), null, "an attribute the manifest does not list");
}

// --- The weapon cube: offenses of one or more codes with a weapon, always from ONE weapon cell (weapon values never add).
{
  const weapon = { root: "/wpn", years: [2024, 2025], codes: new Set(["09A", "120", "13A", "13B"]), attributes: ["weapon", "firearm"] };
  const cfgW: CubeConfig = { root: "", years: [], mode: "on", weapon };
  const ask = { cfg: cfgW, codes: ["09A"], grouping: true, weaponFilter: null, wantsIncidents: false, years: [2024], conditioned: false };
  const grp = cubeWeaponUnits(ask)!;
  assert.match(grp.sql, /unit = 'offense' AND source = 'A' AND offense_code = '09A' AND attribute = 'weapon'/);
  assert.match(grp.sql, /CASE WHEN value = '\(blank\)' THEN NULL ELSE value END AS g0/, "no weapon is a missing category, as the raw statement has it");
  assert.match(grp.totalSql!, /attribute = 'none'/, "overlapping categories: the month's total (every share's denominator) is the distinct offenses, the none row");
  assert.equal(cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: ["13"] })!.totalSql, undefined, "a one-cell filter needs no separate total");
  assert.equal(cubeWeaponUnits({ ...ask, cfg: { ...cfgW, weapon: undefined } }), null, "no weapon cube: raw");
  assert.equal(cubeWeaponUnits({ ...ask, conditioned: true }), null, "any other condition stays raw");
  assert.equal(cubeWeaponUnits({ ...ask, codes: ["999"] }), null);
  assert.equal(cubeWeaponUnits({ ...ask, years: [2023] }), null);
  assert.equal(cubeWeaponUnits({ ...ask, grouping: false }), null, "neither the grouping nor a filter: the offense cube's total, not this one");
  assert.equal(cubeWeaponUnits({ ...ask, weaponFilter: ["11"] }), null, "both a grouping and a filter: raw");
  // Offenses add across codes within a weapon cell; incidents only for one code.
  assert.match(cubeWeaponUnits({ ...ask, codes: ["13A", "13B"] })!.sql, /offense_code IN \('13A', '13B'\)[\s\S]*CAST\(NULL AS BIGINT\) AS wi|CAST\(NULL AS BIGINT\) AS wi/);
  assert.equal(cubeWeaponUnits({ ...ask, codes: ["13A", "13B"], wantsIncidents: true }), null, "incidents of two codes: raw");
  assert.match(cubeWeaponUnits({ ...ask, wantsIncidents: true })!.sql, /CAST\(SUM\(n_distinct_incidents\) AS BIGINT\) AS wi/);
  // The firearm filter is the Y cell, and one two-character code is its weapon cell; any other list of weapons is not one cell.
  const firearm = ["11", "11A", "12", "12A", "13", "13A", "14", "14A", "15", "15A"];
  const fy = cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: firearm })!;
  assert.match(fy.sql, /attribute = 'firearm' AND value = 'Y'/);
  assert.ok(!/g0/.test(fy.sql), "a filter is one cell: no category column");
  assert.match(cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: ["13"] })!.sql, /attribute = 'weapon' AND value = '13'/);
  assert.equal(cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: ["11", "12"] }), null, "two weapons are two cells and never add");
  assert.equal(cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: ["11", "12", "13", "14", "15"] }), null, "the firearm list is all ten values, flag or not");
  assert.equal(cubeWeaponUnits({ ...ask, grouping: false, weaponFilter: ["11A"] }), null, "an automatic firearm is not a cell of the cube");
  assert.equal(cubeWeaponUnits({ ...ask, cfg: { ...cfgW, weapon: { ...weapon, attributes: ["weapon"] } }, grouping: false, weaponFilter: firearm }), null, "no firearm attribute listed");
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
    // cubeFromEnv keys its cache on each manifest's mtime and size: give every write its own, later, modification time so a fast machine cannot repeat one.
    let tick = 1_800_000_000; // a fixed start (no clock read: the timing-gate inventory counts those)
    const put = (file: string, m: object) => { fs.writeFileSync(file, JSON.stringify(m)); tick += 2; fs.utimesSync(file, tick, tick); };
    const write = (m: object) => put(path.join(cubeRoot, "manifest.json"), m);
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
      // Group cube v4 (cube 3): its own file version and hash, and a manifest that lists the four attributes for every unit.
      const four = ["age_bin", "sex", "race", "ethnicity"];
      const v4 = { ...good, groups_version: GROUPS_VERSION_V4, groups_file_sha256: GROUPS_FILE_SHA256_V4, unit_attributes: { offender: four, victim: four, arrestee: four } };
      write(v4);
      assert.equal(cubeFromEnv(env, canonical)!.groupV4, true, "a v4 group cube is accepted and says so");
      assert.equal(cubeFromEnv(env, canonical)!.groupV4 && cubeFromEnv({ ...env, NIBRS_CUBE: "shadow" }, canonical)!.groupV4, true);
      write({ ...v4, groups_file_sha256: GROUPS_FILE_SHA256 });
      assert.equal(cubeFromEnv(env, canonical), null, "v4 name with the v2 hash");
      write({ ...v4, groups_version: GROUPS_VERSION });
      assert.equal(cubeFromEnv(env, canonical), null, "v2 name with the v4 hash");
      write({ ...v4, unit_attributes: { offender: four, victim: four, arrestee: ["age_bin"] } });
      assert.equal(cubeFromEnv(env, canonical), null, "a v4 manifest that does not list the attributes");
      write({ ...v4, unit_attributes: undefined });
      assert.equal(cubeFromEnv(env, canonical), null, "a v4 manifest with no attribute lists");
      write(good);
      assert.equal(cubeFromEnv(env, canonical)!.groupV4, undefined, "the v2 cube does not carry the v4 attributes");
      // The code cube: its own manifest.
      const codeRoot = path.join(dir, "codecube");
      fs.mkdirSync(path.join(codeRoot, "canonical/cube/data_year=2024"), { recursive: true });
      fs.writeFileSync(path.join(codeRoot, "canonical/cube/data_year=2024/data.parquet"), "x");
      const writeCode = (m: object) => put(path.join(codeRoot, "manifest.json"), m);
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
      // Code cube v2 (cube 3): ethnicity only when the file's version, hash and the manifest's own attribute lists all say so.
      const fourC = ["age_bin", "sex", "race", "ethnicity"];
      const v2 = { ...goodCode, groups_version: CODE_VERSION_V2, groups_file_sha256: CODE_FILE_SHA256_V2, unit_attributes: { offender: fourC, victim: fourC, arrestee: fourC } };
      writeCode(goodCode);
      assert.equal(cubeFromEnv(cenv, canonical)!.code!.ethnicity, undefined, "an unstamped (v1) code cube has no ethnicity");
      writeCode(v2);
      assert.equal(cubeFromEnv(cenv, canonical)!.code!.ethnicity, true, "a code cube v2");
      writeCode({ ...v2, groups_file_sha256: "0".repeat(64) });
      assert.equal(cubeFromEnv(cenv, canonical)!.code!.ethnicity, undefined, "another file: no ethnicity (age, sex, race still served)");
      writeCode({ ...v2, unit_attributes: { offender: four, victim: four, arrestee: ["age_bin", "sex", "race"] } });
      assert.equal(cubeFromEnv(cenv, canonical)!.code!.ethnicity, undefined, "the manifest does not list ethnicity for every unit");
      // The offense-and-incident cube (cube 1): its own schema, file hash, product stamp, attribute list, counting contract and codes.
      const offRoot = path.join(dir, "offcube");
      fs.mkdirSync(path.join(offRoot, "canonical/cube/data_year=2024"), { recursive: true });
      fs.writeFileSync(path.join(offRoot, "canonical/cube/data_year=2024/data.parquet"), "x");
      const writeOff = (m: object) => put(path.join(offRoot, "manifest.json"), m);
      const goodOff = { schema_version: "cube-offense-0.1", product: "offense", source_manifest_sha256: sha, groups_version: OFFENSE_VERSION_V1, groups_file_sha256: OFFENSE_FILE_SHA256_V1,
        unit_attributes: { offense: ["incident_hour", "location_type", "clearance_type"] }, counting_contract: "Offenses add across codes.", reference_codes: ["120", "13A"], unlisted_codes: ["9ZZ"],
        years: { "2024": {} }, files: { "canonical/cube/data_year=2024/data.parquet": {} } };
      const oenv = { NIBRS_CUBE: "on", NIBRS_OFFENSE_CUBE_ROOT: offRoot };
      writeOff(goodOff);
      const off = cubeFromEnv(oenv, canonical)!.offense!;
      assert.deepEqual(off.years, [2024]);
      assert.ok(off.codes.has("120") && off.codes.has("9ZZ") && !off.codes.has("13B"), "the listed codes and the unlisted codes the build found");
      assert.deepEqual(off.attributes, ["incident_hour", "location_type", "clearance_type"]);
      // The weapon cube (its own schema, file hash and product stamp).
      const wRoot = path.join(dir, "wpncube");
      fs.mkdirSync(path.join(wRoot, "canonical/cube/data_year=2024"), { recursive: true });
      fs.writeFileSync(path.join(wRoot, "canonical/cube/data_year=2024/data.parquet"), "x");
      const writeW = (m: object) => put(path.join(wRoot, "manifest.json"), m);
      const goodW = { schema_version: "cube-weapon-0.1", product: "weapon", source_manifest_sha256: sha, groups_version: WEAPON_VERSION_V1, groups_file_sha256: WEAPON_FILE_SHA256_V1,
        unit_attributes: { offense: ["weapon", "firearm"] }, counting_contract: "Offenses never add across weapon values.", reference_codes: ["09A", "13A"], unlisted_codes: [],
        years: { "2024": {} }, files: { "canonical/cube/data_year=2024/data.parquet": {} } };
      const wenv = { NIBRS_CUBE: "on", NIBRS_WEAPON_CUBE_ROOT: wRoot };
      writeW(goodW);
      const wp = cubeFromEnv(wenv, canonical)!.weapon!;
      assert.deepEqual([wp.years, wp.attributes], [[2024], ["weapon", "firearm"]]);
      assert.ok(wp.codes.has("09A") && !wp.codes.has("120"));
      for (const [bad, why] of [[{ product: "offense" }, "another product"], [{ groups_file_sha256: OFFENSE_FILE_SHA256_V1 }, "the offense cube's file"], [{ schema_version: "cube-offense-0.1" }, "another schema"],
        [{ source_manifest_sha256: "0".repeat(64) }, "another release"], [{ counting_contract: undefined }, "no counting contract"], [{ unit_attributes: { offense: ["weapon"] } }, "firearm missing"]] as const) {
        writeW({ ...goodW, ...bad });
        assert.equal(cubeFromEnv(wenv, canonical), null, `the weapon cube is left out: ${why}`);
      }
      writeOff(goodOff);
      assert.equal(cubeFromEnv({ ...oenv, NIBRS_WEAPON_CUBE_ROOT: wRoot }, canonical)!.weapon, undefined, "a bad weapon cube leaves the offense cube in use");
      for (const [bad, why] of [[{ product: "weapon" }, "another product"], [{ groups_file_sha256: "0".repeat(64) }, "another groups file (the weapon cube's)"], [{ groups_version: "x" }, "another version"],
        [{ schema_version: "cube-code-0.1" }, "another schema"], [{ source_manifest_sha256: "0".repeat(64) }, "another release"], [{ counting_contract: undefined }, "no counting contract"],
        [{ unit_attributes: { offense: ["incident_hour"] } }, "attributes missing"], [{ reference_codes: undefined }, "no codes"]] as const) {
        writeOff({ ...goodOff, ...bad });
        assert.equal(cubeFromEnv(oenv, canonical), null, `the offense cube is left out: ${why}`);
      }
    } finally { console.error = quiet; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- A cube SET (the Model's monthly wrapper): one pinned manifest names every product; READY required; a product that fails its pins is left out.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nibrs-cube-set-"));
  const quiet = console.error; const warnings: string[] = []; console.error = (m: string) => { warnings.push(String(m)); };
  let tick = 1_900_000_000; // fixed, increasing modification times (no clock read): the loader caches on mtime and size
  const write = (file: string, content: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); tick += 2; fs.utimesSync(file, tick, tick); };
  const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  try {
    const release = path.join(dir, "release"), canonical = path.join(release, "canonical");
    fs.mkdirSync(canonical, { recursive: true });
    write(path.join(release, "manifest.json"), '{"id":"rel-1"}');
    const relSha = sha(path.join(release, "manifest.json"));
    const four = ["age_bin", "sex", "race", "ethnicity"];
    const groups = Object.fromEntries(Object.entries(CUBE_GROUPS).map(([g, c]) => [g, { codes: c, list_sha256: listSha256(c) }]));
    const base = { source_manifest_sha256: relSha, years: { "2024": {} }, files: { "canonical/cube/data_year=2024/data.parquet": {} } };
    const manifests: Record<string, object> = {
      "group-v4": { ...base, schema_version: "cube-0.1", groups_version: GROUPS_VERSION_V4, groups_file_sha256: GROUPS_FILE_SHA256_V4, groups, unit_attributes: { offender: four, victim: four, arrestee: four } },
      "code-v2": { ...base, schema_version: "cube-code-0.1", never_add_across_codes: true, reference_codes: ["09A"], groups_version: CODE_VERSION_V2, groups_file_sha256: CODE_FILE_SHA256_V2, unit_attributes: { offender: four, victim: four, arrestee: four } },
      "offense-v1": { ...base, schema_version: "cube-offense-0.1", product: "offense", groups_version: OFFENSE_VERSION_V1, groups_file_sha256: OFFENSE_FILE_SHA256_V1, unit_attributes: { offense: ["incident_hour", "location_type", "clearance_type"] }, counting_contract: "x", reference_codes: ["120"] },
      "weapon-v1": { ...base, schema_version: "cube-weapon-0.1", product: "weapon", groups_version: WEAPON_VERSION_V1, groups_file_sha256: WEAPON_FILE_SHA256_V1, unit_attributes: { offense: ["weapon", "firearm"] }, counting_contract: "x", reference_codes: ["120"] },
    };
    const folderOf = (k: string) => `${k}-rel-1`;
    const build = (name: string, over: Record<string, Partial<{ folder: string; status: string; schema_version: string; groups_file_sha256: string; manifest_sha256: string }> | null> = {}, top: object = {}, ready: object | null = {}) => {
      const set: Record<string, unknown> = { set_version: 1, release_id: "rel-1", release_manifest_sha256: relSha, attempt: 1, as_of: "2024-08", complete: true, required_missing: [], optional_missing: [], failures: {}, products: {} };
      for (const [k, m] of Object.entries(manifests)) {
        write(path.join(dir, name, folderOf(k), "manifest.json"), JSON.stringify(m));
        write(path.join(dir, name, folderOf(k), "canonical/cube/data_year=2024/data.parquet"), "x");
        const rec = { folder: folderOf(k), manifest_sha256: sha(path.join(dir, name, folderOf(k), "manifest.json")), schema_version: (m as { schema_version: string }).schema_version,
          groups_file_sha256: (m as { groups_file_sha256: string }).groups_file_sha256, status: "ready", required: k !== "weapon-v1" };
        if (over[k] === null) continue;
        (set.products as Record<string, unknown>)[k] = { ...rec, ...(over[k] ?? {}) };
      }
      Object.assign(set, top);
      const file = path.join(dir, name, "cube-set-rel-1-1.json");
      write(file, JSON.stringify(set));
      if (ready) write(file.replace(/\.json$/, ".READY.json"), JSON.stringify({ status: "ready", set_manifest_sha256: sha(file), release_id: "rel-1", written_at: "x", ...ready }));
      return { file, sha: sha(file), env: { NIBRS_CUBE: "on", NIBRS_CUBE_SET: file, NIBRS_CUBE_SET_SHA256: sha(file) } };
    };
    // A good set: all four products read, each from its own folder.
    let t = build("good");
    const c = cubeFromEnv(t.env, canonical)!;
    assert.ok(c && c.groupV4 && c.code?.ethnicity && c.offense && c.weapon, "a complete set gives all four cubes");
    assert.ok(c.root.endsWith("group-v4-rel-1") && c.offense!.root.endsWith("offense-v1-rel-1"), "each product reads from its folder beside the set manifest");
    assert.deepEqual(c.years, [2024]);
    // The set is pinned by hash; no hash, a wrong hash, a changed file: no set.
    assert.equal(cubeFromEnv({ ...t.env, NIBRS_CUBE_SET_SHA256: undefined }, canonical), null, "no pin: refused");
    assert.equal(cubeFromEnv({ ...t.env, NIBRS_CUBE_SET_SHA256: "0".repeat(64) }, canonical), null, "another hash: refused");
    // READY, completeness and release.
    t = build("noready", {}, {}, null);
    assert.equal(cubeFromEnv(t.env, canonical), null, "no READY file: refused");
    t = build("badready", {}, {}, { set_manifest_sha256: "0".repeat(64) });
    assert.equal(cubeFromEnv(t.env, canonical), null, "a READY file for another set: refused");
    t = build("badreadyrel", {}, {}, { release_id: "rel-9" });
    assert.equal(cubeFromEnv(t.env, canonical), null, "a READY file for another release id: refused");
    t = build("incomplete", {}, { complete: false });
    assert.equal(cubeFromEnv(t.env, canonical), null, "an incomplete set: refused");
    t = build("reqmissing", {}, { required_missing: ["code-v2"] });
    assert.equal(cubeFromEnv(t.env, canonical), null, "a required product missing: refused");
    t = build("ver2", {}, { set_version: 2 });
    assert.equal(cubeFromEnv(t.env, canonical), null, "another set version: refused");
    t = build("otherrelease", {}, { release_manifest_sha256: "0".repeat(64) });
    assert.equal(cubeFromEnv(t.env, canonical), null, "built from another release than the one read: refused");
    // A product that is absent or fails its pins is left out with a warning; the others stay.
    warnings.length = 0;
    t = build("noweapon", { "weapon-v1": null });
    let n = cubeFromEnv(t.env, canonical)!;
    assert.ok(n.offense && n.code && !n.weapon, "an absent optional product is left out");
    assert.ok(warnings.some((w) => /weapon-v1 is not in the set/.test(w)), "and said once");
    t = build("badmanifest", { "offense-v1": { manifest_sha256: "0".repeat(64) } });
    n = cubeFromEnv(t.env, canonical)!;
    assert.ok(!n.offense && n.weapon && n.code, "a product whose manifest is not the recorded one is left out");
    t = build("badschema", { "weapon-v1": { schema_version: "cube-weapon-9" } });
    assert.ok(!cubeFromEnv(t.env, canonical)!.weapon, "another schema: left out");
    t = build("badgroups", { "code-v2": { groups_file_sha256: "0".repeat(64) } });
    assert.ok(!cubeFromEnv(t.env, canonical)!.code, "another groups file: left out");
    t = build("notready", { "weapon-v1": { status: "failed" } });
    assert.ok(!cubeFromEnv(t.env, canonical)!.weapon, "a product that is not ready: left out");
    for (const folder of ["../elsewhere", "/abs/path", "C:/abs", "a/../../b"]) {
      t = build("trav" + folder.replace(/\W/g, "_"), { "offense-v1": { folder } });
      assert.ok(!cubeFromEnv(t.env, canonical)!.offense, `a folder that leaves the set's folder is refused: ${folder}`);
    }
    // An unknown product key is ignored; an explicit root variable overrides its product.
    t = build("unknown");
    const raw = JSON.parse(fs.readFileSync(t.file, "utf8")); raw.products["relationship-v1"] = { folder: "x", status: "ready" };
    write(t.file, JSON.stringify(raw)); write(t.file.replace(/\.json$/, ".READY.json"), JSON.stringify({ status: "ready", set_manifest_sha256: sha(t.file), release_id: "rel-1" }));
    assert.ok(cubeFromEnv({ ...t.env, NIBRS_CUBE_SET_SHA256: sha(t.file) }, canonical)!.offense, "an unknown product key is ignored");
    t = build("override");
    const other = path.join(dir, "good", "weapon-v1-rel-1");
    const ov = cubeFromEnv({ ...t.env, NIBRS_WEAPON_CUBE_ROOT: other }, canonical)!;
    assert.equal(ov.weapon!.root, other.replace(/\\/g, "/"), "an explicit root variable overrides the set's folder for that product");
    // The set alone, no release known: refused (each product is bound to the release it was built from).
    assert.equal(cubeFromEnv(t.env, undefined), null, "no release being read: refused");
  } finally { console.error = quiet; fs.rmSync(dir, { recursive: true, force: true }); }
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
const CUBE = process.env.NIBRS_CUBE_TEST_CUBE, CODE_CUBE = process.env.NIBRS_CUBE_TEST_CODE_CUBE, OFFENSE_CUBE = process.env.NIBRS_CUBE_TEST_OFFENSE_CUBE, WEAPON_CUBE = process.env.NIBRS_CUBE_TEST_WEAPON_CUBE, ROOT = process.env.NIBRS_CUBE_TEST_ROOT;
if ((CUBE || CODE_CUBE || OFFENSE_CUBE || WEAPON_CUBE) && ROOT && fs.existsSync(`${CUBE ?? CODE_CUBE ?? OFFENSE_CUBE ?? WEAPON_CUBE}/manifest.json`)) {
  const run = async () => {
    const { shadowAnswer } = await import("../lib/nibrs-shadow/answer");
    const { loadPlaceIndex } = await import("../lib/nibrs-shadow/places");
    const { duckdbExecutor } = await import("../lib/nibrs-shadow/duckdb");
    const { loadNibrsRelease } = await import("../lib/nibrs-shadow/release");
    const { cubeFromEnv } = await import("../lib/nibrs-plan/cube");
    // NIBRS_CUBE_TEST_RELEASE_FILE: the release.json of another release than the checkout's (a laptop with an older release); NIBRS_CUBE_TEST_YEARS: the built
    // years (comma separated) when the cubes hold fewer than the release (a stand-in cube of 2024 to 2026).
    const rel = loadNibrsRelease(process.env.NIBRS_CUBE_TEST_RELEASE_FILE, ROOT);
    const builtYears = (process.env.NIBRS_CUBE_TEST_YEARS ?? "2017,2018,2019,2020,2021,2022,2023,2024,2025,2026").split(",").map(Number);
    const r = { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: "2026-10-29" };
    const executed: string[] = [];
    const exec = duckdbExecutor(process.env.NIBRS_CUBE_TEST_PYTHON ?? "C:/Users/jeffm/nibrs-model/.venv/Scripts/python.exe");
    const execute = (sql: string) => { executed.push(sql); return exec(sql); };
    const cubeCfg = cubeFromEnv({ NIBRS_CUBE: "on", NIBRS_CUBE_ROOT: CUBE, NIBRS_CODE_CUBE_ROOT: CODE_CUBE, NIBRS_OFFENSE_CUBE_ROOT: OFFENSE_CUBE, NIBRS_WEAPON_CUBE_ROOT: WEAPON_CUBE }, ROOT);
    assert.ok(cubeCfg, "the cube folder is readable");
    const mk = (cube: CubeConfig | null) => ({ places: loadPlaceIndex(), release: r, target: { root: ROOT, builtYears, cube }, execute });
    // NIBRS_CUBE_TEST_QUESTIONS_FILE: one question per line (blank lines and lines starting with # skipped); added to NIBRS_CUBE_TEST_QUESTIONS.
    const fromFile = process.env.NIBRS_CUBE_TEST_QUESTIONS_FILE ? fs.readFileSync(process.env.NIBRS_CUBE_TEST_QUESTIONS_FILE, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
    const questions = [...(process.env.NIBRS_CUBE_TEST_QUESTIONS ?? "").split("|").filter(Boolean), ...fromFile];
    // NIBRS_CUBE_TEST_MIN_SERVED: how many questions must come from the cube (default 1); the runner sets it to the list's expected count.
    const minServed = Number(process.env.NIBRS_CUBE_TEST_MIN_SERVED ?? "1");
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
    console.log(`  ${served} of ${questions.length} questions read from the cube`);
    if (questions.length) assert.ok(served >= Math.max(1, minServed), `at least ${Math.max(1, minServed)} question(s) read from the cube (got ${served})`);
  };
  run().then(() => console.log("nibrs cube: cell-by-cell comparison done"), (e) => { console.error(e); process.exit(1); });
} else console.log("(no release or cube named: the cell-by-cell comparison is skipped)");
