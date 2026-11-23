/**
 * Read-only probe of the engine service's adapter against real data folders. Builds the same core the service builds (lib/engine-service/core.ts),
 * prints info() (base and each source loaded or failed with its reason), then asks one real question per tab and prints the answer.
 * Writes nothing; DuckDB only reads the folders. Run from the repo root (it reads scripts/fixtures/nibrs-shadow/*.json from the working directory).
 *
 *   npx tsx scripts/probe-engine-service.ts --nibrs <canonical> --crime-index <dir> --shr <dir> --hate <dir> --python <python with duckdb>
 *   optional: --question tab=text (repeatable) replaces that tab's question; --memory 2GB; --threads 1
 * Exit code: 0 when every tab answered, 1 when any tab did not.
 */
import { configFromEnv, createCore, type CoreConfig } from "../lib/engine-service/core";

const args = process.argv.slice(2);
const one = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const many = (name: string) => args.flatMap((a, i) => (a === `--${name}` && args[i + 1] ? [args[i + 1]] : []));

const roots: CoreConfig["roots"] = {};
const nibrs = one("nibrs"), ci = one("crime-index"), shr = one("shr"), hate = one("hate");
if (nibrs) roots.nibrs = nibrs;
if (ci) roots.crimeIndex = ci;
if (shr) roots.shr = shr;
if (hate) roots.hate = hate;
if (!roots.nibrs) { console.error("usage: probe-engine-service.ts --nibrs <canonical> [--crime-index <dir>] [--shr <dir>] [--hate <dir>] [--python <python>]"); process.exit(2); }

const cfg: CoreConfig = { ...configFromEnv({}), roots, python: one("python") ?? "python3", memoryLimit: one("memory") ?? "2GB", threads: Number(one("threads") ?? "1") || 1, timeoutMs: 120000 };
const QUESTIONS: Record<string, string> = {
  nibrs: "Robberies in Texas in 2024",
  historical: "Murders in the United States in 2019",
  current: "Murders in Chicago in 2024",
  shr: "Murders in Texas in 2022",
  hate_crime: "Hate crimes in Texas in 2023",
};
for (const q of many("question")) { const [tab, ...rest] = q.split("="); if (tab && rest.length) QUESTIONS[tab] = rest.join("="); }

const core = createCore(cfg);
let bad = 0;
console.log("== info() ==");
console.log(JSON.stringify(core.info(), null, 2));
const tabs = (core.info().tabs as string[]) ?? [];
for (const tab of ["nibrs", "historical", "current", "shr", "hate_crime"]) {
  console.log(`\n== ${tab} ==`);
  if (!tabs.includes(tab)) { console.log("not configured (no root for its source)"); if (tab !== "nibrs") continue; }
  const question = QUESTIONS[tab];
  const t0 = Date.now();
  const r = core.answer({ tab, question, path: [] });
  const ms = Date.now() - t0;
  console.log(`question: ${question}\nms: ${ms}`);
  if (r.ok) {
    const text = JSON.stringify(r.response);
    console.log(`result: ANSWERED, release ${r.release}, sql: ${r.sql ? "yes" : "none"}\nresponse: ${text.length > 1500 ? text.slice(0, 1500) + " ...[cut]" : text}`);
  } else { bad++; console.log(`result: ${r.kind}: ${r.message}`); }
}
console.log("\n== info() after the questions ==");
console.log(JSON.stringify(core.info(), null, 2));
core.close();
process.exit(bad ? 1 : 0);