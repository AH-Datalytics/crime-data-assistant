import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { detectQueryBearingFollowup } from "../lib/query-bearing-followup";
import { planFollowup } from "../lib/followup-planner";
import { buildCrossSourceFollowupTransform } from "../lib/cross-source-followup";
import { detectFollowupTransform } from "../lib/followup-transform";
import { normalizeHistoryForTab } from "../lib/chat-history";
import type { SourceId } from "../lib/source-contracts";

type Row = { id: number; question: string; sql: string | null; response: string | null; tab: string | null; session_id: string | null; ts: number };
type HistoryEntry = { role: "user" | "assistant"; content: string; source: SourceId };
type Result = {
  session: string;
  id: number;
  question: string;
  legacy: boolean;
  planned: string;
  currentSource: SourceId;
  observedSource: SourceId;
  plannedSource: SourceId;
  sourceChanged: boolean;
  legacyKinds: string;
  plannedKinds: string;
  reconstructed: string;
  granularity: string;
  timeRange: string;
  reasons: string[];
};

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
const results: Result[] = [];
for (const row of rows) {
  const observedSource = sourceOf(row.tab);
  const history = histories.get(row.session_id!) || [];
  if (history.length > 0) {
    const currentSource = history[history.length - 1]?.source ?? observedSource;
    const normalizedHistory = normalizeHistoryForTab(history, currentSource);
    const legacyDetection = detectQueryBearingFollowup(row.question, history);
    const legacyTransform = detectFollowupTransform(row.question, normalizedHistory) ??
      buildCrossSourceFollowupTransform(row.question, history, currentSource);
    const plan = planFollowup(row.question, history, currentSource);
    const reasons: string[] = [];
    if (Boolean(legacyDetection) !== (plan.kind === "query_bearing")) reasons.push("kind");
    if (legacyDetection && legacyDetection.kinds.join(",") !== plan.changeKinds.join(",")) reasons.push("change-kinds");
    if (legacyTransform?.contextQuestion && plan.kind === "query_bearing" &&
        legacyTransform.contextQuestion !== plan.reconstructedQuestion) reasons.push("reconstruction");
    if (plan.sourceChanged && plan.source === currentSource) reasons.push("source-change-without-target");
    if (!plan.sourceChanged && plan.source !== currentSource) reasons.push("unexpected-source-change");
    results.push({
      session: row.session_id!, id: row.id, question: row.question,
      legacy: Boolean(legacyDetection), planned: plan.kind,
      currentSource, observedSource, plannedSource: plan.source,
      sourceChanged: plan.sourceChanged,
      legacyKinds: legacyDetection?.kinds.join(",") || "",
      plannedKinds: plan.changeKinds.join(","),
      reconstructed: plan.reconstructedQuestion,
      granularity: plan.granularity,
      timeRange: `${plan.timeRange.startYear ?? ""}-${plan.timeRange.endYear ?? ""}`,
      reasons,
    });
  }
  history.push({ role: "user", content: row.question, source: observedSource });
  if (row.sql || row.response) history.push({ role: "assistant", content: sqlContent(row), source: observedSource });
  histories.set(row.session_id!, history.slice(-12));
}

const mismatches = results.filter((r) => r.reasons.length > 0);
const date = new Date().toISOString().slice(0, 10);
const output = [
  "# Follow-Up Planner Parity",
  "",
  "Sessions: " + histories.size,
  "Turns evaluated: " + results.length,
  "Legacy/planner agreements: " + (results.length - mismatches.length),
  "Mismatches: " + mismatches.length,
  "",
  "The comparison checks legacy follow-up detection, change-kind agreement, reconstructed context, source-change validity, and the planner's selected granularity/time range.",
  "",
  "| Session | Log ID | Question | Reasons | Current source | Observed source | Planned source | Legacy kinds | Planned kinds | Granularity | Time range | Reconstructed |",
  "|---|---:|---|---|---|---|---|---|---|---|---|---|",
  ...mismatches.map((r) => "| " + md(r.session) + " | " + r.id + " | " + md(r.question) + " | " + md(r.reasons.join(",")) + " | " + r.currentSource + " | " + r.observedSource + " | " + r.plannedSource + " | " + md(r.legacyKinds) + " | " + md(r.plannedKinds) + " | " + r.granularity + " | " + r.timeRange + " | " + md(r.reconstructed) + " |"),
  "",
].join("\n");
const outputPath = path.join("docs", "followup-planner-parity-" + date + ".md");
fs.writeFileSync(outputPath, output);
console.log("Wrote " + outputPath + " (" + results.length + " turns, " + mismatches.length + " mismatches)");