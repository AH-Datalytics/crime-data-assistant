/**
 * The runner's compare step (docs/runbooks/verify-new-answers.md): the blind checker's values against the requests'.
 *
 *   npx tsx scripts/compare-verify-expected.ts --requests <requests.jsonl> --expected <expected.jsonl> --out <results.jsonl>
 *
 * Writes one result per number ("matched", "mismatch", "no value", "duplicate value") and one per cell the checker wrote
 * that the request doesn't show ("extra cell"); lists the requests with any other than matched and any checker output
 * for a request that doesn't exist. Exits 1 if there is anything to look at.
 */
import fs from "node:fs";
import { compareExpected, type Expected, type VerifyRequest } from "../lib/answer-eval/verify-request";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const [REQ, EXP, OUT] = [arg("--requests"), arg("--expected"), arg("--out")];
if (!REQ || !EXP || !OUT) throw new Error("--requests, --expected and --out are required");
const jsonl = <T>(f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const { results, problems } = compareExpected(jsonl<VerifyRequest>(REQ), jsonl<Expected>(EXP));
fs.writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""));
const bad = new Map<string, Record<string, number>>();
for (const r of results) if (r.result !== "matched") bad.set(r.request, { ...bad.get(r.request), [r.result]: (bad.get(r.request)?.[r.result] ?? 0) + 1 });
console.log(`${results.length} results, ${results.filter((r) => r.result === "matched").length} matched; ${bad.size} requests with something other than matched`);
for (const [id, n] of bad) console.log(`  ${id}: ${Object.entries(n).map(([k, v]) => `${v} ${k}`).join(", ")}`);
for (const p of problems) console.log(`  ${p}`);
process.exit(bad.size || problems.length ? 1 : 0);
