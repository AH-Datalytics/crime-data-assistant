#!/usr/bin/env npx tsx
/**
 * Model replay comparison — replays logged production NIBRS questions through
 * translateToSql under two models and compares deterministic quality signals
 * (refusals, guardrail fires) plus latency. No DB execution — this measures
 * first-pass model output quality only, using the same checks as
 * eval-nibrs-canary.ts.
 *
 * Usage:
 *   npx tsx scripts/eval-model-replay.ts --file <log.json>
 *   npx tsx scripts/eval-model-replay.ts --file <log.json> --models claude-haiku-4-5-20251001,claude-sonnet-5 --limit 20
 *
 * Input file: `sqlite3 -json` export of query_log rows with columns
 *   id, ts, session_id, question, sql, response, rows, error, ms, guardrails
 *
 * Requires ANTHROPIC_API_KEY in env.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { translateToSql } from "../lib/nibrs-claude.js";
import { findNibrsSqlIssues } from "../lib/sql-guardrails.js";
import { extractQueryContext } from "../lib/query-context.js";
import { runGuardrails } from "../lib/guardrails.js";

type LogRow = {
  id: number;
  ts: number;
  session_id: string;
  question: string;
  sql: string | null;
  response: string | null;
  rows: number;
  error: string | null;
  ms: number;
  guardrails: string | null;
};

type HistoryMsg = { role: "user" | "assistant"; content: string };

interface ReplayResult {
  logId: number;
  question: string;
  model: string;
  hasSql: boolean;
  refusalLike: boolean;
  issues: string[];
  latencyMs: number;
  sql: string | null;
  explanation: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    file: get("--file"),
    models: (get("--models") || "claude-haiku-4-5-20251001,claude-sonnet-5").split(","),
    limit: get("--limit") ? parseInt(get("--limit")!, 10) : Infinity,
    concurrency: get("--concurrency") ? parseInt(get("--concurrency")!, 10) : 3,
    out: get("--out"),
  };
}

/** Rebuild the conversation history a row would have seen in production:
 *  prior turns in the same session, trimmed to the last 6 messages. */
function buildHistories(rows: LogRow[]): Map<number, HistoryMsg[]> {
  const bySession = new Map<string, LogRow[]>();
  for (const r of rows) {
    if (!bySession.has(r.session_id)) bySession.set(r.session_id, []);
    bySession.get(r.session_id)!.push(r);
  }
  const histories = new Map<number, HistoryMsg[]>();
  for (const sessionRows of bySession.values()) {
    sessionRows.sort((a, b) => a.ts - b.ts);
    const msgs: HistoryMsg[] = [];
    for (const r of sessionRows) {
      histories.set(r.id, msgs.slice(-6));
      msgs.push({ role: "user", content: r.question });
      msgs.push({
        role: "assistant",
        content: JSON.stringify({
          sql: r.sql || null,
          explanation: (r.response || "").slice(0, 500),
        }),
      });
    }
  }
  return histories;
}

async function replayOne(row: LogRow, history: HistoryMsg[], model: string): Promise<ReplayResult> {
  const start = Date.now();
  let result;
  try {
    result = await translateToSql(row.question, history, model);
  } catch (err) {
    return {
      logId: row.id,
      question: row.question,
      model,
      hasSql: false,
      refusalLike: false,
      issues: [`API_ERROR: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`],
      latencyMs: Date.now() - start,
      sql: null,
      explanation: "",
    };
  }
  const latencyMs = Date.now() - start;

  const issues: string[] = [];
  const refusalLike =
    !result.sql && /cannot|can't|unable|not available|doesn't appear|do not have|don't have/i.test(result.explanation || "");

  if (result.sql) {
    const sqlIssues = findNibrsSqlIssues(result.sql);
    for (const issue of sqlIssues.fired) issues.push(`SQL_GUARDRAIL: ${issue}`);
    const ctx = extractQueryContext(result.sql, row.question, "nibrs");
    const guardrailResult = runGuardrails(ctx);
    for (const fired of guardrailResult.fired) issues.push(`GUARDRAIL: ${fired}`);
  }

  return {
    logId: row.id,
    question: row.question,
    model,
    hasSql: !!result.sql,
    refusalLike,
    issues,
    latencyMs,
    sql: result.sql,
    explanation: (result.explanation || "").slice(0, 300),
  };
}

async function runPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function pct(n: number, total: number): string {
  return total ? `${((100 * n) / total).toFixed(1)}%` : "-";
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[idx];
}

async function main() {
  const opts = parseArgs();
  if (!opts.file) {
    console.error("Usage: npx tsx scripts/eval-model-replay.ts --file <log.json>");
    process.exit(1);
  }

  const allRows: LogRow[] = JSON.parse(readFileSync(opts.file, "utf-8"));
  const histories = buildHistories(allRows);
  const rows = allRows.filter((r) => r.question && r.question.trim().length > 0).slice(0, opts.limit);
  console.log(`Replaying ${rows.length} logged queries through ${opts.models.length} models...\n`);

  const allResults: ReplayResult[] = [];
  for (const model of opts.models) {
    console.log(`--- ${model} ---`);
    // Warm the prompt cache with one call before fanning out.
    allResults.push(await replayOne(rows[0], histories.get(rows[0].id) || [], model));
    const rest = await runPool(rows.slice(1), opts.concurrency, (row) =>
      replayOne(row, histories.get(row.id) || [], model),
    );
    allResults.push(...rest);
  }

  // Summary per model
  console.log("\n=== SUMMARY ===\n");
  const header = ["model", "n", "sql", "no-sql", "refusal-like", "flagged", "fires", "p50 ms", "p90 ms"];
  console.log(header.join("\t"));
  for (const model of opts.models) {
    const rs = allResults.filter((r) => r.model === model);
    const latencies = rs.map((r) => r.latencyMs).sort((a, b) => a - b);
    const flagged = rs.filter((r) => r.issues.length > 0);
    const fires = rs.reduce((sum, r) => sum + r.issues.length, 0);
    console.log(
      [
        model,
        rs.length,
        `${rs.filter((r) => r.hasSql).length} (${pct(rs.filter((r) => r.hasSql).length, rs.length)})`,
        rs.filter((r) => !r.hasSql).length,
        rs.filter((r) => r.refusalLike).length,
        `${flagged.length} (${pct(flagged.length, rs.length)})`,
        fires,
        quantile(latencies, 0.5),
        quantile(latencies, 0.9),
      ].join("\t"),
    );
  }

  // Divergence: queries where one model is clean and another is flagged
  if (opts.models.length === 2) {
    const [a, b] = opts.models;
    const byId = new Map<number, Record<string, ReplayResult>>();
    for (const r of allResults) {
      if (!byId.has(r.logId)) byId.set(r.logId, {});
      byId.get(r.logId)![r.model] = r;
    }
    console.log(`\n=== DIVERGENCES (${a} vs ${b}) ===\n`);
    for (const [logId, pair] of byId) {
      const ra = pair[a];
      const rb = pair[b];
      if (!ra || !rb) continue;
      const aBad = ra.issues.length > 0 || (!ra.hasSql && rb.hasSql);
      const bBad = rb.issues.length > 0 || (!rb.hasSql && ra.hasSql);
      if (aBad === bBad) continue;
      const winner = aBad ? b : a;
      const loserResult = aBad ? ra : rb;
      console.log(`#${logId} [${winner} cleaner] ${loserResult.question.slice(0, 90)}`);
      for (const issue of loserResult.issues.slice(0, 4)) console.log(`    ${issue}`);
      if (!loserResult.hasSql) console.log(`    NO SQL: ${loserResult.explanation.slice(0, 120)}`);
    }
  }

  const outPath = opts.out || opts.file.replace(/\.json$/, `-replay-results.json`);
  writeFileSync(outPath, JSON.stringify(allResults, null, 2));
  console.log(`\nFull results written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
