/**
 * Matched answers into qlog-verified.json (docs/runbooks/verify-new-answers.md, last step):
 *
 *   npx tsx scripts/apply-verify-results.ts --requests <requests.jsonl> --results <results.jsonl> --by <who> --batch <name>
 *     [--replace <id,id,...>]
 *
 * A request every number of which matched (one result each, bound to the request's own cells and values) is added at its
 * table digest; any other is listed and left out. An id already verified at the same digest is left as it is; one
 * verified at another digest is a conflict and stays as it was unless named in --replace (the owner's decision: say why
 * in the commit). The file keeps its layout (one-space indent, LF, a final newline).
 */
import fs from "node:fs";
import path from "node:path";
import { mergeVerified, verifiedEntries, type VerifiedEntry, type VerifyRequest, type VerifyResult } from "../lib/answer-eval/verify-request";

const arg = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const [REQ, RES, BY, BATCH] = [arg("--requests"), arg("--results"), arg("--by"), arg("--batch")];
if (!REQ || !RES || !BY || !BATCH) throw new Error("--requests, --results, --by and --batch are required");
const replace = (arg("--replace") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const jsonl = <T>(f: string) => fs.readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T);
const { entries, unmatched } = verifiedEntries(jsonl<VerifyRequest>(REQ), jsonl<VerifyResult>(RES), { by: BY, batch: BATCH, date: new Date().toISOString().slice(0, 10) });
const file = path.join(__dirname, "fixtures", "answer-eval", "qlog-verified.json");
const verified = JSON.parse(fs.readFileSync(file, "utf8")) as { about: string; verified: Record<string, VerifiedEntry> };
const { merged, added, unchanged, conflicts, replaced } = mergeVerified(verified.verified, entries, replace);
verified.verified = merged;
fs.writeFileSync(file, JSON.stringify(verified, null, 1) + "\n");
console.log(`${added.length} added, ${unchanged.length} already verified at the same digest, ${replaced.length} replaced; ${unmatched.length} not verified; ${conflicts.length} conflicts`);
for (const u of unmatched) console.log(`not verified ${u.id}: ${u.why}`);
for (const c of conflicts) console.log(`conflict ${c}: already verified at another digest; not replaced (name it in --replace to replace)`);
process.exit(conflicts.length ? 1 : 0);
