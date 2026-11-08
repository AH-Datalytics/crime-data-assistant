/**
 * Matched answers into qlog-verified.json (docs/runbooks/verify-new-answers.md, last step):
 *
 *   npx tsx scripts/apply-verify-results.ts --requests <requests.jsonl> --results <results.jsonl> --by <who> --batch <name>
 *
 * A request every number of which matched (one result each, all "matched") is added at its table digest; any other is
 * listed and left out. The file keeps its layout (one-space indent, a final newline), so the commit shows only the
 * entries added.
 */
import fs from "node:fs";
import path from "node:path";
import { verifiedEntries, type VerifyRequest, type VerifyResult } from "../lib/answer-eval/verify-request";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const [REQ, RES, BY, BATCH] = [arg("--requests"), arg("--results"), arg("--by"), arg("--batch")];
if (!REQ || !RES || !BY || !BATCH) throw new Error("--requests, --results, --by and --batch are required");
const jsonl = <T>(f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const { entries, unmatched } = verifiedEntries(jsonl<VerifyRequest>(REQ), jsonl<VerifyResult>(RES), { by: BY, batch: BATCH, date: new Date().toISOString().slice(0, 10) });
const file = path.join(__dirname, "fixtures", "answer-eval", "qlog-verified.json");
const verified = JSON.parse(fs.readFileSync(file, "utf8")) as { about: string; verified: Record<string, unknown> };
Object.assign(verified.verified, entries);
fs.writeFileSync(file, JSON.stringify(verified, null, 1) + "\n");
console.log(`${Object.keys(entries).length} verified and added; ${unmatched.length} not`);
for (const u of unmatched) console.log(`not verified ${u.id}: ${u.why}`);
