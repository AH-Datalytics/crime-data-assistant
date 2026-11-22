/**
 * The size of the Consistent Reporting Agencies sets over a release (P121, Jeff's audit batch 2, 2026-11-22), asked of the engine the way a user would:
 *   crime questions: an agency is in only if EVERY month of the span has at least one Group A row (a formal zero report or a Group B-only month excludes it);
 *   arrest questions: a month counts when the agency reported crimes or has any arrest that month.
 *
 *   npx tsx scripts/check-consistent-reporting-agencies.ts --root <canonical dir> --historical <crime index build> --python <python with duckdb>
 *     [--expect-crime 3291] [--expect-arrest 3706] [--from 2017] [--to 2025]
 *
 * Prints both sizes and exits 1 when one differs from its --expect. The 3,291 and 3,706 are the Runner's and Model's independent counts for 2017-2025 on
 * canon2-20261118-host; they are not constants of the engine, so a new release needs new expected numbers. Idle priority, a few minutes; reads the release only.
 */
import { shadowAnswer, type ShadowDeps } from "../lib/nibrs-shadow/answer";
import { loadPlaceIndex } from "../lib/nibrs-shadow/places";
import { duckdbExecutor } from "../lib/nibrs-shadow/duckdb";
import { historicalBuildAt } from "../lib/nibrs-shadow/historical";
import { currentBuildAt } from "../lib/nibrs-shadow/current";
import { loadNibrsRelease } from "../lib/nibrs-shadow/release";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const root = arg("--root")!, crimeIndex = arg("--historical")!, python = arg("--python", "python")!;
if (!root || !crimeIndex) throw new Error("--root and --historical are required");
const [from, to] = [arg("--from", "2017"), arg("--to", "2025")];
try { (require("node:os") as typeof import("node:os")).setPriority(19); } catch { /* not everywhere */ }
const { released: _r, ...release } = loadNibrsRelease(undefined, root);
const execute = duckdbExecutor(python, { timeoutMs: 900_000, memoryLimit: "8GB", threads: 4 });
const deps = { places: loadPlaceIndex(), release: { ...release, asOf: new Date().toISOString().slice(0, 10) },
  target: { root, builtYears: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026] },
  execute, historical: historicalBuildAt(crimeIndex), current: currentBuildAt(crimeIndex, execute) } as ShadowDeps;
const sizeOf = (question: string): number => {
  const a = shadowAnswer(question, deps) as unknown as { kind: string; stateSum?: { everyAgencies: number } };
  if (a.kind !== "answer" || !a.stateSum) throw new Error(`"${question}" gave ${a.kind}, not a state sum`);
  return a.stateSum.everyAgencies;
};
const crime = sizeOf(`aggravated assault victims in the United States by year from ${from} to ${to} according to NIBRS`);
const arrest = sizeOf(`arrests in the United States by year from ${from} to ${to} according to NIBRS`);
console.log(`Consistent Reporting Agencies ${from}-${to}: crime questions ${crime}, arrest questions ${arrest}`);
const want = (n: string) => (arg(n) ? Number(arg(n)) : null);
let bad = 0;
for (const [name, got, exp] of [["crime", crime, want("--expect-crime")], ["arrest", arrest, want("--expect-arrest")]] as const)
  if (exp !== null && got !== exp) { console.log(`  ${name}: ${got}, expected ${exp}`); bad++; }
execute.close();
process.exit(bad ? 1 : 0);
