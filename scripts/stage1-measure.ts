/**
 * Engine service sizing (stage 1 scope, section 3): wall time and peak memory of engine questions under the proposed caps, on a Windows runner. Measurement only: nothing here is a
 * deployment setting. The caps (DuckDB memory limit and threads per worker) are arguments; the CPU limit is applied outside, to the shell that runs this:
 *     start /affinity 3 /low powershell      (two logical CPUs, Idle priority)
 * Every question runs in its own child process with a FRESH DuckDB executor (as a worker restarted for each question; a worker kept alive is a little faster after its first question).
 * Nothing else may run beside it. Use an empty working folder and no SQL cache. The runner relays the CSV.
 *
 * Scenarios (--scenario):
 *   serial   run every id one at a time, for each --memory value and each --cube setting: seconds, peak DuckDB-process MB, kind (heavy 53: --ids heavy_ids_dev.txt).
 *   pair     run the two ids of --ids AT ONCE (two workers, each with its own --memory): seconds each, the pair's wall time, the sum of the two peaks.
 *   queue    layout A or B (--layout): the first id (a raw national) and then the rest (cube questions) through a two-worker queue; each task's wait and run time.
 *              A = two identical workers at the first --memory value; B = a raw worker at the first value and a cube-only worker at the second (the cube-only worker is simulated: tasks
 *              in --cubeids go to it, the others to the raw worker).
 *
 *   npx tsx scripts/stage1-measure.ts --scenario serial --labels scripts/fixtures/answer-eval/qlog-labels.json --ids C:/runner/scorecard/heavy_ids_dev.txt \
 *     --root <canonical> --release-file <release.json> --python <python with duckdb> --memory 2GB,2.5GB,3GB --threads 1 --cube off,on --out serial.csv
 *
 * The four cube roots come from the engine's own variables (NIBRS_CUBE_ROOT, NIBRS_CODE_CUBE_ROOT, NIBRS_OFFENSE_CUBE_ROOT, NIBRS_WEAPON_CUBE_ROOT) when --cube on.
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { shadowAnswer, shadowFollowUp, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";
import { cubeFromEnv } from "../lib/nibrs-plan/cube";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
type Label = { id: string; question: string; previous?: string | null; kind?: string };
const loadLabels = (file: string): Map<string, Label> => { const d = JSON.parse(fs.readFileSync(file, "utf8")); return new Map((Array.isArray(d) ? d : d.labels).map((l: Label) => [l.id, l])); };
const idsOf = (file: string) => fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
type Row = { scenario: string; id: string; cube: string; memory: string; threads: string; seconds: number; peakMb: number; nodeMb: number; kind: string; error: string; waitSeconds?: number; worker?: string };

/** The peak working set (MB) of the python processes this process started (the DuckDB server). */
function peakChildMb(): number {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).PeakWorkingSet64 } | Measure-Object -Maximum).Maximum`], { encoding: "utf8" });
    return Math.round((Number(out.trim()) || 0) / 1048576);
  } catch { return -1; }
}

/** CHILD: one question with a fresh executor; prints one JSON line. */
async function runOne(): Promise<void> {
  const labels = loadLabels(arg("--labels")!);
  const l = labels.get(arg("--one")!);
  const root = arg("--root")!, python = arg("--python")!, memory = arg("--memory", "3GB")!, threads = Number(arg("--threads", "1")), cubeOn = arg("--cube", "off") === "on";
  const { released: _r, ...release } = loadNibrsRelease(arg("--release-file"), root);
  const cube = cubeOn ? cubeFromEnv({ ...process.env, NIBRS_CUBE: "on" }, root) : null;
  const exec = duckdbExecutor(python, { memoryLimit: memory, threads, timeoutMs: Number(arg("--timeout-ms", "900000")) });
  const deps = { places: loadPlaceIndex(), release: { ...release, asOf: "2026-11-04" }, target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], arrestYears: [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026], cube }, execute: exec } as unknown as ShadowDeps;
  const t0 = performance.now();
  let kind = "", error = "";
  try {
    if (!l) throw new Error(`label ${arg("--one")} is not in the labels file`);
    const o = l.kind === "follow-up" && l.previous ? shadowFollowUp(l.previous, l.question, deps) : shadowAnswer(l.question, deps);
    kind = (await Promise.resolve(o as { kind: string })).kind;
  } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 120).replace(/[\r\n,]+/g, " "); }
  const seconds = (performance.now() - t0) / 1000;
  const row: Row = { scenario: arg("--scenario", "")!, id: arg("--one")!, cube: cubeOn ? "on" : "off", memory, threads: String(threads), seconds: Math.round(seconds * 10) / 10, peakMb: peakChildMb(), nodeMb: Math.round(process.resourceUsage().maxRSS / 1024), kind, error };
  exec.close();
  console.log("ROW " + JSON.stringify(row));
}

/** PARENT: start a child and resolve with its row. */
function child(id: string, memory: string, cube: string, extra: Partial<Row> = {}): Promise<Row> {
  const a = ["--one", id, "--memory", memory, "--cube", cube, "--threads", arg("--threads", "1")!, "--labels", arg("--labels")!, "--root", arg("--root")!, "--python", arg("--python")!,
    ...(arg("--release-file") ? ["--release-file", arg("--release-file")!] : []), "--scenario", arg("--scenario", "")!];
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [...process.execArgv, process.argv[1], ...a], { stdio: ["ignore", "pipe", "inherit"], env: process.env });
    let buf = "";
    p.stdout.on("data", (d) => { buf += d; });
    p.on("close", () => {
      const m = buf.split("\n").find((x) => x.startsWith("ROW "));
      resolve(m ? { ...JSON.parse(m.slice(4)), ...extra } : { scenario: "", id, cube, memory, threads: "", seconds: -1, peakMb: -1, nodeMb: -1, kind: "", error: "child produced no row", ...extra });
    });
  });
}

const HEADER = "scenario,id,cube,memory,threads,seconds,peakMb,nodeMb,kind,error,waitSeconds,worker";
const line = (r: Row) => [r.scenario, r.id, r.cube, r.memory, r.threads, r.seconds, r.peakMb, r.nodeMb, r.kind, r.error, r.waitSeconds ?? "", r.worker ?? ""].join(",");
const out = (rows: Row[]) => { const text = [HEADER, ...rows.map(line)].join("\n") + "\n"; if (arg("--out")) fs.writeFileSync(arg("--out")!, text); console.log(text); };

async function main(): Promise<void> {
  if (arg("--one")) return runOne();
  const scenario = arg("--scenario")!;
  const ids = idsOf(arg("--ids")!);
  const mems = (arg("--memory", "2GB")!).split(",");
  const cubes = (arg("--cube", "off")!).split(",");
  const rows: Row[] = [];
  if (scenario === "serial") {
    for (const mem of mems) for (const cube of cubes) for (const id of ids) { const r = await child(id, mem, cube); rows.push(r); console.error(`${mem} ${cube} ${id}: ${r.seconds}s peak ${r.peakMb} MB ${r.kind}${r.error ? " ERROR " + r.error : ""}`); }
    return out(rows);
  }
  if (scenario === "pair") {
    if (ids.length < 2) throw new Error("--ids needs two ids for the pair scenario");
    for (const mem of mems) for (const cube of cubes) {
      const t0 = performance.now();
      const pair = await Promise.all([child(ids[0], mem, cube, { worker: "1" }), child(ids[1], mem, cube, { worker: "2" })]);
      const wall = Math.round((performance.now() - t0) / 100) / 10;
      pair.forEach((r) => { r.waitSeconds = wall; rows.push(r); });
      console.error(`${mem} ${cube}: pair wall ${wall}s, peaks ${pair.map((r) => r.peakMb).join("+")} = ${pair.reduce((s, r) => s + Math.max(0, r.peakMb), 0)} MB`);
    }
    return out(rows);
  }
  if (scenario === "queue") {
    const layout = arg("--layout", "A")!;
    const cubeIds = new Set(idsOf(arg("--cubeids", arg("--ids")!)!).filter((x) => x !== ids[0]));
    const workers = layout === "B" ? [{ name: "raw", mem: mems[0] }, { name: "cube-only", mem: mems[1] ?? "1GB" }] : [{ name: "w1", mem: mems[0] }, { name: "w2", mem: mems[0] }];
    const queue = ids.map((id, i) => ({ id, t: 0, order: i }));
    const t0 = performance.now();
    const free = new Set(workers.map((w) => w.name));
    await new Promise<void>((resolve) => {
      const pump = () => {
        for (const w of workers) {
          if (!free.has(w.name)) continue;
          // layout B: the cube-only worker takes cube questions only; the raw worker takes anything
          const i = queue.findIndex((q) => layout !== "B" || w.name === "raw" || cubeIds.has(q.id));
          if (i < 0) continue;
          const task = queue.splice(i, 1)[0];
          free.delete(w.name);
          const started = (performance.now() - t0) / 1000;
          child(task.id, w.mem, arg("--cube", "on")!.split(",")[0], { worker: w.name, waitSeconds: Math.round(started * 10) / 10 }).then((r) => { rows.push(r); free.add(w.name); pump(); });
        }
        if (!queue.length && free.size === workers.length) resolve();
      };
      pump();
    });
    console.error(`queue layout ${layout}: total ${(Math.round((performance.now() - t0) / 100) / 10)}s`);
    return out(rows);
  }
  throw new Error("--scenario is serial, pair or queue");
}
main().catch((e) => { console.error(e); process.exit(1); });
