/**
 * Counts how the cached Gemini proposals fare in the validator (plan 3 step 1), without printing any question text:
 * accepted, refused by reason, and attempts that never got an answer. Read-only; no model calls.
 *
 *   npx tsx scripts/check-gemini-readings.ts --cache <readings.json> [--year 2026]
 */
import fs from "node:fs";
import { validateProposal } from "../lib/nibrs-shadow/gemini-reader";
import type { ReadingCache } from "./fetch-gemini-readings";

const arg = (name: string, dflt?: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const store = JSON.parse(fs.readFileSync(arg("--cache")!, "utf8")) as ReadingCache;
const year = Number(arg("--year", "2026"));
const out: Record<string, number> = {};
const add = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
for (const e of Object.values(store.entries)) {
  if (!e.done) { add("not done (an attempt left)"); continue; }
  if (!e.proposal) { add(e.usage.input > 0 ? "unparsed" : "no answer (network or rate limit)"); continue; }
  const v = validateProposal(e.proposal, e.question, year);
  add(v.ok ? "accepted" : `refused: ${v.reason}`);
}
console.log(`entries ${Object.keys(store.entries).length}; spent $${store.spent.toFixed(4)} + $${store.unresolved.toFixed(4)} unresolved`);
console.log(JSON.stringify(out));
