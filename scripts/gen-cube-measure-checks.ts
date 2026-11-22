/**
 * The cube's measure guard, generator (correctness work 2b): decides, from the router itself and with NO data, which measures the cubes may serve, and writes
 *   lib/nibrs-plan/cube-measures.json                         approved measures (each with the questions that prove a cube statement is built for it) and raw measures (with the reason)
 *   scripts/fixtures/nibrs-cube-measures-questions.txt        the approved measures' questions in Memphis, for the runner's cell-by-cell comparison (cube against raw)
 *   scripts/fixtures/nibrs-cube-shadow-questions.txt          the same forms for real places of different sizes (a big city, a mid-size city, a small town, a tiny agency, a state, the nation)
 *
 *   npx tsx scripts/gen-cube-measure-checks.ts
 *
 * How a measure is approved: a question about it is read by the engine's own reader and compiled against a stand-in cube configuration that holds every code and attribute; the measure
 * is approved when at least one of its question forms produces a statement that reads a cube (and raw otherwise). The runner then proves the VALUES: the same questions run with
 * the cubes and without, whole answers compared (scripts/test-nibrs-cube.ts with NIBRS_CUBE_TEST_QUESTIONS_FILE), and shadow mode (NIBRS_CUBE=shadow) over the shadow list logs any
 * difference. scripts/test-cube-measure-guard.ts keeps the three files and the router in step: a new measure that is not classified, or a router change that starts serving a raw
 * measure, fails there.
 */
import fs from "node:fs";
import path from "node:path";
import { knownMeasureNames } from "../lib/nibrs-plan/compile";
import type { CubeConfig } from "../lib/nibrs-plan/cube";
import { MEASURE_CODES, MEASURE_LABEL } from "../lib/nibrs-question-types";
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { stand_in_cube, routesToCube } from "./lib/cube-routing-probe";
import { FORMS, MEASURE_NOUNS, MEMPHIS, YEAR } from "./lib/cube-measure-forms";

function main(): void {
  const places = loadPlaceIndex();
  const rel = loadNibrsRelease();
  const names = knownMeasureNames();
  const cfg: CubeConfig = stand_in_cube(Object.values(MEASURE_CODES).flat().concat(["35A", "35B"]), [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  const deps = (record: string[]): ShadowDeps => ({ places, release: { id: rel.id, firstMonth: rel.firstMonth, lastMonth: rel.lastMonth, asOf: "2026-11-04" },
    target: { root: "/stand-in/canonical", builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], cube: cfg, cubeAllMeasures: true },
    execute: (sql: string) => { record.push(sql); return []; } }) as unknown as ShadowDeps;
  const probe = (q: string) => routesToCube(() => shadowAnswer(q, deps(sqls)), sqls);
  const sqls: string[] = [];

  const approved: Record<string, { questions: string[] }> = {}, raw: Record<string, string> = {};
  for (const m of names) {
    const nouns = [...(MEASURE_NOUNS[m] ?? []), ...(MEASURE_NOUNS[m] && MEASURE_LABEL[m] ? [MEASURE_LABEL[m]] : [])];
    if (!MEASURE_NOUNS[m]) { raw[m] = "no question form: the measure has no plain noun the reader takes (a special family: its definition is more than its codes)"; continue; }
    // One served form per family (victims, offenders, arrests, offenses, incidents) where one exists, so each kind of cube statement a measure can reach is checked.
    const served: string[] = [], seen = new Set<string>();
    for (const n of nouns) for (const form of FORMS(n, MEMPHIS, YEAR)) { if (!seen.has(form.family) && probe(form.q)) { seen.add(form.family); served.push(form.q); } }
    if (served.length) approved[m] = { questions: served };
    else raw[m] = "no question form reaches a cube (the cube holds nothing for it, or its forms are not in the reader): it runs from the raw statements";
  }
  // Special measures never go to a cube, whatever a form does: the router refuses them by name (compile.ts cubeServesMeasure); here they are listed with the reason.
  for (const [m, why] of Object.entries({ justifiable_homicide: "no cell-by-cell cube check yet (09C)", domestic_violence: "its definition is more than its codes (P82: the incident holds the offense, a domestic relationship pair)",
    carjacking: "its definition is more than its codes (a stolen vehicle on the incident)", hate_crime: "its definition is more than its codes", motor_vehicle_property: "its definition is more than its codes", property_value: "its definition is more than its codes" }))
    if (names.includes(m)) { delete approved[m]; raw[m] = why; }

  const out = { _comment: "Written by scripts/gen-cube-measure-checks.ts; kept in step with the router by scripts/test-cube-measure-guard.ts. A measure is `approved` only with the questions that prove a cube statement is built for it and that the runner compares against raw.", approved, raw };
  fs.writeFileSync("lib/nibrs-plan/cube-measures.json", JSON.stringify(out, null, 2) + "\n");

  const memphis = Object.entries(approved).flatMap(([, v]) => v.questions);
  fs.writeFileSync("scripts/fixtures/nibrs-cube-measures-questions.txt",
    `# Every approved measure's cube questions (Memphis, ${YEAR}): the runner compares each against raw, whole answers (NIBRS_CUBE_TEST_QUESTIONS_FILE, all four cubes, MIN_SERVED ${memphis.length}).\n# Written by scripts/gen-cube-measure-checks.ts; ${memphis.length} questions for ${Object.keys(approved).length} measures.\n${memphis.join("\n")}\n`);

  // Real places of different sizes for the shadow comparison: the first agency by ORI in each population band that reports to NIBRS, a state and the nation.
  type Ag = { ori: string; kind: string; name: string; state: string; population: number; sources?: string[] };
  const agencies = (JSON.parse(fs.readFileSync("scripts/fixtures/nibrs-shadow/agencies.json", "utf8")) as { agencies: Ag[] }).agencies;
  const city = agencies.filter((a) => a.kind === "city" && (a.sources ?? []).includes("nibrs") && a.population > 0).sort((a, b) => a.ori.localeCompare(b.ori));
  const band = (lo: number, hi: number) => city.find((a) => a.population >= lo && a.population < hi);
  const picks = [[1_000_000, 10_000_000, "a big city"], [60_000, 120_000, "a mid-size city"], [5_000, 10_000, "a small town"], [200, 1_000, "a tiny agency"]] as const;
  const placeNames: string[] = [];
  for (const [lo, hi] of picks) { const a = band(lo, hi); if (a) placeNames.push(`${a.name}, ${a.state}`); }
  placeNames.push("Ohio", "the United States");
  const shadow: string[] = [];
  for (const [, v] of Object.entries(approved)) for (const q of v.questions) for (const p of placeNames) shadow.push(q.replace(MEMPHIS, p));
  fs.writeFileSync("scripts/fixtures/nibrs-cube-shadow-questions.txt",
    `# The approved measures' cube forms for real places of different sizes (${placeNames.join("; ")}), ${YEAR}: run with NIBRS_CUBE=shadow and NIBRS_CUBE_LOG set (any line in the log is a difference), or through scripts/test-nibrs-cube.ts.\n# Written by scripts/gen-cube-measure-checks.ts; ${shadow.length} questions. Questions the reader or the data decline are counted by the runner, not failures.\n${shadow.join("\n")}\n`);
  console.log(`approved ${Object.keys(approved).length} measures (${memphis.length} questions), raw ${Object.keys(raw).length}; shadow list ${shadow.length} questions over ${placeNames.length} places: ${placeNames.join(" | ")}`);
}
void path;
main();
