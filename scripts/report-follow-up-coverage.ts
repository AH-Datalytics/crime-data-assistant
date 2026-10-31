/**
 * Increment 7b: how many of the logged follow-up turns the deterministic rewriter places (a rewrite, a complete new
 * question, or a presentation-only edit) and how many it asks about. The query-log copy has no session data, so a
 * follow-up's real previous turn is unknown: each is tried against three typical previous questions (a yearly count,
 * a breakdown, a monthly series of victims), and counted as placed when the rewriter places it after any of them.
 *
 *   npx tsx scripts/report-follow-up-coverage.ts   # reads docs/coverage/2026-10-30-query-log-classification.csv
 *
 * Offline: no database, no model.
 */
import fs from "node:fs";
import path from "node:path";
import { deterministicRewriter } from "../lib/nibrs-shadow/follow-up";

const csv = fs.readFileSync(path.join(__dirname, "../docs/coverage/2026-10-30-query-log-classification.csv"), "utf8");
/** The classification CSV's rows (RFC 4180 quoting). */
function rows(text: string): string[][] {
  const out: string[][] = []; let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ",") { row.push(cell); cell = ""; } else if (ch === "\n") { row.push(cell); out.push(row); row = []; cell = ""; } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
const [head, ...data] = rows(csv);
const qi = head.indexOf("question"), si = head.indexOf("status");
const follow = data.filter((r) => r[si] === "P inc 7b").map((r) => r[qi]);
const PREVIOUS = ["Shoplifting in Memphis by year from 2021 to 2024", "Female aggravated assault victims in Memphis in 2024 by offender race", "simple assault victims in Detroit by month in 2023"];
const kinds = new Map<string, number>();
let placed = 0;
const askedExamples: string[] = [];
for (const f of follow) {
  const rs = PREVIOUS.map((p) => deterministicRewriter.rewrite(p, f));
  const best = rs.find((r) => r.kind !== "ask") ?? rs[0];
  kinds.set(best.kind, (kinds.get(best.kind) ?? 0) + 1);
  if (best.kind !== "ask") placed++;
  else if (askedExamples.length < 15) askedExamples.push(f);
}
const pct = (n: number) => `${((100 * n) / follow.length).toFixed(1)}%`;
console.log(`Logged follow-up turns: ${follow.length}`);
console.log(`Placed (rewritten, a new question, or presentation): ${placed} (${pct(placed)})`);
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n} (${pct(n)})`);
console.log(`Asked about: ${follow.length - placed} (${pct(follow.length - placed)}). Examples:`);
for (const e of askedExamples) console.log(`  - ${e.slice(0, 120)}`);
