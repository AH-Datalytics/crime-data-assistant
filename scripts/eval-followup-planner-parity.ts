import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { detectQueryBearingFollowup } from "../lib/query-bearing-followup";
import { planFollowup } from "../lib/followup-planner";
import type { SourceId } from "../lib/source-contracts";

type Row = { id: number; question: string; sql: string | null; response: string | null; tab: string | null; session_id: string | null; ts: number };
type HistoryEntry = { role: "user" | "assistant"; content: string; source: SourceId };

function sourceOf(tab: string | null): SourceId {
  return tab === "historical" || tab === "nibrs" || tab === "shr" || tab === "hate_crime" ? tab : "current";
}
function sqlContent(row: Row): string {
  return (row.response || "") + (row.sql ? "\n[SQL: " + row.sql + "]" : "");
}
function md(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

const dbPath = process.env.QUERY_LOG_DB_PATH || "query_log.db";
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare("SELECT id, question, sql, response, tab, session_id, ts FROM query_log WHERE session_id IS NOT NULL AND question IS NOT NULL ORDER BY session_id, ts, id").all() as Row[];
db.close();

const histories = new Map<string, HistoryEntry[]>();
const results: Array<{ session: string; id: number; question: string; legacy: boolean; planned: string; source: string; reconstructed: string }> = [];
for (const row of rows) {
  const source = sourceOf(row.tab);
  const history = histories.get(row.session_id!) || [];
  if (history.length > 0) {
    const legacy = Boolean(detectQueryBearingFollowup(row.question, history));
    const plan = planFollowup(row.question, history, source);
    results.push({ session: row.session_id!, id: row.id, question: row.question, legacy, planned: plan.kind, source: plan.source, reconstructed: plan.reconstructedQuestion });
  }
  history.push({ role: "user", content: row.question, source });
  if (row.sql || row.response) history.push({ role: "assistant", content: sqlContent(row), source });
  histories.set(row.session_id!, history.slice(-12));
}

const mismatches = results.filter((r) => r.legacy !== (r.planned === "query_bearing"));
const date = new Date().toISOString().slice(0, 10);
const output = [
  "# Follow-Up Planner Parity",
  "",
  "Sessions: " + histories.size,
  "Turns evaluated: " + results.length,
  "Legacy/planner agreements: " + (results.length - mismatches.length),
  "Mismatches: " + mismatches.length,
  "",
  "| Session | Log ID | Question | Legacy | Planner | Planned source | Reconstructed |",
  "|---|---:|---|---|---|---|---|",
  ...mismatches.map((r) => "| " + md(r.session) + " | " + r.id + " | " + md(r.question) + " | " + r.legacy + " | " + r.planned + " | " + r.source + " | " + md(r.reconstructed) + " |"),
  "",
].join("\n");
const outputPath = path.join("docs", "followup-planner-parity-" + date + ".md");
fs.writeFileSync(outputPath, output);
console.log("Wrote " + outputPath + " (" + results.length + " turns, " + mismatches.length + " mismatches)");
