/**
 * The runner's compare step (docs/runbooks/verify-new-answers.md): the blind checker's values against the requests'.
 *
 *   npx tsx scripts/compare-verify-expected.ts --requests <requests.jsonl> --expected <expected.jsonl> --out <results.jsonl>
 *
 * Writes one result per number ("matched", "mismatch" or "no value") and lists the requests with any other than matched.
 */
import fs from "node:fs";
import { compareExpected, type Expected, type VerifyRequest } from "../lib/answer-eval/verify-request";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const [REQ, EXP, OUT] = [arg("--requests"), arg("--expected"), arg("--out")];
if (!REQ || !EXP || !OUT) throw new Error("--requests, --expected and --out are required");
const jsonl = <T>(f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const results = compareExpected(jsonl<VerifyRequest>(REQ), jsonl<Expected>(EXP));
fs.writeFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n") + (results.length ? "\n" : ""));
const bad = new Map<string, number>();
for (const r of results) if (r.result !== "matched") bad.set(r.request, (bad.get(r.request) ?? 0) + 1);
console.log(`${results.length} numbers checked, ${results.filter((r) => r.result === "matched").length} matched; ${bad.size} requests with a number that did not`);
for (const [id, n] of bad) console.log(`  ${id}: ${n} not matched`);
process.exit(bad.size ? 1 : 0);
